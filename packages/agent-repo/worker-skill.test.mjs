import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {renderWorkerSkill,publishWorkerSkill,createWorkerSkillPublisher} from './worker-skill.mjs';
import {createProjectService} from './project-service.mjs';
const plugins={plugins:[{id:'feishu',name:'Feishu',version:'1.0',runtime:{state:'active'},config:{secret:'never-export'}},{id:'off',runtime:{state:'disabled'}},{id:'broken',runtime:{state:'service-failed'}}]};
const catalog={agentId:'main',groups:[{source:'core',tools:[{id:'exec'}]},{source:'plugin',pluginId:'feishu',tools:[{id:'feishu_doc',description:'Read and update docs'}]},{source:'plugin',pluginId:'off',tools:[{id:'disabled_tool'}]}]};
test('Agent Repo generates a deterministic active-plugin catalog plus protocol without exporting configuration',()=>{
 const body=renderWorkerSkill('main',plugins,catalog);
 for(const value of ['feishu_doc','type=request','reply','自身已有权限内直接使用 Feishu CLI','会话过滤前候选工具'])assert.ok(body.includes(value));
 for(const value of ['never-export','disabled_tool','"exec"'])assert.ok(!body.includes(value));
 assert.equal(body,renderWorkerSkill('main',{plugins:plugins.plugins.toReversed()},catalog));
 assert.throws(()=>renderWorkerSkill('other',plugins,catalog));
});
test('publication isolates Agents, preserves pinned revisions and keeps global skills explicit-only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'repo-worker-skill-'));
 try {
  const body=renderWorkerSkill('main',plugins,catalog),first=await publishWorkerSkill(root,'main',body);
  assert.equal(first.path,join(root,'skills/openclaw-main-main/SKILL.md'));
  assert.match(await readFile(join(root,'skills/openclaw-main-main/agents/openai.yaml'),'utf8'),/allow_implicit_invocation: false/);
  const next=await publishWorkerSkill(root,'main',body+'\nUpdated protocol.');
  assert.notEqual(next.revision,first.revision);assert.equal(next.path,first.path);
  assert.equal(await readFile(first.revisionPath,'utf8'),body);
  const other=await publishWorkerSkill(root,'other',renderWorkerSkill('other',plugins,{...catalog,agentId:'other'}));
  assert.notEqual(other.path,first.path);
  await mkdir(join(root,'skills/openclaw-main-existing'));await writeFile(join(root,'skills/openclaw-main-existing/SKILL.md'),'my skill');
  await assert.rejects(publishWorkerSkill(root,'existing','overwrite'),/without ownership/);
  assert.equal(await readFile(join(root,'skills/openclaw-main-existing/SKILL.md'),'utf8'),'my skill');
  await symlink(join(root,'skills/openclaw-main-main'),join(root,'skills/openclaw-main-linked'));
  await assert.rejects(publishWorkerSkill(root,'linked','overwrite'),/managed directory/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('publisher queries public host catalogs, coalesces requests and service fixes the trusted Agent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'repo-worker-publisher-'));
 try {
  const calls=[];const publisher=createWorkerSkillPublisher(()=>({plugins:{entries:{'agent-worker':{config:{codexHome:root}}}}}),async(method,params)=>{calls.push({method,params});return method==='plugins.list'?plugins:catalog;});
  const [a,b]=await Promise.all([publisher('main'),publisher('main')]);assert.deepEqual(a,b);assert.equal(calls.length,2);
  assert.deepEqual(calls.find(c=>c.method==='tools.catalog').params,{agentId:'main',includePlugins:true});
  const service=createProjectService({repo:root},'main',()=>({}),undefined,publisher);
  assert.equal((await service.prepareWorkerSkill({agentId:'other',codexHome:'/ignored'})).agentId,'main');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('catalog outages reuse only a verified previous skill and subsequent refreshes still update it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'repo-worker-cache-'));
 try {
  let offline=false,version='1.0';const warnings=[];
  const publisher=createWorkerSkillPublisher(()=>({plugins:{entries:{'agent-worker':{config:{codexHome:root}}}}}),async method=>{
   if(offline)throw Error('catalog unavailable');return method==='plugins.list'?{plugins:plugins.plugins.map(plugin=>({...plugin,version}))}:catalog;
  },{logger:{warn:message=>warnings.push(message)}});
  offline=true;await assert.rejects(publisher('main'),/catalog unavailable/);
  offline=false;const first=await publisher('main');
  offline=true;assert.deepEqual(await publisher('main'),first);assert.equal(warnings.length,1);
  await writeFile(first.revisionPath,'tampered');await assert.rejects(publisher('main'),/catalog unavailable/);
  offline=false;assert.deepEqual(await publisher('main'),first);
  version='2.0';const next=await publisher('main');assert.notEqual(next.revision,first.revision);
  offline=true;assert.deepEqual(await publisher('main'),next);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an interrupted update falls back to the committed immutable revision and later publishes normally',async()=>{
 const root=await mkdtemp(join(tmpdir(),'repo-worker-interrupted-update-'));
 let child;
 try {
  const body=renderWorkerSkill('main',plugins,catalog),first=await publishWorkerSkill(root,'main',body),updated=body+'\nUpdated catalog.\n';
  const module=new URL('./worker-skill.mjs',import.meta.url).href;
  // Pause after SKILL.md replacement but before the commit marker rename.
  const code=`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.promises.rename;fs.promises.rename=async(a,b)=>{if(b.endsWith('/.agent-repo.json')){console.log('ready');await new Promise(()=>{});}return rename(a,b);};syncBuiltinESMExports();const{publishWorkerSkill}=await import(${JSON.stringify(module)});setInterval(()=>{},1000);await publishWorkerSkill(${JSON.stringify(root)},'main',${JSON.stringify(updated)});`;
  child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','inherit']});
  await Promise.race([once(child.stdout,'data',{signal:AbortSignal.timeout(10000)}),once(child,'exit').then(()=>{throw Error('update exited before commit');})]);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  assert.equal(await readFile(first.path,'utf8'),updated);
  const marker=JSON.parse(await readFile(join(root,'skills/openclaw-main-main/.agent-repo.json'),'utf8'));
  assert.equal(marker.revision,first.revision);
  let offline=true;
  const publisher=createWorkerSkillPublisher(()=>({plugins:{entries:{'agent-worker':{config:{codexHome:root}}}}}),async method=>{
   if(offline)throw Error('catalog unavailable');return method==='plugins.list'?plugins:catalog;
  });
  const cached=await publisher('main');assert.deepEqual(cached,first);
  assert.equal(await readFile(cached.revisionPath,'utf8'),body);
  // A valid uncommitted newer file must not mask corruption of the committed revision.
  await writeFile(first.revisionPath,'tampered');await assert.rejects(publisher('main'),/catalog unavailable/);
  await writeFile(first.revisionPath,body);
  offline=false;assert.deepEqual(await publisher('main'),first);
  assert.equal(await readFile(first.path,'utf8'),body);
  const next=await publishWorkerSkill(root,'main',updated);assert.notEqual(next.revision,first.revision);
  offline=true;assert.deepEqual(await publisher('main'),next);
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  await rm(root,{recursive:true,force:true});
 }
});
