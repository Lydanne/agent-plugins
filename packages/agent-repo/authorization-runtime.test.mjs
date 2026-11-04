import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAuthorizationRuntime} from './authorization-runtime.mjs';
test('host hook audits unknown identities and enforcement blocks; other Agents unaffected',async()=>{
 let policy,service,mode='audit',closed=false;const audits=[];
 const api={registerTrustedToolPolicy:value=>policy=value,registerService:value=>service=value};
 const store={agentId:'ada',mode:()=>mode,audit:(...args)=>audits.push(args),close:()=>{closed=true;}};
 registerAuthorizationRuntime(api,{agents:{ada:{repo:'/unused'}}},{openStore:()=>store,openGraph:()=>({}),resolveOperation:()=>undefined});
 assert.equal(await policy.evaluate({toolName:'exec',params:{}},{agentId:'other'}),undefined);
 assert.equal(await policy.evaluate({toolName:'exec',params:{}},{agentId:'ada'}),undefined);
 mode='enforce';assert.equal((await policy.evaluate({toolName:'exec',params:{}},{agentId:'ada'})).block,true);
 assert.equal(audits.length,2);service.stop();assert.equal(closed,true);
});
test('missing public policy API is explicit rather than silently unguarded',()=>assert.throws(()=>registerAuthorizationRuntime({}, {agents:{}}),/trusted tool policy/));
test('shipped manifest declares the exact installed policy contract',async()=>{
 const {readFile}=await import('node:fs/promises');const manifest=JSON.parse(await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 assert.ok(manifest.contracts.trustedToolPolicies.includes('agent-repo-authorization'));
});
test('missing Agent identity cannot silently bypass configured authorization',async()=>{
 let policy;registerAuthorizationRuntime({registerTrustedToolPolicy:value=>policy=value},{agents:{ada:{repo:'/unused'}}});
 assert.equal((await policy.evaluate({toolName:'exec',params:{}},{})).block,true);
});
test('capability discovery fails closed when storage or mode cannot be read',async()=>{
 for(const openStore of [()=>{throw Error('storage unavailable');},()=>({mode:()=>{throw Error('corrupt mode');}})]){
  const runtime=registerAuthorizationRuntime({registerTrustedToolPolicy:()=>{}},{agents:{ada:{repo:'/unused'}}},{openStore});
  assert.deepEqual(await runtime.prepare({}, {agentId:'ada'}),{toolsAllow:[]});
  assert.deepEqual(await runtime.prepare({}, {}),{toolsAllow:[]});
  assert.equal(await runtime.prepare({}, {agentId:'other'}),undefined);
 }
});
test('discovery adapter failure preserves a successfully read audit mode only',async()=>{
 for(const mode of ['audit','enforce']){
  const runtime=registerAuthorizationRuntime({registerTrustedToolPolicy:()=>{}},{agents:{ada:{repo:'/unused'}}},{openStore:()=>({mode:()=>mode}),openGraph:()=>{throw Error('graph unavailable');}});
  assert.deepEqual(await runtime.prepare({}, {agentId:'ada'}),mode==='audit'?undefined:{toolsAllow:[]});
 }
});
test('skill tool output cannot expose entries or shadowed paths without its trusted invocation',async()=>{
 const runtime=registerAuthorizationRuntime({registerTrustedToolPolicy:()=>{}},{agents:{ada:{repo:'/unused'}}},{openStore:()=>({mode:()=>'enforce'})});
 const catalog={skills:[{name:'secret',path:'private/SKILL.md'}],shadowed:[{name:'secret',path:'shadowed/SKILL.md'}]};
 const filtered=await runtime.filterSkills(catalog,{agentId:'ada',sessionKey:'session',toolCallId:'missing'});
 assert.deepEqual(filtered.skills,[]);assert.deepEqual(filtered.shadowed,[]);
});
