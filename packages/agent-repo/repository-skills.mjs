import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {relative} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
import {containedPath,readProjects,selectProjectId} from './repositories.mjs';
const run=promisify(execFile);
const hash=value=>createHash('sha256').update(value).digest('hex');
export const scopeBridge=globalThis[Symbol.for('agent-repo.skill-scopes.v1')]??=new Map();
export class RepositoryGitCheckError extends Error {
 constructor(kind) {
  super(kind==='timeout'?'本地 Git 状态检查超时，本轮未提交，请核对机器负载后重试。':'本地 Git 检查输出超过索引预算，本轮未提交，请管理员核对目录规模。');
  this.name='RepositoryGitCheckError';this.kind=kind;
 }
}
export async function git(root,args,{timeoutMs=15000}={}) {
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Error('Invalid Git check timeout');
 try {
  const {stdout}=await run('git',['-c','core.fsmonitor=false','-C',root,...args],{timeout:timeoutMs,maxBuffer:2*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
  return stdout;
 }catch(error){
  if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw new RepositoryGitCheckError('output_limit');
  if(error.killed&&error.signal==='SIGTERM')throw new RepositoryGitCheckError('timeout');
  throw error;
 }
}
export function repositorySelector(value) {
 if(typeof value!=='string'||!/^(?:project|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/repositories\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/.test(value))throw Error('repository must select a registered projects/<id> root or its repositories/<name>');
 return value;
}
export async function readSkillSource(root,directory,agentRoot,kind,{inspection=false}={}) {
 const canonical=await realpath(root);
 if(await realpath((await git(root,['rev-parse','--show-toplevel'])).trim())!==canonical)throw Error('Selected repository is not initialized at its own Git root');
 const head=(await git(root,['rev-parse','HEAD'])).trim();
 const directoryPath=await containedPath(root,directory);
 if(directoryPath!==canonical+'/'+directory)throw Error('Skill directory must not be a symlink');
 const status=await git(root,['status','--porcelain=v1','--untracked-files=all','--',directory]);
 if(status.trim()&&!inspection)throw Error('Skill files must be committed before loading: '+kind);
 const tree=(await git(root,['ls-tree','-r','-z',head,'--',directory])).split('\0').filter(Boolean);
 if(tree.length>4000)throw Error('Skill tree is too large');
 const rows=tree.map(row=>{const [metadata,path]=row.split('\t');const [mode,type,oid]=metadata.split(' ');return {mode,type,oid,path};});
 const skillPaths=rows.filter(row=>row.type==='blob'&&['100644','100755'].includes(row.mode)&&row.path.endsWith('/SKILL.md')&&row.path.slice(directory.length+1).split('/').length<=7);
 const entries=[];
 for(const row of skillPaths) {
  // Native grouped discovery stops descending once a parent skill is found.
  if(skillPaths.some(parent=>parent!==row&&row.path.startsWith(parent.path.slice(0,-8))))continue;
  const path=await containedPath(root,row.path);
  if(path!==canonical+'/'+row.path)throw Error('Skill file has a symlink ancestor');
  const body=await git(root,['show',head+':'+row.path]);
  if(Buffer.byteLength(body)>256*1024)throw Error('SKILL.md is too large');
  const match=body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let metadata={};try{if(match)metadata=parse(match[1],{maxAliasCount:20})??{};}catch{throw Error('Invalid skill frontmatter: '+row.path);}
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('Invalid skill frontmatter: '+row.path);
  if(metadata['disable-model-invocation']===true&&!inspection)continue;
  const name=metadata.name??row.path.split('/').at(-2);
  if(typeof name!=='string'||!name.trim()||name.length>160||/[\u0000\r\n]/.test(name))throw Error('Invalid skill name');
  if(entries.some(entry=>entry.name===name))throw Error('Duplicate skill name in '+kind+': '+name);
  entries.push({name,path:relative(agentRoot,path),description:typeof metadata.description==='string'?metadata.description.slice(0,600):'',source:kind,...(inspection?{modelInvocationDisabled:metadata['disable-model-invocation']===true}:{})});
 }
 return {root:canonical,directory,head,tree:hash(tree.join('\0')),entries,...(inspection?{dirty:!!status.trim()}:{} )};
}
const source=readSkillSource;
async function instructions(root,agentRoot) {
 const file='AGENTS.md';
 if((await git(root,['status','--porcelain=v1','--untracked-files=all','--',file])).trim())throw Error('Repository instructions must be committed before loading');
 const tree=(await git(root,['ls-tree','HEAD','--',file])).trim();
 if(tree&&!/^100(?:644|755) blob [a-f0-9]+\tAGENTS\.md$/.test(tree))throw Error('Repository instructions must be an ordinary file');
 if(await containedPath(root,file)!==root+'/'+file)throw Error('Repository instructions must not traverse symlinks');
 return {root,tree:hash(tree),paths:tree?[relative(agentRoot,root+'/'+file)]:[]};
}
export async function repositorySkills(binding,{repository,projectId,hostConfig={},agentId}={}) {
 if(repository!==undefined)repositorySelector(repository);
 const root=await realpath(binding.repo),projects=await readProjects(root);
 const selected=repository===undefined?undefined:Object.values(projects).find(project=>repository===project.repository||repository.startsWith(project.repository+'/repositories/'));
 if(repository!==undefined&&!selected)throw Error('Repository is not registered for this Agent');
 if(projectId!==undefined&&selected&&projectId!==selected.projectId)throw Error('projectId and repository scopes disagree');
 const id=selectProjectId(projects,projectId??selected?.projectId);
 const project=projects[id];
 repository??=project.repository;
 const projectRoot=await realpath(project.paths.repository);
 const scopeDirectory=await realpath(await containedPath(root,repository));
 // A repositories/<name> symlink to a sibling would give it the wrong scope.
 if(scopeDirectory!==root+'/'+repository)throw Error('Repository selector must not traverse symlinks');
 const sources=[await source(projectRoot,'.agents/skills',root,'project')];
 if(repository!==project.repository)sources.push(await source(scopeDirectory,'.agents/skills',root,'repository'));
 sources.push(await source(root,'skills',root,'agent'));
 const allowed=hostConfig.agents?.list?.find(agent=>agent.id===agentId)?.skills;
 const effective=new Map(),shadowed=[];
 for(const item of sources)for(const skill of item.entries) {
  if(hostConfig.skills?.entries?.[skill.name]?.enabled===false||Array.isArray(allowed)&&!allowed.includes(skill.name))continue;
  if(effective.has(skill.name))shadowed.push(effective.get(skill.name));
  effective.set(skill.name,skill);
 }
 const skills=[...effective.values()].sort((a,b)=>a.name.localeCompare(b.name));
 if(skills.length>500||JSON.stringify(skills).length>100000)throw Error('Effective skill catalog is too large');
 const roleFiles=['SOUL.md','AGENTS.md','IDENTITY.md'];
 if((await git(root,['status','--porcelain=v1','--untracked-files=all','--',...roleFiles])).trim())throw Error('Agent role files must be committed before loading');
 const roles=(await git(root,['ls-tree','HEAD','--',...roleFiles])).trim();
 const instructionSources=await Promise.all(sources.slice(0,-1).map(item=>instructions(item.root,root)));
 const skillEntries=sources.map(item=>JSON.stringify({root:item.root,directory:item.directory,tree:item.tree})).concat(skills.map(skill=>JSON.stringify(skill)));
 const instructionPaths=instructionSources.flatMap(item=>item.paths);
 const snapshot={protocol:3,root,catalog:skills.map(skill=>skill.path),skills:hash(skillEntries.join('\n')),roles:hash(JSON.stringify({roles,instructionSources})),skillEntries,repository,projectRepository:project.repository,projectId:id,repositorySources:sources.map(({entries,...item})=>item),instructionSources};
 return {repository,cwd:projectRoot,scopeDirectory,root,projectId:id,skills,instructions:instructionPaths,shadowed,snapshot,instruction:'本次仓库技能索引替代之前的项目技能选择。Agent 角色技能保持优先；当前子仓库同名技能覆盖 Project 根技能，其他子仓库技能不适用。按任务读取适用 SKILL.md 正文、引用及 instructions 列出的仓库规范，不能因索引加载就声称读过正文。agent_worker run 必须传相同 repository；Worker cwd 是本结果的项目根 cwd，scopeDirectory 仅为技能范围。子仓库任务不切换进子仓库执行；本结果不修改其他任务或会话，不构成业务授权。'};
}
export async function agentSkills(binding,{hostConfig={},agentId}={}) {
 const root=await realpath(binding.repo),item=await source(root,'skills',root,'agent');
 const allowed=hostConfig.agents?.list?.find(agent=>agent.id===agentId)?.skills;
 const skills=item.entries.filter(skill=>hostConfig.skills?.entries?.[skill.name]?.enabled!==false&&(!Array.isArray(allowed)||allowed.includes(skill.name)));
 return {root,skills,instructions:[],projectId:null,repository:null,snapshot:{root,catalog:skills.map(skill=>skill.path),repositorySources:[{root:item.root,head:item.head,directory:item.directory,tree:item.tree}]}};
}
export function installScopeProvider(config,getHostConfig,prepareScope) {
 const providers=[];
 for(const [agentId,binding] of Object.entries(config.agents)) {
  const provider={agentId,resolve:options=>prepareScope?prepareScope(binding,{...options,hostConfig:getHostConfig(),agentId}):repositorySkills(binding,{...options,hostConfig:getHostConfig(),agentId})};
  scopeBridge.set(binding.repo,provider);providers.push([binding.repo,provider]);
 }
 return ()=>{for(const [root,provider] of providers)if(scopeBridge.get(root)===provider)scopeBridge.delete(root);};
}
