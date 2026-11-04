import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodexWorkerBridge} from './codex-worker-tools.mjs';
const lease={url:'http://127.0.0.1:1234/invoke',token:'fixture-private-token',context:{version:1,workerId:'worker',jobId:'job',agentId:'ada',sessionKey:'agent:ada:fixture'}};
test('dynamic bridge exposes no credentials and only uses task-bound discovery/describe/call RPC',async()=>{
 const requests=[];let closed=0;
 const bridge=createCodexWorkerBridge(lease,{connect:async(options,env)=>{assert.equal(env.OPENCLAW_JOB_ID,'job');assert.equal(env.OPENCLAW_WORKER_CLI_TOKEN,lease.token);assert.equal(options.timeout,30000);return {request:async(...args)=>{requests.push(args);return {ok:true};},close:()=>closed++};}});
 assert.ok(!JSON.stringify(bridge.definitions).includes(lease.token));
 for(const args of [{action:'catalog'},{action:'describe',tool:'fixture'},{action:'call',tool:'fixture',args:{id:'selected'}}])assert.deepEqual(await bridge.invoke({name:'worker_plugin',arguments:args}),{ok:true});
 assert.deepEqual(requests,[['worker.catalog',{}],['tools.invoke',{name:'fixture'},{describe:true}],['tools.invoke',{name:'fixture',args:{id:'selected'}},{}]]);assert.equal(closed,3);
 assert.equal(createCodexWorkerBridge(),undefined);
});
test('malformed operations and cancelled turns never acquire a plugin connection',async()=>{
 let connections=0;const bridge=createCodexWorkerBridge(lease,{connect:async()=>{connections++;}});
 for(const args of [null,[],{}, {action:'arbitrary.rpc'},{action:'catalog',tool:'fixture'},{action:'call',tool:'fixture',accountId:'other'},{action:'describe',tool:'fixture',args:{}},{action:'call',tool:'fixture',args:[]},{action:'call',tool:''}])await assert.rejects(bridge.invoke({name:'worker_plugin',arguments:args}));
 await assert.rejects(bridge.invoke({name:'exec_command',arguments:{action:'catalog'}}));
 await assert.rejects(bridge.invoke({name:'worker_plugin',arguments:{action:'catalog'},signal:AbortSignal.abort()}));assert.equal(connections,0);
});
test('connection is closed even when execution permission is refused',async()=>{
 let closed=false;const bridge=createCodexWorkerBridge(lease,{connect:async()=>({request:async()=>{throw Error('Permission denied');},close:()=>closed=true})});
 await assert.rejects(bridge.invoke({name:'worker_plugin',arguments:{action:'call',tool:'fixture'}}),/Permission denied/);assert.equal(closed,true);
});
