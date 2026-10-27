import {randomUUID} from 'node:crypto';
import {canonical,digest,fault,terminalStates} from './store.mjs';
const jobTerminal=new Set(['completed','failed','cancelled','timed_out']);
const wrap=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
/** Durable coordinator. The adapter owns host admission; jobs remains the only execution scheduler. */
export function createTaskService({store,jobs,main,invoke,policy,logger=console}){
 let running=false,timer,scheduled,stopping=false,active;
 const patch=(id,p)=>store.update(id,()=>p);
 const view=t=>({version:1,taskId:t.taskId,createdAt:t.createdAt,updatedAt:t.updatedAt,deadline:t.deadline,state:t.state,phase:t.phase,sessionKey:t.sessionKey,sessionId:t.sessionId,jobId:t.jobId,workerStatus:t.workerStatus,result:t.result,error:t.error,predecessorTaskId:t.predecessorTaskId,generation:t.generation,settled:t.settled===true,artifacts:t.artifacts??[],waitingReason:t.waitingReason,verificationAttempts:t.verificationAttempts??0,diagnostics:{unknownCount:store.list().filter(x=>x.owner===t.owner&&x.state==='unknown').length,resultReady:!!t.result},attempts:store.attempts(t.taskId)});
 const fail=(t,code,settled=false)=>patch(t.taskId,{state:settled?'failed':'cancelling',phase:settled?'finished':'stopping',error:{code},settled});
 function bound(context){const b=context.toolBindings?.agentWorkerAutomation;if(!active||b?.nonce!==active.nonce||b?.taskId!==active.taskId||context.sessionKey!==active.sessionKey||context.sessionId!==active.sessionId||context.agentId!==active.agentId)throw fault('INVALID_TASK_BINDING');return store.get(active.taskId);}
 async function tool(params,context){
  const t=bound(context);
  if(stopping||['cancelling','unknown'].includes(t.state)||terminalStates.has(t.state))throw fault('TASK_NOT_EXECUTABLE');
  if(['projects','models','queues','list'].includes(params.action))return invoke(params,context);
  if(params.action==='run'){
   if(active.phase!=='dispatch'||t.jobId)throw fault('WORKER_ALREADY_BOUND');
   if(params.projectId!==t.request.projectId||params.repository!==t.request.repository||params.useWorkspace!==t.request.useWorkspace||params.taskClass!==undefined||params.queueId!==undefined&&params.queueId!==t.policy.queueId)throw fault('TASK_SCOPE_MISMATCH');
   let p={...params,constraints:t.request.constraints,queueId:t.policy.queueId,requestId:'automation:'+t.taskId,topic:t.taskId,deliveryMode:'wait',waitSeconds:0};
   const previous=store.event(t.taskId,'delegation');
   if(previous){if(previous.rejected!==true)throw fault('DELEGATION_ALREADY_CLAIMED');p=previous.params;}else if(!store.claim(t.taskId,'delegation',{params:p}))throw fault('DELEGATION_ALREADY_CLAIMED');
   const attempt=(t.delegationAttempts??0)+1;if(!store.claim(t.taskId,'delegation-attempt:'+attempt,{}))throw fault('DELEGATION_ALREADY_CLAIMED');patch(t.taskId,{delegationAttempts:attempt});store.finish(t.taskId,'delegation',{params:p,rejected:false});
   const answer=await invoke(p,{...context,automationTask:{version:1,taskId:t.taskId},asyncCompletionEnabled:false});
   const job=JSON.parse(answer.content[0].text);
   if(!job.jobId){if(job.status==='queue_full'){store.finish(t.taskId,'delegation',{params:p,rejected:true});patch(t.taskId,{state:'accepted',phase:'waiting_capacity',nextDispatchAt:Date.now()+30000});return wrap({status:'queued',instruction:'宿主保留原任务等待容量；结束本轮，不重复提交。'});}throw fault('WORKER_NOT_ACCEPTED');}
   patch(t.taskId,{jobId:job.jobId,state:store.get(t.taskId).cancelRequestedAt||store.get(t.taskId).state==='cancelling'?'cancelling':'running',phase:'worker'});store.finish(t.taskId,'delegation',{jobId:job.jobId});
   return wrap({...job,deliveryMode:'async',instruction:'已接纳，结束本轮；宿主将调度原任务核验。'});
  }
  if(params.jobId!==t.jobId)throw fault('TASK_SCOPE_MISMATCH');
  if(['status','wait'].includes(params.action))return wrap(jobs.status(t.jobId,t.sessionKey));
  if(params.action==='await_user'){
   if(active.phase!=='context')throw fault('INVALID_PHASE');
   const code=jobs.status(t.jobId,t.sessionKey).contextRequest?.waitKind==='authorization'?'AUTHORIZATION_REQUIRED':'REQUIRED_CONTEXT_UNAVAILABLE';
   await jobs.failAutomationContext(t.jobId,t.sessionKey,t.taskId,params.questionId,code);
   fail(t,code);return wrap({accepted:true,state:'cancelling'});
  }
  if(params.action==='reply'){
   if(active.phase!=='context'||params.questionId!==active.questionId)throw fault('INVALID_QUESTION_BINDING');
   const r=await invoke(params,context);return r;
  }
  throw fault('ACTION_NOT_ALLOWED');
 }
 async function result(params,context){
  const t=bound(context);
  if(active.phase!=='verify'||!t.jobId)throw fault('INVALID_PHASE');
  const j=jobs.status(t.jobId,t.sessionKey);
  if(!jobTerminal.has(j.status)||!['succeeded','blocked'].includes(params.outcome)||!params.result||typeof params.result!=='object'||Array.isArray(params.result)||canonical(params).length>64000)throw fault('INVALID_RESULT');
  if(params.outcome==='succeeded'&&j.status!=='completed')throw fault('WORKER_NOT_SUCCESSFUL');
  if(t.result){if(canonical(t.result)!==canonical(params))throw fault('RESULT_CONFLICT');return wrap(view(t));}
  if(t.state==='cancelling'||t.cancelRequestedAt)throw fault('CANCELLATION_PENDING');
  return wrap(view(patch(t.taskId,{result:params,state:params.outcome==='succeeded'?'completed':'failed',phase:'finished',error:params.outcome==='blocked'?{code:'BUSINESS_BLOCKED'}:null,settled:!j.useWorkspace||j.workspaceSettled===true&&j.workspaceRelease==='idle'})));
 }
 async function turn(t,phase,event,payload){
  if(!store.claim(t.taskId,event,{phase})){
   // A prior process may have executed a side effect before persisting its receipt.
   if(store.event(t.taskId,event)?.status!=='done')patch(t.taskId,{state:'unknown',phase,error:{code:'MAIN_TURN_UNCERTAIN'}});
   return;
  }
  const controller=new AbortController();active={taskId:t.taskId,sessionKey:t.sessionKey,sessionId:t.sessionId,agentId:t.request.agentId,phase,questionId:payload?.contextRequest?.questionId,nonce:randomUUID(),controller};
  patch(t.taskId,{phase,state:'running'});
  try{
   await main.run(t,{phase,payload,binding:{taskId:t.taskId,nonce:active.nonce},signal:controller.signal});
   store.finish(t.taskId,event,{phase});
   const current=store.get(t.taskId);
   if(stopping||current.state==='cancelling')return;
   if(phase==='dispatch'&&!current.jobId&&current.phase!=='waiting_capacity'){const found=jobs.findAutomation(t.taskId,t.sessionKey);if(found)patch(t.taskId,{jobId:found.jobId,phase:'worker'});else fail(current,'MAIN_DID_NOT_DELEGATE',(!store.event(t.taskId,'delegation')||store.event(t.taskId,'delegation').rejected===true));}
   if(phase==='context'&&jobs.status(t.jobId,t.sessionKey).status==='awaiting_main'){const code=payload.contextRequest.waitKind==='authorization'?'AUTHORIZATION_REQUIRED':'REQUIRED_CONTEXT_UNAVAILABLE';await jobs.failAutomationContext(t.jobId,t.sessionKey,t.taskId,payload.contextRequest.questionId,code);fail(current,code);}
   if(phase==='verify'&&!current.result&&current.state!=='cancelling')fail(current,'MAIN_RESULT_MISSING',current.settled===true);
  }catch{if(!terminalStates.has(store.get(t.taskId).state)&&store.get(t.taskId).state!=='cancelling')patch(t.taskId,{state:'unknown',phase,error:{code:'MAIN_TURN_UNCERTAIN'}});}finally{active=undefined;}
 }
 async function step(t){
  if(terminalStates.has(t.state)&&t.settled){main.release?.(t);return;}
  const recovered=t.jobId?null:jobs.findAutomation(t.taskId,t.sessionKey);if(recovered)t=patch(t.taskId,{jobId:recovered.jobId,phase:'worker',state:t.cancelRequestedAt||t.state==='cancelling'?'cancelling':'running'});
  const j=t.jobId?jobs.status(t.jobId,t.sessionKey):null;
  if(j)t=patch(t.taskId,{workerStatus:j.status,waitingReason:j.waitingReason??j.workspaceWaiting,artifacts:(j.reports??[]).map(r=>({path:r.path,omittedReason:r.omittedReason})),settled:jobTerminal.has(j.status)&&(!j.useWorkspace||j.workspaceSettled===true&&j.workspaceRelease==='idle')});
  if(terminalStates.has(t.state)){if(t.settled)main.release?.(t);return;}
  if(t.state==='unknown'&&!j&&!t.cancelRequestedAt){
   // Reconcile jobs first. Never run Main to investigate an uncertain execution.
   const entry=await main.session(t);
   if((!t.sessionId&&!entry)||(t.sessionId&&entry?.sessionId===t.sessionId)){
    const settled=store.settleUnstartedUnknown(t.taskId);
    if(settled){main.release?.(settled);return;}
   }
   if(t.sessionId)await main.protect?.(t);
   return; // Neither a missing receipt nor deadline expiry proves non-execution.
  }
  if(t.sessionId)await main.protect?.(t);
  if(j?.status==='unknown'&&!t.cancelRequestedAt&&t.state!=='cancelling'){patch(t.taskId,{state:'unknown',phase:'worker',error:{code:'WORKER_UNKNOWN'}});return;}
  if(t.state==='unknown'&&j&&!jobTerminal.has(j.status)&&!t.cancelRequestedAt)return;
  if(t.cancelRequestedAt&&(t.state!=='cancelling'||t.error))t=patch(t.taskId,{state:'cancelling',phase:'stopping',error:null});
  if(Date.now()>=t.deadline&&t.state!=='cancelling')t=fail(t,'TASK_DEADLINE_EXCEEDED',!j&&(!store.event(t.taskId,'delegation')||store.event(t.taskId,'delegation').rejected===true));
  if(terminalStates.has(t.state)){if(t.settled)main.release?.(t);return;}
  if(t.state==='cancelling'){
   if(j&&jobs.executionActive?.(t.jobId,t.sessionKey)){jobs.cancel(t.jobId,t.sessionKey);return;}
   if(j&&!jobTerminal.has(j.status)){jobs.cancel(t.jobId,t.sessionKey);return;}
   if(!j&&store.event(t.taskId,'delegation')?.rejected!==true&&store.event(t.taskId,'delegation')){patch(t.taskId,{state:'unknown',error:{code:'DELEGATION_UNCERTAIN'}});return;}
   patch(t.taskId,{state:t.error?'failed':'cancelled',phase:'finished',settled:!j||t.settled});return;
  }
  if(j&&jobs.executionActive?.(t.jobId,t.sessionKey)&&(jobTerminal.has(j.status)||j.status==='awaiting_main'))return;
  if(j&&jobTerminal.has(j.status)){const attempt=(t.verificationAttempts??0)+1;if(attempt>3){fail(t,'MAIN_VERIFICATION_EXHAUSTED',t.settled);return;}t=patch(t.taskId,{verificationAttempts:attempt});await turn(t,'verify','verify:'+attempt,j);return;}
  if(t.state==='unknown')return;
  if(j?.status==='awaiting_main'){
   const q=j.contextRequest,key='gap:'+digest([q.question,q.fields,q.waitKind,q.reason,q.progress]);
   const previous=store.event(t.taskId,key);
   if(previous&&previous.questionId!==q.questionId){await jobs.failAutomationContext(t.jobId,t.sessionKey,t.taskId,q.questionId,'REPEATED_CONTEXT_REQUEST');fail(t,'REPEATED_CONTEXT_REQUEST');return;}
   store.claim(t.taskId,key,{questionId:q.questionId});await turn(t,'context','question:'+q.questionId,j);return;
  }
  if(j)return;
  if(t.nextDispatchAt&&Date.now()<t.nextDispatchAt)return;
  const entry=await main.session(t);if(!entry)return;
  if(t.sessionId&&t.sessionId!==entry.sessionId){patch(t.taskId,{state:'unknown',error:{code:'SESSION_REPLACED'}});return;}
  t=patch(t.taskId,{sessionId:entry.sessionId});await main.protect?.(t);await turn(t,'dispatch',t.delegationAttempts?'dispatch:'+t.delegationAttempts:'dispatch');
 }
 async function tick(){if(running||stopping)return;running=true;try{for(const t of store.list()){if(stopping)break;try{await step(t);}catch(error){logger.error('Automation reconciliation failed task='+t.taskId+' phase='+t.phase+' type='+error?.name+' stack='+String(error?.stack??'').split('\n').slice(1,5).join(' | '));patch(t.taskId,{state:'unknown',error:{code:'TASK_RECONCILIATION_FAILED'}});}}}catch{logger.error('Automation reconciliation failed; durable tasks retained');}finally{running=false;}}
 return {tool,result,tick,view,
  submit(owner,input){if(!policy.enabled)throw fault('AUTOMATION_DISABLED');if(!policy.agents.includes(input.agentId)||!policy.projects.includes(input.projectId))throw fault('TASK_SCOPE_DENIED');return view(store.submit(owner,input,policy));},
  get:(owner,id)=>view(store.owned(id,owner)),
  cancel(owner,id){const t=store.owned(id,owner);if(terminalStates.has(t.state))return view(t);const next=patch(id,{state:'cancelling',phase:'stopping',error:null,cancelRequestedAt:t.cancelRequestedAt??Date.now()});if(active?.taskId===id)active.controller.abort();return view(next);},
  rerun(owner,id,key){if(!policy.enabled)throw fault('AUTOMATION_DISABLED');const prior=store.owned(id,owner);if(!policy.agents.includes(prior.request.agentId)||!policy.projects.includes(prior.request.projectId))throw fault('TASK_SCOPE_DENIED');return view(store.rerun(owner,id,key));},
  protects:scope=>store.list().some(t=>t.sessionKey===scope&&(!terminalStates.has(t.state)||!t.settled)),
  async start(scheduler){stopping=false;for(const t of store.list())if(t.sessionId&&(!terminalStates.has(t.state)||!t.settled)){try{await main.protect?.(t);}catch{patch(t.taskId,{state:'unknown',error:{code:'SESSION_RECONCILIATION_FAILED'}});}}if(scheduler){scheduled=scheduler.schedule({id:"automation-reconcile",delayMs:0,everyMs:1000,run:tick});}else{timer=setInterval(()=>void tick(),1000);timer.unref();void tick();}},
  async stop(){stopping=true;scheduled?.cancel();clearInterval(timer);active?.controller.abort();main.releaseAll?.();while(running)await new Promise(r=>setTimeout(r,20));}
 };
}
