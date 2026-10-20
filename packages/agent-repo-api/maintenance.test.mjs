import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {maintenanceContext,maintenanceRevision,registerMaintenanceProvider,maintenanceCatalog,runMaintenance,createMaintenanceOperations} from './maintenance.mjs';
const ctx={agentId:'main',sessionKey:'agent:main:maintenance',client:{scopes:['operator.read','operator.write']}};
const input=()=>({providerId:'fixture.cli',action:'update',requestId:randomUUID(),confirmed:true,expectedRevision:maintenanceRevision('v1')});
const wait=()=>new Promise(resolve=>setTimeout(resolve,30));
test('maintenance enforces trusted Agent, permissions, supported versions and optional provider isolation',async()=>{
 assert.throws(()=>maintenanceContext({...ctx,sessionKey:'agent:other:session'}));
 assert.throws(()=>maintenanceContext({...ctx,client:{scopes:['operator.read']}},true));
 const a=registerMaintenanceProvider({apiVersion:1,id:'fixture.cli',scope:'host',snapshot:async()=>({apiVersion:1,id:'fixture.cli',state:'available',actions:[],skills:[]}),run:async()=>({accepted:true})},{});
 const b=registerMaintenanceProvider({apiVersion:1,id:'fixture.off',scope:'host',snapshot:async()=>{throw Error('private-token');},run:async()=>{}},{});
 try{
  const result=await maintenanceCatalog(ctx);assert.equal(result.providers.find(row=>row.id==='fixture.off').state,'unavailable');assert.ok(!JSON.stringify(result).includes('private-token'));
  await assert.rejects(runMaintenance({...ctx,client:{scopes:['operator.read']}},input()));
  await assert.rejects(runMaintenance(ctx,{...input(),confirmed:false}));
  await assert.rejects(runMaintenance(ctx,{...input(),command:'shell'}));
  assert.deepEqual(await runMaintenance(ctx,input()),{accepted:true});
 }finally{a();b();}
 assert.equal((await maintenanceCatalog(ctx)).providers.length,0);
});
test('operations persist idempotency, exclude raw errors, reject concurrent admission and survive controller replacement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'maintenance-journal-'));
 try{
  const ops=createMaintenanceOperations(root),request=input();let calls=0,release;
  const gate=new Promise(resolve=>release=resolve);
  const operation=await ops.start(ctx,request,async()=>{calls++;await gate;});
  const duplicate=await ops.start(ctx,request,async()=>calls++);assert.equal(duplicate.id,operation.id);assert.equal(calls,1);
  await assert.rejects(ops.start(ctx,input(),async()=>{}),/已有维护操作/);
  await assert.rejects(ops.find(ctx,{...request,action:'rollback'}),/改变参数/);
  release();await wait();assert.equal((await ops.find(ctx,request)).status,'succeeded');
  const next=createMaintenanceOperations(root);assert.equal((await next.find(ctx,request)).status,'succeeded');
  await next.start(ctx,input(),async()=>{throw Error('Bearer private-secret');});await wait();
  const history=await next.history();assert.equal(history[0].status,'failed');assert.ok(!JSON.stringify(history).includes('private-secret'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('interrupted journal entries become unknown and the same request never replays execution',async()=>{
 const root=await mkdtemp(join(tmpdir(),'maintenance-interrupted-'));
 try{
  const request=input(),id=maintenanceRevision([ctx.agentId,ctx.sessionKey,request.requestId]);
  await writeFile(join(root,id+'.json'),JSON.stringify({id,action:request.action,digest:maintenanceRevision([request.action,request.expectedRevision,null]),status:'running',pid:process.pid,createdAt:new Date().toISOString()}));
  const replacement=createMaintenanceOperations(root);let executions=0;
  assert.equal((await replacement.history())[0].status,'unknown');
  assert.equal((await replacement.start(ctx,request,async()=>executions++)).status,'unknown');assert.equal(executions,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
