import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import plugin,{query} from './index.mjs';
import {createJobs,writeJson,readJson,requestKeyFor} from './jobs.mjs';
import {runWorker} from './worker.mjs';
import {sourceTaskBridge} from './source-tasks.mjs';
import {completionBridge} from './completion.mjs';
import {registerQuestionBridge} from './question-bridge.mjs';
function fixture(){
 const state=mkdtempSync(join(tmpdir(),'worker-steering-')),root=join(state,'jobs'),scope='agent:main:feishu:chat',id=randomUUID(),sessionId=randomUUID();mkdirSync(root);mkdirSync(join(root,'active'));
 const p={taskId:'original',revision:0,accountId:'a',chatId:'chat',chatType:'group',sessionKey:scope,senderId:'alice',sourceMessageIds:['original'],requestMessageIds:['original']};
 const params={topic:'same-task',task:'inspect',context:'fixture',constraints:'read only'},job={jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,p),provenance:p,status:'running',topic:params.topic,heartbeatAt:Date.now(),createdAt:Date.now(),questions:[],schedulerVersion:1,resumeSessionId:sessionId,timeoutMs:60000,resourceKeys:['record'],tags:[]};
 const runtime={state,cwd:state,skillsEnabled:false,model:'test'};
 writeJson(join(root,id+'.json'),job);writeJson(join(root,id+'.request.json'),{params,scope,runtime});
 const jobs=createJobs({root,node:process.execPath,worker:'unused'}),actor={senderId:'alice',accountId:'a'};
 const source=(senderId='alice',messageId=randomUUID())=>({...p,taskId:messageId,senderId,sourceMessageIds:[messageId],...(senderId!=='alice'?{kind:'group_context'}:{})});
 const records=()=>readdirSync(join(root,'supplements')).filter(n=>n.endsWith('.json')).map(n=>readJson(join(root,'supplements',n)));
 const save=v=>writeJson(join(root,id+'.json'),v),read=()=>readJson(join(root,id+'.json'));
 return {state,root,scope,id,p,params,runtime,jobs,job,actor,source,sessionId,records,save,read,close:()=>rmSync(state,{recursive:true,force:true})};
}
test('owner steering is durable, idempotent and waits until the current execution ends',async()=>{
 const f=fixture();try{
  const input=await f.jobs.prepareSteering(f.id,f.scope,'new evidence',f.actor,f.source(),()=>true);
  await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);
  await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});assert.equal(f.read().status,'running');assert.equal(f.records().length,1);assert.equal(f.records()[0].status,'accepted');
  f.save({...f.read(),status:'completed',executionRounds:[{startedAt:100,finishedAt:200}]});await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});
  const s=f.records()[0],child=readJson(join(f.root,s.childJobId+'.json')),request=readJson(join(f.root,s.childJobId+'.request.json'));
  assert.equal(child.resumeSessionId,f.sessionId);assert.equal(child.parentJobId,f.id);assert.equal(request.resumeParams.constraints,'read only');assert.deepEqual(child.resourceKeys,['record']);assert.deepEqual(child.executionRounds,[{startedAt:100,finishedAt:200}]);assert.match(request.resumeParams.mainReplies.at(-1).answer,/new evidence/);
  assert.equal(f.read().status,'completed');
 }finally{f.close();}
});
for(const mode of ['once','worker','always'])test('steering by B requires A approval: '+mode,async()=>{
 const f=fixture();let service;try{
  const source=f.source('bob'),actor={senderId:'bob',accountId:'a'},input=await f.jobs.prepareSteering(f.id,f.scope,'B hint',actor,source,()=>true);
  const permission=await f.jobs.requestContributor(f.id,f.scope,input.questionId,input.answer,actor,source,()=>true);assert.equal(permission.approved,false);
  await assert.rejects(f.jobs.enqueueSteering(f.id,f.scope,permission.request,()=>true),/approval/);
  registerQuestionBridge({registerService:s=>service=s},f.jobs,{authorizeReply:()=>true});await service.start();
  const bridge=globalThis[Symbol.for('ada.worker-question.v1')];const decision={jobId:f.id,requestId:permission.request.requestId,provenance:f.p,actor:f.actor,mode};
  assert.equal((await bridge.contributorDecide(decision)).queued,true);await bridge.contributorDecide(decision);assert.equal(f.records().length,1);assert.equal(f.read().status,'running');
  const nextSource=f.source('bob'),next=await f.jobs.prepareSteering(f.id,f.scope,'next hint',actor,nextSource,()=>true),p=await f.jobs.requestContributor(f.id,f.scope,next.questionId,next.answer,actor,nextSource,()=>true);assert.equal(p.approved,mode!=='once');
 }finally{service?.stop();f.close();}
});
for(const kind of ['decision','authorization','plugin'])test('steering never consumes a pending '+kind,async()=>{
 const f=fixture();try{
  const q={questionId:randomUUID(),question:'confirm',waitKind:kind==='plugin'?'required':kind,...(kind==='plugin'?{requestKind:'plugin'}:{}),expiresAt:Date.now()+60000};f.save({...f.job,status:'awaiting_user',contextRequest:q,questions:[q]});
  const input=await f.jobs.prepareSteering(f.id,f.scope,'context only',f.actor,f.source(),()=>true);await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});
  assert.deepEqual(f.read().contextRequest,q);assert.equal(f.records()[0].status,'accepted');
 }finally{f.close();}
});
test('steering can resume an ordinary context wait at the execution boundary',async()=>{
 const f=fixture();try{
  const q={questionId:randomUUID(),question:'which trace?',waitKind:'required',expiresAt:Date.now()+60000};f.save({...f.job,status:'awaiting_user',contextRequest:q,questions:[q]});
  const input=await f.jobs.prepareSteering(f.id,f.scope,'trace clue',f.actor,f.source(),()=>true);await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});
  assert.equal(f.read().status,'queued');assert.match(f.read().questions[0].answer,/不代表用户已回答/);assert.equal(f.records()[0].childJobId,f.id);
 }finally{f.close();}
});
test('recalled steering is neither observed nor executed',async()=>{
 const f=fixture();try{
  const input=await f.jobs.prepareSteering(f.id,f.scope,'revoked',f.actor,f.source(),()=>true);await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);f.save({...f.read(),status:'completed'});
  const events=[];await f.jobs.processSupplements(f.id,f.scope,p=>!p.attachmentSources?.length,async e=>events.push(e));assert.equal(events.length,0);assert.equal(f.records()[0].status,'suppressed');
 }finally{f.close();}
});
test('live Worker heartbeat and completion preserve Main steering receipts',async()=>{
 const f=fixture();let finish,entered;const ready=new Promise(r=>entered=r);try{
  const running=runWorker({root:f.root,id:f.id,params:f.params,scope:f.scope,runtime:f.runtime,pollMs:5,execute:async()=>{entered();return new Promise(r=>finish=()=>r({content:[{type:'text',text:JSON.stringify({sessionId:f.sessionId})}]}));}});
  await ready;const input=await f.jobs.prepareSteering(f.id,f.scope,'retain me',f.actor,f.source(),()=>true);await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);
  await new Promise(r=>setTimeout(r,30));assert.equal(f.read().steeringInputs[0].answer,'retain me');finish();await running;assert.equal(f.read().steeringInputs[0].answer,'retain me');assert.equal(f.read().status,'completed');
 }finally{finish?.();f.close();}
});
test('real Main steer action needs no questionId and preserves running task',async()=>{
 const f=fixture(),key=JSON.stringify(['a',f.scope]),prior=sourceTaskBridge.leases.get(key),previous=completionBridge.authorizeReply;try{
  plugin.register({pluginConfig:f.runtime,registerService(){},registerTool(){}});completionBridge.authorizeReply=()=>true;sourceTaskBridge.leases.set(key,{...f.source(),signal:new AbortController().signal});
  const args={action:'steer',jobId:f.id,answer:'new clue'},ctx={agentId:'main',agentAccountId:'a',requesterSenderId:'alice',sessionKey:f.scope};
  const first=JSON.parse((await query(args,ctx)).content[0].text),again=JSON.parse((await query(args,ctx)).content[0].text);assert.equal(first.accepted,true);assert.equal(first.steeringId,again.steeringId);assert.equal(f.read().status,'running');assert.equal(f.read().questions.length,0);assert.equal(f.records().length,1);
 }finally{completionBridge.authorizeReply=previous;if(prior)sourceTaskBridge.leases.set(key,prior);else sourceTaskBridge.leases.delete(key);f.close();}
});
for(const status of ['cancelled','failed','timed_out','unknown'])test('steering refuses '+status+' jobs',async()=>{
 const f=fixture();try{f.save({...f.job,status});await assert.rejects(f.jobs.prepareSteering(f.id,f.scope,'hint',f.actor,f.source(),()=>true));}finally{f.close();}
});
test('steering checks scope, requester and live source, preserving the original request',async()=>{
 const f=fixture();try{
  await assert.rejects(f.jobs.prepareSteering(f.id,'other','hint',f.actor,f.source(),()=>true));
  await assert.rejects(f.jobs.prepareSteering(f.id,f.scope,'hint',{senderId:'bob',accountId:'a'},f.source(),()=>true));
  await assert.rejects(f.jobs.prepareSteering(f.id,f.scope,'hint',f.actor,f.source(),()=>false));
  await assert.rejects(f.jobs.prepareSteering(f.id,f.scope,'hint',f.actor,{...f.source(),chatId:'other'},()=>true));
  assert.equal(f.read().steeringInputs,undefined);assert.deepEqual(readJson(join(f.root,f.id+'.request.json')).params,f.params);
 }finally{f.close();}
});
test('independent new job queues in the same session while steer retains parent job',async()=>{
 const f=fixture();try{
  const next=await f.jobs.run({...f.params,task:'independent second goal',requestId:'next',waitSeconds:0},f.scope,{...f.p,taskId:'second'});
  assert.equal(next.status,'queued');assert.notEqual(next.jobId,f.id);assert.equal(next.topic,f.job.topic);
  const input=await f.jobs.prepareSteering(f.id,f.scope,'same goal evidence',f.actor,f.source(),()=>true);await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);
  assert.equal(f.read().status,'running');assert.equal(f.records()[0].jobId,f.id);
 }finally{f.close();}
});

test('cancelling the original task also cancels pending guidance continuations',async()=>{
 const f=fixture();try{
  const input=await f.jobs.prepareSteering(f.id,f.scope,'later clue',f.actor,f.source(),()=>true);await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);f.save({...f.read(),status:'completed'});await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});
  const child=f.records()[0].childJobId,result=f.jobs.cancel(f.id,f.scope,f.actor);assert.deepEqual(result.guidanceCancellationRequested,[child]);assert.equal(existsSync(join(f.root,child+'.cancel')),true);assert.equal(existsSync(join(f.root,f.id+'.cancel')),true);
  await assert.rejects(f.jobs.prepareSteering(f.id,f.scope,'another',f.actor,f.source(),()=>true));assert.equal(f.read().status,'completed');
 }finally{f.close();}
});
