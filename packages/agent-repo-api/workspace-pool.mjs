import {mkdir,readFile,writeFile,rename,lstat,realpath,access} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {acquireLock} from './workspace-lock.mjs';
const exec=promisify(execFile),hash=s=>createHash('sha256').update(s).digest('hex');
const exists=async p=>{try{await access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export const processAlive=pid=>{if(!Number.isInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const environment=()=>Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_|^(FEISHU|LARK)_(APP_ID|APP_SECRET|ACCESS_TOKEN|ENCRYPT_KEY|VERIFICATION_TOKEN)$|^OPENCLAW_GATEWAY_(TOKEN|PASSWORD)$/.test(k)));
export async function poolGit(cwd,args){return (await exec('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],{env:{...environment(),GIT_TERMINAL_PROMPT:'0'},timeout:120000,maxBuffer:4*1024*1024})).stdout.trim();}
async function safePath(root,path){
 const full=resolve(root,path);if(!full.startsWith(root+'/'))throw Error('Workspace path escapes Agent Repo');
 let current=root;for(const part of path.split('/')){if(!part||part==='.'||part==='..')throw Error('Invalid workspace path');current=join(current,part);try{if((await lstat(current)).isSymbolicLink())throw Error('Workspace path must not be linked');}catch(e){if(e.code!=='ENOENT')throw e;}}
 return full;
}
async function atomic(file,value){const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);}
async function transaction(root,fn){
 root=await realpath(root);const dir=await safePath(root,'workspace');await mkdir(dir,{recursive:true,mode:0o700});
 const release=await acquireLock(join(dir,'state.lock'));
 try{const file=await safePath(root,'workspace/state.json');let state;
 try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={version:1,revision:0,workspaces:{}};}
 if(state.version!==1||!state.workspaces||typeof state.workspaces!=='object'||Array.isArray(state.workspaces))throw Error('Invalid workspace state; allocation withheld');
 const result=await fn(state);state.revision++;await atomic(file,state);return result;
 }finally{release();}
}
// Called only with a trusted, committed project registration and prepared skill scope.
export async function workspacePlan(project,result){
 if(project.workspacePool?.enabled!==true)throw Error('Project workspace pool is not enabled');
 const root=await realpath(result.root),source=await realpath(result.cwd),repositories=[];
 const add=async(path,url,branch)=>{
  const location=path==='.'?source:await safePath(source,path);
  if(await realpath(await poolGit(location,['rev-parse','--show-toplevel']))!==location||await poolGit(location,['remote','get-url','origin'])!==url)throw Error('Workspace source repository identity mismatch');
  const expected=result.snapshot.repositorySources.find(s=>s.root===location)?.head;
  const baseSha=expected??await poolGit(location,['rev-parse','HEAD']);
  if(!/^[a-f0-9]{40,64}$/.test(baseSha))throw Error('Invalid workspace base commit');
  repositories.push({path,source:location,url,baseBranch:branch,baseSha});
 };
 await add('.',project.url,project.branch);
 let modules='';try{modules=await poolGit(source,['config','--blob','HEAD:.gitmodules','--get-regexp','^submodule\\..*\\.path$']);}catch(e){if(![1,128].includes(e.code))throw e;}
 for(const row of modules.split('\n').filter(Boolean)){
  const [key,path]=row.split(/\s+/);if(!/^(?:wiki|repositories\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(path))throw Error('Unsupported workspace repository layout');
  const prefix=key.slice(0,-4),url=await poolGit(source,['config','--blob','HEAD:.gitmodules','--get',prefix+'url']);
  let branch;try{branch=await poolGit(source,['config','--blob','HEAD:.gitmodules','--get',prefix+'branch']);}catch{branch=project.branch;}
  await add(path,url,branch);
  const tree=await poolGit(source,['ls-tree','HEAD','--',path]);if(tree.startsWith('160000 '))repositories.at(-1).baseSha=tree.split(/\s+/)[2];
 }
 const target=result.repository===project.repository?'.':result.repository.slice(project.repository.length+1);
 if(!repositories.some(r=>r.path===target))throw Error('Selected repository is not in workspace sources');
 return {root,managed:true,projectId:project.projectId,maxSize:project.workspacePool.maxSize,projectRepository:project.repository,target,repositories};
}
export async function allocateWorkspace(plan,owner,expected){
 return transaction(plan.root,async state=>{
  if(plan.managed){
   const manifest=JSON.parse(await readFile(join(plan.root,'projects.json'),'utf8')),project=manifest.projects?.[plan.projectId];
   if(!project||project.repository!==plan.projectRepository||project.url!==plan.repositories[0].url)throw Error('Workspace project registration changed');
   if(!expected){if(project.workspacePool?.enabled!==true||!Number.isInteger(project.workspacePool.maxSize)||project.workspacePool.maxSize<1||project.workspacePool.maxSize>20)throw Error('Workspace pool is disabled or invalid');plan={...plan,maxSize:project.workspacePool.maxSize};}
  }
  const entries=Object.values(state.workspaces).filter(s=>s.projectId===plan.projectId);
  let slot=entries.find(s=>s.owner===owner);
  if(expected){
   slot=state.workspaces[expected.id];
   if(!slot||slot.assignmentId!==expected.assignmentId||slot.owner!==owner)throw Error('Original workspace assignment is unavailable; execution withheld');
   if(slot.status==='idle')slot.status='ready';
  }
  if(slot){
   if(slot.status==='preparing'&&!processAlive(slot.preparerPid)){slot.status='blocked';slot.error='Workspace preparation interrupted; inspect preserved directory';}
   if(slot.status==='blocked')return {blocked:true,error:slot.error};
   if(!expected&&slot.status==='idle')slot=undefined;
   else return slot.status==='checking'?null:structuredClone(slot);
  }
  if(entries.filter(s=>s.status!=='idle').length>=plan.maxSize)return null;
  slot=entries.filter(s=>s.status==='idle').sort((a,b)=>a.index-b.index).find(s=>s.index<plan.maxSize);
  if(!slot){
   if(entries.length>=plan.maxSize)return null;
   let index=0;while(state.workspaces[plan.projectId+'-'+index])index++;
   const id=plan.projectId+'-'+index,path=await safePath(plan.root,'workspace/'+id);
   if(await exists(path))throw Error('Unmanaged workspace directory exists; preserved');
   slot={id,index,path,projectId:plan.projectId,dependencies:{}};state.workspaces[id]=slot;
  }
  if(slot.repositories&&JSON.stringify(slot.repositories.map(r=>[r.path,r.url]))!==JSON.stringify(plan.repositories.map(r=>[r.path,r.url])))throw Error('Workspace repository layout changed; inspect preserved directory');
  Object.assign(slot,{owner,assignmentId:randomUUID(),status:'preparing',preparerPid:process.pid,repositories:plan.repositories,branch:'codex/worker-'+owner.slice(0,36),target:plan.target,createdAt:Date.now()});delete slot.error;
  return {...structuredClone(slot),needsPreparation:true};
 });
}
async function update(plan,lease,fn){return transaction(plan.root,state=>{const s=state.workspaces[lease.id];if(!s||s.assignmentId!==lease.assignmentId||s.owner!==lease.owner)throw Error('Workspace assignment changed');fn(s);return structuredClone(s);});}
async function cleanRepository(path,{published=false}={}){
 if(await poolGit(path,['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=all']))throw Error('Workspace has uncommitted files; preserved');
 for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply'])if(await exists(resolve(path,await poolGit(path,['rev-parse','--git-path',name]))))throw Error('Workspace has unfinished Git operation');
 if(published){
  const head=await poolGit(path,['rev-parse','HEAD']);
  // Refresh actual remote refs: a successful local commit is not proof of push.
  await poolGit(path,['fetch','--prune','origin']);
  if(!(await poolGit(path,['branch','-r','--contains',head])).split('\n').some(s=>s.trim().startsWith('origin/')&&!s.includes(' -> ')))throw Error('Workspace has unpushed commits; preserved');
 }
}
async function installDependencies(cwd){
 const pkg=JSON.parse(await readFile(join(cwd,'package.json'),'utf8')),manager=pkg.packageManager?.split('@')[0]??(await exists(join(cwd,'pnpm-lock.yaml'))?'pnpm':await exists(join(cwd,'yarn.lock'))?'yarn':'npm');
 if(!['pnpm','npm','yarn'].includes(manager))throw Error('Unsupported workspace package manager');
 const args=manager==='pnpm'?['install','--frozen-lockfile','--ignore-scripts']:manager==='yarn'?['install','--immutable']:[await exists(join(cwd,'package-lock.json'))?'ci':'install','--ignore-scripts'];
 await exec(manager,args,{cwd,env:{...environment(),YARN_ENABLE_SCRIPTS:'false'},timeout:600000,maxBuffer:4*1024*1024});
}
export async function prepareWorkspace(plan,lease,{install=installDependencies}={}){
 try{
  const path=await safePath(plan.root,'workspace/'+lease.id);if(path!==lease.path)throw Error('Workspace path mismatch');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  for(const repo of plan.repositories){
   const dest=repo.path==='.'?path:await safePath(path,repo.path);
   if(!await exists(dest)){
    await mkdir(dirname(dest),{recursive:true});await poolGit(dirname(dest),['clone','--no-hardlinks','--no-checkout','--',repo.source,dest]);
    await poolGit(dest,['remote','set-url','origin',repo.url]);
   }else{
    // A root checkout can contain an empty submodule placeholder.
    const top=await poolGit(dest,['rev-parse','--show-toplevel']).catch(()=>null);
    if(top!==dest){
     const {readdir}=await import('node:fs/promises');if((await readdir(dest)).length)throw Error('Workspace repository is not independent');
     await poolGit(dirname(dest),['clone','--no-hardlinks','--no-checkout','--',repo.source,dest]);await poolGit(dest,['remote','set-url','origin',repo.url]);
    }else await cleanRepository(dest,{published:true});
   }
   if(await poolGit(dest,['remote','get-url','origin'])!==repo.url)throw Error('Workspace remote changed');
   // The accepted source snapshot pins the base, not a mutable branch name.
   await poolGit(dest,['cat-file','-e',repo.baseSha+'^{commit}']).catch(()=>poolGit(dest,['fetch','origin']));
   if(repo.path===plan.target)await poolGit(dest,['switch','-c',lease.branch,repo.baseSha]);
   else await poolGit(dest,['checkout','--detach',repo.baseSha]);
  }
  for(const repo of plan.repositories){
   if(repo.path!=='.'&&repo.path!==plan.target)continue;
   const cwd=repo.path==='.'?path:join(path,repo.path),manifest=join(cwd,'package.json');
   if(!await exists(manifest))continue;
   if((await lstat(manifest)).isSymbolicLink())throw Error('Package manifest must not be linked');
   const digest=hash(await readFile(manifest));
   if(lease.dependencies[repo.path]?.packageJsonHash===digest)continue;
   await install(cwd);
   if(hash(await readFile(manifest))!==digest)throw Error('package.json changed during dependency installation');
   lease=await update(plan,lease,s=>{s.dependencies[repo.path]={packageJsonHash:digest,installedAt:Date.now()};});
  }
  return await update(plan,lease,s=>{s.status='ready';delete s.preparerPid;});
 }catch(error){await update(plan,lease,s=>{s.status='blocked';s.error='Workspace initialization failed; directory preserved. Check clone, branch and dependencies.';});throw Error('Workspace initialization failed; directory preserved. Check clone, branch and dependencies.');}
}
export async function validateWorkspace(plan,lease,{settling=false}={}){
 const s=await transaction(plan.root,state=>structuredClone(state.workspaces[lease.id]));
 if(!s||s.assignmentId!==lease.assignmentId||s.owner!==lease.owner||!(settling?['ready','running','held','checking']:['ready','running','held']).includes(s.status))throw Error('Workspace assignment is not executable');
 if(await safePath(plan.root,'workspace/'+s.id)!==s.path||await realpath(s.path)!==s.path)throw Error('Workspace path changed');
 for(const repo of s.repositories){const cwd=repo.path==='.'?s.path:await safePath(s.path,repo.path);
  if(await realpath(await poolGit(cwd,['rev-parse','--show-toplevel']))!==cwd||await poolGit(cwd,['remote','get-url','origin'])!==repo.url)throw Error('Workspace repository identity changed');
  if(repo.path===s.target&&await poolGit(cwd,['branch','--show-current'])!==s.branch)throw Error('Workspace branch changed');
 }
 return s;
}
export async function markWorkspace(plan,lease,status){return update(plan,lease,s=>{if(!['ready','running','held'].includes(s.status))throw Error('Workspace is not available for execution');s.status=status;if(status==='running'){s.workerPid=process.pid;s.workerStartedAt=Date.now();}});}
export async function releaseWorkspace(plan,lease){
 // Caller has confirmed no live Worker; assignment fencing prevents stale release.
 await update(plan,lease,s=>{if(s.status==='blocked')throw Error(s.error);s.status='checking';});
 try{
  for(const repo of lease.repositories)await cleanRepository(repo.path==='.'?lease.path:join(lease.path,repo.path),{published:true});
  return await update(plan,lease,s=>{s.status='idle';s.releasedAt=Date.now();});
 }catch{ return update(plan,lease,s=>{s.status='blocked';s.error='Workspace has uncommitted, unpushed or unverifiable changes; preserved';}); }
}

// Pool capacity is operational configuration; changing it does not replace a task's project identity.
export function sameRegistryExceptPool(before,after){
 try{
  const pools=text=>Object.entries(JSON.parse(text).projects??{}).map(([id,p])=>[id,p.workspacePool]);
  const normalize=text=>{const value=JSON.parse(text);if(!value.projects||Array.isArray(value.projects))throw Error('Invalid registry');for(const project of Object.values(value.projects)){const pool=project.workspacePool;if(pool!==undefined&&(pool===null||typeof pool!=='object'||Object.keys(pool).some(k=>!['enabled','maxSize'].includes(k))||typeof pool.enabled!=='boolean'||!Number.isInteger(pool.maxSize)||pool.maxSize<1||pool.maxSize>20))throw Error('Invalid pool');delete project.workspacePool;}return value;};
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
  const a=normalize(before),b=normalize(after);
  if(JSON.stringify(pools(before))===JSON.stringify(pools(after)))return before===after;
  return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 }catch{return false;}
}
