import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createJobs,writeJson} from './jobs.mjs';
import {bindSourceTask,sourceTaskBridge,taskProvenance,rememberAsyncJob,rememberAsyncContinuation,rememberUserQuestion} from './source-tasks.mjs';
test('only actual asynchronous acceptance from the same trusted source holds the card',()=>{
 const lease={taskId:'task',revision:0,accountId:'a',chatId:'c',sessionKey:'s',senderId:'u',sourceMessageIds:['m'],signal:new AbortController().signal};
 sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);
 try {
  const provenance=taskProvenance(lease);
  rememberAsyncJob(lease,{jobId:'busy',provenance});
  rememberAsyncJob(lease,{jobId:'other',notification:{state:'pending'},provenance:{...provenance,chatId:'other'}});
  assert.equal(lease.asyncJobIds,undefined);
  const job={jobId:'accepted',notification:{state:'pending'},provenance};
  rememberAsyncJob(lease,job);rememberAsyncJob(lease,job);
  assert.deepEqual(lease.asyncJobIds,['accepted']);
  assert.equal(lease.asyncDispatchAccepted,true);
  assert.equal(taskProvenance(lease).asyncJobIds,undefined);
  const retry={...lease,taskId:'retry',asyncJobIds:undefined,asyncDispatchAccepted:undefined};
  sourceTaskBridge.leases.set(JSON.stringify(['a','s']),retry);
  rememberAsyncJob(retry,job);
  assert.equal(retry.asyncDispatchAccepted,true);assert.equal(retry.asyncJobIds,undefined);
 } finally {sourceTaskBridge.leases.clear();}
});
test('trusted lease is bound once and an invalidated run cannot mint new provenance',()=>{
 const controller=new AbortController();
 const lease={taskId:'task',revision:1,accountId:'a',chatId:'c',sessionKey:'s',senderId:'u',sourceMessageIds:['m'],signal:controller.signal};
 sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);
 try {
  assert.equal(bindSourceTask({agentAccountId:'other',sessionKey:'s',requesterSenderId:'u'}),undefined);
  const bound=bindSourceTask({agentAccountId:'a',sessionKey:'s',requesterSenderId:'u'});
  assert.throws(()=>bindSourceTask({agentAccountId:'a',sessionKey:'s',requesterSenderId:'other'}));
  const p=taskProvenance(bound);lease.sourceMessageIds.push('later');assert.deepEqual(p.sourceMessageIds,['m']);
  sourceTaskBridge.leases.delete(JSON.stringify(['a','s']));assert.throws(()=>taskProvenance(bound));
  sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);controller.abort();assert.throws(()=>taskProvenance(bound));
 } finally {sourceTaskBridge.leases.clear();}
});
test('recall cancels only source-bound jobs including stale-heartbeat workers after restart',()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-source-jobs-'));
 const hash=createHash('sha256').update('s').digest('hex');
 const jobs=createJobs({root,node:process.execPath,worker:'/unused'});
 const seed=(change={})=>{const id=randomUUID();writeJson(join(root,id+'.json'),{jobId:id,scope:hash,status:'running',heartbeatAt:0,provenance:{taskId:'task',revision:0,accountId:'a',chatId:'c',sourceMessageIds:['one','two']},...change});return id;};
 try {
  const live=seed(),done=seed({status:'completed'}),other=seed({provenance:{accountId:'other',chatId:'c',sourceMessageIds:['one']}});
  assert.equal(jobs.status(live,'s').status,'unknown');
  assert.deepEqual(jobs.cancelSources({accountId:'a',chatId:'c',messageId:'one'}),[live]);
  assert.ok(existsSync(join(root,live+'.cancel')));assert.ok(!existsSync(join(root,done+'.cancel')));assert.ok(!existsSync(join(root,other+'.cancel')));
  const recovered=createJobs({root,node:process.execPath,worker:'/unused'});
  assert.deepEqual(recovered.cancelSources({accountId:'a',chatId:'c',messageId:'two'}),[live]);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('worker never executes a queued cancellation and suppresses a late completed result',async()=>{
 const {runWorker}=await import('./worker.mjs');
 const {mkdirSync,writeFileSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'codex-source-worker-'));
 const jobs=createJobs({root,node:process.execPath,worker:'/unused'});
 const make=()=>{const id=randomUUID();mkdirSync(join(root,'active'));const job={jobId:id,status:'queued',heartbeatAt:Date.now(),provenance:{accountId:'a',chatId:'c',sourceMessageIds:['m']}};writeJson(join(root,id+'.json'),job);writeJson(join(root,'active','owner.json'),job);return id;};
 try {
  const id=make();jobs.cancelSources({accountId:'a',chatId:'c',messageId:'m'});
  let calls=0;
  const cancelled=await runWorker({root,id,params:{},scope:'s',execute:async()=>{calls++;}});
  assert.equal(calls,0);assert.equal(cancelled.status,'cancelled');assert.ok(!existsSync(join(root,'active')));
  const second=make();
  const late=await runWorker({root,id:second,params:{},scope:'s',execute:async(_params,context)=>{
   assert.equal(context.reportDirectory,'.tmp/codex-query/'+second);
   writeFileSync(join(root,second+'.cancel'),'cancel');return {text:'obsolete result'};
  }});
  assert.equal(late.status,'cancelled');assert.equal(late.taskReport.status,'cancelled');assert.ok(!late.taskReport.resultContent.includes('obsolete result'));
  const third=make();
  const running=await runWorker({root,id:third,params:{},scope:'s',pollMs:5,execute:async(_params,context)=>{
   jobs.cancelSources({accountId:'a',chatId:'c',messageId:'m'});
   await new Promise(resolve=>context.signal.addEventListener('abort',resolve,{once:true}));
   context.signal.throwIfAborted();
  }});
  assert.equal(running.status,'cancelled');
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('continuation holds the new human card while retaining original task ownership',()=>{
 const lease={taskId:'answer-turn',revision:0,accountId:'a',chatId:'c',sessionKey:'s',senderId:'u',sourceMessageIds:['answer'],signal:new AbortController().signal};
 sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);
 try {
  const provenance={...taskProvenance(lease),taskId:'original'};const job={jobId:'job',notification:{state:'pending'},provenance};
  assert.equal(rememberAsyncContinuation(lease,{...job,provenance:{...provenance,senderId:'other'}},'q'),false);
  assert.equal(rememberAsyncContinuation(lease,job,'q'),true);rememberAsyncContinuation(lease,job,'q');
  assert.equal(lease.asyncDispatchAccepted,true);assert.equal(lease.asyncJobIds,undefined);
  assert.deepEqual(lease.asyncContinuations,[{jobId:'job',questionId:'q',provenance}]);assert.equal(lease.taskId,'answer-turn');
 } finally {sourceTaskBridge.leases.clear();}
});


test('await-user marks the active Main turn as waiting and reply clears that state',()=>{
 const lease={taskId:'waiting-turn',revision:0,accountId:'a',chatId:'c',sessionKey:'s',senderId:'u',sourceMessageIds:['m'],signal:new AbortController().signal};
 sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);
 try{
  const job={jobId:'job',status:'awaiting_user',notification:{state:'pending'},provenance:{...taskProvenance(lease),taskId:'original'}};
  assert.equal(rememberUserQuestion(lease,{...job,status:'running'},'q'),false);
  assert.equal(rememberUserQuestion(lease,{...job,provenance:{...job.provenance,senderId:'other'}},'q'),false);
  assert.equal(rememberUserQuestion(lease,job,'q'),true);rememberUserQuestion(lease,job,'q');
  assert.deepEqual(lease.asyncUserQuestions,[{jobId:'job',questionId:'q'}]);assert.equal(lease.asyncDispatchAccepted,undefined);
  assert.equal(rememberAsyncContinuation(lease,job,'q'),true);assert.deepEqual(lease.asyncUserQuestions,[]);
  assert.equal(taskProvenance(lease).asyncUserQuestions,undefined);
 }finally{sourceTaskBridge.leases.clear();}
});

test('provenance freezes original requester and native mention profiles for background jobs',()=>{
 const lease={taskId:'people-task',revision:0,accountId:'a',chatId:'c',sessionKey:'people-session',senderId:'ou_requester',sourceMessageIds:['m'],signal:new AbortController().signal,people:{requester:{openId:'ou_requester',giteaUsername:'reporter'},mentions:[{openId:'ou_dev',giteaUsername:'developer'}]}};
 const key=JSON.stringify(['a','people-session']);sourceTaskBridge.leases.set(key,lease);
 try{const source=taskProvenance(lease);lease.people.requester.giteaUsername='later-edit';assert.equal(source.people.requester.giteaUsername,'reporter');assert.equal(source.people.mentions[0].giteaUsername,'developer');assert.equal(source.senderId,'ou_requester');}
 finally{sourceTaskBridge.leases.delete(key);}
});
test('background provenance preserves authenticated conversation type without changing legacy sources',()=>{
 const lease={taskId:'private-task',revision:0,accountId:'a',chatId:'c',sessionKey:'private-session',senderId:'ou_requester',sourceMessageIds:['m'],signal:new AbortController().signal};
 const key=JSON.stringify(['a',lease.sessionKey]);sourceTaskBridge.leases.set(key,lease);
 try{
  assert.equal(Object.hasOwn(taskProvenance(lease),'chatType'),false);
  for(const chatType of ['p2p','private','group','topic_group']){lease.chatType=chatType;assert.equal(taskProvenance(lease).chatType,chatType);}
  lease.chatType='unexpected';assert.equal(Object.hasOwn(taskProvenance(lease),'chatType'),false);
 }finally{sourceTaskBridge.leases.delete(key);}
});
test('durable asynchronous acceptance after withdrawal prevents replay without acquiring stale card ownership',()=>{
 const controller=new AbortController();
 const lease={taskId:'task',revision:0,accountId:'a',chatId:'c',sessionKey:'s',senderId:'u',sourceMessageIds:['m'],signal:controller.signal};
 sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);
 try{
  const provenance=taskProvenance(lease);controller.abort();
  assert.throws(()=>rememberAsyncJob(lease,{jobId:'accepted',notification:{state:'pending'},provenance}));
  assert.equal(lease.asyncDispatchAccepted,true);assert.equal(lease.asyncJobIds,undefined);
 }finally{sourceTaskBridge.leases.clear();}
});
test('durable asynchronous continuation after withdrawal prevents replay without binding a stale continuation card',()=>{
 const controller=new AbortController();
 const lease={taskId:'answer-turn',revision:0,accountId:'a',chatId:'c',sessionKey:'s',senderId:'u',sourceMessageIds:['answer'],signal:controller.signal};
 sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);
 try{
  const provenance={...taskProvenance(lease),taskId:'original'};controller.abort();
  assert.throws(()=>rememberAsyncContinuation(lease,{jobId:'resumed',notification:{state:'pending'},provenance},'q'));
  assert.equal(lease.asyncDispatchAccepted,true);assert.equal(lease.asyncContinuations,undefined);
 }finally{sourceTaskBridge.leases.clear();}
});
