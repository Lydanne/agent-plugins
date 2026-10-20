import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerDiagnosticSource,createDiagnosticHub} from './diagnostics.mjs';
const context=(connId='one',agentId='main',payload={})=>({agentId,sessionKey:'agent:'+agentId+':management',client:{connId,scopes:['operator.read','operator.write']},payload});
let n=0;
function fixture(t,options={},open){const id='test.'+(++n),source=registerDiagnosticSource({apiVersion:1,id,pluginId:'test-plugin',label:'Test',...(open?{open}:{})},Symbol());const hub=createDiagnosticHub(options);t.after(()=>{hub.dispose();source.dispose();});return {source,hub,id,start:ctx=>hub.actions.diagnosticStart({...ctx,payload:{sourceIds:[id]}})};}
test('default off is lazy; Main stamps source/Agent and redacts a bounded snapshot',async t=>{
 const f=fixture(t);let evaluated=0,getter=0;assert.equal(f.source.log({agentId:'main'},()=>{evaluated++;return {message:'unused'};}),false);assert.equal(evaluated,0);
 const ctx=context(),lease=await f.start(ctx),data={token:'secret',nested:{authorization:'Bearer xyz'}};Object.defineProperty(data,'lazy',{enumerable:true,get(){getter++;return 'secret';}});
 assert.equal(f.source.log({agentId:'main'},{message:'token=private',pluginId:'spoof',sourceId:'spoof',agentId:'other',data}),true);data.nested.authorization='changed';
 const result=await f.hub.actions.diagnosticRead({...ctx,payload:{leaseId:lease.leaseId,afterSeq:0}});assert.equal(result.rows.length,1);const row=result.rows[0];assert.equal(row.sourceId,f.id);assert.equal(row.pluginId,'test-plugin');assert.equal(row.agentId,'main');assert.equal(getter,0);assert.equal(row.message,'token=[redacted]');assert.equal(row.data.token,'[redacted]');assert.equal(row.data.lazy,'[getter omitted]');
 await f.hub.actions.diagnosticStop({...ctx,payload:{leaseId:lease.leaseId}});assert.equal(f.source.log({agentId:'main'},()=>{evaluated++;return {message:'unused'};}),false);assert.equal(evaluated,0);
});
test('leases enforce trusted connection, Agent, permissions and independent page lifetimes',async t=>{
 const f=fixture(t);await assert.rejects(f.start({...context(),client:{scopes:['operator.write']}}));await assert.rejects(f.start({...context(),client:{connId:'one',scopes:['operator.read']}}));
 const one=await f.start(context()),two=await f.start(context('two'));
 await assert.rejects(f.hub.actions.diagnosticRead(context('two','main',{leaseId:one.leaseId})));await assert.rejects(f.hub.actions.diagnosticStop(context('one','other',{leaseId:one.leaseId})));
 assert.equal(f.source.log({agentId:'other'},{message:'hidden'}),false);f.source.log({agentId:'main'},{message:'both'});
 await f.hub.actions.diagnosticStop(context('one','main',{leaseId:one.leaseId}));assert.equal(f.source.log({agentId:'main'},{message:'remaining'}),true);
 const result=await f.hub.actions.diagnosticRead(context('two','main',{leaseId:two.leaseId}));assert.deepEqual(result.rows.map(row=>row.message),['both','remaining']);
});
test('TTL expires and clears captures, ring eviction reports gaps, restart rejects old cursor',async t=>{
 let now=0,closed=0;const f=fixture(t,{now:()=>now,maxRows:2},async()=>({read:async()=>[],close(){closed++;}})),ctx=context(),lease=await f.start(ctx);
 for(let i=0;i<4;i++)f.source.log(ctx,{message:'row '+i});const result=await f.hub.actions.diagnosticRead(context('one','main',{leaseId:lease.leaseId,afterSeq:0}));assert.equal(result.gap,true);assert.equal(result.dropped,2);assert.deepEqual(result.rows.map(row=>row.seq),[3,4]);
 now=20001;assert.equal(f.source.log(ctx,{message:'expired'}),false);await assert.rejects(f.hub.actions.diagnosticRenew(context('one','main',{leaseId:lease.leaseId})));assert.equal(closed,1);const next=await f.start(ctx);assert.notEqual(next.leaseId,lease.leaseId);await assert.rejects(f.hub.actions.diagnosticRead(context('one','main',{leaseId:lease.leaseId,afterSeq:4})));
});
test('stop while a provider read is pending cancels response and ignores late events',async t=>{
 let resolve,closed=0;const pending=new Promise(yes=>resolve=yes),f=fixture(t,{},async()=>({read:()=>pending,close(){closed++;}})),lease=await f.start(context());const reading=f.hub.actions.diagnosticRead(context('one','main',{leaseId:lease.leaseId}));const rejection=assert.rejects(reading);await f.hub.actions.diagnosticStop(context('one','main',{leaseId:lease.leaseId}));resolve([{message:'late'}]);await rejection;assert.equal(closed,1);assert.equal(f.source.log(context(),{message:'late'}),false);
});
test('shutdown during source open closes the late capture and unregistering stops capture',async t=>{
 let resolve,closed=0;const pending=new Promise(yes=>resolve=yes),f=fixture(t,{},()=>pending);const start=f.start(context()),rejection=assert.rejects(start);await new Promise(yes=>setImmediate(yes));f.hub.dispose();resolve({read:async()=>[],close(){closed++;}});await rejection;assert.equal(closed,1);
});
test('batch cursor drains every event once and metadata/data obey payload budget',async t=>{
 const f=fixture(t),lease=await f.start(context());for(let i=0;i<45;i++)f.source.log(context(),{message:'row '+i,data:{blob:'x'.repeat(100000)}});let cursor=0,all=[];for(let i=0;i<3;i++){const result=await f.hub.actions.diagnosticRead(context('one','main',{leaseId:lease.leaseId,afterSeq:cursor}));cursor=result.nextSeq;all.push(...result.rows);}assert.equal(all.length,45);assert.equal(new Set(all.map(row=>row.seq)).size,45);assert.ok(all.every(row=>Buffer.byteLength(JSON.stringify(row))<17000));
});
test('source replacement and unload invalidate captures without an old disposer deleting the replacement',async t=>{
 const f=fixture(t),owner=Symbol(),id='replacement.'+(++n);const definition={apiVersion:1,id,pluginId:'example',label:'Original'};const first=registerDiagnosticSource(definition,owner);t.after(()=>first.dispose());const lease=await f.hub.actions.diagnosticStart(context('one','main',{sourceIds:[id]}));
 const second=registerDiagnosticSource(definition,owner);t.after(()=>second.dispose());first.dispose();definition.pluginId='spoof';await assert.rejects(f.hub.actions.diagnosticRead(context('one','main',{leaseId:lease.leaseId})));
 const next=await f.hub.actions.diagnosticStart(context('one','main',{sourceIds:[id]}));second.log(context(),{message:'active'});const result=await f.hub.actions.diagnosticRead(context('one','main',{leaseId:next.leaseId}));assert.equal(result.rows[0].pluginId,'example');second.dispose();await assert.rejects(f.hub.actions.diagnosticRead(context('one','main',{leaseId:next.leaseId})));
});
test('array getters are omitted and multilingual payload size stays bounded',async t=>{
 const f=fixture(t),lease=await f.start(context());let getter=0;const values=[];Object.defineProperty(values,0,{get(){getter++;return 'private';}});f.source.log(context(),{message:'中'.repeat(4000),traceId:'中'.repeat(200),jobId:'中'.repeat(200),projectId:'中'.repeat(200),category:'中'.repeat(200),phase:'中'.repeat(200),eventName:'中'.repeat(200),data:{values,blob:Array(50).fill('中'.repeat(4000))}});const result=await f.hub.actions.diagnosticRead(context('one','main',{leaseId:lease.leaseId}));assert.equal(getter,0);assert.ok(Buffer.byteLength(JSON.stringify(result.rows[0]))<16*1024);
});
