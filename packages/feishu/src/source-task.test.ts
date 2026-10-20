import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const state = vi.hoisted(() => ({dir: "", unavailable:false}));
vi.mock("./runtime.js", () => ({getFeishuRuntime: () => {if(state.unavailable)throw Error("Feishu runtime not initialized");return {state:{resolveStateDir:()=>state.dir}};}}));
import {SourceTask, recallTaskSource, sourceTaskBridge, isCompletionSourceCurrent} from "./source-task.js";
const scope={accountId:"a", chatId:"c", sessionKey:"s", senderId:"u"};
let opened: SourceTask[];
const task=(sources=[{messageId:"one",text:"first"},{messageId:"two",text:"second"}])=>{
  const result=new SourceTask(scope,sources);opened.push(result);return result;
};
beforeEach(()=>{state.unavailable=false;state.dir=mkdtempSync(join(tmpdir(),"source-task-test-"));opened=[];});
afterEach(()=>{for(const t of opened)t.close();sourceTaskBridge.recalls.clear();rmSync(state.dir,{recursive:true,force:true});});
it("invalidates partial plans synchronously and stops only when all sources are gone",()=>{
 const t=task(), first=t.begin();t.activate();
 recallTaskSource({...scope,messageId:"one"});
 expect(first.signal.aborted).toBe(true);expect(t.stopped.signal.aborted).toBe(false);
 expect(t.remaining().map(s=>s.messageId)).toEqual(["two"]);
 t.endRevision();const second=t.begin();t.activate();expect(second.revision).toBe(1);
 recallTaskSource({...scope,messageId:"one"});expect(second.signal.aborted).toBe(false);
 recallTaskSource({...scope,messageId:"two"});expect(second.signal.aborted).toBe(true);expect(t.stopped.signal.aborted).toBe(true);
});
it("keeps authenticated account/chat identities isolated and ignores own placeholder recalls",()=>{
 const t=task(),lease=t.begin();t.activate();
 for(const event of [{...scope,accountId:"other",messageId:"one"},{...scope,chatId:"other",messageId:"one"},{...scope,messageId:"placeholder"}])recallTaskSource(event);
 expect(lease.signal.aborted).toBe(false);expect(t.revision).toBe(0);
});
it("retains tombstones before admission and across a recreated task",()=>{
 recallTaskSource({...scope,messageId:"one"});
 const t=task([{messageId:"one",text:"do not execute"}]);
 expect(t.stopped.signal.aborted).toBe(true);expect(t.begin().signal.aborted).toBe(true);
});
it("does not let a queued or old task release the active successor binding",()=>{
 const first=task(),second=task([{messageId:"other",text:"other task"}]);first.begin();first.activate();second.begin();
 expect(sourceTaskBridge.leases.get(JSON.stringify(["a","s"]))?.taskId).toBe(first.id);
 second.activate();first.close();expect(sourceTaskBridge.leases.get(JSON.stringify(["a","s"]))?.taskId).toBe(second.id);
});
it("tracks adopted corrections and reattempts persistent background cancellation",()=>{
 const t=task(),lease=t.begin();t.activate();t.add({messageId:"correction",text:"new scope"});
 expect(lease.sourceMessageIds).toContain("correction");
 const handler=vi.fn().mockImplementationOnce(()=>{throw Error("disk full");});sourceTaskBridge.recalls.add(handler);
 expect(()=>recallTaskSource({...scope,messageId:"correction"})).toThrow();
 expect(lease.signal.aborted).toBe(true);
 recallTaskSource({...scope,messageId:"correction"});expect(handler).toHaveBeenCalledTimes(2);
 expect(t.instruction()).not.toContain("new scope");
});

it("stops when only references survive, but retains their IDs for cancellation audit",()=>{
 const t=new SourceTask(scope,[{messageId:'request',text:'do it',kind:'request'},{messageId:'quote',text:'old task',kind:'reference'}]);opened.push(t);
 const lease=t.begin();t.activate();
 recallTaskSource({...scope,messageId:'request'});
 expect(lease.signal.aborted).toBe(true);expect(t.stopped.signal.aborted).toBe(true);
 expect(t.remaining().map(s=>s.messageId)).toEqual(['quote']);
 expect(t.remainingRequests()).toEqual([]);t.endRevision();expect(t.begin().signal.aborted).toBe(true);
});
it("cannot activate a reference-only task, including recalls before admission",()=>{
 recallTaskSource({...scope,messageId:'gone'});
 for(const sources of [[{messageId:'quote',text:'reference',kind:'reference' as const}], [{messageId:'gone',text:'request',kind:'request' as const},{messageId:'quote',text:'reference',kind:'reference' as const}]]) {
  const t=new SourceTask(scope,sources);opened.push(t);expect(t.begin().signal.aborted).toBe(true);t.activate();
  expect(sourceTaskBridge.leases.size).toBe(0);
 }
});
it("can rebuild a real request after its reference is withdrawn",()=>{
 const t=new SourceTask(scope,[{messageId:'request',text:'new request',kind:'request'},{messageId:'quote',text:'reference',kind:'reference'}]);opened.push(t);
 t.begin();t.activate();recallTaskSource({...scope,messageId:'quote'});
 expect(t.stopped.signal.aborted).toBe(false);t.endRevision();expect(t.begin().signal.aborted).toBe(false);
 expect(t.remainingRequests().map(s=>s.messageId)).toEqual(['request']);
});

it("validates persisted completion provenance after close and rejects recalls or revision mismatch",()=>{
 const t=task(),lease=t.begin();t.activate();t.close();
 expect(lease.requestMessageIds).toEqual(['one','two']);
 expect(isCompletionSourceCurrent(lease)).toBe(true);
 expect(isCompletionSourceCurrent({...lease,revision:1})).toBe(false);
 recallTaskSource({...scope,messageId:'one'});
 expect(isCompletionSourceCurrent(lease)).toBe(false);
});

it("validates completion sources with an owner-bound state directory in a foreign plugin scope",()=>{
 const t=task(),lease=t.begin();t.activate();
 state.unavailable=true;
 try {
  expect(()=>isCompletionSourceCurrent(lease)).toThrow('Feishu runtime not initialized');
  expect(isCompletionSourceCurrent(lease,state.dir)).toBe(true);
  expect(isCompletionSourceCurrent({...lease,revision:lease.revision+1},state.dir)).toBe(false);
 }finally{state.unavailable=false;}
 recallTaskSource({...scope,messageId:'one'});
 state.unavailable=true;
 try {expect(isCompletionSourceCurrent(lease,state.dir)).toBe(false);}finally{state.unavailable=false;}
});

it("directory refresh does not change source-task identity for the same message",()=>{
 const people={requester:{openId:'u',giteaUsername:'reporter',revision:'first'},mentions:[]} as any;
 const first=new SourceTask({...scope,people},[{messageId:'same',text:'create issue'}]);opened.push(first);
 const second=new SourceTask({...scope,people:{...people,requester:{...people.requester,revision:'updated'}}},[{messageId:'same',text:'create issue'}]);opened.push(second);
 const plain=new SourceTask(scope,[{messageId:'same',text:'create issue'}]);opened.push(plain);expect(first.id).toBe(second.id);expect(first.id).toBe(plain.id);
 expect(first.begin().people?.requester.giteaUsername).toBe('reporter');
});
it('retains authenticated chat type for document grants without changing task identity',()=>{
 const typed=new SourceTask({...scope,chatType:'p2p'},[{messageId:'same',text:'report'}]);opened.push(typed);
 const legacy=new SourceTask(scope,[{messageId:'same',text:'report'}]);opened.push(legacy);
 expect(typed.id).toBe(legacy.id);expect(typed.begin().chatType).toBe('p2p');
});

it("keeps native source tracking and reference separation without repeated field instructions",()=>{
 const t=new SourceTask(scope,[{messageId:'single',text:'你好',kind:'request'}]);opened.push(t);
 const lease=t.begin();t.activate();
 expect(t.instruction(false,{compactPrivate:true})).not.toContain('任务来源使用规则');
 expect(t.instruction()).not.toContain('任务来源使用规则');
 expect(lease.sourceMessageIds).toEqual(['single']);expect(lease.requestMessageIds).toEqual(['single']);
 const data=JSON.parse(t.instruction(false,{compactPrivate:true}).split('\n')[1]);expect(data).toEqual({taskId:t.id,revision:0,sourceMessageIds:['single']});
 t.add({messageId:'quote',text:'参考',kind:'reference'});
 expect(JSON.parse(t.instruction().split('\n')[1]).referenceMessageIds).toEqual(['quote']);
 recallTaskSource({...scope,messageId:'quote'});const after=t.instruction(false,{compactPrivate:true});expect(after).toContain('[TaskSourceWithdrawal]');expect(after).toContain('"withdrawnMessageIds":["quote"]');expect(after).toContain('"cancellationRequested":true');
});
