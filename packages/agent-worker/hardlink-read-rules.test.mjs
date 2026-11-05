import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,link,symlink,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sharedHardlinkReadRules} from './hardlink-read-rules.mjs';
async function fixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'hardlink-rules-')));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'source'),workspace=join(root,'workspace');await mkdir(source);await mkdir(workspace);return {root,source,workspace};}
test('existing shared inodes become exact read rules while private workspace files stay writable',async t=>{
 const f=await fixture(t),source=join(f.source,'source.txt'),linked=join(f.workspace,'linked.txt'),owned=join(f.workspace,'own.txt');await writeFile(source,'source');await link(source,linked);await writeFile(owned,'owned');
 assert.deepEqual(await sharedHardlinkReadRules(f.workspace),{[linked]:'read'});assert.equal(await readFile(source,'utf8'),'source');assert.equal(await readFile(owned,'utf8'),'owned');
});
test('nested write roots deduplicate and traversal does not follow directory or file symlinks',async t=>{
 const f=await fixture(t),child=join(f.workspace,'child');await mkdir(child);await writeFile(join(f.source,'file'),'outside');await link(join(f.source,'file'),join(child,'shared'));await symlink(f.source,join(f.workspace,'source-link'));await symlink(f.workspace,join(child,'cycle'));await symlink(join(f.source,'file'),join(f.workspace,'linked-file'));
 assert.deepEqual(await sharedHardlinkReadRules([f.workspace,child,f.workspace]),{[join(child,'shared')]:'read'});
 await assert.rejects(sharedHardlinkReadRules(join(f.workspace,'source-link')),/symlinks/);
});
test('aborted, expired and unavailable scans never return partial writable policy',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(sharedHardlinkReadRules(f.workspace,{signal:controller.signal}),{name:'AbortError'});
 await assert.rejects(sharedHardlinkReadRules(f.workspace,{deadline:Date.now()-1}),{code:'EXECUTION_TIMEOUT'});await assert.rejects(sharedHardlinkReadRules(join(f.root,'missing')),{code:'ENOENT'});
});
