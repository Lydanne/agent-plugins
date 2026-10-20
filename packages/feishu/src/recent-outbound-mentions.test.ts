import {beforeEach,expect,it} from 'vitest';
import {clearRecentOutboundMentions,nativeMentionIds,recordOutboundMentions,recordEditedMentions,recentlyMentioned,textMentionsUser} from './recent-outbound-mentions.js';
const scope={accountId:'a',to:'chat:oc_chat',replyInThread:true,replyToMessageId:'om_question'};
const at={tag:'at',user_id:'ou_requester'};
beforeEach(clearRecentOutboundMentions);
it('isolates accounts, chats, threads and recipients, and follows its own reply chain',()=>{
 recordOutboundMentions(scope,'om_sent',at,1000);
 expect(recentlyMentioned(scope,'ou_requester',1001)).toBe(true);
 expect(recentlyMentioned({...scope,to:'oc_chat',replyToMessageId:'om_sent'},'ou_requester',1001)).toBe(true);
 for(const other of [{...scope,accountId:'b'},{...scope,to:'oc_other',replyToMessageId:'om_sent'},{...scope,replyToMessageId:'om_other'},{...scope,replyInThread:false}])expect(recentlyMentioned(other,'ou_requester',1001)).toBe(false);
 expect(recentlyMentioned(scope,'ou_other',1001)).toBe(false);
});
it('expires mentions at five minutes and after five later accepted messages',()=>{
 recordOutboundMentions(scope,'om_sent',at,1000);
 expect(recentlyMentioned(scope,'ou_requester',300999)).toBe(true);
 expect(recentlyMentioned(scope,'ou_requester',301000)).toBe(false);
 recordOutboundMentions(scope,'om_sent',at,400000);
 for(let i=0;i<5;i++)recordOutboundMentions(scope,'om_'+i,{},400001+i);
 expect(recentlyMentioned(scope,'ou_requester',400010)).toBe(false);
});
it('updates the known message instead of retaining a removed mention',()=>{
 recordOutboundMentions(scope,'om_sent',at,1000);
 recordEditedMentions('a','om_sent',{},1001);
 expect(recentlyMentioned(scope,'ou_requester',1002)).toBe(false);
 recordEditedMentions('b','om_sent',at,1002);
 recordEditedMentions('a','unknown',at,1002);
 expect(recentlyMentioned(scope,'ou_requester',1003)).toBe(false);
 recordEditedMentions('a','om_sent',at,1004);
 expect(recentlyMentioned(scope,'ou_requester',1005)).toBe(true);
});
it('recognizes rich-post and card native mentions but ignores code, plain text and at-all',()=>{
 const mention='<at id="ou_requester"></at>';
 expect(textMentionsUser(mention+'老师','ou_requester')).toBe(true);
 for(const text of ['@同学','`'+mention+'`','```html\n'+mention+'\n```'])expect(textMentionsUser(text,'ou_requester')).toBe(false);
 expect(nativeMentionIds({body:{elements:[{tag:'markdown',content:mention},{tag:'at',user_id:'all'}]},config:{summary:{content:mention}}})).toEqual(['ou_requester']);
});
it('ignores missing receipts',()=>{
 recordOutboundMentions(scope,'',at,1000);
 expect(recentlyMentioned(scope,'ou_requester',1001)).toBe(false);
});

it('restores a persisted card scope only from trusted delivery context',()=>{
 recordOutboundMentions(scope,'new-mention',at,1000);
 recordEditedMentions('a','restored-card',{},1001,scope);
 expect(recentlyMentioned({...scope,replyToMessageId:'restored-card'},'ou_requester',1002)).toBe(true);
 expect(recentlyMentioned({...scope,to:'oc_other',replyToMessageId:'restored-card'},'ou_requester',1002)).toBe(false);
});
