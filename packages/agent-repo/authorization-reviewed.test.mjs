import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerAuthorizationRuntime} from './authorization-runtime.mjs';
import {registerAuthorizationManagement} from './authorization-management.mjs';
import {scanPermissionResources} from './authorization-catalog.mjs';
import {canReviewResource,reviewResource,resolveReviewedOperation} from './authorization-reviewed.mjs';
import {bindAuthorizationScope,registerAuthorizationAdapter} from './dist/authorization-api.mjs';
let invocation=0;
async function evaluateWorker(runtime,event,host){const id=String(++invocation),bound={...host,runId:id,toolCallId:'worker-cli:'+id};const release=bindAuthorizationScope(bound,'test-'+id);try{return await runtime.evaluate(event,bound);}finally{release();}}
const behavior={access:'read',externalEffect:'none',sensitivity:'ordinary',atomicity:'not-applicable',recovery:'not-applicable'};
function candidate(provider='fixture',name='lookup'){return {id:`tool://${provider}/${name}`,agentId:'ada',kind:'tool',provider,status:'pending',definitionHash:'hash',definition:{toolName:name},behavior};}
test('reviewed whole-tool operations preserve write, transfer and mixed requirements',()=>{
 for(const [access,externalEffect,expected] of [['read','none',['execute','read']],['read','present',['execute','read','transfer']],['write','none',['execute','create','update','delete']]]){
  const row=reviewResource({...candidate(),behavior:{...behavior,access,externalEffect}},'operator');
  assert.deepEqual(resolveReviewedOperation({list:()=>[row]},{toolName:'lookup',params:{}}).requirements.map(r=>r.action),expected);
 }
 const mixed=reviewResource({...candidate(),behavior:{...behavior,access:'mixed'}},'operator');assert.equal(mixed.defaultAuthorization,'explicit-only');assert.equal(mixed.actions.length,9);
 assert.throws(()=>reviewResource({...candidate(),behavior:{...behavior,access:'unknown'}},'operator'));
 assert.equal(canReviewResource(candidate('agent-repo','agent_repo')),false);
 assert.equal(canReviewResource({...candidate(),adapter:{id:'custom',revision:'1'}}),false);
});
test('command resources, disabled commands and ambiguous providers cannot fall back to a broad grant',()=>{
 const tool=reviewResource(candidate(),'operator'),command=reviewResource({...candidate(),id:'cli://fixture/lookup%20read',kind:'cli',definition:{toolName:'lookup',transport:'tool',action:'read'}},'operator');
 const store={list:()=>[tool,command]};
 assert.equal(resolveReviewedOperation(store,{toolName:'lookup',params:{action:'read'}}).requirements[0].resourceId,command.id);
 assert.equal(resolveReviewedOperation(store,{toolName:'lookup',params:{action:'other'}}),undefined);
 command.status='disabled';assert.equal(resolveReviewedOperation(store,{toolName:'lookup',params:{action:'read'}}).requirements[0].resourceId,command.id);
 assert.equal(resolveReviewedOperation({list:()=>[tool,reviewResource(candidate('other'),'operator')]},{toolName:'lookup',params:{}}),undefined);
 assert.equal(resolveReviewedOperation({list:()=>[{...tool,behavior:{...behavior,access:'write'}}]},{toolName:'lookup',params:{}}),undefined);
});
test('scan, admin classification review, default grant, adapters, reclassification and definition changes compose',async t=>{
 const root=mkdtempSync(join(tmpdir(),'auth-reviewed-')),services=[],actions=new Map();
 const person={id:'p',typeId:'person',sourceId:'s',status:'active',observedAt:new Date().toISOString(),source:{kind:'channel',namespace:'feishu',externalId:JSON.stringify(['account','app','sender'])}};
 const graph={list:()=>({entities:[person]}),get:()=>({entity:person}),relations:()=>({relations:[]})};
 const runtime=registerAuthorizationRuntime({registerTrustedToolPolicy:()=>{},registerService:s=>services.push(s)},{agents:{ada:{repo:root}}},{openGraph:()=>graph});
 t.after(()=>{services.forEach(s=>s.stop());rmSync(root,{recursive:true,force:true});});
 registerAuthorizationManagement({registerSessionAction:a=>actions.set(a.id,a)},{agents:{ada:{repo:root}}},runtime,{openGraph:()=>graph});
 const store=runtime.storeFor('ada'),inventory={plugins:{plugins:[{id:'fixture',version:'1',runtime:{state:'active'}}]},catalog:{agentId:'ada',groups:[{source:'plugin',pluginId:'fixture',tools:[{id:'lookup',description:'untrusted read hint'}]}]}};
 scanPermissionResources(store,inventory,{actor:'scanner'});store.setMode('enforce',{actor:'operator'});
 store.saveBinding({id:'binding',agentId:'ada',entityId:'p',entityType:'person',membership:'self',groupId:'internal',status:'active'},{actor:'operator'});
 const host={agentId:'ada',sessionKey:'session',requester:{channel:'feishu',accountId:'account',senderId:'sender'}},event={toolName:'lookup',params:{}};
 assert.equal((await evaluateWorker(runtime,event,host)).block,true);
 const invoke=(action,payload,scopes=['operator.admin'])=>actions.get('authorization-'+action).handler({agentId:'ada',client:{connId:'fixture',scopes},payload});
 const id='tool://fixture/lookup';
 assert.equal((await invoke('review',{resourceId:id,expectedRevision:1,confirmed:true})).ok,false);
 assert.equal((await invoke('classify',{resourceId:id,expectedRevision:1,labels:['safe'],behavior})).ok,true);
 assert.equal((await invoke('review',{resourceId:id,expectedRevision:2,confirmed:true},['operator.write'])).ok,false);
 assert.equal((await invoke('review',{resourceId:id,expectedRevision:2})).ok,false);
 assert.equal((await invoke('review',{resourceId:id,expectedRevision:2,confirmed:true})).ok,true);
 assert.equal(store.get('resources',id).review.actor,'operator:fixture');assert.ok(store.effectiveRules(id).some(rule=>rule.groupId==='internal'));
 assert.equal(await evaluateWorker(runtime,event,host),undefined);
 const release=registerAuthorizationAdapter('review-denial',{match:e=>e.toolName==='lookup',resolve:()=>undefined},Symbol());
 try{assert.equal((await evaluateWorker(runtime,event,host)).block,true);}finally{release();}
 scanPermissionResources(store,inventory,{actor:'scanner'});assert.equal(store.get('resources',id).revision,3);assert.equal(await evaluateWorker(runtime,event,host),undefined);
 assert.equal((await invoke('classify',{resourceId:id,expectedRevision:3,labels:['safe'],behavior:{...behavior,access:'write'}})).ok,true);
 assert.equal((await evaluateWorker(runtime,event,host)).block,true);
 assert.equal((await invoke('review',{resourceId:id,expectedRevision:3,confirmed:true})).ok,false);
 assert.equal((await invoke('review',{resourceId:id,expectedRevision:4,confirmed:true})).ok,true);
 assert.equal((await evaluateWorker(runtime,event,host)).block,true); // Internal read defaults do not allow writes.
 inventory.plugins.plugins[0].version='2';scanPermissionResources(store,inventory,{actor:'scanner'});
 assert.equal(store.get('resources',id).verification,'pending');assert.equal(store.get('resources',id).review,undefined);
});
