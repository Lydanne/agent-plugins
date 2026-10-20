import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,click,select,deferred} from '../../scripts/control-ui-test.mjs';
const worker={taskTotal:0,conversationTotal:0,counts:{running:0,queued:0,awaiting_main:0,awaiting_user:0,completed:0,failed:0,timed_out:0},tasks:[],projectIds:[]};
const source={state:'available',skills:[],subagents:[]};
const catalog={root:'/fixture/main',projects:[],registrationCommitted:true,agentSkills:source,agentSubagents:source,scheduledTasks:[]};
function fixtureHost(){
 const calls=[],ctx=uiContext(async(method,params)=>{calls.push(params);return {ok:true,result:params.actionId==='projects-maintenance'?{apiVersion:1,providers:[]}:params.actionId==='inspect-agentTasks'?worker:params.actionId==='projects-list'?catalog:params.actionId==='projects-entityTypes'?{types:[],total:0}:params.actionId==='projects-entities'?{entities:[],total:0,nextOffset:null}:params.actionId==='projects-diagnosticSources'?{sources:[]}:params.actionId==='projects-diagnosticHistory'?{agentId:params.agentId,rows:[]}:params.actionId==='projects-repositoryLogs'?{agentId:params.agentId,records:[]}:{people:[],total:0,nextOffset:null}};});
 ctx.host.agents.rows=[{id:'main',name:'Main'},{id:'other',name:'Other'}];ctx.host.agents.select=id=>{ctx.host.agents.selectedId=id;ctx.notify();};ctx.host.sessions.rows=[];return {ctx,calls};
}
test('AgentRepo is a global management center and personnel is only one of its modules',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx,calls}=fixtureHost();ctx.host.sessions.selectedKey='';
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 assert.match(f.container.textContent,/AgentRepo/);assert.match(f.container.textContent,/管理概览/);assert.equal(calls.length,6);
 const nav=f.container.querySelector('[aria-label="AgentRepo 功能模块"]');assert.deepEqual([...nav.querySelectorAll('button')].map(node=>node.textContent),['概览','项目与技能','Worker 任务','实体资料库','定时任务','日志']);
 click(f.container,'打开实体资料库');await settle();assert.ok(f.container.querySelector('[aria-label="AgentRepo 所属 Agent"]'));assert.equal(f.container.querySelector('[aria-label="人员库所属 Agent"]'),null);assert.match(f.container.textContent,/实体资料库/);
 assert.equal(calls.at(-1).sessionKey,'agent:main:agent-repo-entities');
 click(f.container,'项目与技能');await settle();assert.ok(f.container.querySelector('[aria-label="搜索技能或关联 CLI"]'));assert.equal(calls.at(-1).sessionKey,'agent:main:agent-repo-management');
 click(f.container,'定时任务');await settle();assert.match(f.container.textContent,/暂无定时任务/);assert.equal(f.container.querySelector('[aria-label="搜索技能或关联 CLI"]'),null);
 const before=calls.length;click(f.container,'日志');await settle();assert.match(f.container.textContent,/暂无历史记录/);assert.equal(f.container.querySelector('dialog'),null);assert.equal(calls[before].actionId,'projects-diagnosticHistory');assert.equal(calls.length,before+2);assert.equal(calls.at(-1).actionId,'projects-diagnosticSources');
 const refresh=[...f.container.querySelector('.ar-log-inline').querySelectorAll('button')].find(button=>button.textContent==='刷新日志');assert.ok(refresh);refresh.click();await settle();assert.equal(calls.at(-1).actionId,'projects-diagnosticHistory');
 assert.equal(calls.some(call=>call.actionId==='projects-clearRepositoryLogs'),false);
});
test('management center retains its module across Agent switches and discards hidden module responses',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx,calls}=fixtureHost(),pending=deferred();
 ctx.host.request=async(method,params)=>{calls.push(params);return params.actionId==='projects-entities'?pending.promise:{ok:true,result:params.actionId==='projects-maintenance'?{apiVersion:1,providers:[]}:params.actionId==='inspect-agentTasks'?worker:catalog};};
 const view=f.track(f.ui.mountAgentRepo(f.container,ctx));click(f.container,'实体资料库');await settle();
 select(f.window,f.container,'AgentRepo 所属 Agent','other');await settle();assert.equal(calls.at(-1).agentId,'other');assert.equal(calls.at(-1).sessionKey,'agent:other:agent-repo-entities');
 click(f.container,'概览');pending.resolve({ok:true,result:{people:[],total:99,nextOffset:null}});await settle();assert.match(f.container.textContent,/管理概览/);assert.ok(!f.container.textContent.includes('99 位同事'));
 view.update({...ctx,props:{section:'logs'}});await settle();assert.equal(f.container.querySelector('[aria-label="AgentRepo 功能模块"] [aria-current=page]').textContent,'日志');
 ctx.host.connection.canRead=false;ctx.notify();assert.ok(!f.container.querySelector('.ar-log-inline'));assert.match(f.container.textContent,/operator.read/);
});

test('overview shows real scoped counts, partial failures and safe read-only refresh',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx,calls}=fixtureHost();let fail=true;
 ctx.host.request=async(method,params)=>{calls.push(params);assert.equal(method,'plugins.sessionAction');assert.equal(params.agentId,'main');assert.equal(params.sessionKey,'agent:main:agent-repo-management');assert.deepEqual(params.payload,{});
  if(params.actionId==='inspect-agentTasks')return {ok:true,result:worker};
  if(params.actionId==='projects-list')return {ok:true,result:{...catalog,projects:[{projectId:'one'}],scheduledTasks:[{enabled:true}],agentSkills:{...source,skills:[{}]}}};
  if(params.actionId==='projects-entityTypes')return {ok:true,result:{types:[],total:7}};
  if(params.actionId==='projects-people')return {ok:true,result:{total:7,stats:{missing:{email:2},giteaSources:{email_prefix:1}}}};
  if(fail)throw Error('日志服务不可用');return {ok:true,result:{records:[]}};
 };
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 assert.deepEqual([...f.container.querySelectorAll('.ar-metric strong')].map(node=>node.textContent),['1','7','1','不可读取']);
 assert.match(f.container.textContent,/部分数据不可用/);assert.match(f.container.textContent,/日志读取失败/);assert.match(f.container.textContent,/2 位人员缺少邮箱/);assert.match(f.container.textContent,/1 个账号关联待核验/);
 fail=false;click(f.container,'刷新概览');await settle();assert.equal(f.container.querySelectorAll('.ar-metric strong')[3].textContent,'0');assert.ok(!f.container.textContent.includes('日志读取失败'));
 assert.ok(calls.every(call=>['projects-list','projects-entityTypes','projects-people','projects-repositoryLogs','inspect-agentTasks','projects-maintenance'].includes(call.actionId)));
});
test('overview never publishes stale Agent results after switching Agent or losing read access',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx}=fixtureHost(),pending=deferred();
 ctx.host.request=async(method,params)=>params.agentId==='main'?pending.promise:{ok:true,result:params.actionId==='projects-maintenance'?{apiVersion:1,providers:[]}:params.actionId==='inspect-agentTasks'?worker:params.actionId==='projects-list'?catalog:params.actionId==='projects-entityTypes'?{types:[],total:3}:params.actionId==='projects-people'?{total:3,stats:{}}:{records:[]}};
 f.track(f.ui.mountAgentRepo(f.container,ctx));assert.equal(f.container.querySelector('.ar-overview').getAttribute('aria-busy'),'true');
 assert.deepEqual([...f.container.querySelectorAll('.ar-metric strong')].map(node=>node.textContent),['—','—','—','—']);
 select(f.window,f.container,'AgentRepo 所属 Agent','other');await settle();assert.equal(f.container.querySelectorAll('.ar-metric strong')[1].textContent,'3');
 pending.resolve({ok:true,result:{total:999,stats:{}}});await settle();assert.ok(!f.container.textContent.includes('999'));
 ctx.host.connection.canRead=false;ctx.notify();assert.equal(f.container.querySelector('.ar-overview'),null);assert.match(f.container.textContent,/operator.read/);
});

test('module switches retain the management shell, navigation focus and consistent section headings',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx,calls}=fixtureHost();
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 const header=f.container.querySelector('.ar-management-header'),nav=f.container.querySelector('.ar-management-nav'),region=f.container.querySelector('.ar-management-body');
 for(const [label,title] of [['项目与技能','项目与技能'],['Worker 任务','Worker 任务'],['实体资料库','实体资料库'],['定时任务','定时任务'],['日志','日志'],['概览','管理概览']]){
  const control=[...nav.querySelectorAll('button')].find(button=>button.textContent===label);control.focus();control.click();await settle();
  assert.equal(f.container.querySelector('.ar-management-header'),header);assert.equal(f.container.querySelector('.ar-management-nav'),nav);assert.equal(f.container.querySelector('.ar-management-body'),region);
  assert.equal(f.window.document.activeElement,control);assert.equal(control.getAttribute('aria-current'),'page');assert.equal(control.getAttribute('aria-controls'),region.id);
  assert.equal(region.getAttribute('aria-label'),label+'内容');assert.equal(region.querySelector('.ar-section-heading h2').textContent,title);
  assert.equal(region.querySelectorAll('.ar-section-heading').length,1);
  const before=calls.length;control.click();await settle();assert.equal(calls.length,before,'selecting the active module must not reload data');
 }
});
