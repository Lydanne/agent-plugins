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
 const predicates=[{path:'limit',op:'max',value:100}];
 const input=f.container.querySelector('[aria-label="参数约束"]');assert.ok(input);
 input.value=JSON.stringify(predicates);input.dispatchEvent(new f.window.Event('input',{bubbles:true}));await settle();
 const labels=f.container.querySelector('[aria-label="必须具备的分类标签"]');assert.ok(labels);
 labels.value='orders, internal';labels.dispatchEvent(new f.window.Event('input',{bubbles:true}));await settle();
 assert.equal(calls.some(call=>call.actionId==='authorization-save'),false);
 const form=f.container.querySelector('form');form.dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 const saved=calls.find(call=>call.actionId==='authorization-save');assert.ok(saved);
 assert.equal(saved.payload.value.groupId,'administrator');assert.equal(saved.payload.value.kind,'default');
 assert.deepEqual(saved.payload.value.parameters,predicates);
 assert.deepEqual(saved.payload.value.selector,{labels:['orders','internal']});
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
for(const action of ['scan','previewDefaults','mode','save','publish','classify','recomputeDefaults'])test(`late ${action} responses cannot alter another Agent permission page`,async()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs'));
 let finish,finishOther;const calls=[];
 const resources=[{id:'resource',name:'测试资源',revision:1,labels:[],behavior:{}}];
 const ctx=uiContext(async(_method,params)=>{
  calls.push(params);
  if(params.agentId==='other')return new Promise(resolve=>{finishOther=resolve;});
  if(params.actionId==='authorization-'+action)return new Promise(resolve=>{finish=resolve;});
  if(params.actionId==='authorization-previewDefaults')return {ok:true,result:{resourceId:'resource',revision:'preview',before:[],after:[]}};
  return {ok:true,result:{...catalog,resources,policyVersions:[{id:'draft',revision:1,status:'draft'}]}};
 });ctx.props={...ctx.props,section:'authorization'};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 if(['scan','previewDefaults','classify','recomputeDefaults'].includes(action)){click(f.container,'权限资源');await settle();}
 if(action==='scan')click(f.container,'扫描当前能力');
 if(action==='previewDefaults'||action==='recomputeDefaults')click(f.container,'预览默认授权');
 if(action==='recomputeDefaults'){await settle();click(f.container,'应用此授权变更');}
 if(action==='mode')click(f.container,'启用强制拦截');
 if(action==='publish'){click(f.container,'授权与默认策略');await settle();click(f.container,'发布此规则');}
 if(action==='save'||action==='classify'){
  click(f.container,'编辑');await settle();
  f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));
 }
 await settle();assert.equal(typeof finish,'function');
 ctx.host.agents.selectedId='other';ctx.notify();await settle();assert.equal(typeof finishOther,'function');
 finish({ok:true,result:{discovered:999,changed:999,complete:true,resourceId:'old-resource',revision:'old',before:[],after:[]}});await settle();
 assert.equal(f.container.textContent.includes('页面已切换'),false);
 assert.equal(f.container.textContent.includes('old-resource'),false);
 assert.equal(f.container.textContent.includes('发现 999'),false);
 assert.equal([...f.container.querySelectorAll('button')].find(button=>button.textContent==='刷新').disabled,true);
 finishOther({ok:true,result:{...catalog,agentId:'other'}});await settle();
 assert.equal([...f.container.querySelectorAll('button')].find(button=>button.textContent==='刷新').disabled,false);
 assert.equal(calls.filter(call=>call.agentId==='other').length,1);
});
test('scanned tool review requires classified behavior and explicit confirmation',async()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),calls=[];
 const resource={id:'tool://fixture/lookup',name:'新工具',revision:2,reviewEligible:true,definition:{toolName:'lookup'},behavior:{access:'read',externalEffect:'none',sensitivity:'ordinary'}};
 const ctx=uiContext(async(_method,params)=>{calls.push(params);return {ok:true,result:{...catalog,resources:[resource]}};});ctx.props={...ctx.props,section:'authorization'};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();click(f.container,'权限资源');await settle();click(f.container,'核验并启用');await settle();
 assert.ok(f.container.textContent.includes('不提供沙箱或自动回滚'));assert.equal(calls.some(call=>call.actionId==='authorization-review'),false);
 click(f.container,'取消核验');await settle();assert.equal(calls.some(call=>call.actionId==='authorization-review'),false);
 click(f.container,'核验并启用');await settle();click(f.container,'确认分类并启用');await settle();
 assert.deepEqual(calls.find(call=>call.actionId==='authorization-review').payload,{resourceId:resource.id,expectedRevision:2,confirmed:true});
 resource.behavior.access='unknown';click(f.container,'刷新');await settle();click(f.container,'核验并启用');await settle();
 assert.equal([...f.container.querySelectorAll('button')].find(button=>button.textContent==='确认分类并启用').disabled,true);
});
