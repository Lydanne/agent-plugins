import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAuthorizationManagement} from './authorization-management.mjs';
test('management requires admin for writes and validates entity references',async()=>{
 const actions=new Map(),writes=[];
 const api={registerSessionAction:action=>actions.set(action.id,action)};
 const store={saveBinding:(...args)=>{writes.push(args);return {revision:1};}};
 registerAuthorizationManagement(api,{agents:{ada:{repo:'/unused'}}},{storeFor:()=>store},{openGraph:()=>({get:id=>({entity:id==='p'?{typeId:'person',status:'active'}:null})})});
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

test('entity picker reads all pages, filters inactive and cross-source relations without mutating the graph',async()=>{
 const actions=new Map(),seen=[];
 const graph={list:({typeId,offset})=>{seen.push([typeId,offset]);return {entities:typeId==='person'?[{id:offset?'p2':'p',name:'Person',typeId,sourceId:'s',status:offset?'disabled':'active',source:{namespace:'feishu'}}]:[{id:typeId,name:typeId,typeId,sourceId:'s',status:'active'}],nextOffset:typeId==='person'&&!offset?1:null};},relations:({typeId})=>({relations:typeId==='member_of'?[{fromId:'p',toId:'department',typeId,sourceId:'s'},{fromId:'p',toId:'organization',typeId,sourceId:'other'}]:[],nextOffset:null})};
 registerAuthorizationManagement({registerSessionAction:action=>actions.set(action.id,action)},{agents:{ada:{repo:'/unused'}}},{storeFor:()=>({})},{openGraph:()=>graph});
 const handler=actions.get('authorization-entityOptions').handler;
 assert.equal((await handler({agentId:'ada',client:{scopes:['operator.read']},payload:{}})).ok,false);
 const result=await handler({agentId:'ada',client:{scopes:['operator.admin']},payload:{}});
 assert.equal(result.ok,true);assert.equal(result.result.agentId,'ada');assert.equal(result.result.entities.length,3);
 assert.deepEqual(result.result.relations,[{fromId:'p',toId:'department',type:'member_of'}]);assert.ok(seen.some(([type,offset])=>type==='person'&&offset===1));
});
