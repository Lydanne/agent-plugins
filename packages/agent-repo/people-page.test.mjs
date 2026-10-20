import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,select,click,deferred} from '../../scripts/control-ui-test.mjs';
const person={id:'id',revision:'r1',name:'测试同事',email:'person@example.invalid',departments:[],accountId:'a',appId:'app',openId:'ou_person',giteaUsername:null,giteaSource:'unknown',observedAt:'2026-10-17T00:00:00Z'};
const page={people:[person],total:1,nextOffset:null,stats:{missing:{email:0},giteaSources:{admin:0,email_prefix:0,unknown:1}}};
function host(request){const ctx=uiContext(request);ctx.host.connection.canWrite=true;ctx.host.sessions.rows=[];ctx.host.agents.rows=[{id:'main',name:'主助手'},{id:'other',name:'其他助手'}];ctx.host.agents.select=id=>{ctx.host.agents.selectedId=id;ctx.notify();};return ctx;}
test('full page is Agent-wide without a conversation and supports statistics, filters and editing',async t=>{
 const f=await browserFixture(t,new URL('./people-page.mjs',import.meta.url).pathname),calls=[];
 const ctx=host(async(method,args)=>{calls.push(args);return {ok:true,result:page};});ctx.host.sessions.selectedKey='';
 f.track(f.ui.mountPeoplePage(f.container,ctx));await settle();
 assert.equal(f.container.querySelector('dialog'),null);assert.match(f.container.textContent,/跨会话统一管理/);assert.match(f.container.textContent,/测试同事/);assert.match(f.container.textContent,/匹配人员/);
 assert.equal(calls[0].sessionKey,'agent:main:agent-repo-people');assert.equal(calls[0].agentId,'main');
 select(f.window,f.container,'账号关联状态','unknown');await settle();assert.equal(calls.at(-1).payload.giteaSource,'unknown');
 select(f.window,f.container,'资料完整度','email');await settle();assert.equal(calls.at(-1).payload.missing,'email');
 f.container.querySelector('[aria-label="编辑人员"]').click();const name=f.container.querySelector('[aria-label="编辑姓名"]');name.value='草稿';name.dispatchEvent(new f.window.Event('input'));
 const count=calls.length;ctx.host.sessions.selectedKey='agent:main:another';ctx.notify();await settle();assert.equal(calls.length,count);assert.equal(f.container.querySelector('[aria-label="编辑姓名"]').value,'草稿');
 f.window.document.activeElement?.blur();f.container.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.ok(f.container.querySelector('.ar-people-page'));
});
test('Agent switch, permission loss, hiding and disposal cannot leak a late response',async t=>{
 const f=await browserFixture(t,new URL('./people-page.mjs',import.meta.url).pathname),pending=deferred(),calls=[];
 const ctx=host(async(method,args)=>{calls.push(args);return args.agentId==='main'?pending.promise:{ok:true,result:{...page,people:[{...person,name:'其他助手联系人'}]}};});
 const view=f.track(f.ui.mountPeoplePage(f.container,ctx));select(f.window,f.container,'人员库所属 Agent','other');await settle();
 pending.resolve({ok:true,result:page});await settle();assert.match(f.container.textContent,/其他助手联系人/);assert.ok(!f.container.textContent.includes('测试同事'));assert.equal(calls.at(-1).sessionKey,'agent:other:agent-repo-people');
 ctx.host.connection.canRead=false;ctx.notify();assert.ok(!f.container.textContent.includes('其他助手联系人'));assert.match(f.container.textContent,/operator.read/);
 ctx.host.connection.canRead=true;ctx.host.connection.canWrite=false;ctx.notify();await settle();assert.equal(f.container.querySelector('[aria-label="编辑人员"]'),null);
 view.update({...ctx,presented:false});assert.ok(!f.container.textContent.includes('其他助手联系人'));view.dispose();assert.equal(f.container.children.length,0);
});
test('global group sync selects only this Agent existing groups and never sends an arbitrary chat ID',async t=>{
 const f=await browserFixture(t,new URL('./people-page.mjs',import.meta.url).pathname),calls=[];
 const ctx=host(async(method,args)=>{calls.push(args);if(args.actionId==='projects-peopleSyncInfo')return {ok:true,result:{available:true,accounts:[{accountId:'a'}]}};if(args.actionId==='projects-syncPeople')return {ok:true,result:{status:'running',saved:0,processed:0,discovered:0}};return {ok:true,result:page};});
 ctx.host.sessions.rows=[{key:'agent:main:feishu:group:oc_test',label:'验收群'},{key:'agent:other:feishu:group:oc_other',label:'其他 Agent 群'},{key:'agent:main:feishu:direct:ou_test'}];
 f.track(f.ui.mountPeoplePage(f.container,ctx));await settle();assert.equal(f.container.querySelector('[aria-label="同步本群成员"]'),null);
 const groups=f.container.querySelector('[aria-label="飞书同步来源"]');assert.equal(groups.options.length,2);
 select(f.window,f.container,'飞书同步来源','agent:main:feishu:group:oc_test');await settle();click(f.container,'同步所选群成员');await settle();
 const call=calls.find(call=>call.actionId==='projects-syncPeople');assert.equal(call.sessionKey,'agent:main:feishu:group:oc_test');assert.deepEqual(call.payload,{accountId:'a'});assert.equal(call.agentId,'main');
 assert.ok(calls.filter(call=>call.actionId==='projects-people').every(call=>call.sessionKey==='agent:main:agent-repo-people'));
});
