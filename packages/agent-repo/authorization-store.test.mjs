import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluatePermissions} from './authorization-policy.mjs';
import {createAuthorizationStore} from './authorization-store.mjs';
import {workerAuthorizationResources} from './authorization-worker.mjs';
function setup(t){const root=mkdtempSync(join(tmpdir(),'auth-store-'));const store=createAuthorizationStore(root,{agentId:'ada'});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,root};}
test('independent database initializes exactly three groups without entity changes',t=>{
 const {store,root}=setup(t);assert.deepEqual(store.list('groups').map(g=>g.id),['administrator','external','internal']);
 assert.equal(store.list('rules').length,3);assert.equal(store.list('bindings').length,0);
 assert.equal(existsSync(join(root,'.runtime','agent_repo.sqlite')),false);
 assert.throws(()=>createAuthorizationStore(root,{agentId:'other'}),/another Agent/);
});
test('internal defaults admit Worker tasks and return results without granting business writes; external stays ungranted',t=>{
 const {store}=setup(t),resources=workerAuthorizationResources('ada');
 const write={id:'fixture-write',agentId:'ada',kind:'tool',provider:'fixture',actions:['discover','execute','update'],status:'active',verification:'verified',enforcement:'enforced',behavior:{access:'write',externalEffect:'none',sensitivity:'ordinary'}};
 for(const resource of [...resources,write]){store.saveResource(resource,{actor:'scanner'});store.applyDefaults(resource.id,{actor:'scanner'});}
 const allowed=(group,id,actions)=>evaluatePermissions({agentId:'ada',subject:{id:'person',agentId:'ada',verified:true},groups:[group],rules:store.effectiveRules(id),requirements:actions.map(action=>({resource:store.get('resources',id),action}))}).allowed;
 for(const group of ['administrator','internal']){
  for(const action of ['run','reply','steer'])assert.equal(allowed(group,'tool://agent-worker/agent_worker/'+action,['execute','delegate']),true);
  assert.equal(allowed(group,'delivery://agent-worker/result',['transfer']),true);
 }
 assert.equal(allowed('internal',write.id,['execute','update']),false);
 assert.equal(allowed('administrator',write.id,['execute','update']),true);
 assert.equal(allowed('external','tool://agent-worker/agent_worker/run',['execute','delegate']),false);
 assert.equal(allowed('external','delivery://agent-worker/result',['transfer']),false);
});
test('optimistic updates and audit are transactional',t=>{
 const {store}=setup(t),group=store.get('groups','internal');
 assert.throws(()=>store.saveGroup({...group,name:'Changed'},{actor:'operator'}),/conflict/);
 assert.throws(()=>store.saveGroup({...group,name:'Changed'},{expectedRevision:1}),/actor/);
 assert.equal(store.get('groups','internal').name,'内部组');assert.equal(store.history().length,0);
 const next=store.saveGroup({...group,name:'Changed'},{expectedRevision:1,actor:'operator'});
 assert.equal(next.revision,2);assert.equal(store.history().length,1);
});
test('bindings require existing groups and do not mutate entities',t=>{
 const {store}=setup(t);const binding={id:'b',agentId:'ada',groupId:'internal',entityId:'p1',entityType:'person',membership:'self',status:'active'};
 assert.throws(()=>store.saveBinding({...binding,groupId:'absent'},{actor:'operator'}));
 assert.throws(()=>store.saveBinding({...binding,membership:'descendants'},{actor:'operator'}));
 assert.equal(store.saveBinding(binding,{actor:'operator'}).revision,1);
});
test('resource revisions invalidate stale expected revision',t=>{
 const {store}=setup(t);const resource={id:'tool',agentId:'ada',kind:'capability',provider:'plugin',actions:['execute'],status:'pending',verification:'pending',enforcement:'missing'};
 store.saveResource(resource,{actor:'scanner'});
 assert.throws(()=>store.saveResource(resource,{actor:'scanner'}),/conflict/);
 assert.equal(store.saveResource({...resource,status:'active',verification:'verified',enforcement:'enforced'},{expectedRevision:1,actor:'operator'}).revision,2);
});
test('default grants bind revisions, remain idempotent and preserve conditions',t=>{
 const {store}=setup(t);
 const resource={id:'read-tool',agentId:'ada',kind:'capability',provider:'plugin',actions:['execute'],status:'active',verification:'verified',enforcement:'enforced',behavior:{sensitivity:'ordinary'}};
 store.saveResource(resource,{actor:'operator'});
 store.saveRule({id:'default-read',groupId:'internal',kind:'default',effect:'allow',actions:['execute'],selector:{providers:['plugin']},conditions:{projectId:['xgj'],sensitivity:['ordinary']}},{actor:'operator'});
 assert.equal(store.previewDefaults(resource.id).after.length,2);
 assert.equal(store.applyDefaults(resource.id,{actor:'scanner'}).length,2);
 const request={agentId:'ada',subject:{id:'person',agentId:'ada',verified:true},groups:['internal'],rules:store.effectiveRules(resource.id),requirements:[{resource:store.get('resources',resource.id),action:'execute'}]};
 assert.equal(evaluatePermissions(request).allowed,false);
 assert.equal(evaluatePermissions({...request,context:{projectId:'other'}}).allowed,false);
 assert.equal(evaluatePermissions({...request,context:{projectId:'xgj'}}).allowed,true);
 assert.equal(store.applyDefaults(resource.id,{actor:'scanner',context:{projectId:'xgj'}}).length,0);
 assert.deepEqual(store.effectiveRules(resource.id).find(rule=>rule.groupId==='internal').conditions.projectId,['xgj']);
 store.saveResource({...resource,behavior:{sensitivity:'restricted'}},{actor:'operator',expectedRevision:1});
 assert.equal(store.effectiveRules(resource.id).length,0);
});
test('drafts do not grant until publish and concurrent changes cannot be overwritten',t=>{
 const {store}=setup(t),rule={id:'drafted',groupId:'internal',effect:'allow',actions:['read'],selector:{}};
 const draft=store.draftRule(rule,{actor:'operator'});assert.equal(store.get('rules','drafted'),null);
 const published=store.publishPolicy(draft.id,{expectedRevision:1,actor:'operator'});assert.equal(published.status,'published');assert.equal(store.get('rules','drafted').revision,1);
 assert.throws(()=>store.publishPolicy(draft.id,{expectedRevision:1,actor:'operator'}),/conflict/);
 const next=store.draftRule({...rule,effect:'deny'},{expectedRevision:1,actor:'operator'});
 store.saveRule({...rule,actions:['read','update']},{expectedRevision:1,actor:'other'});
 assert.throws(()=>store.publishPolicy(next.id,{expectedRevision:1,actor:'operator'}),/conflict/);
 assert.equal(store.policyVersions().find(row=>row.id===next.id).status,'draft');assert.equal(store.get('rules','drafted').effect,'allow');
});
test('default recompute previews are read-only and reject concurrent policy changes',t=>{
 const {store}=setup(t),resource={id:'r',agentId:'ada',kind:'data',provider:'p',actions:['read'],status:'active',verification:'verified',enforcement:'enforced'};
 store.saveResource(resource,{actor:'operator'});const before=store.history().length;
 const preview=store.previewDefaults('r');assert.equal(preview.before.length,0);assert.equal(preview.after.length,1);assert.equal(store.history().length,before);
 store.recomputeDefaults('r',{expectedRevision:preview.revision,actor:'operator'});assert.equal(store.effectiveRules('r').length,1);
 assert.throws(()=>store.recomputeDefaults('r',{expectedRevision:preview.revision,actor:'operator'}),/preview changed/);
 const next=store.previewDefaults('r');store.saveGroup({...store.get('groups','administrator'),status:'disabled'},{expectedRevision:1,actor:'operator'});
 assert.throws(()=>store.recomputeDefaults('r',{expectedRevision:next.revision,actor:'operator'}),/preview changed/);
 const final=store.previewDefaults('r');assert.equal(final.after.length,0);store.recomputeDefaults('r',{expectedRevision:final.revision,actor:'operator'});assert.equal(store.effectiveRules('r').length,0);
});
test('broad executors never receive default administrator grants',t=>{
 const {store}=setup(t);store.saveResource({id:'exec',agentId:'ada',kind:'executor',provider:'openclaw',actions:['execute'],status:'active',verification:'verified',enforcement:'enforced',defaultAuthorization:'explicit-only'},{actor:'operator'});
 assert.deepEqual(store.applyDefaults('exec',{actor:'scanner'}),[]);assert.deepEqual(store.previewDefaults('exec').after,[]);assert.deepEqual(store.effectiveRules('exec'),[]);
});
test('continuation snapshots inherit the parent ceiling instead of newly granted rights',t=>{
 const {store}=setup(t),resource={id:'parent-read',agentId:'ada',kind:'data',provider:'p',actions:['read'],status:'active',verification:'verified',enforcement:'enforced'};
 store.saveResource(resource,{actor:'operator'});store.applyDefaults(resource.id,{actor:'scanner'});
 const parent=store.taskScope('parent','person',['administrator']);
 store.saveResource({...resource,id:'newly-added'},{actor:'operator'});store.applyDefaults('newly-added',{actor:'scanner'});
 const child=store.taskScope('child','person',['administrator','internal'],{parentScopeId:'parent'});
 assert.deepEqual(child.resources,parent.resources);assert.deepEqual(child.groupIds,parent.groupIds);
 assert.equal(child.resources.some(row=>row.id==='newly-added'),false);
 assert.deepEqual(store.taskScope('child','person',[]),child);
 assert.throws(()=>store.taskScope('child','person',[],{parentScopeId:'another'}),/parent changed/);
 assert.throws(()=>store.taskScope('foreign','someone-else',[],{parentScopeId:'parent'}),/requester mismatch/);
 assert.throws(()=>store.taskScope('missing','person',[],{parentScopeId:'absent'}),/missing/);
});
