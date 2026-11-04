import {test,onTestFinished} from 'vitest';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,click} from '../../../scripts/control-ui-test.mjs';
const catalog={agentId:'main',mode:'audit',canAdmin:true,actions:['discover','read','execute'],groups:[{id:'administrator',name:'管理员组',revision:1},{id:'internal',name:'内部组',revision:1},{id:'external',name:'外部组',revision:1}],resources:[],rules:[],bindings:[],audit:[]};
test('permission center renders built-in groups without mutating and offers admin actions',async()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),calls=[];
 const ctx=uiContext(async(_method,params)=>{calls.push(params);return {ok:true,result:catalog};});ctx.props={...ctx.props,section:'authorization'};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 for(const name of ['管理员组','内部组','外部组'])assert.ok(f.container.textContent.includes(name));
 assert.equal(calls.filter(call=>call.actionId==='authorization-catalog').length,1);
 assert.equal(calls.some(call=>['authorization-save','authorization-mode','authorization-scan'].includes(call.actionId)),false);
 click(f.container,'权限资源');await settle();assert.ok(f.container.textContent.includes('扫描当前能力'));
 click(f.container,'权限模拟');await settle();assert.ok(f.container.textContent.includes('检查有效权限'));
});
test('read-only operator cannot see mutation controls',async()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs'));
 const ctx=uiContext(async()=>({ok:true,result:{...catalog,canAdmin:false}}));ctx.props={...ctx.props,section:'authorization'};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 assert.equal(f.container.textContent.includes('启用强制拦截'),false);assert.equal(f.container.textContent.includes('新增权限组'),false);
});
test('group default templates save reviewable drafts with independent atomic and recovery conditions',async()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),calls=[];
 const ctx=uiContext(async(_method,params)=>{calls.push(params);return {ok:true,result:catalog};});ctx.props={...ctx.props,section:'authorization'};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 click(f.container,'配置新增资源默认授权');await settle();
 click(f.container,'原子且可撤销写入');await settle();
 assert.equal(calls.some(call=>call.actionId==='authorization-save'),false);
 const form=f.container.querySelector('form');form.dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 const saved=calls.find(call=>call.actionId==='authorization-save');assert.ok(saved);
 assert.equal(saved.payload.value.groupId,'administrator');assert.equal(saved.payload.value.kind,'default');
 assert.deepEqual(saved.payload.value.conditions.atomicity,['guaranteed']);assert.deepEqual(saved.payload.value.conditions.recovery,['reversible']);
 assert.deepEqual(saved.payload.value.conditions.access,['write']);assert.ok(saved.payload.value.actions.includes('update'));
 assert.equal(saved.payload.value.actions.includes('grant'),false);
 assert.equal(calls.some(call=>call.actionId==='authorization-publish'),false);
});
test('simulation sends context and parameters and rejects malformed parameter objects locally',async()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),calls=[];
 const ctx=uiContext(async(_method,params)=>{calls.push(params);return {ok:true,result:params.actionId==='authorization-catalog'?catalog:{allowed:true}};});ctx.props={...ctx.props,section:'authorization'};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();click(f.container,'权限模拟');await settle();
 function fill(label,value){const field=f.container.querySelector(`[aria-label="${label}"]`);assert.ok(field);field.value=value;field.dispatchEvent(new f.window.Event('input',{bubbles:true}));}
 const submit=async()=>{f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await settle();};
 fill('模拟项目','xgj');fill('模拟环境','test');fill('模拟调用参数','[]');await submit();
 assert.equal(calls.some(call=>call.actionId==='authorization-simulate'),false);assert.ok(f.container.textContent.includes('必须是 JSON 对象'));
 fill('模拟调用参数','{"limit":5}');await submit();
 const call=calls.find(call=>call.actionId==='authorization-simulate');assert.ok(call);
 assert.deepEqual(call.payload.context,{projectId:'xgj',environment:'test'});assert.deepEqual(call.payload.parameters,{limit:5});
});
