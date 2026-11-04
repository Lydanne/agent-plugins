import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAuthorizationRuntime} from './authorization-runtime.mjs';
import {bindAuthorizationScope} from './dist/authorization-api.mjs';
test('Main tool calls, skills and nested operations do not consult Worker permission storage',async()=>{
 const hooks=[];
 const runtime=registerAuthorizationRuntime({registerTrustedToolPolicy:()=>{},on:name=>hooks.push(name)},{agents:{ada:{repo:'/unused'}}},{openStore:()=>{throw Error('must not read Worker policies');}});
 for(const host of [{},{agentId:'ada',sessionKey:'main',runId:'run',toolCallId:'call'}])assert.equal(await runtime.evaluate({toolName:'exec',params:{}},host),undefined);
 const catalog={skills:[{name:'main-skill'}],shadowed:[]};
 assert.equal(await runtime.filterSkills(catalog,{agentId:'ada'}),catalog);
 await runtime.authorizeOperation({toolName:'agent_repo_people_enrich',params:{}},{agentId:'ada'});
 assert.equal(hooks.includes('before_prompt_build'),false);
});
test('task-bound Worker calls audit and enforce; missing transport scope fails closed',async()=>{
 let mode='audit',closed=false;const audits=[],services=[];
 const store={agentId:'ada',mode:()=>mode,audit:(...args)=>audits.push(args),close:()=>{closed=true;}};
 const runtime=registerAuthorizationRuntime({registerTrustedToolPolicy:()=>{},registerService:s=>services.push(s)},{agents:{ada:{repo:'/unused'}}},{openStore:()=>store,openGraph:()=>({}),resolveOperation:()=>undefined});
 const host={agentId:'ada',sessionKey:'session',runId:'worker',toolCallId:'worker-cli:call'},event={toolName:'exec',params:{}};
 const release=bindAuthorizationScope(host,'job');
 try{assert.equal(await runtime.evaluate(event,host),undefined);mode='enforce';assert.equal((await runtime.evaluate(event,host)).block,true);assert.equal(audits.length,2);}finally{release();}
 assert.equal((await runtime.evaluate(event,host)).block,true);services.forEach(s=>s.stop());assert.equal(closed,true);
});
test('missing public policy API is explicit rather than silently unguarded',()=>assert.throws(()=>registerAuthorizationRuntime({}, {agents:{}}),/trusted tool policy/));
test('shipped manifest declares the Worker policy contract',async()=>{
 const {readFile}=await import('node:fs/promises');const manifest=JSON.parse(await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 assert.ok(manifest.contracts.trustedToolPolicies.includes('agent-repo-authorization'));
});
test('mismatched Worker context is never treated as a Main operation',async()=>{
 const runtime=registerAuthorizationRuntime({registerTrustedToolPolicy:()=>{}},{agents:{ada:{repo:'/unused'}}});
 const context={agentId:'ada',sessionKey:'session',workerContext:{agentId:'other',sessionKey:'session',jobId:'job'}};
 await assert.rejects(runtime.authorizeOperation({toolName:'x',params:{}},context),/scope mismatch/);
 await assert.rejects(runtime.filterSkills({skills:[]},context),/scope mismatch/);
});
