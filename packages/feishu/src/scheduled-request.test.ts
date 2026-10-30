import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const state=vi.hoisted(()=>({dir:'',session:'s1',sent:[] as any[]}));
vi.mock('./runtime.js',()=>({getFeishuRuntime:()=>({state:{resolveStateDir:()=>state.dir}})}));
vi.mock('./accounts.js',()=>({resolveFeishuRuntimeAccount:()=>({enabled:true,configured:true,config:{}})}));
vi.mock('./send.js',()=>({sendCardFeishu:async(p:any)=>{state.sent.push(p);return {messageId:'out'};}}));
import {createScheduledRequestAdapter,registerScheduledRequestAdapter,scheduledRequestBridge} from './scheduled-request.js';
import {SourceTask,sourceTaskBridge,recallTaskSource,isCompletionSourceCurrent} from './source-task.js';
import {bindSourceTask,taskProvenance,rememberAsyncJob} from '../../agent-worker/source-tasks.mjs';
let task:SourceTask;let adapter:ReturnType<typeof createScheduledRequestAdapter>;let runtime:any;let captured:any;
const scope={accountId:'account',chatId:'group',sessionKey:'agent:main:feishu:group:g',senderId:'requester',chatType:'group' as const,rootId:'thread',replyInThread:true};
const context={agentId:'main',sessionId:'s1',agentAccountId:'account',sessionKey:scope.sessionKey,requesterSenderId:'requester'};
beforeEach(()=>{state.dir=mkdtempSync(join(tmpdir(),'scheduled-feishu-'));state.session='s1';state.sent=[];captured=undefined;
 runtime={state:{resolveStateDir:()=>state.dir},config:{current:()=>({})},agent:{session:{resolveStorePath:()=>'',getSessionEntry:()=>({sessionId:state.session})}},channel:{reply:{finalizeInboundContext:(p:any)=>p},inbound:{run:vi.fn(async({adapter:a}:any)=>{const plan=a.resolveTurn();plan.replyOptions.onAgentRunStart();const lease=bindSourceTask(context);captured=taskProvenance(lease);rememberAsyncJob(lease,{jobId:'worker-job',provenance:captured,notification:{state:'pending'}});await plan.delivery.deliver({text:'已提交任务'},{kind:'final'});})}}};
 adapter=createScheduledRequestAdapter(runtime);task=new SourceTask(scope,[{messageId:'human-message',text:'daily authorized request'}]);task.begin();task.activate();
});
afterEach(()=>{task.close();sourceTaskBridge.leases.clear();rmSync(state.dir,{recursive:true,force:true});});
const request=(source:any)=>({id:'schedule',runKey:'schedule:2000',runAtMs:2000,source,projectId:'xgj',task:'Check specific target',constraints:'read-only'});
it('Main-only summary sends a table card with a receipt and no Worker job',async()=>{const source=adapter.capture(context);task.close();const table='昨日问题清单\n\n| 问题 | 状态 |\n| --- | --- |\n| 登录失败 | 待确认 |';runtime.channel.inbound.run=async({adapter:a}:any)=>{const plan=a.resolveTurn();expect(plan.ctxPayload.Body).toContain('不委派 Worker 做整理');expect(plan.ctxPayload.Body).toContain('start_time/end_time');expect(plan.ctxPayload.Body).toContain('直到 has_more=false');plan.replyOptions.onAgentRunStart();await plan.delivery.deliver({text:table},{kind:'final'});};const receipt=await adapter.deliver(request(source),{assertCurrent:()=>{}});expect(receipt).toMatchObject({accepted:true,jobIds:[],deliveryReceipts:[{messageId:'out',chatId:'group'}]});expect(state.sent[0].card).toMatchObject({schema:'2.0',body:{elements:[{tag:'markdown',content:table}]}});});
it('scheduled Main uses original sender/group/thread and actual Worker provenance, valid after turn closes',async()=>{const source=adapter.capture(context);task.close();const receipt=await adapter.deliver(request(source),{assertCurrent:()=>{}});expect(receipt).toEqual({accepted:true,jobIds:['worker-job'],deliveryReceipts:[{messageId:'out',chatId:'group'}]});expect(captured).toMatchObject(scope);expect(captured.requestMessageIds).toEqual(['human-message']);expect(captured.sourceMessageIds).toContain('scheduled:schedule:2000');expect(isCompletionSourceCurrent(captured,state.dir)).toBe(true);expect(sourceTaskBridge.leases.size).toBe(0);expect(state.sent[0]).toMatchObject({accountId:'account',to:'chat:group',replyToMessageId:'thread',replyInThread:true});});
it('rejects wrong sender and recursive scheduling from a scheduled lease',()=>{expect(()=>adapter.capture({...context,requesterSenderId:'other'})).toThrow();sourceTaskBridge.leases.get(JSON.stringify(['account',scope.sessionKey]))!.scheduledRequest=true;expect(()=>adapter.capture(context)).toThrow();});
it('reset and recalled authorization reject admission; recalls invalidate already submitted Worker provenance',async()=>{const source=adapter.capture(context);task.close();state.session='new';await expect(adapter.deliver(request(source),{assertCurrent:()=>{}})).rejects.toThrow();state.session='s1';await adapter.deliver(request(source),{assertCurrent:()=>{}});recallTaskSource({...scope,messageId:'human-message'});expect(isCompletionSourceCurrent(captured,state.dir)).toBe(false);await expect(adapter.deliver({...request(source),runKey:'schedule:3000'},{assertCurrent:()=>{}})).rejects.toThrow();expect(runtime.channel.inbound.run).toHaveBeenCalledTimes(1);});
it('deferred Main without admission cannot claim submission',async()=>{const source=adapter.capture(context);task.close();runtime.channel.inbound.run=async({adapter:a}:any)=>{expect(a.resolveTurn().replyOptions.turnAdoptionLifecycle.onDeferred()).toBe(false);};expect(await adapter.deliver(request(source),{assertCurrent:()=>{}})).toEqual({accepted:false,jobIds:[]});});
it('records pre-admission account failure stage without calling Main',async()=>{const source=adapter.capture(context);task.close();runtime.config.current=()=>{throw Error('configuration unavailable');};await expect(adapter.deliver(request(source),{assertCurrent:()=>{}})).rejects.toMatchObject({scheduledStage:'source_validation',message:'configuration unavailable'});expect(runtime.channel.inbound.run).not.toHaveBeenCalled();});

it('cross-plugin delivery enters the channel owner lifecycle scope',async()=>{const source=adapter.capture(context);task.close();let service:any;const runInBackgroundContext=vi.fn((run:()=>unknown)=>run());registerScheduledRequestAdapter({runtime,lifecycle:{runInBackgroundContext},registerService:(s:any)=>{service=s;}} as any);service.start();await scheduledRequestBridge.deliver!(request(source),{assertCurrent:()=>{}});expect(runInBackgroundContext).toHaveBeenCalledTimes(1);expect(captured.senderId).toBe(scope.senderId);service.stop();expect(scheduledRequestBridge.deliver).toBeUndefined();});

it('manual native trigger is labeled as an acceptance run, without replacing source identity',async()=>{const source=adapter.capture(context);task.close();runtime.channel.inbound.run=async({adapter:a}:any)=>{const plan=a.resolveTurn();expect(plan.ctxPayload.Body).toContain('管理员手动验收');expect(plan.ctxPayload.Body).toContain('本次时刻不代表计划延误');expect(plan.ctxPayload.SenderId).toBe(scope.senderId);plan.replyOptions.onAgentRunStart();};await adapter.deliver({...request(source),trigger:'manual'},{assertCurrent:()=>{}});});

it('group delivery starts a new group message and snapshots the same route for Worker results',async()=>{
 const source=adapter.capture(context);task.close();
 await adapter.deliver({...request(source),deliveryMode:'group'},{assertCurrent:()=>{}});
 expect(state.sent[0]).toMatchObject({accountId:'account',to:'chat:group',replyInThread:false});expect(state.sent[0].replyToMessageId).toBeUndefined();
 expect(captured).toMatchObject({accountId:scope.accountId,chatId:scope.chatId,sessionKey:scope.sessionKey,senderId:scope.senderId,deliveryMode:'group',replyInThread:false});
 expect(captured.rootId).toBeUndefined();expect(captured.requestMessageIds).toEqual(['human-message']);expect(source.rootId).toBe('thread');
 expect(isCompletionSourceCurrent(captured,state.dir)).toBe(true);
 recallTaskSource({...scope,messageId:'human-message'});expect(isCompletionSourceCurrent(captured,state.dir)).toBe(false);
});
it('explicit thread delivery uses only the original known thread; unsupported routes fail before Main',async()=>{
 const source=adapter.capture(context);task.close();await adapter.deliver({...request(source),deliveryMode:'thread'},{assertCurrent:()=>{}});
 expect(captured).toMatchObject({rootId:'thread',replyInThread:true,deliveryMode:'thread'});expect(state.sent[0].replyToMessageId).toBe('thread');
 const prior=runtime.channel.inbound.run.mock.calls.length;
 await expect(adapter.deliver({...request({...source,rootId:undefined}),deliveryMode:'thread'},{assertCurrent:()=>{}})).rejects.toThrow('Invalid scheduled delivery route');
 await expect(adapter.deliver({...request(source),deliveryMode:'other' as any},{assertCurrent:()=>{}})).rejects.toThrow('Invalid scheduled delivery route');
 expect(runtime.channel.inbound.run).toHaveBeenCalledTimes(prior);
});

it('saved 07:00 schedule updates through the requester API and fires into group chat without replacement',async()=>{
 const {createScheduledRequests}=await import('../../agent-repo/scheduled-requests.mjs');
 const jobs:any[]=[];const cron={add:async(p:any)=>{const job={...structuredClone(p),id:'native-clock'};jobs.push(job);return job;},update:async(id:string,patch:any)=>Object.assign(jobs.find(j=>j.id===id),patch),list:async()=>structuredClone(jobs)};
 const manager=createScheduledRequests({stateDir:join(state.dir,'scheduler'),getCron:()=>cron,bridge:{...adapter,jobsActive:()=>false},now:()=>1000});
 try{
  const original=await manager.manage({action:'create',requestId:'initial',name:'日报',projectId:'xgj',task:'Summarize original group',constraints:'Read only',expr:'0 7 * * *'},context);task.close();
  const humanUpdate=new SourceTask(scope,[{messageId:'update-message',text:'定时消息发在群里不要发在这个话题里'}]);humanUpdate.begin();humanUpdate.activate();
  try{
   const changed=await manager.manage({action:'update',id:original.id,expectedRevision:original.revision,requestId:'delivery-update',deliveryMode:'group'},context);
   expect(changed.id).toBe(original.id);expect(changed.jobId).toBe(original.jobId);expect(changed.schedule.expr).toBe('0 7 * * *');expect(jobs).toHaveLength(1);
  }finally{humanUpdate.close();}
  await manager.fire({action:'finished',status:'ok',jobId:original.jobId,agentId:'main',runAtMs:2000});
  expect(state.sent[0].replyToMessageId).toBeUndefined();expect(state.sent[0].replyInThread).toBe(false);expect(captured.deliveryMode).toBe('group');
  expect(captured.requestMessageIds).toEqual(['human-message']);expect(captured.sessionKey).toBe(scope.sessionKey);
 }finally{manager.close();}
});

it.each(['pause','remove'] as const)('an accepted Main keeps its saved route and final delivery after plan %s',async action=>{
 const {createScheduledRequests}=await import('../../agent-repo/scheduled-requests.mjs');const jobs:any[]=[];const cron={add:async(p:any)=>{const j={...structuredClone(p),id:'native-active'};jobs.push(j);return j;},update:async(id:string,p:any)=>Object.assign(jobs.find(j=>j.id===id),p),list:async()=>structuredClone(jobs)};
 const manager=createScheduledRequests({stateDir:join(state.dir,'manager'),getCron:()=>cron,bridge:{...adapter,jobsActive:()=>false},now:()=>1000});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 try{const plan=await manager.manage({action:'create',requestId:'active',name:'日报',projectId:'xgj',task:'Summarize current group',constraints:'Read only',expr:'0 7 * * *',deliveryMode:'group'},context);task.close();
  runtime.channel.inbound.run=async({adapter:a}:any)=>{const turn=a.resolveTurn();turn.replyOptions.onAgentRunStart();entered();await gate;await turn.delivery.deliver({text:'已核验的本次结果'},{kind:'final'});};
  const firing=manager.fire({action:'finished',status:'ok',jobId:plan.jobId,agentId:'main',runAtMs:2000});await started;try{await manager.administer('main',{action,id:plan.id,expectedRevision:plan.revision,requestId:'stop-accepted',confirmed:true});}finally{release();}await firing;
  expect(state.sent).toHaveLength(1);expect(state.sent[0].replyToMessageId).toBeUndefined();const taskState=(await manager.catalog('main',{includeRemoved:true})).tasks[0];expect(taskState.lastRun.status).toBe('submitted');expect(taskState.status).toBe(action==='pause'?'paused':'removed');
 }finally{release();manager.close();}
});
it('a recalled source still prevents final delivery after Main has been accepted',async()=>{
 const source=adapter.capture(context);task.close();runtime.channel.inbound.run=async({adapter:a}:any)=>{const turn=a.resolveTurn();turn.replyOptions.onAgentRunStart();recallTaskSource({...scope,messageId:'human-message'});await turn.delivery.deliver({text:'stale result'},{kind:'final'});};await expect(adapter.deliver(request(source),{assertCurrent:()=>{},onAccepted:()=>{}})).rejects.toThrow();expect(state.sent).toHaveLength(0);
});
