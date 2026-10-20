import {AgentRepoError,registerAgentRepoService} from './dist/agent-repo-api.mjs';
import {readProjects,inspectProject} from './repositories.mjs';
import {git,RepositoryGitCheckError} from './repository-skills.mjs';
import {PreparationError} from './runtime-sync.mjs';
export async function registryRevision(binding) {
 const head=(await git(binding.repo,['rev-parse','HEAD'])).trim();
 const entry=(await git(binding.repo,['ls-tree',head,'--','projects.json'])).trim();
 if(!/^100(?:644|755) blob [a-f0-9]+\tprojects\.json$/.test(entry)||(await git(binding.repo,['status','--porcelain=v1','--untracked-files=all','--','projects.json'])).trim())throw new AgentRepoError('REGISTRY_CHANGED','Project registration must be committed and unchanged');
 return head+':'+entry.split(' ')[2].split('\t')[0];
}
export function createProjectService(binding,agentId,getHostConfig,prepareScope,prepareWorkerSkill) {
 async function read(){const revision=await registryRevision(binding),projects=await readProjects(binding.repo);if(await registryRevision(binding)!==revision)throw new AgentRepoError('REGISTRY_CHANGED','Project registration changed while reading');return {revision,projects};}
 return {apiVersion:1,agentId,root:binding.repo,...(prepareWorkerSkill?{prepareWorkerSkill:()=>prepareWorkerSkill(agentId)}:{}),
  async listProjects(){const {revision,projects}=await read();const ids=Object.keys(projects);return {apiVersion:1,agentId,root:binding.repo,registryRevision:revision,singleProjectId:ids.length===1?ids[0]:null,projects:Object.values(projects).map(p=>({projectId:p.projectId,name:p.name,repository:p.repository}))};},
  async inspectProject({projectId}){const {revision,projects}=await read();if(!Object.hasOwn(projects,projectId))throw new AgentRepoError('PROJECT_NOT_FOUND','Project is not registered');const result=await inspectProject(projects[projectId]);if(await registryRevision(binding)!==revision)throw new AgentRepoError('REGISTRY_CHANGED','Project registration changed while inspecting');return {...result,registryRevision:revision};},
  async prepareExecutionScope(selector={}){
   try {
   if(!selector||typeof selector!=='object'||Object.keys(selector).some(key=>!['projectId','repository','expectedRegistryRevision'].includes(key)))throw new AgentRepoError('PROJECT_SELECTOR_INVALID','Invalid project selector');
   if(selector.projectId!==undefined&&(typeof selector.projectId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(selector.projectId))||selector.repository!==undefined&&(typeof selector.repository!=='string'||!/^(?:project|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/repositories\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/.test(selector.repository)))throw new AgentRepoError('PROJECT_SELECTOR_INVALID','Invalid project selector');
   const {revision,projects}=await read();
   if(selector.expectedRegistryRevision!==undefined&&selector.expectedRegistryRevision!==revision)throw new AgentRepoError('REGISTRY_CHANGED','Project registration changed; select the project again');
   if(selector.projectId!==undefined&&!Object.hasOwn(projects,selector.projectId))throw new AgentRepoError('PROJECT_NOT_FOUND','Project is not registered');
   if(selector.projectId===undefined&&selector.repository===undefined&&Object.keys(projects).length!==1)throw new AgentRepoError('PROJECT_SELECTION_REQUIRED','Multiple projects require an explicit projectId or repository');
   if(selector.projectId!==undefined&&selector.repository!==undefined&&selector.repository!==projects[selector.projectId].repository&&!selector.repository.startsWith(projects[selector.projectId].repository+'/repositories/'))throw new AgentRepoError('PROJECT_SELECTOR_CONFLICT','projectId and repository select different projects');
   const {expectedRegistryRevision,...options}=selector;
   const result=await prepareScope(binding,{...options,agentId,hostConfig:getHostConfig()});
   if(await registryRevision(binding)!==revision)throw new AgentRepoError('REGISTRY_CHANGED','Project registration changed while preparing');
   return {...result,apiVersion:1,agentId,registryRevision:revision,snapshot:{...result.snapshot,registryRevision:revision,projectRegistration:{branch:projects[result.projectId].branch,url:projects[result.projectId].url}}};
   }catch(error){
    if(error instanceof AgentRepoError)throw error;
    // Only our controlled, public diagnostics may reach Main. Child-process
    // stderr/commands and arbitrary parser or plugin errors can contain secrets.
    const detail=error instanceof PreparationError||error instanceof RepositoryGitCheckError?error.message:'check registration, paths and local Git state';
    throw new AgentRepoError(binding.sync?.enabled?'SYNC_BLOCKED':'PROJECT_NOT_READY','Project preparation failed; '+detail);
   }
  },
 };
}
export function installProjectServices(config,getHostConfig,prepareScope,owner,prepareWorkerSkill) {
 const disposers=[];
 try{for(const [agentId,binding] of Object.entries(config.agents))disposers.push(registerAgentRepoService(createProjectService(binding,agentId,getHostConfig,prepareScope,prepareWorkerSkill),{owner}));}
 catch(error){for(const dispose of disposers)dispose();throw error;}
 return ()=>{for(const dispose of disposers)dispose();};
}
