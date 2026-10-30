import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,uiContext,settle,click,select,deferred} from '../../scripts/control-ui-test.mjs';
import {registerWorkerNavigation} from '../agent-repo-api/ui-navigation.mjs';
const counts={running:2,queued:1,awaiting_main:1,awaiting_user:0,completed:4,failed:1,timed_out:0,unknown:1};
const task={jobId:'11111111-1111-4111-8111-111111111111',topic:'检查项目',taskSummary:'只读检查',projectId:'demo',sessionKey:'agent:main:real-chat',status:'running',createdAt:1};
const result={taskTotal:10,conversationTotal:3,counts,tasks:[task],projectIds:['demo'],total:1,hasMore:false,scannedAt:'2026-10-17T12:00:00Z',coverage:'可核验绑定'};
test('AgentRepo Worker module reads Agent-wide tasks, filters without mutations and opens the exact original task',async t=>{
 const f=await browserFixture(t,new URL('./worker-page.mjs',import.meta.url).pathname),calls=[],opened=[];
 const stop=registerWorkerNavigation(value=>opened.push(value));t.after(stop);
 const ctx=uiContext(async(method,params)=>{calls.push(params);assert.equal(method,'plugins.sessionAction');assert.equal(params.pluginId,'agent-worker');assert.equal(params.actionId,'inspect-agentTasks');assert.equal(params.agentId,'main');assert.equal(params.sessionKey,'agent:main:agent-repo-management');return {ok:true,result};});
 f.track(f.ui.mountWorkerPage(f.container,ctx,'main'));await settle();assert.match(f.container.textContent,/10 个可归属任务 · 3 个来源会话/);assert.match(f.container.textContent,/1 个任务状态待核实/);assert.match(f.container.textContent,/检查项目/);
 click(f.container,'查看详情');assert.deepEqual(opened,[{agentId:'main',sessionKey:task.sessionKey,topic:task.topic,jobId:task.jobId,projectId:'demo'}]);
 select(f.window,f.container,'Worker 项目','demo');await settle();assert.equal(calls.at(-1).payload.projectId,'demo');select(f.window,f.container,'Worker 状态','failed');await settle();assert.equal(calls.at(-1).payload.status,'failed');
 assert.ok(calls.every(call=>call.actionId==='inspect-agentTasks'));
});
test('Worker module distinguishes unavailable from zero and discards responses after disposal',async t=>{
 const f=await browserFixture(t,new URL('./worker-page.mjs',import.meta.url).pathname),pending=deferred();let fail=true;
 const ctx=uiContext(async()=>{if(fail)throw Error('插件未就绪');return pending.promise;});
 const view=f.track(f.ui.mountWorkerPage(f.container,ctx,'main'));await settle();assert.match(f.container.textContent,/暂不可读取/);assert.ok(!f.container.textContent.includes('0 个可归属任务'));
 fail=false;click(f.container,'刷新任务');view.dispose();pending.resolve({ok:true,result});await settle();assert.equal(f.container.textContent,'');
});

test('management clocks tick locally, refresh terminal status, and stop reads after disposal',async t=>{
 const f=await browserFixture(t,new URL('./worker-page.mjs',import.meta.url).pathname);
 t.mock.timers.enable({apis:['Date','setInterval'],now:20000});let reads=0;
 const timed={...task,createdAt:1000,startedAt:2000};
 const ctx=uiContext(async()=>{reads++;return {ok:true,result:{...result,tasks:[{...timed}]}};});
 const view=f.track(f.ui.mountWorkerPage(f.container,ctx,'main'));await settle();assert.match(f.container.textContent,/总用时 19s/);const cell=f.container.querySelector('.ar-worker-elapsed');
 t.mock.timers.tick(1000);await settle();assert.equal(f.container.querySelector('.ar-worker-elapsed'),cell);assert.match(cell.textContent,/总用时 20s/);assert.equal(reads,1);
 timed.status='completed';timed.finishedAt=22000;t.mock.timers.tick(4000);await settle();assert.equal(reads,2);assert.match(f.container.textContent,/总用时 21s/);
 t.mock.timers.tick(5000);await settle();assert.match(f.container.textContent,/总用时 21s/);
 view.dispose();const before=reads;t.mock.timers.tick(10000);await settle();assert.equal(reads,before);
});
