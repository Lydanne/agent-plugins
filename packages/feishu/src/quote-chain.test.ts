import {expect,it,vi,afterEach} from "vitest";
import {loadQuoteChain,renderQuoteAncestors} from "./quote-chain.js";
const mockGet = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({createFeishuClient: () => ({im:{message:{get:mockGet}}})}));
vi.mock("./accounts.js", () => ({resolveFeishuRuntimeAccount: () => ({configured:true,accountId:"test"})}));
import {getMessageFeishu,parseFeishuMessageItem} from "./send.js";
const message=(messageId:string,parentId?:string)=>({messageId,parentId,chatId:"chat",content:messageId,contentType:"text"});
const base={parentId:"c",currentMessageId:"current",chatId:"chat",visible:async()=>true};
afterEach(()=>vi.useRealTimers());
it("requests OpenIDs for fetched mentions and refuses withdrawn API messages",async()=>{
 const item={message_id:"native",chat_id:"chat",msg_type:"text",body:{content:'{"text":"@_user_1"}'},mentions:[{id:"ou-ada",id_type:"open_id",key:"@_user_1"}]};
 mockGet.mockResolvedValueOnce({code:0,data:{items:[item]}});
 expect((await getMessageFeishu({cfg:{},messageId:"native",accountId:"test"}))?.mentionedOpenIds).toEqual(["ou-ada"]);
 expect(mockGet).toHaveBeenLastCalledWith({params:{card_msg_content_type:"user_card_content",user_id_type:"open_id"},path:{message_id:"native"}});
 mockGet.mockResolvedValueOnce({code:0,data:{items:[{...item,deleted:true}]}});
 expect(await getMessageFeishu({cfg:{},messageId:"native",accountId:"test"})).toBeNull();
});
it("keeps native app_id bot mentions returned by the API even when requesting OpenIDs",async()=>{
 const item={message_id:"native-app",chat_id:"chat",msg_type:"text",body:{content:'{"text":"@_user_1 使用 codex_query 等30s输出 aaa"}'},mentions:[
  {id:"cli-ada",id_type:"app_id",key:"@_user_1"},
  {id:"cli-ada",id_type:"app_id",key:"@_user_1"},
  {id:"cli-impostor",id_type:"user_id",key:"@_user_2"},
 ]};
 mockGet.mockResolvedValueOnce({code:0,data:{items:[item]}});
 const parsed=await getMessageFeishu({cfg:{},messageId:"native-app",accountId:"test"});
 expect(parsed?.mentionedAppIds).toEqual(["cli-ada"]);
 expect(parsed?.mentionedOpenIds).toBeUndefined();
});
it("follows every parent and renders oldest ancestors first without duplicating the direct quote",async()=>{
 const rows=[message("c","b"),message("b","a"),message("a")];
 const fetch=vi.fn(async(id:string)=>rows.find(m=>m.messageId===id)??null);
 const result=await loadQuoteChain({...base,fetch});
 expect(result.messages.map(m=>m.messageId)).toEqual(["c","b","a"]);
 expect(result.notice).toBe("");
 const rendered=renderQuoteAncestors(result.messages,result.notice);
 const data=JSON.parse(rendered.split("\n")[1]);
 expect(data.ancestors.map((m:{messageId:string})=>m.messageId)).toEqual(["a","b"]);
 expect(data.directQuoteParentId).toBe("b");
 expect(fetch).toHaveBeenCalledTimes(3);
});
it("preserves the API parent ID independently of the topic root",()=>{
 const parsed=parseFeishuMessageItem({message_id:"c",parent_id:"b",root_id:"a",body:{content:'{"text":"c"}'}});
 expect(parsed.parentId).toBe("b");expect(parsed.rootId).toBe("a");
});
it("retains native OpenID mentions without interpreting display text or broadcast mentions",()=>{
 const parsed=parseFeishuMessageItem({message_id:"native",body:{content:'{"text":"@Ada"}'},mentions:[
  {id:"ou-ada",id_type:"open_id",key:"@_user_1"},
  {id:"ou-ada",id_type:"open_id",key:"@_user_1"},
  {id:"other-id",id_type:"user_id"}, {id:"all",id_type:"open_id"}, {id:"here",id_type:"open_id"},
 ]});
 expect(parsed.mentionedOpenIds).toEqual(["ou-ada"]);
 expect(parseFeishuMessageItem({body:{content:'{"text":"@Ada <at id=ou-ada>"}'}}).mentionedOpenIds).toBeUndefined();
 expect(parseFeishuMessageItem({msg_type:"post",body:{content:JSON.stringify({zh_cn:{title:"",content:[[{tag:"at",user_id:"ou-ada"}]]}})}}).mentionedOpenIds).toEqual(["ou-ada"]);
});
it("stops cycles and configured depth with an explicit notice",async()=>{
 const fetch=vi.fn(async(id:string)=>message(id,id==="c"?"b":"c"));
 expect((await loadQuoteChain({...base,fetch})).notice).toContain("循环");
 fetch.mockClear();
 const result=await loadQuoteChain({...base,fetch,maxDepth:1});
 expect(result.messages).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(1);expect(result.notice).toContain("上限");
});
it("stops on invisible, missing or cross-chat messages without following their parents",async()=>{
 for(const blocked of [null,{...message("b","secret"),chatId:"other"},message("b","secret")]) {
  const fetch=vi.fn(async(id:string)=>id==="c"?message("c","b"):blocked);
  const result=await loadQuoteChain({...base,fetch,visible:async m=>m.messageId!=="b"});
  expect(result.messages.map(m=>m.messageId)).toEqual(["c"]);
  expect(result.notice).toContain("不完整");expect(fetch).toHaveBeenCalledTimes(2);
 }
});
it("retains direct quote when the ancestor budget is exhausted",async()=>{
 const result=await loadQuoteChain({...base,maxChars:1000,fetch:async id=>id==="c"?message("c","b"):{...message("b"),content:"x".repeat(2000)}});
 expect(result.messages).toHaveLength(1);expect(result.notice).toContain("预算");
});
it("returns the partial chain on timeout without late mutations",async()=>{
 vi.useFakeTimers();
 let resolveLate!:(m:ReturnType<typeof message>)=>void;
 const fetch=vi.fn(async(id:string)=>id==="c"?message("c","b"):new Promise<ReturnType<typeof message>>(resolve=>{resolveLate=resolve;}));
 const pending=loadQuoteChain({...base,fetch});
 await vi.advanceTimersByTimeAsync(5000);
 const result=await pending;expect(result.messages).toHaveLength(1);expect(result.notice).toContain("超时");
 resolveLate(message("b","a"));await vi.advanceTimersByTimeAsync(1);
 expect(result.messages).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(2);
});

it('follows ancestors beyond the presentation budget using an independent read budget',async()=>{
 const fetch=vi.fn(async(id:string)=>({...message(id,id==='c'?'b':id==='b'?'a':undefined),content:'x'.repeat(1200)}));
 const result=await loadQuoteChain({...base,maxChars:1000,readMaxChars:10000,fetch});
 expect(result.messages.map(m=>m.messageId)).toEqual(['c','b','a']);expect(result.notice).toBe('');
});
