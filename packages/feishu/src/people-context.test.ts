import {expect,it} from 'vitest';
import {renderConversationPeople} from './people-context.js';
import type {TaskPeople} from './people-directory.js';
const person = {openId:'ou_sender',name:'测试用户',accountId:'default',appId:'cli_example',email:'test@example.invalid',departments:[{id:'dev',name:'研发'}],id:'internal-id',observedAt:'time',updatedAt:'time',revision:'rev',giteaUsername:'candidate',giteaSource:'email_prefix' as const};
const people:TaskPeople = {requester:person,mentions:[]};
const profile = {senderOpenId:person.openId,name:person.name,directory:{jobTitle:'工程师',jobTitleStatus:'available' as const,departments:person.departments,source:'feishu_contact'},preferences:null,profileOperation:'none',audience:'研发',audienceSource:'job_title_inference'};
const input = {isGroup:false,senderOpenId:person.openId,people,profile,text:'你好'};
it('private greeting has one compact identity, without null fields or Issue instructions',()=>{
 const text=renderConversationPeople(input);
 expect(text.match(/ou_sender/g)).toHaveLength(1);
 expect(text).toContain('[ConversationPeople]');
 for(const unnecessary of ['本轮人员资料','当前发言者]','Issue','建单','null','email','revision','observedAt','appId','jobTitle','departments','audience','mentions','internal-id'])expect(text).not.toContain(unnecessary);
 expect(text.length).toBeLessThan(220);
});
it('groups include useful role and native mentions without copying stored audit metadata',()=>{
 const text=renderConversationPeople({...input,isGroup:true,people:{...people,mentions:[{...person,openId:'ou_mention',name:'被提及者'}]}});
 expect(text).toContain('ou_mention');expect(text.match(/ou_sender/g)).toHaveLength(1);
 expect(text).toContain('研发');expect(text).toContain('job_title_inference');expect(text).not.toContain('internal-id');
 expect(text).not.toContain('邮箱前缀');
});
it('uses effective stored name without repeated Issue instructions, preserving task snapshot',()=>{
 const snapshot=structuredClone(people);
 const text=renderConversationPeople({...input,people:{...people,requester:{...person,name:'管理员更正姓名'}},text:'将 BUG 记录给原生提及人'});
 expect(text).toContain('管理员更正姓名');expect(text).not.toContain('agent_repo person');expect(text).not.toContain('记录人');expect(text).not.toContain(person.email);
 expect(people).toEqual(snapshot);
});
it('preserves explicit profile operations and preferences in private conversations',()=>{
 for(const operation of ['view','updated','deleted']){
  const text=renderConversationPeople({...input,profile:{...profile,profileOperation:operation}});
  expect(text).toContain('"profileOperation":"'+operation+'"');expect(text).not.toContain('[Guidance:');
  expect(text.includes('"directory"')).toBe(operation==='view');
 }
 expect(renderConversationPeople({...input,profile:undefined})).toContain('ou_sender');
 expect(renderConversationPeople({...input,people:undefined})).toContain(person.name);
 expect(renderConversationPeople({...input,guidance:'自定义资料规则',isGroup:true})).toContain('自定义资料规则');
});

it('omits OpenID-only context in ordinary private chat but preserves meaningful exceptions',()=>{
 const unknown={...input,senderName:undefined,people:{...people,requester:{...person,name:null}},profile:{...profile,name:null}};
 expect(renderConversationPeople(unknown)).toBe('');
 expect(renderConversationPeople({isGroup:false,senderOpenId:'ou_sender',text:'你好'})).toBe('');
 expect(renderConversationPeople({...unknown,isGroup:true})).toContain('ou_sender');
 expect(renderConversationPeople({...unknown,text:'记录 BUG'})).toContain('ou_sender');
 for(const text of ['我的 OpenID 是什么','查询我的邮箱','查看个人资料'])expect(renderConversationPeople({...unknown,text})).toContain('ou_sender');
 expect(renderConversationPeople({...unknown,guidance:'管理员指定规则'})).toContain('管理员指定规则');
 expect(renderConversationPeople({...unknown,profile:{...unknown.profile,preferences:{role:'研发',detail:'简洁'}}})).toContain('preferences');
 for(const operation of ['view','updated','deleted'])expect(renderConversationPeople({...unknown,profile:{...unknown.profile,profileOperation:operation}})).toContain(operation);
});
