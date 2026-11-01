import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readProjectContext} from './project-context.mjs';
import {skillTaskContext} from '../agent-worker/skill-refresh.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'project-context-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,put:async(p,v)=>{await mkdir(join(root,p,'..'),{recursive:true});await writeFile(join(root,p),typeof v==='string'?v:JSON.stringify(v));}};}
const git={delivery:'review',auto_merge:false,branch_prefix:'codex/',sync:'ff-only'};
test('arbitrary repositories need no template metadata',async t=>{
 const f=await fixture(t),r=await readProjectContext(f.root);assert.equal(r.project.status,'missing');assert.equal(r.git.status,'missing');assert.equal(r.validation.status,'missing');assert.equal(r.bundle.status,'missing');
});
test('template project exposes only bounded metadata and script names, not commands or tools',async t=>{
 const f=await fixture(t);await f.put('project.json',{schema_version:1,project_id:'demo',name:'Demo',git,tools:{token:'PRIVATE'},verification:{commands:['SECRET_COMMAND']}});
 await f.put('package.json',{engines:{node:'>=22'},scripts:{check:'node check.mjs --token PRIVATE',test:'node --test',hidden:'SECRET'}});
 await f.put('wiki/bundle.json',{schema_version:1,bundle_id:'demo',title:'Demo wiki',metadata_namespace:'x_agent',credential:'PRIVATE'});
 const r=await readProjectContext(f.root);assert.equal(r.git.delivery,'review');assert.equal(r.git.source,'project.json');assert.deepEqual(r.validation.scripts,['check','test']);assert.equal(r.validation.node,'>=22');assert.equal(r.bundle.metadataNamespace,'x_agent');assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(!JSON.stringify(r).includes('SECRET'));
 const c=skillTaskContext({protocol:1,root:f.root,catalog:[],projectMetadata:r});assert.deepEqual(c.projectMetadata,r);assert.match(c.instruction,/不自动执行配置/);
});
test('independent wiki policy is supported without a project file',async t=>{
 const f=await fixture(t);await f.put('git-policy.json',{schema_version:1,...git,delivery:'local'});await f.put('bundle.json',{schema_version:1,bundle_id:'standalone',metadata_namespace:'x_agent'});const r=await readProjectContext(f.root);assert.equal(r.git.delivery,'local');assert.equal(r.bundle.bundleId,'standalone');
});
test('explicit project policy wins and invalid policy never falls back',async t=>{
 const f=await fixture(t);await f.put('git-policy.json',{schema_version:1,...git,delivery:'direct'});
 for(const value of [{...git,delivery:'read-only'},{...git,delivery:'bad'},{...git,auto_merge:true},null]){
  await f.put('project.json',{schema_version:1,git:value});const r=await readProjectContext(f.root);assert.equal(r.git.source,'project.json');assert.equal(r.git.status,value?.delivery==='read-only'?'available':'invalid');
 }
 await f.put('project.json','{bad');assert.equal((await readProjectContext(f.root)).git.status,'invalid');
});
test('oversized, malformed and symbolic metadata is not loaded or disclosed',async t=>{
 const f=await fixture(t);await f.put('project.json','x'.repeat(65537));assert.equal((await readProjectContext(f.root)).project.status,'invalid');
 await rm(join(f.root,'project.json'));const outside=join(f.root,'..',f.root.split('/').at(-1)+'-private.json');t.after(()=>rm(outside,{force:true}));await writeFile(outside,JSON.stringify({schema_version:1,name:'PRIVATE'}));await symlink(outside,join(f.root,'project.json'));
 const r=await readProjectContext(f.root);assert.equal(r.project.status,'invalid');assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('knowledge selection is bound to caller scope, never to project hints',async t=>{
 const f=await fixture(t);await f.put('project.json',{schema_version:1,knowledge:{path:'../private'}});await f.put('custom/bundle.json',{schema_version:1,bundle_id:'custom'});await f.put('wiki/bundle.json',{schema_version:1,bundle_id:'default'});
 assert.equal((await readProjectContext(f.root,join(f.root,'custom'))).bundle.bundleId,'custom');assert.equal((await readProjectContext(f.root)).bundle.bundleId,'default');assert.equal((await readProjectContext(f.root,join(f.root,'../outside'))).bundle.status,'invalid');
});
test('effective knowledge namespace is configurable and exposed without requiring template schema',async t=>{
 const f=await fixture(t);await f.put('project.json',{knowledge:{metadata_namespace:'x_xgj'}});await f.put('wiki/bundle.json',{schema_version:1,bundle_id:'legacy',metadata_namespace:'x_agent'});
 const r=await readProjectContext(f.root);assert.equal(r.knowledge.metadataNamespace,'x_xgj');assert.equal(r.knowledge.namespaceSource,'project.json');
 await f.put('project.json',{knowledge:{metadata_namespace:'invalid/path'}});assert.equal((await readProjectContext(f.root)).knowledge.status,'invalid');
});


test('project context uses the same global namespace default as knowledge queries',async t=>{
 const f=await fixture(t);const defaults={metadataNamespace:'x_xgj'};assert.equal((await readProjectContext(f.root,undefined,defaults)).knowledge.namespaceSource,'global');assert.equal((await readProjectContext(f.root,undefined,defaults)).knowledge.metadataNamespace,'x_xgj');
 await f.put('project.json',{knowledge:{metadata_namespace:'x_agent'}});assert.equal((await readProjectContext(f.root,undefined,defaults)).knowledge.namespaceSource,'project.json');
});
