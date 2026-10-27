import test from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,settle,deferred,click} from '../../scripts/control-ui-test.mjs';
const snapshot={projectId:'xgj',revision:'a'.repeat(64),config:{enabled:true,maxSize:3},occupied:1,slots:[{id:'xgj-0',status:'blocked',owner:'job-1',path:'/fixture/workspace/xgj-0',branch:'codex/fix',error:'Unpushed commits'}]};
test('workspace panel displays occupancy and sends only bounded config fields',async t=>{
 const f=await browserFixture(t,new URL('./workspace-pool-page.mjs',import.meta.url).pathname),calls=[];
 f.track(f.ui.mountWorkspacePool(f.container,{projectId:'xgj',canWrite:()=>true,invoke:async(action,payload)=>{calls.push({action,payload});return {...snapshot,pendingCommit:action.endsWith('Save')};}}));assert.equal(calls.length,0);assert.equal(f.container.querySelector('dialog'),null);assert.equal(f.container.querySelector('form'),null);click(f.container,'工作区配置');await settle();
 assert.match(f.container.textContent,/异常保留/);assert.match(f.container.textContent,/job-1/);assert.match(f.container.textContent,/不执行强制释放/);
 f.container.querySelector('input[type=number]').value='2';f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));await settle();
 assert.deepEqual(calls[1],{action:'workspacePoolSave',payload:{projectId:'xgj',revision:snapshot.revision,enabled:true,maxSize:2}});assert.match(f.container.textContent,/待提交/);
});
test('read-only panel cannot save and disposed requests cannot repaint a new Agent',async t=>{
 const f=await browserFixture(t,new URL('./workspace-pool-page.mjs',import.meta.url).pathname);
 const view=f.track(f.ui.mountWorkspacePool(f.container,{projectId:'xgj',canWrite:()=>false,invoke:async()=>snapshot}));click(f.container,'工作区配置');await settle();assert.equal(f.container.querySelector('button[type=submit]').disabled,true);view.dispose();
 const request=deferred(),next=f.track(f.ui.mountWorkspacePool(f.container,{projectId:'xgj',canWrite:()=>true,invoke:()=>request.promise}));click(f.container,'工作区配置');next.dispose();request.resolve(snapshot);await settle();assert.equal(f.container.textContent,'');
});

test('dialog closes with Escape, backdrop and button, restores focus and ignores late loads',async t=>{
 const f=await browserFixture(t,new URL('./workspace-pool-page.mjs',import.meta.url).pathname),pending=deferred();let calls=0;
 f.track(f.ui.mountWorkspacePool(f.container,{projectId:'xgj',canWrite:()=>true,invoke:()=>++calls===1?pending.promise:Promise.resolve(snapshot)}));
 const trigger=f.container.querySelector('button');trigger.focus();trigger.click();
 assert.equal(f.container.querySelector('dialog').open,true);
 f.container.querySelector('dialog').dispatchEvent(new f.window.Event('cancel',{cancelable:true}));
 assert.equal(f.container.querySelector('dialog'),null);assert.equal(f.window.document.activeElement,trigger);
 pending.resolve(snapshot);await settle();assert.equal(f.container.querySelector('dialog'),null);
 trigger.click();await settle();assert.match(f.container.querySelector('dialog').textContent,/job-1/);
 f.container.querySelector('dialog').dispatchEvent(new f.window.MouseEvent('click',{clientX:-1,clientY:-1,bubbles:true}));
 assert.equal(f.container.querySelector('dialog'),null);assert.equal(f.window.document.activeElement,trigger);
 trigger.click();await settle();click(f.container,'关闭');assert.equal(f.container.querySelector('dialog'),null);assert.equal(f.window.document.activeElement,trigger);
});
test('save errors remain inside the dialog and closing a pending save cannot reopen it',async t=>{
 const f=await browserFixture(t,new URL('./workspace-pool-page.mjs',import.meta.url).pathname),pending=deferred();let saves=0;
 f.track(f.ui.mountWorkspacePool(f.container,{projectId:'xgj',canWrite:()=>true,invoke:async action=>{if(action==='workspacePool')return snapshot;if(++saves===1)throw Error('登记版本已过期');return pending.promise;}}));
 click(f.container,'工作区配置');await settle();
 const submit=()=>f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));
 submit();await settle();assert.match(f.container.querySelector('[role=status]').textContent,/登记版本已过期/);
 submit();click(f.container,'关闭');pending.resolve(snapshot);await settle();assert.equal(f.container.querySelector('dialog'),null);
});
