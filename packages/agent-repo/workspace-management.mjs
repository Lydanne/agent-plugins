import {readFile,writeFile,rename,rm,lstat,realpath,open,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readProjects,containedPath} from './repositories.mjs';
import {git} from './repository-skills.mjs';
import {acquireLock} from './dist/workspace-lock.mjs';
const digest=text=>createHash('sha256').update(text).digest('hex');
export class WorkspaceManagementError extends Error {}
async function registration(root){
 const file=await containedPath(root,'projects.json');if(file!==join(root,'projects.json')||!(await lstat(file)).isFile())throw Error('Invalid registration');
 const text=await readFile(file,'utf8');return {file,text,mode:(await lstat(file)).mode&0o777,revision:digest(text)};
}
export async function workspaceCatalog(root,projectId){
 root=await realpath(root);const before=await registration(root),projects=await readProjects(root),project=projects[projectId];
 if(!project)throw new WorkspaceManagementError('请选择当前 Agent 已登记项目');
 let slots=[];
 try{
  const directory=join(root,'workspace');if(await realpath(directory)!==directory)throw Error('Linked state directory');
  const file=join(directory,'state.json');if((await lstat(file)).isSymbolicLink())throw Error('Linked state file');
  const state=JSON.parse(await readFile(file,'utf8'));if(state.version!==1||!state.workspaces||Array.isArray(state.workspaces))throw Error('Invalid state');
  slots=Object.values(state.workspaces).filter(s=>s.projectId===projectId).map(s=>({id:s.id,status:s.status,owner:s.owner,path:s.path,branch:s.branch,target:s.target,error:s.error,createdAt:s.createdAt,releasedAt:s.releasedAt,dependencies:Object.entries(s.dependencies??{}).map(([repository,d])=>({repository,installedAt:d.installedAt,packageJsonHash:d.packageJsonHash}))}));
 }catch(e){if(e.code!=='ENOENT')throw new WorkspaceManagementError('工作区状态不可读取，已保留现场；请检查状态文件与目录');}
 if((await registration(root)).revision!==before.revision)throw new WorkspaceManagementError('项目登记已变化，请刷新');
 return {projectId,revision:before.revision,config:project.workspacePool??{enabled:false,maxSize:3},slots,occupied:slots.filter(s=>s.status!=='idle').length,pendingCommit:!!(await git(root,['status','--porcelain','--','projects.json'])).trim()};
}
export async function saveWorkspaceConfig(root,input){
 const {projectId,revision,enabled,maxSize}=input;
 if(Object.keys(input).some(k=>!['projectId','revision','enabled','maxSize'].includes(k))||typeof projectId!=='string'||typeof enabled!=='boolean'||!Number.isInteger(maxSize)||maxSize<1||maxSize>20||!/^[a-f0-9]{64}$/.test(revision??''))throw new WorkspaceManagementError('配置无效：容量必须为 1–20 的整数');
 root=await realpath(root);const lock=resolve(root,(await git(root,['rev-parse','--git-path','workspace-config.lock'])).trim()),release=await acquireLock(lock);
 let syncLock,syncPath;
 try{
  syncPath=resolve(root,(await git(root,['rev-parse','--git-path','ada-workspace-sync.lock'])).trim());
  try{syncLock=await open(syncPath,'wx',0o600);await syncLock.writeFile(String(process.pid));}catch(e){if(e.code==='EEXIST')throw new WorkspaceManagementError('仓库正在同步或同步锁待核验，请稍后刷新重试');throw e;}
  const before=await registration(root);if(before.revision!==revision)throw new WorkspaceManagementError('配置已被修改，请刷新后重试');
  const projects=await readProjects(root);if(!Object.hasOwn(projects,projectId))throw new WorkspaceManagementError('请选择当前 Agent 已登记项目');
  const catalog=await workspaceCatalog(root,projectId);if(catalog.revision!==revision)throw new WorkspaceManagementError('配置已被修改，请刷新后重试');
  const manifest=JSON.parse(before.text),prior=manifest.projects[projectId].workspacePool??{enabled:false,maxSize:3};
  if(prior.enabled===enabled&&prior.maxSize===maxSize)return catalog;
  manifest.projects[projectId].workspacePool={enabled,maxSize};
  const text=JSON.stringify(manifest,null,2)+'\n',tmp=before.file+'.'+randomUUID();try{await writeFile(tmp,text,{mode:before.mode,flag:'wx'});if((await registration(root)).revision!==revision)throw new WorkspaceManagementError('配置已被修改，请刷新后重试');await rename(tmp,before.file);}finally{await rm(tmp,{force:true});}
  return {...catalog,config:{enabled,maxSize},revision:digest(text),pendingCommit:true};
 }finally{try{if(syncLock){await syncLock.close();await unlink(syncPath);}}finally{release();}}
}
