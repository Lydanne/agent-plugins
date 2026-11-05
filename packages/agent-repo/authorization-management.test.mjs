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

test('large permission catalogs use bounded JSON chunks and preserve connection scope and expiry',async()=>{
 const {readInspectionResponse}=await import('./dist/inspection-transport.mjs');
 const actions=new Map();let clock=0;
 const resources=Array.from({length:461},(_,i)=>({id:'resource-'+i,definition:{toolName:'tool-'+i,description:'查询说明'.repeat(100),parameters:{nested:{value:'x'}}}}));
 const store={mode:()=> 'audit',list:kind=>kind==='resources'?resources:[],history:()=>[],policyVersions:()=>[]};
 registerAuthorizationManagement({registerSessionAction:a=>actions.set(a.id,a)},{agents:{ada:{repo:'/unused'}}},{storeFor:()=>store},{now:()=>clock});
 const ctx={agentId:'ada',sessionKey:'agent:ada:management',client:{connId:'page',scopes:['operator.admin']},payload:{}};
 const assertWire=value=>{let nodes=0;const walk=(v,depth=0)=>{assert.ok(++nodes<=4096&&depth<=32);assert.notEqual(v,undefined);if(typeof v==='string')assert.ok(v.length<=65536);if(v&&typeof v==='object'){assert.ok(Array.isArray(v)||Object.keys(v).length<=512);Object.values(v).forEach(child=>walk(child,depth+1));}};walk(value);assert.ok(Buffer.byteLength(JSON.stringify(value))<=262144);};
 const call=async(action,payload)=>{const result=await actions.get('authorization-'+action).handler({...ctx,payload});assertWire(result.result);return result;};
 const first=await call('catalog',{});assert.equal(first.result.encoding,'json-chunks');assert.ok(first.result.totalChunks>1);
 const chunk=actions.get('authorization-chunk').handler,payload={transferId:first.result.transferId,index:1};
 for(const changed of [{agentId:'other'},{sessionKey:'another'},{client:{connId:'other',scopes:['operator.admin']}},{client:{connId:'page',scopes:[]}}])assert.equal((await chunk({...ctx,...changed,payload})).ok,false);
 const decoded=await readInspectionResponse(call,'catalog',{});assert.equal(decoded.resources.length,461);assert.deepEqual(decoded.resources.at(-1).definition,resources.at(-1).definition);
 clock=120001;assert.equal((await chunk({...ctx,payload})).ok,false);
});

test('permission write replies omit undefined optional fields without changing the persisted operation',async()=>{
 const actions=new Map();let saves=0;
 registerAuthorizationManagement({registerSessionAction:a=>actions.set(a.id,a)},{agents:{ada:{repo:'/unused'}}},{storeFor:()=>({saveGroup:value=>{saves++;return {...value,optional:undefined,revision:1};}})});
 const result=await actions.get('authorization-save').handler({agentId:'ada',client:{scopes:['operator.admin']},payload:{kind:'groups',expectedRevision:0,value:{id:'group',name:'Group',status:'active'}}});
 assert.equal(result.ok,true);assert.equal(saves,1);assert.equal(Object.hasOwn(result.result,'optional'),false);assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});

test('admin-only entity transfers cannot be read after losing admin scope',async()=>{
 const actions=new Map();
 const graph={list:({typeId,offset})=>({entities:typeId==='person'?Array.from({length:100},(_,i)=>({id:String(offset+i),name:'Person '+(offset+i),status:'active',typeId,sourceId:'s'})):[],nextOffset:typeId==='person'&&offset<500?offset+100:null}),relations:()=>({relations:[],nextOffset:null})};
 registerAuthorizationManagement({registerSessionAction:a=>actions.set(a.id,a)},{agents:{ada:{repo:'/unused'}}},{storeFor:()=>({})},{openGraph:()=>graph});
 const ctx={agentId:'ada',sessionKey:'s',client:{connId:'c',scopes:['operator.admin']},payload:{}};
 const first=await actions.get('authorization-entityOptions').handler(ctx);assert.ok(first.result.totalChunks>1);
 const payload={transferId:first.result.transferId,index:1};
 assert.equal((await actions.get('authorization-chunk').handler({...ctx,payload,client:{connId:'c',scopes:['operator.read']}})).ok,false);
 assert.equal((await actions.get('authorization-chunk').handler({...ctx,payload})).ok,true);
});
