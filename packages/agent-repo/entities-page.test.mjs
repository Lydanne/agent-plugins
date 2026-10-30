import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,click,select,deferred} from '../../scripts/control-ui-test.mjs';
const types=[{id:'person',label:'人员资源',count:1,fields:{email:{label:'邮箱'}}},{id:'service',label:'系统服务',count:2,fields:{url:{label:'服务地址'}}}];
const record={id:'entity:1',typeId:'service',name:'工单服务',summary:'支持系统',attributes:{url:'https://example.invalid'},source:{kind:'program',namespace:'cmdb',externalId:'srv-1'},observedAt:'2026-01-01',updatedAt:'2026-01-02',revision:'r1'};
function host(request){const ctx=uiContext(request);ctx.host.agents.rows=[{id:'main'},{id:'other'}];ctx.host.agents.select=id=>{ctx.host.agents.selectedId=id;ctx.notify();};ctx.host.sessions.rows=[];return ctx;}
test('library browses typed records, searches and exposes provenance without write actions',async t=>{
 const f=await browserFixture(t,new URL('./entities-page.mjs',import.meta.url).pathname),calls=[];
 const ctx=host(async(method,args)=>{calls.push(args);return {ok:true,result:args.actionId==='projects-entityTypes'?{types,total:3}:{entities:[record],total:1,nextOffset:null}};});ctx.host.sessions.selectedKey='';
 f.track(f.ui.mountEntitiesPage(f.container,ctx));await settle();assert.match(f.container.textContent,/实体资料库/);assert.match(f.container.textContent,/工单服务/);assert.match(f.container.textContent,/程序同步/);assert.match(f.container.textContent,/srv-1/);assert.equal(calls[0].sessionKey,'agent:main:agent-repo-entities');
 click(f.container,'系统服务2');await settle();assert.equal(calls.at(-1).payload.typeId,'service');
 f.container.querySelector('[aria-label="搜索实体"]').value='工单';f.container.querySelector('[aria-label="实体来源"]').value='cmdb';click(f.container,'搜索');await settle();assert.equal(calls.at(-1).payload.query,'工单');assert.equal(calls.at(-1).payload.source,'cmdb');assert.ok(calls.every(call=>['projects-entities','projects-entityTypes'].includes(call.actionId)));
 const before=calls.length;ctx.host.sessions.selectedKey='agent:main:unrelated';ctx.notify();assert.equal(calls.length,before);
 click(f.container,'人员资源1');await settle();assert.ok([...f.container.querySelectorAll('button')].some(node=>node.textContent==='飞书人员同步与更正'));
});
test('Agent switch, hidden page and permission loss discard previous entity details',async t=>{
 const f=await browserFixture(t,new URL('./entities-page.mjs',import.meta.url).pathname),pending=deferred();
 const ctx=host(async(method,args)=>args.agentId==='main'?pending.promise:{ok:true,result:args.actionId==='projects-entityTypes'?{types,total:0}:{entities:[],total:0,nextOffset:null}});
 const view=f.track(f.ui.mountEntitiesPage(f.container,ctx));select(f.window,f.container,'实体资料库所属 Agent','other');await settle();pending.resolve({ok:true,result:{entities:[record],types,total:1,nextOffset:null}});await settle();assert.ok(!f.container.textContent.includes('工单服务'));assert.match(f.container.textContent,/暂无资料/);
 ctx.host.connection.canRead=false;ctx.notify();assert.match(f.container.textContent,/operator.read/);assert.equal(f.container.querySelector('[aria-label="实体列表"]'),null);view.update({...ctx,presented:false});assert.equal(f.container.querySelector('input'),null);
});
test('failed reads are actionable and never presented as an empty successful catalog',async t=>{
 const f=await browserFixture(t,new URL('./entities-page.mjs',import.meta.url).pathname),ctx=host(async()=>{throw Error('测试读取失败');});f.track(f.ui.mountEntitiesPage(f.container,ctx));await settle();assert.match(f.container.textContent,/测试读取失败/);assert.ok(f.container.querySelector('[role=alert]'));assert.ok(!f.container.textContent.includes('暂无资料'));
});
test('relation details are read-only, show direction and reject stale Agent responses',async t=>{
 const f=await browserFixture(t,new URL('./entities-page.mjs',import.meta.url).pathname),calls=[];
 const ctx=host(async(_method,args)=>{calls.push(args);return {ok:true,result:args.actionId==='projects-entityTypes'?{types,total:3}:args.actionId==='projects-graph'?{entities:[record,{...record,id:'entity:2',name:'关联资产'}],relations:[{id:'rel:1',typeId:'maintains',fromId:record.id,toId:'entity:2'}],truncated:false}:{entities:[record],total:1,nextOffset:null}};});
 f.track(f.ui.mountEntitiesPage(f.container,ctx));await settle();const details=[...f.container.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='查看关联关系');details.open=true;details.dispatchEvent(new f.window.Event('toggle'));await settle();assert.match(details.textContent,/→ maintains · 关联资产/);assert.equal(calls.at(-1).actionId,'projects-graph');assert.deepEqual(calls.at(-1).payload,{id:record.id,depth:1,limit:100});
 ctx.host.connection.canRead=false;ctx.notify();assert.ok(!f.container.textContent.includes('关联资产'));
});
