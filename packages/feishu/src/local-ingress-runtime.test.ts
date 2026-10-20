import { openLocalIngressQueue } from "./local-ingress-queue.js";
import { it, expect, vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuDurableIngress } from './feishu-ingress.js';
import { setFeishuRuntime } from './runtime.js';
import type { PluginRuntime } from 'openclaw/plugin-sdk/core';
it('starts and drains the actual Feishu ingress with all trusted host stores denied',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-live-ingress-'));
 const denied=vi.fn(()=>{throw Error('PLUGIN_TRUST_REFUSED');});
 setFeishuRuntime({state:{resolveStateDir:()=>dir,openKeyedStore:denied,openChannelIngressQueue:denied}} as unknown as PluginRuntime);
 const dispatch=vi.fn(async()=>({kind:'completed'}));
 const errors=vi.fn();
 const ingress=createFeishuDurableIngress({accountId:'test',dispatcher:{invoke:dispatch},runtime:{error:errors},pollIntervalMs:10});
 const envelope={schema:'2.0',header:{event_id:'event-test',event_type:'im.message.receive_v1',create_time:String(Date.now())},event:{sender:{sender_id:{open_id:'ou-test'},sender_type:'user'},message:{message_id:'om-test',chat_id:'oc-test',chat_type:'group',message_type:'text',content:JSON.stringify({text:'test'}),create_time:String(Date.now())}}};
 try {
  await ingress.start();await ingress.invokeWebhook(envelope,{needCheck:false});await ingress.waitForIdle();
  await ingress.invokeWebhook(envelope,{needCheck:false});await ingress.waitForIdle();
  expect(dispatch).toHaveBeenCalledOnce();expect(denied).not.toHaveBeenCalled();expect(errors).not.toHaveBeenCalled();
 }finally{await ingress.stop();rmSync(dir,{recursive:true,force:true});}
});

it('preserves durable identity and gives correction events a separate ingress lane',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-steer-ingress-'));
 const queue=openLocalIngressQueue('test',join(dir,'state.sqlite'));
 const enqueue=vi.spyOn(queue,'enqueue');
 const dispatch=vi.fn(async()=>({kind:'completed'}));
 const ingress=createFeishuDurableIngress({accountId:'test',queue,dispatcher:{invoke:dispatch},runtime:{error:vi.fn()},pollIntervalMs:10});
 const envelope=(id:string,text:string)=>({schema:'2.0',header:{event_id:id,event_type:'im.message.receive_v1',create_time:String(Date.now())},event:{sender:{sender_id:{open_id:'sender'},sender_type:'user'},message:{message_id:id,chat_id:'chat',chat_type:'group',message_type:'text',content:JSON.stringify({text}),create_time:String(Date.now())}}});
 try {
  await ingress.start();
  await ingress.invokeWebhook(envelope('first','普通请求'),{needCheck:false});
  await ingress.invokeWebhook(envelope('second','@_user_1 更正一下：昨天'),{needCheck:false});
  await ingress.waitForIdle();
  expect(enqueue.mock.calls.map(call=>call[2]?.laneKey)).toEqual(['chat:chat','chat:chat:steer']);
  expect(dispatch).toHaveBeenCalledTimes(2);
 }finally{await ingress.stop();rmSync(dir,{recursive:true,force:true});}
});

it('admits later same-chat messages while the first claim remains deferred',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-waiting-ingress-'));
 const queue=openLocalIngressQueue('waiting',join(dir,'state.sqlite'));
 const held: import('./feishu-ingress.js').FeishuIngressLifecycle[]=[];
 let ingress: ReturnType<typeof createFeishuDurableIngress>;
 const dispatch=vi.fn(async(data: unknown)=>{
  const lifecycle=ingress.resolveLifecycle(data)!;
  expect(lifecycle).toBeDefined();
  held.push(lifecycle); lifecycle.onDeferred();
  return {kind:'deferred'};
 });
 ingress=createFeishuDurableIngress({accountId:'waiting',queue,dispatcher:{invoke:dispatch},runtime:{error:vi.fn()},pollIntervalMs:10});
 const envelope=(id:string)=>({schema:'2.0',header:{event_id:id,event_type:'im.message.receive_v1'},event:{sender:{sender_id:{open_id:'sender'},sender_type:'user'},message:{message_id:id,chat_id:'chat',chat_type:'group',message_type:'text',content:JSON.stringify({text:id})}}});
 try{
  ingress.start();
  for(const id of ['a','b','c'])await ingress.invokeWebhook(envelope(id),{needCheck:false});
  await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledTimes(3),{timeout:4000});
 }finally{
  await Promise.all(held.map(l=>l.onAdopted()));
  await ingress.stop();rmSync(dir,{recursive:true,force:true});
 }
});

it('durably admits recall on its own lane while the source request is deferred',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-recall-ingress-'));
 const queue=openLocalIngressQueue('recall',join(dir,'state.sqlite'));
 const enqueue=vi.spyOn(queue,'enqueue');
 const held: import('./feishu-ingress.js').FeishuIngressLifecycle[]=[];
 let ingress: ReturnType<typeof createFeishuDurableIngress>;
 const dispatch=vi.fn(async(data: unknown)=>{
  if((data as {header:{event_type:string}}).header.event_type==='im.message.receive_v1') {
   const lifecycle=ingress.resolveLifecycle({event_id:(data as {header:{event_id:string}}).header.event_id})!;held.push(lifecycle);lifecycle.onDeferred();return {kind:'deferred'};
  }
  return {kind:'completed'};
 });
 ingress=createFeishuDurableIngress({accountId:'recall',queue,dispatcher:{invoke:dispatch},runtime:{error:vi.fn()},pollIntervalMs:10});
 try {
  ingress.start();
  await ingress.invokeWebhook({schema:'2.0',header:{event_id:'source',event_type:'im.message.receive_v1'},event:{message:{message_id:'one',chat_id:'c',message_type:'text',content:'{"text":"task"}'}}},{needCheck:false});
  await ingress.invokeWebhook({schema:'2.0',header:{event_id:'recall',event_type:'im.message.recalled_v1'},event:{message_id:'one',chat_id:'c',recall_type:'group_manager'}},{needCheck:false});
  await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledTimes(2),{timeout:4000});
  expect(enqueue.mock.calls.map(call=>call[2]?.laneKey)).toEqual(['chat:c','chat:c:recall']);
 } finally {await Promise.all(held.map(l=>l.onAdopted()));await ingress.stop();rmSync(dir,{recursive:true,force:true});}
});
