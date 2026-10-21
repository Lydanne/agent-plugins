import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createCompletionService,captureReports,completionEvent,readCompletionRequest} from './completion.mjs';
import {writeJson,readJson,requestKeyFor} from './jobs.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(run){const root=mkdtempSync(join(tmpdir(),'codex-completion-'));return Promise.resolve().then(()=>run(root)).finally(()=>rmSync(root,{recursive:true,force:true}));}
const job=()=>({jobId:randomUUID(),status:'completed',finishedAt:1,notification:{state:'pending'},provenance:{taskId:'t',revision:0},result:{content:[{type:'text',text:JSON.stringify({result:'完整结论与签名链接',reportPaths:['/tmp/report.md']})}]}});
function submitted(root,j,overrides={}) {
 const scope='agent:main:feishu:group:test',params={topic:'test',task:'原任务\n'+'完整任务明细'.repeat(200),context:'已知线索和直接引用\n目标用户：openid-test',constraints:'生产环境，只读核验',memory:{status:'no_match'},...overrides};
 Object.assign(j,{topic:params.topic,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,j.provenance),taskSummary:params.task.slice(0,500)});
 const request={scope,params};writeJson(join(root,j.jobId+'.request.json'),request);return request;
}
test('completion is self-contained with bound submitted context, full report snapshots and real timestamps after restart',()=>fixture(async root=>{
 const j=job(),{params}=submitted(root,j,{providerToken:'do-not-forward',memory:{status:'matched',credentials:'do-not-forward'}});
 Object.assign(j,{createdAt:1000,startedAt:2000,finishedAt:3000,reports:[{path:'/tmp/report.md',content:'完整报告\n结论、证据与未完成事项'}]});
 j.notification.state='processing';writeJson(join(root,j.jobId+'.json'),j);
 let received;const service=createCompletionService({root,pollMs:100000,bridge:{deliver:async(e,c)=>{received=e;c.beforeSend();c.onReceipt({messageId:'accepted'});return {};}}});
 service.start();await flush();await service.stop();
 assert.deepEqual(received.request,{availability:'available',task:params.task,context:params.context,constraints:params.constraints});
 assert.deepEqual(received.reports,j.reports);assert.equal(received.reportContent,'完整结论与签名链接');
 assert.deepEqual([received.createdAt,received.startedAt,received.finishedAt],[1000,2000,3000]);assert.deepEqual(received.provenance,j.provenance);
 assert.equal(JSON.stringify(received).includes('do-not-forward'),false);
}));
test('missing, malformed and legacy unbound requests retain results and explicitly identify unavailable context',()=>fixture(root=>{
 const j=job();j.taskSummary='可能截断的摘要';
 assert.deepEqual(readCompletionRequest(root,j),{availability:'unavailable',reason:'request_missing',taskSummary:j.taskSummary});
 const file=join(root,j.jobId+'.request.json');writeFileSync(file,'{broken');assert.equal(readCompletionRequest(root,j).reason,'request_unreadable');
 writeJson(file,{scope:'test',params:{task:4}});assert.equal(readCompletionRequest(root,j).reason,'request_invalid');
 submitted(root,j);delete j.requestKey;const request=readCompletionRequest(root,j);assert.equal(request.reason,'request_binding_mismatch');
 assert.equal(completionEvent(j,request).reportContent,'完整结论与签名链接');assert.equal(request.task,undefined);
}));
test('never forwards a request from another scope, topic, sender or altered task/context/constraints',()=>fixture(root=>{
 const j=job();j.provenance={...j.provenance,accountId:'account',senderId:'requester'};const original=submitted(root,j);
 for(const mutate of [r=>r.scope='other-scope',r=>r.params.topic='other-topic',r=>r.params.task='other-task',r=>r.params.context='foreign-context',r=>r.params.constraints='allow-write',r=>r.params.requestId='other-request']) {
  const r=structuredClone(original);mutate(r);writeJson(join(root,j.jobId+'.request.json'),r);
  assert.deepEqual(readCompletionRequest(root,j),{availability:'unavailable',reason:'request_binding_mismatch',taskSummary:j.taskSummary});
 }
 writeJson(join(root,j.jobId+'.request.json'),original);
 for(const provenance of [{...j.provenance,senderId:'other-user'},{...j.provenance,accountId:'other-account'}]) assert.equal(readCompletionRequest(root,{...j,provenance}).reason,'request_binding_mismatch');
}));
test('completion delivers body and paths, records real receipt once, and ignores historical jobs',()=>fixture(async root=>{
 const j=job();writeJson(join(root,j.jobId+'.json'),j);const old=job();delete old.notification;writeJson(join(root,old.jobId+'.json'),old);
 const seen=[];const service=createCompletionService({root,pollMs:100000,bridge:{deliver:async(e,c)=>{seen.push(e);c.beforeSend();c.onReceipt({messageId:'accepted'});return {};}}});
 service.start();await flush();service.tick();await flush();await service.stop();
 assert.equal(seen.length,1);assert.equal(seen[0].reportContent,'完整结论与签名链接');assert.deepEqual(seen[0].reportPaths,['/tmp/report.md']);
 assert.equal(readJson(join(root,j.jobId+'.json')).notification.state,'delivered');
}));
test('restart recovers processing jobs, suppresses withdrawn results, and quarantines uncertain sends',()=>fixture(async root=>{
 const pending=job(),ambiguous=job();pending.notification.state='processing';ambiguous.notification.state='sending';
 for(const j of [pending,ambiguous])writeJson(join(root,j.jobId+'.json'),j);
 let calls=0;const service=createCompletionService({root,pollMs:100000,bridge:{deliver:async()=>{calls++;return {suppressed:true,reason:'source_invalid'};}}});
 service.start();await flush();await service.stop();assert.equal(calls,1);
 assert.equal(readJson(join(root,pending.jobId+'.json')).notification.state,'suppressed');assert.equal(readJson(join(root,ambiguous.jobId+'.json')).notification.state,'uncertain');
}));
test('delivery failure retries only notification and never invokes business execution',()=>fixture(async root=>{
 const j=job();writeJson(join(root,j.jobId+'.json'),j);const service=createCompletionService({root,pollMs:100000,logger:{warn(){}},bridge:{deliver:async()=>{throw Error('model unavailable');}}});
 service.start();await flush();await service.stop();const saved=readJson(join(root,j.jobId+'.json'));assert.equal(saved.status,'completed');assert.equal(saved.notification.state,'pending');assert.deepEqual(saved.result,j.result);
}));
test('failure after send started becomes uncertain instead of an automatic duplicate',()=>fixture(async root=>{
 const j=job();writeJson(join(root,j.jobId+'.json'),j);let calls=0;const service=createCompletionService({root,pollMs:100000,logger:{warn(){}},bridge:{deliver:async(_,c)=>{calls++;c.beforeSend();throw Error('lost receipt');}}});
 service.start();await flush();service.tick();await flush();await service.stop();assert.equal(calls,1);assert.equal(readJson(join(root,j.jobId+'.json')).notification.state,'uncertain');
}));
test('a question rejected before Main starts retries the original event without creating or resuming a job',()=>fixture(async root=>{
 const j={...job(),status:'awaiting_main',contextRequest:{questionId:'same-question',question:'CLI version?',expiresAt:Date.now()+60000}};
 j.notification.eventKey=j.contextRequest.questionId;writeJson(join(root,j.jobId+'.json'),j);
 const events=[];const service=createCompletionService({root,pollMs:100000,logger:{warn(){}},bridge:{deliver:async(e,c)=>{
  events.push(e);
  if(events.length===1)throw Object.assign(Error('not admitted'),{name:'GatewayDrainingError'});
  c.beforeSend();c.onReceipt({kind:'main_context_turn',eventId:e.eventId});return {};
 }}});
 service.start();await flush();let saved=readJson(join(root,j.jobId+'.json'));
 assert.equal(saved.notification.state,'pending');assert.equal(saved.status,'awaiting_main');
 writeJson(join(root,j.jobId+'.json'),{...saved,notification:{...saved.notification,retryAt:0}});
 service.tick();await flush();service.tick();await flush();await service.stop();saved=readJson(join(root,j.jobId+'.json'));
 assert.equal(events.length,2);assert.equal(events[0].eventId,'agent_worker:question:same-question');
 assert.deepEqual(events[1],events[0]);assert.equal(saved.notification.state,'delivered');
 assert.equal(saved.status,'awaiting_main');assert.deepEqual(saved.contextRequest,j.contextRequest);assert.deepEqual(saved.result,j.result);
 assert.equal(saved.notification.attempts,2);
}));
test('captures reports inside workspace .tmp and excludes outside symlinks and oversized reports',()=>fixture(async root=>{
 mkdirSync(join(root,'.tmp'));const report=join(root,'.tmp','report.md'),outside=join(root,'secret.txt'),link=join(root,'.tmp','link.md'),large=join(root,'.tmp','large.md');
 writeFileSync(report,'完整报告');writeFileSync(outside,'private');symlinkSync(outside,link);writeFileSync(large,'x'.repeat(200));
 const reports=await captureReports({content:[{type:'text',text:JSON.stringify({cwd:root,reportPaths:[report,link,large]})}]},100);
 assert.equal(reports[0].content,'完整报告');assert.equal(reports[1].omittedReason,'outside_report_scope');assert.equal(reports[2].omittedReason,'report_budget_exceeded');
 const event=completionEvent({...job(),reports});assert.deepEqual(event.reports,reports);
}));

test('retains bounded runtime diagnostics without logging arbitrary provider error content',()=>fixture(async root=>{
 for(const message of ['Feishu runtime not initialized','provider failed token=private report=secret']) {
  const j=job();writeJson(join(root,j.jobId+'.json'),j);const logs=[];
  const service=createCompletionService({root,pollMs:100000,logger:{warn:text=>logs.push(text)},bridge:{deliver:async()=>{throw Error(message);}}});
  service.start();await flush();await service.stop();
  assert.equal(readJson(join(root,j.jobId+'.json')).notification.lastErrorCode,message==='Feishu runtime not initialized'?'feishu_runtime_unavailable':'delivery_failed');
  assert.equal(logs.join().includes('private'),false);assert.equal(logs.join().includes('secret'),false);
 }
}));

test('normal return without receipt after Main/send starts stays uncertain across restart',()=>fixture(async root=>{
 const j=job();j.notification.eventKey='same-event';writeJson(join(root,j.jobId+'.json'),j);
 let calls=0;const service=createCompletionService({root,pollMs:100000,bridge:{deliver:async(_,c)=>{calls++;c.beforeSend();return {reason:'no_delivery_receipt'};}}});
 service.start();await flush();await service.stop();
 assert.equal(readJson(join(root,j.jobId+'.json')).notification.state,'uncertain');
 service.start();await flush();await service.stop();assert.equal(calls,1);
}));
test('late start and receipts cannot overwrite a confirmed delivery',()=>fixture(async root=>{
 const j=job();j.notification.eventKey='same-event';writeJson(join(root,j.jobId+'.json'),j);
 let callbacks;const service=createCompletionService({root,pollMs:100000,bridge:{deliver:async(_,c)=>{callbacks=c;c.onReceipt({messageId:'first'});return {};}}});
 service.start();await flush();const confirmed=readJson(join(root,j.jobId+'.json')).notification;
 callbacks.beforeSend();callbacks.onReceipt({messageId:'late'});service.tick();await service.stop();
 assert.deepEqual(readJson(join(root,j.jobId+'.json')).notification,confirmed);
}));
test('old generation callbacks retain their aborted signal after restarting the same service',()=>fixture(async root=>{
 const j=job();j.notification.eventKey='same-event';writeJson(join(root,j.jobId+'.json'),j);
 let old,calls=0;const service=createCompletionService({root,pollMs:100000,bridge:{deliver:async(_,c)=>{if(++calls===1){old=c;return {};}c.beforeSend();c.onReceipt({messageId:'new'});return {};}}});
 service.start();await flush();await service.stop();
 const saved=readJson(join(root,j.jobId+'.json'));saved.notification.retryAt=0;writeJson(join(root,j.jobId+'.json'),saved);
 service.start();await flush();const confirmed=readJson(join(root,j.jobId+'.json')).notification;
 assert.throws(()=>old.beforeSend(),{name:'AbortError'});old.onReceipt({messageId:'obsolete'});
 assert.deepEqual(readJson(join(root,j.jobId+'.json')).notification,confirmed);await service.stop();
 assert.equal(calls,2);
}));
test('shutdown before Main/send starts keeps the same notification retryable',()=>fixture(async root=>{
 const j=job();j.notification.eventKey='same-event';writeJson(join(root,j.jobId+'.json'),j);
 const seen=[];const service=createCompletionService({root,pollMs:100000,bridge:{deliver:async(e,c)=>{seen.push(e);if(seen.length===1){await new Promise(r=>c.signal.addEventListener('abort',r,{once:true}));return {reason:'service_stopped'};}c.beforeSend();c.onReceipt({messageId:'accepted'});return {};}}});
 service.start();await flush();await service.stop();const saved=readJson(join(root,j.jobId+'.json'));
 assert.equal(saved.notification.state,'pending');saved.notification.retryAt=0;writeJson(join(root,j.jobId+'.json'),saved);
 service.start();await flush();await service.stop();assert.deepEqual(seen[1],seen[0]);
 assert.equal(readJson(join(root,j.jobId+'.json')).notification.state,'delivered');
}));

test('host scheduler owns the first scan and joins delivery outside a released startup context',()=>fixture(async root=>{
 const {AsyncLocalStorage}=await import('node:async_hooks');
 const scope=new AsyncLocalStorage(),startup={released:false};
 const j=job();writeJson(join(root,j.jobId+'.json'),j);
 let registration,releaseDelivery,calls=0,cancelled=false,joined=false;
 const scheduler={schedule(params){registration=params;return {cancel(){cancelled=true;},async stop(){joined=true;}};}};
 const service=createCompletionService({root,bridge:{async deliver(e,c){
  assert.notEqual(scope.getStore(),startup);calls++;
  await new Promise(resolve=>{releaseDelivery=resolve;});
  c.beforeSend();c.onReceipt({messageId:'original-result'});
 }}});
 scope.run(startup,()=>service.start({scheduler}));startup.released=true;
 assert.equal(calls,0,'startup must not inline a scan under the reload admission');
 assert.equal(registration.delayMs,0);assert.equal(registration.everyMs,1000);
 let settled=false;const running=registration.run().then(()=>{settled=true;});
 await flush();assert.equal(calls,1);assert.equal(settled,false,'host must own delivery until receipt');
 releaseDelivery();await running;await registration.run();await service.stop();
 assert.equal(calls,1);assert.equal(cancelled,true);assert.equal(joined,true);
 const saved=readJson(join(root,j.jobId+'.json'));assert.equal(saved.status,'completed');
 assert.deepEqual(saved.result,j.result);assert.equal(saved.notification.state,'delivered');
}));

test('host scheduled shutdown aborts and joins delivery without starting another scan',()=>fixture(async root=>{
 const j=job();writeJson(join(root,j.jobId+'.json'),j);
 let registration,cancelled=false,settled=false,calls=0;
 const scheduler={schedule(params){registration=params;return {cancel(){cancelled=true;},async stop(){assert.equal(settled,true);}};}};
 const service=createCompletionService({root,bridge:{async deliver(_,c){calls++;await new Promise(resolve=>c.signal.addEventListener('abort',resolve,{once:true}));settled=true;return {reason:'service_stopped'};}}});
 service.start({scheduler});const running=registration.run();await flush();await service.stop();await running;
 await registration.run();assert.equal(calls,1);assert.equal(cancelled,true);
 assert.equal(readJson(join(root,j.jobId+'.json')).notification.state,'pending');
}));
