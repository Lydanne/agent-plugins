import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createSessionInspector,inspectionEvent,registerInspector} from './session-inspector.mjs';
import {readInspectionResponse} from './inspection-transport.mjs';
import {requestKeyFor} from './jobs.mjs';
const id='11111111-1111-4111-8111-111111111111';
const id2='22222222-2222-4222-8222-222222222222';
const hash=x=>createHash('sha256').update(x).digest('hex');
test('project filter isolates same-topic task counts and records without broadening conversation scope',()=>fixture(async state=>{
 const rows=[{jobId:id,scope:hash('chat'),topic:'same',projectId:'a',project:{projectId:'a'},repository:'projects/a',executionScope:hash('a'),status:'running',createdAt:1},{jobId:id2,scope:hash('chat'),topic:'same',projectId:'b',project:{projectId:'b'},repository:'projects/b',executionScope:hash('b'),status:'queued',createdAt:2}];
 for(const row of rows)await writeFile(join(state,'jobs',row.jobId+'.json'),JSON.stringify(row));
 const inspector=createSessionInspector({state,jobs:{status:jobId=>rows.find(job=>job.jobId===jobId)}}),a=await inspector.list('chat',{projectId:'a'});
 assert.deepEqual(a.projectIds,['a','b']);assert.equal(a.total,1);assert.equal(a.sessions[0].projectId,'a');assert.equal(a.counts.running,1);assert.equal(a.counts.queued,0);
 const detail=await inspector.detail('chat',{topic:'same',projectId:'a'});assert.equal(detail.total,1);assert.equal(detail.session.projectId,'a');assert.equal(detail.records[0].jobId,id);
 await assert.rejects(inspector.detail('chat',{topic:'same',projectId:'a',jobId:id2}));await assert.rejects(inspector.list('chat',{projectId:'../b'}));
 assert.equal((await inspector.list('other',{projectId:'a'})).total,0);assert.equal((await inspector.list('chat',{projectId:'empty'})).total,0);
}));
async function fixture(fn){const state=await mkdtemp(join(tmpdir(),'codex-inspect-'));try{await mkdir(join(state,'jobs'));await fn(state);}finally{await rm(state,{recursive:true,force:true});}}
test('model sessions group levels together and keep detail records separate, including job deep links',()=>fixture(async state=>{
 const scope='model-chat',project={projectId:'a'},executionScope=hash('project-a');
 const rows=[0,1,2].map((index)=>({jobId:[id,id2,'33333333-3333-4333-8333-333333333333'][index],scope:hash(scope),topic:'same',projectId:'a',project,repository:'projects/a',executionScope,modelSessionScope:hash(index===1?'deep':'quick'),modelId:index===1?'deep':'quick',harness:'codex',model:index===1?'fixture-deep':'fixture-quick',thinkingLevel:index===2?6:0,status:'completed',createdAt:index+1}));
 for(const row of rows)await writeFile(join(state,'jobs',row.jobId+'.json'),JSON.stringify(row));
 const inspector=createSessionInspector({state,jobs:{status:jobId=>rows.find(job=>job.jobId===jobId)}});
 const listing=await inspector.list(scope);assert.equal(listing.total,2);
 assert.equal(listing.sessions.find(row=>row.modelId==='quick').taskCount,2);assert.equal(listing.sessions.find(row=>row.modelId==='deep').taskCount,1);
 assert.equal((await inspector.list(scope,{query:'fixture-deep'})).total,1);
 const detail=await inspector.detail(scope,{topic:'same',executionScope,modelSessionScope:hash('quick')});
 assert.equal(detail.total,2);assert.equal(detail.session.modelId,'quick');assert.equal(detail.records[0].model,'fixture-quick');assert.equal(detail.records[0].thinkingLevel,6);
 const linked=await inspector.detail(scope,{topic:'same',jobId:id2});assert.equal(linked.total,1);assert.equal(linked.session.modelId,'deep');assert.equal(linked.records[0].jobId,id2);
 await assert.rejects(inspector.detail(scope,{topic:'same'}),/model session scope/);
 await assert.rejects(inspector.detail(scope,{topic:'same',modelSessionScope:hash('quick'),jobId:id2}));
 await assert.rejects(inspector.detail(scope,{topic:'same',modelSessionScope:'invalid'}));
}));
test('list isolates conversations, decays heat and excludes heartbeat/poll updates',()=>fixture(async state=>{
 const current=1000000000,params={topic:'任务',task:'正文',context:'上下文',constraints:'只读'};
 const saved={jobId:id,scope:hash('chat-a'),...params,status:'completed',createdAt:current-7*86400000,finishedAt:current-7*86400000,heartbeatAt:current,tags:['测试'],requestKey:requestKeyFor(params,'chat-a')};
 const other={...saved,jobId:id2,scope:hash('chat-b'),topic:'其他聊天'};
 await writeFile(join(state,'jobs',id+'.json'),JSON.stringify(saved));await writeFile(join(state,'jobs',id2+'.json'),JSON.stringify(other));
 const inspector=createSessionInspector({state,now:()=>current,jobs:{status(jobId,scope){assert.equal(scope,'chat-a');assert.equal(jobId,id);return saved;}}});
 const first=await inspector.list('chat-a');assert.equal(first.sessions.length,1);assert.equal(first.sessions[0].heat,7.5);assert.equal(first.sessions[0].interactionCount,2);assert.equal(first.sessions[0].updatedAt,saved.finishedAt);
 assert.deepEqual(await inspector.list('chat-a'),first);
 assert.equal((await inspector.list('chat-a',{query:'测试'})).total,1);
 assert.equal((await inspector.list('chat-a',{query:'不存在'})).total,0);
 await assert.rejects(inspector.list('chat-a',{offset:-1}));
}));
test('detail validates request binding, preserves full task and reports missing legacy events',()=>fixture(async state=>{
 const params={topic:'任务',task:'完整任务'.repeat(1000),context:'上下文',constraints:'只读'};
 const saved={jobId:id,scope:hash('chat-a'),topic:params.topic,status:'completed',createdAt:1,requestKey:requestKeyFor(params,'chat-a'),result:{content:[{type:'text',text:JSON.stringify({result:'完成'})}]}};
 await writeFile(join(state,'jobs',id+'.json'),JSON.stringify(saved));
 await writeFile(join(state,'jobs',id+'.request.json'),JSON.stringify({scope:'chat-a',params,runtime:{secret:'hidden'}}));
 const inspector=createSessionInspector({state,jobs:{status:()=>saved}});
 let detail=await inspector.detail('chat-a',{topic:'任务'});assert.equal(detail.records[0].request.task,params.task);assert.equal(detail.records[0].eventsAvailability,'unavailable');assert.equal(detail.records[0].result,'完成');assert.ok(!JSON.stringify(detail).includes('hidden'));
 await writeFile(join(state,'jobs',id+'.request.json'),JSON.stringify({scope:'chat-b',params}));detail=await inspector.detail('chat-a',{topic:'任务'});assert.equal(detail.records[0].request.availability,'unavailable');
 assert.equal((await inspector.detail('chat-b',{topic:'任务'})).total,0);
 await assert.rejects(inspector.detail('chat-a',{topic:'任务',limit:2}));
}));
test('event projection excludes reasoning/refresh and redacts credentials',()=>{
 assert.equal(inspectionEvent({type:'item.completed',item:{type:'reasoning',text:'private'}}),null);
 assert.equal(inspectionEvent({type:'item.completed',item:{type:'command_execution'}},'refresh'),null);
 const event=inspectionEvent({type:'item.completed',item:{id:'call',type:'mcp_tool_call',server:'docs',tool:'read',arguments:{token:'secret-value',url:'https://example.com/?token=secret-value'},result:{text:'Bearer abc'},internalReasoning:'not-allowed'}});
 assert.equal(event.item.server,'docs');assert.ok(!JSON.stringify(event).includes('secret-value'));assert.ok(!JSON.stringify(event).includes('not-allowed'));assert.ok(!JSON.stringify(event).includes('Bearer abc'));
});
test('native inspection registers read scope and uses trusted action session only',async()=>{
 const actions=[];registerInspector({session:{controls:{registerSessionAction:a=>actions.push(a)}}},{list:async(scope,payload)=>({scope,payload}),detail:async()=>{throw Error('private-path');}});
 assert.deepEqual(actions[0].requiredScopes,['operator.read']);assert.equal((await readInspectionResponse((action,payload)=>actions.find(a=>a.id==='inspect-'+action).handler({sessionKey:'trusted',payload}),'list',{sessionKey:'untrusted'})).scope,'trusted');
 assert.ok(!JSON.stringify(await actions[1].handler({sessionKey:'trusted'})).includes('private-path'));
});
test('unfinished task remains visible when a newer task is terminal',()=>fixture(async state=>{
 const rows=[{jobId:id,scope:hash('chat'),topic:'same',status:'running',createdAt:1},{jobId:id2,scope:hash('chat'),topic:'same',status:'failed',createdAt:2}];
 for(const job of rows)await writeFile(join(state,'jobs',job.jobId+'.json'),JSON.stringify(job));
 const inspector=createSessionInspector({state,jobs:{status:id=>rows.find(j=>j.jobId===id)}});
 const result=await inspector.list('chat');assert.equal(result.sessions[0].status,'running');assert.equal(result.sessions[0].activeCount,1);assert.equal(result.sessions[0].taskCount,2);
}));
test('worker persists inspection records privately and records storage omissions',()=>fixture(async state=>{
 const {runWorker}=await import('./worker.mjs');
 const {readFile,stat}=await import('node:fs/promises');
 const root=join(state,'jobs');await writeFile(join(root,id+'.json'),JSON.stringify({jobId:id,status:'queued'}));
 const result=await runWorker({root,id,params:{},scope:'chat',execute:async(_params,context)=>{
  context.onInspectionEvent(inspectionEvent({type:'item.completed',item:{id:'mcp',type:'mcp_tool_call',server:'demo',tool:'read',arguments:{password:'hidden'},result:{count:2}}}));
  context.onInspectionEvent({event:'item.completed',item:{id:'large',type:'command_execution',aggregated_output:'x'.repeat(6*1024*1024)}});
  return {content:[{type:'text',text:JSON.stringify({result:'完成'})}]};
 }});
 assert.equal(result.status,'completed');const file=join(root,id+'.events.jsonl');const saved=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(saved.length,2);assert.equal(saved[0].item.arguments.password,'[redacted]');assert.equal(saved[1].event,'inspection.omitted');assert.equal(saved[1].count,1);assert.equal((await stat(file)).mode&0o777,0o600);
}));
test('list keeps terminal output in detail and unwraps legacy protocol replies',()=>fixture(async state=>{
 const reply='完整结论'.repeat(1000),saved={jobId:id,scope:hash('chat'),topic:'任务',status:'completed',createdAt:1,progress:JSON.stringify({protocol:'codex_result_v1',result:reply}),result:{content:[{type:'text',text:JSON.stringify({result:JSON.stringify({protocol:'codex_result_v1',result:reply})})}]}};
 await writeFile(join(state,'jobs',id+'.json'),JSON.stringify(saved));
 const inspector=createSessionInspector({state,jobs:{status:()=>saved}});
 const list=await inspector.list('chat');assert.equal(list.sessions[0].progress,'执行已完成');assert.ok(!JSON.stringify(list).includes(reply));
 const detail=await inspector.detail('chat',{topic:'任务'});assert.equal(detail.records[0].result,reply);
}));
test('session information aggregates all tasks regardless of detail pagination',()=>fixture(async state=>{
 const rows=[{jobId:id,scope:hash('chat'),topic:'same',sessionId:'worker-session',status:'running',createdAt:100,tags:['older']},{jobId:id2,scope:hash('chat'),topic:'same',status:'completed',createdAt:200,finishedAt:300,tags:['newer']}];
 for(const job of rows)await writeFile(join(state,'jobs',job.jobId+'.json'),JSON.stringify(job));
 const inspector=createSessionInspector({state,now:()=>400,jobs:{status:jobId=>rows.find(job=>job.jobId===jobId)}});
 const first=await inspector.detail('chat',{topic:'same'}),older=await inspector.detail('chat',{topic:'same',offset:1});
 assert.deepEqual(first.session,older.session);assert.equal(first.records[0].jobId,id2);assert.equal(older.records[0].jobId,id);
 assert.equal(first.session.status,'running');assert.equal(first.session.sessionId,'worker-session');assert.equal(first.session.taskCount,2);assert.equal(first.session.interactionCount,3);
 assert.equal(first.session.runningCount,1);assert.equal(first.session.queuedCount,0);assert.equal(first.session.createdAt,100);assert.equal(first.session.updatedAt,300);
 assert.deepEqual(new Set(first.session.tags),new Set(['older','newer']));assert.equal(first.session.heat,(await inspector.list('chat')).sessions[0].heat);
 assert.equal((await inspector.detail('other-chat',{topic:'same'})).session,null);
}));
test('session information preserves a legacy binding without inventing task history',()=>fixture(async state=>{
 await writeFile(join(state,hash('chat')+'.json'),JSON.stringify({legacy:{topic:'legacy',sessionId:'legacy-worker',updatedAt:'2026-10-01T00:00:00Z'}}));
 const inspector=createSessionInspector({state,jobs:{status:()=>{throw Error('no jobs');}}});
 const result=await inspector.detail('chat',{topic:'legacy'});assert.equal(result.session.sessionId,'legacy-worker');assert.equal(result.session.status,'unknown');assert.equal(result.session.taskCount,0);assert.equal(result.session.createdAt,undefined);assert.deepEqual(result.records,[]);
 const list=await inspector.list('chat');assert.deepEqual(list.groupCounts,{active:0,unknown:1,history:0});assert.equal(list.counts.running,0);
}));

test('large inspection roundtrips full messages within host wire budgets',async()=>{
 const deep={};let cursor=deep;for(let i=0;i<40;i++)cursor=cursor.child={};
 const expected={text:'详细工具输出😀'.repeat(20000),events:Array.from({length:5000},(_,i)=>({id:i})),deep,keys:Object.fromEntries(Array.from({length:600},(_,i)=>[i,i]))};
 const actions=[];registerInspector({registerSessionAction:a=>actions.push(a)},{detail:async()=>expected});
 let calls=0;
 const actual=await readInspectionResponse(async(action,payload)=>{
  const response=await actions.find(a=>a.id==='inspect-'+action).handler({sessionKey:'chat',payload});
  assert.ok(response.result.chunk.length<=32000);assert.ok(Buffer.byteLength(JSON.stringify(response.result))<262144);calls++;return response;
 },'detail',{});
 assert.ok(calls>1);assert.deepEqual(actual,expected);
});
test('inspection transfers reject other sessions, invalid indexes and expiry',async()=>{
 let clock=0;const actions=[];registerInspector({registerSessionAction:a=>actions.push(a)},{detail:async()=>({text:'x'.repeat(80000)})},{now:()=>clock});
 const first=await actions[1].handler({sessionKey:'chat'}),transferId=first.result.transferId;
 for(const [sessionKey,index] of [['other',1],['chat',-1],['chat',3],['chat',1.5]])assert.equal((await actions[2].handler({sessionKey,payload:{transferId,index}})).ok,false);
 clock=120001;assert.equal((await actions[2].handler({sessionKey:'chat',payload:{transferId,index:1}})).ok,false);
});
test('inspection reader rejects corrupt chunks and reports transfer errors',async()=>{
 const first={ok:true,result:{encoding:'json-chunks',transferId:'id',totalChunks:2,index:0,chunk:'{'}};
 await assert.rejects(readInspectionResponse(async action=>action==='detail'?first:{ok:true,result:{...first.result,index:1,transferId:'other'}},'detail',{}),/分块不完整/);
 await assert.rejects(readInspectionResponse(async action=>action==='detail'?first:{ok:false,error:'expired'},'detail',{}),/expired/);
});

test('active sessions appear before hotter history across pagination and sorting',()=>fixture(async state=>{
 const current=1000000000;
 const running={jobId:id,scope:hash('chat'),topic:'cold-running',status:'running',createdAt:1};
 const rows=[running,...Array.from({length:31},(_,i)=>({jobId:`${String(i+10).padStart(8,'0')}-1111-4111-8111-111111111111`,scope:hash('chat'),topic:'history-'+i,status:'completed',createdAt:current-i,finishedAt:current-i}))];
 for(const job of rows)await writeFile(join(state,'jobs',job.jobId+'.json'),JSON.stringify(job));
 const inspector=createSessionInspector({state,now:()=>current,jobs:{status:jobId=>rows.find(job=>job.jobId===jobId)}});
 for(const sort of ['heat','recent']){
  const first=await inspector.list('chat',{sort});assert.equal(first.counts.running,1);assert.equal(first.sessions[0].topic,'cold-running');assert.equal(first.sessions.filter(row=>row.status==='running').length,1);assert.deepEqual(first.groupCounts,{active:1,unknown:0,history:31});assert.equal(first.hasMore,true);
  const second=await inspector.list('chat',{sort,offset:30});assert.equal(second.sessions.length,2);assert.deepEqual(second.groupCounts,first.groupCounts);assert.equal(new Set([...first.sessions,...second.sessions].map(row=>row.topic)).size,32);
 }
 const filtered=await inspector.list('chat',{query:'history'});assert.deepEqual(filtered.groupCounts,{active:0,unknown:0,history:31});assert.equal(filtered.counts.running,1);
}));

test('task overview separates all current work from paged history and lazily selects full tasks',()=>fixture(async state=>{
 const scope='chat',topic='same';
 const rows=Array.from({length:34},(_,index)=>{
  const params={topic,task:`历史任务 ${index} token=hidden\n`+'详细目标'.repeat(150),context:'只读上下文',constraints:'不修改'};
  return {params,jobId:`${String(index+10).padStart(8,'0')}-1111-4111-8111-111111111111`,scope:hash(scope),topic,status:index===0?'awaiting_user':index===1?'running':'completed',createdAt:index+1,taskSummary:params.task.slice(0,500),requestKey:requestKeyFor(params,scope)};
 });
 for(const row of rows){await writeFile(join(state,'jobs',row.jobId+'.json'),JSON.stringify(row));await writeFile(join(state,'jobs',row.jobId+'.request.json'),JSON.stringify({scope,params:row.params}));}
 // A different chat must never contribute to current work or history.
 const other={jobId:id,scope:hash('other'),topic,status:'running',createdAt:99,taskSummary:'其他聊天正文'};
 await writeFile(join(state,'jobs',id+'.json'),JSON.stringify(other));
 const inspector=createSessionInspector({state,jobs:{status:jobId=>rows.find(row=>row.jobId===jobId)}});
 const first=await inspector.detail(scope,{topic});
 assert.deepEqual(first.currentTasks.map(task=>task.status),['running','awaiting_user']);
 assert.equal(first.currentTasks[0].index,32);assert.equal(first.historyTotal,32);assert.equal(first.taskHistory.length,30);assert.equal(first.historyHasMore,true);
 assert.equal(first.taskHistory[0].jobId,rows[33].jobId);assert.equal(first.taskHistory[0].index,0);
 assert.ok(!JSON.stringify(first).includes('hidden'));assert.ok(!JSON.stringify(first).includes('其他聊天正文'));
 assert.ok(first.taskHistory.every(task=>task.task.length<=500));assert.ok(first.taskHistory.every(task=>!('events' in task)&&!('context' in task)));
 const second=await inspector.detail(scope,{topic,historyOffset:30});
 assert.equal(second.taskHistory.length,2);assert.equal(second.historyHasMore,false);
 assert.equal(new Set([...first.taskHistory,...second.taskHistory].map(task=>task.jobId)).size,32);
 const selected=await inspector.detail(scope,{topic,jobId:first.currentTasks[0].jobId});
 await assert.rejects(inspector.detail(scope,{topic,jobId:id}));
 assert.equal(selected.records[0].jobId,rows[1].jobId);assert.equal(selected.records[0].request.context,'只读上下文');assert.ok(selected.records[0].request.task.length>500);
 const newer={jobId:id2,scope:hash(scope),topic,status:'queued',createdAt:100,taskSummary:'新任务'};rows.push(newer);await writeFile(join(state,'jobs',id2+'.json'),JSON.stringify(newer));
 const stable=await inspector.detail(scope,{topic,jobId:first.currentTasks[0].jobId});assert.equal(stable.records[0].jobId,selected.records[0].jobId);assert.equal(stable.offset,33);
 await writeFile(join(state,'jobs',rows[1].jobId+'.request.json'),JSON.stringify({scope:'other',params:rows[1].params}));
 assert.equal((await inspector.detail(scope,{topic,jobId:rows[1].jobId})).records[0].request.availability,'unavailable');
 await assert.rejects(inspector.detail(scope,{topic,historyOffset:-1}));await assert.rejects(inspector.detail(scope,{topic,historyOffset:1.5}));
}));
