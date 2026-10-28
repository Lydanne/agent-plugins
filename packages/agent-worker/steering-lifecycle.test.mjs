import {tryLock as poolLock} from './dist/workspace-lock.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createJobs,writeJson,readJson,requestKeyFor} from './jobs.mjs';
import {runWorker} from './worker.mjs';
import {tryLock} from './locks.mjs';
function fixture(){
 const state=mkdtempSync(join(tmpdir(),'steering-lifecycle-')),root=join(state,'jobs'),id=randomUUID(),scope='agent:main:feishu:chat',sessionId=randomUUID();mkdirSync(root);mkdirSync(join(root,'active'));
 const provenance={taskId:'original',revision:0,accountId:'a',chatId:'chat',chatType:'group',sessionKey:scope,senderId:'alice',sourceMessageIds:['original'],requestMessageIds:['original']},actor={senderId:'alice',accountId:'a'};
 const params={topic:'same',task:'inspect',context:'fixture',constraints:'read only'},runtime={state,cwd:state,skillsEnabled:false};
 const job={jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,provenance),provenance,status:'running',heartbeatAt:Date.now(),questions:[],schedulerVersion:1,topic:'same',resumeSessionId:sessionId};
 writeJson(join(root,id+'.json'),job);writeJson(join(root,id+'.request.json'),{params,scope,runtime});
 const jobs=createJobs({root,node:process.execPath,worker:'unused'}),result={content:[{type:'text',text:JSON.stringify({sessionId,result:'finished original work'})}]};
 const input=()=>jobs.prepareSteering(id,scope,'later clue',actor,{...provenance,taskId:'steering',sourceMessageIds:['steering']},()=>true);
 return {state,root,id,scope,sessionId,actor,params,runtime,job,jobs,result,input,close:()=>rmSync(state,{recursive:true,force:true})};
}
test('a cancellation during terminal report bookkeeping cannot be overwritten by completed',async()=>{
 const f=fixture();try{
  const input=await f.input();await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);let cancellation;
  await runWorker({root:f.root,id:f.id,params:f.params,scope:f.scope,runtime:f.runtime,execute:async()=>{
   // runWorker sees a successful result, then awaits terminal report bookkeeping.
   queueMicrotask(()=>queueMicrotask(()=>{cancellation=f.jobs.cancel(f.id,f.scope,f.actor);}));return f.result;
  }});
  assert.equal(cancellation.status,'cancelling');const final=f.jobs.status(f.id,f.scope);assert.equal(final.status,'cancelled');assert.equal(final.taskReport.status,'cancelled');
  await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});const stored=readJson(join(f.root,'supplements',input.questionId+'.json'));assert.equal(stored.status,'suppressed');assert.equal(stored.childJobId,undefined);
 }finally{f.close();}
});
test('cancellation while startup waits for the metadata lock prevents executor launch',async()=>{
 const f=fixture();let release;try{
  release=tryLock(join(f.root,'scheduler-lock'));assert.ok(release);let calls=0;
  const worker=runWorker({root:f.root,id:f.id,params:f.params,scope:f.scope,runtime:f.runtime,execute:async()=>{calls++;return f.result;}});
  assert.equal(f.jobs.cancel(f.id,f.scope,f.actor).status,'cancelling');release();release=undefined;await worker;
  assert.equal(calls,0);assert.equal(f.jobs.status(f.id,f.scope).status,'cancelled');
 }finally{release?.();f.close();}
});
test('root cancellation traverses completed steering nodes and later ordinary descendants',async()=>{
 const f=fixture();try{
  const input=await f.input(),child=randomUUID(),grandchild=randomUUID();
  writeJson(join(f.root,f.id+'.json'),{...f.job,status:'completed',steeringInputs:[input]});
  writeJson(join(f.root,child+'.json'),{...f.job,jobId:child,parentJobId:f.id,continuationKind:'steering',status:'completed'});
  // A subsequent late answer can create an ordinary continuation under the guidance child.
  writeJson(join(f.root,grandchild+'.json'),{...f.job,jobId:grandchild,parentJobId:child,status:'running'});
  const result=f.jobs.cancel(f.id,f.scope,f.actor);assert.deepEqual(result.guidanceCancellationRequested,[grandchild]);assert.ok(existsSync(join(f.root,grandchild+'.cancel')));assert.ok(existsSync(join(f.root,child+'.cancel')));assert.equal(f.jobs.status(f.id,f.scope).status,'completed');
 }finally{f.close();}
});

test('heartbeat does not expose a pending question before workspace handoff finishes',async()=>{
 const f=fixture();let release,worker,entered;const ready=new Promise(r=>entered=r);
 try{
  mkdirSync(join(f.state,'workspace'));const workspace=realpathSync(join(f.state,'workspace'));const slot={id:'slot',assignmentId:'assignment',owner:'owner',path:join(workspace,'slot'),status:'ready',repositories:[]};mkdirSync(slot.path);
  writeJson(join(workspace,'state.json'),{version:1,revision:0,workspaces:{slot}});
  const runtime={...f.runtime,workspace:slot,workspacePool:{root:realpathSync(f.state)}};
  worker=runWorker({root:f.root,id:f.id,params:f.params,scope:f.scope,runtime,pollMs:5,execute:async()=>{
   release=poolLock(join(workspace,'state.lock'));assert.ok(release);entered();return {content:[{type:'text',text:JSON.stringify({sessionId:f.sessionId,contextRequest:{question:'missing date',reason:'needed',progress:'checked',waitKind:'required'}})}]};
  }});
  await Promise.race([ready,worker.then(()=>{throw Error('Worker stopped before execution');})]);await new Promise(r=>setTimeout(r,35));const waiting=readJson(join(f.root,f.id+'.json'));assert.equal(waiting.status,'running');assert.equal(waiting.contextRequest,undefined);
  release();release=undefined;await worker;assert.equal(f.jobs.status(f.id,f.scope).status,'awaiting_main');
 }finally{release?.();await worker;f.close();}
});

test('root cancellation discovers steering behind an ordinary late-answer bridge without touching unrelated tasks',()=>{
 const f=fixture();try{
  const bridge=randomUUID(),guide=randomUUID(),unrelated=randomUUID(),foreign=randomUUID();
  // No root steeringInputs: all human steering targeted a later ordinary child.
  writeJson(join(f.root,f.id+'.json'),{...f.job,status:'completed'});
  writeJson(join(f.root,bridge+'.json'),{...f.job,jobId:bridge,parentJobId:f.id,supplementId:bridge,status:'completed'});
  writeJson(join(f.root,guide+'.json'),{...f.job,jobId:guide,parentJobId:bridge,supplementId:guide,continuationKind:'steering',status:'running'});
  writeJson(join(f.root,unrelated+'.json'),{...f.job,jobId:unrelated,topic:'new-independent-run',status:'running'});
  // Even a malformed parent link cannot cancel a different original request.
  writeJson(join(f.root,foreign+'.json'),{...f.job,jobId:foreign,parentJobId:f.id,supplementId:foreign,continuationKind:'steering',provenance:{...f.job.provenance,taskId:'different-original'},status:'running'});
  const result=f.jobs.cancel(f.id,f.scope,f.actor);assert.deepEqual(result.guidanceCancellationRequested,[guide]);assert.ok(existsSync(join(f.root,guide+'.cancel')));assert.ok(existsSync(join(f.root,bridge+'.cancel')));assert.ok(existsSync(join(f.root,f.id+'.cancel')));assert.equal(existsSync(join(f.root,unrelated+'.cancel')),false);assert.equal(existsSync(join(f.root,foreign+'.cancel')),false);
 }finally{f.close();}
});

for(const guided of [true,false])test('root cancellation '+(guided?'includes':'does not broaden to')+' a pre-first-steering ordinary continuation',async()=>{
 const f=fixture();try{
  const q={questionId:randomUUID(),question:'late detail?',waitKind:'required',createdAt:Date.now()-1000,expiresAt:Date.now()+60000,answer:'unknown',resumeReason:'user_wait_timeout'};
  writeJson(join(f.root,f.id+'.json'),{...f.job,status:'completed',questions:[q],executionRounds:[{startedAt:100,finishedAt:200}]});
  const late=await f.jobs.openSupplement(f.id,f.scope,q.questionId,()=>true);await f.jobs.submitSupplement(f.id,f.scope,late.supplementId,'late answer',{answerSource:'user_text'},()=>true);
  if(guided){await new Promise(r=>setTimeout(r,2));const input=await f.input();await f.jobs.enqueueSteering(f.id,f.scope,input,()=>true);}
  await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});
  const child=readJson(join(f.root,late.supplementId+'.json'));assert.equal(child.continuationKind,guided?'late_answer':undefined);assert.equal(child.status,'queued');
  const result=f.jobs.cancel(f.id,f.scope,f.actor);assert.deepEqual(result.guidanceCancellationRequested,guided?[child.jobId]:undefined);assert.equal(existsSync(join(f.root,child.jobId+'.cancel')),guided);
 }finally{f.close();}
});
