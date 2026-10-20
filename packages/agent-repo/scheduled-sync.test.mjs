import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readSyncHistory} from './sync-history.mjs';
import {resolveSync} from './configuration.mjs';
import {git} from './repository-skills.mjs';
import {claimDailySync,createDailySyncService,scheduleDate} from './scheduled-sync.mjs';
const schedule={time:'08:00',timeZone:'Asia/Shanghai'};
test('daily schedule validates strict clock and time zone without changing legacy defaults',()=>{
 assert.equal(resolveSync({enabled:true}).submoduleSchedule,undefined);
 assert.deepEqual(resolveSync({enabled:true,submoduleSchedule:schedule}).submoduleSchedule,schedule);
 for(const value of [{...schedule,time:'24:00'},{...schedule,time:'8:00'},{...schedule,timeZone:'invalid'}, {...schedule,command:'git reset'},null])assert.throws(()=>resolveSync({submoduleSchedule:value}));
});
test('daily due dates use configured timezone and allow one catch-up after the scheduled time',()=>{
 assert.equal(scheduleDate(new Date('2026-10-12T23:59:59Z'),schedule),null);
 assert.equal(scheduleDate(new Date('2026-10-13T00:00:00Z'),schedule),'2026-10-13');
 assert.equal(scheduleDate(new Date('2026-10-13T08:00:00Z'),schedule),'2026-10-13');
 assert.equal(scheduleDate(new Date('2026-10-13T16:00:00Z'),schedule),null);
 assert.equal(scheduleDate(new Date('2026-10-13T16:00:00Z'),{time:'00:00',timeZone:'UTC'}),'2026-10-13');
});
test('exclusive persisted daily receipt prevents concurrent and restarted replays even after failure',async t=>{
 const base=fileURLToPath(new URL('../../.tmp/daily-sync-tests/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await git(root,['init','-b','main']);
 const receipts=await Promise.all([claimDailySync(root,'main','2026-10-13'),claimDailySync(root,'main','2026-10-13')]);
 assert.equal(receipts.filter(Boolean).length,1);
 await receipts.find(Boolean).finish({ok:false,reason:'preserved local changes'});
 assert.equal(await claimDailySync(root,'main','2026-10-13'),null);
 const stored=JSON.parse(await readFile(join(root,'.git/agent-repo-daily-sync-main-2026-10-13.json'),'utf8'));
 assert.equal(stored.status,'failed');assert.equal(stored.result.reason,'preserved local changes');assert.equal(stored.taskId,'repo-sync:main');assert.equal(stored.runId,'repo-sync:main:2026-10-13');
 const tomorrow=await claimDailySync(root,'main','2026-10-14');await tomorrow.finish({ok:true});
 await assert.rejects(claimDailySync(root,'../main','2026-10-13'));
});
test('service attempts each enabled Agent once per date, isolates failures, and stops timers',async()=>{
 let now=Date.parse('2026-10-12T23:59:00Z'),timer,cleared=0;
 const calls=[],warnings=[];
 const config={agents:{main:{sync:{enabled:true,submoduleSchedule:schedule}},another:{sync:{enabled:true,submoduleSchedule:schedule}},disabled:{sync:{enabled:false,submoduleSchedule:schedule}},legacy:{sync:{enabled:true}}}};
 const service=createDailySyncService(config,async(agent,date)=>{calls.push([agent,date]);if(agent==='main')throw Error('private stderr');return {ok:true};},{warn:message=>warnings.push(message)},{clock:()=>now,setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>cleared++});
 await service.start();assert.deepEqual(calls,[]);
 now+=60000;await timer();assert.equal(calls.length,2);assert.equal(warnings.length,1);assert(!warnings[0].includes('private stderr'));
 now+=60000;await timer();assert.equal(calls.length,2);
 now+=86400000;await timer();assert.equal(calls.length,4);
 await service.stop();assert.equal(cleared,1);
});
test('service stop waits for in-flight preparation and prevents further Agent starts',async()=>{
 let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r),calls=[];
 const binding={sync:{enabled:true,submoduleSchedule:schedule}};
 const service=createDailySyncService({agents:{main:binding,another:binding}},async agent=>{calls.push(agent);entered();await wait;return {ok:true};},{},{clock:()=>Date.parse('2026-10-13T00:00:00Z'),setTimer:()=>{throw Error('stopped service scheduled timer');},clearTimer:()=>{}});
 const pending=service.start();await started;let stopped=false;const stop=service.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);release();await pending;await stop;assert.deepEqual(calls,['main']);
});


test('receipt logs persist before completion, remain bounded, and legacy failures stay readable',async t=>{
 const base=fileURLToPath(new URL('../../.tmp/daily-sync-tests/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'history-'));t.after(()=>rm(root,{recursive:true,force:true}));await git(root,['init','-b','main']);
 const receipt=await claimDailySync(root,'main','2026-10-14');
 await receipt.log({stage:'拉取',status:'started',repository:'frontend',projectId:'demo',rawStderr:'private'});
 const running=await readSyncHistory(root,'main','2026-10-14');assert.equal(running.status,'running');assert.equal(running.logs.length,1);assert.equal(running.logs[0].rawStderr,undefined);
 for(let i=0;i<401;i++)await receipt.log({stage:'检查',status:'started'});
 await receipt.finish({ok:false,reason:'本地改动'});
 const result=await readSyncHistory(root,'main','2026-10-14');assert.equal(result.status,'failed');assert.equal(result.reason,'本地改动');assert.equal(result.logs.length,400);assert.equal(result.logsTruncated,true);
 await writeFile(join(root,'.git/agent-repo-daily-sync-main-2026-10-13.json'),JSON.stringify({agentId:'main',date:'2026-10-13',status:'failed',result:{reason:'legacy'}}));
 await writeFile(join(root,'.git/agent-repo-daily-sync-other-2026-10-15.json'),JSON.stringify({agentId:'other',date:'2026-10-15',status:'completed'}));
 assert.deepEqual((await readSyncHistory(root,'main')).records.map(r=>r.date),['2026-10-14','2026-10-13']);
 assert.deepEqual((await readSyncHistory(root,'main','2026-10-13')).logs,[]);
 await assert.rejects(readSyncHistory(root,'main','../secret'));
});
