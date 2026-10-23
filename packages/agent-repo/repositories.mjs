import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname,basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {idPattern} from './configuration.mjs';
const run=promisify(execFile);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const inside=(root,path)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..'+ '/')&&rel!=='..'&&!isAbsolute(rel));};
function relativePath(path) {
 if(typeof path!=='string'||!path||isAbsolute(path)||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\u0000\r\n]/.test(path))throw Error('Invalid registered relative path');
 return path;
}
export async function containedPath(repo,path) {
 relativePath(path);
 const root=await realpath(repo),target=resolve(root,path);
 let existing=target;const missing=[];
 while(true) {
  try {await lstat(existing);break;}catch(error){if(error.code!=='ENOENT')throw Error('Registered path is inaccessible');missing.unshift(basename(existing));existing=dirname(existing);}
 }
 let canonical;
 try{canonical=resolve(await realpath(existing),...missing);}catch{throw Error('Registered path is inaccessible');}
 if(!inside(root,canonical))throw Error('Registered path escapes Agent Repo');
 return canonical;
}
function validUrl(value) {
 if(typeof value!=='string'||!value||/[\s\u0000]/.test(value))return false;
 if(/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(value))return true;
 try{const url=new URL(value);return ['https:','ssh:'].includes(url.protocol)&&!!url.hostname&&!url.password&&!url.search&&!url.hash&&(url.protocol==='ssh:'||!url.username);}catch{return false;}
}
export async function readProjects(repo) {
 const path=await containedPath(repo,'projects.json');
 const stat=await lstat(path);
 if(!stat.isFile()||stat.size>256*1024)throw Error('projects.json must be a file of at most 256 KiB');
 let manifest;try{manifest=JSON.parse(await readFile(path,'utf8'));}catch{throw Error('Invalid projects.json');}
 if(!object(manifest)||manifest.schemaVersion!==1||!object(manifest.projects)||Object.keys(manifest).some(key=>!['schemaVersion','projects'].includes(key))||Object.keys(manifest.projects).length>100)throw Error('Unsupported projects.json schema');
 const projects={};const locations=[];
 for(const [projectId,entry] of Object.entries(manifest.projects)) {
  if(!idPattern.test(projectId)||!object(entry)||Object.keys(entry).some(key=>!['name','url','branch','repository','skills','knowledge','workspacePool'].includes(key)))throw Error('Invalid project registration');
  if(typeof entry.name!=='string'||!entry.name.trim()||entry.name.length>160||!validUrl(entry.url)||typeof entry.branch!=='string'||!entry.branch||entry.branch.length>160||/[\s\u0000]/.test(entry.branch))throw Error('Invalid project metadata');
  if(entry.workspacePool!==undefined&&(!object(entry.workspacePool)||Object.keys(entry.workspacePool).some(k=>!['enabled','maxSize'].includes(k))||typeof entry.workspacePool.enabled!=='boolean'||!Number.isInteger(entry.workspacePool.maxSize)||entry.workspacePool.maxSize<1||entry.workspacePool.maxSize>20))throw Error('Invalid workspace pool configuration');
  const repository=relativePath(entry.repository);
  if(repository!=='project'&&repository!=='projects/'+projectId)throw Error('Project repository layout is invalid');
  if(locations.some(path=>inside(path,repository)||inside(repository,path)))throw Error('Project repository paths overlap');
  locations.push(repository);
  if(!Array.isArray(entry.skills)||entry.skills.length>20||entry.skills.some(path=>!relativePath(path).startsWith(repository+'/')))throw Error('Project skill paths must be inside its repository');
  if(entry.knowledge!==undefined&&!relativePath(entry.knowledge).startsWith(repository+'/'))throw Error('Project knowledge must be inside its repository');
  // Validate all existing symlink ancestors even when the final path does not exist.
  const paths={};
  for(const [key,path] of Object.entries({repository,...(entry.knowledge?{knowledge:entry.knowledge}:{})}))paths[key]=await containedPath(repo,path);
  const skills=await Promise.all(entry.skills.map(path=>containedPath(repo,path)));
  for(const path of [...skills,...(paths.knowledge?[paths.knowledge]:[])])if(!inside(paths.repository,path))throw Error('Project resource escapes its repository');
  projects[projectId]={projectId,...entry,paths:{...paths,skills}};
 }
 return projects;
}
async function directory(path) {
 try{return (await lstat(path)).isDirectory();}catch(error){if(error.code==='ENOENT')return false;throw Error('Registered directory is inaccessible');}
}
async function git(path,args) {
 const {stdout}=await run('git',['-c','core.fsmonitor=false','-C',path,...args],{timeout:5000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
 return stdout.trim();
}
export function selectProjectId(projects,requested) {
 const ids=Object.keys(projects);
 const id=requested??(ids.length===1?ids[0]:undefined);
 if(typeof id!=='string'||!Object.hasOwn(projects,id))throw Error('Select a registered projectId for this task; multiple projects require an explicit selection');
 return id;
}
export async function inspectProject(project) {
 const {paths}=project;
 const result={projectId:project.projectId,name:project.name,repository:paths.repository,
  skills:await Promise.all(paths.skills.map(async path=>({path,available:await directory(path)}))),
  ...(paths.knowledge?{knowledge:{path:paths.knowledge,available:await directory(paths.knowledge)}}:{}),
  expectedBranch:project.branch,available:await directory(paths.repository)};
 if(!result.available)return {...result,git:{state:'missing'}};
 try {
  const top=await realpath(await git(paths.repository,['rev-parse','--show-toplevel']));
  if(top!==await realpath(paths.repository)||await git(paths.repository,['rev-parse','--show-superproject-working-tree']))return {...result,git:{state:'not_independent_repository'}};
  const [head,branch,status,remote]=await Promise.all([
   git(paths.repository,['rev-parse','HEAD']),git(paths.repository,['branch','--show-current']),
   git(paths.repository,['status','--porcelain=v1','--untracked-files=normal','--ignore-submodules=all']),
   git(paths.repository,['config','--get','remote.origin.url']).catch(()=>undefined)]);
  let upstream,divergence;
  try{upstream=await git(paths.repository,['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}']);
   const [ahead,behind]=(await git(paths.repository,['rev-list','--left-right','--count','HEAD...@{upstream}'])).split(/\s+/).map(Number);divergence={ahead,behind};}catch{ /* No configured/fetched upstream is not evidence of being current. */ }
  return {...result,git:{state:'available',head,branch:branch||null,branchMatches:branch===project.branch,dirty:!!status,remoteMatches:remote===project.url,upstream:upstream??null,...divergence,remoteFreshness:'not_fetched'}};
 }catch{return {...result,git:{state:'unavailable'}};}
}
export async function agentSummary(repo) {
 const roles={};
 for(const file of ['SOUL.md','AGENTS.md','IDENTITY.md','MEMORY.md']) {
  const path=await containedPath(repo,file);try{roles[file]=(await lstat(path)).isFile();}catch(error){if(error.code!=='ENOENT')throw Error('Agent role file is inaccessible');roles[file]=false;}
 }
 return {repo:await realpath(repo),roles,skills:{path:await containedPath(repo,'skills'),available:await directory(await containedPath(repo,'skills'))},memory:{path:await containedPath(repo,'memory'),available:await directory(await containedPath(repo,'memory'))}};
}
