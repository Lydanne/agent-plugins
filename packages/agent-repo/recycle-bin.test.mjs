import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {git} from './repository-skills.mjs';
import {createPeopleStore} from './people.mjs';
import {createEntityStore} from './entities.mjs';
import {createScheduledRequests,scheduledRequestBridge} from './scheduled-requests.mjs';
import {repositoryScheduleBridge} from './scheduled-tasks.mjs';
import {createDailySyncService} from './native-sync-scheduler.mjs';
import {writeRepositoryLog,readRepositoryLogs,clearRepositoryLogs,recycledRepositoryLogs,purgeRepositoryLogs} from './repository-log.mjs';
import {recycleSettings,recycleCatalog,restoreRecycled,configureRecycle,sweepRecycled,registerRecycleService} from './recycle-bin.mjs';
import {dayMs} from './recycle-store.mjs';
const ctx={client:{connId:'operator',scopes:['operator.read','operator.write']},sessionKey:'agent:main:agent-repo-management'};
const restoreInput=e=>({id:e.id,provider:e.provider,expectedRevision:e.revision,requestId:crypto.randomUUID(),confirmed:true});
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'recycle-integration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));await git(root,['init','-b','main']);mkdirSync(join(root,'projects/demo'),{recursive:true});writeFileSync(join(root,'projects.json'),JSON.stringify({schemaVersion:1,projects:{demo:{name:'Demo',repository:'projects/demo',url:'https://example.invalid/demo',branch:'main',skills:[]}}}));
 let now=Date.now(),valid=true,active=false;const jobs=[],native={list:async()=>structuredClone(jobs),add:async p=>{const job={...structuredClone(p),id:crypto.randomUUID()};jobs.push(job);return job;},update:async(id,p)=>Object.assign(jobs.find(j=>j.id===id),p),remove:async id=>{const i=jobs.findIndex(j=>j.id===id);if(i>=0)jobs.splice(i,1);return {removed:i>=0};},enqueueRun:async()=>({ok:true,enqueued:true})};
 const source={agentId:'main',accountId:'a',chatId:'group',sessionId:'s1',sessionKey:'agent:main:feishu:group:group',senderId:'human',requestMessageIds:['message']};
 const manager=createScheduledRequests({stateDir:join(root,'state'),getCron:()=>native,now:()=>now,bridge:{capture:()=>source,current:()=>valid,jobsActive:()=>active,deliver:async()=>({accepted:true,jobIds:['active-worker']})}});
 const savedGroup={...scheduledRequestBridge},savedSystem={...repositoryScheduleBridge};Object.assign(scheduledRequestBridge,{catalog:manager.catalog,administer:manager.administer,trash:manager.trash,purgeTrash:manager.purgeTrash});for(const k of Object.keys(repositoryScheduleBridge))delete repositoryScheduleBridge[k];
 t.after(()=>{manager.close();for(const k of Object.keys(scheduledRequestBridge))delete scheduledRequestBridge[k];Object.assign(scheduledRequestBridge,savedGroup);for(const k of Object.keys(repositoryScheduleBridge))delete repositoryScheduleBridge[k];Object.assign(repositoryScheduleBridge,savedSystem);});
 const input={action:'create',name:'日报',projectId:'demo',task:'Read current group only',constraints:'Read only',requestId:'original',expr:'0 7 * * *'};
 return {root,native,jobs,manager,source,input,get now(){return now;},advance:days=>now+=days*dayMs,expire:()=>valid=false,activate:()=>active=true};
}
test('soft-deleted plans disappear, restore paused with original identity, and cannot resume directly from trash',async t=>{
 const f=await fixture(t),plan=await f.manager.manage(f.input,{});await f.manager.manage({action:'remove',id:plan.id,requestId:'delete'},{});
 assert.equal((await f.manager.manage({action:'list'},{})).total,0);assert.equal((await f.manager.catalog('main')).tasks.length,0);assert.equal((await f.manager.inspect('main')).length,0);assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].enabled,false);
 const bin=await recycleCatalog(f.root,'main',{feature:'schedules'},f.now);assert.equal(bin.total,1);const entry=bin.records[0];assert.equal(entry.expiresAt-entry.deletedAt,30*dayMs);
 await assert.rejects(f.manager.administer('main',{action:'resume',id:plan.id,requestId:'bad',expectedRevision:entry.revision,confirmed:true}),/已删除/);
 const p=restoreInput(entry);assert.equal((await restoreRecycled(f.root,'main',p,ctx)).restored,true);assert.equal((await restoreRecycled(f.root,'main',p,ctx)).restored,true);
 const saved=await f.manager.manage({action:'get',id:plan.id},{});assert.equal(saved.id,plan.id);assert.equal(saved.jobId,plan.jobId);assert.equal(saved.status,'paused');assert.equal(saved.task,f.input.task);assert.equal(saved.deliveryMode,'source');assert.equal(f.jobs[0].enabled,false);assert.equal((await recycleCatalog(f.root,'main',{})).total,0);
 assert.equal(f.manager.audit('main',{action:'restore'}).total,1);
});
test('retention is configurable with version and idempotency checks; cleanup respects the boundary and retains audit',async t=>{
 const f=await fixture(t),plan=await f.manager.manage(f.input,{});await f.manager.manage({action:'remove',id:plan.id},{});const settings=recycleSettings(f.root,'main');assert.equal(settings.retentionDays,30);
 const p={retentionDays:2,expectedRevision:settings.revision,requestId:'retention',confirmed:true};await configureRecycle(f.root,'main',p,ctx);await configureRecycle(f.root,'main',p,ctx);assert.equal(recycleSettings(f.root,'main').retentionDays,2);
 await assert.rejects(configureRecycle(f.root,'main',{...p,requestId:'stale',retentionDays:1},ctx),/已变化/);
 for(const retentionDays of [0,-1,1.5,3651])await assert.rejects(configureRecycle(f.root,'main',{...p,requestId:'invalid',retentionDays},ctx));
 f.advance(1);await sweepRecycled(f.root,'main',f.now);assert.equal(f.manager.trash('main').length,1);f.advance(1);await sweepRecycled(f.root,'main',f.now);assert.equal(f.manager.trash('main').length,0);assert.equal(f.jobs.length,0);assert.equal(f.manager.audit('main',{action:'purge'}).total,1);await assert.rejects(f.manager.manage({action:'get',id:plan.id},{}),/not found/);
});
test('expired schedules with active workers, invalid source, unknown state or reassigned native ownership are protected',async t=>{
 const f=await fixture(t),plan=await f.manager.manage(f.input,{});await f.manager.fire({action:'finished',status:'ok',jobId:plan.jobId,agentId:'main',runAtMs:f.now+1000});f.activate();await f.manager.manage({action:'remove',id:plan.id},{});f.advance(31);await sweepRecycled(f.root,'main',f.now);assert.equal(f.manager.trash('main').length,1);
 await assert.rejects(restoreRecycled(f.root,'main',restoreInput(f.manager.trash('main')[0]),ctx),/运行中/);
});
test('revoked plan sources cannot be restored and foreign Agents cannot select another Agent item',async t=>{
 const f=await fixture(t),r=await f.manager.manage(f.input,{});await f.manager.manage({action:'remove',id:r.id},{});const e=f.manager.trash('main')[0];f.expire();await assert.rejects(restoreRecycled(f.root,'main',restoreInput(e),ctx),/已失效/);assert.equal(f.jobs[0].enabled,false);
 await assert.rejects(restoreRecycled(f.root,'other',restoreInput(e),ctx),/记录已变化/);assert.equal((await recycleCatalog(f.root,'other',{feature:'schedules'})).total,0);
 for(const fn of [restoreRecycled,configureRecycle])await assert.rejects(fn(f.root,'main',{}, {client:{scopes:['operator.read']}}),/写入权限/);
 await assert.rejects(recycleCatalog(f.root,'main',{agentId:'other'}),/筛选/);
});
test('people and sourced entities retain full local data, stay hidden during sync, and recover without reviving ended relations',async t=>{
 const f=await fixture(t),people=createPeopleStore(f.root),person=people.observe({accountId:'a',appId:'app',openId:'ou_test',name:'测试',email:'local@example.invalid',departments:[]});const corrected=people.update({id:person.id,revision:person.revision,patch:{giteaUsername:'verified-user'}});
 people.remove({id:person.id,revision:corrected.revision});assert.equal(people.all().length,0);assert.equal(people.lookup({accountId:'a',appId:'app',openId:'ou_test'}),null);people.observe({accountId:'a',appId:'app',openId:'ou_test',name:'自动同步名'});assert.equal(people.all().length,0);
 const store=createEntityStore(f.root),e=store.trash()[0];await restoreRecycled(f.root,'main',restoreInput(e),ctx);assert.equal(people.all()[0].name,'测试');assert.equal(people.all()[0].giteaUsername,'verified-user');
 const source=store.forSource({kind:'program',namespace:'assets',scope:'default',actor:'collector',types:['asset'],relations:[]}),old=source.upsert({typeId:'asset',externalId:'one',name:'设备',observedAt:'2026-01-01T00:00:00.000Z'}).entity;
 source.remove({id:old.id,revision:old.revision,observedAt:'2026-01-02T00:00:00.000Z',evidence:{kind:'event',id:'delete'}});source.upsert({typeId:'asset',externalId:'one',name:'新名称',observedAt:'2026-01-03T00:00:00.000Z'});assert.equal(store.get(old.id).entity,null);assert.equal(store.trash().length,1);
 const entry=store.trash()[0];await assert.rejects(restoreRecycled(f.root,'main',{...restoreInput(entry),expectedRevision:'stale'},ctx),/已变化/);await restoreRecycled(f.root,'main',restoreInput(entry),ctx);assert.equal(store.get(old.id).entity.name,'设备');assert.equal(store.get(old.id).entity.source.namespace,'assets');assert.equal(store.relations({status:'active'}).total,0);
 const next=store.get(old.id).entity;source.remove({id:next.id,revision:next.revision,observedAt:'2026-01-04T00:00:00.000Z',evidence:{kind:'event',id:'delete2'}});await sweepRecycled(f.root,'main',Date.now()+31*dayMs);assert.equal(store.trash().length,0);assert.equal(store.get(old.id).entity,null);assert.ok(store.history({id:old.id}).history.some(r=>r.action==='purge'));
});
test('repository log clearing is reversible, preserves newer and other-Agent entries, and purges only archived files',async t=>{
 const f=await fixture(t);await writeRepositoryLog(f.root,'main',{reason:'old'});await writeRepositoryLog(f.root,'other',{reason:'private'});await clearRepositoryLogs(f.root,'main');await writeRepositoryLog(f.root,'main',{reason:'new'});
 const e=recycledRepositoryLogs(f.root,'main')[0];assert.equal((await readRepositoryLogs(f.root,'main')).records.length,1);await restoreRecycled(f.root,'main',restoreInput(e),ctx);assert.equal((await readRepositoryLogs(f.root,'main')).records.length,2);
 await clearRepositoryLogs(f.root,'main');await writeRepositoryLog(f.root,'main',{reason:'latest'});const deleted=recycledRepositoryLogs(f.root,'main')[0];await purgeRepositoryLogs(f.root,'main',deleted.deletedAt);assert.equal(recycledRepositoryLogs(f.root,'main').length,0);assert.equal((await readRepositoryLogs(f.root,'main')).records[0].reason,'latest');assert.equal((await readRepositoryLogs(f.root,'other')).records[0].reason,'private');
});
test('system plan restore stays paused and expiry does not recreate a purged configured plan',async t=>{
 const f=await fixture(t),config={agents:{main:{repo:f.root,sync:{enabled:true,submoduleSchedule:{time:'07:00',timeZone:'Asia/Shanghai'}}}}},options={clock:()=>f.now,history:async()=>({status:'completed'})};let service=createDailySyncService(config,async()=>({ok:true}),{warn:()=>{}},options);await service.start({stateDir:join(f.root,'system'),getCron:()=>f.native});t.after(()=>service.stop());
 let plan=(await repositoryScheduleBridge.catalog('main'))[0];await repositoryScheduleBridge.administer('main',{id:plan.id,action:'remove',expectedRevision:plan.revision,requestId:'remove-system',confirmed:true});assert.equal((await repositoryScheduleBridge.catalog('main')).length,0);
 const e=repositoryScheduleBridge.trash('main')[0];await restoreRecycled(f.root,'main',restoreInput(e),ctx);plan=(await repositoryScheduleBridge.catalog('main'))[0];assert.equal(plan.status,'paused');assert.equal(f.jobs[0].enabled,false);
 await repositoryScheduleBridge.administer('main',{id:plan.id,action:'remove',expectedRevision:plan.revision,requestId:'remove-system-again',confirmed:true});f.advance(31);await sweepRecycled(f.root,'main',f.now);assert.equal(f.jobs.length,0);await service.stop();service=createDailySyncService(config,async()=>({ok:true}),{warn:()=>{}},options);await service.start({stateDir:join(f.root,'system'),getCron:()=>f.native});assert.equal(f.jobs.length,0);assert.equal((await repositoryScheduleBridge.catalog('main')).length,0);assert.equal((await repositoryScheduleBridge.inspect('main')).status,'purged');
});
test('native cleanup runs without opening the UI, survives reload and rejects foreign or modified ticks',async t=>{
 const f=await fixture(t),services=[],hooks={},sweeps=[];const api={registerService:s=>services.push(s),on:(n,h)=>hooks[n]=h,logger:{warn:()=>{}}},config={agents:{main:{repo:f.root}}};
 registerRecycleService(api,config,{clock:()=>f.now,sweep:async(root,id,now)=>sweeps.push({root,id,now})});await services[0].start({getCron:()=>f.native});assert.equal(f.jobs.length,1);assert.deepEqual(f.jobs[0].payload.toolsAllow,[]);assert.equal(sweeps.length,1);
 await hooks.cron_changed({jobId:f.jobs[0].id,agentId:'other',action:'finished',status:'ok'});assert.equal(sweeps.length,1);await hooks.cron_changed({jobId:f.jobs[0].id,agentId:'main',action:'finished',status:'ok'});assert.equal(sweeps.length,2);f.jobs[0].payload.script='tampered';await hooks.cron_changed({jobId:f.jobs[0].id,agentId:'main',action:'finished',status:'ok'});assert.equal(sweeps.length,2);await services[0].stop();
 f.jobs[0].payload.script='return {};';await services[0].start({getCron:()=>f.native});assert.equal(f.jobs.length,1);await services[0].stop();
});

test('permanent cleanup suppresses stale schedule retries and source observations without recreating deleted content',async t=>{
 const f=await fixture(t),plan=await f.manager.manage(f.input,{});await f.manager.manage({action:'remove',id:plan.id},{});f.advance(31);await sweepRecycled(f.root,'main',f.now);await assert.rejects(f.manager.manage(f.input,{}),/永久清理/);assert.equal(f.jobs.length,0);
 const store=createEntityStore(f.root),people=createPeopleStore(f.root),person=people.observe({accountId:'a',appId:'app',openId:'ou_tombstone',name:'不应重现',email:'deleted@example.invalid',departments:[]});people.remove({id:person.id,revision:person.revision});await sweepRecycled(f.root,'main',Date.now()+31*dayMs);people.observe({accountId:'a',appId:'app',openId:'ou_tombstone',name:'新采集',departments:[]});assert.equal(people.all().length,0);assert.equal(store.trash().length,0);
 const db=new DatabaseSync(join(f.root,'.runtime/agent_repo.sqlite'));const stub=JSON.parse(db.prepare('SELECT value FROM graph_nodes WHERE id=?').get('person:'+person.id).value);db.close();assert.equal(stub.purged,true);assert.equal(stub.attributes,undefined);assert.equal(stub.name,undefined);
});
test('reassigned native plans and uncertain restore writes never get cleaned or automatically replayed',async t=>{
 const f=await fixture(t),plan=await f.manager.manage(f.input,{});await f.manager.manage({action:'remove',id:plan.id},{});const e=f.manager.trash('main')[0];f.jobs[0].agentId='foreign';f.advance(31);await sweepRecycled(f.root,'main',f.now);assert.equal(f.manager.trash('main').length,1);assert.equal(f.jobs.length,1);f.jobs[0].agentId='main';
 let calls=0;f.native.update=async()=>{calls++;throw Error('PRIVATE_NATIVE');};await assert.rejects(restoreRecycled(f.root,'main',restoreInput(e),ctx),/未确认/);assert.equal(f.manager.trash('main')[0].restorePending,true);const count=calls;await sweepRecycled(f.root,'main',f.now);assert.equal(calls,count);assert.equal(f.jobs.length,1);
});

test('concurrent cleanup claims a log batch once and cannot delete a newly restored batch',async t=>{
 const f=await fixture(t);await writeRepositoryLog(f.root,'main',{reason:'restorable'});await clearRepositoryLogs(f.root,'main');const entry=recycledRepositoryLogs(f.root,'main')[0];
 const results=await Promise.all([purgeRepositoryLogs(f.root,'main',entry.deletedAt),purgeRepositoryLogs(f.root,'main',entry.deletedAt)]);assert.equal(results.reduce((n,r)=>n+r.purged.length,0),1);
 await writeRepositoryLog(f.root,'main',{reason:'restore-wins'});await clearRepositoryLogs(f.root,'main');const saved=recycledRepositoryLogs(f.root,'main')[0];await restoreRecycled(f.root,'main',restoreInput(saved),ctx);await purgeRepositoryLogs(f.root,'main',Date.now()+31*dayMs);assert.equal((await readRepositoryLogs(f.root,'main')).records[0].reason,'restore-wins');
});

test('a pending restore remains in trash until native acknowledgment and cannot be enabled through the normal manager',async t=>{
 const f=await fixture(t),plan=await f.manager.manage(f.input,{});await f.manager.manage({action:'remove',id:plan.id},{});const entry=f.manager.trash('main')[0];let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r),update=f.native.update;
 f.native.update=async(id,p)=>{started();await gate;return update(id,p);};const work=restoreRecycled(f.root,'main',restoreInput(entry),ctx);await entered;
 try{const record=f.manager.trash('main')[0];assert.equal(record.restorePending,true);assert.equal((await f.manager.catalog('main')).tasks.length,0);await assert.rejects(f.manager.administer('main',{id:plan.id,action:'resume',requestId:'bypass',expectedRevision:record.revision,confirmed:true}),/已删除|正在变更/);assert.equal((await f.manager.manage({action:'get',id:plan.id},{})).status,'removed');}finally{release();await work;}
 await work;assert.equal(f.manager.trash('main').length,0);assert.equal((await f.manager.catalog('main')).tasks[0].status,'paused');assert.equal(f.jobs[0].enabled,false);
});
