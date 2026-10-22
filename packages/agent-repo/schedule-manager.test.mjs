import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,settle,click,select,deferred} from '../../scripts/control-ui-test.mjs';
const task={id:'one',revision:'revision',name:'Daily',status:'enabled',sourceValid:true,busy:false,chatId:'original-group',requester:'Original requester',projectId:'demo',task:'Summarize only',constraints:'No new business writes',schedule:{kind:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'}};
async function fixture(t,{write=true,mutate=async()=>({status:'succeeded',id:'one'})}={}){
 const f=await browserFixture(t,new URL('./schedule-manager.mjs',import.meta.url).pathname),calls=[];let closed=0,changed=0;
 const view=f.track(f.ui.mountScheduleManager(f.container,{canWrite:()=>write,safe:String,onClose:()=>closed++,onChanged:()=>changed++,invoke:async(action,payload)=>{calls.push({action,payload});return action==='scheduleCatalog'?{available:true,canRun:true,tasks:[structuredClone(task)],operations:[]}:mutate(payload);}}));await settle();return {...f,calls,view,get changed(){return changed;},get closed(){return closed;}};
}
test('panel previews scope, confirms native manual run once and displays submission truthfully',async t=>{
 const gate=deferred(),f=await fixture(t,{mutate:()=>gate.promise});click(f.container,'Daily · 已启用');click(f.container,'立即执行');assert.match(f.container.textContent,/original-group/);assert.match(f.container.textContent,/不会改变下一次/);assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
 click(f.container,'确认执行');click(f.container,'正在提交…');assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,1);const p=f.calls.at(-1).payload;assert.equal(p.action,'run');assert.equal(p.expectedRevision,'revision');assert.equal(p.confirmed,true);assert.ok(p.requestId);
 gate.resolve({status:'succeeded',id:'one',enqueued:true});await settle();assert.match(f.container.textContent,/已提交 OpenClaw/);assert.equal(f.changed,1);
});
test('source-bound creation shows inherited immutable task and only sends schedule fields',async t=>{
 const f=await fixture(t);click(f.container,'基于群请求新建');assert.match(f.container.textContent,/Original requester/);assert.match(f.container.textContent,/No new business writes/);
 f.container.querySelector('[aria-label="任务名称"]').value='Morning';f.container.querySelector('[aria-label="Cron（五字段）"]').value='0 8 * * *';f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));click(f.container,'确认执行');await settle();
 const p=f.calls.find(c=>c.action==='scheduleManage').payload;assert.equal(p.sourceId,'one');assert.equal(p.name,'Morning');assert.equal(p.expr,'0 8 * * *');assert.ok(!('task'in p));assert.ok(!('chatId'in p));assert.match(f.container.textContent,/默认暂停/);
});
test('read-only panel cannot create, edit or run, and native failures are not success',async t=>{
 const f=await fixture(t,{write:false});click(f.container,'Daily · 已启用');for(const label of ['立即执行','删除','暂停','保存设置','基于群请求新建'])assert.equal([...f.container.querySelectorAll('button')].find(b=>b.textContent===label).disabled,true);assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,0);
});
test('closing an in-flight panel ignores delayed responses without changing another view',async t=>{
 const gate=deferred(),f=await fixture(t,{mutate:()=>gate.promise});click(f.container,'Daily · 已启用');click(f.container,'暂停');click(f.container,'确认执行');click(f.container,'关闭');gate.resolve({status:'succeeded',id:'one'});await settle();assert.equal(f.container.textContent,'');assert.equal(f.changed,0);assert.equal(f.closed,1);
});
test('panel reports uncertain action without automatic retry',async t=>{
 const f=await fixture(t,{mutate:async()=>{throw Error('结果未确认');}});click(f.container,'Daily · 已启用');click(f.container,'删除');click(f.container,'确认执行');await settle();assert.match(f.container.textContent,/结果未确认/);assert.ok(!f.container.textContent.includes('操作已完成'));assert.equal(f.calls.filter(c=>c.action==='scheduleManage').length,1);
});
