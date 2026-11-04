import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAuthorizationManagement} from './authorization-management.mjs';
test('management requires admin for writes and validates entity references',async()=>{
 const actions=new Map(),writes=[];
 const api={registerSessionAction:action=>actions.set(action.id,action)};
 const store={saveBinding:(...args)=>{writes.push(args);return {revision:1};}};
 registerAuthorizationManagement(api,{agents:{ada:{repo:'/unused'}}},{storeFor:()=>store},{openGraph:()=>({get:id=>({entity:id==='p'?{typeId:'person'}:null})})});
 const handler=actions.get('authorization-save').handler;
 const input={agentId:'ada',client:{scopes:['operator.write'],connId:'c'},payload:{kind:'bindings',expectedRevision:0,value:{entityId:'p',entityType:'person'}}};
 assert.equal((await handler(input)).ok,false);assert.equal(writes.length,0);
 input.client.scopes=['operator.admin'];assert.equal((await handler(input)).ok,true);assert.equal(writes[0][0].agentId,'ada');
 input.payload.value.entityId='missing';assert.equal((await handler(input)).ok,false);assert.equal(writes.length,1);
});
test('classification cannot manufacture enforcement or change resource actions',async()=>{
 const actions=new Map();let saved;
 const resource={id:'tool',revision:1,actions:['execute'],verification:'pending',enforcement:'missing',behavior:{sensitivity:'unknown'}};
 registerAuthorizationManagement({registerSessionAction:action=>actions.set(action.id,action)},{agents:{ada:{repo:'/unused'}}},{storeFor:()=>({get:()=>resource,saveResource:value=>(saved=value)})});
 const ctx={agentId:'ada',client:{scopes:['operator.admin'],connId:'c'},payload:{resourceId:'tool',expectedRevision:1,labels:['orders'],behavior:{access:'read'}}};
 assert.equal((await actions.get('authorization-classify').handler(ctx)).ok,true);
 assert.equal(saved.verification,'pending');assert.equal(saved.enforcement,'missing');assert.deepEqual(saved.actions,['execute']);
 ctx.payload.enforcement='enforced';assert.equal((await actions.get('authorization-classify').handler(ctx)).ok,false);
});
