import {parseHistory} from './context-history.js';
import {expect,it,vi} from 'vitest';
import {prepareHistory,selectRelatedHistory,renderInputContext} from './input-context.js';
const m=(messageId:string)=>({messageId,content:messageId,contentType:'text'});
it('does not confuse equal text with a provider reference and never includes another topic',()=>{
 const messages=[m('quote'),{...m('same'),content:'quote'},{...m('reply'),rootId:'root'},m('root')];
 expect(selectRelatedHistory(messages,{rootId:'root',parentId:'quote'}).map(m=>m.messageId)).toEqual(['quote','reply','root']);
 expect(selectRelatedHistory(messages,{threadId:'missing'})).toEqual([]);
});
it('evicts ordinary history before a direct quote and reports counts without content',()=>{
 const report=vi.fn();
 const result=prepareHistory([m('quote'),{...m('large'),rootId:'root',content:'secret'.repeat(500)}],{relation:{rootId:'root',parentId:'quote'},maxChars:1000,report});
 expect(parseHistory(result)!.map((m:{messageId:string})=>m.messageId)).toEqual(['quote']);
 expect(report).toHaveBeenCalledWith({protocol:1,candidates:2,unrelated:0,budgetDropped:1,retained:1,chars:result.length});
 expect(JSON.stringify(report.mock.calls)).not.toContain('secret');
});
it('renders current input and identity independently of supplemental history',()=>{
 expect(renderInputContext({sender:'sender',style:'style',identity:'stamp',current:'request'})).toBe('senderstyle\nstamp\nrequest');
});
