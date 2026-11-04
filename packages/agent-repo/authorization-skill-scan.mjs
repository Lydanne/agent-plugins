import {readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {agentSkills,repositorySkills} from './repository-skills.mjs';
import {readProjects,containedPath} from './repositories.mjs';
/** Read registered scopes without synchronization, installation or command execution. */
export async function scanAuthorizationSkills(binding,{agentId,hostConfig={},knowledgeDefaults}={},dependencies={}){
 const agentReader=dependencies.agentSkills??agentSkills,scopeReader=dependencies.repositorySkills??repositorySkills,projectsReader=dependencies.readProjects??readProjects,childrenReader=dependencies.readdir??readdir;
 const entries=new Map(),failures=[];
 function collect(catalog,provider){
  const revision=createHash('sha256').update(JSON.stringify(catalog.snapshot?.repositorySources??[])).digest('hex');
  for(const skill of catalog.skills){const key=provider+'\0'+skill.name;entries.set(key,{...skill,provider,revision});}
 }
 try{collect(await agentReader(binding,{agentId,hostConfig}),'agent:'+agentId);}catch{failures.push({scope:'agent',reason:'技能索引不可读取'});}
 const projects=await projectsReader(binding.repo);
 for(const project of Object.values(projects)){
  const scopes=[project.repository];
  try{
   const directory=dependencies.containedPath?await dependencies.containedPath(binding.repo,project.repository+'/repositories'):await containedPath(binding.repo,project.repository+'/repositories');
   for(const entry of await childrenReader(directory,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name))scopes.push(project.repository+'/repositories/'+entry.name);
  }catch(error){if(error.code!=='ENOENT')failures.push({scope:project.repository+'/repositories',reason:'子仓库目录不可读取'});}
  for(const repository of scopes){try{collect(await scopeReader(binding,{agentId,hostConfig,knowledgeDefaults,projectId:project.projectId,repository}),'repository:'+repository);}catch{failures.push({scope:repository,reason:'仓库或已提交技能不可读取'});}}
 }
 return {skills:[...entries.values()],failures,complete:failures.length===0};
}
