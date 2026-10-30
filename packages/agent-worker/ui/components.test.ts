import {describe,it,expect,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import SourceView from './SourceView.vue';
import MessageText from './MessageText.vue';
import ToolCalls from './ToolCalls.vue';
import ProcessTimeline from './ProcessTimeline.vue';
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
