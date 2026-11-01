import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {queryKnowledge,resolveKnowledgeConfig} from './knowledge.mjs';
import {projectTool} from './index.mjs';
import {resolveConfiguration} from './configuration.mjs';
import {repoToolActions} from './cli-capabilities.mjs';
const time='2026-11-01T10:00:00+08:00';
function md(uid,ns='x_agent',extra={},x={}){return '---\n'+JSON.stringify({type:'Guide',title:'知识 '+uid,description:'source-backed knowledge',status:'draft',sources:[],[ns]:{uid,owner:null,created_at:time,updated_at:time,relations:[],...x},...extra},null,2)+'\n---\n\n# 知识\n\n附件持久化验证\n';}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'knowledge-api-'));t.after(()=>rm(root,{recursive:true,force:true}));const project={projectId:'demo',paths:{repository:root,knowledge:join(root,'wiki')}};const put=async(path,data)=>{await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),typeof data==='string'?data:JSON.stringify(data));};return {root,project,put,query:p=>queryKnowledge(project,p)};}
async function normalized(f,ns='x_agent'){await f.put('wiki/bundle.json',{schema_version:1,bundle_id:'demo',metadata_namespace:ns});await f.put('wiki/index.md',md('index',ns));}
test('plain wiki supports Unicode literal search, stable paging and bounded line reads without metadata',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md','# 附件\n持久化修复\n更多\n');await f.put('wiki/b.md','# 附件\n持久化已验证');
 const a=await f.query({action:'knowledge_search',query:'附件 持久化',limit:1});assert.equal(a.total,2);assert.equal(a.entries[0].path,'a.md');assert.equal(a.nextOffset,1);assert.equal(a.normalized,false);
 const b=await f.query({action:'knowledge_search',query:'附件 持久化',limit:1,offset:1});assert.equal(b.entries[0].path,'b.md');assert.equal(a.revision,b.revision);
 const r=await f.query({action:'knowledge_read',path:'a.md',startLine:2,maxLines:1});assert.equal(r.content,'持久化修复');assert.equal(r.nextLine,3);
 const listing=await f.query({action:'knowledge_list',limit:1});assert.equal(listing.total,2);assert.equal(listing.entries[0].path,'a.md');assert.equal(listing.entries[0].line,1);assert.equal(listing.nextOffset,1);assert.equal((await f.query({action:'knowledge_list',limit:1,offset:1})).entries[0].path,'b.md');await assert.rejects(f.query({action:'knowledge_list',query:'ignored'}));
 const v=await f.query({action:'knowledge_validate'});assert.equal(v.valid,true);
});
test('normalized JSON-compatible and YAML frontmatter both support UID reads',async t=>{
 const f=await fixture(t);await normalized(f);await f.put('wiki/a.md',md('a'));await f.put('wiki/b.md','---\ntype: Guide\ntitle: YAML\ndescription: text\nstatus: draft\nx_agent:\n  uid: b\n  created_at: "'+time+'"\n  updated_at: "'+time+'"\n  relations: []\n---\nYAML body');
 assert.equal((await f.query({action:'knowledge_read',uid:'a'})).entry.path,'a.md');assert.equal((await f.query({action:'knowledge_read',uid:'b'})).entry.title,'YAML');assert.equal((await f.query({action:'knowledge_validate'})).valid,true);
});
test('project.json namespace overrides Bundle, no document-field guessing, no source mutation',async t=>{
 const f=await fixture(t);await normalized(f);await f.put('project.json',{knowledge:{metadata_namespace:'x_xgj'}});await f.put('wiki/index.md',md('index','x_xgj'));await f.put('wiki/a.md',md('business','x_xgj'));
 const before=await readFile(join(f.root,'wiki/a.md'));const r=await f.query({action:'knowledge_read',uid:'business'});assert.equal(r.metadataNamespace,'x_xgj');assert.equal(r.namespaceSource,'project.json');assert.equal((await f.query({action:'knowledge_validate'})).valid,true);assert.deepEqual(await readFile(join(f.root,'wiki/a.md')),before);
 await f.put('project.json',{});const v=await f.query({action:'knowledge_validate'});assert.equal(v.metadataNamespace,'x_agent');assert.equal(v.valid,false);assert.ok(v.errors.some(e=>e.code==='metadata_namespace_missing'));
});
test('Bundle namespace and default namespace are supported without project config',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md','# 普通知识');assert.equal((await f.query({action:'knowledge_validate'})).metadataNamespace,'x_agent');await normalized(f,'x_xgj');assert.equal((await f.query({action:'knowledge_validate'})).namespaceSource,'bundle.json');
});
for(const value of ['__proto__','x_bad/path','x_xgj\n',null,123])test('invalid namespace fails explicitly: '+JSON.stringify(value),async t=>{
 const f=await fixture(t);await f.put('project.json',{knowledge:{metadata_namespace:value}});await assert.rejects(f.query({action:'knowledge_validate'}),/KNOWLEDGE_NAMESPACE_INVALID/);
});
test('missing knowledge is unavailable, never a clean validation success',async t=>{
 const f=await fixture(t);const r=await f.query({action:'knowledge_validate'});assert.equal(r.available,false);assert.equal(r.valid,null);
});
test('invalid config JSON and oversized configuration fail explicitly',async t=>{
 const f=await fixture(t);await f.put('project.json','{bad');await assert.rejects(f.query({action:'knowledge_validate'}),/KNOWLEDGE_CONFIG_INVALID/);await f.put('project.json',' '.repeat(65537));await assert.rejects(f.query({action:'knowledge_validate'}),/KNOWLEDGE_CONFIG_INVALID/);
});
test('duplicate UIDs make reads ambiguous and validation invalid',async t=>{
 const f=await fixture(t);await normalized(f);await f.put('wiki/a.md',md('dup'));await f.put('wiki/b.md',md('dup'));await assert.rejects(f.query({action:'knowledge_read',uid:'dup'}),/KNOWLEDGE_UID_AMBIGUOUS/);assert.ok((await f.query({action:'knowledge_validate'})).errors.some(e=>e.code==='duplicate_uid'));
});
test('relations, sources, frontmatter, calendar, status and file targets are validated',async t=>{
 const f=await fixture(t);await normalized(f);await f.put('wiki/a.md',md('a','x_agent',{status:'stable',sources:[{id:'a',title:'source',resource:'../private.md'}]}, {relations:[{type:'references',target_uid:'absent'}],updated_at:'2099-02-30T00:00:00Z'})+'[bad](missing.md)\n[file](file:///private.md)');await f.put('wiki/bad.md','---\ninvalid: [\n---\nbody');
 const v=await f.query({action:'knowledge_validate'});for(const code of ['review_missing','source_outside_scope','relation_target_missing','timestamps_invalid','link_missing_or_unsafe','frontmatter_invalid','link_outside_scope'])assert.ok(v.errors.some(e=>e.code===code),code);assert.equal(v.valid,false);
});
test('navigation with minimal namespace times is valid; code link examples are ignored',async t=>{
 const f=await fixture(t);await normalized(f);await f.put('wiki/index.md','---\nx_agent:\n  created_at: "'+time+'"\n  updated_at: "'+time+'"\n---\n# 导航\n```md\n[example](none.md)\n```\n`[example](missing.md)`');assert.equal((await f.query({action:'knowledge_validate'})).valid,true);
});
test('source packages and real relation targets pass without calling an external service',async t=>{
 const f=await fixture(t);await normalized(f);await f.put('wiki/sources/documents/one/index.md',md('source'));await f.put('wiki/a.md',md('a','x_agent',{sources:[{id:'s',title:'Source',resource:'sources/documents/one/index.md'}]},{relations:[{type:'references',target_uid:'source'}]})+'[remote](https://example.invalid/not-fetched)');assert.equal((await f.query({action:'knowledge_validate'})).valid,true);
});
test('traversal, absolute paths, excluded tools, symlinks and hardlinks never disclose their contents',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md','# Public');await f.put('private.md','PRIVATE');await f.put('wiki/.agents/internal.md','PRIVATE');await symlink(join(f.root,'private.md'),join(f.root,'wiki/link.md'));await link(join(f.root,'private.md'),join(f.root,'wiki/hard.md'));
 for(const path of ['../private.md','/private.md','.agents/internal.md','a/../a.md'])await assert.rejects(f.query({action:'knowledge_read',path}),/KNOWLEDGE_PATH_DENIED/);
 const r=await f.query({action:'knowledge_search',query:'PRIVATE'});assert.equal(r.total,0);assert.equal(r.complete,false);assert.equal((await f.query({action:'knowledge_validate'})).valid,null);await assert.rejects(f.query({action:'knowledge_read',uid:'anything'}),/KNOWLEDGE_SCAN_INCOMPLETE/);
});
test('long-line and line-window output remain bounded and pagination advances',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md','中'.repeat(20000)+'\nlast');const r=await f.query({action:'knowledge_read',path:'a.md'});assert.ok(Buffer.byteLength(r.content)<=32768);assert.equal(r.lineTruncated,true);assert.equal(r.nextLine,2);
});
test('oversized Markdown produces incomplete results, not silent success',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md','x'.repeat(262145));const r=await f.query({action:'knowledge_validate'});assert.equal(r.complete,false);assert.equal(r.valid,null);
});
test('only the bound knowledge directory is scanned',async t=>{
 const f=await fixture(t);await f.put('custom/a.md','# Scoped');await f.put('wiki/b.md','# Other');const p={...f.project,paths:{...f.project.paths,knowledge:join(f.root,'custom')}};assert.equal((await queryKnowledge(p,{action:'knowledge_search',query:'Other'})).total,0);
});
test('knowledge actions are discovered by tool/CLI, require project selection and reject unrelated arguments',async t=>{
 const f=await fixture(t);await f.put('projects/demo/wiki/a.md','# Demo');await f.put('projects/other/wiki/a.md','# Other');await f.put('projects.json',{schemaVersion:1,projects:Object.fromEntries(['demo','other'].map(id=>[id,{name:id,url:'https://example.invalid/'+id+'.git',branch:'main',repository:'projects/'+id,skills:[]}]))});
 const tool=projectTool(resolveConfiguration({agents:{main:{repo:f.root}}}),{agentId:'main'});for(const a of ['knowledge_search','knowledge_read','knowledge_validate','knowledge_graph'])assert.ok(repoToolActions.includes(a));
 await assert.rejects(tool.execute('',{action:'knowledge_search',query:'Demo'}),/Select a registered projectId/);
 const globalTool=projectTool(resolveConfiguration({knowledge:{metadataNamespace:'x_xgj'},agents:{main:{repo:f.root}}}),{agentId:'main'});const graph=JSON.parse((await globalTool.execute('',{action:'knowledge_graph',projectId:'demo'})).content[0].text);assert.equal(graph.metadataNamespace,'x_xgj');assert.equal(graph.namespaceSource,'global');assert.equal(graph.nodes.length,1);
 const r=JSON.parse((await tool.execute('',{action:'knowledge_search',projectId:'demo',query:'Demo'})).content[0].text);assert.equal(r.total,1);assert.equal(r.entries[0].path,'a.md');
 await assert.rejects(tool.execute('',{action:'knowledge_read',projectId:'demo',path:'a.md',repository:'projects/other'}),/KNOWLEDGE_ARGUMENT_INVALID/);
 await assert.rejects(tool.execute('',{action:'knowledge_validate',projectId:'demo',name:'person'}),/KNOWLEDGE_ARGUMENT_INVALID/);
 await assert.rejects(tool.execute('',{action:'inspect',projectId:'demo',path:'a.md'}),/Knowledge parameters/);
});
test('collection scan limits return incomplete rather than validating an unseen remainder',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'wiki'));for(let start=0;start<2001;start+=100)await Promise.all(Array.from({length:Math.min(100,2001-start)},(_,i)=>f.put('wiki/'+String(start+i).padStart(4,'0')+'.md','# Doc')));
 const r=await f.query({action:'knowledge_validate'});assert.equal(r.scanned,2000);assert.equal(r.complete,false);assert.equal(r.valid,null);assert.ok(r.issues.some(i=>i.code==='scan_limit'));
});
test('extra parameters, invalid pages and ambiguous read selectors are rejected',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md','# Doc');
 for(const args of [{action:'knowledge_search',query:'['.repeat(321)},{action:'knowledge_search',query:'Doc',limit:101},{action:'knowledge_read',path:'a.md',uid:'a'},{action:'knowledge_read',path:5,uid:'a'},{action:'knowledge_read',path:'a.md',maxLines:201}])await assert.rejects(f.query(args),/KNOWLEDGE_ARGUMENT_INVALID|KNOWLEDGE_PATH_DENIED/);
});

test('knowledge graph resolves Markdown links, encoded relative paths and references while ignoring code, images and outside targets',async t=>{
 const f=await fixture(t);await f.put('wiki/start.md','# Start\n\n[child](nested/a.md#标题) [child twice](nested/a.md) [encoded](other%20guide.md) [reference][ref]\n\n[ref]: nested/a.md "title"\n\n`[inline](wrong.md)`\n\n```md\n[fenced](wrong.md)\n```\n\n![image](wrong.md) [outside](../private.md) [web](https://example.invalid) [missing](missing.md)');await f.put('wiki/nested/a.md','# Child\n\n[back](../start.md)');await f.put('wiki/other guide.md','# Other');
 const result=await f.query({action:'knowledge_graph'});assert.equal(result.totalNodes,3);assert.deepEqual(result.edges.map(e=>[e.source,e.target,e.kind]),[['nested/a.md','start.md','link'],['start.md','nested/a.md','link'],['start.md','other guide.md','link']]);assert.equal(result.unresolvedReferences,1);assert.equal(result.complete,true);assert.equal(result.scope,'local_document_references');assert.ok(!JSON.stringify(result).includes('fenced'));assert.ok(!JSON.stringify(result).includes('private.md'));
});
test('global knowledge defaults consistently apply to read, search, validate and graph, with explicit project and Bundle overrides',async t=>{
 const f=await fixture(t),defaults={metadataNamespace:'x_xgj'};await f.put('wiki/a.md',md('a','x_xgj',{}, {relations:[{type:'depends_on',target_uid:'b'}]}));await f.put('wiki/b.md',md('b','x_xgj'));
 for(const args of [{action:'knowledge_read',uid:'a'},{action:'knowledge_search',query:'a'},{action:'knowledge_validate'},{action:'knowledge_graph'}]){const r=await queryKnowledge(f.project,args,defaults);assert.equal(r.metadataNamespace,'x_xgj');assert.equal(r.namespaceSource,'global');if(args.action==='knowledge_read')assert.equal(r.entry.uid,'a');if(args.action==='knowledge_graph')assert.deepEqual(r.edges,[{source:'a.md',target:'b.md',kind:'relation',relation:'depends_on'}]);}
 assert.equal((await f.query({action:'knowledge_graph'})).metadataNamespace,'x_agent');
 await f.put('wiki/bundle.json',{schema_version:1,bundle_id:'demo',metadata_namespace:'x_agent'});assert.equal((await queryKnowledge(f.project,{action:'knowledge_graph'},defaults)).namespaceSource,'bundle.json');
 await f.put('project.json',{knowledge:{metadata_namespace:'x_xgj'}});const r=await queryKnowledge(f.project,{action:'knowledge_graph'},defaults);assert.equal(r.namespaceSource,'project.json');assert.equal(r.edges.length,1);
 await assert.rejects(queryKnowledge(f.project,{action:'knowledge_graph'},{metadataNamespace:'invalid'}),/KNOWLEDGE_NAMESPACE_INVALID/);
});
test('graph never guesses duplicate UIDs, cross-Bundle targets, or UID uniqueness during an incomplete scan',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md',md('a','x_agent',{}, {relations:[{type:'references',target_uid:'dup'},{type:'references',target_uid:'external',target_bundle:'other'}]})+'[local](b.md)');await f.put('wiki/b.md',md('dup'));await f.put('wiki/c.md',md('dup'));
 let r=await f.query({action:'knowledge_graph'});assert.equal(r.unresolvedReferences,1);assert.deepEqual(r.edges,[{source:'a.md',target:'b.md',kind:'link'}]);
 await f.put('wiki/c.md',md('unique'));await symlink(join(f.root,'wiki/b.md'),join(f.root,'wiki/alias.md'));r=await f.query({action:'knowledge_graph'});assert.equal(r.complete,false);assert.equal(r.scanComplete,false);assert.equal(r.unresolvedReferences,1);assert.ok(r.nodes.every(n=>n.path!=='alias.md'));assert.ok(r.edges.every(e=>e.kind==='link'));
});
test('graph limits produce a partial graph without dangling edges and reject unsupported selectors',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md','# A\n\n[B](b.md)');await f.put('wiki/b.md','# B');const r=await f.query({action:'knowledge_graph',limit:1});assert.equal(r.nodes.length,1);assert.equal(r.totalNodes,2);assert.equal(r.truncated,true);assert.equal(r.complete,false);assert.equal(r.omittedEdges,1);assert.deepEqual(r.edges,[]);
 for(const args of [{limit:101},{limit:0},{limit:'2'},{offset:1},{path:'a.md'},{metadataNamespace:'x_private'}])await assert.rejects(f.query({action:'knowledge_graph',...args}),/KNOWLEDGE_ARGUMENT_INVALID/);
});
test('graph reports reference and invalid-metadata bounds instead of presenting a complete graph',async t=>{
 const f=await fixture(t);await f.put('wiki/a.md','# A\n\n'+Array.from({length:10001},()=> '[B](b.md)').join(' '));await f.put('wiki/b.md','# B');let r=await f.query({action:'knowledge_graph'});assert.equal(r.referenceLimit,true);assert.equal(r.complete,false);assert.equal(r.edges.length,1);
 await f.put('wiki/a.md','---\nbroken: [\n---\n[A](b.md)');r=await f.query({action:'knowledge_graph'});assert.equal(r.invalidDocuments,1);assert.equal(r.complete,false);assert.equal(r.edges.length,0);
});

test('graph edge budget keeps a closed bounded graph and explicitly reports omitted relationships',async t=>{
 const f=await fixture(t),paths=Array.from({length:35},(_,i)=>String(i).padStart(2,'0')+'.md');for(const file of paths)await f.put('wiki/'+file,'# '+file+'\n\n'+paths.filter(p=>p!==file).map(p=>'[doc]('+p+')').join(' '));
 const r=await f.query({action:'knowledge_graph'}),present=new Set(r.nodes.map(n=>n.path));assert.equal(r.nodes.length,35);assert.equal(r.edges.length,1000);assert.equal(r.omittedEdges,190);assert.equal(r.truncated,true);assert.equal(r.complete,false);assert.ok(r.edges.every(e=>present.has(e.source)&&present.has(e.target)));
});
