import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,settle,click,deferred} from '../../scripts/control-ui-test.mjs';
const person={id:'id',revision:'r1',name:'客服同事',email:'reporter@example.invalid',departments:[{id:'support',name:'客服'}],accountId:'a',appId:'app',openId:'ou_reporter',giteaUsername:'reporter',giteaSource:'email_prefix',observedAt:'2026-10-14T00:00:00Z'};
test('people manager searches, saves explicit corrections and confirms deletion',async t=>{
 const f=await browserFixture(t,new URL('./people-ui.mjs',import.meta.url).pathname),calls=[];
 const invoke=async(action,payload)=>{calls.push({action,payload});return action==='people'?{people:[person],total:1,nextOffset:null}:{ok:true};};
 f.track(f.ui.mountPeopleDialog(f.container,{invoke,canWrite:()=>true,safe:String}));await settle();
 assert.equal(f.container.querySelector('dialog').open,true);assert.match(f.container.textContent,/根据邮箱前缀推导/);f.container.querySelector('[aria-label="编辑人员"]').click();
 const name=f.container.querySelector('[aria-label="编辑姓名"]');name.value='姓名更正';
 const username=f.container.querySelector('[aria-label="编辑Gitea 账号"]');username.value='custom-account';
 name.closest('form').dispatchEvent(new f.window.Event('submit',{cancelable:true,bubbles:true}));await settle();
 const save=calls.find(call=>call.action==='updatePerson');assert.equal(save.payload.patch.name,'姓名更正');assert.equal(save.payload.patch.giteaUsername,'custom-account');assert.equal(save.payload.revision,'r1');
 const search=f.container.querySelector('[aria-label="搜索人员"]');search.value='研发';click(f.container,'搜索');await settle();assert.deepEqual(calls.at(-1),{action:'people',payload:{query:'研发',offset:0}});
 [...f.container.querySelectorAll('summary')].find(node=>node.textContent==='更多操作').click();click(f.container,'删除人员');assert.equal(calls.some(call=>call.action==='deletePerson'),false);click(f.container,'确认删除本地资料');await settle();assert.deepEqual(calls.find(call=>call.action==='deletePerson').payload,{id:'id',revision:'r1',confirmed:true});
 f.container.querySelector('[aria-label="关闭人员资料"]').click();assert.equal(f.container.children.length,0);
});
test('read-only manager cannot mutate and closing rejects stale responses',async t=>{
 const f=await browserFixture(t,new URL('./people-ui.mjs',import.meta.url).pathname),pending=deferred();
 const view=f.track(f.ui.mountPeopleDialog(f.container,{invoke:()=>pending.promise,canWrite:()=>false,safe:String}));
 view.dispose();pending.resolve({people:[person],total:1,nextOffset:null});await settle();assert.equal(f.container.children.length,0);
 f.track(f.ui.mountPeopleDialog(f.container,{invoke:async()=>({people:[person],total:1,nextOffset:null}),canWrite:()=>false,safe:String}));await settle();assert.match(f.container.textContent,/客服同事/);assert.equal(f.container.querySelector('[aria-label="编辑人员"]'),null);
});

test('failed saves retain an edited draft for correction and retry',async t=>{
 const f=await browserFixture(t,new URL('./people-ui.mjs',import.meta.url).pathname);
 f.track(f.ui.mountPeopleDialog(f.container,{invoke:async action=>{if(action==='updatePerson')throw Error('资料已变化');return {people:[person],total:1,nextOffset:null};},canWrite:()=>true,safe:String}));await settle();f.container.querySelector('[aria-label="编辑人员"]').click();
 const name=f.container.querySelector('[aria-label="编辑姓名"]');name.value='保留输入';name.closest('form').dispatchEvent(new f.window.Event('submit',{cancelable:true,bubbles:true}));await settle();
 assert.match(f.container.textContent,/资料已变化/);assert.equal(f.container.querySelector('[aria-label="编辑姓名"]').value,'保留输入');
});

test('selecting another person keeps edits and deletion scoped to that identity and preserves department IDs',async t=>{
 const f=await browserFixture(t,new URL('./people-ui.mjs',import.meta.url).pathname),calls=[];
 const other={...person,id:'second',revision:'r2',name:'研发同事',giteaUsername:'developer',giteaSource:'admin',departments:[{id:'dev',name:'研发部'},{id:'platform',name:'平台组'}]};
 f.track(f.ui.mountPeopleDialog(f.container,{invoke:async(action,payload)=>{calls.push({action,payload});return action==='people'?{people:[person,other],total:2,nextOffset:null}:{ok:true};},canWrite:()=>true,safe:String}));await settle();
 f.container.querySelector('[aria-label="查看 研发同事"]').click();assert.equal(f.container.querySelector('.ar-people-person.is-selected').getAttribute('aria-label'),'查看 研发同事');assert.match(f.container.querySelector('.ar-people-detail').textContent,/已确认/);
 f.container.querySelector('[aria-label="编辑人员"]').click();const departments=f.container.querySelector('[aria-label="编辑部门（多个用逗号分隔）"]');assert.equal(departments.value,'研发部, 平台组');departments.closest('form').dispatchEvent(new f.window.Event('submit',{cancelable:true,bubbles:true}));await settle();
 const save=calls.find(call=>call.action==='updatePerson');assert.equal(save.payload.id,'second');assert.equal(save.payload.revision,'r2');assert.deepEqual(save.payload.patch.departments,other.departments);
});

test('empty searches can be cleared and do not show unusable pagination',async t=>{
 const f=await browserFixture(t,new URL('./people-ui.mjs',import.meta.url).pathname),calls=[];
 f.track(f.ui.mountPeopleDialog(f.container,{invoke:async(action,payload)=>{calls.push(payload);return {people:payload.query?[]:[person],total:payload.query?0:1,nextOffset:null};},canWrite:()=>false,safe:String}));await settle();
 const search=f.container.querySelector('[aria-label="搜索人员"]');search.value='missing';click(f.container,'搜索');await settle();assert.match(f.container.textContent,/没有找到相关人员/);assert.equal(f.container.querySelector('.ar-people-roster').hidden,true);assert.ok(![...f.container.querySelectorAll('button')].some(node=>node.textContent==='下一页'));
 click(f.container,'清空搜索');await settle();assert.equal(search.value,'');assert.equal(calls.at(-1).query,'');assert.match(f.container.textContent,/客服同事/);
});

test('current-group sync requires write permission, submits no arbitrary chat ID and renders result',async t=>{
 const f=await browserFixture(t,new URL('./people-ui.mjs',import.meta.url).pathname),calls=[];
 const run={id:'job',status:'completed',saved:2,created:1,updated:1,profiled:2,identityOnly:0};let started=false;
 f.track(f.ui.mountPeopleDialog(f.container,{isGroup:()=>true,invoke:async(action,payload)=>{calls.push({action,payload});if(action==='peopleSyncInfo')return {available:true,accounts:[{accountId:'a'}],onJoin:true,run:started?run:null};if(action==='syncPeople'){started=true;return run;}return {people:[person],total:1,nextOffset:null};},canWrite:()=>true,safe:String}));await settle();
 const sync=f.container.querySelector('[aria-label="同步本群成员"]');assert.equal(sync.disabled,false);sync.click();await settle();assert.deepEqual(calls.find(c=>c.action==='syncPeople').payload,{accountId:'a'});assert.match(f.container.textContent,/同步完成：已保存 2 人/);
});
