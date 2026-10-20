import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPeopleStore} from './people.mjs';
import {queryPeople} from './people-query.mjs';
import {projectTool} from './index.mjs';
import Ajv from 'ajv';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'people-query-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const store=createPeopleStore(root);return {root,store,query:params=>queryPeople(root,params)};}
const base={accountId:'main',appId:'app',openId:'ou_one',name:'张三',email:'zhang@example.invalid',departments:[{id:'dev',name:'研发组'}]};
test('searches effective fields, combines filters, and reports mapping and missing fields',t=>{
 const {store,query}=fixture(t);const first=store.observe(base);
 store.observe({...base,openId:'ou_two',name:'李四',email:'',departments:[]});
 store.update({id:first.id,revision:first.revision,patch:{giteaUsername:'verified'}});
 for(const input of [{query:'研发'},{query:'DEV'},{email:'ZHANG@example.invalid'},{giteaUsername:'VERIFIED'},{name:'张',department:'dev',giteaSource:'admin',accountId:'main',appId:'app'}])assert.equal(query({action:'people',...input}).total,1);
 assert.equal(query({action:'people',giteaUsername:'zhang'}).total,0);
 assert.equal(query({action:'people',missing:'email'}).people[0].openId,'ou_two');
 const stats=query({action:'people_stats'});assert.equal(stats.total,2);assert.deepEqual(stats.giteaSources,{admin:1,email_prefix:0,unknown:1});assert.deepEqual(stats.missing,{name:0,email:1,departments:1,giteaUsername:1});
 assert.equal(query({action:'people_stats',department:'研发'}).total,1);
 assert.equal(query({action:'people',query:"' OR 1=1 --"}).total,0);
});
test('exact identity lookup never chooses an ambiguous account or application',t=>{
 const {store,query}=fixture(t);const first=store.observe(base);store.observe({...base,appId:'another'});store.observe({...base,accountId:'another'});
 const result=query({action:'person',openId:'ou_one'});assert.equal(result.ambiguous,true);assert.equal(result.person,null);assert.equal(result.total,3);
 assert.equal(query({action:'person',openId:'ou_one',accountId:'main',appId:'app'}).person.id,first.id);
 assert.equal(query({action:'person',id:first.id}).person.openId,'ou_one');
 assert.equal(query({action:'person',openId:'ou_missing'}).found,false);
 assert.equal(query({action:'person',openId:'OU_ONE'}).found,false);
});
test('pagination is bounded, stable, and sortable without changing stored records',t=>{
 const {store,query}=fixture(t);for(let i=0;i<23;i++)store.observe({...base,openId:'ou_'+i,name:String(i).padStart(2,'0')});
 const first=query({action:'people'});assert.equal(first.people.length,20);assert.equal(first.nextOffset,20);
 const last=query({action:'people',offset:20});assert.equal(last.people.length,3);assert.equal(last.nextOffset,null);
 assert.equal(query({action:'people',sortBy:'name',sortOrder:'desc',limit:1}).people[0].name,'22');
 assert.equal(query({action:'people',offset:100}).total,23);
 assert.equal(store.all().length,23);
});
test('tool schema and runtime reject invalid, cross-Agent, mutation and mixed-scope requests',async t=>{
 const {root,store}=fixture(t);store.observe(base);const tool=projectTool({agents:{main:{repo:root}}},{agentId:'main'});
 const validate=new Ajv().compile(tool.parameters);
 for(const input of [{action:'people',query:'张'},{action:'person',openId:'ou_one'},{action:'people_stats',missing:'email'}]){assert.equal(validate(input),true);const result=JSON.parse((await tool.execute('',input)).content[0].text);assert.equal(result.agentId,'main');}
 for(const input of [{action:'people',limit:101},{action:'people',limit:0},{action:'people',offset:-1},{action:'people',offset:0.5},{action:'people',query:''},{action:'people',query:'a\n'},{action:'people',query:3},{action:'people',sortBy:'id'},{action:'people',giteaSource:'fake'},{action:'person'},{action:'person',openId:'x',id:'y'},{action:'person',openId:'x',query:'张'},{action:'person',openId:'x',limit:1},{action:'people_stats',offset:1},{action:'people',projectId:'demo'},{action:'people',repository:'projects/demo'},{action:'people',agentId:'other'},{action:'people',patch:{}},{action:'list',query:'张'}])await assert.rejects(tool.execute('',input));
 const other=fixture(t);const otherTool=projectTool({agents:{main:{repo:root},other:{repo:other.root}}},{agentId:'other'});assert.equal(JSON.parse((await otherTool.execute('',{action:'people'})).content[0].text).total,0);
 assert.equal(projectTool({agents:{main:{repo:root}}},{agentId:'unknown'}),null);
});

test('automatic fallback persists remote identities and subsequent queries stay local',async t=>{
 const {root,store}=fixture(t);let calls=0;
 const {registerPeopleResolver}=await import('./dist/people-api.mjs');
 const dispose=registerPeopleResolver(async input=>{calls++;assert.equal(input.agentId,'main');assert.ok(input.openId==='ou_one'||input.name===base.name);return {status:'found',people:[base]};},Symbol());t.after(dispose);
 const tool=projectTool({agents:{main:{repo:root}}},{agentId:'main',deliveryContext:{accountId:'main'}});
 const execute=async params=>JSON.parse((await tool.execute('',params)).content[0].text);
 const first=await execute({action:'person',openId:'ou_one'});assert.equal(first.found,true);assert.equal(first.lookup.status,'saved');assert.equal(store.lookup(base).email,base.email);
 assert.equal((await execute({action:'person',openId:'ou_one'})).lookup.source,'local');assert.equal(calls,1);
 const record=store.lookup(base);store.update({id:record.id,revision:record.revision,patch:{name:'人工姓名'}});
 // Searching a directory name that differs from the override must preserve that override.
 const refreshed=await execute({action:'people',name:base.name});assert.equal(refreshed.lookup.status,'saved');assert.equal(store.lookup(base).name,'人工姓名');assert.equal(calls,2);
});
test('fallback is skipped for stats, browsing, IDs, invalid inputs and nonempty result sets',async t=>{
 const {root,store}=fixture(t);let calls=0;const {registerPeopleResolver}=await import('./dist/people-api.mjs');const dispose=registerPeopleResolver(async()=>{calls++;return {status:'not_found',people:[]};},Symbol());t.after(dispose);
 const tool=projectTool({agents:{main:{repo:root}}},{agentId:'main'}),execute=async params=>JSON.parse((await tool.execute('',params)).content[0].text);
 await execute({action:'people'});await execute({action:'people_stats',name:'张'});await execute({action:'person',id:'missing'});await assert.rejects(tool.execute('',{action:'person'}));assert.equal(calls,0);
 store.observe(base);await execute({action:'people',offset:100});assert.equal(calls,0);
 const empty=await execute({action:'person',openId:'ou_missing'});assert.equal(empty.lookup.status,'not_found');assert.equal(store.all().length,1);
});
test('resolver errors do not become false not-found or stored empty profiles, and scopes are fenced',async t=>{
 const {root,store}=fixture(t),{registerPeopleResolver}=await import('./dist/people-api.mjs');const owner=Symbol();
 const tool=projectTool({agents:{main:{repo:root}}},{agentId:'main',deliveryContext:{accountId:'main'}}),execute=async params=>JSON.parse((await tool.execute('',params)).content[0].text);
 assert.equal((await execute({action:'person',openId:'ou_one'})).lookup.status,'unavailable');
 let dispose=registerPeopleResolver(async()=>({status:'error',reason:'contact_lookup_failed',code:41050,requiredScopes:['contact:user.id:readonly'],people:[]}),owner);t.after(()=>dispose());
 const denied=await execute({action:'person',openId:'ou_one'});assert.equal(denied.lookup.status,'error');assert.equal(denied.lookup.code,41050);assert.deepEqual(denied.lookup.requiredScopes,['contact:user.id:readonly']);assert.equal(store.all().length,0);
 dispose=registerPeopleResolver(async()=>{throw Error('private token');},owner);const failed=await execute({action:'person',openId:'ou_one'});assert.equal(failed.lookup.status,'error');assert.ok(!JSON.stringify(failed).includes('private token'));
 dispose=registerPeopleResolver(async()=>({status:'found',people:[{...base,accountId:'other'}]}),owner);await assert.rejects(tool.execute('',{action:'person',openId:'ou_one'}),/身份范围/);assert.equal(store.all().length,0);
 dispose=registerPeopleResolver(async input=>{assert.equal(input.email,'person@example.invalid');return {status:'not_found',people:[]};},owner);await execute({action:'people',query:'person@example.invalid'});
});
test('concurrent misses share a single remote request without losing results',async t=>{
 const {root,store}=fixture(t),{registerPeopleResolver}=await import('./dist/people-api.mjs');let calls=0,release;
 const gate=new Promise(resolve=>release=resolve);const dispose=registerPeopleResolver(async()=>{calls++;await gate;return {status:'found',people:[base]};},Symbol());t.after(dispose);
 const tool=projectTool({agents:{main:{repo:root}}},{agentId:'main'});
 const a=tool.execute('',{action:'person',openId:'ou_one'}),b=tool.execute('',{action:'person',openId:'ou_one'});release();const results=await Promise.all([a,b]);assert.equal(calls,1);assert.equal(results.length,2);assert.equal(store.all().length,1);
});
test('timed-out remote queries never persist a late result',async t=>{
 const {root,store}=fixture(t),{registerPeopleResolver}=await import('./dist/people-api.mjs');let release;
 const gate=new Promise(resolve=>release=resolve);const dispose=registerPeopleResolver(async()=>{await gate;return {status:'found',people:[base]};},Symbol());t.after(dispose);
 t.mock.timers.enable({apis:['setTimeout']});
 const tool=projectTool({agents:{main:{repo:root}}},{agentId:'main'}),pending=tool.execute('',{action:'person',openId:'ou_one'});
 await Promise.resolve();t.mock.timers.tick(20001);
 const result=JSON.parse((await pending).content[0].text);assert.equal(result.lookup.reason,'feishu_lookup_timeout');release();await Promise.resolve();assert.equal(store.all().length,0);
});
