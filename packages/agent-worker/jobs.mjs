import {validateAutomationSource} from './adapters/automation-source.mjs';
import {resolveTaskQueues,requestedQueueId,queueFields} from './task-queues.mjs';
import {processAlive} from './dist/workspace-pool.mjs';
import {attachmentIdentity,attachmentSupplement} from './source-attachments.mjs';
import {projectFields,modelFields,validateHistoryFilter,matchesHistoryFilter} from './project-binding.mjs';
import {validateContextAnswers} from './context-request.mjs';
import {workerEnvironment} from './plugin-environment.mjs';
import {finalizeJobReport} from './task-report.mjs';
import {tryLock,acquireLock} from './locks.mjs';
import {memoryHandoffSummary} from './memory-context.mjs';
import {hasSourceProvenance} from './source-tasks.mjs';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,renameSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
export function readJson(path){return JSON.parse(readFileSync(path,'utf8'));}
export function writeJson(path,value){const tmp=path+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,path);}
export function requestKeyFor(params,scope,provenance){return createHash('sha256').update(JSON.stringify([scope,params.topic,params.task,params.context,params.constraints,params.requestId??'',provenance?.accountId,provenance?.senderId,...(provenance?.attachments?.length?[{attachments:attachmentIdentity(provenance.attachments)}]:[]),...(requestedQueueId(params)==='long'?[{taskClass:'long'}]:requestedQueueId(params)&&requestedQueueId(params)!=='short'?[{queueId:requestedQueueId(params)}]:[]),...(params.thinkingLevel?[params.thinkingLevel]:[]),...(params.modelId!==undefined?[{modelId:params.modelId}]:[]),...(params.useWorkspace===true?[{useWorkspace:true}]:[]),...(params.responsibility!==undefined?[{responsibility:params.responsibility}]:[]),...((params.repository??(params.projectId?'projects/'+params.projectId:undefined))&&params.repository!=='project'?[params.repository??'projects/'+params.projectId]:[])])).digest('hex');}
export function normalizeTags(tags=[]) {
 if(!Array.isArray(tags)||tags.length>50)throw Error('tags must be an array of at most 50 strings');
 const unique=new Map();
 for(const tag of tags){
  if(typeof tag!=='string'||!tag.trim()||tag.length>160)throw Error('Each tag must contain 1 to 160 characters');
  const value=tag.trim();unique.set(value.toLocaleLowerCase(),value);
 }
 return [...unique.values()];
}
export const USER_INPUT_WAIT_MS=3*60*1000;
// Only host-owned adapters supply this receipt time, never model/callback fields.
export function savedBeforeDeadline(question,submittedAt){return Number.isFinite(submittedAt)&&submittedAt>0&&submittedAt>=(question.createdAt??0)&&submittedAt<=question.expiresAt&&submittedAt<=Date.now();}

const timeoutAnswer='用户等待已超过 3 分钟，未收到输入。这不是用户答复或授权。保留已核验信息，未补充字段标为未知；跳过依赖这些字段、账号选择或额外授权的步骤，在原 task/constraints 范围内继续可独立完成的工作。不得猜测用户选择、扩大写入权限、重做已执行操作或重复询问同一缺口。无法继续时交付已核验结果、限制与未完成项，不把未知当成否定或成功。';
const waitPolicy={optional:'可选补充未取得时注明缺失并继续。',required:'必要业务参数未知时跳过依赖步骤，交付未完成项。',decision:'用户未明确决策时跳过对应操作，不代选。',authorization:'外部授权未确认完成时跳过依赖授权的操作，不把超时当授权成功。'};
export function taskClassOf(job){return job.queueId??job.taskClass??'short';}
const agentOf=job=>job.agentId??job.provenance?.agentId??job.project?.agentId??'__legacy__';
const sameQueue=(a,b)=>(a.provenance?.automation&&b.provenance?.automation||agentOf(a)===agentOf(b))&&taskClassOf(a)===taskClassOf(b);
const waiting=new Set(['awaiting_main','awaiting_user']);
const active=new Set(['queued','running','cancelling']);
export function createJobs({root,node,worker,getRuntime=()=>undefined,getLimits=()=>({maxConcurrentJobs:3,maxQueuedJobs:100}),authorizeUserTimeout=()=>false,getUserTimeoutSubmission=()=>undefined,mainTimeoutGraceMs=0,getRequestId=()=>undefined,prepareWorkspace,settleWorkspace,logger}) {
 const lock=join(root,'scheduler-lock');
 let timer;
 const workspaceOperations=new Set();
 const settlementActive=job=>job.workspaceSettlement&&processAlive(job.workspaceSettlement.pid);
 const sameWorkspace=(a,b)=>a.workspace?.assignmentId&&a.workspace.assignmentId===b.workspace?.assignmentId;
 let workspaceAdmission=Promise.resolve();
 const files=()=>readdirSync(root).filter(x=>/^[0-9a-f-]{36}\.json$/i.test(x)).map(x=>readJson(join(root,x)));
 const limits=job=>{
  const {taskQueues}=resolveTaskQueues(getLimits());
  const id=taskClassOf(job??{});
  // Removed queues drain admitted work with its persisted capacity; new work is rejected.
  return Object.hasOwn(taskQueues,id)?taskQueues[id]:job?.queueConfig??{maxConcurrentJobs:id==='long'?1:3,maxQueuedJobs:100};
 };
 const atCapacity=(running,job)=>running.filter(other=>sameQueue(other,job)||agentOf(other)==='__legacy__'&&taskClassOf(other)===taskClassOf(job)).length>=limits(job).maxConcurrentJobs;
 const legacyBusy=()=>existsSync(join(root,'active'))||existsSync(join(root,'..','lock'));
 const order=(a,b)=>(b.continuationPriority??0)-(a.continuationPriority??0)||(a.queueSequence??a.createdAt)-(b.queueSequence??b.createdAt)||a.createdAt-b.createdAt||a.jobId.localeCompare(b.jobId);
 const sameSession=(a,b)=>!!(a.workspace?.assignmentId&&a.workspace.assignmentId===b.workspace?.assignmentId)||a.scope===b.scope&&a.topic===b.topic&&(!a.executionScope||!b.executionScope||a.executionScope===b.executionScope)&&(!a.modelSessionScope||!b.modelSessionScope||a.modelSessionScope===b.modelSessionScope);
 const conflict=(a,b)=>sameSession(a,b)||(a.resourceKeys??[]).some(key=>(b.resourceKeys??[]).includes(key));
 const queued=j=>j.schedulerVersion===1&&j.status==='queued'&&(!j.startedAt||j.resumePending===true);
 const occupied=j=>(active.has(j.status)||j.status==='unknown')&&!queued(j);
 const scopeKey=scope=>createHash('sha256').update(scope).digest('hex');
 function get(jobId,scope){
  if(!/^[0-9a-f-]{36}$/i.test(jobId??''))throw Error('Invalid jobId');
  const j=readJson(join(root,jobId+'.json'));
  if(j.scope!==scopeKey(scope))throw Error('Job does not belong to this conversation');
  const metadata=join(root,jobId+'.tags.json');
  j.tags=existsSync(metadata)?normalizeTags(readJson(metadata).tags):normalizeTags(j.tags);
  if(occupied(j)&&Date.now()-j.heartbeatAt>15000)return {...j,status:'unknown',error:'Worker heartbeat lost. Do not rerun business operations; inspect the existing job.'};
  if(queued(j)){const all=files(),pending=all.filter(x=>queued(x)&&sameQueue(x,j)).sort(order);
   const running=all.filter(occupied);
   j.queuePosition=pending.findIndex(x=>x.jobId===j.jobId)+1;
   j.waitingReason=j.workspaceWaiting??(legacyBusy()?'legacy_executor':(running.some(x=>sameSession(x,j))||all.some(x=>waiting.has(x.status)&&sameSession(x,j)))?'session_busy':running.some(x=>conflict(x,j))?'resource_busy':atCapacity(running,j)?'capacity':'awaiting_dispatch');
  }
  return j;
 }
 function view(j){const {scope,request,...result}=j;return {...result,...queueFields(taskClassOf(j))};}
 function cancelMatching(matches) {
  mkdirSync(root,{recursive:true,mode:0o700});
  const ids=[];
  for (const file of readdirSync(root).filter(x=>/^[0-9a-f-]{36}\.json$/i.test(x))) {
   const job=readJson(join(root,file));
   // Inspect stored state, not the derived 'unknown' heartbeat projection: a
   // temporarily lost worker must see cancellation if it later comes back.
   if ((active.has(job.status)||job.status==='unknown'||waiting.has(job.status)) && matches(job.provenance,job)) {
    if(waiting.has(job.status))terminalJob({...job,status:'cancelled',finishedAt:Date.now(),notification:job.notification?{state:'pending',eventKey:randomUUID()}:undefined});
    else writeFileSync(join(root,job.jobId+'.cancel'),'source-recalled',{mode:0o600}); ids.push(job.jobId);
   }
  }
  return ids;
 }
 function terminalJob(job,request) {
  if(job.contextRequest){delete job.result;delete job.contextRequest;}
  if(!request)try{request=readJson(join(root,job.jobId+'.request.json'));}catch{}
  const valid=request && typeof request.scope==='string' && request.params?.topic===job.topic && scopeKey(request.scope)===job.scope &&
   job.requestKey && requestKeyFor(request.params,request.scope,job.provenance)===job.requestKey;
  finalizeJobReport({job,params:valid?request.params:{task:job.taskSummary},runtime:valid?request.runtime:getRuntime()});
  writeJson(join(root,job.jobId+'.json'),job);
 }
 function resumeLocked(job,request,answer,metadata) {
  const jobId=job.jobId,questionId=job.contextRequest.questionId,requestFile=join(root,jobId+'.request.json');
    const questions=job.questions.map(q=>q.questionId===questionId?{...q,answer,...metadata,answeredAt:Date.now()}:q);
    request.resumeParams={...request.params,mainReplies:questions.filter(q=>q.answer!==undefined).map(({questionId,question,answer,answerValues})=>({questionId,question,answer,...(answerValues?{answerValues}:{})}))};
    writeJson(requestFile,request);
    const attachmentSource=metadata.attachmentSource;
    const attachmentSources=attachmentSource?[...(job.provenance?.attachmentSources??[]),{...attachmentSource,questionId}]:undefined;
    const resumed={...job,...(attachmentSources?{provenance:{...job.provenance,attachmentSources}}:{}),questions,status:'queued',resumePending:true,heartbeatAt:Date.now(),progress:metadata.resumeReason==='user_wait_timeout'?'用户等待超时，跳过缺失信息并继续原任务':'Main 已回复，等待继续执行',notification:job.notification?{state:'pending',eventKey:randomUUID()}:undefined};
    delete resumed.contextRequest;delete resumed.finishedAt;delete resumed.result;
    appendFileSync(join(root,jobId+'.events.jsonl'),JSON.stringify({event:metadata.resumeReason==='user_wait_timeout'?'worker.user_wait_timeout':'main.context_reply',time:Date.now(),questionId,answer})+'\n',{mode:0o600});
    writeJson(join(root,jobId+'.json'),resumed);
  return resumed;
 }
 function scheduleLocked(){
  const all=files();
  for(const job of all.filter(j=>waiting.has(j.status)&&j.contextRequest?.expiresAt<=Date.now())){
   const submitted=getUserTimeoutSubmission(job);
   if(submitted&&savedBeforeDeadline(job.contextRequest,submitted.userSubmittedAt))continue;
   job.status='timed_out';job.error='Context reply deadline exceeded';job.finishedAt=Date.now();if(job.notification)job.notification={state:'pending',eventKey:randomUUID()};terminalJob(job);
  }
  for(const job of all.filter(j=>j.status==='awaiting_user'||j.status==='awaiting_main'&&j.contextRequest?.timeoutRequestedAt)){
   const question=job.contextRequest,at=Date.now(),submitted=question?getUserTimeoutSubmission(job):undefined;
   if(!question||!Number.isFinite(question.waitingForUserAt)||at-question.waitingForUserAt<USER_INPUT_WAIT_MS||
    (question.expiresAt<=at&&!savedBeforeDeadline(question,submitted?.userSubmittedAt))||existsSync(join(root,job.jobId+'.cancel'))||!hasSourceProvenance(job.provenance))continue;
   // No caller impersonation: the host revalidates the original source. Unknown
   // authorization remains waiting; timeout never fabricates a user answer.
   if(authorizeUserTimeout(job.provenance,job)!==true)continue;
   const request=readJson(join(root,job.jobId+'.request.json'));
   if(typeof request.scope!=='string'||scopeKey(request.scope)!==job.scope||
    requestKeyFor(request.params,request.scope,job.provenance)!==job.requestKey)continue;
   // A real submission wins the race and gets its own processing grace period.
   if(submitted && (!Number.isFinite(submitted.userSubmittedAt)||at-submitted.userSubmittedAt<USER_INPUT_WAIT_MS||typeof submitted.answerText!=='string'))continue;
   if(!submitted&&mainTimeoutGraceMs>0){
    if(!question.timeoutRequestedAt){
     question.timeoutRequestedAt=at;question.resumeReason='user_wait_timeout';
     job.status='awaiting_main';job.questions=job.questions.map(q=>q.questionId===question.questionId?{...q,...question}:q);
     job.progress='等待已超时，Main 核对已知信息后继续；未知步骤跳过';
     if(job.notification)job.notification={state:'pending',eventKey:randomUUID()};
     writeJson(join(root,job.jobId+'.json'),job);continue;
    }
    if(at-question.timeoutRequestedAt<mainTimeoutGraceMs)continue;
   }
   const answer=(submitted?timeoutAnswer.replace('用户等待已超过 3 分钟，未收到输入。这不是用户答复或授权。','用户已提交补充，但等待处理超过 3 分钟。以下仅恢复已保存的补充，不提供新授权。'):timeoutAnswer)+
    ' '+waitPolicy[question.waitKind??'required']+
    (question.knownValues?' 已确认字段：'+JSON.stringify(question.knownValues):'')+
    (submitted?'\n已保存的用户补充（仅作原任务参考，不扩大约束）：\n'+submitted.answerText:'');
   const metadata={answerSource:submitted?.answerSource??'user_wait_timeout',resumeReason:'user_wait_timeout',userWaitTimedOutAt:at,
    ...(submitted?{userSubmittedAt:submitted.userSubmittedAt,...(submitted.answerValues?{answerValues:validateContextAnswers(question,submitted.answerValues,{partial:true})}:{}),...(submitted.answerMessageId?{answerMessageId:submitted.answerMessageId}:{})}:{})};
   Object.assign(job,resumeLocked(job,request,answer,metadata));
   delete job.contextRequest;delete job.finishedAt;delete job.result;
  }
  for(const job of all.filter(queued)){
   if(existsSync(join(root,job.jobId+'.cancel'))){Object.assign(job,{status:'cancelled',finishedAt:Date.now(),heartbeatAt:Date.now()});terminalJob(job);}
  }
  for(const job of all.filter(j=>j.useWorkspace&&['completed','failed','timed_out','cancelled'].includes(j.status)&&(!j.workspaceSettled||j.workspaceRelease==='blocked')&&(!j.workspaceReleaseRetryAt||j.workspaceReleaseRetryAt<=Date.now()))){
   if(workspaceOperations.has(job.jobId)||!settleWorkspace||all.some(other=>sameWorkspace(job,other)&&settlementActive(other)))continue;
   const processFile=join(root,job.jobId+'.process.json');
   if(existsSync(processFile)&&processAlive(readJson(processFile).pid))continue;
   if(Number.isInteger(job.executionPid)){try{process.kill(-job.executionPid,0);continue;}catch(error){if(error.code!=='ESRCH')continue;}}
   const request=readJson(join(root,job.jobId+'.request.json'));
   if(!request.runtime?.workspace)continue;
   // A continuation with the same assignment keeps ownership, even when queued.
   if(all.some(other=>other.jobId!==job.jobId&&other.workspace?.assignmentId===job.workspace?.assignmentId&&!['completed','failed','timed_out','cancelled'].includes(other.status)))continue;
   const token=randomUUID();job.workspaceSettlement={pid:process.pid,token};writeJson(join(root,job.jobId+'.json'),job);
   workspaceOperations.add(job.jobId);
   void Promise.resolve().then(()=>settleWorkspace(request.runtime)).then(async result=>{
    const release=await acquireLock(lock);try{
     const current=readJson(join(root,job.jobId+'.json'));if(current.workspaceSettlement?.token!==token)return;
     for(const related of files().filter(j=>sameWorkspace(j,job)&&['completed','failed','timed_out','cancelled'].includes(j.status))){
      delete related.workspaceSettlement;
      const settled=result?.status==='idle',attempts=(related.workspaceReleaseAttempts??0)+1;
      const updated={...related,workspaceSettled:settled,workspaceRelease:result?.status??'preserved',workspaceReleaseAttempts:attempts};
      if(settled){delete updated.workspaceReleaseRetryAt;delete updated.workspaceReleaseFailure;}
      else{updated.workspaceReleaseFailure=result?.releaseFailure??{code:'RELEASE_UNCONFIRMED',stage:'settlement'};updated.workspaceReleaseRetryAt=Date.now()+Math.min(300000,30000*2**Math.min(attempts-1,4));}
      writeJson(join(root,related.jobId+'.json'),updated);
     }
    }finally{release();}
   }).catch(async()=>{const release=await acquireLock(lock);try{const current=readJson(join(root,job.jobId+'.json'));if(current.workspaceSettlement?.token===token){for(const related of files().filter(j=>sameWorkspace(j,job)&&['completed','failed','timed_out','cancelled'].includes(j.status))){delete related.workspaceSettlement;related.workspaceReleaseRetryAt=Date.now()+300000;related.workspaceReleaseFailure={code:'WORKSPACE_VALIDATION_FAILED',stage:'identity'};writeJson(join(root,related.jobId+'.json'),related);}}}finally{release();}}).finally(()=>workspaceOperations.delete(job.jobId)).catch(()=>{});
  }
  // Old releases use a global admission directory. Never bypass their worker.
  if(legacyBusy())return;
  const running=all.filter(occupied);
  const pending=all.filter(queued).sort(order);
  for(const job of pending){
   const file=join(root,job.jobId+'.json');
   if(existsSync(join(root,job.jobId+'.cancel'))){terminalJob({...job,status:'cancelled',finishedAt:Date.now(),heartbeatAt:Date.now()});continue;}
   if(all.some(other=>sameWorkspace(other,job)&&(settlementActive(other)||workspaceOperations.has(other.jobId))))continue;
   if(running.some(other=>conflict(other,job))||all.some(other=>waiting.has(other.status)&&sameSession(other,job)))continue;
   if(atCapacity(running,job))continue;
   const requestFile=join(root,job.jobId+'.request.json');
   if(!existsSync(requestFile)){terminalJob({...job,status:'failed',error:'Queued request missing; task was not executed',finishedAt:Date.now()});continue;}
   const request=readJson(requestFile);
   if(scopeKey(request.scope)!==job.scope||request.params?.topic!==job.topic)throw Error('Queued request binding mismatch; execution withheld');
   if(request.runtime?.workspacePool&&!job.workspaceReady){
    if(!prepareWorkspace){terminalJob({...job,status:'failed',error:'Workspace service unavailable',finishedAt:Date.now()});continue;}
    job.workspaceWaiting='waiting_workspace';writeJson(file,job);
    if(!workspaceOperations.has(job.jobId)){
     workspaceOperations.add(job.jobId);
     workspaceAdmission=workspaceAdmission.catch(()=>{}).then(async()=>{
      try{
       if(!queued(readJson(file))||existsSync(join(root,job.jobId+'.cancel')))return;
       const owner=request.runtime.workspace?.owner??job.jobId;
       const prepared=await prepareWorkspace(request.runtime,owner);
       const release=await acquireLock(lock);
       try{
        const current=readJson(file);
        if(prepared){request.runtime=prepared;writeJson(requestFile,request);Object.assign(current,projectFields(prepared),{workspaceReady:true});delete current.workspaceWaiting;writeJson(file,current);}
       }finally{release();}
      }catch(error){const release=await acquireLock(lock);try{const current=readJson(file);if(queued(current))terminalJob({...current,status:'failed',error:String(error.message),finishedAt:Date.now()});}finally{release();}}
      finally{workspaceOperations.delete(job.jobId);}
     });
    }
    continue;
   }
   const claimed={...job,resumePending:false,status:'running',startedAt:job.startedAt??Date.now(),heartbeatAt:Date.now()};
   // Persist the reservation BEFORE spawning. An interrupted dispatch remains
   // unknown and occupied, never automatically spawning a second business worker.
   writeJson(file,claimed);running.push(claimed);
   let child;
   const failed=()=>{terminalJob({...claimed,status:'failed',error:'Could not start job worker',finishedAt:Date.now(),heartbeatAt:Date.now()},request);};
   try{child=spawn(request.runtime?.node ?? node,[worker,root,job.jobId],{detached:true,stdio:['pipe','ignore','ignore'],env:workerEnvironment()});}
   catch{failed();continue;}
   child.stdin.on('error',()=>{});child.once('error',failed);
   writeJson(join(root,job.jobId+'.process.json'),{pid:child.pid});
   child.stdin.end(JSON.stringify({...request,params:request.resumeParams??request.params}));child.unref();
  }
 }
 function tick(){
  mkdirSync(root,{recursive:true,mode:0o700});const release=tryLock(lock);if(!release)return;
  try{scheduleLocked();}finally{release();}
 }
 async function wait(jobId,scope,seconds=20){
  if(!Number.isInteger(seconds)||seconds<0||seconds>30)throw Error('waitSeconds must be an integer from 0 to 30');
  const deadline=Date.now()+seconds*1000;
  for(;;){tick();const j=get(jobId,scope);if(!active.has(j.status)||Date.now()>=deadline)return view(j);await new Promise(r=>setTimeout(r,200));}
 }
 function contributorKey(job,source){return createHash('sha256').update(JSON.stringify([job.provenance.accountId,job.provenance.chatId,job.provenance.sessionKey,job.provenance.senderId,source.senderId])).digest('hex');}
 function contributorPermission(job,source,approvalId,questionId){
  const key=contributorKey(job,source),grantsFile=join(root,'contributor-grants.json');
  const grant=existsSync(grantsFile)?readJson(grantsFile)[key]:undefined;
  if(grant?.mode==='always'&&grant.approvedBy===job.provenance.senderId)return true;
  return (job.contributorApprovals??[]).some(r=>r.status==='approved'&&r.source.senderId===source.senderId&&r.approvedBy===job.provenance.senderId&&(r.mode==='worker'||r.mode==='once'&&r.requestId===approvalId&&r.questionId===questionId&&JSON.stringify(r.source)===JSON.stringify(source)));
 }
 return {
  contributorRequest(jobId,scope,requestId){const job=get(jobId,scope),request=job.contributorApprovals?.find(r=>r.requestId===requestId);if(!request)throw Error('Contributor approval request not found');return {job:view(job),request};},
  async requestContributor(jobId,scope,questionId,answer,requester,source,authorize){
   const release=await acquireLock(lock);
   try{
    const job=get(jobId,scope),bound=attachmentSupplement(job.provenance,source),q=job.contextRequest??job.questions?.find(q=>q.questionId===questionId);
    if(bound.kind!=='group_context'||bound.senderId!==requester?.senderId||bound.accountId!==requester?.accountId)throw Error('Contributor source mismatch');
    if(typeof answer!=='string'||!answer.trim()||answer.length>16000)throw Error('Invalid contributor context');
    if(!q||q.questionId!==questionId||q.requestKind==='plugin'||!['optional','required'].includes(q.waitKind??'required'))throw Error('Contributor context cannot answer decisions or authorization');
    if(!authorize({...job.provenance,attachmentSources:[...(job.provenance.attachmentSources??[]),bound]}))throw Error('Contributor or original source is no longer current');
    const prior=job.contributorApprovals?.find(r=>r.source.senderId===bound.senderId&&JSON.stringify(r.source)===JSON.stringify(bound)&&r.questionId===questionId);
    if(prior&&prior.answer!==answer)throw Error('Contributor request already saved differently');
    if(contributorPermission(job,bound,prior?.requestId,questionId))return {approved:true,approvalId:prior?.requestId};
    if(!waiting.has(job.status)||job.contextRequest?.questionId!==questionId||q.expiresAt<=Date.now()||existsSync(join(root,jobId+'.cancel')))throw Error('No matching pending question');
    if(prior)return {approved:false,request:prior};
    const pending=job.contributorApprovals?.find(r=>r.source.senderId===bound.senderId&&r.status==='pending'&&r.expiresAt>Date.now());
    if(pending)throw Error('Contributor approval is pending; this additional hint has not been accepted');
    if((job.contributorApprovals?.length??0)>=64)throw Error('Contributor approval request limit reached');
    const request={requestId:randomUUID(),questionId,source:bound,answer,status:'pending',createdAt:Date.now(),expiresAt:q.expiresAt};
    writeJson(join(root,jobId+'.json'),{...job,contributorApprovals:[...(job.contributorApprovals??[]),request]});
    return {approved:false,request};
   }finally{release();}
  },
  async decideContributor(jobId,scope,requestId,actor,mode,authorize){
   if(!['once','worker','always'].includes(mode))throw Error('Invalid contributor permission mode');
   const release=await acquireLock(lock);
   try{
    const job=get(jobId,scope),request=job.contributorApprovals?.find(r=>r.requestId===requestId);
    if(!request||actor?.senderId!==job.provenance.senderId||actor?.accountId!==job.provenance.accountId)throw Error('Only the task requester can approve a contributor');
    if(!authorize({...job.provenance,attachmentSources:[...(job.provenance.attachmentSources??[]),request.source]}))throw Error('Contributor or original source is no longer current');
    if(request.status==='approved'&&request.mode!==mode)throw Error('Contributor approval already decided differently');
    const late=job.questions?.find(q=>q.questionId===request.questionId)?.resumeReason==='user_wait_timeout';
    if(request.status!=='approved'&&(request.expiresAt<=Date.now()||job.status==='completed'&&!late||['failed','timed_out','cancelled','unknown','cancelling'].includes(job.status)||existsSync(join(root,jobId+'.cancel'))))throw Error('Contributor approval expired or task unavailable');
    const approved=request.status==='approved'?request:{...request,status:'approved',mode,approvedBy:actor.senderId,approvedAt:Date.now()};
    writeJson(join(root,jobId+'.json'),{...job,contributorApprovals:job.contributorApprovals.map(r=>r.requestId===requestId?approved:r)});
    if(mode==='always'){
     const file=join(root,'contributor-grants.json'),grants=existsSync(file)?readJson(file):{};
     grants[contributorKey(job,request.source)]={mode,approvedBy:actor.senderId,approvedAt:approved.approvedAt,requestId};writeJson(file,grants);
    }
    return approved;
   }finally{release();}
  },
  tick,
  start(){if(timer)return;tick();timer=setInterval(()=>{try{tick();}catch(error){logger?.error?.('Codex scheduler: '+error.message);}},500);timer.unref();},
  stop(){clearInterval(timer);timer=undefined;},
  cancelSources(event) {return cancelMatching((p,job)=>p?.accountId===event.accountId && p?.chatId===event.chatId && (p.sourceMessageIds?.includes(event.messageId)||p.attachmentSources?.some(source=>source.sourceMessageIds?.includes(event.messageId))||job.questions?.some(q=>q.answerSource==='user_text'&&q.answerMessageId===event.messageId)));},
  cancelTask(taskId,revision) {return cancelMatching(p=>p?.taskId===taskId && p?.revision===revision);},
  list(scope,options={}){return this.search(scope,options).jobs;},
  search(scope,{limit=10,query='',projectId,repository}={}){
   validateHistoryFilter({projectId,repository});
   if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('limit must be an integer from 1 to 100');
   if(typeof query!=='string'||query.length>500)throw Error('query must be a string of at most 500 characters');
   const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
   mkdirSync(root,{recursive:true,mode:0o700});
   const matches=readdirSync(root).filter(x=>/^[0-9a-f-]{36}\.json$/i.test(x))
    .map(x=>readJson(join(root,x))).filter(j=>j.scope===scopeKey(scope)&&matchesHistoryFilter(j,{projectId,repository}))
    .map(j=>get(j.jobId,scope)).filter(j=>{
     const text=[j.jobId,j.topic,j.projectId,j.repository,j.modelId,j.model,j.harness,j.taskSummary,j.status,j.provenance?.senderId,...j.tags].filter(Boolean).join(' ').toLocaleLowerCase();
     return terms.every(term=>text.includes(term));
    }).sort((a,b)=>b.createdAt-a.createdAt||a.jobId.localeCompare(b.jobId));
   const summaries=matches.slice(0,limit).map(j=>{const {result,reports,taskReport,...summary}=view(j);return summary;});
   const hasMore=summaries.length<matches.length;
   return {jobs:summaries,jobPage:{total:matches.length,limit,hasMore}};
  },
  tag(jobId,scope,tags,requester,mode='merge'){
   const j=get(jobId,scope);
   if(hasSourceProvenance(j.provenance)&&(!requester?.senderId||requester.senderId!==j.provenance.senderId||requester.accountId!==j.provenance.accountId))throw Error('Only the task requester can tag this job');
   if(!hasSourceProvenance(j.provenance)&&scope.includes(':feishu:'))throw Error('Job requester is unknown; administrator inspection required');
   if(!['merge','replace'].includes(mode))throw Error('tagMode must be merge or replace');
   const values=normalizeTags(tags);
   const merged=mode==='merge'?[...new Map([...j.tags,...values].map(tag=>[tag.toLocaleLowerCase(),tag])).values()]:values;
   const updated=normalizeTags(merged);
   writeJson(join(root,jobId+'.tags.json'),{tags:updated});
   const {result,reports,taskReport,...summary}=view({...j,tags:updated});return summary;
  },
  executionActive(jobId,scope){get(jobId,scope);const file=join(root,jobId+'.process.json');return existsSync(file)&&processAlive(readJson(file).pid);},
  findAutomation(taskId,scope){const found=(existsSync(root)?files():[]).filter(j=>j.scope===scopeKey(scope)&&j.provenance?.automation?.version===1&&j.provenance.automation.taskId===taskId);if(found.length>1)throw Error('Multiple automation jobs');return found[0]?view(get(found[0].jobId,scope)):null;},
  async failAutomationContext(jobId,scope,taskId,questionId,code){const release=await acquireLock(lock);try{const j=get(jobId,scope);if(j.provenance?.automation?.version!==1||j.provenance.automation.taskId!==taskId||!waiting.has(j.status)||j.contextRequest?.questionId!==questionId)throw Error('Automation context binding mismatch');terminalJob({...j,scope:scopeKey(scope),status:'failed',error:code,finishedAt:Date.now()});return view(get(jobId,scope));}finally{release();}},
  status:(jobId,scope)=>view(get(jobId,scope)),wait,
  cancel(jobId,scope,requester){const j=get(jobId,scope);
   if(hasSourceProvenance(j.provenance) && (!requester?.senderId || requester.senderId!==j.provenance.senderId || requester.accountId!==j.provenance.accountId))throw Error('Only the task requester can cancel this job');
   if(!hasSourceProvenance(j.provenance) && scope.includes(':feishu:'))throw Error('Job requester is unknown; administrator inspection required');
   const stored=readJson(join(root,jobId+'.json'));
   const processFile=join(root,jobId+'.process.json');
   if(j.provenance?.automation&&existsSync(processFile)&&processAlive(readJson(processFile).pid)){writeFileSync(join(root,jobId+'.cancel'),'cancel',{mode:0o600});return {...view(j),status:'cancelling'};}
   if(waiting.has(stored.status)){terminalJob({...stored,status:'cancelled',finishedAt:Date.now(),notification:stored.notification?{state:'pending',eventKey:randomUUID()}:undefined});return view(get(jobId,scope));}
   if(active.has(stored.status)||stored.status==='unknown'){writeFileSync(join(root,jobId+'.cancel'),'cancel',{mode:0o600});return {...view(j),status:j.status==='unknown'?'unknown':'cancelling',note:'Cancellation requested; business operations already accepted externally are not rolled back.'};}return view(j);},
  awaitUser(jobId,scope,questionId,requester,authorize,knownValues){return this.reply(jobId,scope,questionId,undefined,requester,authorize,true,knownValues);},
  async reply(jobId,scope,questionId,answer,requester,authorize=()=>true,waitingForUser=false,knownValues,answerMetadata={}){
   if(!waitingForUser&&(typeof answer!=='string'||!answer.trim()||answer.length>16000))throw Error('Invalid Main answer');
   const release=await acquireLock(lock);
   try {
    const job=get(jobId,scope);
    const question=job.contextRequest??job.questions?.find(q=>q.questionId===questionId);
    const groupSource=answerMetadata.attachmentSource?.kind==='group_context'?attachmentSupplement(job.provenance,answerMetadata.attachmentSource):undefined;
    const groupReply=!waitingForUser&&groupSource&&groupSource.senderId===requester?.senderId&&groupSource.accountId===requester?.accountId&&question?.requestKind!=='plugin'&&['optional','required'].includes(question?.waitKind??'required')&&contributorPermission(job,groupSource,answerMetadata.contributorApprovalId,questionId);
    if(hasSourceProvenance(job.provenance)&&(!requester?.senderId||requester.senderId!==job.provenance.senderId||requester.accountId!==job.provenance.accountId)&&!groupReply)throw Error('Only the task requester Main can reply to decisions or authorization; group context requires a trusted same-chat source');
    if(groupSource&&!authorize({...job.provenance,attachmentSources:[...(job.provenance?.attachmentSources??[]),groupSource]}))throw Error('Group context source is no longer current');
    if(!hasSourceProvenance(job.provenance)&&scope.includes(':feishu:'))throw Error('Job requester is unknown');
    if(!authorize(job.provenance))throw Error('Original task authorization is no longer current');
    if(['cancelled','timed_out','failed'].includes(job.status))throw Error('Task cannot accept a reply');
    const previous=(job.questions??[]).find(q=>q.questionId===questionId);
    if(!waitingForUser&&previous?.answer!==undefined){
     const incoming=answerMetadata.attachmentSource?attachmentSupplement(job.provenance,answerMetadata.attachmentSource):undefined;
     if(previous.answer!==answer||(incoming&&JSON.stringify(attachmentIdentity(previous.attachmentSource?.attachments))!==JSON.stringify(attachmentIdentity(incoming.attachments))))throw Error('Question already answered differently');
     return view(job);
    }
    if(!waiting.has(job.status)||job.contextRequest?.questionId!==questionId)throw Error('No matching pending question');
    if((job.contextRequest.expiresAt<=Date.now()&&!savedBeforeDeadline(job.contextRequest,answerMetadata.userSubmittedAt))||existsSync(join(root,jobId+'.cancel')))throw Error('Question expired or task cancelled');
    const requestFile=join(root,jobId+'.request.json'),request=readJson(requestFile);
    if(requestKeyFor(request.params,scope,job.provenance)!==job.requestKey||request.scope!==scope)throw Error('Original request binding mismatch');
    if(waitingForUser){
     const merged=knownValues===undefined?job.contextRequest.knownValues:validateContextAnswers(job.contextRequest,{...job.contextRequest.knownValues,...validateContextAnswers(job.contextRequest,knownValues,{partial:true})},{partial:true});
     if(job.status==='awaiting_user'&&JSON.stringify(merged)===JSON.stringify(job.contextRequest.knownValues))return view(job);
     const at=Date.now(),question={...job.contextRequest,waitingForUserAt:job.contextRequest.waitingForUserAt??at,...(merged?{knownValues:merged}:{})};
     const updated={...job,status:'awaiting_user',contextRequest:question,progress:'等待用户补充上下文',questions:job.questions.map(q=>q.questionId===questionId?question:q)};
     appendFileSync(join(root,jobId+'.events.jsonl'),JSON.stringify({event:'main.awaiting_user',time:at,questionId})+'\n',{mode:0o600});
     writeJson(join(root,jobId+'.json'),updated);return view(updated);
    }
    // Resuming admitted work must not deadlock behind its own queued successors.
    const metadata={answerSource:job.status==='awaiting_main'?'main_context':'user_text',...(job.contextRequest.timeoutRequestedAt?{resumeReason:'user_wait_timeout'}:{}),...answerMetadata};
    if(metadata.attachmentSource){
     metadata.attachmentSource=attachmentSupplement(job.provenance,metadata.attachmentSource);
     if((job.provenance?.attachmentSources?.length??0)>=64)throw Error('Attachment supplement limit reached');
     if(!authorize({...job.provenance,attachmentSources:[...(job.provenance?.attachmentSources??[]),metadata.attachmentSource]}))throw Error('Attachment supplement authorization is no longer current');
    }
    if(metadata.answerValues)metadata.answerValues=validateContextAnswers(job.contextRequest,metadata.answerValues);
    resumeLocked(job,request,answer,metadata);scheduleLocked();return view(get(jobId,scope));
   }finally{release();}
  },
  async openSupplement(jobId,scope,questionId,authorize,metadata={}){
   const release=await acquireLock(lock);
   try{
    const job=get(jobId,scope),question=job.questions?.find(q=>q.questionId===questionId);
    const saved=question&&savedBeforeDeadline(question,metadata.userSubmittedAt);
    if(!authorize(job.provenance)||!question||(!saved&&(['cancelled','failed','timed_out','unknown','cancelling'].includes(job.status)||existsSync(join(root,jobId+'.cancel'))||question.expiresAt<=Date.now()))||question.resumeReason!=='user_wait_timeout'||question.answer===undefined)throw Error('Task cannot reopen this question');
    const directory=join(root,'supplements');mkdirSync(directory,{recursive:true,mode:0o700});
    const prior=readdirSync(directory).filter(f=>/^[0-9a-f-]{36}\.json$/i.test(f)).map(f=>({name:f,record:readJson(join(directory,f))})).find(({name,record:s})=>name===s.supplementId+'.json'&&s.jobId===jobId&&s.originalQuestionId===questionId)?.record;
    if(prior)return prior;
    const {answer,answerValues,answerSource,answeredAt,timeoutRequestedAt,resumeReason,waitingForUserAt,...fields}=question;
    const id=randomUUID(),record={supplementId:id,jobId,originalQuestionId:questionId,scope:job.scope,provenance:job.provenance,question:{...fields,questionId:id,createdAt:saved?(question.createdAt??0):Date.now()},status:'waiting',createdAt:Date.now()};
    writeJson(join(directory,id+'.json'),record);return record;
   }finally{release();}
  },
  supplement(jobId,scope,id){
   if(!/^[0-9a-f-]{36}$/i.test(id??''))return undefined;
   const file=join(root,'supplements',id+'.json');if(!existsSync(file))return undefined;
   const record=readJson(file);if(record.supplementId!==id||record.jobId!==jobId||record.scope!==scopeKey(scope))throw Error('Supplement scope mismatch');return record;
  },
  async submitSupplement(jobId,scope,id,answer,metadata,authorize){
   const release=await acquireLock(lock);
   try{
    const job=get(jobId,scope),s=this.supplement(jobId,scope,id);
    const saved=s&&savedBeforeDeadline(s.question,metadata.userSubmittedAt);
    if(!s||!authorize(job.provenance)||(!saved&&(['cancelled','failed','timed_out','unknown','cancelling'].includes(job.status)||existsSync(join(root,jobId+'.cancel')))))throw Error('Supplement is no longer valid');
    if(typeof answer!=='string'||!answer.trim()||answer.length>16000)throw Error('Invalid supplement');
    const source=metadata.attachmentSource?attachmentSupplement(job.provenance,metadata.attachmentSource):undefined;
    if(source&&(!contributorPermission(job,source,metadata.contributorApprovalId,s.originalQuestionId)||s.question.requestKind==='plugin'||!['optional','required'].includes(s.question.waitKind??'required')||!authorize({...job.provenance,attachmentSources:[...(job.provenance.attachmentSources??[]),source]})))throw Error('Contributor supplement permission is no longer valid');
    if(metadata.answerValues)validateContextAnswers(s.question,metadata.answerValues);
    if(s.status!=='waiting'){if(s.answer!==answer)throw Error('Supplement already answered differently');return s;}
    if(s.question.expiresAt<=Date.now()&&!saved)throw Error('Supplement is no longer valid');
    const accepted={...s,answer,answerSource:metadata.answerSource,answerValues:metadata.answerValues,answerMessageId:metadata.answerMessageId,userSubmittedAt:metadata.userSubmittedAt,...(source?{attachmentSource:source,contributorApprovalId:metadata.contributorApprovalId}:{}),status:'accepted',acceptedAt:Date.now()};
    writeJson(join(root,'supplements',id+'.json'),accepted);return accepted;
   }finally{release();}
  },
  async suppressSupplements(jobId,scope,isRevoked){
   const directory=join(root,'supplements');if(!existsSync(directory))return;
   const release=await acquireLock(lock);
   try{
    const job=get(jobId,scope);if(isRevoked(job.provenance)!==true)return;
    for(const name of readdirSync(directory).filter(f=>/^[0-9a-f-]{36}\.json$/i.test(f))){
     const s=readJson(join(directory,name));
     if(s.supplementId+'.json'===name&&s.jobId===jobId&&['waiting','accepted'].includes(s.status))writeJson(join(directory,name),{...s,status:'suppressed',reason:'source_invalid',notificationSuppressed:true,finishedAt:Date.now()});
    }
   }finally{release();}
  },
  async processSupplements(jobId,scope,authorize,observe){
   const directory=join(root,'supplements');if(!existsSync(directory))return;
   for(const name of readdirSync(directory).filter(f=>/^[0-9a-f-]{36}\.json$/i.test(f))){
    let s=readJson(join(directory,name));if(s.supplementId+'.json'!==name||s.jobId!==jobId)continue;
    const terminalEvent=()=>({kind:'supplement_unavailable',supplementId:s.supplementId,status:s.status,reason:s.reason??'continuation_unavailable'});
    if(s.status==='suppressed'&&s.reason==='source_invalid'&&s.notificationSuppressed===true)continue;
    if(['blocked','suppressed'].includes(s.status)){await observe(terminalEvent());continue;}
    if(!['waiting','accepted','dispatched'].includes(s.status))continue;
    await observe({kind:s.status==='waiting'?'supplement_opened':s.status==='dispatched'?'supplement_dispatched':'supplement_received',supplementId:s.supplementId,answer:s.answer,childJobId:s.childJobId});
    if(s.status!=='accepted')continue;
    const release=await acquireLock(lock);
    try{
     const job=get(jobId,scope);s=readJson(join(directory,name));if(s.status!=='accepted')continue;
     const fail=(status,reason)=>{s={...s,status,reason,finishedAt:Date.now()};writeJson(join(directory,name),s);};
     // Expiry limits admission, not execution of an already accepted answer.
     const provenance=s.attachmentSource?{...job.provenance,attachmentSources:[...(job.provenance.attachmentSources??[]),{...s.attachmentSource,questionId:s.originalQuestionId}]}:job.provenance;
     const authorized=authorize(provenance);
     if(authorized===false){s={...s,notificationSuppressed:true};fail('suppressed','source_invalid');continue;}
     if(authorized!==true)continue;
     if(['cancelled','cancelling'].includes(job.status)||existsSync(join(root,jobId+'.cancel'))){fail('suppressed','task_cancelled');continue;}
     if(['failed','timed_out'].includes(job.status)){fail('blocked','worker_'+job.status);continue;}
     if(['running','queued','unknown'].includes(job.status))continue;
     let request;
     try{request=readJson(join(root,jobId+'.request.json'));}
     catch(error){
      if(error.code==='ENOENT'){fail('blocked','original_request_missing');continue;}
      if(error instanceof SyntaxError){fail('blocked','original_request_invalid');continue;}
      throw error;
     }
     if(!request?.params||request.scope!==scope||requestKeyFor(request.params,scope,job.provenance)!==job.requestKey){fail('blocked','original_request_mismatch');continue;}
     const answer='原 questionId='+s.originalQuestionId+'，原问题：'+s.question.question+'\n'+(s.attachmentSource?'经原请求人确认接纳的同群成员补充':'原请求人的迟到补充')+'，仅针对原问题，不增加授权；保留已完成结果，不重复外部操作。若当前正在等待其他问题，不把本补充当作其他问题的答案；核对仍缺信息后继续独立步骤。\n'+s.answer;
     if(waiting.has(job.status)){
      // An answer to an older question cannot consume the current question,
      // including its decision/authorization wait. Retain it for the next boundary.
      if(job.contextRequest?.questionId!==s.originalQuestionId)continue;
      resumeLocked(job,request,answer,{answerSource:s.answerSource,answerMessageId:s.answerMessageId,supplementId:s.supplementId,...(s.attachmentSource?{attachmentSource:s.attachmentSource,contributorApprovalId:s.contributorApprovalId}:{})});
      writeJson(join(directory,name),{...s,status:'dispatched',childJobId:jobId});scheduleLocked();continue;
     }
     if(job.status!=='completed'||files().filter(other=>queued(other)&&sameQueue(other,job)).length>=limits(job).maxQueuedJobs)continue;
     // Keep the parent's immutable final report. Exact session resume may fail
     // closed if another task has since changed its binding; never start fresh.
     let output;try{output=JSON.parse(job.result?.content?.find(c=>c.type==='text')?.text);}catch{}
     const sessionId=output?.sessionId??job.resumeSessionId??job.sessionId;
     if(!sessionId){fail('blocked','original_session_missing');continue;}
     const childId=s.supplementId,params={...request.params,requestId:'supplement:'+s.supplementId};
     const question={...s.question,answer,answerSource:s.answerSource,answerValues:s.answerValues,answerMessageId:s.answerMessageId,answeredAt:s.acceptedAt};
     const questions=[...(job.questions??[]),question];
     const resumeParams={...params,mainReplies:questions.filter(q=>q.answer!==undefined).map(({questionId,question,answer,answerValues})=>({questionId,question,answer,...(answerValues?{answerValues}:{})}))};
     const child={...queueFields(taskClassOf(job)),queueConfig:job.queueConfig,agentId:agentOf(job),timeoutMs:job.timeoutMs,jobId:childId,parentJobId:jobId,supplementId:s.supplementId,requestKey:requestKeyFor(params,scope,job.provenance),scope:job.scope,provenance,contributorApprovals:job.contributorApprovals?.filter(r=>r.status==='approved'&&r.mode==='worker'),topic:job.topic,taskSummary:job.taskSummary,...projectFields(request.runtime),...modelFields(request.runtime),tags:job.tags,resourceKeys:job.resourceKeys,questions,resumeSessionId:sessionId,resumePending:true,continuationPriority:1,schedulerVersion:1,queueSequence:job.queueSequence,status:'queued',createdAt:Date.now(),heartbeatAt:Date.now(),notification:{state:'pending',eventKey:randomUUID()}};
     if(!existsSync(join(root,childId+'.json'))){writeJson(join(root,childId+'.request.json'),{...request,params,resumeParams});writeJson(join(root,childId+'.json'),child);}
     writeJson(join(directory,name),{...s,status:'dispatched',childJobId:childId});scheduleLocked();
    }finally{
     release();
     // Durable terminal records retry notification after adapter failure/restart.
     if(['blocked','suppressed'].includes(s.status)&&s.notificationSuppressed!==true)await observe(terminalEvent());
    }
   }
  },
  async run(params,scope,provenance){
   validateAutomationSource(provenance,scope);
   requestedQueueId(params);
   const automaticRequestId=params.requestId===undefined;
   if(automaticRequestId)params={...params,requestId:getRequestId(params,provenance)};
   const tags=normalizeTags(params.tags);
   if(params.resourceKeys!==undefined&&(!Array.isArray(params.resourceKeys)||params.resourceKeys.length>20))throw Error('resourceKeys must contain at most 20 keys');
   normalizeTags(params.resourceKeys);
   const resourceKeys=[...new Set((params.resourceKeys??[]).map(key=>key.trim()))];
   mkdirSync(root,{recursive:true,mode:0o700});
   const inputRequestKey=requestKeyFor(params,scope,provenance);
   const findPrior=all=>{
    const exact=all.find(j=>j.inputRequestKey===inputRequestKey||j.requestKey===inputRequestKey);
    if(exact?.project&&params.projectId!==undefined&&params.projectId!==exact.projectId)throw Object.assign(Error('projectId conflicts with the original project binding'),{code:'PROJECT_SELECTOR_CONFLICT'});
    if(exact&&requestedQueueId(params)!==undefined&&requestedQueueId(params)!==taskClassOf(exact))throw Object.assign(Error('Existing request has a different queue'),{code:'REQUEST_ID_CONFLICT'});
    if(exact)return exact;
    const sameBody=all.filter(j=>j.project&&j.scope===scopeKey(scope)&&j.requestBodyKey===requestKeyFor({...params,repository:undefined,projectId:undefined},scope,provenance));
    const matches=sameBody.filter(j=>params.repository?j.repository===params.repository:params.projectId?j.projectId===params.projectId&&j.repository==='projects/'+params.projectId:false);
    if(matches.length===1)return matches[0];
    if(params.requestId&&all.some(j=>(j.project||params.requestId.startsWith('host:')||taskClassOf(j)!==taskClassOf(params))&&j.scope===scopeKey(scope)&&j.topic===params.topic&&j.requestId===params.requestId&&j.provenance?.accountId===provenance?.accountId&&j.provenance?.senderId===provenance?.senderId))throw Object.assign(Error('Existing project request has different task or selectors'),{code:'REQUEST_ID_CONFLICT'});
   };
   const early=findPrior(files());
   let runtime=early?undefined:await getRuntime(params,{...provenance,sessionKey:scope});
   const originalParams=params;
   const queueSettings=early?undefined:resolveTaskQueues({...runtime,...getLimits(),...(runtime?.taskQueues?{taskQueues:runtime.taskQueues}:{} )});
   const taskClass=early?taskClassOf(early):requestedQueueId(params)??queueSettings.defaultQueueId;
   const queueConfig=early?early.queueConfig:queueSettings.taskQueues[taskClass];
   if(!early&&!Object.hasOwn(queueSettings.taskQueues,taskClass))throw Error('Unknown task queue: '+taskClass);
   if(runtime)runtime={...runtime,timeoutMs:queueConfig.timeoutMs};
   params={...params,queueId:taskClass};
   if(runtime?.projectContext){
    params={...params,projectId:runtime.projectContext.projectId,repository:runtime.projectContext.repository};
    if(automaticRequestId)params={...params,requestId:getRequestId({...params,requestId:undefined},provenance)};
   }
   const requestKey=requestKeyFor(params,scope,provenance);
   const release=await acquireLock(lock);
   let jobId;
   try{
    scheduleLocked();
    const all=files(),prior=early?all.find(j=>j.jobId===early.jobId):all.find(j=>j.requestKey===requestKey)||findPrior(all);
    if(early&&!prior)throw Error("Original accepted request disappeared; execution was withheld");
    if(prior){jobId=prior.jobId;}
    else{
     // Retries of accepted jobs succeed even when the waiting queue is full.
     const running=all.filter(occupied),candidate={...queueFields(taskClass),queueConfig,provenance,agentId:provenance?.agentId??runtime?.projectContext?.agentId,scope:scopeKey(scope),topic:params.topic,executionScope:runtime?.executionScope,modelSessionScope:runtime?.modelSessionScope,resourceKeys};
     const canStart=!runtime?.workspacePool&&!legacyBusy()&&!atCapacity(running,candidate)&&!running.some(job=>conflict(job,candidate))&&!all.some(job=>waiting.has(job.status)&&sameSession(job,candidate));
     if(!canStart&&all.filter(job=>queued(job)&&sameQueue(job,candidate)).length>=limits(candidate).maxQueuedJobs)return {status:'queue_full',...queueFields(taskClass),agentId:agentOf(candidate),accepted:false,message:'Waiting queue is full; no job was created.'};
     jobId=randomUUID();
     const job={...queueFields(taskClass),queueConfig,inputRequestKey,agentId:agentOf(candidate),timeoutMs:queueConfig.timeoutMs,jobId,requestKey,...projectFields(runtime),...modelFields(runtime),...(runtime?.projectContext?{requestBodyKey:requestKeyFor({...originalParams,repository:undefined,projectId:undefined},scope,provenance)}:{}),requestId:params.requestId,provenance,memoryReview:memoryHandoffSummary(params.memory),scope:scopeKey(scope),topic:params.topic,taskSummary:params.task.trim().slice(0,500),tags,resourceKeys,schedulerVersion:1,queueSequence:all.reduce((max,j)=>Math.max(max,j.queueSequence??0),0)+1,status:'queued',...(params.notify?{notification:{state:'pending',createdAt:Date.now()}}:{}),createdAt:Date.now(),heartbeatAt:Date.now()};
     writeJson(join(root,jobId+'.request.json'),{params,scope,runtime});
     writeJson(join(root,jobId+'.json'),job);
    }
    scheduleLocked();
   }finally{release();}
   // Persisted async jobs must release the caller even after an idempotent retry.
   return wait(jobId,scope,get(jobId,scope).notification ? 0 : params.waitSeconds??20);
  }
 };
}
