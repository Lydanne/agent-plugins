import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerCliService,workerContextApi,workerCliEnvironment,connectWorkerCli,readWorkerCliContext} from './worker-cli.mjs';
const p={agentId:'main',sessionKey:'agent:main:feishu:group:test',accountId:'a',chatId:'c',senderId:'u',taskId:'source',revision:1};
test('task-bound CLI invokes a plugin with original context, no Main turn or Gateway secret in child; revokes and rejects identity changes',async()=>{
 let status='running',workerId='execution-one',authorized=true,calls=0,closed=0;const seen=[];let factory;
 workerContextApi({id:'fixture',registerTool:f=>{factory=f;}}).registerTool(context=>({name:'fixture_read',description:'read',parameters:{type:'object',properties:{requester:{const:context.requesterSenderId}}},execute:(_id,args)=>{calls++;seen.push({context,args});return {content:[{type:'text',text:JSON.stringify({value:args.id})}]};}}));
 const hostContext={agentId:p.agentId,sessionKey:p.sessionKey,senderIsOwner:true};
 const service=createWorkerCliService({getConfig:()=>({}),authorize:()=>authorized,getJob:()=>({status,workerId,provenance:p}),connect:async()=>({close(){closed++;},async request(method,input){
  const tool=factory(hostContext);
  if(method==='tools.catalog')return {groups:[{source:'plugin',pluginId:'fixture',tools:[{id:tool.name}]}]};
  assert.equal(method,'tools.invoke');assert.equal(input.agentId,p.agentId);assert.equal(input.sessionKey,p.sessionKey);
  // The host policy entry remains tools.invoke, which can reject before execute.
  if(input.args.id==='policy-denied')return {ok:false,error:{code:'forbidden'}};
  return {ok:true,output:await tool.execute('host-policy-call',input.args)};
 }}),onAudit:record=>{assert.ok(!JSON.stringify(record).includes('token'));}});
 await service.start();
 try{
  const job={jobId:'job-one',workerId,provenance:p,projectId:'project'};
  const lease=service.issue(job,{params:{task:'read record',constraints:'read-only'},runtime:{}}),env=workerCliEnvironment(lease);
  assert.equal(env.OPENCLAW_WORKER_ID,workerId);assert.equal(env.OPENCLAW_JOB_ID,'job-one');assert.equal(env.OPENCLAW_GATEWAY_TOKEN,undefined);
  assert.equal(readWorkerCliContext(env).jobId,'job-one');assert.equal(readWorkerCliContext(env).constraints,undefined);
  assert.throws(()=>readWorkerCliContext({...env,OPENCLAW_JOB_ID:'other'}));
  await assert.rejects(connectWorkerCli({agent:'other'},env));await assert.rejects(connectWorkerCli({url:'http://other'},env));
  const cli=await connectWorkerCli({},env),scope={agentId:p.agentId,sessionKey:p.sessionKey};
  assert.equal((await cli.request('worker.context',{})).jobId,'job-one');
  const schema=await cli.request('tools.invoke',{...scope,name:'fixture_read'},{describe:true});assert.equal(schema.parameters.type,'object');assert.equal(schema.parameters.properties.requester.const,p.senderId);assert.equal(calls,0);
  const result=await cli.request('tools.invoke',{...scope,name:'fixture_read',args:{id:'record'}});assert.equal(result.ok,true);assert.equal(calls,1);
  const proof={token:lease.token,workerId:lease.context.workerId,jobId:lease.context.jobId};
  await assert.rejects(factory({...hostContext,agentId:'other',sessionKey:'agent:other:main'}).execute('forged',{__openclawWorker:proof,id:'never'}));
  let administrativeFactory;
  workerContextApi({id:'fixture-admin',registerTool:f=>{administrativeFactory=f;}}).registerTool(()=>({name:'agent_task_result',parameters:{type:'object'},execute:()=>{throw Error('must never execute');}}));
  await assert.rejects(administrativeFactory(hostContext).execute('forged',{__openclawWorker:proof,outcome:'succeeded'}),/Main decision/);
  assert.equal(seen[0].context.requesterSenderId,p.senderId);assert.equal(seen[0].context.agentAccountId,p.accountId);assert.equal(seen[0].context.workerContext.jobId,'job-one');assert.equal(seen[0].context.senderIsOwner,false);assert.deepEqual(seen[0].args,{id:'record'});
  assert.equal((await cli.request('tools.invoke',{...scope,name:'fixture_read',args:{id:'policy-denied'}})).ok,false);assert.equal(calls,1);
  await assert.rejects(cli.request('tools.invoke',{...scope,sessionKey:'agent:other:main',name:'fixture_read'}));
  await assert.rejects(cli.request('tools.invoke',{...scope,name:'exec',args:{command:'never'}}));
  await assert.rejects(cli.request('tools.invoke',{...scope,name:'fixture_read',args:{projectId:'another-project'}}));
  await assert.rejects(cli.request('plugins.sessionAction',{}));
  authorized=false;await assert.rejects(cli.request('worker.context',{}));authorized=true;
  status='completed';await assert.rejects(cli.request('worker.context',{}));status='running';
  workerId='resumed-execution';await assert.rejects(cli.request('worker.context',{}));
  const next=service.issue({...job,workerId},{params:{task:'read',constraints:'read-only'},runtime:{}});
  await assert.rejects(cli.request('worker.context',{}));assert.ok((await connectWorkerCli({},workerCliEnvironment(next))));
  assert.ok(closed>=3);
 }finally{await service.stop();}
});
test('unbound commands retain ordinary operator transport and malformed partial Worker environments fail closed',async()=>{
 assert.equal(await connectWorkerCli({},{}),undefined);
 await assert.rejects(connectWorkerCli({},{OPENCLAW_JOB_ID:'a'}));
});

test('automation/local task context inherits the admitted request scope when channel provenance has no session key',async()=>{
 const scope='agent:main:automation:11111111-1111-4111-8111-111111111111';
 const provenance={agentId:'main',sessionId:'fixture-session',automation:{version:1,taskId:'11111111-1111-4111-8111-111111111111'}};
 const job={jobId:'automation-job',workerId:'automation-execution',status:'running',provenance};
 const service=createWorkerCliService({getJob:()=>job,getConfig:()=>({}),connect:()=>{throw Error('No Gateway connection needed for context');},authorize:(p,key)=>{assert.equal(p,provenance);assert.equal(key,scope);return true;}});
 await service.start();
 try{
  const lease=service.issue(job,{scope,params:{task:'read fixture',context:'original context',constraints:'read-only'}});
  const cli=await connectWorkerCli({},workerCliEnvironment(lease));const context=await cli.request('worker.context',{});
  assert.equal(context.sessionKey,scope);assert.equal(context.context,'original context');assert.equal(context.jobId,job.jobId);
 }finally{await service.stop();}
});
