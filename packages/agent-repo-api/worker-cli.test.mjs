import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkerCliService,workerContextApi,workerCliEnvironment,connectWorkerCli,readWorkerCliContext,prepareWorkerCliOptions} from './worker-cli.mjs';
const p={agentId:'main',sessionKey:'agent:main:feishu:group:test',accountId:'a',chatId:'c',senderId:'u',taskId:'source',revision:1};
async function fixture({runPolicy,execute,pollMs=10}={}){
 let status='running',authorized=true,workerId='execution-one';const seen=[],hooks=[];let factory;
 workerContextApi({registerTool:f=>{factory=f;}}).registerTool(context=>({name:'fixture_read',parameters:{type:'object',properties:{requester:{const:context.requesterSenderId}}},execute:async(id,args,signal)=>{seen.push({context,args,id,signal});return execute?execute(args,signal):{value:args.id};}}));
 const service=createWorkerCliService({getConfig:()=>({}),getJob:()=>({status,workerId,provenance:p}),authorize:()=>authorized,pollMs,
 prepareContext:async b=>({agentId:p.agentId,sessionKey:p.sessionKey,requesterSenderId:p.senderId,senderIsOwner:false,agentAccountId:p.accountId,messageChannel:'feishu',messageTo:'chat:c',sessionId:'session'}),
 createSurface:async options=>[{pluginId:'fixture',tool:factory(options)},...['agent_repo','agent_task_result','feishu_doc'].map(name=>({pluginId:'fixture',tool:{name,parameters:{},execute:()=>{throw Error('must not execute');}}}))],
 runPolicy:async input=>{hooks.push(input);return runPolicy?runPolicy(input):{params:input.params,blocked:false};}});
 await service.start();const lease=service.issue({jobId:'job',workerId,provenance:p,projectId:'project'},{params:{task:'read',constraints:'read-only'},runtime:{}}),env=workerCliEnvironment(lease),cli=await connectWorkerCli({},env);
 return {service,cli,env,seen,hooks,lease,setStatus:value=>status=value,setAuthorized:value=>authorized=value,setWorker:value=>workerId=value};
}
test('task-bound CLI keeps identity outside arguments and runs original requester policy once',async()=>{
 const f=await fixture({runPolicy:async input=>({params:{...input.params,id:'hook-result'}})});
 try{
  assert.equal(f.env.OPENCLAW_WORKER_ID,'execution-one');assert.equal(f.env.OPENCLAW_GATEWAY_TOKEN,undefined);assert.equal(readWorkerCliContext(f.env).constraints,undefined);
  assert.throws(()=>readWorkerCliContext({...f.env,OPENCLAW_JOB_ID:'other'}));await assert.rejects(connectWorkerCli({agent:'other'},f.env));await assert.rejects(connectWorkerCli({url:'http://other'},f.env));
  assert.equal((await f.cli.request('worker.context',{})).jobId,'job');
  assert.equal((await f.cli.request('tools.invoke',{name:'fixture_read'},{describe:true})).parameters.properties.requester.const,'u');assert.equal(f.seen.length,0);
  const result=await f.cli.request('tools.invoke',{name:'fixture_read',args:{id:'original'}});assert.equal(result.output.value,'hook-result');assert.equal(f.hooks.length,1);
  assert.equal(f.hooks[0].ctx.requester.senderId,'u');assert.equal(f.hooks[0].ctx.requester.senderIsOwner,false);
  assert.equal(f.seen[0].context.workerContext.jobId,'job');assert.equal(f.seen[0].context.agentAccountId,'a');assert.deepEqual(f.seen[0].args,{id:'hook-result'});assert.equal(f.seen[0].id,f.hooks[0].toolCallId);
  assert.ok(!JSON.stringify(f.hooks[0].params).includes(f.lease.token));
  for(const params of [{name:'fixture_read',args:{accountId:'b'}},{name:'fixture_read',args:{projectId:'other'}},{name:'agent_repo',args:{action:'sync'}},{name:'agent_repo',args:{action:'skills'}},{name:'agent_task_result',args:{}},{name:'fixture_read',sessionKey:'agent:other:main'},{name:'fixture_read',args:{__openclawWorker:{}}}])await assert.rejects(f.cli.request('tools.invoke',params));
  await assert.rejects(f.cli.request('plugins.sessionAction',{}));
  f.setAuthorized(false);await assert.rejects(f.cli.request('worker.context',{}));f.setAuthorized(true);f.setStatus('unknown');await assert.rejects(f.cli.request('worker.context',{}));f.setStatus('running');f.setWorker('resumed');await assert.rejects(f.cli.request('worker.context',{}));
 }finally{await f.service.stop();}
});
test('hook cannot replace bound account or bypass administrative action checks',async()=>{
 for(const params of [{accountId:'b'},{action:'sync'}]){
  const f=await fixture({runPolicy:async()=>({params})});try{await assert.rejects(f.cli.request('tools.invoke',{name:params.action?'agent_repo':'fixture_read',args:params.action?{action:'list'}:{}}));assert.equal(f.seen.length,0);}finally{await f.service.stop();}
 }
});
test('in-flight calls abort on cancellation, source revocation, timeout and service stop',async()=>{
 for(const reason of ['cancel','revoke','timeout','stop']){
  let writes=0,started;const ready=new Promise(r=>started=r);
  const f=await fixture({execute:async(_args,signal)=>{started();await delay(200,null,{signal});writes++;return {};}});
  try{
   const cli=reason==='timeout'?await connectWorkerCli({timeout:60},f.env):f.cli;
   const result=cli.request('tools.invoke',{name:'fixture_read',args:{}});const rejected=assert.rejects(result);await ready;
   if(reason==='cancel')f.setStatus('cancelled');if(reason==='revoke')f.setAuthorized(false);if(reason==='stop')await f.service.stop();
   await rejected;await delay(220);assert.equal(writes,0,reason);
  }finally{if(reason!=='stop')await f.service.stop();}
 }
});
test('unbound commands keep operator transport and partial Worker environments fail closed',async()=>{assert.equal(await connectWorkerCli({},{}),undefined);await assert.rejects(connectWorkerCli({},{OPENCLAW_JOB_ID:'a'}));});
test('session preparation restores stored permission boundary and sandbox; rejects replaced sessions and opaque authority',async()=>{
 const entry={sessionId:'s',permissionMode:'read-only',sessionRoot:'/original'};const calls=[];
 const api={runtime:{agent:{resolveAgentWorkspaceDir:()=>'/workspace',session:{resolveStorePath:()=>'/store',getSessionEntry:async input=>{calls.push(input);return entry;}}}}};
 const b={provenance:{...p,sessionId:'s',senderName:'User',policyContext:{version:1,channel:'feishu',memberRoleIds:['reader']}},context:{...p,workerId:'worker',cwd:'/clone'}};
 await assert.rejects(prepareWorkerCliOptions(api,{...b,provenance:{...b.provenance,policyContext:undefined}},{},{resolveSandbox:async()=>undefined}),/policy snapshot/);
 await assert.rejects(prepareWorkerCliOptions(api,{...b,provenance:{...b.provenance,policyContext:{version:1,channel:'telegram'}}},{},{resolveSandbox:async()=>undefined}),/channel policy/);
 const options=await prepareWorkerCliOptions(api,b,{}, {resolveSandbox:async input=>{assert.equal(input.requireCurrentConfig,true);return {fixture:true};}});
 assert.deepEqual(options.sessionPermissionPolicy,{mode:'read-only',root:'/original'});assert.equal(options.senderIsOwner,false);assert.equal(options.senderId,'u');assert.equal(options.senderName,'User');assert.deepEqual(options.memberRoleIds,['reader']);assert.equal(options.cwd,'/clone');assert.equal(calls[0].readConsistency,'latest');
 await assert.rejects(prepareWorkerCliOptions(api,{...b,provenance:{...b.provenance,sessionId:'replaced'}},{},{resolveSandbox:async()=>undefined}));
 await assert.rejects(prepareWorkerCliOptions(api,{...b,provenance:{...b.provenance,policyContext:{requiresOpaqueBindings:true}}},{},{resolveSandbox:async()=>undefined}));
 await assert.rejects(prepareWorkerCliOptions(api,b,{}, {resolveSandbox:async()=>{throw Error('sandbox unavailable');}}));
});
