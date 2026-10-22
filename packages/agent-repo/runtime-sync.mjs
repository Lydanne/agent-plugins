import {writeRepositoryLog} from './repository-log.mjs';
import {realpath} from 'node:fs/promises';
import {parseAgentSessionKey} from 'openclaw/plugin-sdk/routing';
import {resolveAgentWorkspaceDir} from 'openclaw/plugin-sdk/agent-runtime';
import {maybeResolveTextAlias} from 'openclaw/plugin-sdk/command-auth-native';
import {shouldHandleTextCommands} from 'openclaw/plugin-sdk/command-surface';
import {readProjects,selectProjectId} from './repositories.mjs';
import {repositorySkills,repositorySelector,agentSkills,git,RepositoryGitCheckError} from './repository-skills.mjs';
import {claimDailySync} from './scheduled-sync.mjs';
import {bindingFor} from './configuration.mjs';
import {syncWorkspace} from './workspace-sync.mjs';

const preparationQueues=new Map();
async function serializePreparation(root,prepare) {
 const previous=preparationQueues.get(root)??Promise.resolve();
 const pending=previous.catch(()=>{}).then(prepare);
 preparationQueues.set(root,pending);
 try{return await pending;}finally{if(preparationQueues.get(root)===pending)preparationQueues.delete(root);}
}

const readOnlyCommands=new Set(['/help','/commands','/status','/whoami','/agents','/subagents']);
const control = (text,cfg,channel) => /^\/(?:stop|abort|status)(?:@[\w-]+)?(?:\s|$)/i.test((text??'').trim()) ||
 shouldHandleTextCommands({cfg,surface:channel,commandSource:'text'}) && readOnlyCommands.has(maybeResolveTextAlias((text??'').trim(),cfg));
const failure = '仓库同步或技能准备未通过，本轮尚未开始。请管理员核对仓库配置、网络与本地 Git 状态。';
export class PreparationError extends Error {}
const failureText = error => error instanceof PreparationError||error instanceof RepositoryGitCheckError ? `${failure}\n原因：${error.message}` : failure;
function legacySyncEnabled(hostConfig) {
 const feishu=hostConfig.channels?.feishu;
 return feishu?.workspaceSync?.enabled===true||Object.values(feishu?.accounts??{}).some(account=>account?.workspaceSync?.enabled===true);
}
export function createRepositoryRuntime(config,getHostConfig,{synchronize=syncWorkspace,resolveWorkspace=resolveAgentWorkspaceDir,parseSession=parseAgentSessionKey,clock=Date.now,logger}={}) {
 // Run IDs are used only to bind the version captured by a prompt hook to its
 // model gate. They are never used as a receipt for a different dispatch.
 const runs=new Map();
 async function log(binding,agentId,entry){try{await writeRepositoryLog(binding.repo,agentId,entry);}catch{logger?.warn?.("agent-repo: repository diagnostic could not be saved");}}
 const enabled=binding=>binding?.sync?.enabled===true;
 async function checkWorkspace(binding,agentId) {
  const host=getHostConfig();
  if(legacySyncEnabled(host))throw new PreparationError('新 Agent Repo 同步与旧 Feishu 同步同时启用，请管理员停用旧入口。');
  const hooks=host.plugins?.entries?.['agent-repo']?.hooks;
  if(hooks?.allowConversationAccess!==true||hooks.allowPromptInjection===false)throw new PreparationError('启用同步必须允许 Agent Repo 会话钩子及提示词注入，请管理员核对 hooks 权限。');
  const root=await realpath(binding.repo);
  if(root!==binding.repo||await realpath(resolveWorkspace(host,agentId))!==root)throw new PreparationError('Agent Repo 必须与本轮智能体的实际工作区一致，且不能经过软链接。');
  if(await realpath((await git(root,['rev-parse','--show-toplevel'])).trim())!==root||(await git(root,['rev-parse','--show-superproject-working-tree'])).trim())throw new PreparationError('Agent Repo 必须是独立 Git 根目录。');
  return root;
 }
 function syncConfig(binding) {
  const {timeoutMs,branch,remote,preserveLocalMemory,gitEnvironment}=binding.sync;
  return {enabled:true,root:binding.repo,timeoutMs,branch,remote,preserveLocalMemory,...(gitEnvironment!==undefined?{gitEnvironment:{...gitEnvironment}}:{}),includeUpstream:false,submodules:[]};
 }
 async function readRegistry(binding) {
  const head=(await git(binding.repo,['rev-parse','HEAD'])).trim();
  if(!/^100(?:644|755) blob [a-f0-9]+\tprojects\.json$/.test((await git(binding.repo,['ls-tree',head,'--','projects.json'])).trim()))throw new PreparationError('项目登记必须是已提交的普通文件。');
  if(await realpath(binding.repo+'/projects.json')!==binding.repo+'/projects.json')throw new PreparationError('项目登记不能经过软链接。');
  const projects=await readProjects(binding.repo);
  const registry={head,projects};
  await assertRegistry(binding,registry);
  return registry;
 }
 async function assertRegistry(binding,registry) {
  if((await git(binding.repo,['rev-parse','HEAD'])).trim()!==registry.head||(await git(binding.repo,['status','--porcelain=v1','--untracked-files=all','--','projects.json'])).trim())throw new PreparationError('角色仓库或项目登记在准备期间改变，本轮已停止，请重试。');
 }
 async function checkProject(project) {
  if((await git(project.paths.repository,['branch','--show-current'])).trim()!==project.branch||(await git(project.paths.repository,['remote','get-url','origin'])).trim()!==project.url)throw new PreparationError('项目分支或远端与当前登记不一致，本轮已停止。');
 }
 async function select(projects,options={}) {
  if(options.repository!==undefined)repositorySelector(options.repository);
  const selected=options.repository===undefined?undefined:Object.values(projects).find(project=>options.repository===project.repository||options.repository.startsWith(project.repository+'/repositories/'));
  if(options.repository!==undefined&&!selected)throw Error('Repository is not registered for this Agent');
  if(selected&&options.projectId!==undefined&&options.projectId!==selected.projectId)throw Error('projectId and repository scopes disagree');
  return projects[selectProjectId(projects,options.projectId??selected?.projectId)];
 }
 function projectConfig(project,submodules=true) {
  return {path:project.repository,expectedUrl:project.url,branch:project.branch,remote:'origin',
   repositorySubmodules:submodules,
   submodules:submodules&&project.knowledge===project.repository+'/wiki'?[{name:'wiki',path:'wiki'}]:[]};
 }
 async function sync(binding,agentId,project,{root=true,submodules=!binding.sync.submoduleSchedule,onProgress,allowLocalChanges=true}={}) {
  await checkWorkspace(binding,agentId);
  if(project&&project.paths.repository!==binding.repo+'/'+project.repository)throw new PreparationError('登记项目目录不能经过软链接。');
  if(project&&(await realpath((await git(project.paths.repository,['rev-parse','--show-toplevel'])).trim())!==project.paths.repository||(await git(project.paths.repository,['rev-parse','--show-superproject-working-tree'])).trim()))throw new PreparationError('登记项目必须是独立 Git 根目录，不能是 Git Submodule。');
  const settings={...syncConfig(binding),...(onProgress?{onProgress}:{})};
  let result;
  if(root)result=await synchronize({...settings,...(project?{project:projectConfig(project,submodules)}:{})});
  else result=await synchronize({...settings,root:project.paths.repository,preserveLocalMemory:false,...projectConfig(project,submodules),project:undefined,submodules:projectConfig(project,submodules).submodules},project.url);
  if(!result?.ok){
   const skipped=allowLocalChanges&&result?.code==='LOCAL_CHANGES';
   await log(binding,agentId,{repository:project?.repository??'Agent Repo',stage:'仓库同步',status:skipped?'skipped':'failed',reason:result?.reason??'仓库准备失败。',effect:skipped?'已跳过同步，继续使用本地资料；技能及角色仍需通过校验。':'准备未通过'});
   if(skipped)return {...result,skipped:true};
   throw new PreparationError(result?.reason??'仓库准备失败。');
  }
  return result;
 }
 async function prepareScope(binding,options) {
  if(!enabled(binding))return repositorySkills(binding,options);
  return serializePreparation(binding.repo,async()=>{
   await checkWorkspace(binding,options.agentId);
   const registry=await readRegistry(binding),project=await select(registry.projects,options);
   const synchronized=await sync(binding,options.agentId,project,{root:false,...(options.syncSubmodules===true?{submodules:true,allowLocalChanges:false}:{})});
   const catalog=await repositorySkills(binding,options);
   await assertRegistry(binding,registry);
   await validate({catalog});
   return options.syncSubmodules===true||synchronized.skipped?{...catalog,synchronization:synchronized}:catalog;
  }).catch(async error=>{
   await log(binding,options.agentId,{repository:options.repository??options.projectId??'Agent Repo',stage:'技能准备',status:'failed',reason:failureText(error),effect:'执行范围准备未通过'});
   throw error;
  });
 }
 async function scheduledSync(agentId,date) {
  const binding=bindingFor(config,{agentId});
  if(!enabled(binding)||!binding.sync.submoduleSchedule)return;
  return serializePreparation(binding.repo,async()=>{
   const receipt=await claimDailySync(binding.repo,agentId,date);
   if(!receipt)return {skipped:true};
   const failures=[];
   let result;
   try {
    await receipt.log({stage:'定时同步',status:'started'});
    await checkWorkspace(binding,agentId);
    await sync(binding,agentId,undefined,{allowLocalChanges:false,onProgress:event=>receipt.log({...event,repository:event.repository==='主仓库'?'Agent Repo':event.repository})});
    const registry=await readRegistry(binding);
    for(const project of Object.values(registry.projects)) {
     try{
      await receipt.log({projectId:project.projectId,repository:project.repository,stage:'项目同步',status:'started'});
      await sync(binding,agentId,project,{root:false,submodules:true,allowLocalChanges:false,onProgress:event=>receipt.log({...event,repository:event.repository==='主仓库'?project.repository:event.repository,projectId:project.projectId})});
      await receipt.log({projectId:project.projectId,repository:project.repository,stage:'项目同步',status:'completed'});
     }
     catch(error){const reason=failureText(error);failures.push({projectId:project.projectId,reason});await receipt.log({projectId:project.projectId,stage:'项目同步',status:'failed',reason});}
    }
    await assertRegistry(binding,registry);
    result={ok:failures.length===0,failures};
   }catch(error){const reason=failureText(error);await receipt.log({stage:'定时同步',status:'failed',reason});await receipt.finish({ok:false,reason});throw error;}
   await receipt.log({stage:'定时同步',status:result.ok?'completed':'failed'});
   await receipt.finish(result);
   return result;
  });
 }
 async function beforeDispatch(event,context) {
  let binding;
  try {
   const session=context.sessionKey;
   const agentId=typeof session==='string'?parseSession(session)?.agentId:undefined;
   binding=bindingFor(config,{agentId});
   if(!enabled(binding))return;
   const channel=context.channelId;
   if(!Object.hasOwn(binding.sync.inboundChannels,channel))return;
   const rule=binding.sync.inboundChannels[channel];
   if(!rule||typeof context.messageId!=='string'||!context.messageId.startsWith(rule.messageIdPrefix)||control(event.content,getHostConfig(),channel))return;
   await serializePreparation(binding.repo,async()=>{
    const result=await sync(binding,agentId);
    // Read registrations after synchronization and bind preparation to that version.
    const registry=await readRegistry(binding);
    if(result.rootHead&&result.rootHead!==registry.head)throw new PreparationError('角色仓库在同步完成后改变，本轮已停止，请重试。');
    const ids=Object.keys(registry.projects);
    // defaultProject is an operator planning hint, never a task fallback.
    const project=ids.length===1?registry.projects[ids[0]]:undefined;
    if(project)await sync(binding,agentId,project,{root:false});
    const catalog=project?await repositorySkills(binding,{agentId,hostConfig:getHostConfig(),projectId:project.projectId}):await agentSkills(binding,{agentId,hostConfig:getHostConfig()});
    await assertRegistry(binding,registry);
    await validate({catalog});
   });
  }catch(error) {
   // Claim hooks are fail-open on throws: return a handled reply explicitly.
   if(enabled(binding)){await log(binding,parseSession(context.sessionKey??'')?.agentId,{repository:'Agent Repo',stage:'入站准备',status:'failed',reason:failureText(error),effect:'本轮未开始'});return {handled:true,text:failureText(error)};}
  }
 }
 function prune() {
  for(const [key,entry] of runs)if(clock()-entry.at>3600000)runs.delete(key);
  while(runs.size>=1000)runs.delete(runs.keys().next().value);
 }
 async function capturePrompt(context,catalog) {
  const binding=bindingFor(config,context);
  if(!enabled(binding))return;
  context.hookInvocation?.assertActive();
  await checkWorkspace(binding,context.agentId);
  if(!context.runId)throw Error('This runner does not expose a model run identity');
  const key=JSON.stringify([context.agentId,context.sessionKey,context.runId]);
  const previous=runs.get(key);
  if(previous)await validate(previous);
  const record={at:clock(),catalog};
  await validate(record);
  if(previous&&catalog.snapshot.repositorySources.find(item=>item.root===binding.repo)?.head!==previous.catalog.snapshot.repositorySources.find(item=>item.root===binding.repo)?.head)throw Error('Agent role changed during this run');
  // Host timeout discards prompt enrichment but does not cancel underlying work.
  // An expired invocation must never publish a version for the model gate.
  context.hookInvocation?.assertActive();
  prune();runs.set(key,record);
 }
 function promptFailure(context) {
  if(!context.runId)return;
  prune();runs.set(JSON.stringify([context.agentId,context.sessionKey,context.runId]),{at:clock(),failed:true});
 }
 async function validate(record) {
  if(record.failed)throw Error('Prompt preparation failed');
  for(const item of record.catalog.snapshot.repositorySources) {
   if(await realpath(item.root)!==item.root||(await git(item.root,['rev-parse','HEAD'])).trim()!==item.head)throw Error('Repository version changed after prompt preparation');
   if((await git(item.root,['status','--porcelain=v1','--untracked-files=all','--',item.directory,'AGENTS.md','SOUL.md','IDENTITY.md','USER.md','TOOLS.md','BOOTSTRAP.md','HEARTBEAT.md'])).trim())throw Error('Role or skill files changed after prompt preparation');
  }
  const binding={repo:record.catalog.snapshot.root};
  const registry=await readRegistry(binding);
  const role=record.catalog.snapshot.repositorySources.find(item=>item.root===binding.repo);
  if(role?.head!==registry.head)throw new PreparationError('项目登记版本与本轮技能快照不一致，本轮已停止。');
  if(record.catalog.projectId){
   const project=registry.projects[record.catalog.projectId];
   if(!project||record.catalog.cwd!==project.paths.repository||record.catalog.snapshot.projectRepository!==project.repository)throw new PreparationError('项目登记范围与本轮技能快照不一致，本轮已停止。');
   await checkProject(project);
  }
  await assertRegistry(binding,registry);
 }
 async function beforeAgentRun(_event,context) {
  const binding=bindingFor(config,context);
  if(!enabled(binding))return {outcome:'pass'};
  try {
   await checkWorkspace(binding,context.agentId);
   if(!context.runId)throw Error('This runner does not expose a model run identity');
   const record=runs.get(JSON.stringify([context.agentId,context.sessionKey,context.runId]));
   if(!record)throw Error('No version captured by this run prompt hook');
   await validate(record);
   return {outcome:'pass'};
  }catch(error){await log(binding,context.agentId,{repository:'Agent Repo',stage:'模型准备校验',status:'failed',reason:failureText(error),effect:'本轮未开始'});return {outcome:'block',reason:'agent-repo prompt repository validation failed',message:failureText(error),category:'repository_sync'};}
 }
 function endRun(context) {if(context.runId)runs.delete(JSON.stringify([context.agentId,context.sessionKey,context.runId]));}
 return {scheduledSync,beforeDispatch,prepareScope,capturePrompt,promptFailure,beforeAgentRun,endRun};
}
