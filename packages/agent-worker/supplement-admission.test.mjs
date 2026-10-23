import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createJobs,readJson,writeJson,requestKeyFor,USER_INPUT_WAIT_MS} from './jobs.mjs';
import {registerQuestionBridge} from './question-bridge.mjs';
const p={taskId:'task',revision:0,accountId:'a',chatId:'chat',sessionKey:'scope',senderId:'alice',agentId:'main',sourceMessageIds:['m'],requestMessageIds:['m']};
function fixture(status='completed'){
 const root=mkdtempSync('/tmp/supplement-admission-'),id=randomUUID(),scope='scope',params={topic:'topic',task:'read',context:'known',constraints:'read only'};
 const q={questionId:randomUUID(),question:'date?',createdAt:Date.now()-10000,expiresAt:Date.now()-1000,answer:'unknown, continue',resumeReason:'user_wait_timeout'};
 const job={jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,p),provenance:p,topic:'topic',status,questions:[q],tags:[],resourceKeys:[],schedulerVersion:1,queueSequence:1,createdAt:Date.now(),heartbeatAt:Date.now(),resumeSessionId:randomUUID()};
 mkdirSync(join(root,'active'));writeJson(join(root,id+'.json'),job);writeJson(join(root,id+'.request.json'),{params,scope,runtime:{state:root,cwd:root}});
 const jobs=createJobs({root,node:process.execPath,worker:'unused'});
 return {root,id,scope,params,q,job,jobs,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('late admission reads only trusted saved content and retries after expiry without a new job',async()=>{
 const f=fixture();let service;const bridge=globalThis[Symbol.for('ada.worker-question.v1')]??={};
 const saved={answerText:'2026-10-23',answerSource:'user_card',userSubmittedAt:Date.now()-5000};
 bridge.submission=()=>saved;
 registerQuestionBridge({registerService:s=>{service=s;}},f.jobs,{authorizeReply:()=>true});await service.start();
 try{
  const args={jobId:f.id,questionId:f.q.questionId,provenance:p,answer:'malicious replacement',userSubmittedAt:Date.now()};
  assert.equal(bridge.read(args).question.questionId,f.q.questionId);
  const s=await bridge.acceptSubmission(args);assert.equal(s.answer,saved.answerText);assert.equal(s.userSubmittedAt,saved.userSubmittedAt);
  assert.equal((await bridge.acceptSubmission(args)).supplementId,s.supplementId);
  assert.equal(existsSync(join(f.root,s.supplementId+'.json')),false);
  await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});
  assert.equal(readJson(join(f.root,s.supplementId+'.request.json')).resumeParams.mainReplies.at(-1).answer.endsWith(saved.answerText),true);
  await assert.rejects(bridge.acceptSubmission({...args,provenance:{...p,revision:1}}),/source/);
 }finally{service.stop();delete bridge.submission;f.close();}
});
for(const time of ['missing','after_expiry','before_creation','future'])test('rejects untrusted or out-of-window recovery receipt: '+time,async()=>{
 const f=fixture();let service;const bridge=globalThis[Symbol.for('ada.worker-question.v1')]??={};
 const at=time==='missing'?undefined:time==='after_expiry'?Date.now()-500:time==='before_creation'?f.q.createdAt-1:Date.now()+10000;
 bridge.submission=()=>({answerText:'date',answerSource:'user_text',userSubmittedAt:at});
 registerQuestionBridge({registerService:s=>{service=s;}},f.jobs,{authorizeReply:()=>true});await service.start();
 try{await assert.rejects(bridge.acceptSubmission({jobId:f.id,questionId:f.q.questionId,provenance:p}),/expired|trusted/);}
 finally{service.stop();delete bridge.submission;f.close();}
});
test('a saved human answer already applied by timeout is not sent twice',async()=>{
 const f=fixture();let service;const bridge=globalThis[Symbol.for('ada.worker-question.v1')]??={};
 const saved={answerText:'date',answerSource:'user_text',userSubmittedAt:Date.now()-5000,answerMessageId:'answer'};
 const q={...f.q,...saved};writeJson(join(f.root,f.id+'.json'),{...f.job,questions:[q]});bridge.submission=()=>saved;
 registerQuestionBridge({registerService:s=>{service=s;}},f.jobs,{authorizeReply:()=>true});await service.start();
 try{assert.deepEqual(await bridge.acceptSubmission({jobId:f.id,questionId:q.questionId,provenance:p}),{alreadyApplied:true});assert.equal(existsSync(join(f.root,'supplements')),false);}
 finally{service.stop();delete bridge.submission;f.close();}
});
for(const status of ['failed','timed_out','cancelled'])test('saved submission handoff records terminal job outcome: '+status,async()=>{
 const f=fixture(status);try{
  const metadata={userSubmittedAt:Date.now()-5000,answerSource:'user_text'};
  const s=await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true,metadata);
  await f.jobs.submitSupplement(f.id,f.scope,s.supplementId,'date',metadata,()=>true);
  const events=[];await f.jobs.processSupplements(f.id,f.scope,()=>true,async e=>events.push(e));
  assert.equal(events.at(-1).kind,'supplement_unavailable');assert.equal(existsSync(join(f.root,s.supplementId+'.json')),false);
 }finally{f.close();}
});
test('crash leftovers and mismatched filenames cannot become admitted supplements',async()=>{
 const f=fixture();try{
  const q={...f.q,expiresAt:Date.now()+60000};writeJson(join(f.root,f.id+'.json'),{...f.job,questions:[q]});
  const dir=join(f.root,'supplements');mkdirSync(dir);const stale=randomUUID();
  const record={supplementId:stale,jobId:f.id,originalQuestionId:q.questionId,status:'accepted',question:q,answer:'stale'};
  writeJson(join(dir,stale+'.json.'+randomUUID()),record);writeJson(join(dir,randomUUID()+'.json'),record);
  const s=await f.jobs.openSupplement(f.id,f.scope,q.questionId,()=>true);assert.notEqual(s.supplementId,stale);
  assert.ok(existsSync(join(dir,s.supplementId+'.json')));
  const observed=[];await f.jobs.processSupplements(f.id,f.scope,()=>true,async e=>observed.push(e));
  assert.equal(observed.length,1);assert.equal(observed[0].supplementId,s.supplementId);assert.equal(existsSync(join(f.root,stale+'.json')),false);
 }finally{f.close();}
});
for(const mode of ['reply','timeout'])test('full queue does not deadlock an admitted same-session continuation: '+mode,async()=>{
 const f=fixture('awaiting_user');try{
  const q={...f.q,createdAt:Date.now()-USER_INPUT_WAIT_MS-1000,expiresAt:Date.now()+60000,waitingForUserAt:Date.now()};delete q.answer;delete q.resumeReason;
  writeJson(join(f.root,f.id+'.json'),{...f.job,contextRequest:q,questions:[q]});
  const jobs=createJobs({root:f.root,node:process.execPath,worker:'unused',getLimits:()=>({maxConcurrentJobs:1,maxQueuedJobs:1}),authorizeUserTimeout:()=>true});
  const next=await jobs.run({...f.params,requestId:'next',waitSeconds:0},f.scope,p);assert.equal(next.status,'queued');
  const waiting=readJson(join(f.root,f.id+'.json'));waiting.contextRequest.waitingForUserAt=Date.now()-USER_INPUT_WAIT_MS-1;writeJson(join(f.root,f.id+'.json'),waiting);
  if(mode==='reply')await jobs.reply(f.id,f.scope,q.questionId,'date',p,()=>true);else jobs.tick();
  const parent=jobs.status(f.id,f.scope);assert.equal(parent.status,'queued');assert.equal(parent.queuePosition,1);assert.ok(parent.questions[0].answer);
  assert.equal(jobs.status(next.jobId,f.scope).queuePosition,2);
 }finally{f.close();}
});

for(const mode of ['reply','timeout'])test('saved ordinary answer survives the hard question deadline: '+mode,async()=>{
 const f=fixture('awaiting_user');try{
  const q={...f.q,createdAt:Date.now()-USER_INPUT_WAIT_MS*3,waitingForUserAt:Date.now()-USER_INPUT_WAIT_MS*2};delete q.answer;delete q.resumeReason;
  writeJson(join(f.root,f.id+'.json'),{...f.job,contextRequest:q,questions:[q]});
  const submitted={answerText:'saved original answer',answerSource:'user_text',answerMessageId:'saved-message',userSubmittedAt:Date.now()-USER_INPUT_WAIT_MS-1000};
  const jobs=createJobs({root:f.root,node:process.execPath,worker:'unused',authorizeUserTimeout:()=>true,getUserTimeoutSubmission:()=>submitted});
  if(mode==='reply')await jobs.reply(f.id,f.scope,q.questionId,submitted.answerText,p,()=>true,false,undefined,submitted);else jobs.tick();
  const after=jobs.status(f.id,f.scope);assert.equal(after.status,'queued');assert.match(after.questions[0].answer,/saved original answer/);assert.equal(after.questions[0].answerMessageId,'saved-message');
 }finally{f.close();}
});

for(const kind of ['missing','invalid','mismatch'])test('unusable original request is reported without repeating execution: '+kind,async()=>{
 const f=fixture();try{
  const metadata={userSubmittedAt:Date.now()-5000,answerSource:'user_text'};
  const s=await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true,metadata);await f.jobs.submitSupplement(f.id,f.scope,s.supplementId,'date',metadata,()=>true);
  const file=join(f.root,f.id+'.request.json');
  if(kind==='missing')rmSync(file);else if(kind==='invalid')(await import('node:fs')).writeFileSync(file,'{');else writeJson(file,{params:{...f.params,task:'different'},scope:f.scope});
  const events=[];await f.jobs.processSupplements(f.id,f.scope,()=>true,async e=>events.push(e));
  assert.equal(events.at(-1).reason,'original_request_'+kind);assert.equal(events.at(-1).status,'blocked');assert.equal(existsSync(join(f.root,s.supplementId+'.json')),false);
 }finally{f.close();}
});
test('confirmed source revocation suppresses accepted data but unknown authorization preserves it',async()=>{
 const f=fixture();try{
  const metadata={userSubmittedAt:Date.now()-5000,answerSource:'user_text'};
  const s=await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true,metadata);await f.jobs.submitSupplement(f.id,f.scope,s.supplementId,'date',metadata,()=>true);
  await f.jobs.suppressSupplements(f.id,f.scope,()=>undefined);assert.equal(f.jobs.supplement(f.id,f.scope,s.supplementId).status,'accepted');
  await f.jobs.suppressSupplements(f.id,f.scope,()=>true);const suppressed=f.jobs.supplement(f.id,f.scope,s.supplementId);
  assert.equal(suppressed.status,'suppressed');assert.equal(suppressed.reason,'source_invalid');assert.equal(suppressed.notificationSuppressed,true);assert.equal(existsSync(join(f.root,s.supplementId+'.json')),false);
 }finally{f.close();}
});

test('adapter disappearance while awaiting dispatch is not a revocation',async()=>{
 const f=fixture();try{
  const metadata={userSubmittedAt:Date.now()-5000,answerSource:'user_text'};
  const s=await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true,metadata);await f.jobs.submitSupplement(f.id,f.scope,s.supplementId,'date',metadata,()=>true);
  await f.jobs.processSupplements(f.id,f.scope,()=>undefined,async()=>{});assert.equal(f.jobs.supplement(f.id,f.scope,s.supplementId).status,'accepted');
  const events=[];await f.jobs.processSupplements(f.id,f.scope,()=>false,async e=>events.push(e));
  assert.equal(f.jobs.supplement(f.id,f.scope,s.supplementId).notificationSuppressed,true);assert.equal(events.some(e=>e.kind==='supplement_unavailable'),false);
  await f.jobs.processSupplements(f.id,f.scope,()=>true,async()=>{throw Error('revoked record must not notify even if adapter returns');});
 }finally{f.close();}
});
