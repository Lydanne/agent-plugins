import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runAppServerTurn} from './codex-app-server.mjs';

function fixture(t,mode='live'){
 const root=mkdtempSync(join(tmpdir(),'worker-live-rpc-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const script=join(root,'server.mjs');
 writeFileSync(script,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
 const send=x=>console.log(JSON.stringify(x));const toolCall={threadId:'${mode}'==='tool-wrong-scope'?'other':'thread-fixture',turnId:'turn-fixture',tool:'${mode}'==='tool-unknown'?'exec_command':'fixture_tool',callId:'call-fixture',arguments:{id:'fixture'}};const done=()=>{send({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{type:'agentMessage',text:'guided result',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});};
 for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);appendFileSync('requests.jsonl',line+'\\n');
 if(r.method==='initialize')send({id:r.id,result:{}});
 if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:'thread-fixture'}}});
 if(r.method==='turn/start'){send({id:r.id,result:{turn:{id:'turn-fixture'}}});send({method:'turn/started',params:{threadId:'thread-fixture',turn:{id:'turn-fixture'}}});if('${mode}'==='refresh'){send({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{type:'commandExecution',command:'forbidden'}}});}if('${mode}'==='complete')done();if('${mode}'.startsWith('tool')){send({id:'tool-call',method:'item/tool/call',params:toolCall});if('${mode}'==='tool-early-complete')done();}}
 if(r.id==='tool-call'&&!r.method){if('${mode}'==='tool-duplicate')send({id:'tool-replay',method:'item/tool/call',params:toolCall});else done();}if(r.id==='tool-replay'&&!r.method)done();
 if(r.method==='turn/steer'){if('${mode}'==='reject'){send({id:r.id,error:{code:-32600,message:'stale turn'}});setTimeout(done,10);}else{send({id:r.id,result:{turnId:'turn-fixture'}});setTimeout(done,10);}}
 }`);
 return {root,options:{invocation:{command:process.execPath,args:[script]},config:{cwd:root,model:'fixture',approvalMode:'read-only',executorInstructions:'Only fixture',reasoningEffort:'low'},prompt:'original',deadline:Date.now()+5000,env:{PATH:process.env.PATH,CODEX_HOME:root},signal:new AbortController().signal}};
}
test('steers the current turn without interrupt, new turn or lost execution policy',async t=>{
 const f=fixture(t);let receipt,pending;
 const result=await runAppServerTurn({...f.options,onLiveSteering:turn=>{if(turn)pending=turn.send({id:'supplement-fixture',text:'new evidence'}).then(r=>{receipt=r;});}});
 await pending;assert.equal(result,'guided result');assert.equal(receipt.turnId,'turn-fixture');
 const requests=readFileSync(join(f.root,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(requests.filter(r=>r.method==='turn/start').length,1);
 assert.equal(requests.filter(r=>r.method==='turn/interrupt').length,0);
 const steer=requests.find(r=>r.method==='turn/steer').params;
 assert.equal(steer.expectedTurnId,'turn-fixture');assert.equal(steer.clientUserMessageId,'supplement-fixture');assert.equal(steer.input[0].text,'new evidence');
 const start=requests.find(r=>r.method==='thread/start').params;assert.equal(start.sandbox,'read-only');assert.equal(start.approvalPolicy,'never');assert.equal(start.model,'fixture');
});
test('explicit RPC rejection is distinguishable from uncertain transport failure',async t=>{
 const f=fixture(t,'reject');let pending;
 await runAppServerTurn({...f.options,onLiveSteering:turn=>{if(turn)pending=assert.rejects(turn.send({id:'x',text:'hint'}),e=>e.definitelyRejected===true);}});await pending;
});
test('resume refuses a different thread rather than starting business on it',async t=>{
 const f=fixture(t,'complete');await assert.rejects(runAppServerTurn({...f.options,threadId:'different-thread'}),/cannot be resumed safely/);
 const requests=readFileSync(join(f.root,'requests.jsonl'),'utf8');assert.ok(!requests.includes('turn/start'));
});
test('read-only skill refresh never exposes live steering and rejects tool events',async t=>{
 const f=fixture(t,'refresh');let published=false;
 await assert.rejects(runAppServerTurn({...f.options,refresh:true,onLiveSteering:turn=>{if(turn)published=true;}}),/Skill refresh attempted/);assert.equal(published,false);
});
test('executeQuery selects the live Hermes adapter and preserves the result/session contract',async t=>{
 const f=fixture(t);const {executeQuery}=await import('./index.mjs');const {resolveConfiguration}=await import('./configuration.mjs');
 const config=resolveConfiguration({state:join(f.root,'state'),cwd:f.root,codexHome:join(f.root,'codex'),skillsEnabled:false,memoryRequired:false,approvalMode:'read-only',hermesTemplates:{live:{name:'fixture',adapter:'codex-app-server',command:process.execPath,args:f.options.invocation.args,resumeArgs:['{{sessionId}}'],stdin:'{{prompt}}',variables:{}}},taskQueues:{short:{name:'fixture',timeoutMs:10000,maxConcurrentJobs:1,maxQueuedJobs:2,hermesTemplateId:'live',hermesVariables:{model:'fixture'}}}});
 let pending;
 const response=await executeQuery({action:'run',topic:'live-fixture',task:'read fixture',context:'fixture',constraints:'read only'},{sessionKey:'live-fixture',onLiveSteering:turn=>{if(turn)pending=turn.send({id:'fixture-hint',text:'additional evidence'});}},config);
 await pending;const result=JSON.parse(response.content[0].text);assert.equal(result.result,'guided result');assert.equal(result.sessionId,'thread-fixture');assert.equal(result.hermesTemplateId,'live');
});

const definitions=[{type:'function',name:'fixture_tool',description:'Fixture only',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}}];
const requestsOf=f=>readFileSync(join(f.root,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
test('dynamic tool calls are dispatched to the host bridge in the active turn',async t=>{
 const f=fixture(t,'tool');let calls=0;
 await runAppServerTurn({...f.options,toolBridge:{definitions,invoke:async input=>{calls++;assert.equal(input.name,'fixture_tool');assert.equal(input.callId,'call-fixture');assert.deepEqual(input.arguments,{id:'fixture'});assert.equal(input.signal.aborted,false);return {value:'authorized'};}}});
 const requests=requestsOf(f);assert.equal(calls,1);assert.deepEqual(requests.find(r=>r.method==='thread/start').params.dynamicTools,definitions);
 assert.deepEqual(requests.find(r=>r.id==='tool-call').result,{success:true,contentItems:[{type:'inputText',text:'{"value":"authorized"}'}]});
});
for(const mode of ['tool-wrong-scope','tool-unknown','tool-refresh'])test('dynamic tool bridge refuses '+mode,async t=>{
 const f=fixture(t,mode);let calls=0;
 await runAppServerTurn({...f.options,refresh:mode==='tool-refresh',toolBridge:{definitions,invoke:async()=>{calls++;return {};}}});
 assert.equal(calls,0);assert.equal(requestsOf(f).find(r=>r.id==='tool-call').result.success,false);
});
test('duplicate dynamic calls are not re-executed and provider errors stay private',async t=>{
 const f=fixture(t,'tool-duplicate');let calls=0;
 await runAppServerTurn({...f.options,toolBridge:{definitions,invoke:async()=>{calls++;throw Error('private-provider-token');}}});
 assert.equal(calls,1);const requests=requestsOf(f);assert.equal(requests.find(r=>r.id==='tool-call').result.success,false);assert.equal(requests.find(r=>r.id==='tool-replay').result.success,false);
 assert.ok(!JSON.stringify(requests).includes('private-provider-token'));
});
test('premature turn completion aborts outstanding dynamic operations',async t=>{
 const f=fixture(t,'tool-early-complete');let aborted=false;
 await assert.rejects(runAppServerTurn({...f.options,toolBridge:{definitions,invoke:async({signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'));},{once:true}))}}),/unfinished Worker tools/);
 assert.equal(aborted,true);
});
