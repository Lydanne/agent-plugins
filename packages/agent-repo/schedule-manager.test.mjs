import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,settle,click,select,deferred} from '../../scripts/control-ui-test.mjs';
const task={id:'one',revision:'revision',name:'Daily',status:'enabled',sourceValid:true,busy:false,chatId:'original-group',requester:'Original requester',projectId:'demo',task:'Summarize only',constraints:'No new business writes',schedule:{kind:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'}};
async function fixture(t,{write=true,initialTaskId=null,initialAction=null,tasks=[structuredClone(task)],mutate=async()=>({status:'succeeded',id:'one'})}={}){
 const f=await browserFixture(t,new URL('./schedule-manager.mjs',import.meta.url).pathname),calls=[];let closed=0,changed=0;
 const view=f.track(f.ui.mountScheduleManager(f.container,{initialTaskId,initialAction,canWrite:()=>write,safe:String,onClose:()=>closed++,onChanged:()=>changed++,invoke:async(action,payload)=>{calls.push({action,payload});return action==='scheduleCatalog'?{available:true,canRun:true,tasks,operations:[]}:mutate(payload);}}));await settle();return {...f,calls,view,get changed(){return changed;},get closed(){return closed;}};
}
test('panel previews scope, confirms native manual run once and displays submission truthfully',async t=>{
 const gate=deferred(),f=await fixture(t,{mutate:()=>gate.promise});f.container.querySelector('[aria-label="Daily · 已启用"]').click();click(f.container,'立即执行');assert.match(f.container.textContent,/original-group/);assert.match(f.container.textContent,/不会改变下一次/);assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
 click(f.container,'确认执行');click(f.container,'正在提交…');assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,1);const p=f.calls.at(-1).payload;assert.equal(p.action,'run');assert.equal(p.expectedRevision,'revision');assert.equal(p.confirmed,true);assert.ok(p.requestId);
 gate.resolve({status:'succeeded',id:'one',enqueued:true});await settle();assert.match(f.container.textContent,/已提交 OpenClaw/);assert.equal(f.changed,1);
});
test('source-bound creation shows inherited immutable task and only sends schedule fields',async t=>{
 const f=await fixture(t);click(f.container,'基于群请求新建');assert.match(f.container.textContent,/Original requester/);assert.match(f.container.textContent,/No new business writes/);
 f.container.querySelector('[aria-label="任务名称"]').value='Morning';f.container.querySelector('[aria-label="每日执行时间"]').value='08:00';f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));click(f.container,'确认执行');await settle();
 const p=f.calls.find(c=>c.action==='scheduleManage').payload;assert.equal(p.sourceId,'one');assert.equal(p.name,'Morning');assert.equal(p.expr,'0 8 * * *');assert.ok(!('task'in p));assert.ok(!('chatId'in p));assert.match(f.container.textContent,/默认暂停/);
});
test('read-only panel cannot create, edit or run, and native failures are not success',async t=>{
 const f=await fixture(t,{write:false});f.container.querySelector('[aria-label="Daily · 已启用"]').click();for(const label of ['立即执行','删除','暂停','保存设置','基于群请求新建'])assert.equal([...f.container.querySelectorAll('button')].find(b=>b.textContent===label).disabled,true);assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
});
test('closing an in-flight panel ignores delayed responses without changing another view',async t=>{
 const gate=deferred(),f=await fixture(t,{mutate:()=>gate.promise});f.container.querySelector('[aria-label="Daily · 已启用"]').click();click(f.container,'暂停');click(f.container,'确认执行');click(f.container,'关闭');gate.resolve({status:'succeeded',id:'one'});await settle();assert.equal(f.container.textContent,'');assert.equal(f.changed,0);assert.equal(f.closed,1);
});
test('panel reports uncertain action without automatic retry',async t=>{
 const f=await fixture(t,{mutate:async()=>{throw Error('结果未确认');}});f.container.querySelector('[aria-label="Daily · 已启用"]').click();click(f.container,'删除');click(f.container,'确认执行');await settle();assert.match(f.container.textContent,/结果未确认/);assert.ok(!f.container.textContent.includes('操作已完成'));assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,1);
});
test('system plans expose daily time editor and native controls without borrowing group provenance',async t=>{
 const f=await browserFixture(t,new URL('./schedule-manager.mjs',import.meta.url).pathname),calls=[];const system={...task,id:'repo-sync:main',kind:'repository-sync',name:'每日仓库同步',schedule:{kind:'cron',time:'08:00',tz:'Asia/Shanghai'},canRun:false,alreadyAttempted:true};
 f.track(f.ui.mountScheduleManager(f.container,{safe:String,canWrite:()=>true,onChanged(){},invoke:async(action,payload)=>{calls.push({action,payload});return action==='scheduleCatalog'?{available:true,tasks:[system,task],canRun:true,operations:[]}:{status:'succeeded',id:system.id};}}));await settle();f.container.querySelector('[aria-label="每日仓库同步 · 已启用"]').click();assert.match(f.container.textContent,/今日已有/);assert.equal([...f.container.querySelectorAll('button')].find(b=>b.textContent==='立即执行').disabled,true);assert.equal(f.container.querySelector('[aria-label="Cron（五字段）"]'),null);
 f.container.querySelector('[aria-label="每日执行时间"]').value='09:00';f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));assert.match(f.container.textContent,/当前 Agent 全部登记项目/);click(f.container,'确认执行');await settle();const p=calls.find(c=>c.action==='scheduleManage').payload;assert.equal(p.id,'repo-sync:main');assert.equal(p.time,'09:00');assert.ok(!('sourceId'in p));
 click(f.container,'基于群请求新建');assert.equal(f.container.querySelector('[aria-label="来源群请求"]').options.length,1);
});
test('cancelled confirmation and navigation preserve unsaved schedule fields',async t=>{
 const f=await fixture(t);
 f.container.querySelector('[aria-label="任务名称"]').value='Draft';
 f.container.querySelector('[aria-label="每日执行时间"]').value='10:15';
 f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));
 assert.match(f.container.textContent,/每天 10:15/);assert.ok(!f.container.textContent.includes('"expr"'));
 click(f.container,'取消');assert.equal(f.container.querySelector('[aria-label="任务名称"]').value,'Draft');
 click(f.container,'基于群请求新建');f.container.querySelector('[aria-label="Daily · 已启用"]').click();
 assert.equal(f.container.querySelector('[aria-label="每日执行时间"]').value,'10:15');
 assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
});
test('search filters task list without discarding editor and custom cron stays editable',async t=>{
 const f=await fixture(t),search=f.container.querySelector('[aria-label="搜索任务"]');
 search.value='missing';search.dispatchEvent(new f.window.Event('input'));
 assert.equal(f.container.querySelector('[aria-label="Daily · 已启用"]').hidden,true);
 const mode=f.container.querySelector('[aria-label="重复方式"]');mode.value='custom';mode.dispatchEvent(new f.window.Event('change'));
 const cron=f.container.querySelector('[aria-label="Cron（五字段）"]');assert.equal(cron.parentElement.hidden,false);cron.value='30 10 * * 1-5';
 f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));click(f.container,'确认执行');await settle();
 assert.equal(f.calls.find(c=>c.action==='scheduleManage').payload.expr,'30 10 * * 1-5');
});
test('changing one-time plan to recurring previews the new schedule and keeps source binding',async t=>{
 const f=await fixture(t,{tasks:[{...task,schedule:{kind:'at',at:'2099-01-01T09:00:00+08:00'}}]});
 const kind=f.container.querySelector('[aria-label="计划类型"]');kind.value='cron';kind.dispatchEvent(new f.window.Event('change'));
 f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));
 assert.match(f.container.textContent,/每天 09:00/);assert.ok(!f.container.textContent.includes('2099-01-01'));
 click(f.container,'确认执行');await settle();const p=f.calls.find(c=>c.action==='scheduleManage').payload;
 assert.equal(p.id,'one');assert.equal(p.expr,'0 9 * * *');assert.ok(!('at'in p));
});
test('initial catalog failure exposes retry and recovers without reopening panel',async t=>{
 const f=await browserFixture(t,new URL('./schedule-manager.mjs',import.meta.url).pathname);let attempts=0;
 f.track(f.ui.mountScheduleManager(f.container,{safe:String,canWrite:()=>true,invoke:async()=>{if(++attempts===1)throw Error('网络不可用');return {available:true,tasks:[task],operations:[]};}}));
 await settle();assert.match(f.container.querySelector('[role="alert"]').textContent,/网络不可用/);
 click(f.container,'重新读取');await settle();assert.equal(attempts,2);assert.ok(f.container.querySelector('[aria-label="任务名称"]'));
});

test('direct editing selects the requested plan without executing it',async t=>{
 const f=await fixture(t,{initialTaskId:'two',tasks:[task,{...task,id:'two',name:'Second plan'}]});
 assert.equal(f.container.querySelector('[aria-label="任务名称"]').value,'Second plan');
 assert.equal(f.container.querySelector('[aria-current="true"]').textContent.includes('Second plan'),true);
 assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
});

for(const [action,status] of [['pause','enabled'],['resume','paused'],['remove','enabled']])test(`direct ${action} rechecks selected task and requires confirmation`,async t=>{
 const f=await fixture(t,{initialTaskId:'two',initialAction:action,tasks:[task,{...task,id:'two',name:'Target',status}]});
 assert.match(f.container.textContent,/确认/);assert.match(f.container.textContent,/Target/);
 assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
 click(f.container,'确认执行');await settle();const p=f.calls.find(c=>c.action==='scheduleManage').payload;
 assert.equal(p.id,'two');assert.equal(p.action,action);assert.equal(p.expectedRevision,'revision');assert.equal(p.confirmed,true);
});
test('direct actions respect read-only permissions',async t=>{
 const f=await fixture(t,{write:false,initialTaskId:'one',initialAction:'remove'});
 assert.match(f.container.textContent,/状态或权限已变化/);assert.ok(![...f.container.querySelectorAll('button')].some(b=>b.textContent==='确认执行'));
 assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
});

for(const [action,initialTaskId,tasks] of [
 ['pause','one',[{...task,status:'paused'}]],
 ['resume','one',[task]],
 ['resume','one',[{...task,status:'paused',sourceValid:false}]],
 ['remove','missing',[task]],
])test(`direct ${action} rejects changed or missing task ${initialTaskId}`,async t=>{
 const f=await fixture(t,{initialTaskId,initialAction:action,tasks});
 assert.match(f.container.textContent,/状态或权限已变化/);
 assert.ok(![...f.container.querySelectorAll('button')].some(b=>b.textContent==='确认执行'));
 assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
});

test('delivery position is editable with confirmation and cannot select an unknown thread',async t=>{
 const f=await fixture(t,{tasks:[{...task,deliveryMode:'source',delivery:{canUseThread:false}}]});
 const mode=f.container.querySelector('[aria-label="投递位置"]');assert.equal(mode.querySelector('[value="thread"]').disabled,true);
 mode.value='group';f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));
 assert.match(f.container.textContent,/投递位置：群主会话/);assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
 click(f.container,'确认执行');await settle();assert.equal(f.calls.find(c=>c.action==='scheduleManage').payload.deliveryMode,'group');
});
