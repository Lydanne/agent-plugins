import test from 'node:test';
import assert from 'node:assert/strict';
import {cliParameters,cliSession,connectCli,sessionOutput,registerPluginCli} from './plugin-cli.mjs';
class Command {
 constructor(name='program'){this.name=name;this.children=[];}
 command(name){const c=new Command(name);this.children.push(c);return c;}
 description(){return this;}
 option(){return this;}
 requiredOption(){return this;}
 action(handler){this.handler=handler;return this;}
 get(...path){return path.length?this.children.find(c=>c.name===path[0])?.get(...path.slice(1)):this;}
}
function setup(spec,request=async()=>({ok:true,output:{content:[{type:'text',text:'{"value":1}'}]}})){
 const program=new Command(),output=[],calls=[];let closed=0,connected=0,registration;
 registerPluginCli({registerCli(callback,metadata){registration=metadata;callback({program,config:{fixture:true}});}},spec,{env:{},write:v=>output.push(v),connect:async()=>{connected++;return {request:async(...args)=>{calls.push(args);return request(...args);},close(){closed++;}};}});
 return {program,output,calls,registration,get closed(){return closed;},get connected(){return connected;}};
}
const spec={pluginId:'agent-repo',tools:[{name:'agent_repo',actions:['list','people_stats']},{name:'agent_entity_sync',command:'entity-sync',actions:['upsert']}],actions:['list','chunk','workspacePoolSave','diagnosticStart','diagnosticRead','diagnosticRenew','diagnosticStop'],prefix:'projects-'};
const options={agent:'main'};
test('JSON input rejects ambiguous, oversized and non-object input before any call',async()=>{
 assert.deepEqual(await cliParameters({params:'{"confirmed":false}'}),{confirmed:false});
 assert.deepEqual(await cliParameters({paramsFile:'fixture'},async()=>'{"id":"abc"}'),{id:'abc'});
 for(const p of [{params:'{}',paramsFile:'x'},{params:'null'},{params:'[]'},{params:'{'},{params:'"'+('a'.repeat(1024*1024))+'"'}])await assert.rejects(cliParameters(p));
});
test('Agent and session must agree; no inferred cross-Agent targeting',()=>{
 assert.equal(cliSession(options),'agent:main:main');
 assert.equal(cliSession({...options,session:'agent:main:feishu:group:fixture'}),'agent:main:feishu:group:fixture');
 for(const o of [{},{agent:'../x'},{agent:'main',session:'agent:other:main'}])assert.throws(()=>cliSession(o));
});
test('registers lazy descriptors and every tool/action; preserves raw arguments',async()=>{
 const f=setup(spec);assert.deepEqual(f.registration.commands,['agent-repo']);
 await f.program.get('agent-repo','people-stats').handler({...options,params:'{"query":"测试"}'});
 assert.deepEqual(f.calls,[['tools.invoke',{name:'agent_repo',agentId:'main',sessionKey:'agent:main:main',args:{query:'测试',action:'people_stats'}}]]);
 assert.deepEqual(f.output,[{ok:true,result:{value:1}}]);assert.equal(f.closed,1);
 assert.ok(f.program.get('agent-repo','entity-sync','upsert'));
 assert.ok(f.program.get('agent-repo','manage','workspace-pool-save'));
 assert.equal(f.program.get('agent-repo','manage','chunk'),undefined);
});
test('conflicting action and tool denial yield nonzero status, never retry',async()=>{
 const old=process.exitCode;
 try{
  const f=setup(spec,async()=>({ok:false,error:{message:'denied'}}));
  await f.program.get('agent-repo','list').handler({...options,params:'{"action":"sync"}'});
  assert.equal(f.calls.length,0);assert.equal(f.output[0].ok,false);assert.equal(process.exitCode,1);
  await f.program.get('agent-repo','list').handler(options);
  assert.equal(f.calls.length,1);assert.equal(f.output[1].error.message,'denied');assert.equal(f.closed,2);
 }finally{process.exitCode=old;}
});
test('management forwards confirmations and revisions unchanged; server failures remain failures',async()=>{
 const old=process.exitCode;
 try{
  const f=setup(spec,async()=>({ok:false,error:'revision changed',code:'CONFLICT'}));
  const input={confirmed:false,expectedRevision:'r1',requestId:'stable',maxSize:3};
  await f.program.get('agent-repo','manage','workspace-pool-save').handler({...options,params:JSON.stringify(input)});
  assert.deepEqual(f.calls[0],['plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-workspacePoolSave',agentId:'main',sessionKey:'agent:main:main',payload:input}]);
  assert.equal(f.output[0].ok,false);assert.equal(f.closed,1);
 }finally{process.exitCode=old;}
});
test('chunks reassemble sequentially on same RPC and reject mixed transfers',async()=>{
 const calls=[],text=JSON.stringify({data:'中'.repeat(33000)});
 const rpc=async(m,p)=>{calls.push([m,p]);const i=p.actionId==='projects-list'?0:p.payload.index;return {ok:true,result:{encoding:'json-chunks',transferId:'t',totalChunks:2,index:i,chunk:text.slice(i*32000,(i+1)*32000)}};};
 assert.equal((await sessionOutput(rpc,'agent-repo','projects-','list',{agentId:'main',sessionKey:'agent:main:main'},{})).data.length,33000);
 assert.equal(calls.length,2);assert.deepEqual(calls[1][1].payload,{transferId:'t',index:1});
 await assert.rejects(sessionOutput(async()=>({ok:true,result:{encoding:'json-chunks',transferId:'t',totalChunks:1,index:1,chunk:'{}'}}),'p','x-','list',{},{}),/Incomplete/);
});
test('diagnostic watch uses one connection, cleans up after read failure',async()=>{
 const old=process.exitCode;
 try{
  const f=setup(spec,async(_m,p)=>p.actionId==='projects-diagnosticStart'?{ok:true,result:{leaseId:'lease'}}:p.actionId==='projects-diagnosticRead'?{ok:false,error:'capture failed'}:{ok:true,result:{stopped:true}});
  await f.program.get('agent-repo','manage','diagnostic-watch').handler({...options,duration:'1'});
  assert.equal(f.connected,1);assert.equal(f.closed,1);
  assert.deepEqual(f.calls.map(c=>c[1].actionId),['projects-diagnosticStart','projects-diagnosticRead','projects-diagnosticStop']);
  assert.equal(f.output[0].ok,false);
 }finally{process.exitCode=old;}
});
test('automation submit uses client to prepare host-selected session and rejects Agent conflict',async()=>{
 const old=process.exitCode;
 try{
  const f=setup({...spec,automation:['submit','get','cancel','rerun'],automationClient:rpc=>({submit:async p=>{const t=await rpc('agent-repo.automation.submit',p);await rpc('sessions.create',{key:t.sessionKey,agentId:p.agentId});return t;},rerun:async(...p)=>({rerun:p})})},async()=>({sessionKey:'agent:main:automation:fixture',taskId:'task'}));
  await f.program.get('agent-repo','automation','submit').handler({...options,params:'{"requestKey":"stable"}'});
  assert.equal(f.calls[0][1].agentId,'main');assert.equal(f.calls[1][0],'sessions.create');
  await f.program.get('agent-repo','automation','submit').handler({...options,params:'{"agentId":"other"}'});
  assert.equal(f.calls.length,2);assert.equal(f.output[1].ok,false);
 }finally{process.exitCode=old;}
});
test('transport keeps authentication and connection scoped; explicit URL never inherits config secret',async()=>{
 const clients=[];
 class Client {constructor(o){this.o=o;clients.push(this);}start(){queueMicrotask(()=>this.o.onHelloOk({}));}request(...args){this.args=args;return Promise.resolve({});}stop(){this.stopped=true;}}
 const sdk={GatewayClient:Client,resolveGatewayAuth:()=>({token:'local-secret'})};
 const connection=await connectCli({gateway:{port:12345}},{timeout:'1000'},{sdk,env:{}});
 assert.equal(clients[0].o.url,'ws://127.0.0.1:12345');assert.equal(clients[0].o.token,'local-secret');
 await connection.request('tools.invoke',{});await connection.request('plugins.sessionAction',{});assert.equal(clients.length,1);
 clients[0].o.onClose();assert.throws(()=>connection.request('tools.invoke',{}),/connection lost/);connection.close();
 const remote=await connectCli({gateway:{auth:{token:'local-secret'}}},{url:'wss://example.invalid',timeout:'1000'},{sdk,env:{}});
 assert.equal(clients[1].o.token,undefined);remote.close();
 await assert.rejects(connectCli({}, {timeout:'0'}, {sdk,env:{}}));
});
test('transport authentication errors close client without retrying a mutation',async()=>{
 let stopped=false,requests=0;
 class Client {constructor(o){this.o=o;}start(){queueMicrotask(()=>this.o.onConnectError(Error('authentication denied')));}stop(){stopped=true;}request(){requests++;}}
 await assert.rejects(connectCli({}, {timeout:'100'}, {sdk:{GatewayClient:Client,resolveGatewayAuth:()=>({})},env:{}}),/authentication denied/);
 assert.equal(stopped,true);assert.equal(requests,0);
});
test('source-bound result tool forwards only schema fields without adding an action',async()=>{
 const f=setup({...spec,tools:[...spec.tools,{name:'agent_task_result',command:'task-result'}]});
 await f.program.get('agent-repo','task-result').handler({...options,params:'{"outcome":"blocked","result":{"reason":"fixture"}}'});
 assert.deepEqual(f.calls[0][1].args,{outcome:'blocked',result:{reason:'fixture'}});
});
test('diagnostic watch uses the actual diagnostic hub cursor contract and stops its lease',async()=>{
 const {createDiagnosticHub,registerDiagnosticSource}=await import('./diagnostics.mjs');
 const source=registerDiagnosticSource({apiVersion:1,id:'cli-fixture',pluginId:'cli-fixture',label:'CLI fixture',open:async()=>({read:async()=>[],close(){}})},Symbol('cli-test'));
 const hub=createDiagnosticHub(),old=process.exitCode;
 try{
  const f=setup(spec,async(_m,p)=>({ok:true,result:await hub.actions[p.actionId.slice('projects-'.length)]({agentId:'main',client:{connId:'fixture',scopes:['operator.admin']},payload:p.payload})}));
  await f.program.get('agent-repo','manage','diagnostic-watch').handler({...options,duration:'1',params:'{"sourceIds":["cli-fixture"]}'});
  assert.equal(f.output.at(-1).ok,true);assert.equal(f.output.at(-1).result.stopped,true);
  assert.equal(f.calls.find(c=>c[1].actionId==='projects-diagnosticRead')[1].payload.afterSeq,0);
 }finally{hub.dispose();source.dispose();process.exitCode=old;}
});

test('generic plugin discovery/describe/call outside a Worker never becomes an operator tool invocation',async()=>{
 const old=process.exitCode;
 try{
  const f=setup({...spec,pluginId:'agent-worker'});
  for(const action of ['list','describe','call'])await f.program.get('agent-worker','plugin',action).handler({...options,tool:'dangerous_tool'});
  assert.equal(f.calls.length,0);assert.equal(f.output.length,3);assert.ok(f.output.every(value=>value.ok===false));
 }finally{process.exitCode=old;}
});
