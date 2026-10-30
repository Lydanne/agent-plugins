import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEntityStore,entitySyncTool} from './entities.mjs';
import {createPeopleStore} from './people.mjs';
import plugin,{projectTool} from './index.mjs';
import {createProjectInspector,registerProjectInspector} from './project-inspector.mjs';
import {getEntityService,registerEntityService} from '../agent-repo-api/entities.mjs';
const observation={typeId:'service',name:'工单服务',attributes:{url:'https://service.example.invalid'},source:{kind:'program',namespace:'cmdb',externalId:'service-1'},observedAt:'2026-01-01T00:00:00.000Z'};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'entities-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,store:createEntityStore(root)};}
test('typed upserts are idempotent, reject stale/conflicting writes and preserve omitted attributes',t=>{
 const {root,store}=fixture(t),first=store.upsert(observation);assert.equal(first.created,true);assert.equal(store.upsert(observation).unchanged,true);
 const next=store.upsert({...observation,name:'工单中心',attributes:{owner:'支持团队'},observedAt:'2026-01-02T00:00:00.000Z',revision:first.entity.revision});assert.equal(next.entity.id,first.entity.id);assert.equal(next.entity.attributes.url,observation.attributes.url);assert.equal(next.entity.attributes.owner,'支持团队');assert.equal(next.created,false);
 assert.throws(()=>store.upsert(observation),/过期/);assert.throws(()=>store.upsert({...observation,name:'冲突',observedAt:next.entity.observedAt}),/冲突/);assert.throws(()=>store.upsert({...observation,revision:first.entity.revision,observedAt:'2026-01-03T00:00:00.000Z'}),/变化/);
 assert.equal(statSync(join(root,'.runtime/agent_repo.sqlite')).mode&0o777,0o600);
 assert.equal(store.upsert({...observation,attributes:{url:null},observedAt:'2026-01-03T00:00:00.000Z'}).entity.attributes.url,null);
 assert.equal(createEntityStore(root).list().total,1);
});
test('custom types validate schema and retain separate identities for sources and types',t=>{
 const {store}=fixture(t);const definition={id:'contract',label:'合同资料',fields:{amount:{label:'金额',type:'number'},active:{label:'有效',type:'boolean'},tags:{label:'标签',type:'strings'}}};
 store.registerType(definition);store.registerType({...definition,label:'合同档案'});store.registerType({...definition,fields:{...definition.fields,note:{label:'备注',type:'string'}}});assert.throws(()=>store.registerType({...definition,fields:{}}),/不可删除/);assert.throws(()=>store.registerType({...definition,id:'person'}),/不可覆盖/);
 const first=store.upsert({...observation,typeId:'contract',attributes:{amount:42,active:false,tags:['测试']}});assert.equal(first.entity.attributes.active,false);
 assert.throws(()=>store.upsert({...observation,typeId:'contract',attributes:{amount:'42'}}),/类型不匹配/);assert.throws(()=>store.upsert({...observation,attributes:{password:'secret'}}),/未注册/);
 store.upsert(observation);store.upsert({...observation,source:{...observation.source,namespace:'inventory'}});assert.equal(store.types().sources.find(source=>source.namespace==='cmdb').count,2);assert.equal(store.list().total,3);assert.equal(store.list({source:'cmdb',typeId:'service'}).total,1);
 assert.throws(()=>store.upsert({...observation,typeId:'unknown'}),/注册/);assert.throws(()=>store.list({limit:101}),/分页/);assert.throws(()=>store.upsert({...observation,source:{...observation.source,namespace:'feishu'}}),/渠道/);assert.throws(()=>store.upsert({...observation,observedAt:'2026-02-31T00:00:00.000Z'}),/时间/);
});
test('Feishu people share the canonical graph without duplicating or losing corrections',t=>{
 const {root,store}=fixture(t),people=createPeopleStore(root);const person=people.observe({accountId:'a',appId:'app',openId:'ou_test',name:'来源姓名',email:'source@example.invalid'});
 let record=store.list({typeId:'person'}).entities[0];assert.equal(record.id,'person:'+person.id);assert.equal(record.legacyPersonId,person.id);
 people.update({id:person.id,revision:person.revision,patch:{name:'人工更正'}});record=store.get(record.id).entity;assert.equal(record.name,'人工更正');assert.equal(record.source.kind,'channel');assert.equal(store.types().types.find(type=>type.id==='person').count,1);
 const other=fixture(t);assert.equal(other.store.list().total,0);assert.equal(other.store.get(record.id).entity,null);
});
test('model and UI queries stay bound to the trusted Agent and sync tool cannot claim channel/program origin',async t=>{
 const {root,store}=fixture(t),config={agents:{main:{repo:root}}},ctx={agentId:'main',sessionKey:'agent:main:test'};store.upsert(observation);
 const tool=projectTool(config,ctx);const result=JSON.parse((await tool.execute('q',{action:'entities',typeId:'service'})).content[0].text);assert.equal(result.agentId,'main');assert.equal(result.total,1);
 await assert.rejects(projectTool(config,{agentId:'main',sessionKey:'agent:other:test'}).execute('q',{action:'entities'}),/context|conversation/);
 await assert.rejects(tool.execute('q',{action:'entities',repository:'projects/foreign'}),/项目/);await assert.rejects(tool.execute('q',{action:'entities',openId:'ou_bad'}),/参数/);assert.equal(projectTool(config,{agentId:'other'}),null);
 const sync=entitySyncTool(ctx,{repo:root});const written=JSON.parse((await sync.execute('w',{action:'upsert',typeId:'asset',name:'测试设备',namespace:'assistant',externalId:'asset-1',observedAt:observation.observedAt})).content[0].text);assert.equal(written.entity.source.kind,'ai');
 await assert.rejects(sync.execute('w',{action:'upsert',...observation}),/参数/);await assert.rejects(sync.execute('w',{action:'register_type',definition:{id:'test',label:'类型',fields:{}},agentId:'other'}),/参数/);
 const inspector=createProjectInspector(config,()=>({}));assert.equal((await inspector.entities({...ctx,payload:{typeId:'service'}})).total,1);await assert.rejects(inspector.entities({...ctx,sessionKey:'agent:other:test'}));await assert.rejects(inspector.entities({...ctx,payload:{root:'/tmp'}}));
 const actions=[];registerProjectInspector({registerSessionAction:a=>actions.push(a)},inspector);assert.deepEqual(actions.find(a=>a.id==='projects-entities').requiredScopes,['operator.read']);
});
test('program API scopes registry ownership, safely disposes generations and blocks redirected storage',t=>{
 const {root,store}=fixture(t);assert.throws(()=>registerEntityService(undefined,store,Symbol()));const owner=Symbol(),dispose=registerEntityService('main',store,owner);t.after(dispose);assert.equal(getEntityService({agentId:'main'}),store);assert.throws(()=>getEntityService({agentId:'main',sessionKey:'agent:other:test'}));assert.throws(()=>registerEntityService('main',store,Symbol()));
 const newer=registerEntityService('main',store,owner);dispose();assert.equal(getEntityService({agentId:'main'}),store);newer();assert.equal(getEntityService({agentId:'main'}),undefined);
 const other=fixture(t);mkdirSync(join(other.root,'outside'));symlinkSync(join(other.root,'outside'),join(root,'.runtime'));assert.throws(()=>store.upsert(observation),/目录/);
});

test('plugin installs scoped entity producers and releases them on stop with optional AI write tool',async t=>{
 const {root}=fixture(t),services=[],tools=[];
 plugin.register({pluginConfig:{agents:{'entity-fixture':{repo:root}}},registerTool:(factory,options)=>tools.push({factory,options}),registerService:service=>services.push(service)});
 const lifecycle=services.find(service=>service.id==='agent-repo-skill-scopes');t.after(()=>lifecycle.stop());
 assert.ok(getEntityService({agentId:'entity-fixture'}));const write=tools.find(tool=>tool.factory({agentId:'entity-fixture'})?.name==='agent_entity_sync');assert.equal(write.options.optional,true);assert.equal(write.factory({agentId:'foreign'}),null);
 lifecycle.stop();assert.equal(getEntityService({agentId:'entity-fixture'}),undefined);await lifecycle.start();assert.ok(getEntityService({agentId:'entity-fixture'}));
});

test('context guidance is scoped to the bound Agent and the detailed skill ships with the plugin',async t=>{
 const {root}=fixture(t),services=[],hooks=[];
 plugin.register({pluginConfig:{agents:{'context-fixture':{repo:root}}},registerTool:()=>{},registerService:s=>services.push(s),on:(event,handler)=>hooks.push({event,handler})});
 t.after(()=>services.forEach(s=>s.stop?.()));
 const boundary=hooks.find(h=>h.event==='before_prompt_build');
 assert.equal(boundary.handler({}, {agentId:'other'}),undefined);
 const text=boundary.handler({}, {agentId:'context-fixture'}).appendSystemContext;
 assert.match(text,/合同 v2/);assert.ok(text.length<160);
 const fs=await import('node:fs/promises');
 const manifest=JSON.parse(await fs.readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 const pkg=JSON.parse(await fs.readFile(new URL('./package.json',import.meta.url),'utf8'));
 assert.ok(manifest.skills.includes('./skills'));assert.ok(pkg.files.includes('skills'));
 const skill=await fs.readFile(new URL('./skills/agent-repo-context/SKILL.md',import.meta.url),'utf8');
 assert.match(skill,/^---\nname: agent-repo-context\n/);
});
