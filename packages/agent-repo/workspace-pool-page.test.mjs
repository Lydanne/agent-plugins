import test from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,settle,deferred} from '../../scripts/control-ui-test.mjs';
const snapshot={projectId:'xgj',revision:'a'.repeat(64),config:{enabled:true,maxSize:3},occupied:1,slots:[{id:'xgj-0',status:'blocked',owner:'job-1',path:'/fixture/workspace/xgj-0',branch:'codex/fix',error:'Unpushed commits'}]};
test('workspace panel displays occupancy and sends only bounded config fields',async t=>{
 const f=await browserFixture(t,new URL('./workspace-pool-page.mjs',import.meta.url).pathname),calls=[];
 f.track(f.ui.mountWorkspacePool(f.container,{projectId:'xgj',canWrite:()=>true,invoke:async(action,payload)=>{calls.push({action,payload});return {...snapshot,pendingCommit:action.endsWith('Save')};}}));await settle();
 assert.match(f.container.textContent,/异常保留/);assert.match(f.container.textContent,/job-1/);assert.match(f.container.textContent,/不执行强制释放/);
 f.container.querySelector('input[type=number]').value='2';f.container.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));await settle();
 assert.deepEqual(calls[1],{action:'workspacePoolSave',payload:{projectId:'xgj',revision:snapshot.revision,enabled:true,maxSize:2}});assert.match(f.container.textContent,/待提交/);
});
test('read-only panel cannot save and disposed requests cannot repaint a new Agent',async t=>{
 const f=await browserFixture(t,new URL('./workspace-pool-page.mjs',import.meta.url).pathname);
 const view=f.track(f.ui.mountWorkspacePool(f.container,{projectId:'xgj',canWrite:()=>false,invoke:async()=>snapshot}));await settle();assert.equal(f.container.querySelector('button[type=submit]').disabled,true);view.dispose();
 const request=deferred(),next=f.track(f.ui.mountWorkspacePool(f.container,{projectId:'xgj',canWrite:()=>true,invoke:()=>request.promise}));next.dispose();request.resolve(snapshot);await settle();assert.equal(f.container.textContent,'');
});
