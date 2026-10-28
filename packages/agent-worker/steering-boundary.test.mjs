import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createJobs,readJson,writeJson,requestKeyFor} from './jobs.mjs';
import {runWorker} from './worker.mjs';
function fixture(options={}){
 const state=mkdtempSync(join(tmpdir(),'steer-boundary-')),root=join(state,'jobs'),id=randomUUID(),scope='agent:main:feishu:group',session=randomUUID();mkdirSync(root);mkdirSync(join(root,'active'));
 const p={taskId:'original',revision:0,accountId:'a',chatId:'chat',chatType:'group',senderId:'alice',sessionKey:scope,sourceMessageIds:['request'],requestMessageIds:['request']};
 const params={topic:'topic',task:'inspect',context:'fixture',constraints:'read only'},runtime={cwd:state,state,skillsEnabled:false};
 const initial={jobId:id,provenance:p,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,p),topic:params.topic,status:'running',heartbeatAt:Date.now(),createdAt:Date.now(),schedulerVersion:1,questions:[],timeoutMs:60000,resumeSessionId:session,executionRounds:[{startedAt:100,finishedAt:200,resumed:false}]};
 writeJson(join(root,id+'.json'),initial);writeJson(join(root,id+'.request.json'),{scope,params,runtime});
 const jobs=createJobs({root,node:process.execPath,worker:'unused',...options});
 const read=jobId=>readJson(join(root,(jobId??id)+'.json')),save=value=>writeJson(join(root,value.jobId+'.json'),value);
 const records=()=>readdirSync(join(root,'supplements')).filter(name=>name.endsWith('.json')).map(name=>readJson(join(root,'supplements',name)));
 async function steer(jobId=id,answer=randomUUID()){
  const source={...p,taskId:randomUUID(),sourceMessageIds:[randomUUID()]},input=await jobs.prepareSteering(jobId,scope,answer,{senderId:'alice',accountId:'a'},source,()=>true);await jobs.enqueueSteering(jobId,scope,input,()=>true);return input.questionId;
 }
 const dispatch=jobId=>jobs.processSupplements(jobId??id,scope,()=>true,async()=>{});
 return {state,root,id,scope,session,params,runtime,jobs,read,save,records,steer,dispatch,close:()=>rmSync(state,{recursive:true,force:true})};
}
test('sibling steering waits for its predecessor and carries its execution budget',async()=>{
 const f=fixture();try{
  const one=await f.steer(),two=await f.steer();f.save({...f.read(),status:'completed'});await f.dispatch();
  assert.equal(f.read(one).status,'queued');assert.equal(f.records().find(record=>record.supplementId===two).status,'accepted');
  const r1={startedAt:300,finishedAt:500,resumed:true};f.save({...f.read(one),status:'completed',executionRounds:[...f.read(one).executionRounds,r1]});await f.dispatch();
  assert.deepEqual(f.read(two).executionRounds,[...f.read().executionRounds,r1]);assert.equal(f.read(two).resumeSessionId,f.session);
 }finally{f.close();}
});
test('nested steering and later root steering share one cumulative family budget and source history',async()=>{
 const f=fixture();try{
  const one=await f.steer();f.save({...f.read(),status:'completed'});await f.dispatch();f.save({...f.read(one),status:'running',heartbeatAt:Date.now()});
  const nested=await f.steer(one),rootLater=await f.steer();await f.dispatch();assert.equal(f.records().find(record=>record.supplementId===rootLater).status,'accepted');
  const r1={startedAt:300,finishedAt:500,resumed:true};f.save({...f.read(one),status:'completed',executionRounds:[...f.read(one).executionRounds,r1]});await f.dispatch(one);
  assert.equal(f.read(nested).status,'queued');await f.dispatch();assert.equal(f.records().find(record=>record.supplementId===rootLater).status,'accepted');
  const r2={startedAt:600,finishedAt:900,resumed:true};f.save({...f.read(nested),status:'completed',executionRounds:[...f.read(nested).executionRounds,r2]});await f.dispatch();
  assert.deepEqual(f.read(rootLater).executionRounds,[...f.read().executionRounds,r1,r2]);assert.equal(f.read(rootLater).provenance.attachmentSources.length,3);
 }finally{f.close();}
});
for(const status of ['failed','timed_out','cancelled'])test('later steering never executes after a family member becomes '+status,async()=>{
 const f=fixture();try{
  const one=await f.steer(),two=await f.steer();f.save({...f.read(),status:'completed'});await f.dispatch();f.save({...f.read(one),status});await f.dispatch();
  const next=f.records().find(record=>record.supplementId===two);assert.equal(next.status,status==='cancelled'?'suppressed':'blocked');assert.equal(next.childJobId,undefined);
 }finally{f.close();}
});
test('a real child decision wait prevents later root guidance from bypassing the question',async()=>{
 const f=fixture();try{
  const one=await f.steer(),two=await f.steer();f.save({...f.read(),status:'completed'});await f.dispatch();
  const req=readJson(join(f.root,one+'.request.json'));
  await runWorker({root:f.root,id:one,params:req.resumeParams,scope:f.scope,runtime:req.runtime,execute:async()=>({content:[{type:'text',text:JSON.stringify({sessionId:f.session,contextRequest:{question:'Confirm?',reason:'decision',progress:'ready',waitKind:'decision'}})}]})});
  assert.equal(f.read(one).status,'awaiting_main');await f.dispatch();assert.equal(f.records().find(record=>record.supplementId===two).status,'accepted');
  assert.equal(f.read(one).contextRequest.waitKind,'decision');
 }finally{f.close();}
});
test('workspace settlement retains an accepted steering assignment until its child is admitted',async()=>{
 let settled=0;const f=fixture({settleWorkspace:async()=>{settled++;return {status:'idle'};}});try{
  const assignment={assignmentId:randomUUID(),id:'slot',owner:f.id,path:'/unused/isolated/slot'},runtime={...f.runtime,workspace:assignment,workspacePool:{},projectContext:{projectId:'test',repository:'projects/test'}};
  f.save({...f.read(),useWorkspace:true,workspace:assignment});writeJson(join(f.root,f.id+'.request.json'),{params:f.params,scope:f.scope,runtime});
  const input=await f.steer();f.save({...f.read(),status:'completed'});f.jobs.tick();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(settled,0);
  await f.dispatch();assert.equal(f.read(input).workspace.assignmentId,assignment.assignmentId);f.jobs.tick();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(settled,0);
 }finally{f.close();}
});
test('ordinary late-answer descendants of steering also retain the family budget and cannot be bypassed',async()=>{
 const f=fixture();try{
  const one=await f.steer();f.save({...f.read(),status:'completed'});await f.dispatch();
  const q={questionId:randomUUID(),question:'late detail?',waitKind:'required',createdAt:Date.now()-1000,expiresAt:Date.now()+60000,answer:'unknown',resumeReason:'user_wait_timeout'},r1={startedAt:300,finishedAt:500,resumed:true};
  f.save({...f.read(one),status:'completed',questions:[...f.read(one).questions,q],executionRounds:[...f.read(one).executionRounds,r1]});
  const late=await f.jobs.openSupplement(one,f.scope,q.questionId,()=>true);await f.jobs.submitSupplement(one,f.scope,late.supplementId,'late answer',{answerSource:'user_text'},()=>true);await f.dispatch(one);
  const ordinary=f.read(late.supplementId);assert.equal(ordinary.continuationKind,'late_answer');assert.deepEqual(ordinary.executionRounds,[...f.read().executionRounds,r1]);
  const next=await f.steer();await f.dispatch();assert.equal(f.records().find(record=>record.supplementId===next).status,'accepted');
  const decision={questionId:randomUUID(),question:'confirm',waitKind:'decision',expiresAt:Date.now()+60000};f.save({...ordinary,status:'awaiting_main',contextRequest:decision,questions:[...ordinary.questions,decision]});await f.dispatch();assert.equal(f.records().find(record=>record.supplementId===next).status,'accepted');
  const r2={startedAt:600,finishedAt:800,resumed:true};f.save({...f.read(late.supplementId),status:'completed',contextRequest:undefined,executionRounds:[...ordinary.executionRounds,r2]});await f.dispatch();assert.deepEqual(f.read(next).executionRounds,[...f.read().executionRounds,r1,r2]);
 }finally{f.close();}
});
test('a failed ordinary late-answer descendant blocks later steering in the same workflow',async()=>{
 const f=fixture();try{
  const one=await f.steer();f.save({...f.read(),status:'completed'});await f.dispatch();f.save({...f.read(one),status:'completed'});
  const lateId=randomUUID(),child=f.read(one);f.save({...child,jobId:lateId,parentJobId:one,supplementId:lateId,continuationKind:'late_answer',status:'failed'});
  const next=await f.steer();await f.dispatch();assert.equal(f.records().find(record=>record.supplementId===next).status,'blocked');
 }finally{f.close();}
});
test('workspace admission grace protects a fresh draft but releases a crashed unqueued draft',async()=>{
 let settled=0;const f=fixture({settleWorkspace:async()=>{settled++;return {status:'idle'};}});try{
  const assignment={assignmentId:randomUUID(),id:'slot',owner:f.id,path:'/unused/isolated/slot'},runtime={...f.runtime,workspace:assignment,workspacePool:{},projectContext:{projectId:'test',repository:'projects/test'}};
  f.save({...f.read(),useWorkspace:true,workspace:assignment});writeJson(join(f.root,f.id+'.request.json'),{params:f.params,scope:f.scope,runtime});
  const p=f.read().provenance,input=await f.jobs.prepareSteering(f.id,f.scope,'draft only',{senderId:'alice',accountId:'a'},{...p,taskId:'draft',sourceMessageIds:['draft']},()=>true);
  f.save({...f.read(),status:'completed'});f.jobs.tick();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(settled,0);
  const stored=f.read();stored.steeringInputs[0].createdAt=Date.now()-60001;f.save(stored);f.jobs.tick();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(settled,1);assert.equal(f.read().workspaceSettled,true);
 }finally{f.close();}
});

test('accepted guidance holds independent same-session work until dispatch or terminal cleanup, without blocking other sessions',async()=>{
 const f=fixture();try{
  const input=await f.steer();f.save({...f.read(),status:'completed'});
  const worker=join(f.state,'fake-worker.mjs');writeFileSync(worker,`import {readFileSync,writeFileSync} from 'node:fs';const[root,id]=process.argv.slice(2);for await(const chunk of process.stdin){};const file=root+'/'+id+'.json',job=JSON.parse(readFileSync(file));job.status='completed';job.finishedAt=Date.now();writeFileSync(file,JSON.stringify(job));writeFileSync(root+'/'+id+'.ran','yes');`);
  const jobs=createJobs({root:f.root,node:process.execPath,worker}),p=f.read().provenance;
  const same=await jobs.run({...f.params,task:'independent later',requestId:'same',waitSeconds:0},f.scope,p),different=await jobs.run({...f.params,topic:'another-session',task:'independent other',requestId:'different',waitSeconds:0},f.scope,p);
  rmSync(join(f.root,'active'),{recursive:true});jobs.tick();
  for(let n=0;n<100&&!existsSync(join(f.root,different.jobId+'.ran'));n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(existsSync(join(f.root,different.jobId+'.ran')),true);assert.equal(existsSync(join(f.root,same.jobId+'.ran')),false);assert.equal(f.read(same.jobId).status,'queued');
  const record=f.records().find(value=>value.supplementId===input);writeJson(join(f.root,'supplements',input+'.json'),{...record,status:'suppressed',reason:'source_invalid'});jobs.tick();
  for(let n=0;n<100&&!existsSync(join(f.root,same.jobId+'.ran'));n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(existsSync(join(f.root,same.jobId+'.ran')),true);
 }finally{f.close();}
});
test('an unapproved contributor draft does not reserve the workspace',async()=>{
 let settled=0;const f=fixture({settleWorkspace:async()=>{settled++;return {status:'idle'};}});try{
  const assignment={assignmentId:randomUUID(),id:'slot',owner:f.id,path:'/unused/isolated/slot'},runtime={...f.runtime,workspace:assignment,workspacePool:{},projectContext:{projectId:'test',repository:'projects/test'}};
  f.save({...f.read(),useWorkspace:true,workspace:assignment});writeJson(join(f.root,f.id+'.request.json'),{params:f.params,scope:f.scope,runtime});
  const source={...f.read().provenance,taskId:'bob-draft',senderId:'bob',kind:'group_context',sourceMessageIds:['bob-draft']},actor={senderId:'bob',accountId:'a'},input=await f.jobs.prepareSteering(f.id,f.scope,'B pending',actor,source,()=>true);
  const permission=await f.jobs.requestContributor(f.id,f.scope,input.questionId,input.answer,actor,source,()=>true);assert.equal(permission.approved,false);
  f.save({...f.read(),status:'completed'});f.jobs.tick();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(settled,1);assert.equal(f.read().workspaceSettled,true);
 }finally{f.close();}
});
test('family FIFO follows global admission even when child is scanned before parent in the same millisecond',async t=>{
 const f=fixture();try{
  const first=await f.steer();f.save({...f.read(),status:'completed'});await f.dispatch();f.save({...f.read(first),status:'running',heartbeatAt:Date.now()});
  const frozen=Date.now();t.mock.method(Date,'now',()=>frozen);
  const older=await f.steer(f.id,'older root hint'),newer=await f.steer(first,'newer child hint');
  const oldRecord=f.records().find(record=>record.supplementId===older),newRecord=f.records().find(record=>record.supplementId===newer);assert.equal(oldRecord.acceptedAt,newRecord.acceptedAt);assert.ok(oldRecord.admissionSequence<newRecord.admissionSequence);
  await f.jobs.enqueueSteering(f.id,f.scope,f.read().steeringInputs.find(input=>input.questionId===older),()=>true);assert.equal(f.records().find(record=>record.supplementId===older).admissionSequence,oldRecord.admissionSequence);
  f.save({...f.read(first),status:'completed'});await f.dispatch(first);assert.equal(f.records().find(record=>record.supplementId===newer).status,'accepted');
  await f.dispatch();assert.equal(f.records().find(record=>record.supplementId===older).status,'dispatched');assert.equal(f.records().find(record=>record.supplementId===newer).status,'accepted');
  f.save({...f.read(older),status:'completed'});await f.dispatch(first);assert.equal(f.records().find(record=>record.supplementId===newer).status,'dispatched');
 }finally{f.close();}
});
test('an earlier unapproved family draft does not block a later accepted guide',async()=>{
 const f=fixture();try{
  const first=await f.steer();f.save({...f.read(),status:'completed'});await f.dispatch();f.save({...f.read(first),status:'running',heartbeatAt:Date.now()});
  const source={...f.read().provenance,taskId:'pending-B',senderId:'bob',kind:'group_context',sourceMessageIds:['pending-B']},actor={senderId:'bob',accountId:'a'},draft=await f.jobs.prepareSteering(f.id,f.scope,'not yet approved',actor,source,()=>true);
  const permission=await f.jobs.requestContributor(f.id,f.scope,draft.questionId,draft.answer,actor,source,()=>true);assert.equal(permission.approved,false);
  const accepted=await f.steer(first,'approved owner guide');f.save({...f.read(first),status:'completed'});await f.dispatch(first);assert.equal(f.records().find(record=>record.supplementId===accepted).status,'dispatched');assert.equal(f.records().some(record=>record.supplementId===draft.questionId),false);
 }finally{f.close();}
});
async function acceptOrdinaryLateAnswer(f){
 const q={questionId:randomUUID(),question:'late detail?',waitKind:'required',createdAt:Date.now()-1000,expiresAt:Date.now()+60000,answer:'unknown',resumeReason:'user_wait_timeout'};
 f.save({...f.read(),status:'completed',questions:[q]});const late=await f.jobs.openSupplement(f.id,f.scope,q.questionId,()=>true);await f.jobs.submitSupplement(f.id,f.scope,late.supplementId,'ordinary late answer',{answerSource:'user_text'},()=>true);return late.supplementId;
}
test('accepted guidance activates the family budget before the first steering child is created',async()=>{
 const f=fixture();try{
  const late=await acceptOrdinaryLateAnswer(f);await new Promise(resolve=>setTimeout(resolve,2));const guide=await f.steer();await f.dispatch();
  assert.deepEqual(f.read(late).executionRounds,f.read().executionRounds);assert.equal(f.read(late).continuationKind,'late_answer');assert.equal(f.records().find(record=>record.supplementId===guide).status,'accepted');
 }finally{f.close();}
});
for(const state of ['blocked','suppressed','unapproved'])test('an unexecuted '+state+' guide does not activate the ordinary late-answer family',async()=>{
 const f=fixture();try{
  const late=await acceptOrdinaryLateAnswer(f);
  if(state==='unapproved'){
   const source={...f.read().provenance,taskId:'pending-B',senderId:'bob',kind:'group_context',sourceMessageIds:['pending-B']},actor={senderId:'bob',accountId:'a'},input=await f.jobs.prepareSteering(f.id,f.scope,'B draft',actor,source,()=>true);await f.jobs.requestContributor(f.id,f.scope,input.questionId,input.answer,actor,source,()=>true);
  }else{
   const guide=await f.steer(),record=f.records().find(value=>value.supplementId===guide);writeJson(join(f.root,'supplements',guide+'.json'),{...record,status:state,reason:'original_session_missing'});
  }
  await f.dispatch();assert.equal(f.read(late).continuationKind,undefined);assert.equal(f.read(late).executionRounds,undefined);
 }finally{f.close();}
});
test('a guided late-answer marker retains cumulative policy after its initiating guide is suppressed',async()=>{
 const f=fixture();try{
  const firstLate=await acceptOrdinaryLateAnswer(f);await new Promise(resolve=>setTimeout(resolve,2));const guide=await f.steer();await f.dispatch();assert.equal(f.read(firstLate).continuationKind,'late_answer');
  const guideFile=join(f.root,'supplements',guide+'.json');writeJson(guideFile,{...readJson(guideFile),status:'suppressed',reason:'source_invalid'});
  const r1={startedAt:300,finishedAt:500,resumed:true},q={questionId:randomUUID(),question:'more late detail?',waitKind:'required',createdAt:Date.now()-1000,expiresAt:Date.now()+60000,answer:'unknown',resumeReason:'user_wait_timeout'};
  f.save({...f.read(firstLate),status:'completed',executionRounds:[...f.read(firstLate).executionRounds,r1],questions:[...f.read(firstLate).questions,q]});
  const next=await f.jobs.openSupplement(firstLate,f.scope,q.questionId,()=>true);await f.jobs.submitSupplement(firstLate,f.scope,next.supplementId,'next late answer',{answerSource:'user_text'},()=>true);await f.dispatch(firstLate);
  assert.equal(f.read(next.supplementId).continuationKind,'late_answer');assert.deepEqual(f.read(next.supplementId).executionRounds,[...f.read().executionRounds,r1]);
 }finally{f.close();}
});
