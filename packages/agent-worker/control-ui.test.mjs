import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserFixture,settle,uiContext,select,click,deferred} from '../../scripts/control-ui-test.mjs';
function listing(projectId,running=0,queued=0){return {projectId:projectId??null,projectIds:['sample','demo'],sessions:[],counts:{running,queued},groupCounts:{active:running?1:0,history:0,unknown:0},hasMore:false};}
test('same-topic model sessions show their model and open only the selected model scope',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),calls=[];
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
test('project switch clears old counts and groups while loading and failed, keeps options and can recover',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),pending=deferred();let fail=true;
 const ctx=uiContext(async(_method,params)=>{const project=params.payload.projectId;if(project==='demo'){if(fail)return pending.promise;return {ok:true,result:listing('demo',2,0)};}return {ok:true,result:listing(project,3,1)};},{agentId:'main',sessionKey:'agent:main:test',projectId:'sample'});
 f.track(f.ui.mountPanel(f.container,ctx));await settle();assert.match(f.container.textContent,/运行 3 个任务 · 排队 1 个任务/);assert.match(f.container.textContent,/进行中/);
 select(f.window,f.container,'Worker 项目筛选','demo');assert.match(f.container.textContent,/正在读取任务统计/);assert.ok(!f.container.textContent.includes('运行 3'));assert.ok(!f.container.textContent.includes('进行中'));
 pending.reject(Error('Fixture read failed'));await settle();assert.match(f.container.textContent,/任务统计尚未读取/);assert.match(f.container.textContent,/Fixture read failed/);assert.ok(!f.container.textContent.includes('运行 3'));assert.ok(!f.container.textContent.includes('运行 0'));assert.ok(!f.container.textContent.includes('进行中'));
 assert.deepEqual([...f.container.querySelector('[aria-label="Worker 项目筛选"]').options].map(option=>option.value),['','sample','demo']);
 fail=false;click(f.container,'重试');await settle();assert.match(f.container.textContent,/运行 2 个任务 · 排队 0 个任务/);assert.ok(!f.container.querySelector('.cq-error'));
 click(f.container,'刷新');await settle();assert.ok(!f.container.textContent.includes('正在读取…'));assert.match(f.container.textContent,/运行 2 个任务/);
});
test('late responses from the previous project cannot overwrite current project statistics',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),old=deferred();let reads=0;
 const ctx=uiContext(async(_method,params)=>{if(params.payload.projectId==='sample'&&++reads===2)return old.promise;return {ok:true,result:listing(params.payload.projectId,params.payload.projectId==='demo'?2:3)};},{agentId:'main',sessionKey:'agent:main:test',projectId:'sample'});
 f.track(f.ui.mountPanel(f.container,ctx));await settle();click(f.container,'刷新');select(f.window,f.container,'Worker 项目筛选','demo');await settle();assert.match(f.container.textContent,/运行 2 个任务/);
 old.resolve({ok:true,result:listing('sample',99,99)});await settle();assert.match(f.container.textContent,/运行 2 个任务/);assert.ok(!f.container.textContent.includes('99'));assert.equal(f.container.querySelector('[aria-label="Worker 项目筛选"]').value,'demo');
});
test('failed commands have red frames and collapsed failure labels in records and process views',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname);
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
  assert.deepEqual(calls.filter(node=>node.classList.contains('cq-call-failed')).map(node=>node.dataset.foldKey),['nonzero','failed','error']);
  for(const call of calls.slice(0,3)){assert.equal(call.open,false);assert.match(call.querySelector('summary').textContent,/执行失败/);}
  calls[0].open=true;assert.ok(calls[0].classList.contains('cq-call-failed'));
 };
 verify();click(f.container,'任务过程');verify();assert.equal(f.container.querySelectorAll('.cq-stage.failed').length,3);
 click(f.container,'对话记录');assert.equal(f.container.querySelectorAll('.cq-call-failed').length,3);
});

test('task deep link reads the original job directly and updates when another job is opened',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),calls=[];
 const ctx=uiContext(async(method,params)=>{calls.push(params);return {ok:true,result:{topic:params.payload.topic,session:null,currentTasks:[],taskHistory:[],records:[],hasMore:false}};},{agentId:'main',sessionKey:'agent:main:original',projectId:'demo',topic:'original topic',jobId:'11111111-1111-4111-8111-111111111111'});
 const view=f.track(f.ui.mountProjectPage(f.container,ctx));await settle();assert.equal(calls[0].actionId,'inspect-detail');assert.equal(calls[0].payload.jobId,ctx.props.jobId);assert.equal(calls[0].sessionKey,'agent:main:original');
 view.update({...ctx,props:{...ctx.props,topic:'next topic',jobId:'22222222-2222-4222-8222-222222222222'}});await settle();assert.equal(calls.at(-1).payload.topic,'next topic');assert.equal(calls.at(-1).payload.jobId,'22222222-2222-4222-8222-222222222222');
});

function deletableSession(patch={}){return {topic:'delete-me',projectId:'demo',executionScope:'a'.repeat(64),modelSessionScope:'b'.repeat(64),deletionRevision:'c'.repeat(64),canDelete:true,status:'completed',taskCount:2,tags:[],heat:0,interactionCount:4,...patch};}
test('sidebar delete confirms exact model session and refreshes the list after success',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),row=deletableSession(),calls=[];let deleted=false;
 const ctx=uiContext(async(_method,params)=>{calls.push(params);if(params.actionId==='inspect-deleteSession'){deleted=true;return {ok:true,result:{deleted:true,taskCount:2}};}return {ok:true,result:{...listing(null),sessions:deleted?[]:[row],groupCounts:{history:deleted?0:1,active:0,unknown:0}}};},{agentId:'main',sessionKey:'agent:main:test'});ctx.host.connection.canWrite=true;
 f.track(f.ui.mountPanel(f.container,ctx));await settle();click(f.container,'删除会话');assert.match(f.container.textContent,/删除会话？/);assert.match(f.container.textContent,/2 条历史任务/);assert.equal(calls.filter(p=>p.actionId==='inspect-deleteSession').length,0);
 click(f.container,'取消');assert.equal(f.container.querySelector('dialog'),null);click(f.container,'删除会话');click(f.container,'确认删除');await settle();
 assert.deepEqual(calls.find(p=>p.actionId==='inspect-deleteSession').payload,{topic:row.topic,executionScope:row.executionScope,modelSessionScope:row.modelSessionScope,projectId:'demo',revision:row.deletionRevision,confirmed:true});assert.equal(f.container.querySelector('dialog'),null);assert.match(f.container.textContent,/没有匹配的会话/);
});
test('read-only users have no delete button and active sessions explain why deletion is disabled',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),row=deletableSession({canDelete:false,deleteReason:'仍在执行',status:'running'});
 const ctx=uiContext(async()=>({ok:true,result:{...listing(null),sessions:[row],groupCounts:{history:1,active:1,unknown:0}}}),{sessionKey:'chat'}),view=f.track(f.ui.mountPanel(f.container,ctx));await settle();assert.equal(f.container.querySelector('.cq-delete'),null);
 ctx.host.connection.canWrite=true;view.update(ctx);await settle();click(f.container,'刷新');await settle();const remove=f.container.querySelector('.cq-delete');assert.equal(remove.disabled,true);assert.equal(remove.title,'仍在执行');
});
test('delete failures retain the session and switching chats dismisses the confirmation',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),row=deletableSession();
 const ctx=uiContext(async(_method,p)=>p.actionId==='inspect-deleteSession'?{ok:false,error:'会话已变化，请刷新后重新确认删除。'}:{ok:true,result:{...listing(null),sessions:[row],groupCounts:{history:1,active:1,unknown:0}}},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();click(f.container,'删除会话');click(f.container,'确认删除');await settle();assert.match(f.container.querySelector('dialog').textContent,/会话已变化/);assert.ok(f.container.querySelector('.cq-row'));
 view.update({...ctx,props:{sessionKey:'other'}});await settle();assert.equal(f.container.querySelector('dialog'),null);
});

test('detail deletion survives same-target host updates and returns to the refreshed session list',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),row=deletableSession();let deleted=false;
 const ctx=uiContext(async(_method,p)=>{if(p.actionId==='inspect-deleteSession'){deleted=true;return {ok:true,result:{deleted:true}};}return {ok:true,result:p.actionId==='inspect-detail'?{session:row,records:[],currentTasks:[],taskHistory:[],hasMore:false}:{...listing(null),sessions:deleted?[]:[row],groupCounts:{history:deleted?0:1,active:0,unknown:0}}};},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();f.container.querySelector('.cq-row-open').click();await settle();click(f.container,'删除会话');view.update({...ctx});click(f.container,'确认删除');await settle();assert.equal(deleted,true);assert.equal(f.container.querySelector('dialog'),null);assert.match(f.container.textContent,/没有匹配的会话/);
});
test('losing write permission closes the delete dialog without sending a mutation',async t=>{
 const f=await browserFixture(t,new URL('./control-ui.mjs',import.meta.url).pathname),row=deletableSession(),calls=[];
 const ctx=uiContext(async(_method,p)=>{calls.push(p.actionId);return {ok:true,result:{...listing(null),sessions:[row],groupCounts:{history:1,active:0,unknown:0}}};},{sessionKey:'chat'});ctx.host.connection.canWrite=true;
 const view=f.track(f.ui.mountPanel(f.container,ctx));await settle();click(f.container,'删除会话');ctx.host.connection.canWrite=false;view.update(ctx);await settle();assert.equal(f.container.querySelector('dialog'),null);assert.equal(f.container.querySelector('.cq-delete'),null);assert.ok(!calls.includes('inspect-deleteSession'));
});
