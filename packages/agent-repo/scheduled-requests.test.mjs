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
 return {input,cron,jobs,source,bridge,delivered,event,get manager(){return manager;},reopen:()=>{manager.close();manager=createScheduledRequests({stateDir,getCron:()=>cron,bridge,now:()=>1000});},revoke:()=>current=false,busy:()=>active=true};
}
test('native no-op scheduler stores no task content; binding and duplicate creation survive restart',async t=>{const f=fixture(t);const first=await f.manager.manage(f.input,{});assert.equal(f.jobs[0].payload.kind,'script');assert.equal(f.jobs[0].delivery.mode,'none');assert.deepEqual(f.jobs[0].payload.toolsAllow,[]);assert.ok(!JSON.stringify(f.jobs).includes('check target'));f.reopen();assert.equal((await f.manager.manage(f.input,{})).id,first.id);assert.equal(f.jobs.length,1);await assert.rejects(f.manager.manage({...f.input,task:'different'},{}),/different input/);});
test('duplicate callbacks and recovery dispatch only once, retaining requester and project',async t=>{const f=fixture(t);await f.manager.manage(f.input,{});await Promise.all([f.manager.fire(f.event()),f.manager.fire(f.event())]);assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].source.senderId,'u');assert.equal(f.delivered[0].projectId,'xgj');f.jobs[0].state={lastRunStatus:'ok',lastRunAtMs:2000};f.reopen();await f.manager.recover();assert.equal(f.delivered.length,1);});
test('no other requester, account, group or reset session can list or cancel a task',async t=>{const f=fixture(t);const r=await f.manager.manage(f.input,{});for(const key of ['senderId','accountId','chatId','sessionId','agentId']){assert.deepEqual(await f.manager.manage({action:'list'},{[key]:'other'}),{tasks:[]});await assert.rejects(f.manager.manage({action:'remove',id:r.id},{[key]:'other'}),/not found/);}});
test('pause and remove prevent late native ticks',async t=>{const f=fixture(t);const r=await f.manager.manage(f.input,{});await f.manager.manage({action:'pause',id:r.id},{});await f.manager.fire(f.event());assert.equal(f.delivered.length,0);await f.manager.manage({action:'remove',id:r.id},{});assert.equal(f.jobs.length,0);});
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
async function operation(f,id,action,fields={}){const task=(await f.manager.catalog('main')).tasks.find(t=>t.id===id);return {action,id,expectedRevision:task.revision,requestId:crypto.randomUUID(),confirmed:true,...fields};}
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
 await f.manager.administer('main',await operation(f,r.id,'remove'));assert.equal(f.jobs.length,0);const c=await f.manager.catalog('main');assert.equal(c.tasks[0].runs.length,1);assert.equal(c.operations.length,4);assert.equal(c.tasks[0].status,'removed');
});
test('panel manual execution uses native queue once and leaves the schedule unchanged',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{});let calls=0;f.cron.enqueueRun=async(id,mode)=>{calls++;assert.equal(id,r.jobId);assert.equal(mode,'force');return {ok:true,enqueued:true,runId:'manual'};};
 const original=structuredClone(f.jobs[0].schedule),p=await operation(f,r.id,'run');await f.manager.administer('main',p);await f.manager.administer('main',p);assert.equal(calls,1);assert.deepEqual(f.jobs[0].schedule,original);
 await assert.rejects(f.manager.administer('main',await operation(f,r.id,'run')),/运行中/);
 f.bridge.deliver=async r=>{assert.equal(r.trigger,'manual');return {accepted:true,jobIds:[],deliveryReceipts:[{chatId:'group',messageId:'card'}]};};await f.manager.fire(f.event());assert.equal((await f.manager.catalog('main')).tasks[0].busy,false);assert.match((await f.manager.inspect('main'))[0].records[0].logs[0].reason,/手动执行/);
});
test('panel rejects forged bindings, foreign agents, stale versions and revoked sources',async t=>{
 const f=fixture(t),r=await f.manager.manage(f.input,{}),p=await operation(f,r.id,'pause');
 await assert.rejects(f.manager.administer('other',p),/不属于/);await assert.rejects(f.manager.administer('main',{...p,chatId:'other'}),/参数/);await assert.rejects(f.manager.administer('main',{...p,task:'changed'}),/参数/);await assert.rejects(f.manager.administer('main',{...p,confirmed:false}),/确认/);
 await f.manager.administer('main',p);await assert.rejects(f.manager.administer('main',{...p,requestId:'stale'}),/已改变/);
 f.revoke();await assert.rejects(f.manager.administer('main',await operation(f,r.id,'resume')),/已失效/);await f.manager.administer('main',await operation(f,r.id,'remove'));assert.equal(f.jobs.length,0);
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
