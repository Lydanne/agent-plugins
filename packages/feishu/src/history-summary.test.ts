import {parseHistory} from './context-history.js';
import {expect,it,vi,afterEach} from "vitest";
import {mergeHistoryContext,summarizeHistoryContext} from "./history-summary.js";
import {HISTORY_HEADER,prepareHistory,readHistoryContext,renderHistoryContext} from "./input-context.js";
import {CURRENT_HEADER} from "./context-sections.js";
import {contextFingerprint,removeKnownHistory,collectKnownContext,contextMessageMarker} from "./context-history.js";
const m=(messageId:string,content=messageId)=>({messageId,content,contentType:"text"});
const recent=Array.from({length:5},(_,i)=>({...m('r'+i,'x'.repeat(1000)),retention:'recent' as const}));
const body=(rows=recent)=>HISTORY_HEADER+JSON.stringify(rows)+'\n'+CURRENT_HEADER+'\nDO_NOT_CHANGE_CURRENT';
const complete=vi.fn(async({records}:{records:{messageId:string}[]})=>JSON.stringify(records.map(m=>({messageId:m.messageId,summary:'摘要'}))));
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('keeps history status and unknown extensions inside history across merge, deduplication and summary',async()=>{
 const context={messages:[m('known'),{...m('quote'),content:'x'.repeat(4000)}],
  retrieval:[{scope:'history',status:'partial'}],quoteChain:{status:'incomplete',reason:'unavailable'},
  extensions:{crm:{enabled:false,count:0,unknown:null}}};
 const tail='\n[DepartmentReplyStyle]\n{"style":"配置原值"}\n'+CURRENT_HEADER+'\ncurrent request';
 const merged=mergeHistoryContext(renderHistoryContext(context)+tail,[{...context.messages[1],contextKinds:['direct-quote']}]);
 const deduped=removeKnownHistory(merged,[],{accountId:'a',chatId:'g'},undefined,new Map([['known',contextFingerprint(m('known'))]]));
 const result=await summarizeHistoryContext({body:deduped,config:{triggerChars:1000,targetChars:200},complete});
 const block=readHistoryContext(result)!;
 expect(block.context.retrieval).toEqual(context.retrieval);
 expect(block.context.quoteChain).toEqual(context.quoteChain);
 expect(block.context.extensions).toEqual(context.extensions);
 expect(block.context.summary).toBeDefined();
 expect(result.slice(block.end)).toBe(tail);
 expect(result).not.toContain('[Context: 历史消息摘要');
 const marker=contextMessageMarker({accountId:'a',chatId:'g'},m('current'));
 expect(collectKnownContext([{id:'entry',parentId:null,type:'message',message:{role:'user',content:result.replace(CURRENT_HEADER,marker+'\n'+CURRENT_HEADER)}}],{accountId:'a',chatId:'g'}).has('quote')).toBe(false);
});
it('preserves retrieval failure even when every original message was already read',()=>{
 const context={messages:[m('known')],retrieval:[{scope:'history',status:'partial'}]};
 const result=removeKnownHistory(renderHistoryContext(context)+'\n'+CURRENT_HEADER+'\nnow',[],{accountId:'a',chatId:'g'},undefined,new Map([['known',contextFingerprint(m('known'))]]));
 expect(readHistoryContext(result)?.context).toEqual({...context,messages:[]});
});
it('merges same-turn quote and recent sources without losing mandatory status',()=>{
 const result=mergeHistoryContext(body(),[{...recent[0],retention:'quote',contextKinds:['direct-quote']}]);
 const rows=parseHistory(result)!;
 expect(rows).toHaveLength(5);expect(rows[0].retention).toBe('recent');expect(rows[0].contextKinds).toEqual(['direct-quote']);
});
it('summarizes all five oversized recent messages with explicit labels and preserves current request',async()=>{
 const result=await summarizeHistoryContext({body:body(),config:{triggerChars:1000,targetChars:300},complete});
 expect(complete).toHaveBeenCalledTimes(1);expect(result).toContain('AI 生成，非原文');
 for(const row of recent)expect(result).toContain('"messageId":"'+row.messageId+'"');
 expect(result).toContain('DO_NOT_CHANGE_CURRENT');expect(result).not.toContain('x'.repeat(100));
});
it('does not consider summarized originals read, but still recognizes verbatim history',async()=>{
 const scope={accountId:'a',chatId:'g'};
 const result=await summarizeHistoryContext({body:body(),config:{triggerChars:1000},complete});
 const marker=contextMessageMarker(scope,m('current'));
 const events=[{id:'1',parentId:null,type:'message',message:{role:'user',content:result.replace(CURRENT_HEADER,marker+'\n'+CURRENT_HEADER)}}];
 expect(collectKnownContext(events,scope).has('r0')).toBe(false);
});
it('deduplicates older history before applying the summary budget',async()=>{
 const unseen=m('unseen','u'.repeat(350)),known=m('known','k'.repeat(2000));
 const input=mergeHistoryContext(CURRENT_HEADER+'\nrequest',[unseen,known]);
 const deduped=removeKnownHistory(input,[],{accountId:'a',chatId:'g'},undefined,new Map([[known.messageId,contextFingerprint(known)]]));
 const result=await summarizeHistoryContext({body:deduped,config:{triggerChars:1000},complete});
 expect(result).toContain('unseen');expect(complete).not.toHaveBeenCalled();
});
it('keeps small mandatory originals and summarizes older records',async()=>{
 const small={...m('recent','original'),retention:'recent' as const};
 const input=HISTORY_HEADER+JSON.stringify([small,m('old','x'.repeat(4000))])+'\n'+CURRENT_HEADER+'\nrequest';
 const result=await summarizeHistoryContext({body:input,config:{triggerChars:1800,targetChars:300},complete});
 expect(parseHistory(result)!).toEqual([small]);expect(result).toContain('"summary"');
});
it.each(['invalid','unknown','too-long'])('rejects %s model output and labels deterministic excerpts honestly',async kind=>{
 const bad=async()=>kind==='invalid'?'not json':JSON.stringify(recent.map(m=>({messageId:kind==='unknown'?'invented':m.messageId,summary:'x'.repeat(2000)})));
 const result=await summarizeHistoryContext({body:body(),config:{triggerChars:1000},complete:bad});
 expect(result).toContain('原文摘录，非 AI 摘要');expect(result).not.toContain('invented');expect(result).toContain('截取');
});
it('does not send input beyond the configured budget or when disabled',async()=>{
 for(const config of [{triggerChars:1000,maxInputChars:100},{triggerChars:1000,enabled:false}]){
  const result=await summarizeHistoryContext({body:body(),config,complete});expect(result).toContain('原文摘录');
 }
 expect(complete).not.toHaveBeenCalled();
});
it('times out even if the provider ignores abort',async()=>{
 vi.useFakeTimers();
 const pending=summarizeHistoryContext({body:body(),config:{triggerChars:1000,timeoutMs:1000},complete:async()=>new Promise(()=>{})});
 await vi.advanceTimersByTimeAsync(1000);
 expect(await pending).toContain('AI 摘要超时');
});
