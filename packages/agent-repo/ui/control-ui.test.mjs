import {test,onTestFinished} from 'vitest';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {browserFixture,settle,uiContext,click as simpleClick,deferred} from '../../../scripts/control-ui-test.mjs';
import {repositorySyncTasks} from '../scheduled-tasks.mjs';
import {registerWorkerNavigation} from '../dist/ui-navigation.mjs';

async function click(container,label){
 let button=Array.from(container.querySelectorAll('button')).find(n=>n.textContent===label);
 if(!button)button=Array.from(container.ownerDocument.body.querySelectorAll('[aria-label="日志更多操作"] button')).find(n=>n.textContent===label);
 if(!button){const trigger=Array.from(container.querySelectorAll('button')).find(n=>n.textContent==='更多操作');if(trigger){trigger.click();await settle();button=Array.from(container.ownerDocument.body.querySelectorAll('button')).find(n=>n.textContent===label);}}
 assert.ok(button,'Missing button: '+label);button.click();await settle();
}
async function openMore(container){await click(container,'更多操作');}
const skill={name:'demo-cli',description:'Demo CLI',path:'skills/demo-cli/SKILL.md',status:'candidate',appliesWhen:'Current Agent',updatedAt:'2026-10-12T00:00:00Z'};
const source={source:'agent',state:'available',skills:[skill,{...skill,name:'other',path:'skills/other/SKILL.md'}]};
function catalog(agentId){return {agentId,root:'/fixture/ada-agent',registrationCommitted:true,agentSkills:source,projects:[{projectId:'demo',name:'Demo',repository:'projects/demo'}]};}
function detail(agentId){return {agentId,name:'Demo',projectId:'demo',cwd:'fixture/projects/demo',repository:'projects/demo',scopes:[{repository:'projects/demo',label:'项目根'}],sources:[source],effectiveSkillCount:2,inspection:{git:{state:'ready'}},scannedAt:123};}
test('plugin exposes AgentRepo as the sole left navigation and keeps personnel deep links',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),panels=[],pages=[],navigation=[],released=[];
 const dispose=f.ui.default.activate({ui:{
  registerPanel:definition=>{panels.push(definition);return ()=>released.push('panel');},
  registerPage:definition=>{pages.push(definition);return ()=>released.push('page');},
  registerNavigation:definition=>{navigation.push(definition);return ()=>released.push('navigation');},
 }});
 assert.equal(panels[0].id,'projects');assert.equal(pages[0].id,'people');assert.equal(pages[0].mount,f.ui.mountPeoplePage);
 assert.equal(pages.find(page=>page.id==='management').mount,f.ui.mountAgentRepo);
 assert.equal(navigation.length,1);assert.deepEqual(navigation[0].page,{id:'management'});assert.equal(navigation[0].defaultVisible,true);assert.equal(navigation[0].label,'AgentRepo');
 dispose();assert.deepEqual(released,['navigation','page','page','page','panel']);
});

function contractHost(){
 const requests=[];
 return {requests,request:async(method,params)=>{
  assert.equal(method,'plugins.sessionAction');requests.push(params);
  if(!params.sessionKey)return {ok:false,error:'Missing trusted Agent'};
  const owner=params.sessionKey.split(':')[1];
  if(!['main','other'].includes(owner)||owner!==params.agentId)throw Error('Unknown or mismatched Agent');
  return {ok:true,result:params.actionId==='projects-maintenance'?{apiVersion:1,providers:[],observedAt:'2026-10-20T00:00:00Z'}:params.actionId==='projects-detail'?detail(owner):catalog(owner)};
 }};
}
test('Agent catalog resolves host identity without selecting or creating a matching conversation',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),wire=contractHost(),ctx=uiContext(wire.request),opened=[];
 ctx.host.agents.selectedId='other';const oldSession=ctx.host.sessions.selectedKey;
 const stop=registerWorkerNavigation(target=>opened.push(target));onTestFinished(stop);
 const view=f.track(f.ui.mountProjects(f.container,ctx));await settle();
 assert.match(f.container.textContent,/当前 Agent · other/);assert.match(f.container.textContent,/demo-cli/);assert.ok(!f.container.querySelector('.ar-error'));
 assert.ok(wire.requests.every(request=>request.agentId==='other'&&['agent:other:agent-repo-catalog','agent:other:agent-repo-management'].includes(request.sessionKey)));
 const jump=()=>[...f.container.querySelectorAll('button')].find(button=>button.textContent==='查看 Worker 项目任务 ↗');
 assert.equal(jump(),undefined);await click(f.container,'Demo');await settle();
 assert.equal(jump().disabled,true);assert.equal(ctx.host.sessions.selectedKey,oldSession);assert.deepEqual(opened,[]);
 assert.equal((await wire.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-list',agentId:'other',payload:{}})).ok,false);
 await assert.rejects(wire.request('plugins.sessionAction',{actionId:'projects-list',agentId:'other',sessionKey:'agent:main:test'}));
 ctx.host.sessions.selectedKey='agent:other:real';ctx.notify();await settle();await click(f.container,'Demo');await settle();assert.equal(jump().disabled,false);jump().click();assert.deepEqual(opened,[{agentId:'other',sessionKey:'agent:other:real',projectId:'demo'}]);
 ctx.host.agents.selectedId='missing';ctx.notify();await settle();assert.ok(f.container.querySelector('.ar-error'));assert.ok(!f.container.textContent.includes('demo-cli'));view.dispose();
});
test('search survives host notifications and rerenders with input node, focus and caret intact',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),wire=contractHost(),ctx=uiContext(wire.request);
 f.track(f.ui.mountProjects(f.container,ctx));await settle();
 await click(f.container,'demo-cli');await settle();
 const search=f.container.querySelector('[aria-label="搜索技能或关联 CLI"]');search.focus();search.value='demo-cli';search.setSelectionRange(2,5);search.dispatchEvent(new f.window.Event('input'));await settle();
 assert.equal(f.container.querySelectorAll('.ar-maintenance-table tbody tr').length,1);assert.match(f.container.querySelector('aside').textContent,/Demo CLI/);const before=wire.requests.length;ctx.notify();await settle();
 assert.equal(wire.requests.length,before);assert.equal(search.value,'demo-cli');assert.ok(f.window.document.activeElement===search,'search retains focus');assert.deepEqual([search.selectionStart,search.selectionEnd],[2,5]);
 await click(f.container,'刷新扫描');await settle();assert.ok(f.container.querySelector('[aria-label="搜索技能或关联 CLI"]')===search,'search node is retained');assert.ok(f.window.document.activeElement===search,'search retains focus');assert.deepEqual([search.selectionStart,search.selectionEnd],[2,5]);assert.equal(search.value,'demo-cli');
 // Navigation availability notifications also rebuild the view, without losing editing state.
 const stop=registerWorkerNavigation(()=>{});stop();await settle();assert.ok(f.window.document.activeElement===search,'search retains focus');assert.deepEqual([search.selectionStart,search.selectionEnd],[2,5]);
 ctx.host.connection.canRead=false;ctx.notify();await settle();assert.ok(!f.container.textContent.includes('demo-cli'));ctx.host.connection.canRead=true;ctx.notify();await settle();assert.equal(f.container.querySelector('[aria-label="搜索技能或关联 CLI"]').value,'');assert.equal(f.container.querySelectorAll('.ar-maintenance-table tbody tr').length,2);
});

test('first fixed tab defaults to role skills only; project tabs load only their selected scope',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),requests=[];
 const projectSource={source:'project',state:'available',skills:[{...skill,name:'project-only',path:'projects/demo/.agents/skills/project-only/SKILL.md'}]};
 const ctx=uiContext(async(_method,p)=>{requests.push(p);return {ok:true,result:p.actionId==='projects-list'?{...catalog('main'),projects:[...catalog('main').projects,{projectId:'b',name:'Second',repository:'projects/b'}]}:{...detail('main'),projectId:p.payload.projectId,repository:p.payload.repository??'projects/demo',scopes:[{repository:'projects/demo',label:'项目根'},{repository:'projects/demo/repositories/frontend',label:'frontend'}],sources:[{...projectSource,skills:projectSource.skills.map(s=>({...s,name:p.payload.projectId+'-only'}))},...(p.payload.repository?.endsWith('/frontend')?[{source:'repository',state:'available',skills:[{...skill,name:'child-only',path:'projects/demo/repositories/frontend/.agents/skills/child-only/SKILL.md'}]}]:[]),source]}};});
 f.track(f.ui.mountProjects(f.container,ctx));await settle();
 const tabs=()=>[...f.container.querySelectorAll('[role=tab]')];
 assert.deepEqual(tabs().map(tab=>tab.textContent),['Agent Repo','Demo','Second']);assert.equal(tabs()[0].getAttribute('aria-selected'),'true');assert.ok(tabs()[0].tabIndex===0||f.container.querySelector('[role=tablist]').tabIndex===0,'tabs are keyboard reachable');
 assert.deepEqual([...f.container.querySelectorAll('h3')].map(heading=>heading.textContent),['子代理0']);assert.ok(!/角色技能|仓库技能|项目根技能/.test(f.container.textContent));assert.equal(requests.filter(p=>p.actionId==='projects-detail').length,0);assert.ok(!f.container.querySelector('[aria-label="当前仓库范围"]'));
 assert.ok(f.container.querySelector('.ar-panel').contains(f.container.querySelector('[role=tablist]')));assert.ok(!f.container.querySelector('.ar-scroll').contains(tabs()[0]));
 await click(f.container,'Demo');await settle();assert.match(f.container.textContent,/demo-only/);assert.ok(!f.container.querySelector('[data-skill-path="skills/demo-cli/SKILL.md"]'));assert.match(f.container.textContent,/继承 2 个技能/);assert.ok(!f.container.textContent.includes('b-only'));assert.ok(f.container.querySelector('[aria-label="当前仓库范围"]'));
 const scope=f.container.querySelector('[aria-label="当前仓库范围"]');scope.value='projects/demo/repositories/frontend';scope.dispatchEvent(new f.window.Event('change'));await settle();assert.deepEqual([...f.container.querySelectorAll('h3')].map(heading=>heading.textContent),['子代理0']);assert.match(f.container.textContent,/child-only/);assert.equal(f.container.querySelectorAll('.ar-maintenance-table tbody tr').length,2);assert.ok(f.container.querySelector('[data-item-key="repo:projects/demo/repositories/frontend/.agents/skills/child-only/SKILL.md"]'));
 f.container.querySelector('.ar-scroll').scrollTop=170;await click(f.container,'Second');await settle();assert.equal(f.container.querySelector('.ar-scroll').scrollTop,0);assert.match(f.container.textContent,/b-only/);assert.ok(!f.container.textContent.includes('demo-only'));
 await click(f.container,'Agent Repo');await settle();assert.ok(!f.container.textContent.includes('b-only'));assert.ok(!f.container.querySelector('[aria-label="当前仓库范围"]'));assert.ok(!f.container.textContent.includes('查看 Worker 项目任务'));
 const panel=f.container.querySelector('[role=tabpanel]');assert.equal(panel.getAttribute('aria-labelledby'),tabs()[0].id);assert.equal(tabs()[0].getAttribute('aria-controls'),panel.id);
 tabs()[0].focus();tabs()[0].dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await settle();assert.ok(f.window.document.activeElement===tabs()[1],'arrow reaches next tab');assert.equal(tabs()[0].getAttribute('aria-selected'),'true');
 tabs()[1].click();await settle();assert.equal(f.window.document.activeElement.dataset.tabKey,'demo');assert.equal(tabs()[1].getAttribute('aria-selected'),'true');
});
test('returning to role tab invalidates pending project results and permits recovery from project errors',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),late=deferred();let fail=false;
 const ctx=uiContext(async(_method,p)=>p.actionId==='projects-maintenance'?{ok:true,result:{apiVersion:1,providers:[]}}:p.actionId==='projects-list'?{ok:true,result:catalog('main')}:fail?{ok:false,error:'Project unavailable'}:late.promise);
 f.track(f.ui.mountProjects(f.container,ctx));await settle();await click(f.container,'Demo');await settle();assert.ok(!f.container.querySelector('.ar-skill'));assert.match(f.container.textContent,/正在读取当前项目内容/);
 await click(f.container,'Agent Repo');await settle();late.resolve({ok:true,result:detail('main')});await settle();assert.equal(f.container.querySelector('[role=tab][aria-selected=true]').textContent,'Agent Repo');assert.ok(!f.container.querySelector('[aria-label="当前仓库范围"]'));
 fail=true;await click(f.container,'Demo');await settle();assert.match(f.container.textContent,/Project unavailable/);assert.equal(f.container.querySelectorAll('.ar-maintenance-table tbody tr').length,0);
 await click(f.container,'Agent Repo');await settle();assert.ok(!f.container.querySelector('.ar-error'));assert.equal(f.container.querySelectorAll('.ar-maintenance-table tbody tr').length,2);
});
test('role tab remains usable without projects and with empty or unavailable role skills',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs'));
 const ctx=uiContext(async()=>({ok:true,result:{...catalog('main'),projects:[],agentSkills:{...source,skills:[],state:'unavailable',warning:'Fixture unavailable'}}}));
 f.track(f.ui.mountProjects(f.container,ctx));await settle();assert.deepEqual([...f.container.querySelectorAll('[role=tab]')].map(tab=>tab.textContent),['Agent Repo']);assert.match(f.container.textContent,/尚未登记项目/);assert.match(f.container.textContent,/此范围暂不可扫描/);assert.match(f.container.textContent,/Fixture unavailable/);
});

test('subagents follow tabs and scopes, share search, and render metadata as text without claiming activation',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),subagent={name:'review',provider:'codex',description:'<script>unsafe</script>',path:'.codex/agents/review.toml',model:'fixture-model',reasoningEffort:'high',updatedAt:'2026-10-13T00:00:00Z',status:'candidate',appliesWhen:'Scope only'},shared={source:'agent',state:'available',subagents:[subagent],warnings:[]};
 const ctx=uiContext(async(_method,p)=>({ok:true,result:p.actionId==='projects-list'?{...catalog('main'),agentSubagents:shared}:{...detail('main'),repository:p.payload.repository??'projects/demo',scopes:[{repository:'projects/demo',label:'项目根'},{repository:'projects/demo/repositories/frontend',label:'frontend'}],candidateSubagentCount:2,subagentSources:[shared,{source:'project',state:'available',warnings:[],subagents:[{...subagent,name:p.payload.repository?.endsWith('/frontend')?'child-review':'project-review',path:'projects/demo/.agents/agents/review.md',provider:'agents'}]}]}}));
 f.track(f.ui.mountProjects(f.container,ctx));await settle();assert.match(f.container.textContent,/子代理1/);assert.match(f.container.textContent,/fixture-model/);assert.ok(f.container.querySelector('.ar-subagent script')===null);assert.match(f.container.textContent,/实际注册、继承与调用/);
 const row=f.container.querySelector('.ar-subagent');row.open=true;const input=f.container.querySelector('input');input.value='review';input.dispatchEvent(new f.window.Event('input'));await settle();assert.equal(f.container.querySelectorAll('.ar-subagent').length,1);assert.equal(f.container.querySelectorAll('.ar-skill:not(.ar-subagent)').length,0);ctx.notify();assert.equal(f.container.querySelector('.ar-subagent').open,true);
 await click(f.container,'Demo');await settle();assert.equal(f.container.querySelectorAll('.ar-subagent').length,1);assert.match(f.container.textContent,/project-review/);assert.match(f.container.textContent,/共享 1 个/);assert.ok(!f.container.querySelector('[data-skill-path="subagent:codex:review:.codex/agents/review.toml"]'));
 const scope=f.container.querySelector('select');scope.value='projects/demo/repositories/frontend';scope.dispatchEvent(new f.window.Event('change'));await settle();assert.match(f.container.textContent,/child-review/);assert.ok(!f.container.textContent.includes('project-review'));
 await click(f.container,'Agent Repo');await settle();assert.ok(!f.container.textContent.includes('child-review'));assert.equal(f.container.querySelectorAll('.ar-subagent').length,1);
});

function taskCatalog(agentId,history={}){
 const schedule=history.schedule??{time:'08:00',timeZone:'Asia/Shanghai'};
 return {...catalog(agentId),scheduledTasks:repositorySyncTasks({sync:{enabled:history.enabled!==false,submoduleSchedule:schedule}},agentId,{records:history.records??[],hasMore:history.hasMore??false},{demo:{}},Date.parse('2026-10-14T02:00:00Z'))};
}
function recordResult(params,record={}){return {taskId:params.payload.taskId,runId:params.payload.runId,...record};}
async function openTask(f){f.container.querySelector('.ar-scheduled-task').click();await settle();}
async function openRun(f,index=0){f.container.querySelectorAll('.ar-sync-record')[index].click();await settle();}

test('task directory precedes records, separates enabled state from failed results, and clears late responses across Agents',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),late=deferred(),requests=[];
 const record={date:'2026-10-14',status:'failed',startedAt:'2026-10-14T00:00:00Z',finishedAt:'2026-10-14T00:00:02Z',failures:[{projectId:'demo',reason:'frontend 有本地改动'}]};
 const ctx=uiContext(async(_method,p)=>{requests.push(p);if(p.actionId==='projects-taskRecord')return late.promise;return {ok:true,result:p.actionId==='projects-list'?taskCatalog(p.agentId,{records:p.agentId==='main'?[record]:[]}):detail(p.agentId)};});
 f.track(f.ui.mountProjects(f.container,ctx));await settle();
 assert.match(f.container.textContent,/定时任务/);assert.match(f.container.textContent,/每日仓库同步/);assert.match(f.container.textContent,/已启用/);assert.match(f.container.textContent,/失败/);assert.ok(f.container.querySelector('.ar-sync-record')===null);
 await openTask(f);assert.equal(f.container.querySelectorAll('[role=dialog]').length,1);assert.match(f.container.querySelector('[role=dialog]').textContent,/执行记录/);assert.equal(requests.filter(p=>p.actionId==='projects-taskRecord').length,0);
 await openRun(f);assert.equal(requests.filter(p=>p.actionId==='projects-taskRecord').length,1);assert.match(f.container.textContent,/正在读取执行日志/);
 const submitted=requests.find(p=>p.actionId==='projects-taskRecord');assert.deepEqual(submitted.payload,{taskId:'repo-sync:main',runId:'repo-sync:main:2026-10-14'});
 ctx.host.agents.selectedId='other';ctx.notify();await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);assert.ok(!f.container.textContent.includes('frontend 有本地改动'));
 late.resolve({ok:true,result:recordResult(submitted,{logs:[{stage:'OLD-AGENT-LOG',status:'failed'}]})});await settle();assert.ok(!f.container.textContent.includes('OLD-AGENT-LOG'));
});

test('single task dialog navigates records and read-only settings, retries logs, returns to records and restores focus on close',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs'));let fail=true;
 const records=[{date:'2026-10-14',status:'completed',failures:[]},{date:'2026-10-13',status:'failed',reason:'legacy failure',failures:[]}];
 const ctx=uiContext(async(_method,p)=>{
  if(p.actionId==='projects-list')return {ok:true,result:taskCatalog('main',{records,enabled:false})};
  if(p.actionId==='projects-taskRecord')return fail?{ok:false,error:'日志读取失败'}:{ok:true,result:recordResult(p,{logs:p.payload.runId.endsWith('2026-10-13')?[]:[{stage:'拉取',status:'completed',reason:'<script>unsafe</script>'}]})};
  return {ok:true,result:detail('main')};
 });
 f.track(f.ui.mountProjects(f.container,ctx));await settle();assert.match(f.container.textContent,/已暂停/);
 await openTask(f);await click(f.container,'任务设置');await settle();assert.match(f.container.querySelector('[role=dialog]').textContent,/只读展示/);assert.ok(f.container.querySelector('[role=dialog] input')===null);await click(f.container,'执行记录');await settle();
 await openRun(f);assert.match(f.container.textContent,/日志读取失败/);fail=false;await click(f.container,'重试读取日志');await settle();assert.match(f.container.textContent,/<script>unsafe<\/script>/);assert.ok(f.container.querySelector('.ar-sync-log script')===null);assert.equal(f.container.querySelectorAll('[role=dialog]').length,1);
 await click(f.container,'返回执行记录');await settle();assert.ok(f.container.querySelector('.ar-sync-events')===null);assert.ok(f.window.document.activeElement===f.container.querySelector('.ar-sync-record'),'focus returns to run');
 await openRun(f,1);assert.match(f.container.textContent,/旧版记录仅保存最终结果/);
 const modal=f.container.querySelector('[role=dialog]');modal.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);assert.ok(f.window.document.activeElement===f.container.querySelector('.ar-scheduled-task'),'focus returns to task');
 await click(f.container,'Demo');await settle();await openTask(f);assert.equal(f.container.querySelector('[data-run-id="repo-sync:main:2026-10-13"]').title,'legacy failure');
});

test('task dialog closes on backdrop, permission loss, hiding and disposal without reopening for late logs',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),late=deferred(),record={date:'2026-10-14',status:'running',failures:[]};
 const ctx=uiContext(async(_method,p)=>p.actionId==='projects-taskRecord'?late.promise:{ok:true,result:taskCatalog('main',{records:[record]})});
 const view=f.track(f.ui.mountProjects(f.container,ctx));await settle();await openTask(f);await openRun(f);
 const modal=f.container.querySelector('[role=dialog]');modal.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);
 await openTask(f);ctx.host.connection.canRead=false;ctx.notify();await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);
 late.resolve({ok:true,result:{taskId:'repo-sync:main',runId:'repo-sync:main:2026-10-14',logs:[{stage:'PRIVATE-LOG',status:'started'}]}});await settle();assert.ok(!f.container.textContent.includes('PRIVATE-LOG'));
 ctx.host.connection.canRead=true;ctx.notify();await settle();await openTask(f);view.update({...ctx,presented:false});await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);
 view.update({...ctx,presented:true});await settle();await openTask(f);view.dispose();assert.ok(f.container.querySelector('[role=dialog]')===null);
});

test('host refresh reloads the selected run and removes a dialog when its task disappears',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs'));let reads=0,removed=false;
 const ctx=uiContext(async(_method,p)=>({ok:true,result:p.actionId==='projects-taskRecord'?recordResult(p,{logs:[{stage:'检查 '+(++reads),status:'completed'}]}):{...taskCatalog('main',{records:[{date:'2026-10-14',status:'completed',failures:[]}]}),...(removed?{scheduledTasks:[]}:{} )}}));
 const view=f.track(f.ui.mountProjects(f.container,ctx));await settle();await openTask(f);await openRun(f);assert.equal(reads,1);
 view.update(ctx);await settle();assert.ok(f.container.querySelector('[role=dialog]'));assert.equal(reads,2);assert.match(f.container.querySelector('[role=dialog]').textContent,/检查 2/);
 removed=true;view.update(ctx);await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);assert.match(f.container.textContent,/暂无定时任务/);
});

test('task run rejects a mismatched response identity and new tasks show an empty record list',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs'));let records=[];
 const ctx=uiContext(async(_method,p)=>({ok:true,result:p.actionId==='projects-taskRecord'?{taskId:'repo-sync:other',runId:'repo-sync:other:2026-10-14',logs:[{stage:'FOREIGN-LOG'}]}:taskCatalog('main',{records})}));
 const view=f.track(f.ui.mountProjects(f.container,ctx));await settle();await openTask(f);assert.match(f.container.querySelector('[role=dialog]').textContent,/暂无执行记录/);await click(f.container,'关闭');await settle();
 records=[{date:'2026-10-14',status:'failed',failures:[]}];view.update(ctx);await settle();await openTask(f);await openRun(f);assert.match(f.container.querySelector('[role=dialog]').textContent,/来源与当前任务不一致/);assert.ok(!f.container.textContent.includes('FOREIGN-LOG'));
});


test('record navigation opens logs at the top and restores the task record list scroll position',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs'));
 const ctx=uiContext(async(_method,p)=>({ok:true,result:p.actionId==='projects-taskRecord'?recordResult(p,{logs:[]}):taskCatalog('main',{records:[{date:'2026-10-14',status:'completed',failures:[]}]})}));
 f.track(f.ui.mountProjects(f.container,ctx));await settle();await openTask(f);f.container.querySelector('.ar-sync-dialog-body').scrollTop=120;
 await openRun(f);assert.equal(f.container.querySelector('.ar-sync-dialog-body').scrollTop,0);f.container.querySelector('.ar-sync-dialog-body').scrollTop=80;
 await click(f.container,'返回执行记录');await settle();assert.equal(f.container.querySelector('.ar-sync-dialog-body').scrollTop,120);
 await click(f.container,'任务设置');await settle();assert.equal(f.container.querySelector('.ar-sync-dialog-body').scrollTop,0);await click(f.container,'执行记录');await settle();assert.equal(f.container.querySelector('.ar-sync-dialog-body').scrollTop,120);
});

const logSources={sources:[{id:'test.history',label:'测试来源',capabilities:{live:true,history:true,clearHistory:true}}]};
test('repository log dialog copies and downloads redacted logs and closes on Agent changes',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),requests=[],copied=[],downloads=[];let late=null;
 Object.defineProperty(f.window.navigator,'clipboard',{value:{writeText:async text=>copied.push(text)},configurable:true});
 f.window.URL.createObjectURL=()=> 'blob:fixture';f.window.URL.revokeObjectURL=url=>downloads.push(url);f.window.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download);};
 const ctx=uiContext(async(_method,p)=>{requests.push(p);return {ok:true,result:p.actionId==='projects-list'?catalog(p.agentId):p.actionId==='projects-diagnosticSources'?logSources:late?await late.promise:{agentId:p.agentId,rows:[{eventId:'one',sourceId:'test.history',time:Date.now(),message:'local changes'}]}};});
 const view=f.track(f.ui.mountProjects(f.container,ctx));await settle();await click(f.container,'日志');await settle();
 const dialog=f.container.querySelector('[role=dialog]');assert.ok(dialog);assert.match(dialog.textContent,/更多操作/);await openMore(dialog);f.container.querySelector('.ar-log-raw').open=true;f.container.querySelector('.ar-log-raw').dispatchEvent(new f.window.Event('toggle'));await settle();assert.match(f.container.querySelector('textarea').value,/local changes/);
 await click(dialog,'复制筛选结果');await settle();assert.equal(copied.length,1);assert.match(dialog.textContent,/已复制当前筛选结果/);
 await click(dialog,'导出筛选结果');await settle();await new Promise(resolve=>f.window.setTimeout(resolve,10));assert.deepEqual(downloads,['agent-logs.json','blob:fixture']);
 await click(dialog,'关闭');await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);
 late=deferred();await click(f.container,'日志');await settle();ctx.host.agents.selectedId='other';ctx.notify();await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);
 late.resolve({agentId:'main',rows:[{message:'old Agent'}]});await settle();assert(!f.container.textContent.includes('old Agent'));
 late=null;await click(f.container,'日志');await settle();ctx.host.connection.canRead=false;ctx.notify();await settle();assert.ok(f.container.querySelector('[role=dialog]')===null);assert(!f.container.textContent.includes('日志'));view.dispose();
 assert(requests.some(p=>p.actionId==='projects-diagnosticHistory'));
});

test('repository logs remain open across panel refresh and show readable records before raw data',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),late=deferred();let pending=true;
 const ctx=uiContext(async(_method,p)=>({ok:true,result:p.actionId==='projects-list'?catalog('main'):p.actionId==='projects-diagnosticSources'?logSources:pending?await late.promise:{agentId:'main',rows:[]}}));
 const view=f.track(f.ui.mountProjects(f.container,ctx));await settle();
 const actions=f.container.querySelector('.ar-panel-actions');assert.deepEqual([...actions.querySelectorAll('button')].map(b=>b.textContent),['刷新扫描','查看审计','日志','人员资料']);
 await click(f.container,'日志');await settle();view.update({...ctx});await settle();assert.ok(f.container.querySelector('[role=dialog]'));
 late.resolve({agentId:'main',rows:[{eventId:'one',sourceId:'test.history',time:'2026-10-14T08:00:00Z',message:'local code changes · using local files'}]});await settle();
 const dialog=f.container.querySelector('[role=dialog]');assert.equal(dialog.querySelectorAll('.ar-log-record').length,1);assert.match(dialog.textContent,/local code changes/);assert.match(dialog.textContent,/using local files/);await openMore(dialog);assert.equal(f.container.querySelector('.ar-log-raw').open,false);
 view.update({...ctx});await settle();assert.ok(f.container.querySelector('[role=dialog]')===dialog,'log dialog remains mounted');assert.ok(dialog);
 await click(dialog,'关闭');await settle();pending=false;await click(f.container,'日志');await settle();assert(f.container.querySelector('.ar-log-empty'));assert.equal(f.container.querySelectorAll('.ar-log-record').length,0);
});

test('log clearing confirms, cancels, handles failure and refreshes records and export data',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),requests=[];let fail=true,pending=null;
 const rows={agentId:'main',rows:[{eventId:'one',sourceId:'test.history',message:'old entry'}]};
 const ctx=uiContext(async(_method,p)=>{requests.push(p);if(p.actionId==='projects-list')return {ok:true,result:catalog('main')};if(p.actionId==='projects-diagnosticSources')return {ok:true,result:logSources};if(p.actionId==='projects-diagnosticClearHistory'){if(fail)return {ok:false,error:'clear failed'};if(pending)await pending.promise;return {ok:true,result:{agentId:'main',rows:[],cleared:1}};}return {ok:true,result:rows};});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountProjects(f.container,ctx));await settle();await click(f.container,'日志');await settle();const dialog=f.container.querySelector('[role=dialog]');
 await click(dialog,'清理来源历史');await settle();assert.match(dialog.textContent,/回收站/);await click(dialog,'取消');await settle();assert.equal(requests.filter(r=>r.actionId==='projects-diagnosticClearHistory').length,0);
 await click(dialog,'清理来源历史');await settle();await click(dialog,'确认清理');await settle();assert.match(dialog.textContent,/clear failed/);assert.equal(dialog.querySelectorAll('.ar-log-record').length,1);
 fail=false;pending=deferred();await click(dialog,'确认清理');await settle();assert.equal([...dialog.querySelectorAll('button')].find(b=>b.textContent==='确认清理').disabled,true);pending.resolve();await settle();
 assert.equal(dialog.querySelectorAll('.ar-log-record').length,0);assert(dialog.querySelector('.ar-log-empty'));assert.match(dialog.textContent,/已清理 1 条/);assert.deepEqual(requests.find(r=>r.actionId==='projects-diagnosticClearHistory').payload,{sourceId:'test.history',confirmed:true});
 await openMore(dialog);assert.equal([...f.container.querySelectorAll('button')].find(b=>b.textContent==='清理来源历史').disabled,true);
 await click(dialog,'关闭');await settle();ctx.host.connection.canWrite=false;ctx.notify();await settle();await click(f.container,'日志');await settle();await openMore(f.container.querySelector('[role=dialog]'));assert.equal([...f.container.querySelectorAll('button')].find(b=>b.textContent==='清理来源历史').disabled,true);view.dispose();
});

test('people sidebar dialog closes on Agent switch and ignores late personnel responses',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs')),pending=deferred(),calls=[];
 const ctx=uiContext(async(_method,p)=>{calls.push(p);if(p.actionId==='projects-people')return pending.promise;return {ok:true,result:catalog(p.agentId)};});
 f.track(f.ui.mountProjects(f.container,ctx));await settle();await click(f.container,'人员资料');await settle();assert.ok(f.container.querySelector('[aria-label="人员资料管理"]'));
 ctx.host.agents.selectedId='other';ctx.notify();await settle();assert.ok(!f.container.querySelector('[aria-label="人员资料管理"]'));
 pending.resolve({ok:true,result:{people:[{name:'stale'}],total:1,nextOffset:null}});await settle();assert.ok(!f.container.textContent.includes('stale'));
 assert.equal(calls.find(p=>p.actionId==='projects-people').agentId,'main');
});
test('OpenClaw linked tasks show native schedule, admission status, source and receipt history',async ()=>{
 const f=await browserFixture({after:onTestFinished},path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs'));
 const task={taskId:'scheduled-request:one',name:'每日9点群清单',type:'scheduled-request',source:'openclaw',enabled:true,status:'enabled',nativeAvailable:true,nativeMissing:false,nativeLastStatus:'ok',jobId:'native-one',chatId:'group-one',requester:'Requester',scope:{label:'项目 demo · 群 group-one'},schedule:{kind:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'},nextPlanned:{state:'scheduled',at:'2026-10-23T01:00:00Z',timeZone:'Asia/Shanghai'},records:[{taskId:'scheduled-request:one',runId:'scheduled-request:one:1',date:'2026-10-22',startedAt:'2026-10-22T01:00:00Z',status:'submitted'}]};task.lastRun=task.records[0];
 const ctx=uiContext(async(_method,p)=>({ok:true,result:p.actionId==='projects-taskRecord'?{...task.records[0],logs:[{stage:'原群回复',status:'delivered',reason:'消息 receipt-one'}]}:{...catalog('main'),scheduledTasks:[task]}}));
 f.track(f.ui.mountProjects(f.container,ctx));await settle();assert.match(f.container.textContent,/OpenClaw 联动/);assert.match(f.container.textContent,/每天 09:00/);assert.match(f.container.textContent,/Main 已接纳/);assert.ok(!f.container.textContent.includes('undefined'));await openTask(f);await click(f.container,'任务设置');await settle();assert.ok(!f.container.textContent.includes('undefined'));assert.match(f.container.textContent,/native-one/);assert.match(f.container.textContent,/Requester/);await click(f.container,'执行记录');await settle();await openRun(f);assert.match(f.container.textContent,/消息已送达/);assert.match(f.container.textContent,/receipt-one/);
});
