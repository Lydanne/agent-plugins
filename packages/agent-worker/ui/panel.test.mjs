import path from 'node:path';
import {fileURLToPath} from 'node:url';
const panelEntry=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../control-ui.mjs');
import {test,vi,onTestFinished} from 'vitest';
import assert from 'node:assert/strict';
import {browserFixture,settle,uiContext,select,click as clickButton,deferred} from '../../../scripts/control-ui-test.mjs';
function listing(projectId,running=0,queued=0){return {projectId:projectId??null,projectIds:['sample','demo'],sessions:[],counts:{running,queued},groupCounts:{active:running?1:0,history:0,unknown:0},hasMore:false};}
test('same-topic model sessions show their model and open only the selected model scope',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),calls=[];
 const sessions=['quick','deep'].map((id,index)=>({topic:'same',modelId:id,model:'fixture-'+id,harness:'codex',modelSessionScope:String(index+1).repeat(64),status:'completed',tags:[],heat:0,taskCount:1,interactionCount:1}));
 const ctx=uiContext(async(_method,params)=>{calls.push(params.payload);return {ok:true,result:params.payload.topic?{topic:'same',session:sessions.find(row=>row.modelSessionScope===params.payload.modelSessionScope),records:[],currentTasks:[],taskHistory:[],hasMore:false}:{...listing(null),sessions,groupCounts:{active:0,history:2,unknown:0}}};},{agentId:'main',sessionKey:'agent:main:test'});
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();
 assert.match(f.container.textContent,/codex \/ fixture-quick/);assert.match(f.container.textContent,/codex \/ fixture-deep/);
 assert.equal(new Set([...f.container.querySelectorAll('.cq-row')].map(row=>row.dataset.recordKey)).size,2);
 f.container.querySelectorAll('.cq-row-open')[1].click();await settle();
 assert.equal(calls.at(-1).modelSessionScope,sessions[1].modelSessionScope);
 view.update({...ctx,props:{...ctx.props,topic:'same',modelSessionScope:sessions[0].modelSessionScope}});await settle();
 assert.equal(calls.at(-1).modelSessionScope,sessions[0].modelSessionScope);
});
test('project switch clears old counts and groups while loading and failed, keeps options and can recover',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),pending=deferred();let fail=true;
 const ctx=uiContext(async(_method,params)=>{const project=params.payload.projectId;if(project==='demo'){if(fail)return pending.promise;return {ok:true,result:listing('demo',2,0)};}return {ok:true,result:listing(project,3,1)};},{agentId:'main',sessionKey:'agent:main:test',projectId:'sample'});
 f.track(f.ui.mountPanel(f.container,ctx));await settle();assert.match(f.container.textContent,/运行 3 个任务 · 排队 1 个任务/);assert.match(f.container.textContent,/进行中/);
 select(f.window,f.container,'Worker 项目筛选','demo');await settle();assert.match(f.container.textContent,/正在读取任务统计/);assert.ok(!f.container.textContent.includes('运行 3'));assert.ok(!f.container.textContent.includes('进行中'));
 pending.reject(Error('Fixture read failed'));await settle();assert.match(f.container.textContent,/任务统计尚未读取/);assert.match(f.container.textContent,/Fixture read failed/);assert.ok(!f.container.textContent.includes('运行 3'));assert.ok(!f.container.textContent.includes('运行 0'));assert.ok(!f.container.textContent.includes('进行中'));
 assert.deepEqual([...f.container.querySelector('[aria-label="Worker 项目筛选"]').options].map(option=>option.value),['','sample','demo']);
 fail=false;await press(f,'重试');await settle();assert.match(f.container.textContent,/运行 2 个任务 · 排队 0 个任务/);assert.ok(!f.container.querySelector('.cq-error'));
 await press(f,'刷新');await settle();assert.ok(!f.container.textContent.includes('正在读取…'));assert.match(f.container.textContent,/运行 2 个任务/);
});
test('late responses from the previous project cannot overwrite current project statistics',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),old=deferred();let reads=0;
 const ctx=uiContext(async(_method,params)=>{if(params.payload.projectId==='sample'&&++reads===2)return old.promise;return {ok:true,result:listing(params.payload.projectId,params.payload.projectId==='demo'?2:3)};},{agentId:'main',sessionKey:'agent:main:test',projectId:'sample'});
 f.track(f.ui.mountPanel(f.container,ctx));await settle();await press(f,'刷新');select(f.window,f.container,'Worker 项目筛选','demo');await settle();await settle();assert.match(f.container.textContent,/运行 2 个任务/);
 old.resolve({ok:true,result:listing('sample',99,99)});await settle();assert.match(f.container.textContent,/运行 2 个任务/);assert.ok(!f.container.textContent.includes('99'));assert.equal(f.container.querySelector('[aria-label="Worker 项目筛选"]').value,'demo');
});
test('failed commands have red frames and collapsed failure labels in records and process views',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry);
 const items=[
  {id:'nonzero',command:'exit 2',status:'completed',exit_code:2},
  {id:'failed',command:'missing-command',status:'failed',exit_code:null},
  {id:'error',command:'blocked-command',error:{message:'Permission denied'}},
  {id:'success',command:'echo error',status:'completed',exit_code:0,aggregated_output:'error'},
  {id:'running',command:'sleep 1',status:'in_progress',exit_code:null},
  {id:'empty-error',command:'true',status:'completed',exit_code:0,error:null},
 ];
 const events=items.map((item,index)=>({event:'item.completed',time:1000+index,item:{type:'command_execution',...item}}));
 const record={jobId:'job',status:'completed',createdAt:100,startedAt:200,finishedAt:2000,request:{availability:'available',task:'Fixture task'},events,eventsAvailability:'available'};
 const ctx=uiContext(async(_method,params)=>({ok:true,result:params.payload.topic?{records:[record],offset:0,hasMore:false}:{...listing(null),groupCounts:{active:0,history:1,unknown:0},sessions:[{topic:'fixture',status:'completed',tags:[],heat:0,taskCount:1,interactionCount:1}]}}),{agentId:'main',sessionKey:'agent:main:test'});
 f.track(f.ui.mountPanel(f.container,ctx));await settle();f.container.querySelector('.cq-row-open').click();await settle();
 const verify=()=>{
  const calls=[...f.container.querySelectorAll('.cq-calls>.cq-disclosure')];assert.equal(calls.length,items.length);
  assert.deepEqual(calls.filter(node=>node.classList.contains('cq-call-failed')).map(node=>node.dataset.foldKey),['0:nonzero','0:failed','0:error']);
  for(const call of calls.slice(0,3)){assert.equal(call.open,false);assert.match(call.querySelector('summary').textContent,/执行失败/);}
  calls[0].open=true;assert.ok(calls[0].classList.contains('cq-call-failed'));
 };
 verify();await press(f,'任务过程');verify();assert.equal(f.container.querySelectorAll('.cq-stage.failed').length,3);
 await press(f,'对话记录');assert.equal(f.container.querySelectorAll('.cq-call-failed').length,3);
});

test('task deep link reads the original job directly and updates when another job is opened',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),calls=[];
 const ctx=uiContext(async(method,params)=>{calls.push(params);return {ok:true,result:{topic:params.payload.topic,session:null,currentTasks:[],taskHistory:[],records:[],hasMore:false}};},{agentId:'main',sessionKey:'agent:main:original',projectId:'demo',topic:'original topic',jobId:'11111111-1111-4111-8111-111111111111'});
 const view=f.track(f.ui.mountProjectPage(f.container,ctx));await settle();assert.equal(calls[0].actionId,'inspect-detail');assert.equal(calls[0].payload.jobId,ctx.props.jobId);assert.equal(calls[0].sessionKey,'agent:main:original');
 view.update({...ctx,props:{...ctx.props,topic:'next topic',jobId:'22222222-2222-4222-8222-222222222222'}});await settle();assert.equal(calls.at(-1).payload.topic,'next topic');assert.equal(calls.at(-1).payload.jobId,'22222222-2222-4222-8222-222222222222');
});

function deletableSession(patch={}){return {topic:'delete-me',projectId:'demo',executionScope:'a'.repeat(64),modelSessionScope:'b'.repeat(64),deletionRevision:'c'.repeat(64),canDelete:true,status:'completed',taskCount:2,tags:[],heat:0,interactionCount:4,...patch};}
test('sidebar delete confirms exact model session and refreshes the list after success',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),row=deletableSession(),calls=[];let deleted=false;
 const ctx=uiContext(async(_method,params)=>{calls.push(params);if(params.actionId==='inspect-deleteSession'){deleted=true;return {ok:true,result:{deleted:true,taskCount:2}};}return {ok:true,result:{...listing(null),sessions:deleted?[]:[row],groupCounts:{history:deleted?0:1,active:0,unknown:0}}};},{agentId:'main',sessionKey:'agent:main:test'});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountPanel(f.container,ctx));await settle();await press(f,'删除会话');assert.match(f.container.textContent,/删除会话？/);assert.match(f.container.textContent,/2 条历史任务/);assert.equal(calls.filter(p=>p.actionId==='inspect-deleteSession').length,0);
 await press(f,'取消');assert.equal(f.container.querySelector('[role=dialog]'),null);await press(f,'删除会话');await press(f,'确认删除');await settle();
 assert.deepEqual(calls.find(p=>p.actionId==='inspect-deleteSession').payload,{topic:row.topic,executionScope:row.executionScope,modelSessionScope:row.modelSessionScope,projectId:'demo',revision:row.deletionRevision,confirmed:true});assert.equal(f.container.querySelector('[role=dialog]'),null);assert.match(f.container.textContent,/没有匹配的会话/);
});
test('read-only users have no delete button and active sessions explain why deletion is disabled',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),row=deletableSession({canDelete:false,deleteReason:'仍在执行',status:'running'});
 const ctx=uiContext(async()=>({ok:true,result:{...listing(null),sessions:[row],groupCounts:{history:1,active:1,unknown:0}}}),{sessionKey:'chat'}),view=f.track(f.ui.mountPanel(f.container,ctx));await settle();assert.equal(f.container.querySelector('.cq-delete'),null);
 ctx.host.connection.canWrite=true;view.update(ctx);await settle();await press(f,'刷新');await settle();await openMore(f);const remove=f.container.querySelector('.cq-delete');assert.equal(remove.disabled,true);assert.equal(remove.title,'仍在执行');
});
test('delete failures retain the session and switching chats dismisses the confirmation',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),row=deletableSession();
 const ctx=uiContext(async(_method,p)=>p.actionId==='inspect-deleteSession'?{ok:false,error:'会话已变化，请刷新后重新确认删除。'}:{ok:true,result:{...listing(null),sessions:[row],groupCounts:{history:1,active:1,unknown:0}}},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();await press(f,'删除会话');await press(f,'确认删除');await settle();assert.match(f.container.querySelector('[role=dialog]').textContent,/会话已变化/);assert.ok(f.container.querySelector('.cq-row'));
 view.update({...ctx,props:{sessionKey:'other'}});await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);
});

test('detail deletion survives same-target host updates and returns to the refreshed session list',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),row=deletableSession();let deleted=false;
 const ctx=uiContext(async(_method,p)=>{if(p.actionId==='inspect-deleteSession'){deleted=true;return {ok:true,result:{deleted:true}};}return {ok:true,result:p.actionId==='inspect-detail'?{session:row,records:[],currentTasks:[],taskHistory:[],hasMore:false}:{...listing(null),sessions:deleted?[]:[row],groupCounts:{history:deleted?0:1,active:0,unknown:0}}};},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();f.container.querySelector('.cq-row-open').click();await settle();await press(f,'删除会话');view.update({...ctx});await press(f,'确认删除');await settle();assert.equal(deleted,true);assert.equal(f.container.querySelector('[role=dialog]'),null);assert.match(f.container.textContent,/没有匹配的会话/);
});
test('losing write permission closes the delete dialog without sending a mutation',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),row=deletableSession(),calls=[];
 const ctx=uiContext(async(_method,p)=>{calls.push(p.actionId);return {ok:true,result:{...listing(null),sessions:[row],groupCounts:{history:1,active:0,unknown:0}}};},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();await press(f,'删除会话');ctx.host.connection.canWrite=false;view.update(ctx);await settle();assert.equal(f.container.querySelector('[role=dialog]'),null);assert.equal(f.container.querySelector('.cq-delete'),null);assert.ok(!calls.includes('inspect-deleteSession'));
});

async function openMore(f,selector='.cq-row .cq-more'){
 const host=f.container.querySelector(selector);assert.ok(host);
 const trigger=host.querySelector('[aria-haspopup=menu]');assert.ok(trigger);assert.equal(trigger.getAttribute('aria-expanded'),'false');
 trigger.dispatchEvent(new f.window.MouseEvent('click',{button:0,ctrlKey:false,bubbles:true}));await settle();
 assert.equal(trigger.getAttribute('aria-expanded'),'true');return f.container.querySelector('[role=menu]');
}
async function press(f,label){
 if(label==='删除会话'&&![...f.container.querySelectorAll('button')].some(node=>node.textContent===label))await openMore(f,f.container.querySelector('.cq-detail')?'.cq-detail-title .cq-more':'.cq-row .cq-more');
 const control=[...f.container.querySelectorAll('button')].find(node=>node.textContent===label);assert.ok(control,'Missing button: '+label);
 control.dispatchEvent(new f.window.MouseEvent('mousedown',{button:0,ctrlKey:false,bubbles:true}));clickButton(f.container,label);await settle();
}
async function checkSession(f,topic='delete-me'){const input=[...f.container.querySelectorAll('.cq-session-check')].find(node=>node.getAttribute('aria-label')==='选择会话 demo / '+topic);assert.ok(input);input.checked=!input.checked;input.dispatchEvent(new f.window.Event('change'));await settle();}
function batchFixtureRows(){return [deletableSession({topic:'one'}),deletableSession({topic:'two',modelSessionScope:'d'.repeat(64)}),deletableSession({topic:'active',status:'running',canDelete:false,deleteReason:'仍在执行'})];}
test('session menus hide destructive actions until opened and close with Escape or outside click',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),row=deletableSession();
 const ctx=uiContext(async()=>({ok:true,result:{...listing(null),groupCounts:{history:2,active:1,unknown:0},sessions:[row]}}),{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountPanel(f.container,ctx));await settle();
 const menu=await openMore(f);assert.ok(menu.querySelector('.cq-delete'));assert.equal(f.container.querySelector('.cq-row-meta>.cq-delete'),null);
 menu.querySelector('button').dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle();assert.equal(f.container.querySelector('[role=menu]'),null);
 await openMore(f);f.container.dispatchEvent(new f.window.PointerEvent('pointerdown',{button:0,bubbles:true,pointerType:'mouse'}));await settle();assert.equal(f.container.querySelector('[role=menu]'),null);
});
test('multi-select exposes deletion only after selection, skips active rows, confirms exact scopes once',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),rows=batchFixtureRows(),calls=[],removed=new Set();
 const ctx=uiContext(async(_method,p)=>{calls.push(p);if(p.actionId==='inspect-deleteSession'){removed.add(p.payload.topic);return {ok:true,result:{deleted:true}};}return {ok:true,result:{...listing(null),groupCounts:{history:2,active:1,unknown:0},sessions:rows.filter(row=>!removed.has(row.topic))}};},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountPanel(f.container,ctx));await settle();await openMore(f,'header .cq-more');await press(f,'多选会话');assert.equal(f.container.querySelectorAll('.cq-session-check').length,3);assert.ok(!f.container.textContent.includes('删除所选'));
 const all=f.container.querySelector('[aria-label="全选已加载的可删除会话"]');all.checked=true;all.dispatchEvent(new f.window.Event('change'));await settle();
 assert.match(f.container.textContent,/已选 2 个会话/);assert.equal(f.container.querySelectorAll('.cq-session-check:checked').length,2);assert.equal(f.container.querySelector('[aria-label="选择会话 demo / active"]').disabled,true);
 await press(f,'删除所选 (2)');assert.match(f.container.querySelector('[role=dialog]').textContent,/4 条历史任务/);assert.equal(calls.filter(p=>p.actionId==='inspect-deleteSession').length,0);
 await press(f,'取消');assert.equal(f.container.querySelector('[role=dialog]'),null);assert.match(f.container.textContent,/已选 2 个/);
 await press(f,'删除所选 (2)');await press(f,'确认批量删除');await settle();
 const deletions=calls.filter(p=>p.actionId==='inspect-deleteSession');assert.equal(deletions.length,2);assert.deepEqual(deletions.map(p=>p.payload.modelSessionScope),[rows[0].modelSessionScope,rows[1].modelSessionScope]);assert.ok(deletions.every(p=>p.sessionKey==='chat'&&p.payload.confirmed===true));assert.match(f.container.textContent,/已删除 2 个会话/);assert.equal(f.container.querySelectorAll('.cq-session-check').length,0);
});
test('row selection shortcut and partial deletion keep only failures selected without retrying successes',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),rows=batchFixtureRows().slice(0,2),calls=[];let removed=false;
 const ctx=uiContext(async(_method,p)=>{if(p.actionId==='inspect-deleteSession'){calls.push(p.payload.topic);if(p.payload.topic==='two')return {ok:false,error:'存储暂不可用'};removed=true;return {ok:true,result:{deleted:true}};}return {ok:true,result:{...listing(null),groupCounts:{history:2,active:1,unknown:0},sessions:removed?[rows[1]]:rows}};},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountPanel(f.container,ctx));await settle();await openMore(f);await press(f,'选择会话');assert.match(f.container.textContent,/已选 1 个/);await checkSession(f,'two');await press(f,'删除所选 (2)');await press(f,'确认批量删除');await settle();
 assert.deepEqual(calls,['one','two']);assert.match(f.container.textContent,/已删除 1 个会话，1 个未确认删除/);assert.match(f.container.textContent,/two：存储暂不可用/);assert.match(f.container.textContent,/已选 1 个会话/);assert.equal(f.container.querySelector('.cq-session-check').checked,true);
 await press(f,'删除所选 (1)');await press(f,'确认批量删除');await settle();assert.deepEqual(calls,['one','two','two']);
});
test('selection invalidates changed revisions and clears on project, chat or write-permission changes',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry);let row=deletableSession();
 const ctx=uiContext(async()=>({ok:true,result:{...listing(null),groupCounts:{history:2,active:1,unknown:0},sessions:[row]}}),{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();await openMore(f);await press(f,'选择会话');row={...row,deletionRevision:'f'.repeat(64)};await press(f,'刷新');await settle();assert.match(f.container.textContent,/已选 0 个会话/);assert.match(f.container.textContent,/已变化或不可删除/);
 await checkSession(f);select(f.window,f.container,'Worker 项目筛选','demo');await settle();await settle();assert.equal(f.container.querySelectorAll('.cq-session-check').length,0);
 await openMore(f);await press(f,'选择会话');view.update({...ctx,props:{sessionKey:'other'}});await settle();assert.equal(f.container.querySelectorAll('.cq-session-check').length,0);
 await openMore(f);await press(f,'选择会话');ctx.host.connection.canWrite=false;view.update({...ctx,props:{sessionKey:'other'}});await settle();assert.equal(f.container.querySelectorAll('.cq-session-check').length,0);assert.equal(f.container.querySelector('.cq-more'),null);
});
test('revoking permission during bulk deletion stops before the next session',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),rows=batchFixtureRows().slice(0,2),pending=deferred(),calls=[];
 const ctx=uiContext(async(_method,p)=>{if(p.actionId==='inspect-deleteSession'){calls.push(p.payload.topic);return pending.promise;}return {ok:true,result:{...listing(null),groupCounts:{history:2,active:1,unknown:0},sessions:rows}};},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();await openMore(f);await press(f,'选择会话');await checkSession(f,'two');await press(f,'删除所选 (2)');await press(f,'确认批量删除');await settle();assert.deepEqual(calls,['one']);
 ctx.host.connection.canWrite=false;view.update(ctx);pending.resolve({ok:true,result:{deleted:true}});await settle();assert.deepEqual(calls,['one']);assert.equal(f.container.querySelector('[role=dialog]'),null);
});

test('selection persists across loaded pages and same-topic models delete by distinct identities',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),one=deletableSession({topic:'same',model:'quick'}),two=deletableSession({topic:'same',model:'deep',modelSessionScope:'e'.repeat(64)}),calls=[];let deleted=false;
 const ctx=uiContext(async(_method,p)=>{if(p.actionId==='inspect-deleteSession'){calls.push(p.payload);deleted=true;return {ok:true,result:{deleted:true}};}return {ok:true,result:{...listing(null),groupCounts:{history:2,active:0,unknown:0},sessions:deleted?[]:[p.payload.offset?two:one],hasMore:!deleted&&!p.payload.offset}};},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountPanel(f.container,ctx));await settle();await openMore(f);await press(f,'选择会话');await press(f,'加载更多会话');await settle();
 const input=f.container.querySelector('[aria-label="选择会话 demo / same · deep"]');input.checked=true;input.dispatchEvent(new f.window.Event('change'));await settle();assert.match(f.container.textContent,/已选 2 个会话/);
 await press(f,'删除所选 (2)');assert.match(f.container.querySelector('[role=dialog]').textContent,/quick/);assert.match(f.container.querySelector('[role=dialog]').textContent,/deep/);await press(f,'确认批量删除');await settle();
 assert.equal(calls.length,2);assert.equal(calls[0].topic,calls[1].topic);assert.notEqual(calls[0].modelSessionScope,calls[1].modelSessionScope);
});

test('process clocks tick without replacing disclosures and stop at task completion',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry);
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval'],now:20000});onTestFinished(()=>vi.useRealTimers());
 const record={jobId:'clock-job',status:'running',createdAt:1000,startedAt:2000,request:{availability:'available',task:'Clock fixture'},questions:[],eventsAvailability:'available',events:[{event:'turn.started',time:2000},{event:'item.started',time:5000,item:{id:'call',type:'mcp_tool_call',server:'fixture',tool:'lookup',status:'in_progress'}}]};
 const ctx=uiContext(async()=>({ok:true,result:{records:[record],offset:0,hasMore:false}}),{sessionKey:'fixture',topic:'clock'});
 f.track(f.ui.mountPanel(f.container,ctx));await settle();await press(f,'任务过程');
 const call=f.container.querySelector('.cq-calls>details');call.open=true;
 assert.match(call.querySelector('summary').textContent,/15s/);assert.match(f.container.textContent,/总用时 19s/);
 vi.advanceTimersByTime(1000);await settle();assert.equal(f.container.querySelector('.cq-calls>details'),call);assert.equal(call.open,true);assert.match(call.querySelector('summary').textContent,/16s/);
 record.status='completed';record.finishedAt=22000;record.events.push({event:'item.completed',time:21500,item:{id:'call',type:'mcp_tool_call',server:'fixture',tool:'lookup',status:'completed'}});
 await press(f,'刷新');await settle();assert.match(f.container.textContent,/总用时 21s/);assert.match(f.container.querySelector('.cq-calls>details summary').textContent,/16s/);
 vi.advanceTimersByTime(1000);await settle();assert.match(f.container.textContent,/总用时 21s/);
});
for(const fields of [{cwd:'/agent/workspace/xgj-0/a long directory',directoryKind:'workspace'},{cwd:'/agent/projects/xgj',directoryKind:'project'},{workspacePending:true},{}]) test('session directory display '+JSON.stringify(fields),async()=>{
  const f=await browserFixture({after:onTestFinished},panelEntry);
  const session={topic:'directory',status:'completed',tags:[],heat:0,taskCount:1,interactionCount:1,...fields};
  const ctx=uiContext(async(_m,p)=>({ok:true,result:p.payload.topic?{session,records:[],currentTasks:[],taskHistory:[],hasMore:false}:{...listing(null),sessions:[session],groupCounts:{active:0,history:1,unknown:0}}}),{agentId:'main',sessionKey:'agent:main:test'});
  f.track(f.ui.mountPanel(f.container,ctx));await settle();f.container.querySelector('.cq-row-open').click();await settle();await press(f,'会话信息');
  assert.ok(f.container.textContent.includes(fields.cwd??(fields.workspacePending?'等待分配 workspace':'未记录运行目录')));
  if(fields.directoryKind==='workspace')assert.ok(f.container.textContent.includes('独立 workspace'));
});

test('public page registrations and actual RPC routing retain agent-worker identity',async()=>{
 const f=await browserFixture({after:onTestFinished},panelEntry),panels=[],pages=[],calls=[],released=[];
 const deactivate=f.ui.default.activate({ui:{registerPanel(value){panels.push(value);return ()=>released.push(value.id);},registerPage(value){pages.push(value);return ()=>released.push(value.id);}},navigation:{openPage(){}}});onTestFinished(deactivate);
 assert.equal(f.ui.default.id,'agent-worker');assert.equal(panels[0].id,'agent-worker-sessions');assert.equal(pages[0].id,'project-tasks');
 const ctx=uiContext(async(method,params)=>{calls.push({method,...params});return {ok:true,result:listing(null)};},{agentId:'main',sessionKey:'agent:main:fixture'});
 f.track(panels[0].mount(f.container,ctx));await settle();assert.equal(calls.length,1);assert.equal(calls[0].method,'plugins.sessionAction');assert.equal(calls[0].pluginId,'agent-worker');assert.equal(calls[0].actionId,'inspect-list');assert.equal(calls[0].agentId,'main');assert.equal(calls[0].sessionKey,'agent:main:fixture');
});
