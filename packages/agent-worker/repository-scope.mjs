import {getAgentRepoService,AgentRepoError} from './dist/agent-repo-api.mjs';
import {realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
const hash=value=>createHash('sha256').update(value).digest('hex');
async function git(root,args) {
 const {stdout}=await run('git',['-c','core.fsmonitor=false','-C',root,...args],{timeout:5000,maxBuffer:2*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
 return stdout;
}
export function executionScopeOf(result,agentId) {
 return hash(JSON.stringify([agentId,result.root??result.snapshot.root,result.projectId??result.snapshot.projectId,result.repository??result.snapshot.repository]));
}
export async function scopeRuntime(config,params,provenance,hostConfig={}) {
 const context=provenance;
 if(config.projectRouting==='legacy'){if(['projectId','repository','expectedRegistryRevision'].some(key=>params[key]!==undefined))throw new AgentRepoError('PROJECT_SELECTOR_INVALID','Legacy mode does not accept project selectors');return config;}
 const service=context?.agentId&&config.projectRouting!=='legacy'?getAgentRepoService(context,{required:false}):undefined;
 let result;
 if(service) {
  result=await service.prepareExecutionScope({projectId:params.projectId,repository:params.repository,expectedRegistryRevision:params.expectedRegistryRevision});
 } else {
  const bound=hostConfig.plugins?.entries?.['agent-repo']?.enabled!==false&&hostConfig.plugins?.entries?.['agent-repo']?.config?.agents?.[context?.agentId];
  if(config.projectRouting==='agent-repo'||bound)throw new AgentRepoError('AGENT_REPO_UNAVAILABLE','Agent Repo service is unavailable; project routing cannot fall back to a fixed cwd');
  if(params.projectId!==undefined||params.expectedRegistryRevision!==undefined)throw new AgentRepoError('AGENT_REPO_UNAVAILABLE','projectId routing requires the Agent Repo API');
  if(params.repository===undefined&&!config.skillContextRoot)return config;
  if(params.repository!==undefined&&(typeof params.repository!=='string'||!/^(?:project|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/repositories\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/.test(params.repository)))throw Error('Invalid repository scope');
  if(!config.skillContextRoot)throw Error('repository routing requires the Agent Repo migration configuration');
  const root=await realpath(config.skillContextRoot);
  const provider=globalThis[Symbol.for('agent-repo.skill-scopes.v1')]?.get(root);
  if(!provider||typeof provider.resolve!=='function')throw Error('agent-repo skill scope provider is unavailable');
  if(!context?.agentId||provider.agentId!==context.agentId)throw Error('Worker Agent does not own this Agent Repo');
  result=await provider.resolve({repository:params.repository});
 }
 const projectContext={agentId:context.agentId,root:result.root??result.snapshot.root,projectId:result.projectId??result.snapshot.projectId,repository:result.repository??result.snapshot.repository,cwd:result.cwd,scopeDirectory:result.scopeDirectory,registryRevision:result.registryRevision};
 const render=text=>text.replaceAll(config.cwd,result.cwd).replaceAll('{projectDir}',result.cwd).replaceAll('{agentRepo}',projectContext.root).replaceAll('{scopeDirectory}',projectContext.scopeDirectory??result.cwd);
 return {...config,cwd:result.cwd,skillContextRoot:projectContext.root,projectContext,executionScope:executionScopeOf(result,context.agentId),scopedSkillSnapshot:result.snapshot,executorInstructions:render(config.executorInstructions),delegationInstructions:render(config.delegationInstructions)};
}
export async function readScopedSkillVersion(config) {
 const snapshot=config.scopedSkillSnapshot;
 const projectRepository=snapshot?.projectRepository??'project';
 if(!/^(?:project|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.test(projectRepository)||!(snapshot?.repository===projectRepository||new RegExp('^'+projectRepository+'/repositories/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$').test(snapshot?.repository??'')))throw Error('Invalid selected project snapshot');
 if(![1,2,3].includes(snapshot?.protocol)||snapshot.root!==config.skillContextRoot||!Array.isArray(snapshot.repositorySources)||snapshot.repositorySources.length<2||snapshot.repositorySources.length>3||!Array.isArray(snapshot.catalog)||snapshot.catalog.length>500||!snapshot.catalog.every(path=>typeof path==='string'&&["skills/",projectRepository+'/.agents/skills/',snapshot.repository+'/.agents/skills/'].some(prefix=>path.startsWith(prefix)&&path.endsWith('/SKILL.md'))&&!path.split('/').includes('..'))||!Array.isArray(snapshot.skillEntries)||!snapshot.skillEntries.every(entry=>typeof entry==='string')||!/^[a-f0-9]{64}$/.test(snapshot.roles)||hash(snapshot.skillEntries.join('\n'))!==snapshot.skills)throw Error('Invalid repository skill snapshot');
 const root=await realpath(snapshot.root);
 if(snapshot.registryRevision&&((await git(root,['rev-parse','HEAD'])).trim()+':'+(await git(root,['rev-parse','HEAD:projects.json'])).trim()!==snapshot.registryRevision||(await git(root,['status','--porcelain=v1','--untracked-files=all','--','projects.json'])).trim()))throw Error('Project registration changed after task submission');
 if(snapshot.projectRegistration){const project=root+'/'+projectRepository;if((await git(project,['branch','--show-current'])).trim()!==snapshot.projectRegistration.branch||(await git(project,['remote','get-url','origin'])).trim()!==snapshot.projectRegistration.url)throw Error('Project branch or origin changed after task submission');}
 for(const path of snapshot.catalog)if(await realpath(root+'/'+path)!==root+'/'+path)throw Error('Skill catalog path changed after submission');
 if(root+'/'+(snapshot.protocol>=2?projectRepository:snapshot.repository)!==await realpath(config.cwd))throw Error('Repository skill snapshot cwd mismatch');
 for(const item of snapshot.repositorySources) {
  const actual=await realpath(item.root);
  if(actual!==root&&actual!==root+'/'+projectRepository&&actual!==root+'/'+snapshot.repository)throw Error('Repository skill source escapes selected scope');
  if(actual!==item.root||await realpath((await git(actual,['rev-parse','--show-toplevel'])).trim())!==actual||(await git(actual,['rev-parse','HEAD'])).trim()!==item.head)throw Error('Repository changed after task submission; task was not started');
  if(!['skills','.agents/skills'].includes(item.directory))throw Error('Invalid skill source directory');
  if((await git(actual,['status','--porcelain=v1','--untracked-files=all','--',item.directory])).trim())throw Error('Skill files changed after task submission; task was not started');
 }
 if(snapshot.protocol===3) {
  const sources=snapshot.repositorySources.slice(0,-1);
  if(!Array.isArray(snapshot.instructionSources)||snapshot.instructionSources.length!==sources.length)throw Error('Invalid repository instruction snapshot');
  for(const [index,item] of snapshot.instructionSources.entries()) {
   const expectedPath=sources[index].root.slice(root.length+1)+'/AGENTS.md';
   if(item.root!==sources[index].root||!/^[a-f0-9]{64}$/.test(item.tree)||!Array.isArray(item.paths)||item.paths.length>1||item.paths.some(path=>path!==expectedPath))throw Error('Invalid repository instruction snapshot');
   if((await git(item.root,['status','--porcelain=v1','--untracked-files=all','--','AGENTS.md'])).trim())throw Error('Repository instructions changed after task submission; task was not started');
   const tree=(await git(item.root,['ls-tree','HEAD','--','AGENTS.md'])).trim();
   if(hash(tree)!==item.tree||!!tree!==!!item.paths.length)throw Error('Repository instruction version changed after task submission');
  }
 }
 if((await git(root,['status','--porcelain=v1','--untracked-files=all','--','SOUL.md','AGENTS.md','IDENTITY.md'])).trim())throw Error('Agent role files changed after task submission; task was not started');
 return snapshot;
}
