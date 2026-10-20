import {parseHistory} from './context-history.js';
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("./client.js", () => ({ createFeishuClient: () => ({ im: { message: { list } } }) }));
vi.mock("./accounts.js", () => ({ resolveFeishuRuntimeAccount: (p: unknown) => p }));
import type { HistoryMessage } from "./input-context.js";
import { boundMentionHistory, loadMentionHistory } from "./mention-history.js";
const params = { cfg: {}, accountId: "test", chatId: "group", currentMessageId: "current", beforeMs: 100000 };
const item = (id: string, time: number, text = id) => ({ message_id: id, chat_id: "group", create_time: String(time), msg_type: "text", body: { content: JSON.stringify({ text }) }, sender: { id: "sender", sender_type: "user" } });
beforeEach(() => { list.mockReset(); });
afterEach(() => { vi.useRealTimers(); });
it("loads twenty preceding messages, excluding trigger, future, deleted and other groups", async () => {
  list.mockResolvedValue({ code: 0, data: { items: [item("future", 100001), item("current", 100000), { ...item("other", 99), chat_id: "other" }, { ...item("deleted", 98), deleted: true }, ...Array.from({ length: 25 }, (_, i) => item(String(30-i), 90-i))] } });
  const result = await loadMentionHistory(params);
  const records = parseHistory(result)!;
  expect(records).toHaveLength(20);
  expect(records[0].messageId).toBe("11");
  expect(records[19].messageId).toBe("30");
  expect(list).toHaveBeenCalledWith({ params: expect.objectContaining({ container_id_type: "chat", container_id: "group", end_time: "101", page_size: 21 }) });
});
it("paginates, deduplicates and bounds repeated tokens", async () => {
  list.mockResolvedValue({ code: 0, data: { items: [item("one", 1)], has_more: true, page_token: "same" } });
  const result = await loadMentionHistory(params);
  expect(list).toHaveBeenCalledTimes(2);
  expect(result.match(/"messageId"/g)).toHaveLength(1);
});
it("evicts oldest whole messages and counts JSON escaping and metadata", () => {
  const messages = Array.from({length: 20}, (_, i) => ({messageId: String(i), contentType: "text", content: '"\\\n'.repeat(200)}));
  const result = boundMentionHistory(messages, 4000);
  expect(result.length).toBeLessThanOrEqual(4000);
  const records = parseHistory(result)!;
  expect(records.length).toBeGreaterThan(0);
  expect(records.at(-1).messageId).toBe("19");
  expect(records[0].messageId).not.toBe("0");
  expect(boundMentionHistory([{messageId:"huge", contentType:"text",content:"x".repeat(20000)}],1000)).toContain('"messages":[]');
});
it("returns an explicit unavailable notice on API denial", async () => {
  list.mockResolvedValue({ code: 999 });
  expect(await loadMentionHistory(params)).toContain('"status":"unavailable"');
});
it("stops waiting after five seconds", async () => {
  vi.useFakeTimers(); list.mockImplementation(() => new Promise(() => {}));
  const result = loadMentionHistory(params);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toContain('"reason":"timeout"');
});

it("applies context visibility filtering before rendering", async () => {
  list.mockResolvedValue({code:0,data:{items:[item("allowed",2),item("blocked",1)]}});
  const result = await loadMentionHistory({...params,filter:async messages => messages.filter(m=>m.messageId==="allowed")});
  expect(result).toContain("allowed"); expect(result).not.toContain("blocked");
});

it("retains own replies in the mandatory recent window", async()=>{
 list.mockResolvedValue({code:0,data:{items:[
  {...item('own-app',5),sender:{id:'self-app',sender_type:'app'}},
  {...item('own-openid',4),sender:{id:'self-openid',sender_type:'user'}},
  {...item('other-bot',3),sender:{id:'other-app',sender_type:'app'}},item('human',2)
 ]}});
 const result=await loadMentionHistory({...params,botAppId:'self-app',botOpenId:'self-openid',limit:2});
 expect(result).toContain('own-app');expect(result).toContain('own-openid');
 expect(result).toContain('other-bot');expect(result).toContain('human');
});

it('selects provider topic relations and retains a direct quote without unrelated chat',async()=>{
 list.mockResolvedValue({code:0,data:{items:[item('unrelated',9),{...item('topic-reply',8),thread_id:'thread'},item('quote',7)]}});
 const result=await loadMentionHistory({...params,relation:{threadId:'thread',parentId:'quote'}});
 expect(result).toContain('unrelated');expect(result).toContain('topic-reply');expect(result).toContain('quote');
});
it('keeps only five recent background messages without a known topic',async()=>{
 list.mockResolvedValue({code:0,data:{items:Array.from({length:10},(_,i)=>item('m'+i,90-i))}});
 const result=await loadMentionHistory({...params,relation:{}});
 expect(parseHistory(result)!.map((m:{messageId:string})=>m.messageId)).toEqual(['m4','m3','m2','m1','m0']);
});

it("keeps recent five on every turn including large messages and adds quote neighbors", async () => {
 list.mockImplementation(({params:p}) => {
  if (p.page_size === 21) return Promise.resolve({code:0,data:{items:Array.from({length:8},(_,i)=>item('recent'+i,90000-i))}});
  return Promise.resolve({code:0,data:{items:[...Array.from({length:4},(_,i)=>item('before'+i,50000-i-1)),item('quote',50000),...Array.from({length:4},(_,i)=>item('after'+i,50000+i+1)),item('future',100001)]}});
 });
 const result=await loadMentionHistory({...params,relation:{parentId:'quote'},quote:{messageId:'quote',createTime:50000}});
 const records=parseHistory(result)!;
 expect(records.filter((m:HistoryMessage)=>m.retention==='recent')).toHaveLength(5);
 expect(records.filter((m:HistoryMessage)=>m.messageId.startsWith('before')).map((m:HistoryMessage)=>m.messageId)).toEqual(['before2','before1','before0']);
 expect(records.filter((m:HistoryMessage)=>m.messageId.startsWith('after')).map((m:HistoryMessage)=>m.messageId)).toEqual(['after0','after1','after2']);
 expect(result).not.toContain('future');
});
it("preserves mandatory recent messages over the soft character budget",async()=>{
 list.mockResolvedValue({code:0,data:{items:Array.from({length:7},(_,i)=>item('large'+i,90-i,'x'.repeat(2000)))}});
 const result=await loadMentionHistory({...params,maxChars:1000});
 expect(parseHistory(result)!).toHaveLength(5);
});

it("keeps the recent window when quote lookup times out",async()=>{
 vi.useFakeTimers();
 list.mockImplementation(({params:p}) => p.page_size===21
  ? Promise.resolve({code:0,data:{items:Array.from({length:5},(_,i)=>item('recent'+i,90-i))}})
  : new Promise(()=>{}));
 const pending=loadMentionHistory({...params,quote:{messageId:'quote',createTime:50}});
 await vi.advanceTimersByTimeAsync(5000);
 const result=await pending;
 expect(parseHistory(result)!).toHaveLength(5);
 expect(result).toContain('"status":"partial"');
});
it("filters quote neighborhood visibility before selecting three per side",async()=>{
 list.mockImplementation(({params:p}) => Promise.resolve({code:0,data:{items:p.page_size===21 ? [item('recent',90000)] :
  [item('blocked',49999),item('b1',49998),item('b2',49997),item('b3',49996),item('a1',50001),item('a2',50002),item('a3',50003)]}}));
 const result=await loadMentionHistory({...params,quote:{messageId:'quote',createTime:50000},filter:async rows=>rows.filter(m=>m.messageId!=='blocked')});
 expect(result).not.toContain('blocked');
 for(const id of ['b1','b2','b3','a1','a2','a3']) expect(result).toContain(id);
});

it("honors configured recent count even above candidate limit",async()=>{
 list.mockResolvedValue({code:0,data:{items:Array.from({length:10},(_,i)=>item('m'+i,90-i))}});
 const result=await loadMentionHistory({...params,relation:{},recentLimit:7,limit:2});
 expect(parseHistory(result)!).toHaveLength(7);
 expect(list).toHaveBeenCalledWith({params:expect.objectContaining({page_size:8})});
});
it("supports asymmetric quote windows and zero disables each direction",async()=>{
 list.mockImplementation(({params:p})=>Promise.resolve({code:0,data:{items:p.page_size===21?[item('recent',90)]:[item('after1',51),item('after2',52),item('after3',53)]}}));
 const result=await loadMentionHistory({...params,quote:{messageId:'quote',createTime:50},quoteBefore:0,quoteAfter:2});
 expect(result).toContain('after1');expect(result).toContain('after2');expect(result).not.toContain('after3');
 expect(list).toHaveBeenCalledTimes(2);
 list.mockClear();
 await loadMentionHistory({...params,quote:{messageId:'quote',createTime:50},quoteBefore:0,quoteAfter:0});
 expect(list).toHaveBeenCalledTimes(1);
});

it('preserves already fetched recent messages when a later page fails',async()=>{
 list.mockResolvedValueOnce({code:0,data:{items:Array.from({length:5},(_,i)=>item('recent'+i,90-i)),has_more:true,page_token:'next'}}).mockResolvedValueOnce({code:999});
 const result=await loadMentionHistory(params);
 expect(parseHistory(result)!).toHaveLength(5);expect(result).toContain('"status":"partial"');
});
it('defers budgeting until after session deduplication',async()=>{
 list.mockResolvedValue({code:0,data:{items:Array.from({length:10},(_,i)=>item('m'+i,90-i,'x'.repeat(1000)))}});
 const result=await loadMentionHistory({...params,maxChars:1000,deferBudget:true});
 expect(parseHistory(result)!).toHaveLength(10);
});
