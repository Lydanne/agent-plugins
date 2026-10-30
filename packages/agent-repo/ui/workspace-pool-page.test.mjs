import {test,onTestFinished} from 'vitest';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,deferred,click} from '../../../scripts/control-ui-test.mjs';
const snapshot={projectId:'xgj',revision:'a'.repeat(64),config:{enabled:true,maxSize:3},occupied:1,slots:[{id:'xgj-0',status:'blocked',owner:'job-1',path:'/fixture/workspace/xgj-0',branch:'codex/fix',error:'Unpushed commits'}]};
test('workspace panel displays occupancy and sends only bounded config fields',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../workspace-pool-page.mjs')),calls=[];
 f.track(f.ui.mountWorkspacePool(f.container,{context:{...uiContext(async()=>({})),host:{...uiContext(async()=>({})).host,connection:{canRead:true,canWrite:true}}},projectId:'xgj',canWrite:()=>true,invoke:async(action,payload)=>{calls.push({action,payload});return {...snapshot,pendingCommit:action.endsWith('Save')};}}));assert.equal(calls.length,0);assert.equal(f.container.querySelector('[role=dialog]'),null);assert.equal(f.container.querySelector('form'),null);click(f.container,'工作区配置');await settle();
 assert.match(f.container.textContent,/异常保留/);assert.match(f.container.textContent,/job-1/);assert.match(f.container.textContent,/不执行强制释放/);
 f.container.querySelector('input[type=number]').value='2';f.container.querySelector('input[type=number]').dispatchEvent(new f.window.Event('input',{bubbles:true}));await settle();f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));await settle();
 assert.deepEqual(calls[1],{action:'workspacePoolSave',payload:{projectId:'xgj',revision:snapshot.revision,enabled:true,maxSize:2}});assert.match(f.container.textContent,/待提交/);
});
test('read-only panel cannot save and disposed requests cannot repaint a new Agent',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../workspace-pool-page.mjs'));
 const view=f.track(f.ui.mountWorkspacePool(f.container,{context:{...uiContext(async()=>({})),host:{...uiContext(async()=>({})).host,connection:{canRead:true,canWrite:true}}},projectId:'xgj',canWrite:()=>false,invoke:async()=>snapshot}));click(f.container,'工作区配置');await settle();assert.equal(f.container.querySelector('button[type=submit]').disabled,true);view.dispose();
 const request=deferred(),next=f.track(f.ui.mountWorkspacePool(f.container,{context:{...uiContext(async()=>({})),host:{...uiContext(async()=>({})).host,connection:{canRead:true,canWrite:true}}},projectId:'xgj',canWrite:()=>true,invoke:()=>request.promise}));click(f.container,'工作区配置');next.dispose();request.resolve(snapshot);await settle();assert.equal(f.container.textContent,'');
});

test('dialog closes with Escape, backdrop and button, restores focus and ignores late loads',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../workspace-pool-page.mjs')),pending=deferred();let calls=0;
 f.track(f.ui.mountWorkspacePool(f.container,{context:{...uiContext(async()=>({})),host:{...uiContext(async()=>({})).host,connection:{canRead:true,canWrite:true}}},projectId:'xgj',canWrite:()=>true,invoke:()=>++calls===1?pending.promise:Promise.resolve(snapshot)}));
 const trigger=f.container.querySelector('button');trigger.focus();trigger.click();await settle();
 assert.ok(f.container.querySelector('[role=dialog]'));
 f.container.querySelector('[role=dialog]').dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();
 assert.equal(f.container.querySelector('[role=dialog]'),null);assert.equal(f.window.document.activeElement,trigger);
 pending.resolve(snapshot);await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);
 trigger.click();await settle();assert.match(f.container.querySelector('[role=dialog]').textContent,/job-1/);
 f.window.document.body.dispatchEvent(new f.window.PointerEvent('pointerdown',{pointerType:'mouse',button:0,bubbles:true,cancelable:true}));f.window.document.body.dispatchEvent(new f.window.MouseEvent('click',{bubbles:true}));await settle();
 assert.equal(f.container.querySelector('[role=dialog]'),null);assert.equal(f.window.document.activeElement,trigger);
 trigger.click();await settle();click(f.container,'关闭');await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);assert.equal(f.window.document.activeElement,trigger);
});
test('save errors remain inside the dialog and closing a pending save cannot reopen it',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../workspace-pool-page.mjs')),pending=deferred();let saves=0;
 f.track(f.ui.mountWorkspacePool(f.container,{context:{...uiContext(async()=>({})),host:{...uiContext(async()=>({})).host,connection:{canRead:true,canWrite:true}}},projectId:'xgj',canWrite:()=>true,invoke:async action=>{if(action==='workspacePool')return snapshot;if(++saves===1)throw Error('登记版本已过期');return pending.promise;}}));
 click(f.container,'工作区配置');await settle();
 const submit=()=>f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));
 submit();await settle();assert.match(f.container.querySelector('[role=status]').textContent,/登记版本已过期/);
 submit();await settle();click(f.container,'关闭');pending.resolve(snapshot);await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);
});

test('late workspace reads cannot replace the audit view and pending saves prevent a view switch',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../workspace-pool-page.mjs')),read=deferred(),save=deferred();let reads=0;
 f.track(f.ui.mountWorkspacePool(f.container,{context:{...uiContext(async()=>({})),host:{...uiContext(async()=>({})).host,connection:{canRead:true,canWrite:true}}},projectId:'xgj',canWrite:()=>true,invoke:async action=>action==='audit'?{records:[],total:0,nextOffset:null}:action==='workspacePoolSave'?save.promise:++reads===1?read.promise:snapshot}));
 click(f.container,'工作区配置');await settle();click(f.container,'修改日志');await settle();assert.ok(f.container.querySelector('.ar-audit'));read.resolve(snapshot);await settle();assert.ok(f.container.querySelector('.ar-audit'));assert.equal(f.container.querySelector('button[type=submit]'),f.container.querySelector('.ar-audit button[type=submit]'));
 const auditClose=[...f.container.querySelectorAll('.ar-audit button')].find(b=>b.textContent==='关闭');auditClose.click();await settle();f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));await settle();assert.equal([...f.container.querySelectorAll('button')].find(b=>b.textContent==='修改日志').disabled,true);save.resolve(snapshot);await settle();assert.match(f.container.textContent,/池配置已保存/);
});
