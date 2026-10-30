import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScheduledRequests} from './scheduled-requests.mjs';
function fixture(t){
 const stateDir=mkdtempSync(join(tmpdir(),'ada-schedule-test-'));const jobs=[];let current=true,active=false,delivered=[];
 const source={agentId:'main',accountId:'a',chatId:'group',sessionKey:'agent:main:feishu:group:g',sessionId:'session',senderId:'u',taskId:'source',revision:0,sourceMessageIds:['m'],requestMessageIds:['m']};
 const cron={add:async input=>{const job={...structuredClone(input),id:'job'+jobs.length};jobs.push(job);return job;},update:async(id,patch)=>Object.assign(jobs.find(j=>j.id===id),patch),remove:async id=>{jobs.splice(jobs.findIndex(j=>j.id===id),1);return {removed:true};},list:async()=>structuredClone(jobs)};
 const bridge={capture:ctx=>({...source,...ctx}),current:()=>current,jobsActive:()=>active,deliver:async(r,cb)=>{cb.assertCurrent();delivered.push(r);return {accepted:true,jobIds:['worker']};}};
 let manager=createScheduledRequests({stateDir,getCron:()=>cron,bridge,now:()=>1000});t.after(()=>{manager.close();rmSync(stateDir,{recursive:true,force:true});});
 const input={action:'create',name:'Daily',requestId:'request',projectId:'xgj',task:'check target',constraints:'read-only target',expr:'0 9 * * *'};
 const event=(slot=2000)=>({action:'finished',status:'ok',jobId:jobs[0].id,agentId:'main',runAtMs:slot});
 return {stateDir,input,cron,jobs,source,bridge,delivered,event,get manager(){return manager;},reopen:()=>{manager.close();manager=createScheduledRequests({stateDir,getCron:()=>cron,bridge,now:()=>1000});},revoke:()=>current=false,busy:()=>active=true};
}
test('native no-op scheduler stores no task content; binding and duplicate creation survive restart',async t=>{const f=fixture(t);const first=await f.manager.manage(f.input,{});assert.equal(f.jobs[0].payload.kind,'script');assert.equal(f.jobs[0].delivery.mode,'none');assert.deepEqual(f.jobs[0].payload.toolsAllow,[]);assert.ok(!JSON.stringify(f.jobs).includes('check target'));f.reopen();assert.equal((await f.manager.manage(f.input,{})).id,first.id);assert.equal(f.jobs.length,1);await assert.rejects(f.manager.manage({...f.input,task:'different'},{}),/different input/);});
test('duplicate callbacks and recovery dispatch only once, retaining requester and project',async t=>{const f=fixture(t);await f.manager.manage(f.input,{});await Promise.all([f.manager.fire(f.event()),f.manager.fire(f.event())]);assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].source.senderId,'u');assert.equal(f.delivered[0].projectId,'xgj');f.jobs[0].state={lastRunStatus:'ok',lastRunAtMs:2000};f.reopen();await f.manager.recover();assert.equal(f.delivered.length,1);});
test('no other requester, account, group or reset session can list or cancel a task',async t=>{const f=fixture(t);const r=await f.manager.manage(f.input,{});for(const key of ['senderId','accountId','chatId','sessionId','agentId']){assert.deepEqual(await f.manager.manage({action:'list'},{[key]:'other'}),{tasks:[],total:0,nextOffset:null});await assert.rejects(f.manager.manage({action:'remove',id:r.id},{[key]:'other'}),/not found/);}});
test('pause and remove prevent late native ticks',async t=>{const f=fixture(t);const r=await f.manager.manage(f.input,{});await f.manager.manage({action:'pause',id:r.id},{});await f.manager.fire(f.event());assert.equal(f.delivered.length,0);await f.manager.manage({action:'remove',id:r.id},{});assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].enabled,false);});
test('revoked sources, altered jobs and foreign-agent events do not dispatch',async t=>{const f=fixture(t);await f.manager.manage(f.input,{});await f.manager.fire({...f.event(),agentId:'other'});f.jobs[0].payload.script='malicious';await f.manager.fire(f.event());f.jobs[0].payload.script='return {};';f.revoke();await f.manager.fire(f.event());assert.equal(f.delivered.length,0);});
test('unknown admission is never replayed and blocks subsequent occurrences',async t=>{const f=fixture(t);await f.manager.manage(f.input,{});f.bridge.deliver=async()=>{throw Error('lost response');};await assert.rejects(f.manager.fire(f.event()),/lost response/);f.reopen();await f.manager.fire(f.event());await f.manager.fire(f.event(3000));const {tasks}=await f.manager.manage({action:'list'},{});assert.equal(tasks[0].lastRun.status,'unknown');assert.equal(tasks[0].runs.length,2);});
test('unfinished worker prevents another occurrence',async t=>{const f=fixture(t);await f.manager.manage(f.input,{});await f.manager.fire(f.event());f.busy();await f.manager.fire(f.event(3000));assert.equal(f.delivered.length,1);});
test('uncertain native add retains requestId and never creates another native job',async t=>{const f=fixture(t);const add=f.cron.add;f.cron.add=async input=>{await add(input);throw Error('unknown');};await assert.rejects(f.manager.manage(f.input,{}),/incomplete/);assert.equal((await f.manager.manage(f.input,{})).status,'needs_review');assert.equal(f.jobs.length,1);});
test('one-shot needs timezone and ends after submission',async t=>{const f=fixture(t);await assert.rejects(f.manager.manage({...f.input,expr:undefined,at:'2030-01-01T09:00:00'},{}),/timezone/);await f.manager.manage({...f.input,expr:undefined,at:'2030-01-01T09:00:00+08:00'},{});await f.manager.fire(f.event());assert.equal((await f.manager.manage({action:'list'},{})).tasks[0].status,'completed');});
test('pause racing with scheduler lookup prevents admission',async t=>{const f=fixture(t);const r=await f.manager.manage(f.input,{});const list=f.cron.list;f.cron.list=async()=>{f.cron.list=list;await f.manager.manage({action:'pause',id:r.id},{});return list();};await f.manager.fire(f.event());assert.equal(f.delivered.length,0);});
test('lost cron callback is recovered only for latest unclaimed occurrence',async t=>{const f=fixture(t);await f.manager.manage(f.input,{});f.jobs[0].state={lastRunStatus:'ok',lastRunAtMs:3000};f.reopen();await f.manager.recover();assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].runAtMs,3000);});
test('service holds the native hook until admission completes, and revokes it on stop',async t=>{
 const {registerScheduledRequests,scheduledRequestBridge}=await import('./scheduled-requests.mjs');
 const stateDir=mkdtempSync(join(tmpdir(),'ada-schedule-service-'));t.after(()=>rmSync(stateDir,{recursive:true,force:true}));
 const source={agentId:'main',accountId:'a',chatId:'g',sessionKey:'s',sessionId:'s1',senderId:'u'};const jobs=[];
 const cron={add:async input=>{const j={...input,id:'native'};jobs.push(j);return j;},update:async(id,p)=>Object.assign(jobs[0],p),list:async()=>jobs};
 let release;const gate=new Promise(resolve=>release=resolve);Object.assign(scheduledRequestBridge,{capture:()=>source,current:()=>true,deliver:async()=>{await gate;return {accepted:true};}});
 t.after(()=>{delete scheduledRequestBridge.capture;delete scheduledRequestBridge.current;delete scheduledRequestBridge.deliver;});
 const manager=createScheduledRequests({stateDir:join(stateDir,'agent-repo-scheduled-requests'),getCron:()=>cron});
 await manager.manage({action:'create',requestId:'r',name:'r',task:'read',constraints:'read-only',projectId:'xgj',expr:'0 9 * * *'},{});manager.close();
 let service;const hooks={};registerScheduledRequests({registerService:s=>service=s,on:(n,h)=>hooks[n]=h,registerTool:()=>{},logger:{warn:()=>{}}},{agents:{main:{repo:'/unused'}}});
 service.start({stateDir,getCron:()=>cron});let finished=false;
 const promise=hooks.cron_changed({action:'finished',status:'ok',jobId:'native',agentId:'main',runAtMs:2000}).then(()=>finished=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);release();await promise;await service.stop();
 assert.equal(hooks.cron_changed({action:'finished'}),undefined);
});
test('management inspection combines native timing and scoped admission receipts without exposing task payloads',async t=>{
 const f=fixture(t);await f.manager.manage(f.input,{});await f.manager.manage({...f.input,requestId:'foreign'}, {agentId:'other'});
 f.jobs[0].state={nextRunAtMs:3000,lastRunStatus:'ok'};await f.manager.fire(f.event());
 const tasks=await f.manager.inspect('main');assert.equal(tasks.length,1);assert.equal(tasks[0].type,'scheduled-request');assert.equal(tasks[0].nextPlanned.at,new Date(3000).toISOString());assert.equal(tasks[0].lastRun.status,'submitted');assert.ok(!JSON.stringify(tasks).includes('read-only target'));assert.equal(tasks[0].records[0].logs.at(-1).status,'worker_submitted');
 assert.deepEqual(await f.manager.inspect('unbound'),[]);
 f.bridge.deliver=async()=>({accepted:true,jobIds:[],deliveryReceipts:[{messageId:'receipt',chatId:'group'}]});await f.manager.fire(f.event(2500));assert.equal((await f.manager.inspect('main'))[0].lastRun.status,'delivered');
 f.cron.list=async()=>{throw Error('offline');};const offline=(await f.manager.inspect('main'))[0];assert.equal(offline.nativeAvailable,false);assert.equal(offline.records.length,2);assert.equal(offline.nextPlanned.state,'unavailable');
});
async function operation(f,id,action,fields={}){const task=(await f.manager.catalog('main',{includeRemoved:true})).tasks.find(t=>t.id===id);return {action,id,expectedRevision:task.revision,requestId:crypto.randomUUID(),confirmed:true,...fields};}
test('panel creates a paused plan from a saved source, retaining task, requester and constraints',async t=>{
 const f=fixture(t),original=await f.manager.manage(f.input,{});const {id,...params}=await operation(f,original.id,'create',{sourceId:original.id,name:'Second',expr:'0 10 * * *'});
 const result=await f.manager.administer('main',params);assert.equal(result.status,'succeeded');assert.equal(f.jobs.length,2);assert.equal(f.jobs[1].enabled,false);
 const created=(await f.manager.catalog('main')).tasks.find(t=>t.id===result.id);assert.equal(created.status,'paused');assert.equal(created.task,f.input.task);assert.equal(created.constraints,f.input.constraints);assert.equal(created.requester,'u');assert.equal(created.chatId,'group');
 assert.deepEqual(await f.manager.administer('main',params),result);assert.equal(f.jobs.length,2);
});
test('panel edits native plan, resumes and removes while retaining audit and run history',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});await f.manager.fire(f.event());
 await f.manager.administer('main',await operation(f,r.id,'pause'));assert.equal(f.jobs[0].enabled,false);
 await f.manager.administer('main',await operation(f,r.id,'update',{name:'New name',expr:'0 8 * * *',timeZone:'Asia/Shanghai'}));assert.equal(f.jobs[0].schedule.expr,'0 8 * * *');assert.equal(f.jobs[0].name,'Ada: New name');assert.equal(f.jobs[0].enabled,false);
 await f.manager.administer('main',await operation(f,r.id,'resume'));assert.equal(f.jobs[0].enabled,true);
 await f.manager.administer('main',await operation(f,r.id,'remove'));assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].enabled,false);assert.equal((await f.manager.catalog('main')).tasks.length,0);const c=await f.manager.catalog('main',{includeRemoved:true});assert.equal(c.tasks[0].runs.length,1);assert.equal(c.operations.length,4);assert.equal(c.tasks[0].status,'removed');
});
test('panel manual execution uses native queue once and leaves the schedule unchanged',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});let calls=0;f.cron.enqueueRun=async(id,mode)=>{calls++;assert.equal(id,r.jobId);assert.equal(mode,'force');return {ok:true,enqueued:true,runId:'manual'};};
 const original=structuredClone(f.jobs[0].schedule),p=await operation(f,r.id,'run');await f.manager.administer('main',p);await f.manager.administer('main',p);assert.equal(calls,1);assert.deepEqual(f.jobs[0].schedule,original);
 await assert.rejects(f.manager.administer('main',await operation(f,r.id,'run')),/运行中/);
 f.bridge.deliver=async r=>{assert.equal(r.trigger,'manual');return {accepted:true,jobIds:[],deliveryReceipts:[{chatId:'group',messageId:'card'}]};};await f.manager.fire({...f.event(),runId:'manual'});assert.equal((await f.manager.catalog('main')).tasks[0].busy,false);assert.match((await f.manager.inspect('main'))[0].records[0].logs[0].reason,/手动执行/);
});
test('panel rejects forged bindings, foreign agents, stale versions and revoked sources',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),p=await operation(f,r.id,'pause');
 await assert.rejects(f.manager.administer('other',p),/不属于/);await assert.rejects(f.manager.administer('main',{...p,chatId:'other'}),/参数/);await assert.rejects(f.manager.administer('main',{...p,task:'changed'}),/参数/);await assert.rejects(f.manager.administer('main',{...p,confirmed:false}),/确认/);
 await f.manager.administer('main',p);await assert.rejects(f.manager.administer('main',{...p,requestId:'stale'}),/已改变/);
 f.revoke();await assert.rejects(f.manager.administer('main',await operation(f,r.id,'resume')),/已失效/);await f.manager.administer('main',await operation(f,r.id,'remove'));assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].enabled,false);
});
test('uncertain writes remain durable and never replay after restart',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),p=await operation(f,r.id,'update',{name:'New',expr:'0 8 * * *'});let calls=0;f.cron.update=async()=>{calls++;throw Error('private backend detail');};
 await assert.rejects(f.manager.administer('main',p),/未确认/);f.reopen();assert.equal((await f.manager.administer('main',p)).status,'unknown');assert.equal(calls,1);assert.equal((await f.manager.catalog('main')).tasks[0].status,'needs_review');assert.ok(!JSON.stringify(await f.manager.catalog('main')).includes('private backend detail'));
});
test('unfinished Main and Worker block editing and replay but allow revocation',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});await f.manager.fire(f.event());f.busy();await assert.rejects(f.manager.administer('main',await operation(f,r.id,'update',{name:'N',expr:'0 8 * * *'})),/运行中/);await f.manager.administer('main',await operation(f,r.id,'pause'));
});
test('concurrent panel edits serialize and stale tick after edit cannot dispatch',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),update=f.cron.update;let release;const gate=new Promise(resolve=>release=resolve);f.cron.update=async(...args)=>{await gate;return update(...args);};
 const p=await operation(f,r.id,'update',{name:'N',expr:'0 8 * * *'}),first=f.manager.administer('main',p);await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.manager.administer('main',await operation(f,r.id,'pause')),/正在变更/);release();await first;await f.manager.fire(f.event(999));assert.equal(f.delivered.length,0);
});
test('expired one-shot cannot resume and missing enqueueRun cannot bypass native scheduler',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});await assert.rejects(f.manager.administer('main',await operation(f,r.id,'run')),/原生入队/);await assert.rejects(f.manager.administer('main',await operation(f,r.id,'update',{name:'N',at:'1970-01-01T00:00:00Z'})),/未来/);assert.equal(f.jobs.length,1);
});
test('native reassignment cannot be removed or executed through the old request',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});f.jobs[0].agentId='other';await assert.rejects(f.manager.administer('main',await operation(f,r.id,'remove')),/未确认/);assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].agentId,'other');
});

async function toolEdit(f,r,fields,action='update',requestId=crypto.randomUUID()){
 const current=await f.manager.manage({action:'get',id:r.id},{});
 return f.manager.manage({action,id:r.id,expectedRevision:current.revision,requestId,...fields},{});
}
test('requester can patch only delivery without replacing job, schedule, task, status or original provenance',async t=>{
 const f=fixture(t);f.source.rootId='original-thread';f.source.replyInThread=true;
 const r=await f.manager.manage({...f.input,expr:'0 7 * * *'},{}),schedule=structuredClone(f.jobs[0].schedule);
 const before=await f.manager.manage({action:'get',id:r.id},{});
 const changed=await toolEdit(f,r,{deliveryMode:'group'});
 assert.equal(changed.id,r.id);assert.equal(changed.jobId,r.jobId);assert.equal(changed.status,'enabled');assert.equal(changed.delivery.target,'group');assert.equal(changed.deliveryMode,'group');assert.notEqual(changed.revision,before.revision);
 assert.deepEqual(changed.schedule,schedule);assert.equal(changed.task,f.input.task);assert.equal(changed.constraints,f.input.constraints);assert.equal(f.jobs.length,1);
 await f.manager.fire(f.event());assert.equal(f.delivered[0].deliveryMode,'group');assert.equal(f.delivered[0].source.rootId,'original-thread');assert.deepEqual(f.delivered[0].source.requestMessageIds,['m']);
 f.reopen();assert.equal((await f.manager.manage({action:'get',id:r.id},{})).deliveryMode,'group');
});
test('partial name, timezone and cron edits preserve other fields and paused state',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});await f.manager.manage({action:'pause',id:r.id},{});
 let changed=await toolEdit(f,r,{name:'Renamed'});assert.equal(f.jobs[0].name,'Ada: Renamed');assert.equal(changed.schedule.expr,f.input.expr);
 changed=await toolEdit(f,r,{timeZone:'UTC'});assert.equal(changed.schedule.expr,f.input.expr);assert.equal(changed.schedule.tz,'UTC');assert.equal(changed.status,'paused');
 changed=await toolEdit(f,r,{expr:'30 7 * * 1-5'});assert.equal(changed.name,'Renamed');assert.equal(changed.schedule.tz,'UTC');assert.equal(f.jobs[0].enabled,false);
 await toolEdit(f,r,{},'resume');assert.equal(f.jobs[0].enabled,true);assert.equal(f.jobs.length,1);
});
test('delivery routes are bounded to original group and known thread; old creates retain source mode',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});assert.equal(r.deliveryMode,'source');assert.equal(r.delivery.canUseThread,false);
 await assert.rejects(toolEdit(f,r,{deliveryMode:'thread'}),/投递位置/);await assert.rejects(toolEdit(f,r,{deliveryMode:'other-group'}),/投递位置/);
 for(const fields of [{chatId:'other'},{rootId:'forged'},{replyInThread:true},{constraints:'expand scope'},{projectId:'other'}])await assert.rejects(toolEdit(f,r,fields),/parameters/);
 assert.equal((await f.manager.manage({action:'get',id:r.id},{})).revision,r.revision);
 f.source.rootId='known';const second=await f.manager.manage({...f.input,requestId:'threaded',deliveryMode:'thread'},{});assert.equal(second.delivery.target,'thread');
 await toolEdit(f,second,{deliveryMode:'source'});assert.equal((await f.manager.manage({action:'get',id:second.id},{})).deliveryMode,'source');
});
test('requester update uses stable keys and revisions; retries after restart do not mutate twice',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),p={action:'update',id:r.id,expectedRevision:r.revision,requestId:'update-route',deliveryMode:'group'};
 const first=await f.manager.manage(p,{});f.reopen();const second=await f.manager.manage(Object.fromEntries(Object.entries(p).reverse()),{});assert.deepEqual(second,first);
 await assert.rejects(f.manager.manage({...p,requestId:'stale'},{}),/已改变/);
 await assert.rejects(f.manager.manage({...p,deliveryMode:'source'},{}),/用于其他操作/);
 await assert.rejects(f.manager.manage({action:'update',id:r.id,deliveryMode:'source'},{}),/expectedRevision/);
});
test('list filters and pagination and detailed history stay inside requester and conversation scope',async t=>{
 const f=fixture(t),a=await f.manager.manage(f.input,{}),b=await f.manager.manage({...f.input,name:'Other',requestId:'two'},{});
 await f.manager.manage({...f.input,name:'Foreign',requestId:'foreign'}, {senderId:'other'});
 const list=await f.manager.manage({action:'list',limit:1},{});assert.equal(list.total,2);assert.equal(list.nextOffset,1);assert.equal(list.tasks.length,1);
 const next=await f.manager.manage({action:'list',limit:1,offset:list.nextOffset},{});assert.equal(next.tasks[0].id,b.id);assert.equal(next.nextOffset,null);
 assert.equal((await f.manager.manage({action:'list',query:'daily',projectId:'xgj',status:'enabled'},{})).tasks[0].id,a.id);
 await f.manager.fire(f.event());await f.manager.fire(f.event(3000));const history=await f.manager.manage({action:'history',id:a.id,limit:1},{});assert.equal(history.total,2);assert.equal(history.nextOffset,1);assert.equal(history.records[0].at,3000);assert.deepEqual(history.records[0].detail.jobIds,['worker']);
 for(const action of ['get','history','update','resume','run'])await assert.rejects(f.manager.manage({action,id:a.id},{senderId:'other'}),/not found/);
 for(const params of [{action:'list',offset:-1},{action:'history',id:a.id,limit:101},{action:'list',status:'bogus'},{action:'list',query:12}])await assert.rejects(f.manager.manage(params,{}));
});
test('tool run uses native queue once, and update cannot change a pending occurrence route',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});let calls=0;f.cron.enqueueRun=async()=>{calls++;return {ok:true,enqueued:true,runId:'native-run'};};
 const p={action:'run',id:r.id,expectedRevision:r.revision,requestId:'run-once'};
 await f.manager.manage(p,{});await f.manager.manage(p,{});assert.equal(calls,1);
 await assert.rejects(toolEdit(f,r,{deliveryMode:'group'}),/运行中/);
 await f.manager.fire(f.event());assert.equal(f.delivered[0].deliveryMode,'source');
});
test('completed one-shot can be edited in place and explicitly resumed with a future time',async t=>{
 const f=fixture(t),r=await f.manager.manage({...f.input,expr:undefined,at:'2030-01-01T00:00:00Z'},{});await f.manager.fire(f.event());
 let changed=await toolEdit(f,r,{at:'2031-01-01T00:00:00Z'});assert.equal(changed.status,'paused');
 changed=await toolEdit(f,r,{},'resume');assert.equal(changed.status,'enabled');assert.equal(f.jobs.length,1);assert.equal(changed.id,r.id);
});
test('tool schema exposes management actions and bounded delivery without accepting arbitrary destination IDs',async()=>{
 const {scheduledRequestToolParameters}=await import('./scheduled-requests.mjs');
 const {default:Ajv}=await import('ajv');const validate=new Ajv().compile(scheduledRequestToolParameters);
 for(const action of ['get','history','update','resume','run'])assert.ok(scheduledRequestToolParameters.properties.action.enum.includes(action));
 assert.equal(validate({action:'update',id:'one',deliveryMode:'group'}),true);
 assert.equal(validate({action:'update',id:'one',chatId:'other'}),false);assert.equal(validate({action:'update',deliveryMode:'dm'}),false);
});

test('pause/remove with a stable key but optional revision remains idempotent',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});
 for(const action of ['pause','remove']){
  const p={action,id:r.id,requestId:'stable-'+action};const first=await f.manager.manage(p,{});f.reopen();assert.deepEqual(await f.manager.manage(p,{}),first);
 }
 assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].enabled,false);assert.equal((await f.manager.manage({action:'history',id:r.id},{})).operations.length,2);
});
test('a pending routing mutation cannot admit a new tick before native acknowledgment',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),update=f.cron.update;let release;
 const gate=new Promise(resolve=>release=resolve);f.cron.update=async(...args)=>{await gate;return update(...args);};
 const editing=toolEdit(f,r,{deliveryMode:'group'});await new Promise(resolve=>setImmediate(resolve));
 await f.manager.fire(f.event());assert.equal(f.delivered.length,0);release();await editing;
 await f.manager.fire(f.event(3000));assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].deliveryMode,'group');
});

test('routing update during a tick lookup skips the stale snapshot without creating unknown admission',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),list=f.cron.list;let release;
 const gate=new Promise(resolve=>release=resolve);f.cron.list=async()=>{f.cron.list=list;await gate;return list();};
 const firing=f.manager.fire(f.event());await new Promise(resolve=>setImmediate(resolve));
 await toolEdit(f,r,{deliveryMode:'group'});release();await firing;
 assert.equal(f.delivered.length,0);assert.equal((await f.manager.manage({action:'get',id:r.id},{})).runs.length,0);
 await f.manager.fire(f.event(3000));assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].deliveryMode,'group');
});

test('schedule audit attributes each change to its current human message, retains diffs, and deduplicates across restart',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});
 const p={action:'update',id:r.id,requestId:'route-change',expectedRevision:r.revision,deliveryMode:'group'};
 const changed=await f.manager.manage(p,{requestMessageIds:['change-message'],people:{requester:{name:'真人甲'}}});
 let history=await f.manager.manage({action:'audit',id:r.id},{});assert.equal(history.total,2);
 const event=history.records.find(r=>r.action==='update');assert.equal(event.actor.id,'u');assert.equal(event.actor.name,'真人甲');assert.deepEqual(event.actor.messageIds,['change-message']);assert.equal(event.executor,'agent_schedule');
 assert.deepEqual(event.changes.find(c=>c.field==='deliveryMode'),{field:'deliveryMode',before:'source',after:'group'});assert.equal(event.status,'succeeded');assert.equal(changed.jobId,r.jobId);
 await f.manager.manage(p,{});f.reopen();await f.manager.manage(p,{});history=await f.manager.manage({action:'audit',id:r.id},{});assert.equal(history.total,2);
 for(const ctx of [{senderId:'foreign'},{agentId:'foreign'},{chatId:'foreign'},{sessionId:'reset'}])await assert.rejects(f.manager.manage({action:'audit',id:r.id},ctx),/not found/);
 await assert.rejects(f.manager.manage({action:'update',...p,actor:{id:'spoof'}},{}),/Unsupported/);
});
test('unknown native writes preserve intent and saved-state changes without asserting success or replaying',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.update=async()=>{throw Error('SECRET_NATIVE_ERROR');};
 await assert.rejects(f.manager.manage({action:'update',id:r.id,requestId:'lost-update',expectedRevision:r.revision,deliveryMode:'group'},{}),/未确认/);
 f.reopen();const result=f.manager.audit('main',{targetId:r.id,status:'unknown'});assert.equal(result.total,1);assert.equal(result.records[0].requested.deliveryMode,'group');assert.equal(result.records[0].after.status,'needs_review');assert.ok(!JSON.stringify(result).includes('SECRET_NATIVE_ERROR'));
 assert.equal(f.manager.audit('foreign',{}).total,0);
});
test('operator attribution is separate from original plan requester and cannot be supplied through payload',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),p={action:'pause',id:r.id,requestId:'operator-pause',expectedRevision:r.revision,confirmed:true};
 await f.manager.administer('main',p,{actor:{kind:'operator',id:'trusted-connection'},executor:'control-ui'});
 const event=f.manager.audit('main',{action:'pause'}).records[0];assert.equal(event.actor.id,'trusted-connection');assert.equal(event.executor,'control-ui');assert.notEqual(event.actor.id,'u');
 await assert.rejects(f.manager.administer('main',{...p,actor:{id:'spoof'}}),/参数/);
 await f.manager.administer('main',p);assert.equal(f.manager.audit('main',{action:'pause'}).total,1);
});

test('an unavailable audit writer blocks schedule mutation before any native change',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const f=fixture(t),r=await f.manager.manage(f.input,{}),db=new DatabaseSync(join(f.stateDir,'scheduled-requests.sqlite'));
 db.exec("CREATE TRIGGER audit_write_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");db.close();
 await assert.rejects(f.manager.manage({action:'update',id:r.id,requestId:'blocked-audit',expectedRevision:r.revision,deliveryMode:'group'},{}),/audit unavailable/);
 const saved=await f.manager.manage({action:'get',id:r.id},{});assert.equal(saved.revision,r.revision);assert.equal(saved.deliveryMode,'source');assert.equal(f.jobs[0].enabled,true);
});

for(const action of ['pause','remove'])test(`queued manual run is fenced on ${action}, allowing safe restore/resume without old tick resurrection`,async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.enqueueRun=async()=>({ok:true,enqueued:true,runId:'old-force'});await f.manager.administer('main',await operation(f,r.id,'run'));await f.manager.administer('main',await operation(f,r.id,action));
 assert.equal((await f.manager.catalog('main',{includeRemoved:true})).tasks[0].busy,false);if(action==='remove')await f.manager.administer('main',await operation(f,r.id,'restore'));await f.manager.administer('main',await operation(f,r.id,'resume'));f.reopen();await f.manager.fire({...f.event(5000),runId:'old-force'});assert.equal(f.delivered.length,0);
});
test('a failed manual clock terminal clears its known reservation but an unacknowledged run stays protected',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.enqueueRun=async()=>({ok:true,enqueued:true,runId:'failed-clock'});await f.manager.administer('main',await operation(f,r.id,'run'));await f.manager.fire({...f.event(),runId:'failed-clock',status:'error'});assert.equal((await f.manager.catalog('main')).tasks[0].busy,false);
 f.cron.enqueueRun=async()=>({ok:true,enqueued:true});await assert.rejects(f.manager.administer('main',await operation(f,r.id,'run')),/未确认/);assert.equal((await f.manager.catalog('main')).tasks[0].status,'needs_review');assert.equal((await f.manager.catalog('main')).tasks[0].busy,true);
});
test('stopping a plan preserves an already accepted Main receipt and the live Worker identity',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.bridge.deliver=async(run,cb)=>{cb.onAccepted();entered();await gate;cb.assertCurrent();return {accepted:true,jobIds:['in-flight-worker']};};const firing=f.manager.fire(f.event());await started;
 const update=f.cron.update;let enteredUpdate,releaseUpdate;const updating=new Promise(resolve=>enteredUpdate=resolve),updateGate=new Promise(resolve=>releaseUpdate=resolve);f.cron.update=async(...args)=>{enteredUpdate();await updateGate;return update(...args);};const stopping=f.manager.administer('main',await operation(f,r.id,'pause'));await updating;release();await firing;releaseUpdate();await stopping;
 const saved=(await f.manager.catalog('main')).tasks[0];assert.equal(saved.lastRun.status,'submitted');assert.deepEqual(saved.lastRun.jobIds,['in-flight-worker']);f.busy();assert.equal((await f.manager.catalog('main')).tasks[0].busy,true);
});

test('legacy queued-run receipts recover a paused reservation without reviving an old native tick',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.enqueueRun=async()=>({ok:true,enqueued:true,runId:'legacy-run'});await f.manager.administer('main',await operation(f,r.id,'run'));
 const db=new DatabaseSync(join(f.stateDir,'scheduled-requests.sqlite'));const saved=JSON.parse(db.prepare('SELECT body FROM requests WHERE id=?').get(r.id).body);saved.status='paused';delete saved.manualPending.runId;db.prepare('UPDATE requests SET body=? WHERE id=?').run(JSON.stringify(saved),r.id);db.close();f.jobs[0].enabled=false;f.reopen();await f.manager.recover();assert.equal((await f.manager.catalog('main')).tasks[0].busy,false);await f.manager.administer('main',await operation(f,r.id,'resume'));await f.manager.fire({...f.event(6000),runId:'legacy-run'});assert.equal(f.delivered.length,0);
});

test('recovery cannot erase the identity of a revoked force run, while future identified clocks still run',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.enqueueRun=async()=>({ok:true,enqueued:true,runId:'revoked'});await f.manager.administer('main',await operation(f,r.id,'run'));await f.manager.administer('main',await operation(f,r.id,'pause'));await f.manager.administer('main',await operation(f,r.id,'resume'));
 await f.manager.fire({...f.event(5000),runId:'revoked'});f.jobs[0].state={lastRunStatus:'ok',lastRunAtMs:5000};f.reopen();await f.manager.recover();assert.equal(f.delivered.length,0);
 // No callback identity was saved for this other state-only slot: it remains unclaimed.
 f.jobs[0].state.lastRunAtMs=6000;await f.manager.recover();assert.equal(f.delivered.length,0);await f.manager.fire({...f.event(7000),runId:'future-periodic'});assert.equal(f.delivered.length,1);
});
test('terminal-before-enqueue acknowledgment does not recreate an already finished reservation',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.enqueueRun=async()=>{await f.manager.fire({...f.event(),runId:'early-error',status:'error'});return {ok:true,enqueued:true,runId:'early-error'};};await f.manager.administer('main',await operation(f,r.id,'run'));assert.equal((await f.manager.catalog('main')).tasks[0].busy,false);
});
test('a periodic occurrence cannot consume a different queued manual run',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.enqueueRun=async()=>({ok:true,enqueued:true,runId:'queued-manual'});await f.manager.administer('main',await operation(f,r.id,'run'));await f.manager.fire({...f.event(),runId:'periodic'});assert.equal((await f.manager.catalog('main')).tasks[0].manualPending,true);assert.equal(f.delivered[0].trigger,'scheduled');await f.manager.administer('main',await operation(f,r.id,'pause'));await f.manager.administer('main',await operation(f,r.id,'resume'));await f.manager.fire({...f.event(4000),runId:'queued-manual'});assert.equal(f.delivered.length,1);
});
test('manual lookup races cannot overwrite a newly submitted active Worker receipt',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),list=f.cron.list;let entered,release,first=true;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let enqueued=0;f.cron.enqueueRun=async()=>{enqueued++;return {ok:true,enqueued:true,runId:'manual'};};f.cron.list=async()=>{if(first){first=false;entered();await gate;}return list();};
 const running=f.manager.administer('main',await operation(f,r.id,'run'));await started;await f.manager.fire({...f.event(),runId:'periodic'});f.busy();release();await assert.rejects(running,/本次未入队/);const saved=(await f.manager.catalog('main')).tasks[0];assert.deepEqual(saved.lastRun.jobIds,['worker']);assert.equal(saved.status,'enabled');assert.equal(enqueued,0);assert.equal(f.delivered.length,1);
});
test('claiming a clock after lookup revalidates the latest active Worker state',async t=>{
 const f=fixture(t);await f.manager.manage(f.input,{});const list=f.cron.list;let entered,release,first=true;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.cron.list=async()=>{if(first){first=false;entered();await gate;}return list();};const delayed=f.manager.fire({...f.event(3000),runId:'delayed'});await started;await f.manager.fire({...f.event(2000),runId:'first'});f.busy();release();await delayed;assert.equal(f.delivered.length,1);
});
test('startup clears a reservation already durably fenced before an interrupted old consume',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.enqueueRun=async()=>({ok:true,enqueued:true,runId:'crash-fenced'});await f.manager.administer('main',await operation(f,r.id,'run'));const db=new DatabaseSync(join(f.stateDir,'scheduled-requests.sqlite'));db.prepare('INSERT INTO revoked_native_runs VALUES(?,?)').run(r.jobId,'crash-fenced');db.close();f.reopen();assert.equal((await f.manager.catalog('main')).tasks[0].busy,false);await f.manager.fire({...f.event(),runId:'crash-fenced'});assert.equal(f.delivered.length,0);
});

test('live automatic clocks without runId continue after revocation, while identity-less recovery stays guarded',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});f.cron.enqueueRun=async()=>({ok:true,enqueued:true,runId:'revoked-force'});await f.manager.administer('main',await operation(f,r.id,'run'));await f.manager.administer('main',await operation(f,r.id,'pause'));await f.manager.administer('main',await operation(f,r.id,'resume'));
 await f.manager.fire(f.event(6000));await f.manager.fire(f.event(7000));assert.equal(f.delivered.length,2);f.jobs[0].state={lastRunStatus:'ok',lastRunAtMs:8000};f.reopen();await f.manager.recover();assert.equal(f.delivered.length,2);await f.manager.fire({...f.event(9000),runId:'revoked-force'});f.jobs[0].state.lastRunAtMs=9000;await f.manager.recover();assert.equal(f.delivered.length,2);
});

test('an early successful native hook waits for identity binding without making enqueue wait for Main',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});let firing,entered,release;const mainStarted=new Promise(resolve=>entered=resolve),mainGate=new Promise(resolve=>release=resolve);f.bridge.deliver=async run=>{f.delivered.push(run);entered();await mainGate;return {accepted:true,jobIds:[]};};
 f.cron.enqueueRun=async()=>{firing=f.manager.fire({...f.event(),runId:'early-success'});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.delivered.length,0);return {ok:true,enqueued:true,runId:'early-success'};};
 try{const receipt=await f.manager.administer('main',await operation(f,r.id,'run'));assert.equal(receipt.enqueued,true);await mainStarted;assert.equal(f.delivered[0].trigger,'manual');}finally{release();if(firing)await firing;}
 assert.match((await f.manager.inspect('main'))[0].records[0].logs[0].reason,/手动执行/);
});

test('concurrent Agents using the same request ID keep independent native ACK bindings',async t=>{
 const f=fixture(t),a=await f.manager.manage(f.input,{}),b=await f.manager.manage(f.input,{agentId:'other',sessionKey:'agent:other:feishu:group:g',sessionId:'other-session'});let ackA,ackB;const gateA=new Promise(resolve=>ackA=resolve),gateB=new Promise(resolve=>ackB=resolve);f.cron.enqueueRun=id=>id===a.jobId?gateA:gateB;
 const p=(plan)=>({id:plan.id,action:'run',requestId:'shared-request',expectedRevision:plan.revision,confirmed:true}),runningA=f.manager.administer('main',p(a)),runningB=f.manager.administer('other',p(b));await new Promise(resolve=>setImmediate(resolve));ackB({ok:true,enqueued:true,runId:'agent-B'});await runningB;
 const firingA=f.manager.fire({action:'finished',status:'ok',agentId:'main',jobId:a.jobId,runId:'agent-A',runAtMs:2000});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.delivered.length,0);ackA({ok:true,enqueued:true,runId:'agent-A'});await runningA;await firingA;assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].trigger,'manual');assert.equal(f.delivered[0].source.agentId,'main');assert.equal((await f.manager.catalog('main')).tasks[0].manualPending,false);
 await f.manager.fire({action:'finished',status:'ok',agentId:'other',jobId:b.jobId,runId:'agent-B',runAtMs:2000});assert.equal(f.delivered.length,2);assert.equal(f.delivered[1].source.agentId,'other');assert.equal((await f.manager.catalog('other')).tasks[0].manualPending,false);
});

test('task text update retains plan, permissions, provenance and schedule, audits the diff and survives restart',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),originalJob=structuredClone(f.jobs[0]);
 const p={action:'update',id:r.id,requestId:'edit-task',expectedRevision:r.revision,task:'Report Runtime errors and work errors in separate sections'};
 const changed=await f.manager.manage(p,{});
 assert.equal(changed.task,p.task);assert.equal(changed.id,r.id);assert.equal(changed.jobId,r.jobId);assert.equal(changed.status,'enabled');assert.notEqual(changed.revision,r.revision);
 assert.equal(changed.constraints,r.constraints);assert.equal(changed.projectId,r.projectId);assert.deepEqual(changed.schedule,r.schedule);assert.deepEqual(f.jobs[0],originalJob);
 const audit=await f.manager.manage({action:'audit',id:r.id},{}),edit=audit.records.find(a=>a.requestId===p.requestId);
 assert.deepEqual(edit.changes.find(c=>c.field==='task'),{field:'task',before:r.task,after:p.task});assert.equal(edit.actor.id,f.source.senderId);assert.equal(edit.requested.task,p.task);
 f.reopen();assert.equal((await f.manager.manage(p,{})).operation.status,'succeeded');
 await assert.rejects(f.manager.manage({...p,task:'different'},{}),/用于其他操作/);
 await assert.rejects(f.manager.manage({...p,requestId:'stale'},{}),/已改变/);
 // Retrying the original create keeps its original idempotency input and never restores old text.
 assert.equal((await f.manager.manage(f.input,{})).task,p.task);assert.equal(f.jobs.length,1);
 await f.manager.fire(f.event());assert.equal(f.delivered[0].task,p.task);assert.equal(f.delivered[0].constraints,r.constraints);assert.deepEqual(f.delivered[0].source,f.source);
});
test('task editing validates content, preserves paused state and forbids permission or source changes',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});
 for(const task of ['', '   ',null,1,'x'.repeat(4001)])await assert.rejects(toolEdit(f,r,{task}),/正文/);
 assert.equal((await f.manager.manage({action:'get',id:r.id},{})).revision,r.revision);
 for(const key of ['senderId','accountId','chatId','sessionId','agentId'])await assert.rejects(f.manager.manage({action:'update',id:r.id,requestId:'foreign',expectedRevision:r.revision,task:'new'}, {[key]:'other'}),/not found/);
 await assert.rejects(toolEdit(f,r,{task:'new',constraints:'write'}),/parameters/);
 await assert.rejects(toolEdit(f,r,{task:'new',projectId:'other'}),/parameters/);
 await toolEdit(f,r,{},'pause');const paused=await toolEdit(f,r,{task:'x'.repeat(4000)});assert.equal(paused.status,'paused');assert.equal(f.jobs[0].enabled,false);
 const p=await operation(f,r.id,'update',{task:'Panel revision'});assert.equal((await f.manager.administer('main',p)).status,'succeeded');assert.equal((await f.manager.manage({action:'get',id:r.id},{})).task,p.task);
 const {id,...create}=await operation(f,r.id,'create',{sourceId:r.id,name:'Copy',expr:'0 7 * * *',task:'new'});
 await assert.rejects(f.manager.administer('main',create),/继承来源/);assert.equal(f.jobs.length,1);
 f.revoke();await assert.rejects(toolEdit(f,r,{task:'revoked'}),/失效/);
});
test('accepted execution retains old task snapshot and active work blocks task edits until settled',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});await f.manager.fire(f.event());
 f.busy();await assert.rejects(toolEdit(f,r,{task:'next task'}),/运行中/);
 assert.equal((await f.manager.manage({action:'get',id:r.id},{})).task,r.task);
 f.bridge.jobsActive=()=>false;await toolEdit(f,r,{task:'next task'});
 assert.equal(f.delivered[0].task,r.task);await f.manager.fire(f.event(3000));assert.equal(f.delivered[1].task,'next task');
});
test('task edit fences concurrent dispatch and unknown native mutation cannot be blindly replayed',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});const update=f.cron.update;let release;
 const gate=new Promise(resolve=>release=resolve);f.cron.update=async(...args)=>{await gate;return update(...args);};
 const edit=toolEdit(f,r,{task:'future'});await new Promise(resolve=>setImmediate(resolve));await f.manager.fire(f.event());assert.equal(f.delivered.length,0);release();await edit;
 await f.manager.fire(f.event(3000));assert.equal(f.delivered[0].task,'future');
 const p={action:'update',id:r.id,requestId:'unknown-task',expectedRevision:(await f.manager.manage({action:'get',id:r.id},{})).revision,task:'uncertain'};let calls=0;
 f.cron.update=async()=>{calls++;throw Error('lost acknowledgement');};await assert.rejects(f.manager.manage(p,{}),/未确认/);
 f.reopen();const retry=await f.manager.manage(p,{});assert.equal(retry.operation.status,'unknown');assert.equal(retry.status,'needs_review');assert.equal(calls,1);
 await f.manager.fire(f.event(4000));assert.equal(f.delivered.length,1);
});
