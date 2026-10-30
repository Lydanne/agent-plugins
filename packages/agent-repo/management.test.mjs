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
 const nav=f.container.querySelector('[aria-label="AgentRepo 功能模块"]');assert.deepEqual([...nav.querySelectorAll('button')].map(node=>node.textContent),['概览','项目与技能','Worker 任务','实体资料库','定时任务','审计','日志']);
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
 ctx.host.connection.canRead=false;ctx.notify();await settle();assert.ok(!f.container.querySelector('.ar-log-inline'));assert.match(f.container.textContent,/operator.read/);
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
 ctx.host.connection.canRead=false;ctx.notify();await settle();assert.equal(f.container.querySelector('.ar-overview'),null);assert.match(f.container.textContent,/operator.read/);
});

test('module switches retain the management shell, navigation focus and consistent section headings',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx,calls}=fixtureHost();
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 const header=f.container.querySelector('.ar-management-header'),nav=f.container.querySelector('.ar-management-nav'),region=f.container.querySelector('.ar-management-body');
 for(const [label,title] of [['项目与技能','项目与技能'],['Worker 任务','Worker 任务'],['实体资料库','实体资料库'],['定时任务','定时任务'],['审计','审计'],['日志','日志'],['概览','管理概览']]){
  const control=[...nav.querySelectorAll('button')].find(button=>button.textContent===label);control.focus();control.click();await settle();
  assert.equal(f.container.querySelector('.ar-management-header'),header);assert.equal(f.container.querySelector('.ar-management-nav'),nav);assert.equal(f.container.querySelector('.ar-management-body'),region);
  assert.equal(f.window.document.activeElement,control);assert.equal(control.getAttribute('aria-current'),'page');assert.equal(control.getAttribute('aria-controls'),region.id);
  assert.equal(region.getAttribute('aria-label'),label+'内容');assert.equal(region.querySelector('.ar-section-heading h2').textContent,title);
  assert.equal(region.querySelectorAll('.ar-section-heading').length,1);
  const before=calls.length;control.click();await settle();assert.equal(calls.length,before,'selecting the active module must not reload data');
 }
});

test('task cards open the selected schedule and retain history navigation',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx,calls}=fixtureHost();
 const plan={id:'group-plan',name:'群整理',status:'enabled',sourceValid:true,chatId:'test-group',requester:'测试请求人',projectId:'demo',task:'Summarize',constraints:'Read only',schedule:{kind:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'}};
 ctx.props.section='tasks';ctx.host.connection.canWrite=true;ctx.host.sessions.rows=[{key:'agent:other:feishu:group:test-group',label:'错误群名'},{key:'agent:main:feishu:group:test-group',displayName:'测试群'}];
 ctx.host.request=async(method,p)=>{calls.push(p);return {ok:true,result:p.actionId==='projects-scheduleCatalog'?{available:true,tasks:[{...plan,id:'other',name:'Other'},plan],operations:[]}:p.actionId==='projects-list'?{...catalog,scheduledTasks:[{...plan,taskId:'scheduled-request:group-plan',type:'scheduled-request',enabled:true,nativeAvailable:true,scope:{label:'Test group'},records:[]}]}:{}};};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 assert.equal(f.container.querySelectorAll('h2').length,1);
 assert.equal(f.container.querySelectorAll('.ar-task-card').length,1);const card=f.container.querySelector('.ar-task-card');assert.match(card.textContent,/来源群：测试群/);assert.match(card.textContent,/原请求人：测试请求人/);assert.ok(!card.textContent.includes('test-group'));assert.ok(!card.textContent.includes('错误群名'));
 assert.match(f.container.querySelector('.ar-scheduled-task').textContent,/每天 09:00/);
 f.container.querySelector('[aria-label="编辑群整理"]').click();await settle();
 assert.equal(f.container.querySelector('[aria-label="任务名称"]').value,'群整理');assert.match(f.container.querySelector('details').textContent,/群 ID：test-group/);
 assert.equal(calls.some(c=>c.actionId==='projects-scheduleManage'),false);
 click(f.container,'关闭');ctx.host.sessions.rows=[{key:'agent:other:feishu:group:test-group',label:'错误群名'}];ctx.notify();await settle();click(f.container,'刷新任务');await settle();
 assert.match(f.container.querySelector('.ar-task-card').textContent,/群名称未获取/);assert.ok(!f.container.querySelector('.ar-task-card').textContent.includes('错误群名'));
});

test('task cards expose confirmed stop, start and delete actions for the selected plan',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx,calls}=fixtureHost();
 const plans=[{id:'a',name:'Active',status:'enabled',enabled:true},{id:'b',name:'Paused',status:'paused',enabled:false}].map(p=>({...p,revision:'v1',sourceValid:true,chatId:'group',requester:'User',projectId:'demo',task:'Summarize',constraints:'Read only',schedule:{kind:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'}}));
 ctx.props.section='tasks';ctx.host.connection.canWrite=true;
 ctx.host.request=async(method,p)=>{calls.push(p);return {ok:true,result:p.actionId==='projects-scheduleCatalog'?{available:true,tasks:plans,operations:[]}:p.actionId==='projects-scheduleManage'?{status:'succeeded',id:p.payload.id}:p.actionId==='projects-list'?{...catalog,scheduledTasks:plans.map(t=>({...t,taskId:'scheduled-request:'+t.id,type:'scheduled-request',readOnly:true,nativeAvailable:true,scope:{label:'Group'},records:[]}))}:{}};};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();
 for(const [label,id,action] of [['停止Active','a','pause'],['开始Paused','b','resume'],['删除Paused','b','remove']]){
  f.container.querySelector(`[aria-label="${label}"]`).click();await settle();
  assert.match(f.container.querySelector('dialog').textContent,/确认/);
  const before=calls.filter(c=>c.actionId==='projects-scheduleManage').length;
  click(f.container,'确认执行');await settle();
  const writes=calls.filter(c=>c.actionId==='projects-scheduleManage');assert.equal(writes.length,before+1);
  assert.equal(writes.at(-1).payload.id,id);assert.equal(writes.at(-1).payload.action,action);assert.equal(writes.at(-1).agentId,'main');
  click(f.container,'关闭');
 }
 f.container.querySelector('[aria-label="查看Paused"]').click();await settle();click(f.container,'管理此任务');await settle();
 assert.equal(f.container.querySelectorAll('dialog').length,1);assert.equal(f.container.querySelector('[aria-label="任务名称"]').value,'Paused');
 click(f.container,'关闭');ctx.host.connection.canWrite=false;ctx.notify();await settle();
 for(const label of ['停止Active','开始Paused','删除Paused'])assert.equal(f.container.querySelector(`[aria-label="${label}"]`).disabled,true);
});

test('global and per-plan audit share a filtered read-only view and discard stale Agent responses',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),{ctx,calls}=fixtureHost(),pending=deferred();let hold=false;
 const plan={taskId:'scheduled-request:plan',name:'日报',type:'scheduled-request',status:'enabled',enabled:true,nativeAvailable:true,scope:{label:'群'},records:[],schedule:{kind:'cron',expr:'0 7 * * *',tz:'Asia/Shanghai'}};
 ctx.host.request=async(method,p)=>{calls.push(p);if(p.actionId==='projects-audit'){if(hold&&p.agentId==='main')return pending.promise;return {ok:true,result:{agentId:p.agentId,total:1,nextOffset:null,records:[{id:'audit-1',at:1000,targetId:'plan',targetName:'日报',action:'update',status:'succeeded',actor:{kind:'human',id:'ou_123',name:'张三',messageIds:['om_change']},executor:'agent_schedule',changes:[{field:'deliveryMode',before:'source',after:'group'}]}]}};}return {ok:true,result:p.actionId==='projects-list'?{...catalog,scheduledTasks:[plan]}:p.actionId==='projects-maintenance'?{providers:[]}:p.actionId==='inspect-agentTasks'?worker:{records:[]}};};
 f.track(f.ui.mountAgentRepo(f.container,ctx));await settle();click(f.container,'审计');await settle();assert.equal(calls.at(-1).actionId,'projects-audit');assert.deepEqual(calls.at(-1).payload,{limit:25,offset:0});assert.match(f.container.textContent,/张三/);assert.match(f.container.textContent,/om_change/);assert.match(f.container.textContent,/群主会话/);
 click(f.container,'定时任务');await settle();f.container.querySelector('[aria-label="查看日报"]').click();click(f.container,'修改日志');await settle();assert.deepEqual(calls.at(-1).payload,{feature:'schedules',targetId:'plan',limit:25,offset:0});assert.equal(f.container.querySelector('[aria-label="对象 ID"]').disabled,true);assert.equal(f.container.querySelector('[aria-label="功能"]').disabled,true);assert.equal(calls.some(c=>c.actionId==='projects-scheduleManage'),false);
 click(f.container,'关闭');hold=true;click(f.container,'审计');await settle();select(f.window,f.container,'AgentRepo 所属 Agent','other');await settle();pending.resolve({ok:true,result:{records:[{targetName:'STALE_SECRET'}],total:1,nextOffset:null}});await settle();assert.ok(!f.container.textContent.includes('STALE_SECRET'));assert.equal(calls.at(-1).agentId,'other');
 ctx.host.connection.canRead=false;ctx.notify();await settle();assert.equal(f.container.querySelector('.ar-audit'),null);
});
