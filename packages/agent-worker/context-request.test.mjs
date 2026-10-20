import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {explainQueryError} from './diagnostics.mjs';
import {parseContextRequest,validateContextAnswers} from './context-request.mjs';
import {runWorker} from './worker.mjs';
import {createJobs,readJson,writeJson,requestKeyFor} from './jobs.mjs';
import {createCompletionService,completionEvent} from './completion.mjs';
import {createSessionInspector} from './session-inspector.mjs';
const question={question:'哪一天？',reason:'范围缺失',progress:'已确认查询方式'};
function fixture(){
 const state=mkdtempSync(join(tmpdir(),'worker-context-')),root=join(state,'jobs');mkdirSync(root);const id=randomUUID(),scope='isolated',params={action:'run',topic:'test',task:'查询',context:'测试',constraints:'只读',waitSeconds:0};
 const provenance={senderId:'alice',accountId:'a'};
 writeJson(join(root,id+'.json'),{jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,provenance),provenance,topic:'test',tags:[],schedulerVersion:1,status:'running',createdAt:Date.now(),startedAt:Date.now(),heartbeatAt:Date.now(),notification:{state:'pending'}});
 writeJson(join(root,id+'.request.json'),{params,scope});
 return {state,root,id,scope,params,provenance,close:()=>rmSync(state,{recursive:true,force:true})};
}
async function ask(f){return runWorker({...f,execute:async()=>({content:[{type:'text',text:JSON.stringify({contextRequest:question,sessionId:'original-thread',result:JSON.stringify({type:'request',...question})})}]})});}
test('only explicit bounded context request protocol pauses work',()=>{
 assert.equal(explainQueryError(Error('No matching pending question')).code,'QUESTION_UNAVAILABLE');assert.equal(explainQueryError(Error('Original task authorization is no longer current')).code,'CONTEXT_REPLY_FORBIDDEN');
 assert.equal(parseContextRequest('信息不足，请确认'),undefined);assert.equal(parseContextRequest('{"type":"other"}'),undefined);
 assert.deepEqual(parseContextRequest(JSON.stringify({type:'request',...question})),question);
 for(const value of [{...question,question:''},{...question,reason:'a'.repeat(4001)},{...question,target:'other-main'}])assert.throws(()=>parseContextRequest(JSON.stringify({type:'request',...value})));
});
test('Worker question is durable, nonterminal and bound to its original thread; inspector shows it as active',async()=>{
 const f=fixture();try{
  const job=await ask(f);assert.equal(job.status,'awaiting_main');assert.equal(job.finishedAt,undefined);assert.equal(job.taskReport,undefined);assert.equal(job.resumeSessionId,'original-thread');
  assert.equal(job.notification.eventKey,job.contextRequest.questionId);
  assert.equal(completionEvent(job).type,'agent_worker.context_request');
  const inspector=createSessionInspector({state:f.state,jobs:{status:()=>job}});
  assert.equal((await inspector.list(f.scope)).groupCounts.active,1);assert.equal((await inspector.detail(f.scope,{topic:'test'})).records[0].questions[0].question,question.question);
  // Persistence, rather than heartbeat, owns the waiting state.
  writeJson(join(f.root,f.id+'.json'),{...job,heartbeatAt:0});
  const jobs=createJobs({root:f.root,node:process.execPath,worker:'unused'});
  assert.equal(jobs.status(f.id,f.scope).status,'awaiting_main');
  assert.ok(readFileSync(join(f.root,f.id+'.events.jsonl'),'utf8').includes('worker.context_request'));
 }finally{f.close();}
});
test('reply preserves job and original request, resumes once, enforces owner/scope/question and idempotency',async()=>{
 const f=fixture();try{
  const job=await ask(f),worker=join(f.root,'fake.mjs');
  writeFileSync(worker,`import{readFileSync,writeFileSync}from'node:fs';const[root,id]=process.argv.slice(2);let input='';for await(const c of process.stdin)input+=c;const {params}=JSON.parse(input);const file=root+'/'+id+'.json';let j=JSON.parse(readFileSync(file));j.status='completed';j.result={params};writeFileSync(file,JSON.stringify(j));`);
  const jobs=createJobs({root:f.root,node:process.execPath,worker});const q=job.contextRequest.questionId;
  await assert.rejects(jobs.reply(f.id,'other',q,'今天',f.provenance),/conversation/);
  await assert.rejects(jobs.reply(f.id,f.scope,q,'今天',{...f.provenance,senderId:'bob'}),/requester/);
  await assert.rejects(jobs.reply(f.id,f.scope,'wrong','今天',f.provenance),/matching/);
  await assert.rejects(jobs.reply(f.id,f.scope,q,'今天',f.provenance,()=>false),/authorization/);
  assert.equal(jobs.status(f.id,f.scope).status,'awaiting_main');
  await assert.rejects(jobs.awaitUser(f.id,f.scope,q,{...f.provenance,senderId:'bob'}),/requester/);
  await assert.rejects(jobs.awaitUser(f.id,f.scope,'wrong',f.provenance),/matching/);
  const userWait=await jobs.awaitUser(f.id,f.scope,q,f.provenance);assert.equal(userWait.status,'awaiting_user');
  const repeated=await jobs.awaitUser(f.id,f.scope,q,f.provenance);assert.equal(repeated.questions[0].waitingForUserAt,userWait.questions[0].waitingForUserAt);
  const inspector=createSessionInspector({state:f.state,jobs});assert.equal((await inspector.list(f.scope)).counts.awaitingUser,1);
  const resumed=await jobs.reply(f.id,f.scope,q,'今天',f.provenance);assert.equal(resumed.jobId,f.id);
  const duplicate=await jobs.reply(f.id,f.scope,q,'今天',f.provenance);assert.equal(duplicate.jobId,f.id);
  await assert.rejects(jobs.reply(f.id,f.scope,q,'明天',f.provenance),/differently/);
  const done=await jobs.wait(f.id,f.scope,2);assert.equal(done.status,'completed');assert.deepEqual(done.result.params.mainReplies,[{questionId:q,question:question.question,answer:'今天'}]);
  const request=readJson(join(f.root,f.id+'.request.json'));assert.deepEqual(request.params,f.params);assert.equal(requestKeyFor(request.params,f.scope,f.provenance),done.requestKey);
  assert.equal(done.questions[0].answer,'今天');
 }finally{f.close();}
});
test('waiting releases capacity but reserves its topic, can cancel and expires without executing',async()=>{
 const f=fixture();try{
  await ask(f);const worker=join(f.root,'fake.mjs');writeFileSync(worker,`for await(const c of process.stdin){};`);
  const jobs=createJobs({root:f.root,node:process.execPath,worker,getLimits:()=>({maxConcurrentJobs:1,maxQueuedJobs:10})});
  const same=await jobs.run({...f.params,task:'另一个任务'},f.scope);assert.equal(same.status,'queued');assert.equal(same.waitingReason,'session_busy');
  const other=await jobs.run({...f.params,topic:'other'},f.scope);assert.equal(other.status,'running');
  assert.equal(jobs.cancel(f.id,f.scope,f.provenance).status,'cancelled');
  await assert.rejects(jobs.reply(f.id,f.scope,'wrong','今天',f.provenance));
  const waiting=await ask({...f,id:f.id});waiting.contextRequest.expiresAt=0;writeJson(join(f.root,f.id+'.json'),waiting);jobs.tick();assert.equal(jobs.status(f.id,f.scope).status,'timed_out');
 }finally{f.close();}
});

test('native text answers preserve source metadata and withdrawing that message cancels only the matching account and chat',async()=>{
 const f=fixture();try{
  f.provenance.chatId='chat';writeJson(join(f.root,f.id+'.json'),{...readJson(join(f.root,f.id+'.json')),provenance:f.provenance});
  const job=await ask(f);mkdirSync(join(f.root,'active'));
  const jobs=createJobs({root:f.root,node:process.execPath,worker:'unused'}),q=job.contextRequest.questionId;
  await jobs.awaitUser(f.id,f.scope,q,f.provenance);
  const resumed=await jobs.reply(f.id,f.scope,q,'北京时间10月19日至20日',f.provenance,()=>true,false,undefined,{answerSource:'user_text',answerMessageId:'native-answer',userSubmittedAt:123});
  assert.equal(resumed.jobId,f.id);assert.equal(resumed.status,'queued');
  assert.equal(resumed.questions[0].answerMessageId,'native-answer');assert.equal(resumed.questions[0].answerSource,'user_text');assert.equal(resumed.questions[0].answerValues,undefined);
  assert.deepEqual(jobs.cancelSources({accountId:'other',chatId:'chat',messageId:'native-answer'}),[]);
  assert.deepEqual(jobs.cancelSources({accountId:'a',chatId:'other',messageId:'native-answer'}),[]);
  assert.deepEqual(jobs.cancelSources({accountId:'a',chatId:'chat',messageId:'unrelated'}),[]);
  assert.deepEqual(jobs.cancelSources({accountId:'a',chatId:'chat',messageId:'native-answer'}),[f.id]);
  assert.equal(readFileSync(join(f.root,f.id+'.cancel'),'utf8'),'source-recalled');
 }finally{f.close();}
});
test('old question receipt cannot overwrite notification for a resumed task',async()=>{
 const f=fixture();let service;try{
  const job=await ask(f);let callbacks,release;const done=new Promise(r=>release=r);
  service=createCompletionService({root:f.root,pollMs:100000,bridge:{deliver:async(_event,c)=>{callbacks=c;await done;c.onReceipt({id:'old'});}},logger:{warn(){}}});service.start();
  assert.ok(callbacks);writeJson(join(f.root,f.id+'.json'),{...job,status:'running',notification:{state:'pending',eventKey:'next-round'}});release();await new Promise(r=>setImmediate(r));
  assert.deepEqual(readJson(join(f.root,f.id+'.json')).notification,{state:'pending',eventKey:'next-round'});
 }finally{await service?.stop();f.close();}
});
for(const legacy of [false,true])test(`real detached Worker CLI resumes the same paused job with frozen constraints (v5 continuation=${legacy})`,async()=>{
 const f=fixture();try{
  const {resolveConfiguration,executionFingerprint}=await import('./configuration.mjs');
  const {fileURLToPath}=await import('node:url');
  const cli=join(f.state,'fixture-cli.mjs');
  writeFileSync(cli,`#!${process.execPath}\nimport{appendFileSync}from'node:fs';import{randomUUID}from'node:crypto';let text='';for await(const c of process.stdin)text+=c;const p=JSON.parse(text);const args=process.argv.slice(2);appendFileSync('seen.jsonl',JSON.stringify({args,prompt:p})+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:args.includes('resume')?args[args.indexOf('resume')+1]:randomUUID()}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:p.mainReplies?JSON.stringify({protocol:'codex_result_v1',result:'查询完成',experienceCandidates:[],reportPaths:[]}):JSON.stringify({type:'request',question:'哪一天？',reason:'日期缺失',progress:'确认查询方式'})}}));`);chmodSync(cli,0o700);
  const baseline=resolveConfiguration({state:f.state,cwd:f.state,cli,node:process.execPath,codexHome:join(f.state,'codex'),skillsEnabled:false,memoryRequired:false,approvalMode:'read-only',executorInstructions:'只读测试',pathPrefix:'',reportDirectory:'reports'});
  const config=legacy?{...baseline,harness:'codex'}:baseline;
  const jobs=createJobs({root:f.root,node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:()=>config});
  // Replace the manual fixture with a genuinely scheduled task.
  rmSync(join(f.root,f.id+'.json'));rmSync(join(f.root,f.id+'.request.json'));
  const accepted=await jobs.run({...f.params,waitSeconds:3},f.scope);
  const waiting=await jobs.wait(accepted.jobId,f.scope,3);assert.equal(waiting.status,'awaiting_main');
  const thread=waiting.resumeSessionId;
  const bindingFile=join(f.state,createHash('sha256').update(f.scope).digest('hex')+'.json');
  if(legacy) {
   const bindings=readJson(bindingFile),original=bindings.test;
   bindings.test={...original,executionPolicyVersion:4};writeJson(bindingFile,bindings);
   const {executeQuery}=await import('./index.mjs');
   await assert.rejects(executeQuery(f.params,{sessionKey:f.scope,expectedSessionId:thread},config),/cannot be resumed safely/);
   bindings.test={...original,executionPolicyVersion:5,configurationFingerprint:executionFingerprint(config,{policyVersion:5})};writeJson(bindingFile,bindings);
   await assert.rejects(executeQuery(f.params,{sessionKey:f.scope,expectedSessionId:thread},{...config,model:'changed-model'}),/cannot be resumed safely/);
   assert.equal(readFileSync(join(f.state,'seen.jsonl'),'utf8').trim().split('\n').length,1);
  }
  const {executeQuery}=await import('./index.mjs');
  await assert.rejects(executeQuery(f.params,{sessionKey:f.scope,expectedSessionId:randomUUID()},config),/cannot be resumed safely/);
  await jobs.awaitUser(waiting.jobId,f.scope,waiting.contextRequest.questionId);
  assert.equal(jobs.status(waiting.jobId,f.scope).status,'awaiting_user');
  await jobs.reply(waiting.jobId,f.scope,waiting.contextRequest.questionId,'今天');
  const done=await jobs.wait(waiting.jobId,f.scope,3);assert.equal(done.status,'completed');assert.equal(done.jobId,waiting.jobId);
  assert.equal(JSON.parse(done.result.content[0].text).sessionId,thread);
  const turns=readFileSync(join(f.state,'seen.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(turns.length,2);assert.ok(turns[1].args.includes('resume'));assert.equal(turns[1].args[turns[1].args.indexOf('resume')+1],thread);
  assert.equal(turns[1].prompt.constraints,f.params.constraints);assert.equal(turns[1].prompt.task,f.params.task);assert.equal(turns[1].prompt.mainReplies[0].answer,'今天');
  assert.equal(done.taskReport.contextExchanges[0].answer,'今天');assert.equal(done.executionRounds.length,2);assert.equal(done.executionRounds[1].resumed,true);
 }finally{f.close();}
});


test('structured questions validate field types, options, dates and known values',()=>{
 const fields=[{id:'env',label:'环境',type:'single_select',required:true,options:[{label:'生产',value:'prod'}]},{id:'period',label:'日期范围',type:'date_range',required:true,timezone:'Asia/Shanghai'},{id:'count',label:'数量',type:'number',min:1,max:10}];
 const q=parseContextRequest(JSON.stringify({type:'request',...question,fields,allowFreeText:true}));
 assert.deepEqual(q.fields,fields);
 const values={env:'prod',period:{start:'2026-10-01',end:'2026-10-09'},count:'3'};
 assert.deepEqual(validateContextAnswers(q,values),{...values,count:3});
 assert.deepEqual(validateContextAnswers(q,{env:'prod'},{partial:true}),{env:'prod'});
 for(const bad of [{env:'test'},{env:'prod',period:{start:'2026-02-30',end:'2026-03-01'}},{env:'prod',period:{start:'2026-10-09',end:'2026-10-01'}},{...values,count:'NaN'},{...values,unknown:'extra'}])assert.throws(()=>validateContextAnswers(q,bad));
 for(const badFields of [[...fields,fields[0]],[{...fields[0],options:[{label:'生产',value:'prod'},{label:'重复',value:'prod'}]}],[{id:'date',label:'日期',type:'date'}],[{id:'text',label:'描述',type:'unsupported'}]])assert.throws(()=>parseContextRequest(JSON.stringify({type:'request',...question,fields:badFields})));
});

test('multi-select and date-time answers are bounded and validated',()=>{
 const q=parseContextRequest(JSON.stringify({type:'request',...question,fields:[{id:'items',label:'事项',type:'multi_select',options:[{label:'A',value:'a'},{label:'B',value:'b'}]},{id:'at',label:'时间',type:'datetime',timezone:'Asia/Shanghai'}]}));
 assert.deepEqual(validateContextAnswers(q,{items:['a','b'],at:'2026-10-10 12:30'}),{items:['a','b'],at:'2026-10-10 12:30'});
 assert.throws(()=>validateContextAnswers(q,{items:['a','a']}));assert.throws(()=>validateContextAnswers(q,{at:'2026-10-10 25:30'}));assert.throws(()=>validateContextAnswers(q,{at:'2026-10-10 12:30:99'}));assert.throws(()=>validateContextAnswers(q,{at:'2026-10-10 12:30+9900'}));
});

test('known values survive awaiting-user persistence and invalid known values never change state',async()=>{
 const f=fixture();try{
  const job=await ask(f);const fields=[{id:'env',label:'环境',type:'single_select',required:true,options:[{label:'生产',value:'prod'}]}];
  const saved={...job,contextRequest:{...job.contextRequest,fields},questions:job.questions.map(q=>({...q,fields}))};writeJson(join(f.root,f.id+'.json'),saved);
  const jobs=createJobs({root:f.root,node:process.execPath,worker:'unused'});
  await assert.rejects(jobs.awaitUser(f.id,f.scope,job.contextRequest.questionId,f.provenance,()=>true,{env:'test'}),/请检查/);
  assert.equal(jobs.status(f.id,f.scope).status,'awaiting_main');
  const waiting=await jobs.awaitUser(f.id,f.scope,job.contextRequest.questionId,f.provenance,()=>true,{env:'prod'});
  assert.deepEqual(waiting.contextRequest.knownValues,{env:'prod'});assert.equal(waiting.status,'awaiting_user');
 }finally{f.close();}
});

test('trusted card answer values persist in task history and override no original constraints',async()=>{
 const f=fixture();try{
  const job=await ask(f),worker=join(f.root,'fake-values.mjs');
  const fields=[{id:'env',label:'环境',type:'single_select',required:true,options:[{label:'生产',value:'prod'}]}];
  writeJson(join(f.root,f.id+'.json'),{...job,contextRequest:{...job.contextRequest,fields},questions:job.questions.map(q=>({...q,fields}))});
  writeFileSync(worker,`import{readFileSync,writeFileSync}from'node:fs';const[root,id]=process.argv.slice(2);let input='';for await(const c of process.stdin)input+=c;const {params}=JSON.parse(input);const file=root+'/'+id+'.json';let j=JSON.parse(readFileSync(file));j.status='completed';j.result={params};writeFileSync(file,JSON.stringify(j));`);
  const jobs=createJobs({root:f.root,node:process.execPath,worker});await jobs.awaitUser(f.id,f.scope,job.contextRequest.questionId,f.provenance);
  await jobs.reply(f.id,f.scope,job.contextRequest.questionId,'环境：生产',f.provenance,()=>true,false,undefined,{answerValues:{env:'prod'},answerSource:'user_card',userSubmittedAt:123});
  const done=await jobs.wait(f.id,f.scope,2);
  assert.equal(done.questions[0].answerSource,'user_card');assert.deepEqual(done.questions[0].answerValues,{env:'prod'});
  assert.equal(done.result.params.constraints,'只读');assert.equal(done.result.params.mainReplies[0].answerValues.env,'prod');
 }finally{f.close();}
});

test('reserved names and date-range form names cannot collide',()=>{
 for(const fields of [[{id:'worker_note',label:'冲突',type:'text'}],[{id:'period',label:'日期',type:'date_range',timezone:'Asia/Shanghai'},{id:'period__start',label:'冲突',type:'text'}]])assert.throws(()=>parseContextRequest(JSON.stringify({type:'request',...question,fields})),/field name/);
});

test('ignores a model-supplied questionId and assigns a fresh host ID on each question',async()=>{
 const f=fixture();try {
  const fields=[{id:'activity_type',label:'活动类型',type:'single_select',required:true,options:[{label:'分享会',value:'sharing'},{label:'工作坊',value:'workshop'}]}];
  const raw={type:'request',questionId:'activity_invitation_round_1_type',...question,fields,allowFreeText:false};
  const parsed=parseContextRequest(JSON.stringify(raw));
  assert.equal(parsed.questionId,undefined);assert.deepEqual(parsed.fields,fields);
  const ids=new Set();
  for(let round=0;round<4;round++) {
   const job=await runWorker({...f,execute:async()=>({content:[{type:'text',text:JSON.stringify({contextRequest:parsed,sessionId:'original-thread',result:JSON.stringify(raw)})}]})});
   assert.equal(job.status,'awaiting_main');assert.equal(job.jobId,f.id);
   assert.equal(job.resumeSessionId,'original-thread');assert.equal(job.questions.length,round+1);
   assert.notEqual(job.contextRequest.questionId,raw.questionId);ids.add(job.contextRequest.questionId);
  }
  assert.equal(ids.size,4);
 }finally{f.close();}
});
test('identifies unsupported context request properties without accepting new authority fields',()=>{
 assert.throws(()=>parseContextRequest(JSON.stringify({type:'request',...question,target:'other-main'})),/unsupported "target"/);
 assert.throws(()=>parseContextRequest(JSON.stringify({type:'request',...question,questionId:{id:'bad'}})),/questionId/);
});

test('accepts complete fenced questions without interpreting prose or swallowing broken protocol',()=>{
 const raw=JSON.stringify({type:'request',...question});
 for(const language of ['json','JSON',''])assert.deepEqual(parseContextRequest('```'+language+'\n'+raw+'\n```'),question);
 assert.equal(parseContextRequest('报告示例：\n```json\n'+raw+'\n```'),undefined);
 assert.throws(()=>parseContextRequest('```json\n{"type":"request","question":\n```'),/Invalid context request JSON/);
});
test('rejects coerced field identifiers and questions with no answer entry',()=>{
 for(const id of [['choice'],null,7,{toString:'choice'}])assert.throws(()=>parseContextRequest(JSON.stringify({type:'request',...question,fields:[{id,label:'选择',type:'text'}]})),/fields\[0\]\.id: expected a string/);
 assert.throws(()=>parseContextRequest(JSON.stringify({type:'request',...question,allowFreeText:false})),/fields required/);
 const request=parseContextRequest(JSON.stringify({type:'request',...question,allowFreeText:false,fields:[{id:'choice',label:'选择',type:'text'}]}));
 assert.deepEqual(validateContextAnswers(request,{choice:'继续'}),{choice:'继续'});
});

 test('request discriminator preserves legacy questions and strict validation',()=>{
  for(const type of ['request','context_request']){
   assert.deepEqual(parseContextRequest(JSON.stringify({type,...question})),question);
   assert.throws(()=>parseContextRequest(JSON.stringify({type,...question,target:'other-main'})),/unsupported/);
   assert.throws(()=>parseContextRequest('{"type":"'+type+'","question":'),/Invalid context request JSON/);
  }
  assert.equal(parseContextRequest(JSON.stringify({type:'other',...question})),undefined);
 });

for(const [kind,priorCount,expected] of [['plugin',5,'awaiting_main'],['plugin',49,'awaiting_main'],['plugin',50,'failed'],['context',4,'awaiting_main'],['context',5,'failed']])test(`separate ${kind} budget with ${priorCount} prior requests`,async()=>{
 const f=fixture();try{
  const job=readJson(join(f.root,f.id+'.json'));
  job.questions=Array.from({length:priorCount},(_,i)=>({questionId:String(i),question:'earlier',answer:'done',...(kind==='plugin'?{requestKind:'plugin'}:{})}));
  // Exhaust the other budget as well: the two counters remain independent.
  job.questions.push(...Array.from({length:kind==='plugin'?5:50},()=>({requestKind:kind==='plugin'?'context':'plugin',answer:'done'})));
  writeJson(join(f.root,f.id+'.json'),job);
  const parsed=parseContextRequest(JSON.stringify({type:'request',...question,requestKind:kind}));
  const result=await runWorker({...f,execute:async()=>({content:[{type:'text',text:JSON.stringify({contextRequest:parsed,sessionId:'original-thread'})}]})});
  assert.equal(result.status,expected);
  if(expected==='failed')assert.match(result.error,kind==='plugin'?/Plugin request limit/:/Context question limit/);
  else assert.equal(result.contextRequest.requestKind,kind);
 }finally{f.close();}
});
test('request kinds are optional for legacy tasks and strictly validated',()=>{
 assert.deepEqual(parseContextRequest(JSON.stringify({type:'request',...question})),question);
 for(const requestKind of ['other',null,1,{}])assert.throws(()=>parseContextRequest(JSON.stringify({type:'request',...question,requestKind})),/kind/);
});
