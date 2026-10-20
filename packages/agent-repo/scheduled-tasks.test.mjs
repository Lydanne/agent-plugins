import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repositorySyncTasks,repositorySyncTaskId,repositorySyncRunId} from './scheduled-tasks.mjs';
const schedule={time:'08:00',timeZone:'Asia/Shanghai'},projects={demo:{}},binding={sync:{enabled:true,submoduleSchedule:schedule}};
const task=(now,records=[],config=binding)=>repositorySyncTasks(config,'main',{records,hasMore:false},projects,Date.parse(now))[0];
test('configured system task exists before the first run and enabled state is independent from run failure',()=>{
 const fresh=task('2026-10-13T23:00:00Z');assert.equal(fresh.taskId,repositorySyncTaskId('main'));assert.equal(fresh.lastRun,null);assert.equal(fresh.readOnly,true);assert.equal(fresh.nextPlanned.date,'2026-10-14');assert.equal(fresh.nextPlanned.state,'scheduled');
 const failed=task('2026-10-14T02:00:00Z',[{date:'2026-10-14',status:'failed'}]);assert.equal(failed.enabled,true);assert.equal(failed.lastRun.status,'failed');assert.equal(failed.nextPlanned.date,'2026-10-15');assert.equal(failed.records[0].runId,repositorySyncRunId('main','2026-10-14'));
});
test('planning uses configured timezone, calendar rollover and the once-per-date receipt without replaying failures',()=>{
 assert.equal(task('2026-10-14T00:01:00Z').nextPlanned.state,'due');
 assert.equal(task('2026-12-31T02:00:00Z',[{date:'2026-12-31',status:'failed'}]).nextPlanned.date,'2027-01-01');
 const utc={sync:{enabled:true,submoduleSchedule:{time:'08:00',timeZone:'UTC'}}};assert.equal(task('2026-10-14T00:01:00Z',[],utc).nextPlanned.state,'scheduled');
 const la={sync:{enabled:true,submoduleSchedule:{time:'08:00',timeZone:'America/Los_Angeles'}}};assert.equal(task('2026-10-14T02:00:00Z',[],la).nextPlanned.date,'2026-10-13');assert.equal(task('2026-10-14T02:00:00Z',[],la).nextPlanned.state,'due');
 const paused=task('2026-10-14T02:00:00Z',[],{sync:{enabled:false,submoduleSchedule:schedule}});assert.equal(paused.enabled,false);assert.equal(paused.nextPlanned.state,'disabled');
});
test('request-only synchronization is not a scheduled task while archived daily records remain available',()=>{
 assert.deepEqual(repositorySyncTasks({sync:{enabled:true}},'main',{records:[],hasMore:false},projects),[]);
 const old=[{date:'2026-10-13',status:'failed'}],snapshot=JSON.stringify(old),archived=task('2026-10-14T02:00:00Z',old,{sync:{enabled:true}});assert.equal(archived.enabled,false);assert.equal(archived.nextPlanned.state,'unconfigured');assert.equal(archived.records[0].taskId,'repo-sync:main');assert.equal(JSON.stringify(old),snapshot);
});
