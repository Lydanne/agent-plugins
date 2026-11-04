import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuthorizationStore} from './authorization-store.mjs';
import {createAuthorizationService} from './authorization-service.mjs';
test('service resolves trusted identity, evaluates store rules, and blocks revoked rights',async t=>{
 const root=mkdtempSync(join(tmpdir(),'auth-service-')),store=createAuthorizationStore(root,{agentId:'ada'});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const subject={id:'p',agentId:'ada',sourceId:'tenant',verified:true};
 const resource={id:'query',agentId:'ada',kind:'capability',provider:'xgj',actions:['execute'],status:'active',verification:'verified',enforcement:'enforced'};
 store.saveResource(resource,{actor:'admin'});
 store.saveBinding({id:'b',agentId:'ada',entityId:'p',entityType:'person',membership:'self',groupId:'internal',status:'active'},{actor:'admin'});
 store.saveRule({id:'allow',groupId:'internal',actions:['execute'],effect:'allow',selector:{resourceIds:['query']}},{actor:'admin'});
 const service=createAuthorizationService({store,resolveIdentity:async host=>host.requester?subject:null,readMembership:async()=>({agentId:'ada',subjectId:'p',sourceId:'tenant',observedAt:new Date().toISOString(),complete:true,nodes:[{id:'p',type:'person',sourceId:'tenant',status:'active'}],edges:[]}),resolveOperation:async()=>({requirements:[{resourceId:'query',action:'execute'}]})});
 assert.equal((await service.enforce({params:{requester:'p'}},{})).block,true);
 assert.equal(await service.enforce({}, {requester:'trusted'}),undefined);
 store.saveRule({id:'deny',groupId:'internal',actions:['execute'],effect:'deny',selector:{resourceIds:['query']}},{actor:'admin'});
 assert.equal((await service.enforce({}, {requester:'trusted'})).block,true);
 assert.equal(store.history().filter(row=>row.action==='execution.decision').length,3);
});
test('adapter failure is a denial rather than an unguarded invocation',async()=>{
 const audit=[];
 const service=createAuthorizationService({store:{agentId:'ada',audit:(...args)=>audit.push(args)},resolveIdentity:async()=>{throw Error('private details');},readMembership:async()=>{},resolveOperation:async()=>{}});
 const result=await service.enforce({},{});assert.equal(result.block,true);assert.equal(result.blockReason.includes('private details'),false);assert.equal(audit.length,1);
});
test('permission resolution reads current bindings after asynchronous operation preparation',async()=>{
 let operationResolved=false;
 const store={agentId:'ada',list:kind=>{assert.equal(operationResolved,true);return [];}};
 const subject={id:'p',sourceId:'s',agentId:'ada',verified:true};
 const service=createAuthorizationService({store,resolveIdentity:()=>subject,resolveOperation:async()=>{await Promise.resolve();operationResolved=true;return {requirements:[{resourceId:'r',action:'read'}]};},readMembership:()=>({agentId:'ada',subjectId:'p',sourceId:'s',complete:true,observedAt:new Date().toISOString(),nodes:[{id:'p',type:'person',sourceId:'s',status:'active'}],edges:[]})});
 store.get=()=>null;const result=await service.decide({},{});assert.equal(result.allowed,false);assert.equal(operationResolved,true);
});
