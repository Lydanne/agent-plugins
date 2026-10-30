import {describe,it,expect,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import SourceView from './SourceView.vue';
import MessageText from './MessageText.vue';
import ToolCalls from './ToolCalls.vue';
import ProcessTimeline from './ProcessTimeline.vue';
import ConversationRecord from './ConversationRecord.vue';
import type {TaskRecord} from './models';
const redact=(value:string)=>value;
const task:TaskRecord={jobId:'fixture-job',status:'running',createdAt:1000,request:{availability:'available'},events:[]};
describe('Worker Vue record components',()=>{
 it('keeps raw JSON lazy, lossless and safely escaped, with clipboard failure feedback',async()=>{
  const payload={openId:'ou_complete',url:'https://example.test/_cos/full/key?signature=a%2Fb&expires=123',text:'<img src=x onerror=alert(1)>'};
  const wrapper=mount(SourceView,{props:{title:'原始 JSON',value:payload,redact}});
  expect(wrapper.findAll('.cq-source-line')).toHaveLength(0);
  (wrapper.element as HTMLDetailsElement).open=true;await wrapper.trigger('toggle');
  expect(wrapper.get('pre').text()).toContain(payload.url);expect(wrapper.get('pre').text()).toContain(payload.openId);expect(wrapper.find('img').exists()).toBe(false);
  await wrapper.get('button').trigger('click');expect(wrapper.get('pre').classes()).toContain('cq-nowrap');
  Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockRejectedValue(Error('denied'))}});
  await wrapper.findAll('button')[1]!.trigger('click');await Promise.resolve();expect(wrapper.get('[role=status]').text()).toBe('复制失败，请选择文本复制');wrapper.unmount();
 });
 it('renders rich message text and fenced code without executing HTML',()=>{
  const wrapper=mount(MessageText,{props:{text:'**重点** 与 `变量`\n\n<img src=x>\n\n```json\n{"id":"完整标识"}\n```'}});
  expect(wrapper.get('strong').text()).toBe('重点');expect(wrapper.find('img').exists()).toBe(false);expect(wrapper.text()).toContain('<img src=x>');expect(wrapper.findComponent(SourceView).props('value')).toBe('{"id":"完整标识"}');wrapper.unmount();
 });
 it('retains observed tool duration and full URLs while excluding credential-bearing links',()=>{
  const events=[{event:'item.started',time:2000,item:{id:'tool',type:'command_execution',command:'cat skills/SKILL.md'}},{event:'item.completed',time:5000,item:{id:'tool',type:'command_execution',command:'cat skills/SKILL.md',exit_code:7,result:{url:'https://example.test/_cos/key?signature=a%2Fb&expires=123',private:'https://user:password@example.test/private'}}}];
  const wrapper=mount(ToolCalls,{props:{events,task,redact,now:9000}});
  expect(wrapper.get('.cq-call-elapsed').text()).toBe('3s');expect(wrapper.get('.cq-call-name').text()).toContain('执行失败');expect(wrapper.text()).toContain('不证明技能被完整读取或遵循');
  const links=wrapper.findAll('a');expect(links).toHaveLength(1);expect(links[0]!.attributes('href')).toBe('https://example.test/_cos/key?signature=a%2Fb&expires=123');wrapper.unmount();
 });
 it('preserves question, user waiting and answer provenance in timeline order',()=>{
  const record:TaskRecord={...task,status:'completed',startedAt:2000,finishedAt:7000,questions:[{createdAt:3000,waitingForUserAt:4000,answeredAt:5000,question:'请选择范围',answer:'已确认',answerSource:'user_card',answerBasis:'原消息',answerValues:{scope:'本群'},fields:[{id:'scope',label:'查询范围'}]}]};
  const wrapper=mount(ProcessTimeline,{props:{record,redact,now:9000}});
  expect(wrapper.findAll('.cq-stage strong').map(row=>row.text())).toEqual(['任务受理','Worker 开始执行','Worker · 请求上下文','Main · 等待用户补充','用户 · 卡片选择','已完成']);expect(wrapper.text()).toContain('依据：原消息');expect(wrapper.text()).toContain('查询范围');wrapper.unmount();
 });
});

it('keeps expanded timeline tools and focused nodes when earlier events arrive',async()=>{
 const event=(id:string,at:number)=>({event:'item.completed',time:at,item:{id,type:'command_execution',command:id,status:'completed',exit_code:0}});
 const a=event('A',4000),b=event('B',5000),wrapper=mount(ProcessTimeline,{attachTo:document.body,props:{record:{...task,events:[a,b]},redact,now:9000}});
 const original=wrapper.findAll('.cq-calls>details')[0]!.element as HTMLDetailsElement;original.open=true;const summary=original.querySelector('summary')!;summary.tabIndex=0;summary.focus();
 await wrapper.setProps({record:{...task,events:[event('X',3000),a,b]}});
 const retained=wrapper.findAll('.cq-calls>details').find(node=>node.text().includes('工具命令 · A'))!.element;
 expect(retained).toBe(original);expect(original.open).toBe(true);expect(document.activeElement).toBe(summary);wrapper.unmount();
});

it('keeps an expanded message code reader when an earlier reply arrives',async()=>{
 const event=(id:string,at:number,text:string)=>({event:'item.completed',time:at,item:{id,type:'agent_message',text}});
 const a=event('A',4000,'```json\n{"complete":"value"}\n```'),b=event('B',5000,'Later reply');
 const record={...task,questions:[{id:'question',createdAt:2000,question:'Original question'}],events:[a,b]};
 const wrapper=mount(ConversationRecord,{props:{record,view:'records',filter:'all',redact,now:9000}});
 const reader=wrapper.findAllComponents(SourceView)[0]!;const original=reader.element as HTMLDetailsElement;original.open=true;await reader.trigger('toggle');expect(reader.findAll('.cq-source-line')).toHaveLength(1);
 await wrapper.setProps({record:{...record,events:[event('X',3000,'Earlier reply'),a,b]}});
 const retained=wrapper.findAllComponents(SourceView)[0]!;expect(retained.element).toBe(original);expect(original.open).toBe(true);expect(retained.findAll('.cq-source-line')).toHaveLength(1);wrapper.unmount();
});
