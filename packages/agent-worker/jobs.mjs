import {projectFields,validateHistoryFilter,matchesHistoryFilter} from './project-binding.mjs';
import {validateContextAnswers} from './context-request.mjs';
import {finalizeJobReport} from './task-report.mjs';
import {tryLock,acquireLock} from './locks.mjs';
import {memoryHandoffSummary} from './memory-context.mjs';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,renameSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
export function readJson(path){return JSON.parse(readFileSync(path,'utf8'));}
export function writeJson(path,value){const tmp=path+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,path);}
export function requestKeyFor(params,scope,provenance){return createHash('sha256').update(JSON.stringify([scope,params.topic,params.task,params.context,params.constraints,params.requestId??'',provenance?.accountId,provenance?.senderId,...(params.thinkingLevel?[params.thinkingLevel]:[]),...((params.repository??(params.projectId?'projects/'+params.projectId:undefined))&&params.repository!=='project'?[params.repository??'projects/'+params.projectId]:[])])).digest('hex');}
export function normalizeTags(tags=[]) {
 if(!Array.isArray(tags)||tags.length>50)throw Error('tags must be an array of at most 50 strings');
 const unique=new Map();
 for(const tag of tags){
  if(typeof tag!=='string'||!tag.trim()||tag.length>160)throw Error('Each tag must contain 1 to 160 characters');
  const value=tag.trim();unique.set(value.toLocaleLowerCase(),value);
 }
 return [...unique.values()];
}
const waiting=new Set(['awaiting_main','awaiting_user']);
const active=new Set(['queued','running','cancelling']);
export function createJobs({root,node,worker,getRuntime=()=>undefined,getLimits=()=>({maxConcurrentJobs:3,maxQueuedJobs:100}),logger}) {
 const lock=join(root,'scheduler-lock');
 let timer;
 const files=()=>readdirSync(root).filter(x=>/^[0-9a-f-]{36}\.json$/i.test(x)).map(x=>readJson(join(root,x)));
 const limits=()=>{const {maxConcurrentJobs=3,maxQueuedJobs=100}=getLimits();
  if(!Number.isInteger(maxConcurrentJobs)||maxConcurrentJobs<1||maxConcurrentJobs>10||!Number.isInteger(maxQueuedJobs)||maxQueuedJobs<1||maxQueuedJobs>1000)throw Error('Invalid scheduler capacity');
  return {maxConcurrentJobs,maxQueuedJobs};};
 const legacyBusy=()=>existsSync(join(root,'active'))||existsSync(join(root,'..','lock'));
 const order=(a,b)=>(a.queueSequence??a.createdAt)-(b.queueSequence??b.createdAt)||a.createdAt-b.createdAt||a.jobId.localeCompare(b.jobId);
 const sameSession=(a,b)=>a.scope===b.scope&&a.topic===b.topic&&(!a.executionScope||!b.executionScope||a.executionScope===b.executionScope);
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
  if(queued(j)){const all=files(),pending=all.filter(queued).sort(order);
   const running=all.filter(occupied);
   j.queuePosition=pending.findIndex(x=>x.jobId===j.jobId)+1;
   j.waitingReason=legacyBusy()?'legacy_executor':(running.some(x=>sameSession(x,j))||all.some(x=>waiting.has(x.status)&&sameSession(x,j)))?'session_busy':running.some(x=>conflict(x,j))?'resource_busy':running.length>=limits().maxConcurrentJobs?'capacity':'awaiting_dispatch';
  }
  return j;
 }
 function view(j){const {scope,request,...result}=j;return result;}
 function cancelMatching(matches) {
  mkdirSync(root,{recursive:true,mode:0o700});
  const ids=[];
  for (const file of readdirSync(root).filter(x=>/^[0-9a-f-]{36}\.json$/i.test(x))) {
   const job=readJson(join(root,file));
   // Inspect stored state, not the derived 'unknown' heartbeat projection: a
   // temporarily lost worker must see cancellation if it later comes back.
   if ((active.has(job.status)||job.status==='unknown'||waiting.has(job.status)) && matches(job.provenance)) {
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
 function scheduleLocked(){
  const all=files();
  for(const job of all.filter(j=>waiting.has(j.status)&&j.contextRequest?.expiresAt<=Date.now())){job.status='timed_out';job.error='Context reply deadline exceeded';job.finishedAt=Date.now();if(job.notification)job.notification={state:'pending',eventKey:randomUUID()};terminalJob(job);}
  for(const job of all.filter(queued)){
   if(existsSync(join(root,job.jobId+'.cancel'))){Object.assign(job,{status:'cancelled',finishedAt:Date.now(),heartbeatAt:Date.now()});terminalJob(job);}
  }
  // Old releases use a global admission directory. Never bypass their worker.
  if(legacyBusy())return;
  const {maxConcurrentJobs}=limits();
  const running=all.filter(occupied);
  const pending=all.filter(queued).sort(order);
  for(const job of pending){
   const file=join(root,job.jobId+'.json');
   if(existsSync(join(root,job.jobId+'.cancel'))){terminalJob({...job,status:'cancelled',finishedAt:Date.now(),heartbeatAt:Date.now()});continue;}
   if(running.length>=maxConcurrentJobs||running.some(other=>conflict(other,job))||all.some(other=>waiting.has(other.status)&&sameSession(other,job)))continue;
   const requestFile=join(root,job.jobId+'.request.json');
   if(!existsSync(requestFile)){terminalJob({...job,status:'failed',error:'Queued request missing; task was not executed',finishedAt:Date.now()});continue;}
   const request=readJson(requestFile);
   if(scopeKey(request.scope)!==job.scope||request.params?.topic!==job.topic)throw Error('Queued request binding mismatch; execution withheld');
   const claimed={...job,resumePending:false,status:'running',startedAt:job.startedAt??Date.now(),heartbeatAt:Date.now()};
   // Persist the reservation BEFORE spawning. An interrupted dispatch remains
   // unknown and occupied, never automatically spawning a second business worker.
   writeJson(file,claimed);running.push(claimed);
   let child;
   const failed=()=>{terminalJob({...claimed,status:'failed',error:'Could not start job worker',finishedAt:Date.now(),heartbeatAt:Date.now()},request);};
   try{child=spawn(request.runtime?.node ?? node,[worker,root,job.jobId],{detached:true,stdio:['pipe','ignore','ignore']});}
   catch{failed();continue;}
   child.stdin.on('error',()=>{});child.once('error',failed);
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
 return {
  tick,
  start(){if(timer)return;tick();timer=setInterval(()=>{try{tick();}catch(error){logger?.error?.('Codex scheduler: '+error.message);}},500);timer.unref();},
  stop(){clearInterval(timer);timer=undefined;},
  cancelSources(event) {return cancelMatching(p=>p?.accountId===event.accountId && p?.chatId===event.chatId && p.sourceMessageIds?.includes(event.messageId));},
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
     const text=[j.jobId,j.topic,j.projectId,j.repository,j.taskSummary,j.status,j.provenance?.senderId,...j.tags].filter(Boolean).join(' ').toLocaleLowerCase();
     return terms.every(term=>text.includes(term));
    }).sort((a,b)=>b.createdAt-a.createdAt||a.jobId.localeCompare(b.jobId));
   const summaries=matches.slice(0,limit).map(j=>{const {result,reports,taskReport,...summary}=view(j);return summary;});
   const hasMore=summaries.length<matches.length;
   return {jobs:summaries,jobPage:{total:matches.length,limit,hasMore}};
  },
  tag(jobId,scope,tags,requester,mode='merge'){
   const j=get(jobId,scope);
   if(j.provenance&&(!requester?.senderId||requester.senderId!==j.provenance.senderId||requester.accountId!==j.provenance.accountId))throw Error('Only the task requester can tag this job');
   if(!j.provenance&&scope.includes(':feishu:'))throw Error('Job requester is unknown; administrator inspection required');
   if(!['merge','replace'].includes(mode))throw Error('tagMode must be merge or replace');
   const values=normalizeTags(tags);
   const merged=mode==='merge'?[...new Map([...j.tags,...values].map(tag=>[tag.toLocaleLowerCase(),tag])).values()]:values;
   const updated=normalizeTags(merged);
   writeJson(join(root,jobId+'.tags.json'),{tags:updated});
   const {result,reports,taskReport,...summary}=view({...j,tags:updated});return summary;
  },
  status:(jobId,scope)=>view(get(jobId,scope)),wait,
  cancel(jobId,scope,requester){const j=get(jobId,scope);
   if(j.provenance && (!requester?.senderId || requester.senderId!==j.provenance.senderId || requester.accountId!==j.provenance.accountId))throw Error('Only the task requester can cancel this job');
   if(!j.provenance && scope.includes(':feishu:'))throw Error('Job requester is unknown; administrator inspection required');
   const stored=readJson(join(root,jobId+'.json'));
   if(waiting.has(stored.status)){terminalJob({...stored,status:'cancelled',finishedAt:Date.now(),notification:stored.notification?{state:'pending',eventKey:randomUUID()}:undefined});return view(get(jobId,scope));}
   if(active.has(stored.status)||stored.status==='unknown'){writeFileSync(join(root,jobId+'.cancel'),'cancel',{mode:0o600});return {...view(j),status:j.status==='unknown'?'unknown':'cancelling',note:'Cancellation requested; business operations already accepted externally are not rolled back.'};}return view(j);},
  awaitUser(jobId,scope,questionId,requester,authorize,knownValues){return this.reply(jobId,scope,questionId,undefined,requester,authorize,true,knownValues);},
  async reply(jobId,scope,questionId,answer,requester,authorize=()=>true,waitingForUser=false,knownValues,answerMetadata={}){
   if(!waitingForUser&&(typeof answer!=='string'||!answer.trim()||answer.length>16000))throw Error('Invalid Main answer');
   const release=await acquireLock(lock);
   try {
    const job=get(jobId,scope);
    if(job.provenance&&(!requester?.senderId||requester.senderId!==job.provenance.senderId||requester.accountId!==job.provenance.accountId))throw Error('Only the task requester Main can reply');
    if(!job.provenance&&scope.includes(':feishu:'))throw Error('Job requester is unknown');
    if(!authorize(job.provenance))throw Error('Original task authorization is no longer current');
    if(['cancelled','timed_out','failed'].includes(job.status))throw Error('Task cannot accept a reply');
    const previous=(job.questions??[]).find(q=>q.questionId===questionId);
    if(!waitingForUser&&previous?.answer!==undefined){if(previous.answer!==answer)throw Error('Question already answered differently');return view(job);}
    if(!waiting.has(job.status)||job.contextRequest?.questionId!==questionId)throw Error('No matching pending question');
    if(job.contextRequest.expiresAt<=Date.now()||existsSync(join(root,jobId+'.cancel')))throw Error('Question expired or task cancelled');
    const requestFile=join(root,jobId+'.request.json'),request=readJson(requestFile);
    if(requestKeyFor(request.params,scope,job.provenance)!==job.requestKey||request.scope!==scope)throw Error('Original request binding mismatch');
    if(waitingForUser){
     if(job.status==='awaiting_user')return view(job);
     const at=Date.now(),question={...job.contextRequest,waitingForUserAt:at,...(knownValues?{knownValues:validateContextAnswers(job.contextRequest,knownValues,{partial:true})}:{})};
     const updated={...job,status:'awaiting_user',contextRequest:question,progress:'等待用户补充上下文',questions:job.questions.map(q=>q.questionId===questionId?question:q)};
     appendFileSync(join(root,jobId+'.events.jsonl'),JSON.stringify({event:'main.awaiting_user',time:at,questionId})+'\n',{mode:0o600});
     writeJson(join(root,jobId+'.json'),updated);return view(updated);
    }
    if(files().filter(queued).length>=limits().maxQueuedJobs)throw Error('Waiting queue is full; question remains pending');
    const metadata={answerSource:job.status==='awaiting_main'?'main_context':'user_text',...answerMetadata};
    if(metadata.answerValues)metadata.answerValues=validateContextAnswers(job.contextRequest,metadata.answerValues);
    const questions=job.questions.map(q=>q.questionId===questionId?{...q,answer,...metadata,answeredAt:Date.now()}:q);
    request.resumeParams={...request.params,mainReplies:questions.filter(q=>q.answer!==undefined).map(({questionId,question,answer,answerValues})=>({questionId,question,answer,...(answerValues?{answerValues}:{})}))};
    writeJson(requestFile,request);
    const resumed={...job,questions,status:'queued',resumePending:true,heartbeatAt:Date.now(),progress:'Main 已回复，等待继续执行',notification:job.notification?{state:'pending',eventKey:randomUUID()}:undefined};
    delete resumed.contextRequest;delete resumed.finishedAt;delete resumed.result;
    appendFileSync(join(root,jobId+'.events.jsonl'),JSON.stringify({event:'main.context_reply',time:Date.now(),questionId,answer})+'\n',{mode:0o600});
    writeJson(join(root,jobId+'.json'),resumed);scheduleLocked();return view(get(jobId,scope));
   }finally{release();}
  },
  async run(params,scope,provenance){
   const tags=normalizeTags(params.tags);
   if(params.resourceKeys!==undefined&&(!Array.isArray(params.resourceKeys)||params.resourceKeys.length>20))throw Error('resourceKeys must contain at most 20 keys');
   normalizeTags(params.resourceKeys);
   const resourceKeys=[...new Set((params.resourceKeys??[]).map(key=>key.trim()))];
   mkdirSync(root,{recursive:true,mode:0o700});
   const inputRequestKey=requestKeyFor(params,scope,provenance);
   const findPrior=all=>{
    const exact=all.find(j=>j.inputRequestKey===inputRequestKey||j.requestKey===inputRequestKey);
    if(exact?.project&&params.projectId!==undefined&&params.projectId!==exact.projectId)throw Object.assign(Error('projectId conflicts with the original project binding'),{code:'PROJECT_SELECTOR_CONFLICT'});
    if(exact)return exact;
    const sameBody=all.filter(j=>j.project&&j.scope===scopeKey(scope)&&j.requestBodyKey===requestKeyFor({...params,repository:undefined,projectId:undefined},scope,provenance));
    const matches=sameBody.filter(j=>params.repository?j.repository===params.repository:params.projectId?j.projectId===params.projectId&&j.repository==='projects/'+params.projectId:false);
    if(matches.length===1)return matches[0];
    if(params.requestId&&all.some(j=>j.project&&j.scope===scopeKey(scope)&&j.topic===params.topic&&j.requestId===params.requestId&&j.provenance?.accountId===provenance?.accountId&&j.provenance?.senderId===provenance?.senderId))throw Object.assign(Error('Existing project request has different task or selectors'),{code:'REQUEST_ID_CONFLICT'});
   };
   const early=findPrior(files());
   const runtime=early?undefined:await getRuntime(params,{...provenance,sessionKey:scope});
   const originalParams=params;
   if(runtime?.projectContext)params={...params,projectId:runtime.projectContext.projectId,repository:runtime.projectContext.repository};
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
     const running=all.filter(occupied),candidate={scope:scopeKey(scope),topic:params.topic,executionScope:runtime?.executionScope,resourceKeys};
     const canStart=!legacyBusy()&&running.length<limits().maxConcurrentJobs&&!running.some(job=>conflict(job,candidate))&&!all.some(job=>waiting.has(job.status)&&sameSession(job,candidate));
     if(!canStart&&all.filter(queued).length>=limits().maxQueuedJobs)return {status:'queue_full',accepted:false,message:'Waiting queue is full; no job was created.'};
     jobId=randomUUID();
     const job={jobId,requestKey,...projectFields(runtime),...(runtime?.projectContext?{inputRequestKey,requestBodyKey:requestKeyFor({...originalParams,repository:undefined,projectId:undefined},scope,provenance),requestId:params.requestId}:{}),provenance,memoryReview:memoryHandoffSummary(params.memory),scope:scopeKey(scope),topic:params.topic,taskSummary:params.task.trim().slice(0,500),tags,resourceKeys,schedulerVersion:1,queueSequence:all.reduce((max,j)=>Math.max(max,j.queueSequence??0),0)+1,status:'queued',...(params.notify?{notification:{state:'pending',createdAt:Date.now()}}:{}),createdAt:Date.now(),heartbeatAt:Date.now()};
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
