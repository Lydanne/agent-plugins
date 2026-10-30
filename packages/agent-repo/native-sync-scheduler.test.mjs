import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDailySyncService} from './native-sync-scheduler.mjs';
import {repositoryScheduleBridge as bridge} from './scheduled-tasks.mjs';
async function fixture(t,{time='2026-10-13T00:00:00Z',sync=async()=>({ok:true}),already=false}={}){
 const stateDir=mkdtempSync(join(tmpdir(),'native-sync-test-')),jobs=[],calls=[],queued=[];let now=Date.parse(time);
 const config={agents:{main:{repo:'/isolated',sync:{enabled:true,submoduleSchedule:{time:'08:00',timeZone:'Asia/Shanghai'}}}}};
 const cron={list:async()=>structuredClone(jobs),add:async p=>{const j={...structuredClone(p),id:'native-'+jobs.length,state:{nextRunAtMs:now+86400000}};jobs.push(j);return j;},update:async(id,p)=>Object.assign(jobs.find(j=>j.id===id),p),remove:async id=>{jobs.splice(jobs.findIndex(j=>j.id===id),1);},enqueueRun:async(id,mode)=>{queued.push({id,mode});return {ok:true,enqueued:true,runId:'run-'+queued.length};}};
 const options={clock:()=>now,history:async()=>{if(already)return {status:'failed'};throw Object.assign(Error('not found'),{code:'ENOENT'});}};
 let service=createDailySyncService(config,async(...args)=>{calls.push(args);return sync(...args);},{warn:()=>{}},options);await service.start({stateDir,getCron:()=>cron});
 t.after(async()=>{await service.stop();rmSync(stateDir,{recursive:true,force:true});});
 return {jobs,calls,queued,cron,config,advance:ms=>now+=ms,get service(){return service;},event:()=>({action:'finished',status:'ok',agentId:'main',jobId:jobs[0].id,runAtMs:now}),async restart(){await service.stop();service=createDailySyncService(config,async(...args)=>{calls.push(args);return sync(...args);},{warn:()=>{}},options);await service.start({stateDir,getCron:()=>cron});}};
}
async function operation(action,fields={}){const t=(await bridge.catalog('main',{includeRemoved:true}))[0];return {id:t.id,action,expectedRevision:t.revision,confirmed:true,requestId:crypto.randomUUID(),...fields};}
test('native scheduler owns clock and catch-up; no duplicate run after restart or failure',async t=>{
 const f=await fixture(t,{sync:async()=>{throw Error('failure');}});assert.equal(f.jobs.length,1);assert.deepEqual(f.jobs[0].schedule,{kind:'cron',expr:'0 8 * * *',tz:'Asia/Shanghai',staggerMs:0});assert.equal(f.jobs[0].payload.kind,'script');assert.equal(f.queued.length,1);assert.equal(f.calls.length,0);
 await Promise.all([f.service.onCronChanged(f.event()),f.service.onCronChanged(f.event())]);assert.equal(f.calls.length,1);await f.restart();assert.equal(f.jobs.length,1);assert.equal(f.queued.length,1);assert.equal(f.calls.length,1);
 f.advance(86400000);await f.service.onCronChanged(f.event());assert.equal(f.calls.length,2);
});
test('pre-migration Git receipt prevents same-day catch-up, including failures',async t=>{
 const f=await fixture(t,{already:true});assert.equal(f.queued.length,0);await f.service.onCronChanged(f.event());assert.equal(f.calls.length,0);await assert.rejects(bridge.administer('main',await operation('run')),/今日已有/);
});
test('panel edits, pauses, enables, deletes and restores native system plan without resetting daily history',async t=>{
 const f=await fixture(t,{time:'2026-10-12T23:00:00Z'});await bridge.administer('main',await operation('update',{time:'09:00',timeZone:'Asia/Shanghai'}));assert.equal(f.jobs[0].schedule.expr,'0 9 * * *');
 await bridge.administer('main',await operation('pause'));assert.equal(f.jobs[0].enabled,false);await f.restart();assert.equal(f.jobs[0].enabled,false);assert.equal((await bridge.catalog('main'))[0].schedule.time,'09:00');
 await bridge.administer('main',await operation('resume'));const p=await operation('run');await bridge.administer('main',p);await bridge.administer('main',p);assert.equal(f.queued.length,1);await f.service.onCronChanged(f.event());assert.equal(f.calls.length,1);
 await bridge.administer('main',await operation('remove'));assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].enabled,false);assert.deepEqual(await bridge.catalog('main'),[]);await f.restart();assert.equal(f.jobs[0].enabled,false);await bridge.administer('main',await operation('restore'));assert.equal(f.jobs[0].enabled,false);await bridge.administer('main',await operation('resume'));assert.equal(f.jobs.length,1);await assert.rejects(bridge.administer('main',await operation('run')),/今日已有/);
});
test('scope, stale revision, configuration gate and uncertain native results fail closed',async t=>{
 const f=await fixture(t,{time:'2026-10-12T23:00:00Z'}),p=await operation('pause');await assert.rejects(bridge.administer('other',p),/参数/);await assert.rejects(bridge.administer('main',{...p,confirmed:false}),/参数/);await bridge.administer('main',p);await assert.rejects(bridge.administer('main',{...p,requestId:'stale'}),/已改变/);
 f.config.agents.main.sync.enabled=false;await assert.rejects(bridge.administer('main',await operation('resume')),/配置/);f.config.agents.main.sync.enabled=true;
 f.cron.update=async()=>{throw Error('sensitive detail');};const update=await operation('update',{time:'10:00',timeZone:'Asia/Shanghai'});await assert.rejects(bridge.administer('main',update),/未确认/);assert.equal((await bridge.administer('main',update)).status,'unknown');assert.equal((await bridge.catalog('main'))[0].status,'needs_review');
});
test('stop drains in-flight synchronization and late ticks cannot start new work',async t=>{
 let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const f=await fixture(t,{sync:async()=>{entered();await gate;return {ok:true};}});const fire=f.service.onCronChanged(f.event());await started;let stopped=false;const stop=f.service.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);release();await fire;await stop;await f.service.onCronChanged(f.event());assert.equal(f.calls.length,1);
});
test('no native scheduler means no local timer fallback or repository execution',async()=>{
 let called=false;const service=createDailySyncService({agents:{}},async()=>called=true,{warn:()=>{}});await service.start({});await service.stop();assert.equal(called,false);
});
test('concurrent manual requests and reconciliation cannot double enqueue',async t=>{
 const f=await fixture(t,{time:'2026-10-12T23:00:00Z'});const a=await operation('run'),b=await operation('run');const results=await Promise.allSettled([bridge.administer('main',a),bridge.administer('main',b)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.queued.length,1);await f.service.onCronReconciled();assert.equal(f.queued.length,1);
});
test('tampered native Agent never gets removed via old system binding',async t=>{
 const f=await fixture(t,{time:'2026-10-12T23:00:00Z'});f.jobs[0].agentId='other';await assert.rejects(bridge.administer('main',await operation('remove')),/未确认/);assert.equal(f.jobs.length,1);
});
test('pending native queue can be revoked by removal without leaving an unresumable reservation',async t=>{
 const f=await fixture(t);assert.equal(f.queued.length,1);await bridge.administer('main',await operation('remove'));await bridge.administer('main',await operation('restore'));assert.equal(f.jobs[0].enabled,false);await bridge.administer('main',await operation('resume'));assert.equal((await bridge.catalog('main'))[0].busy,false);await bridge.administer('main',await operation('run'));assert.equal(f.queued.length,2);
});

test('system schedule audit retains operator identity, configuration diffs and uncertain results across restart',async t=>{
 const f=await fixture(t,{time:'2026-10-12T23:00:00Z'}),p=await operation('update',{time:'09:00',timeZone:'Asia/Shanghai'});
 await bridge.administer('main',p,{actor:{kind:'operator',id:'connection'},executor:'control-ui'});await bridge.administer('main',p);await f.restart();
 const event=bridge.audit('main',{targetId:'repo-sync:main',action:'update'});assert.equal(event.total,1);assert.equal(event.records[0].actor.id,'connection');assert.equal(event.records[0].before.schedule.time,'08:00');assert.equal(event.records[0].after.schedule.time,'09:00');assert.equal(bridge.audit('other',{}).total,0);
 f.cron.update=async()=>{throw Error('PRIVATE');};await assert.rejects(bridge.administer('main',await operation('pause')),/未确认/);assert.equal(bridge.audit('main',{status:'unknown'}).total,1);assert.ok(!JSON.stringify(bridge.audit('main',{})).includes('PRIVATE'));
});

test('management preserves synchronization completion that occurs during a native lookup',async t=>{
 let enteredRun,releaseRun;const started=new Promise(r=>enteredRun=r),runGate=new Promise(r=>releaseRun=r);const f=await fixture(t,{sync:async()=>{enteredRun();await runGate;return {ok:true};}}),fire=f.service.onCronChanged(f.event());await started;const p=await operation('remove');
 let enteredList,releaseList;const listing=new Promise(r=>enteredList=r),listGate=new Promise(r=>releaseList=r),list=f.cron.list;f.cron.list=async()=>{enteredList();await listGate;return list();};const removal=bridge.administer('main',p);await listing;releaseRun();await fire;releaseList();await removal;assert.equal(bridge.trash('main')[0].busy,false);
 f.advance(31*86400000);assert.equal((await bridge.purgeTrash('main',Date.parse('2026-12-01T00:00:00Z'))).purged.length,1);
});
test('revoked queued force runs cannot restart synchronization after restore and resume, even with a new runAtMs',async t=>{
 const f=await fixture(t);assert.equal(f.queued.length,1);await bridge.administer('main',await operation('remove'));await bridge.administer('main',await operation('restore'));await bridge.administer('main',await operation('resume'));f.advance(1000);await f.service.onCronChanged({...f.event(),runId:'run-1'});assert.equal(f.calls.length,0);await f.restart();await f.service.onCronChanged({...f.event(),runId:'run-1'});assert.equal(f.calls.length,0);
});

test('native reconciliation retains the cancelled run identity and does not replay its state-only receipt',async t=>{
 const f=await fixture(t);await bridge.administer('main',await operation('pause'));await bridge.administer('main',await operation('resume'));f.advance(1000);await f.service.onCronChanged({...f.event(),runId:'run-1'});const event=f.event();f.jobs[0].state={lastRunStatus:'ok',lastRunAtMs:event.runAtMs};await f.restart();assert.equal(f.calls.length,0);await f.service.onCronChanged({...event,runId:'fresh-clock'});assert.equal(f.calls.length,1);
});
test('periodic clocks retain an unrelated pending manual identity across a date boundary',async t=>{
 const f=await fixture(t);await f.service.onCronChanged({...f.event(),runId:'periodic'});assert.equal(f.calls.length,1);await bridge.administer('main',await operation('pause'));await bridge.administer('main',await operation('resume'));f.advance(86400000);await f.service.onCronChanged({...f.event(),runId:'run-1'});assert.equal(f.calls.length,1);await f.service.onCronChanged({...f.event(),runId:'next-day-periodic'});assert.equal(f.calls.length,2);
});
test('an early failed native terminal cannot leave a later acknowledged run permanently queued',async t=>{
 const f=await fixture(t,{time:'2026-10-12T23:00:00Z'});f.cron.enqueueRun=async()=>{await f.service.onCronChanged({...f.event(),runId:'early-error',status:'error'});return {ok:true,enqueued:true,runId:'early-error'};};await bridge.administer('main',await operation('run'));assert.equal((await bridge.catalog('main'))[0].busy,false);
});
test('a synchronization spanning midnight prevents the next daily clock from starting overlapping work',async t=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const f=await fixture(t,{sync:async()=>{entered();await gate;return {ok:true};}});const running=f.service.onCronChanged({...f.event(),runId:'day-one'});await started;f.advance(86400000);await f.service.onCronChanged({...f.event(),runId:'day-two'});assert.equal(f.calls.length,1);release();await running;
});

test('SDK live automatic clocks without runId remain enabled after cancelling a queued force run',async t=>{
 const f=await fixture(t);await bridge.administer('main',await operation('pause'));await bridge.administer('main',await operation('resume'));f.advance(1000);await f.service.onCronChanged(f.event());assert.equal(f.calls.length,1);f.advance(86400000);await f.service.onCronChanged(f.event());assert.equal(f.calls.length,2);
});
