import {continueContributor,steeringReceiptOutcome} from './question-bridge.mjs';
import {registerAutomation} from './adapters/automation.mjs';
import {hermesCommand} from './hermes-templates.mjs';
import {requestedQueueId,queueIdPattern} from './task-queues.mjs';
import {prepareJobWorkspace,settleJobWorkspace,checkJobWorkspace,holdJobWorkspace} from './workspace-runtime.mjs';
import {hostRequestId,createCollaborationService} from './collaboration.mjs';
import {attachmentPolicy,attachmentSupplement} from './source-attachments.mjs';
import {registerScheduledWorkerStatus} from './scheduled-status.mjs';
import {installWorkerDiagnostics} from './diagnostic-source.mjs';
import {bindingKey,compatibleLegacyBinding,projectFields,modelFields,validateHistoryFilter,matchesHistoryFilter} from './project-binding.mjs';
import {getAgentRepoService,AgentRepoError} from './dist/agent-repo-api.mjs';
import {scopeRuntime,readScopedSkillVersion} from './repository-scope.mjs';
import {registerQuestionBridge,contextPresentation,waitingPresentationInstruction} from './question-bridge.mjs';
import {parseContextRequest} from './context-request.mjs';
import {mainSkillNotice} from './main-capability-skill.mjs';
import {workerEnvironment} from './plugin-environment.mjs';
import {createSessionInspector,registerInspector,inspectionEvent} from './session-inspector.mjs';
import {resolveConfiguration,defaultConfiguration,resolveQueueExecution,executionFingerprint,workerReportInstructions,delegationReportInstructions} from './configuration.mjs';
import {existsSync} from 'node:fs';
import {acquireLock} from './locks.mjs';
import {createCompletionService,completionBridge} from './completion.mjs';
import {experienceInstructions,experienceReviewInstructions,collectExperience} from './experience.mjs';
import {normalizeMemoryContext,memoryContextSchema,memoryPolicy,memoryHandoffSummary,memoryDelegationInstructions} from './memory-context.mjs';
import {readSkillVersion,revisionOf,skillRefreshPlan,refreshSkillSession,skillTaskContext,reviewedContinuationMatches} from './skill-refresh.mjs';
import {rememberDiagnostic,describeQueryJob,explainQueryError} from './diagnostics.mjs';
import {sourceTaskBridge,hasSourceProvenance,bindSourceTask,taskProvenance,rememberAsyncJob,rememberAsyncContinuation,rememberUserQuestion} from './source-tasks.mjs';
import {createJobs} from './jobs.mjs';
import {asyncRunRequested,waitForQueryJob,discoverTopics} from './dispatch-policy.mjs';
import {fileURLToPath} from 'node:url';
import {delimiter,join} from 'node:path';
import {tmpdir} from 'node:os';
import {StringDecoder} from 'node:string_decoder';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,mkdtemp,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
let configuration=resolveConfiguration();
let hostConfiguration=()=>({});
async function load(file){try{return JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return {};throw e}}
async function save(file,data){const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(data),{mode:0o600});await rename(tmp,file)}


export const executionPolicyVersion = 7;
export {executorInstructions,businessDataPolicy} from './configuration.mjs';
export function buildTaskPrompt(params,context={},config=configuration) {
 if(params.responsibility!==undefined&&(typeof params.responsibility!=='string'||!params.responsibility.trim()||params.responsibility.length>2000))throw Error('Invalid responsibility');
 if(typeof params.constraints!=='string'||!params.constraints.trim()||params.constraints.length>4000) throw Error('For run, provide explicit execution constraints (1–4000 characters), including allowed writes or read-only scope');
 return JSON.stringify({kind:'business_task',...(context.attachments?.length?{attachments:context.attachments,attachmentPolicy}:{}),responsibility:params.responsibility??'你是 Main 委派的 Worker，负责完成本轮 task、核验结果并生成完整客观报告；Main 负责业务决策、插件调用和面向用户的交付。',...(context.people?{people:context.people,peoplePolicy:'people 是渠道绑定的本次任务人员快照。记录人为 requester；原生提及仅在本次请求明确指派时作为 Assignees。账号 email_prefix 为候选，须核验真实账号及仓库指派权限；不能用登录账号、引用作者或后续发言者替代记录人。'}:{}),reportInstructions:workerReportInstructions,...(context.reportDirectory?{reportDirectory:context.reportDirectory,reportPolicy:'本 job 新报告和临时证据仅写入 reportDirectory（相对工作目录）；按需创建子目录，返回报告绝对路径，不覆盖其他 job 的文件。'}:{}),...(params.mainReplies?{mainReplies:params.mainReplies}:{}),task:params.task,constraints:params.constraints,context:params.context,memory:normalizeMemoryContext(params.memory),memoryPolicy,dataPolicy:config.businessDataPolicy,experienceInstructions,...(config.projectContext?{project:config.projectContext}:{})});
}
export function selectExecutionSession(entry) {
 return entry?.executionPolicyVersion===executionPolicyVersion ? entry.sessionId : undefined;
}

async function currentSkillVersion(config){return config.scopedSkillSnapshot?readScopedSkillVersion(config):readSkillVersion(config.state,config.skillContextRoot||config.cwd,config.skillDirectories);}
let jobLimits={maxConcurrentJobs:3,maxQueuedJobs:100,maxConcurrentLongJobs:1,maxQueuedLongJobs:100};
export async function executeQuery(params,context={},runtime=configuration){
 // Admitted workers (including pre-catalog snapshots) retain their exact selection.
 const config=params.action==='list'||runtime.harness?resolveConfiguration(runtime):resolveQueueExecution(runtime,params);
 if(config.scopedSkillSnapshot)await readScopedSkillVersion(config);
 const {state,cwd}=config;
 const fingerprint=executionFingerprint(config);
 context.signal?.throwIfAborted();
 if(params.useWorkspace!==undefined&&(params.action!=='run'||typeof params.useWorkspace!=='boolean'))throw Error('useWorkspace is a boolean supported only for run');
 const scope=context.sessionKey;
 if(!scope)throw Error('A trusted OpenClaw conversation context is required');
 await mkdir(state,{recursive:true,mode:0o700});
 const scopeHash=createHash('sha256').update(scope).digest('hex');
 const file=state+'/'+scopeHash+'.json';
 if(params.action==='list'){
  validateHistoryFilter(params);
  const db=await load(file);let current;try{if(config.skillsEnabled)current=await currentSkillVersion(config);}catch{ /* Report unknown, never mark current. */ }
  const tasks=await Promise.all(Object.values(db).filter(entry=>matchesHistoryFilter(entry,params)).map(async entry=>{
   const {topic,sessionId,updatedAt,cwd:savedCwd,executionPolicyVersion:version,skillsSnapshot,skillsRefreshFailed,configurationFingerprint}=entry;
   let scoped=config,versionCurrent=current,invalid=false;
   try{scoped=resolveQueueExecution(runtime,{queueId:entry.queueId});}catch{invalid=true;}
   if(entry.project){
    scoped={...scoped,cwd:savedCwd,skillContextRoot:entry.project.root,projectContext:entry.project,scopedSkillSnapshot:skillsSnapshot,executorInstructions:scoped.executorInstructions.replaceAll(scoped.cwd,savedCwd).replaceAll('{projectDir}',savedCwd),delegationInstructions:scoped.delegationInstructions.replaceAll(scoped.cwd,savedCwd).replaceAll('{projectDir}',savedCwd)};
    try{versionCurrent=await readScopedSkillVersion(scoped);}catch{invalid=true;versionCurrent=undefined;}
   }
   return {topic,sessionId,updatedAt,...modelFields(entry),...(entry.project?{projectId:entry.project.projectId,repository:entry.project.repository,cwd:savedCwd}:{}),needsMigration:invalid||entry.modelSessionScope!==scoped.modelSessionScope||savedCwd!==scoped.cwd||configurationFingerprint!==executionFingerprint(scoped)||version!==executionPolicyVersion||!!skillsRefreshFailed||(config.skillsEnabled&&!skillsSnapshot)||!!(versionCurrent&&skillRefreshPlan(skillsSnapshot,versionCurrent).migrate),needsSkillsUpdate:config.skillsEnabled&&(!!skillsRefreshFailed||!versionCurrent||!skillsSnapshot||revisionOf(skillsSnapshot)!==revisionOf(versionCurrent)),appliedSkillsRevision:revisionOf(skillsSnapshot)};
  }));
  return {content:[{type:'text',text:JSON.stringify({skillsRevision:revisionOf(current),skillsStatus:!config.skillsEnabled?'disabled':current?'available':'unavailable',tasks})}]};
 }
 if(typeof params.context!=='string'||!params.context.trim()||params.context.length>40000)throw Error('For run, provide relevant conversation context, or explicitly state no prior context is available');
 if(typeof params.topic!=='string'||!params.topic.trim()||params.topic.length>160)throw Error('Choose a stable topic (1–160 characters); list existing topics first');
 const topic=params.topic.trim();

 if(typeof params.task!=='string'||!params.task.trim()||params.task.length>40000) throw Error('Provide a task of 1–40000 characters');
 const taskPrompt=buildTaskPrompt(params,context,config);
 const key=bindingKey(topic,config);
 const legacySessionLock=state+'/session-locks/'+createHash('sha256').update(JSON.stringify([scope,topic])).digest('hex');
 const projectSessionLock=config.executionScope?state+'/session-locks/'+createHash('sha256').update(JSON.stringify([scope,config.executionScope,topic])).digest('hex'):legacySessionLock;
 const sessionLock=config.modelSessionScope?state+'/session-locks/'+createHash('sha256').update(JSON.stringify([scope,key])).digest('hex'):projectSessionLock;
 await mkdir(state+'/session-locks',{recursive:true,mode:0o700});
 // The legacy global lock must not be removed or bypassed while an old worker runs.
 if(existsSync(state+'/lock'))throw Error('Legacy executor lock is unresolved; existing business execution must settle');
 let locked=false,db,entry,threadId,skillsSnapshot,mainSkillNotifiedRevision,skillsRefreshFailed=false,legacyKey;
 const commands=[];
 const persistBinding=async()=>{
  if(!locked||!threadId||!db)return;
  const release=await acquireLock(state+'/binding-'+scopeHash+'.lock');
  try{const latest=await load(file);if(legacyKey&&compatibleLegacyBinding(latest[legacyKey],config)&&latest[legacyKey].sessionId===entry.sessionId)delete latest[legacyKey];await save(file,{...latest,[key]:{topic,...projectFields(config),...modelFields(config),sessionId:threadId,cwd,executionPolicyVersion,configurationFingerprint:fingerprint,skillsSnapshot,mainSkillNotifiedRevision,skillsRefreshFailed,previousSessionIds:[...new Set([...(entry?.previousSessionIds??[]),...(entry&&entry.sessionId!==threadId?[entry.sessionId]:[])])],updatedAt:new Date().toISOString()}});}
  finally{release();}
 };
 let releaseSession;const legacyReleases=[];

 try{
  for(const path of new Set([legacySessionLock,projectSessionLock]))if(path!==sessionLock&&existsSync(path))legacyReleases.push(await acquireLock(path,context.signal));
  releaseSession=await acquireLock(sessionLock,context.signal);locked=true;
  db=await load(file);entry=db[key];
  if(!entry){legacyKey=[bindingKey(topic,{executionScope:config.executionScope}),topic].find(candidate=>candidate!==key&&compatibleLegacyBinding(db[candidate],config));if(legacyKey)entry=db[legacyKey];}
  if(entry&&(!/^[0-9a-f-]{36}$/i.test(entry.sessionId)))throw Error('Invalid saved session binding');
  const currentSkills=config.skillsEnabled ? await currentSkillVersion(config) : undefined;
  const plan=currentSkills ? skillRefreshPlan(entry?.skillsSnapshot,currentSkills) : {migrate:false};
  // Only a bound in-flight continuation may retain the compatible v5 session.
  // New runs still migrate; unsafe older policies and other validation failures do not.
  const legacyContinuation=!!context.expectedSessionId && context.expectedSessionId===entry?.sessionId && entry?.executionPolicyVersion===5;
  const expectedFingerprint=legacyContinuation ? executionFingerprint(config,{policyVersion:5}) : fingerprint;
  const resumeId=entry?.cwd!==cwd || entry?.configurationFingerprint!==expectedFingerprint || (plan.migrate&&!reviewedContinuationMatches(config.reviewedContinuation,context.expectedSessionId,entry?.skillsSnapshot,currentSkills)) || entry?.skillsRefreshFailed || (config.skillsEnabled && !entry?.skillsSnapshot) ? undefined : legacyContinuation ? entry.sessionId : selectExecutionSession(entry);
  if(context.expectedSessionId && resumeId!==context.expectedSessionId)throw Error('Original Worker session cannot be resumed safely');
  skillsSnapshot=config.skillsEnabled?(resumeId?entry?.skillsSnapshot:undefined):config.scopedSkillSnapshot;
  threadId=resumeId;
  context.signal?.throwIfAborted();
  mainSkillNotifiedRevision=resumeId?entry?.mainSkillNotifiedRevision:undefined;
  const collaborationSkill=await mainSkillNotice(config.mainCapabilitySkill,mainSkillNotifiedRevision,config.projectContext?.agentId);
  const deadline=Date.now()+config.timeoutMs;
  const runTurn=async(prompt,{refresh=false,outputSchema}={})=>{
  let schemaDirectory;
  try{
   let outputSchemaPath;
   if(refresh&&outputSchema){
    schemaDirectory=await mkdtemp(join(tmpdir(),'agent-worker-skill-ack-'));
    outputSchemaPath=join(schemaDirectory,'response.schema.json');
    await writeFile(outputSchemaPath,JSON.stringify(outputSchema),{mode:0o600});
   }
   context.signal?.throwIfAborted();
   return await new Promise((resolve,reject)=>{
  const invocation=hermesCommand(config,{refresh,threadId,outputSchemaPath,prompt}),args=invocation.args;
  const child=spawn(invocation.command,args,{cwd,detached:true,stdio:['pipe','pipe','pipe'],env:{...workerEnvironment(),CODEX_HOME:config.codexHome,...(config.pathPrefix?{PATH:[config.pathPrefix,process.env.PATH].filter(Boolean).join(delimiter)}:{})}});
  if(config.workspace&&child.pid)context.onProgress?.({executionPid:child.pid});
  const decoder=new StringDecoder('utf8');
  let out='',size=0,failed; const messages=[];
  const stop=()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}};
  const abort=()=>{failed=Error('Codex query cancelled');stop();};
  context.signal?.addEventListener('abort',abort,{once:true});
  if(context.signal?.aborted)abort();
  const timer=setTimeout(()=>{failed=Object.assign(Error(config.timeoutMs===600000?'Codex query exceeded 10 minutes':'Codex query exceeded '+config.timeoutMs+' ms'),{code:'EXECUTION_TIMEOUT'});stop()},Math.max(1,deadline-Date.now()));
  let stderr='';
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);});
  child.stdout.on('data',chunk=>{
   size+=chunk.length;if(size>8*1024*1024){failed=Error('Codex output limit exceeded');stop();return;}
   out+=decoder.write(chunk);let pos;while((pos=out.indexOf('\n'))>=0){const line=out.slice(0,pos);out=out.slice(pos+1);try{
    const e=JSON.parse(line);const recorded=inspectionEvent(e,refresh?'refresh':'business');if(recorded){try{context.onInspectionEvent?.(recorded);}catch{failed=Error('Execution inspection log could not be persisted');stop();return;}}if(e.type==='thread.started'&&typeof e.thread_id==='string'){threadId=e.thread_id;context.onProgress?.({sessionId:threadId});}if(e.type==='item.completed'&&e.item?.type==='agent_message') {messages.push(e.item.text);context.onProgress?.({progress:refresh?'正在更新执行会话的技能索引。':e.item.text.slice(-2000)});}
    if(refresh && e.item && ['command_execution','mcp_tool_call','web_search','file_change'].includes(e.item.type)){failed=Error('Skill refresh attempted a tool action; user task was not started');stop();}
    if(!refresh && e.type==='item.completed'&&e.item?.type==='command_execution')commands.push({exitCode:e.item.exit_code});
    if(e.type==='turn.failed') failed=Error(explainQueryError(e.error?.message ?? 'Codex turn failed').message);
   }catch{}}
  });
  child.on('error',e=>{clearTimeout(timer);reject(e)});
  child.on('close',code=>{clearTimeout(timer);context.signal?.removeEventListener('abort',abort);if(failed||code!==0)return reject(failed??Error(explainQueryError(stderr || 'Codex exited with code '+code).message));if(!messages.length)return reject(Error('Codex returned no final response'));resolve(messages.at(-1))});
  child.stdin.on('error',()=>{});
  child.stdin.end(invocation.stdin);
 });
  }finally{if(schemaDirectory)await rm(schemaDirectory,{recursive:true,force:true});}
 };
  if(revisionOf(skillsSnapshot)!==revisionOf(currentSkills))context.onProgress?.({skillsStatus:'refreshing',targetSkillsRevision:revisionOf(currentSkills)});
  try {if(currentSkills)await refreshSkillSession({previous:skillsSnapshot,current:currentSkills,runTurn,signal:context.signal,
    onApplied:async snapshot=>{skillsSnapshot=snapshot;await persistBinding();context.onProgress?.({appliedSkillsRevision:revisionOf(snapshot),skillsStatus:'catalog_applied'});}});}catch(error){skillsRefreshFailed=!context.signal?.aborted;throw error;}
  // A newer publication during the refresh must not be acknowledged by this run.
  if(currentSkills && revisionOf(await currentSkillVersion(config))!==revisionOf(currentSkills))throw Error('Skills changed during refresh; user task was not started');
  if(currentSkills&&revisionOf(skillsSnapshot)===revisionOf(currentSkills))skillsSnapshot=currentSkills;
  context.signal?.throwIfAborted();
  const rawResult=await runTurn(JSON.stringify({...JSON.parse(taskPrompt),...(collaborationSkill?{collaborationSkill}:{}),...(currentSkills?{skills:skillTaskContext(currentSkills)}:{})}));
  if(collaborationSkill)mainSkillNotifiedRevision=collaborationSkill.revision;
  const contextRequest=parseContextRequest(rawResult);
  const {result,experienceReview,reportPaths=[]}=collectExperience(rawResult,{scope,topic});
  return {content:[{type:'text',text:JSON.stringify({...(contextRequest?{contextRequest}:{}),topic,sessionId:threadId,...projectFields(config),...modelFields(config),reused:!!resumeId,migratedFrom:entry&&!resumeId?entry.sessionId:undefined,executionPolicyVersion,cwd,reportDirectory:context.reportDirectory,model:config.model,harness:config.harness,reasoningEffort:config.reasoningEffort,speed:config.speed??'inherited',appliedSkillsRevision:revisionOf(skillsSnapshot),skillsStatus:config.skillsEnabled?'catalog_applied':'disabled',approvalMode:config.approvalMode,commands,memoryReview:memoryHandoffSummary(params.memory),experienceReview,reportPaths,result})}]};
 }finally{
  try{await persistBinding()}finally{releaseSession?.();for(const release of legacyReleases.reverse())release();}
 }
}
function makeJobs(config){return createJobs({root:config.state+'/jobs',node:config.node,getRuntime:(params,provenance)=>params?scopeRuntime(resolveQueueExecution(config,params),params,provenance,hostConfiguration()):config,prepareWorkspace:prepareJobWorkspace,settleWorkspace:settleJobWorkspace,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getLimits:()=>jobLimits,authorizeUserTimeout:p=>completionBridge.authorizeReply?.(p)===true,mainTimeoutGraceMs:60000,getRequestId:hostRequestId,getUserTimeoutSubmission:job=>globalThis[Symbol.for('ada.worker-question.v1')]?.submission?.({jobId:job.jobId,questionId:job.contextRequest.questionId,provenance:job.provenance}),logger:{error:message=>console.error(message)}});}
let jobs=makeJobs(configuration);
async function queryInternal(params,context={}) {
 if(params.thinkingLevel!==undefined)throw Error('thinkingLevel has been removed; configure Hermes variables instead');
 if((params.taskClass!==undefined||params.queueId!==undefined)&&params.action!=='run')throw Error('queueId/taskClass are only supported for run; reply retains the original queue');
 requestedQueueId(params);
 if((['repository','projectId'].some(key=>params[key]!==undefined)&&!['run','list'].includes(params.action))||(params.expectedRegistryRevision!==undefined&&params.action!=='run'))throw new AgentRepoError('PROJECT_SELECTOR_INVALID','projectId/repository are only supported for run/list; expectedRegistryRevision is only supported for run');
 if(params.useWorkspace!==undefined&&(params.action!=='run'||typeof params.useWorkspace!=='boolean'))throw Error('useWorkspace is a boolean supported only for run');
 const scope=context.sessionKey;
 if(!scope)throw Error('A trusted OpenClaw conversation context is required');
 const wrap=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
 if(params.modelId!==undefined)throw Error('modelId has been removed; select queueId');
 if(params.action==='queues')return wrap({defaultQueueId:configuration.defaultQueueId,queues:Object.entries(configuration.taskQueues).map(([id,queue])=>({id,...queue}))});
 if(params.action==='models')throw Error('models has been removed; use action=queues');
 if(params.action==='projects')return wrap(await getAgentRepoService(context).listProjects());
 if(params.action==='list') {
  if(Object.hasOwn(params,'limit')||Object.hasOwn(params,'offset'))throw Error('list does not accept limit or offset; configure jobListLimit in plugin settings');
  const topics=await executeQuery(params,context);
  const listed=jobs.search(scope,{limit:context.jobListLimit??10,query:params.query,projectId:params.projectId,repository:params.repository});
  const topicData=JSON.parse(topics.content[0].text);
  return wrap({...topicData,...discoverTopics(topicData.tasks,{limit:context.jobListLimit??10,query:params.query,jobTopics:listed.jobs,projectId:params.projectId,repository:params.repository}),...listed});
 }
 if(params.action==='tag'){if(params.tags===undefined)throw Error('tags is required for tag');return wrap(jobs.tag(params.jobId,scope,params.tags,{senderId:context.requesterSenderId,accountId:context.agentAccountId},params.tagMode));}
 if(params.action==='steer'){
  if(params.questionId!==undefined)throw Error('steer does not answer a question; use reply for an existing question');
  const original=jobs.status(params.jobId,scope),lease=bindSourceTask(context),source=lease?taskProvenance(lease):undefined;
  if(!source||lease.scheduledRequest||!hasSourceProvenance(original.provenance))throw Error('Steering requires a current trusted human task source');
  const bound=attachmentSupplement(original.provenance,{...source,...(source.senderId!==original.provenance.senderId?{kind:'group_context'}:{})});
  const requester={senderId:context.requesterSenderId,accountId:context.agentAccountId},authorize=p=>completionBridge.authorizeReply?.(p)===true;
  let request=await jobs.prepareSteering(params.jobId,scope,params.answer,requester,bound,authorize);
  if(bound.senderId!==original.provenance.senderId){
   const permission=await jobs.requestContributor(params.jobId,scope,request.questionId,params.answer,requester,bound,authorize);
   if(!permission.approved){
    const presentation=await contextPresentation(completionBridge.contributorApproval,{jobId:original.jobId,provenance:original.provenance,request:permission.request});
    return wrap({jobId:original.jobId,steeringId:request.questionId,accepted:false,contextSaved:true,permissionPending:true,presentation,instruction:'引导已保存，尚未进入执行队列；等待原请求人在授权卡片确认。卡片未投递成功则如实说明；不绕过授权，不创建新的业务任务。'});
   }
   request=permission.request;
  }
  const record=await jobs.enqueueSteering(params.jobId,scope,request,authorize);
  const outcome=steeringReceiptOutcome(record);
  return wrap({jobId:original.jobId,steeringId:record.supplementId,accepted:outcome.queued||outcome.resumed,...outcome,instruction:outcome.queued?'引导已保存，将在原任务当前执行轮次结束后沿原 Worker 会话处理；不是实时插入，也未改变原 task/constraints。独立决策、授权或插件问题仍需单独回答。结束本轮，不中断、不重复提交或轮询。':outcome.resumed?'这条引导此前已交回原会话接续，本次仅返回已有回执，未重复排队；不把已交回称为业务已完成。':'这条引导未能接续，已保存终态及原因；不是等待执行，不自动重建或重试业务。请按原任务状态说明未完成事项。'});
 }
 if(['reply','await_user'].includes(params.action)){
  const original=jobs.status(params.jobId,scope);
  const sourceBound=hasSourceProvenance(original.provenance);
  if(sourceBound && (!completionBridge.authorizeReply || !completionBridge.authorizeReply(original.provenance)))throw Error('Original task authorization is no longer current');
  const continuationLease=bindSourceTask(context);
  const continuationSource=continuationLease?taskProvenance(continuationLease):undefined;
  const requester={senderId:context.requesterSenderId,accountId:context.agentAccountId},authorize=p=>!hasSourceProvenance(p)||completionBridge.authorizeReply?.(p)===true;
  const groupContext=params.action==='reply'&&sourceBound&&continuationSource&&continuationSource.senderId!==original.provenance.senderId
   ?attachmentSupplement(original.provenance,{...continuationSource,kind:'group_context'}):undefined;
  if(groupContext&&(typeof params.answer!=='string'||!params.answer.trim()))throw Error('Invalid Main answer');
  const replyAnswer=params.answer;
  let contributorApprovalId;
  if(groupContext){
   const permission=await jobs.requestContributor(params.jobId,scope,params.questionId,replyAnswer,requester,groupContext,authorize);
   contributorApprovalId=permission.approvalId;
   if(permission.approved&&(original.questions??[]).find(q=>q.questionId===params.questionId)?.resumeReason==='user_wait_timeout'){
    const outcome=await continueContributor(jobs,original,permission.request,authorize,completionBridge);
    return wrap({jobId:original.jobId,questionId:params.questionId,status:jobs.status(original.jobId,scope).status,accepted:outcome.resumed||outcome.queued===true,continuationQueued:outcome.queued===true,instruction:outcome.queued?'补充已获许可并保存，将在当前 Worker 轮次结束后沿原会话接续。结束本轮，不中断或重建任务，不重复提交或轮询。':outcome.resumed?'补充已交回原任务；结束本轮，不重复提交。':'授权仍有效，但原问题已不可接续；补充尚未恢复执行。'});
   }
   if(!permission.approved){
    const presentation=await contextPresentation(completionBridge.contributorApproval,{jobId:original.jobId,provenance:original.provenance,request:permission.request});
    return wrap({jobId:original.jobId,questionId:params.questionId,status:original.status,accepted:false,contextSaved:true,permissionPending:true,presentation,instruction:presentation.interactive?'补充已保存，等待原请求人在授权卡片中选择允许范围。可简短说明补充已保存、等待授权；结束本轮，不重复提问、不重建或恢复任务，不把保存当作已交给 Worker。':'补充已保存但授权卡片未成功投递，尚未交给 Worker。说明卡片投递失败；可用相同参数重试，不绕过原请求人授权、不新建任务。'});
   }
  }
  const submitted=params.action==='reply'&&sourceBound?globalThis[Symbol.for('ada.worker-question.v1')]?.submission?.({jobId:original.jobId,questionId:params.questionId,provenance:original.provenance}):undefined;
  if(params.answerBasis!==undefined&&(typeof params.answerBasis!=='string'||params.answerBasis.length>1000))throw Error('Invalid answer basis');
  const resumed=params.action==='await_user'?await jobs.awaitUser(params.jobId,scope,params.questionId,requester,authorize,params.knownValues):await jobs.reply(params.jobId,scope,params.questionId,(original.contextRequest??original.questions?.find(q=>q.questionId===params.questionId))?.timeoutRequestedAt&&submitted?.answerText?replyAnswer+'\n用户已提交的真实补充（优先核对，不扩大原授权）：\n'+submitted.answerText:replyAnswer,requester,authorize,false,undefined,{answerSource:continuationLease?'user_text':'main_context',...submitted,...(groupContext?{attachmentSource:groupContext,contributorApprovalId}:continuationSource?.attachments?.length?{attachmentSource:attachmentSupplement(original.provenance,continuationSource)}:{}),...(params.answerBasis?{answerBasis:params.answerBasis}:{})});
  // Directory refresh is metadata maintenance, never a prerequisite for accepting an answer.
  if(params.action==='reply'&&context.agentId&&original.project)void Promise.resolve().then(()=>getAgentRepoService(context,{required:false})?.prepareWorkerSkill?.()).catch(()=>console.error('Main Worker skill refresh failed; the accepted reply and previous skill remain available'));
  const newlyAnswered=params.action==='reply'&&['awaiting_main','awaiting_user'].includes(original.status);
  if(params.action==='await_user')rememberUserQuestion(continuationLease,resumed,params.questionId);
  const continuationHeld=newlyAnswered&&rememberAsyncContinuation(continuationLease,resumed,params.questionId);
  let presentation={interactive:false,state:'unavailable'};
  // An idempotent reply may repair presentation without resuming the business job again.
  const repairPresentation=params.action==='reply' && ['queued','running'].includes(resumed.status) && resumed.questions?.at(-1)?.questionId===params.questionId;
  if(sourceBound && (params.action==='await_user'||newlyAnswered||repairPresentation)){
   presentation=await contextPresentation(completionBridge.contextState,{jobId:original.jobId,questionId:params.questionId,provenance:original.provenance,status:params.action==='await_user'?'awaiting_user':'resumed',contextRequest:resumed.contextRequest});
   if(presentation.state==='failed')console.error('Worker context presentation update failed; task state remains authoritative');
  }
  return wrap({jobId:resumed.jobId,topic:resumed.topic,status:resumed.status,questionId:params.questionId,accepted:true,presentation,instruction:params.action==='await_user'?waitingPresentationInstruction(presentation):'补充上下文已受理；保留原任务及 Worker 会话。'+(continuationHeld?'宿主保留本轮的新工作卡显示后续进度，不另发重复受理消息。':'沿用当前任务的交付位置。')+'结束当前轮次，不创建新的 run，不重复 reply 或轮询。'});
 }
 if(params.action==='status')return wrap(jobs.status(params.jobId,scope));
 if(params.action==='wait')return wrap(await waitForQueryJob(params,context,jobs));
 if(params.action==='cancel')return wrap(jobs.cancel(params.jobId,scope,{senderId:context.requesterSenderId,accountId:context.agentAccountId}));
 if(params.action!=='run')throw Error('Invalid action');
 for(const [key,max] of [['topic',160],['task',40000],['context',40000]])if(typeof params[key]!=='string'||!params[key].trim()||params[key].length>max)throw Error('Invalid '+key);
 normalizeMemoryContext(params.memory,{required:configuration.memoryRequired});
 buildTaskPrompt(params);
 if(params.requestId!==undefined&&(typeof params.requestId!=='string'||params.requestId.length>160))throw Error('Invalid requestId');
 if(params.waitSeconds!==undefined&&(!Number.isInteger(params.waitSeconds)||params.waitSeconds<0||params.waitSeconds>30))throw Error('Invalid waitSeconds');
 const lease=context.sourceTaskLease;
 if((context.messageChannel==='feishu'||scope.includes(':feishu:')) && !lease) throw Error('No active source-bound task; execution is not authorized');
 const source=taskProvenance(lease);
 const provenance=context.automationTask?{agentId:context.agentId,sessionId:context.sessionId,automation:context.automationTask}:source?{...source,agentId:context.agentId,sessionId:context.sessionId}:context.agentId?{agentId:context.agentId,sessionId:context.sessionId}:undefined;
 const cancel=()=>{try{jobs.cancelTask(lease.taskId,lease.revision);}catch{console.error("Source task cancellation could not be persisted; durable recall handler will retry.");}};
 lease?.signal.addEventListener('abort',cancel,{once:true});
 try {
  lease?.signal.throwIfAborted();
  const asyncDelivery = asyncRunRequested(params,context);
  if (asyncDelivery && (!source || !completionBridge.deliver)) throw Error('Async completion requires the active Feishu completion adapter and source-bound task');
  const reply = await jobs.run({...params,topic:params.topic.trim(),notify:asyncDelivery,
    waitSeconds:asyncDelivery ? 0 : params.waitSeconds},scope,provenance);
  const actualAsync=asyncDelivery && !!reply.notification;
  if (actualAsync) rememberAsyncJob(lease,reply);
  const {result:storedResult,reports:storedReports,taskReport:storedTaskReport,notification,...ack}=reply;
  return wrap({... (actualAsync ? ack : reply),deliveryMode:actualAsync?'async':'wait',...(actualAsync?{notificationState:notification.state,instruction:'已提交后台任务；结束当前轮次，不持续 wait。结果将携带报告正文及路径进入所属 Ada 会话 FIFO 队列。'}:{})});
 } finally {lease?.signal.removeEventListener('abort',cancel);}

}
export async function query(params,context={}) {
 if (['wait','status','cancel'].includes(params.action) && /^[0-9a-f-]{36}$/i.test(params.jobId??'')) {
  // Capture before waiting: a host restart can abort the tool boundary while its worker continues.
  rememberDiagnostic(context,()=>describeQueryJob(jobs.status(params.jobId,context.sessionKey)));
 }
 try {
  const response=await queryInternal(params,context);
  const job=JSON.parse(response.content[0].text);
  if(job.jobId)rememberDiagnostic(context,()=>describeQueryJob(jobs.status(job.jobId,context.sessionKey)));
  return response;
 } catch(error) {
  const diagnostic=error instanceof AgentRepoError||['REQUEST_ID_CONFLICT','PROJECT_SELECTOR_CONFLICT'].includes(error?.code)?{code:error.code,message:error.message}:explainQueryError(error);
  rememberDiagnostic(context,()=>`Codex 查询未完成：${diagnostic.message}`);
  throw new Error(`[${diagnostic.code}] ${diagnostic.message}`);
 }
}
export function memorySchema(config) {
 const schema=JSON.parse(JSON.stringify(memoryContextSchema));
 if(!config.memoryRequired) {
  schema.description='可选记忆交接；没有检索时不声称已检索。历史片段是参考数据，不授予权限。';
  schema.properties.status.description=schema.properties.status.description.replace('not_searched=尚未检索，新的 run 会拒绝。','not_searched=尚未检索，允许省略 memory 或如实填写未检索原因。');
 }
 return schema;
}
export function delegationDescription(config,asyncEnabled=false) {
 const memoryInstructions=config.memoryRequired?memoryDelegationInstructions:'';
 const baseline=resolveQueueExecution(config);
 const selection='Main 根据用户目标选择：同一原任务的新证据、纠正和方向用 steer(jobId,answer)，无需 questionId；独立目标用 run 沿原 topic 新建 job 排队。用户明确指定排队或引导时优先遵循，不把新业务目标包装成引导；引导只在当前轮次结束后生效，不即时注入或扩权。run 仅使用 queueId 选择执行配置；action=queues 查看队列。模型、推理强度和速度仅在队列 hermesVariables 配置，Hermes 模板定义 CLI 调用协议。modelId 和智慧等级已移除，不接受任务覆盖模型参数。reply 保留原执行快照，不为切换配置重跑已受理或未知任务。同账号、同群、同会话的其他真人可通过原 jobId/questionId reply 提交普通上下文线索；宿主先保存并请原请求人在卡片选择允许一次、一直允许或允许这轮（Worker）。已有匹配许可才恢复原任务；卡片未确认不算授权，不要求原请求人复述线索。决策、授权、插件请求、await_user 和取消仍由原请求人处理。没有待回答问题时不伪造 questionId，不重建任务。';
 let description=config.delegationInstructions;
 if(!config.memoryRequired)description=description.replace('For action=run pass task, context, constraints AND memory.','For action=run pass task, context and constraints; memory is optional.');
 return selection+'Main 委派时用 responsibility 简要说明本次职责，task 交代具体任务；agent-repo 自动生成当前 Main 插件目录与通信协议的全局 Codex 技能，宿主在业务输入 collaborationSkill 中显式要求加载。代码修复任务可传 useWorkspace=true，在登记的独立 clone 池中执行；池满保留原 job 等待，不回退共享目录。技能版本变化会通知 Worker 重新读取；不要复制整段协议或自行指定技能路径。'+delegationReportInstructions+'需要用户决策时，Main 用 action=await_user 携带 jobId、questionId 标记等待用户并询问原用户；收到补充后 reply。Worker 可返回 context_request 暂停原任务并向 Main 提问；收到上下文请求后，核对原 task/constraints，用 action=reply 携带 jobId、questionId、answer 补充上下文；不调用新的 run，不扩大授权。'+(asyncEnabled?config.asyncInstructions:'')+experienceReviewInstructions+memoryInstructions+description.replaceAll('{projectDir}',config.cwd).replaceAll(defaultConfiguration.cwd,config.cwd).replace('GPT-6.1 Sol low, dangerous full access with no sandbox or approval prompts',baseline?`${baseline.model} ${baseline.reasoningEffort}, ${config.approvalMode}`:'No enabled model profiles; configure one in OpenClaw settings before run').replace('Preserve complete task-related user identifiers, personal/business fields and signed download URLs for internal support; exclude unrelated chat and authentication credentials.',config.businessDataPolicy);
}
export default {id:'agent-worker',name:'本地智能体执行器 / Local agent worker',register(api){hostConfiguration=()=>api.config??{};configuration=resolveConfiguration(api.pluginConfig);jobs=makeJobs(configuration);const automation=registerAutomation(api,{configuration,jobs,invoke:queryInternal});const installDiagnostics=()=>installWorkerDiagnostics({root:configuration.state+'/jobs'},Symbol.for('openclaw-plugins.agent-worker.diagnostics.owner'));let diagnostics=installDiagnostics();api.registerService({id:'agent-worker-diagnostics',start:()=>{diagnostics??=installDiagnostics();},stop:()=>{diagnostics?.dispose();diagnostics=null;}});registerInspector(api,createSessionInspector({state:configuration.state,jobs}));registerScheduledWorkerStatus(api,()=>jobs);jobLimits=configuration;api.registerService({id:'agent-worker-scheduler',start:()=>jobs.start(),stop:()=>jobs.stop()});registerQuestionBridge(api,jobs,completionBridge);const collaboration=createCollaborationService({root:configuration.state+'/jobs',jobs,bridge:completionBridge});api.registerService({id:'agent-worker-collaboration',start:context=>collaboration.start(context),stop:()=>collaboration.stop()});const completion=createCompletionService({root:configuration.state+'/jobs',logger:api.logger,beforeDeliver:()=>collaboration.tick()});api.registerService({id:'agent-worker-completion',start:context=>completion.start(context),stop:()=>completion.stop()});sourceTaskBridge.recalls.add(event=>jobs.cancelSources(event));api.registerTool(context=>{let sourceTaskLease;let sourceTaskBound=false;return ({name:'agent_worker',label:'Run or resume a local agent worker',description:'块接口详见 agent-worker-context 技能。projects 只读返回当前 Agent 的项目列表，list 可用 projectId/repository 筛选当前会话的任务历史；run 按 projectId/repository 固定所选项目及技能范围，同一 topic 在不同项目独立保留会话，不接受任意 cwd。queues 返回队列、有效模型参数和 Hermes 模板绑定。run 按队列调用 CLI 模板，会话按执行配置隔离。'+delegationDescription(configuration,api.pluginConfig?.asyncCompletion===true),parameters:{type:'object',properties:{queueId:{type:'string',pattern:queueIdPattern,description:'仅 run：已配置的任务队列 ID；省略使用管理员 defaultQueueId。各队列按 Agent 独立并发和排队，可用 action=queues 查看名称、用途、执行时限与容量。重试及 reply 不改变原队列。'},taskClass:{type:'string',enum:['short','long'],description:'兼容旧参数：short 或 long，等价于同名 queueId；新调用优先使用 queueId，两者同时提供须一致。'},useWorkspace:{type:'boolean',description:'仅 run：true 从项目 workspacePool 分配独立 clone，池满排队；false 或省略保持原目录。不授予代码或发布权限。'},responsibility:{type:'string',minLength:1,maxLength:2000,description:'run 的本次执行职责，简要说明 Worker 负责什么；不粘贴角色手册，不扩大 constraints 授权。'},projectId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',description:'run 选择当前 Agent Repo 登记的项目，只有一个项目可省略，多项目须明确选择。list 可选：按历史绑定筛选整个项目（含子仓库），不准备执行范围；省略筛选时返回当前会话各项目历史。与 repository 同时提供时必须一致。'},expectedRegistryRevision:{type:'string',maxLength:160,description:'仅 run：可传 projects 或 agent_repo list 返回的登记版本，变化时拒绝提交。'},repository:{type:'string',pattern:'^(?:project|projects/[A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:/repositories/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$',description:'list 精确匹配历史 repository，不自动包含子仓库；与 projectId 同传须一致。run 传登记的 projects/<项目ID> 或 projects/<项目ID>/repositories/<name>；仅有一个项目时可省略，多项目必须由 Main 按用户意图明确选择；cwd 始终为所选项目根，子仓库仅影响技能范围。与 agent_repo skills 返回的 repository 一致，继承根技能且同名子仓库优先。'},resourceKeys:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:160},description:'涉及同一业务用户或记录的写操作传稳定资源键，例如 '+configuration.resourceKeyExample+'；相同键跨聊天串行，不构成授权。'},query:{type:'string',maxLength:500,description:'list 搜索 jobId、主题、任务摘要、状态、请求人 OpenID 和标签；空格分隔词须全部匹配。'},tags:{type:'array',maxItems:50,items:{type:'string',minLength:1,maxLength:160},description:'run 创建标签；tag 补充或替换标签。包含目标 OpenID、问题关键字、环境、业务 ID；标签不构成业务授权。'},tagMode:{type:'string',enum:['merge','replace'],description:'tag 默认 merge；replace 替换全部标签，空数组可清空。'},deliveryMode:{type:'string',enum:api.pluginConfig?.asyncCompletion===true?['async']:['async','wait'],description:'async 提交后结束当前轮次，由插件排队投递完整结果；wait 使用原等待协议。'},memory:memorySchema(configuration),requestId:{type:'string',maxLength:160,description:'可省略，宿主按可信消息版本、topic 和项目生成稳定 ID；相同请求重试复用。仅明确重新执行时提供新 ID。'},answerBasis:{type:'string',maxLength:1000,description:'reply 可选：自动补充依据的简短来源说明，不提供内部推理，不改变授权。'},knownValues:{type:'object',description:'await_user 使用：Main 已明确知道的字段值，按 Worker fields.id 提供；只向用户询问其余字段。等待期间可再次调用以合并新增或更正字段，不重置等待起点。'},questionId:{type:'string',description:'reply/await_user 必填：Worker 提问的问题 ID。'},answer:{type:'string',minLength:1,maxLength:16000,description:'reply/steer 必填：Main 补充的参考上下文，不改变原任务授权。'},jobId:{type:'string',description:'run 返回的后台任务 ID；status/wait/cancel/reply/await_user/steer 必填。'},waitSeconds:{type:'integer',minimum:0,maximum:30,description:'单次最多等待 30 秒，默认 20 秒。'},constraints:{type:'string',minLength:1,maxLength:4000,description:'本次执行限制：环境、目标、范围、允许的写操作或只读；不传整份角色手册。run 时必填。'},action:{type:'string',enum:['queues','projects','list','run','status','wait','cancel','tag','reply','await_user','steer']},topic:{type:'string',minLength:1,maxLength:160},task:{type:'string',minLength:1,maxLength:40000},context:{type:'string',minLength:1,maxLength:40000,description:'Relevant recent chat messages and known findings for this task; explicitly say if no prior context exists.'}},required:['action'],additionalProperties:false},async execute(_id,params){if(context.toolBindings?.agentWorkerAutomation)return automation.tool(params,context);if(context.sessionKey?.includes(':automation:')||params.action==='run'&&configuration.automation.callers.length&&params.queueId===configuration.automation.queueId)throw Error('Automation requires a current host task binding');if(!['reply','await_user','projects','queues'].includes(params.action)&&!sourceTaskBound){sourceTaskLease=bindSourceTask(context);sourceTaskBound=true;}return query(params,{...context,sourceTaskLease,asyncCompletionEnabled:api.pluginConfig?.asyncCompletion===true,jobListLimit:api.pluginConfig?.jobListLimit??10})}})})}};
