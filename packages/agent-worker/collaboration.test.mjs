import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {hostRequestId,localPersonCall,createCollaborationService} from './collaboration.mjs';
import {parseContextRequest} from './context-request.mjs';
import {createJobs,writeJson,readJson,requestKeyFor,USER_INPUT_WAIT_MS} from './jobs.mjs';
const p={taskId:'task',revision:0,accountId:'a',chatId:'chat',sessionKey:'scope',senderId:'alice',agentId:'main',sourceMessageIds:['m'],requestMessageIds:['m'],people:{requester:{openId:'alice',accountId:'a',appId:'app'},mentions:[]}};
function fixture(status='awaiting_user'){
 const root=mkdtempSync('/tmp/worker-collaboration-'),id=randomUUID(),scope='scope',params={topic:'test',task:'只读查询',context:'已核实对象',constraints:'不修改业务数据',memory:{status:'no_match',queries:['test'],items:[]}};
 const q={questionId:randomUUID(),question:'补充日期',reason:'未知',progress:'已查询',fields:[{id:'date',label:'日期',type:'text',required:true}],createdAt:Date.now(),waitingForUserAt:Date.now()-USER_INPUT_WAIT_MS-10,expiresAt:Date.now()+3600000};
 const job={jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,p),provenance:p,topic:'test',status,contextRequest:q,questions:[q],tags:[],resourceKeys:['record:one'],schedulerVersion:1,createdAt:Date.now(),heartbeatAt:Date.now(),resumeSessionId:randomUUID(),notification:{state:'pending'}};
 writeJson(join(root,id+'.request.json'),{params,scope,runtime:{state:root,cwd:root}});writeJson(join(root,id+'.json'),job);mkdirSync(join(root,'active'));
 const jobs=createJobs({root,node:process.execPath,worker:'unused',authorizeUserTimeout:()=>true,mainTimeoutGraceMs:60000});
 return {root,id,scope,params,q,job,jobs,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('host ID survives selector equivalents/retries and separates source revisions',()=>{
 const a=hostRequestId({topic:'t',projectId:'xgj'},p);
 assert.equal(a,hostRequestId({topic:'t',repository:'projects/xgj'},p));
 assert.notEqual(a,hostRequestId({topic:'t',projectId:'xgj'},{...p,revision:1}));
 assert.equal(hostRequestId({requestId:'explicit'},p),'explicit');assert.equal(hostRequestId({},{}),undefined);
});
test('structured calls are bounded and local lookup cannot escape source-bound people',()=>{
 const call={callId:'lookup-1',capability:'person_lookup',arguments:{openId:'alice'},purpose:'核验账号'};
 const request={type:'request',requestKind:'plugin',question:'查询',reason:'需要',progress:'已定位',pluginCall:call,waitKind:'required'};
 assert.deepEqual(parseContextRequest(JSON.stringify(request)).pluginCall,call);
 for(const invalid of [{...request,requestKind:'context'},{...request,waitKind:'forever'},{...request,pluginCall:{...call,tool:'shell'}},{...request,pluginCall:{...call,arguments:'text'}}])assert.throws(()=>parseContextRequest(JSON.stringify(invalid)));
 let lookups=0;const service=()=>({lookup:args=>{lookups++;assert.equal(args.accountId,'a');return {name:'Alice'};}});
 assert.equal(localPersonCall(call,p,service).found,true);
 assert.deepEqual(localPersonCall({...call,arguments:{openId:'bob'}},p,service),{fallback:true});
 assert.deepEqual(localPersonCall({...call,arguments:{openId:'alice',accountId:'other'}},p,service),{fallback:true});
 assert.equal(lookups,1);
});
test('timeout asks Main once, then resumes with unknowns after bounded grace',()=>{
 const f=fixture();try{
  f.jobs.tick();let job=f.jobs.status(f.id,f.scope);assert.equal(job.status,'awaiting_main');assert.ok(job.contextRequest.timeoutRequestedAt);
  f.jobs.tick();assert.equal(f.jobs.status(f.id,f.scope).status,'awaiting_main');
  const saved=readJson(join(f.root,f.id+'.json'));saved.contextRequest.timeoutRequestedAt-=60001;writeJson(join(f.root,f.id+'.json'),saved);
  f.jobs.tick();job=f.jobs.status(f.id,f.scope);assert.equal(job.status,'queued');assert.match(job.questions[0].answer,/不是用户答复或授权/);assert.equal(job.questions[0].resumeReason,'user_wait_timeout');
  assert.equal(readJson(join(f.root,f.id+'.request.json')).params.constraints,f.params.constraints);
 }finally{f.close();}
});
test('late supplement persists during running, dispatches once after completion, preserves parent and scope',async()=>{
 const f=fixture('running');try{
  const old={...f.job,contextRequest:undefined,questions:[{...f.q,answer:'未知跳过',resumeReason:'user_wait_timeout'}]};writeJson(join(f.root,f.id+'.json'),old);
  const opened=await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true);
  assert.equal((await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true)).supplementId,opened.supplementId);
  await f.jobs.submitSupplement(f.id,f.scope,opened.supplementId,'2026-10-23',{answerSource:'user_card',answerValues:{date:'2026-10-23'}},()=>true);
  await assert.rejects(f.jobs.submitSupplement(f.id,f.scope,opened.supplementId,'other',{},()=>true),/differently/);
  const observations=[];await f.jobs.processSupplements(f.id,f.scope,()=>true,async e=>observations.push(e));
  assert.equal(existsSync(join(f.root,opened.supplementId+'.json')),false);
  writeJson(join(f.root,f.id+'.json'),{...old,status:'completed',finishedAt:Date.now()});const parent=readFileSync(join(f.root,f.id+'.json'),'utf8');
  await f.jobs.processSupplements(f.id,f.scope,()=>true,async e=>observations.push(e));
  const child=readJson(join(f.root,opened.supplementId+'.json'));
  assert.equal(child.parentJobId,f.id);assert.equal(child.resumeSessionId,old.resumeSessionId);assert.equal(child.continuationPriority,1);assert.deepEqual(child.resourceKeys,old.resourceKeys);
  assert.equal(readFileSync(join(f.root,f.id+'.json'),'utf8'),parent);
  const request=readJson(join(f.root,child.jobId+'.request.json'));assert.equal(request.params.constraints,f.params.constraints);assert.match(request.resumeParams.mainReplies.at(-1).answer,/不重复外部操作/);
  await f.jobs.processSupplements(f.id,f.scope,()=>true,async e=>observations.push(e));assert.equal(observations.at(-1).kind,'supplement_dispatched');
  await assert.rejects(f.jobs.openSupplement(f.id,'wrong',f.q.questionId,()=>true));
 }finally{f.close();}
});
test('cancelled sources never dispatch accepted supplements',async()=>{
 const f=fixture('completed');try{
  writeJson(join(f.root,f.id+'.json'),{...f.job,contextRequest:undefined,questions:[{...f.q,answer:'未知',resumeReason:'user_wait_timeout'}]});
  const s=await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true);await f.jobs.submitSupplement(f.id,f.scope,s.supplementId,'date',{},()=>true);
  await f.jobs.processSupplements(f.id,f.scope,()=>false,async()=>{});assert.equal(f.jobs.supplement(f.id,f.scope,s.supplementId).status,'suppressed');assert.equal(existsSync(join(f.root,s.supplementId+'.json')),false);
 }finally{f.close();}
});
test('automatic plugin collaboration informs Main and caches call results across restart',async()=>{
 const f=fixture('awaiting_main');let calls=0,replies=0,notices=0;
 try{
  const q={...f.q,pluginCall:{callId:'lookup',capability:'person_lookup',arguments:{openId:'alice'},purpose:'核验'},requestKind:'plugin'};
  writeJson(join(f.root,f.id+'.json'),{...f.job,contextRequest:q,questions:[q]});
  const opts={root:f.root,jobs:{reply:async()=>{replies++;}},bridge:{authorizeReply:()=>true,observe:async()=>{notices++;}},personCall:()=>{calls++;return {ok:true,person:{name:'Alice'}};}};
  let service=createCollaborationService(opts);service.start();await service.tick();await service.stop();
  service=createCollaborationService(opts);service.start();await service.tick();await service.stop();
  assert.equal(calls,1);assert.equal(notices,2);assert.equal(replies,2); // reply itself is idempotent
 }finally{f.close();}
});

for(const waitKind of ['optional','required','decision','authorization'])test('all wait kinds continue without manufacturing consent: '+waitKind,()=>{
 const f=fixture();try{
  const j=readJson(join(f.root,f.id+'.json'));j.contextRequest.waitKind=waitKind;j.contextRequest.timeoutRequestedAt=Date.now()-60001;writeJson(join(f.root,f.id+'.json'),j);
  f.jobs.tick();const after=f.jobs.status(f.id,f.scope);assert.equal(after.status,'queued');assert.match(after.questions[0].answer,/不是用户答复或授权/);
  if(waitKind==='authorization')assert.match(after.questions[0].answer,/不把超时当授权成功/);
  if(waitKind==='decision')assert.match(after.questions[0].answer,/不代选/);
 }finally{f.close();}
});
test('Main can fill known context during timeout grace without resetting the wait',async()=>{
 const f=fixture();try{
  f.jobs.tick();const started=f.jobs.status(f.id,f.scope).contextRequest.timeoutRequestedAt;
  await f.jobs.awaitUser(f.id,f.scope,f.q.questionId,p,()=>true,{date:'2026-10-23'});
  assert.equal(f.jobs.status(f.id,f.scope).contextRequest.timeoutRequestedAt,started);
  const resumed=await f.jobs.reply(f.id,f.scope,f.q.questionId,'已核实日期 2026-10-23，来源原消息',p,()=>true,false,undefined,{answerBasis:'原消息'});
  assert.equal(resumed.status,'queued');assert.equal(resumed.questions[0].resumeReason,'user_wait_timeout');assert.match(resumed.questions[0].answer,/已核实/);
 }finally{f.close();}
});
test('accepted supplement survives restart and executes once through the original session',async()=>{
 const f=fixture('completed');try{
  writeJson(join(f.root,f.id+'.json'),{...f.job,contextRequest:undefined,questions:[{...f.q,answer:'未知',resumeReason:'user_wait_timeout'}]});
  const s=await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true);
  await f.jobs.submitSupplement(f.id,f.scope,s.supplementId,'2026-10-23',{answerSource:'user_text',answerMessageId:'late-message'},()=>true);
  const worker=join(f.root,'fixture-worker.mjs');
  writeFileSync(worker,`import{readFileSync,writeFileSync,appendFileSync}from'node:fs';const[root,id]=process.argv.slice(2);let input='';for await(const c of process.stdin)input+=c;const p=root+'/'+id+'.json',j=JSON.parse(readFileSync(p));appendFileSync(root+'/runs',id+'\\n');j.status='completed';j.result={params:JSON.parse(input).params};writeFileSync(p,JSON.stringify(j));`);
  rmSync(join(f.root,'active'),{recursive:true});const jobs=createJobs({root:f.root,node:process.execPath,worker});
  await jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});const done=await jobs.wait(s.supplementId,f.scope,3);
  assert.equal(done.status,'completed');assert.equal(done.resumeSessionId,f.job.resumeSessionId);assert.match(done.result.params.mainReplies.at(-1).answer,/2026-10-23/);
  await jobs.processSupplements(f.id,f.scope,()=>true,async()=>{});assert.equal(readFileSync(join(f.root,'runs'),'utf8').trim(),s.supplementId);
 }finally{f.close();}
});
for(const mode of ['fallback','unobservable','revoked','call_conflict'])test('structured plugin preserves Main control for '+mode,async()=>{
 const f=fixture('awaiting_main');let replies=0,calls=0,allowed=mode!=='revoked';try{
  const q={...f.q,pluginCall:{callId:'lookup',capability:'other',arguments:{},purpose:'查询'},requestKind:'plugin'};
  writeJson(join(f.root,f.id+'.json'),{...f.job,contextRequest:q,questions:[q]});
  if(mode==='call_conflict'){mkdirSync(join(f.root,'collaboration'));writeJson(join(f.root,'collaboration',f.id+'.json'),{events:{},calls:{lookup:{body:'different',result:{ok:true}}}});}
  const service=createCollaborationService({root:f.root,jobs:{reply:async()=>{replies++;}},bridge:{authorizeReply:()=>allowed,...(mode==='unobservable'?{}:{observe:async()=>{}})},personCall:()=>{calls++;return {fallback:true};},logger:{warn(){}}});
  service.start();await service.tick();await service.stop();assert.equal(replies,0);assert.equal(calls,mode==='fallback'?1:0);assert.equal(f.jobs.status(f.id,f.scope).status,'awaiting_main');
 }finally{f.close();}
});

test('pending supplemental context is resumed even when the current plugin needs Main fallback',async()=>{
 const f=fixture('awaiting_main');try{
  const current={...f.q,questionId:randomUUID(),requestKind:'plugin',pluginCall:{callId:'manual',capability:'unregistered',arguments:{},purpose:'查询'}};
  writeJson(join(f.root,f.id+'.json'),{...f.job,contextRequest:current,questions:[{...f.q,answer:'未知',resumeReason:'user_wait_timeout'},current]});
  const s=await f.jobs.openSupplement(f.id,f.scope,f.q.questionId,()=>true);await f.jobs.submitSupplement(f.id,f.scope,s.supplementId,'补充日期',{},()=>true);
  const kinds=[];const service=createCollaborationService({root:f.root,jobs:f.jobs,bridge:{authorizeReply:()=>true,observe:async e=>kinds.push(e.kind)}});
  service.start();await service.tick();await service.tick();await service.stop();
  const after=f.jobs.status(f.id,f.scope);assert.equal(after.status,'queued');assert.match(after.questions.at(-1).answer,/原 questionId=/);assert.ok(kinds.includes('supplement_received'));assert.ok(kinds.includes('supplement_dispatched'));
 }finally{f.close();}
});
