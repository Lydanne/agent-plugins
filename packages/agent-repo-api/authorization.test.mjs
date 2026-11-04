import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAuthorizationAdapter,resolveAuthorizedOperation} from './authorization.mjs';
test('unknown and ambiguous adapters fail closed and ownership is enforced',async()=>{
 const owner=Symbol(),adapter={match:()=>true,resolve:()=>({requirements:[{resourceId:'r',action:'read'}]})};
 assert.equal(await resolveAuthorizedOperation({},{}),undefined);
 const off=registerAuthorizationAdapter('one',adapter,owner);
 try{assert.equal((await resolveAuthorizedOperation({},{})).requirements[0].action,'read');assert.throws(()=>registerAuthorizationAdapter('one',adapter,Symbol()));const off2=registerAuthorizationAdapter('two',adapter,owner);try{assert.equal(await resolveAuthorizedOperation({},{}),undefined);}finally{off2();}}finally{off();}
});
test('Worker job scope survives changed execution ids and cannot leak after invocation',async()=>{
 const {bindAuthorizationScope,getAuthorizationScope}=await import('./authorization.mjs');
 const first={agentId:'a',sessionKey:'agent:a:s',runId:'execution-1',toolCallId:'call-1'};
 const off=bindAuthorizationScope(first,'job');const scope=getAuthorizationScope(first);
 assert.equal(getAuthorizationScope({...first,toolCallId:'other'}),undefined);off();assert.equal(getAuthorizationScope(first),undefined);
 const next={...first,runId:'execution-2',toolCallId:'call-2'},release=bindAuthorizationScope(next,'job');
 try{assert.equal(getAuthorizationScope(next),scope);}finally{release();}
});
test('trusted resources are namespaced and operation records carry adapter revision',async()=>{
 const {authorizationAdapterResources}=await import('./authorization.mjs');
 const release=registerAuthorizationAdapter('files',{revision:'v1',resources:context=>[{id:'adapter://files/root',agentId:context.agentId,kind:'file',provider:'files',actions:['read']}],match:()=>true,resolve:()=>({requirements:[{resourceId:'adapter://files/root',action:'read'}]})},Symbol());
 try{const resources=await authorizationAdapterResources({agentId:'ada'});assert.equal(resources[0].verification,'verified');assert.deepEqual((await resolveAuthorizedOperation({},{})).adapter,{id:'files',revision:'v1'});}finally{release();}
 const bad=registerAuthorizationAdapter('bad',{revision:'v1',resources:()=>[{id:'data://someone-else',agentId:'ada'}],match:()=>true,resolve:()=>undefined},Symbol());
 try{await assert.rejects(authorizationAdapterResources({agentId:'ada'}),/Invalid/);}finally{bad();}
});
