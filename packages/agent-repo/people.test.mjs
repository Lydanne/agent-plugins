import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPeopleStore} from './people.mjs';
import {createProjectInspector,registerProjectInspector} from './project-inspector.mjs';
import {registerPeopleService,getPeopleService} from './dist/people-api.mjs';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'people-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,store:createPeopleStore(root)};}
const person={accountId:'feishu-main',appId:'app1',openId:'ou_user',name:'测试用户',email:'reporter@example.invalid',departments:[{id:'dept',name:'客服部'}]};
test('collects directory data, preserves administrative corrections, and restores automatic values',t=>{
 const {root,store}=fixture(t),first=store.observe(person);assert.equal(first.giteaUsername,'reporter');assert.equal(first.giteaSource,'email_prefix');
 const changed=store.update({id:first.id,revision:first.revision,patch:{name:'更正姓名',email:'verified@example.invalid',departments:[{id:'support',name:'支持部'}],giteaUsername:'different-login'}});
 assert.equal(changed.giteaSource,'admin');
 const refreshed=store.observe({...person,name:'飞书姓名更新',email:'new@example.invalid'});assert.equal(refreshed.name,'更正姓名');assert.equal(refreshed.giteaUsername,'different-login');assert.equal(refreshed.email,'verified@example.invalid');
 const restored=store.update({id:first.id,revision:refreshed.revision,patch:{name:null,email:null,departments:null,giteaUsername:null}});assert.equal(restored.email,'new@example.invalid');assert.equal(restored.name,'飞书姓名更新');assert.equal(restored.giteaUsername,'new');
 const unavailable=store.observe({accountId:person.accountId,appId:person.appId,openId:person.openId});assert.equal(unavailable.name,'飞书姓名更新');assert.equal(unavailable.email,'new@example.invalid');
 assert.equal(statSync(join(root,'.runtime/people/people.sqlite')).mode&0o777,0o600);
 assert.equal(store.list({query:'客服'}).total,1);assert.equal(store.list({query:'new@'}).total,1);
 assert.throws(()=>store.remove({id:first.id,revision:first.revision}),/变化/);
 assert.equal(store.remove({id:first.id,revision:unavailable.revision}).deleted,true);assert.equal(store.list().total,0);
});
test('isolates app, account, and Agent and guards stale edits and malformed input',t=>{
 const {root,store}=fixture(t),first=store.observe(person);
 store.observe({...person,appId:'other'});store.observe({...person,accountId:'other'});assert.equal(store.list().total,3);
 const other=fixture(t);assert.equal(other.store.lookup(person),null);
 assert.throws(()=>store.update({id:first.id,revision:first.revision,patch:{giteaUsername:'bad @name'}}),/格式/);
 assert.throws(()=>store.update({id:first.id,revision:first.revision,patch:{accountId:'spoof'}}),/参数/);
 const fresh=store.observe({...person,name:"Updated"});assert.throws(()=>store.update({id:first.id,revision:first.revision,patch:{name:'stale'}}),/变化/);
 assert.equal(store.lookup(person).revision,fresh.revision);
 const dispose=registerPeopleService('main',store,Symbol());t.after(dispose);assert.equal(getPeopleService('other'),undefined);assert.equal(getPeopleService('main'),store);
});
test('pagination is bounded and runtime directory cannot redirect to another location',t=>{
 const {store}=fixture(t);for(let i=0;i<53;i++)store.observe({...person,openId:'ou_'+i});assert.equal(store.list().people.length,50);assert.equal(store.list().nextOffset,50);assert.equal(store.list({offset:50}).people.length,3);
 const a=fixture(t),b=fixture(t);mkdirSync(join(b.root,'outside'));symlinkSync(join(b.root,'outside'),join(a.root,'.runtime'));assert.throws(()=>a.store.observe(person),/目录/);
});
test('sidebar mutations require write scope and trusted Agent ownership',async t=>{
 const {root,store}=fixture(t),first=store.observe(person),inspector=createProjectInspector({agents:{main:{repo:root}}},()=>({}));
 const ctx={agentId:'main',sessionKey:'agent:main:test',client:{scopes:['operator.read']},payload:{}};
 assert.equal((await inspector.people(ctx)).total,1);
 await assert.rejects(inspector.updatePerson({...ctx,payload:{id:first.id,revision:first.revision,patch:{name:'admin'}}}),/写入权限/);
 await assert.rejects(inspector.people({...ctx,agentId:'other'}));
 const updated=await inspector.updatePerson({...ctx,client:{scopes:['operator.write']},payload:{id:first.id,revision:first.revision,patch:{giteaUsername:'confirmed'}}});assert.equal(updated.giteaUsername,'confirmed');
 await assert.rejects(inspector.deletePerson({...ctx,client:{scopes:['operator.write']},payload:{id:first.id,revision:updated.revision}}),/确认/);
 const actions=[];registerProjectInspector({registerSessionAction:action=>actions.push(action)},inspector);
 assert.deepEqual(actions.find(action=>action.id==='projects-updatePerson').requiredScopes,['operator.write']);
 assert.deepEqual(actions.find(action=>action.id==='projects-people').requiredScopes,['operator.read']);
});
test('group sync actions enforce write scope, reject payload chat IDs and preserve trusted conversation',async t=>{
 const {root}=fixture(t),{registerPeopleGroupSync}=await import('./dist/people-api.mjs');const seen=[];
 const dispose=registerPeopleGroupSync({info:input=>({available:true,accounts:[{accountId:'a'}]}),status:()=>null,start:input=>{seen.push(input);return {status:'running'};},join:()=>{},stop:async()=>{}},Symbol());t.after(dispose);
 const inspector=createProjectInspector({agents:{main:{repo:root}}},()=>({})),ctx={agentId:'main',sessionKey:'agent:main:feishu:group:oc_test',payload:{},client:{scopes:['operator.read']}};
 assert.equal((await inspector.peopleSyncInfo(ctx)).available,true);await assert.rejects(inspector.syncPeople(ctx),/写入权限/);
 await assert.rejects(inspector.syncPeople({...ctx,client:{scopes:['operator.write']},payload:{chatId:'oc_foreign'}}),/参数/);
 await inspector.syncPeople({...ctx,client:{scopes:['operator.write']},payload:{accountId:'a'}});assert.deepEqual(seen[0],{agentId:'main',sessionKey:ctx.sessionKey,accountId:'a'});
});
test('Agent-wide people management shares contacts across sessions with filters and accurate statistics',async t=>{
 const {root,store}=fixture(t);store.observe(person);store.observe({...person,openId:'ou_second',email:'',departments:[]});
 const inspector=createProjectInspector({agents:{main:{repo:root}}},()=>({}));
 const ctx={agentId:'main',sessionKey:'agent:main:agent-repo-people',client:{scopes:['operator.read']},payload:{query:''}};
 assert.equal((await inspector.people(ctx)).total,2);
 assert.equal((await inspector.people({...ctx,sessionKey:'agent:main:other'})).total,2);
 const result=await inspector.people({...ctx,payload:{missing:'email'}});assert.equal(result.total,1);assert.equal(result.stats.missing.email,1);
 assert.equal((await inspector.people({...ctx,payload:{giteaSource:'unknown'}})).total,1);
 await assert.rejects(inspector.people({...ctx,payload:{agentId:'other'}}));
 await assert.rejects(inspector.people({...ctx,sessionKey:'agent:other:test'}));
});
