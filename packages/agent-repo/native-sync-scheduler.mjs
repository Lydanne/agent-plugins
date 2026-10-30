import {importLegacyOperations,auditTable,auditBegin,auditFinish,auditQuery,scheduleSnapshot} from './audit.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {repositoryScheduleBridge,repositorySyncTaskId} from './scheduled-tasks.mjs';
import {scheduleDate} from './scheduled-sync.mjs';
import {readSyncHistory} from './sync-history.mjs';
const script='return {};';
const nativeSchedule=s=>({kind:'cron',expr:`${Number(s.time.slice(3))} ${Number(s.time.slice(0,2))} * * *`,tz:s.timeZone,staggerMs:0});
const revision=r=>createHash('sha256').update(JSON.stringify([r.jobId,r.schedule,r.status,r.version??0])).digest('hex');
const localDate=(time,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(time);
export function createDailySyncService(config,synchronize,logger,{clock=Date.now,history=readSyncHistory}={}){
 let db,context,active=false,reconciling;const work=new Set(),locks=new Set();
 const track=promise=>{work.add(promise);promise.finally(()=>work.delete(promise)).catch(()=>{});return promise;};
 const cron=()=>{const value=context?.getCron?.();if(!active||!value)throw Error('OpenClaw 原生调度不可用');return value;};
 const get=id=>{const row=db?.prepare('SELECT body FROM schedules WHERE agent=?').get(id);return row?JSON.parse(row.body):null;};
 const save=r=>db.prepare('INSERT OR REPLACE INTO schedules VALUES (?,?)').run(r.agentId,JSON.stringify(r));
 const description=id=>'agent-repo repository sync '+id;
 const matches=(job,r)=>job?.agentId===r.agentId&&job.description===description(r.agentId)&&job.payload?.kind==='script'&&job.payload.script===script&&job.delivery?.mode==='none';
 const enabled=id=>config.agents[id]?.sync?.enabled===true&&!!config.agents[id]?.sync?.submoduleSchedule;
 const owned=id=>{if(!config.agents[id])throw Error('当前 Agent 未绑定');const r=get(id);if(!r)throw Error('此 Agent 未配置每日仓库同步');return r;};
 async function tried(r,date){if(r.attemptedDate===date)return true;try{await history(config.agents[r.agentId].repo,r.agentId,date);return true;}catch(e){if(e.code==='ENOENT')return false;throw Error('无法核验今日同步记录，不能重复执行');}}
 async function fire(event){
  if(!active||event.action!=='finished'||event.status!=='ok'||!Number.isSafeInteger(event.runAtMs))return;
  const r=get(event.agentId);if(!r||r.status!=='enabled'||r.jobId!==event.jobId||!enabled(r.agentId)||event.runAtMs<(r.acceptAfter??0))return;
  const job=(await cron().list({includeDisabled:true})).find(j=>j.id===r.jobId);if(!matches(job,r)||!job.enabled||JSON.stringify(job.schedule)!==JSON.stringify(nativeSchedule(r.schedule)))return;
  if(!active||get(r.agentId)?.status!=='enabled'||revision(get(r.agentId))!==revision(r))return;
  const date=localDate(event.runAtMs,r.schedule.timeZone);if(date!==localDate(clock(),r.schedule.timeZone))return;
  if(await tried(r,date)){const current=get(r.agentId);if(current.queuedDate===date){delete current.queuedDate;save(current);}return;}
  // Persist the daily claim before asynchronous preparation. Git receipts keep
  // the pre-migration history and cross-process exclusion authoritative too.
  const latest=get(r.agentId);if(!active||latest.attemptedDate===date||latest.status!=='enabled'||revision(latest)!==revision(r))return;
  latest.attemptedDate=date;latest.running=true;delete latest.queuedDate;save(latest);
  try{const result=await synchronize(r.agentId,date);const done=get(r.agentId);done.running=false;done.lastResult=result?.skipped?'skipped':result?.ok?'completed':'failed';save(done);if(!result?.ok&&!result?.skipped)logger?.warn?.('agent-repo: daily sync failed; inspect repository receipts');}
  catch{const done=get(r.agentId);done.running=false;done.lastResult='failed';save(done);logger?.warn?.('agent-repo: daily sync failed; inspect repository receipts');}
 }
 async function enqueue(r,date){
  if(typeof cron().enqueueRun!=='function')throw Error('宿主未提供原生调度入队接口');
  const latest=get(r.agentId);if(latest.attemptedDate===date||latest.running||latest.queuedDate)return {ok:true,enqueued:false,skipped:true};
  if(latest.status!=='enabled'||revision(latest)!==revision(r))throw Error('计划状态已改变');
  latest.queuedDate=date;save(latest);
  const result=await cron().enqueueRun(r.jobId,'force');if(!result?.ok||result.enqueued!==true)throw Error('原生队列未确认接纳');return result;
 }
 async function reconcileOnce(){
  if(!active)return;
  for(const [id,binding] of Object.entries(config.agents)){
   if(!active)break;if(!binding.sync?.submoduleSchedule||locks.has(id))continue;
   locks.add(id);let setupAudit;try{
    let r=get(id),jobs=await cron().list({includeDisabled:true});
    if(r?.purged)continue;
    if(!r){
     const candidates=jobs.filter(j=>j.agentId===id&&j.description===description(id));
     if(candidates.length>1)throw Error('重复原生计划');
     r={agentId:id,schedule:binding.sync.submoduleSchedule,status:'creating',version:0};setupAudit=auditBegin(db,{agentId:id,feature:'schedules',targetId:repositorySyncTaskId(id),targetName:'每日仓库同步',action:'create',actor:{kind:'system',id:'deployment-config'},executor:'native-sync-reconcile',requested:{schedule:r.schedule},at:clock()});save(r);
     const job=candidates[0]??await cron().add({name:'每日仓库同步 · '+id,description:description(id),agentId:id,enabled:false,schedule:nativeSchedule(r.schedule),sessionTarget:'isolated',wakeMode:'next-heartbeat',deleteAfterRun:false,payload:{kind:'script',script,toolsAllow:[],timeoutSeconds:30},delivery:{mode:'none'}});
     if(!job?.id||!matches(job,r))throw Error('原生任务来源不一致');r.jobId=job.id;r.status=enabled(id)?'enabled':'paused';save(r);await cron().update(r.jobId,{enabled:enabled(id)});auditFinish(db,setupAudit,'succeeded',scheduleSnapshot(r),{at:clock()});
    }
    if(!enabled(id)){if(r.jobId){const job=jobs.find(j=>j.id===r.jobId);if(job&&matches(job,r)&&job.enabled)await cron().update(r.jobId,{enabled:false});}continue;}
    if(r.status!=='enabled'||r.running||r.queuedDate)continue;
    const job=(await cron().list({includeDisabled:true})).find(j=>j.id===r.jobId);if(!matches(job,r)||!job.enabled||JSON.stringify(job.schedule)!==JSON.stringify(nativeSchedule(r.schedule)))continue;
    if(job.state?.lastRunStatus==='ok')await fire({action:'finished',status:'ok',agentId:id,jobId:r.jobId,runAtMs:job.state.lastRunAtMs});
    r=get(id);const date=scheduleDate(new Date(clock()),r.schedule);if(date&&!r.running&&!r.queuedDate&&!await tried(r,date))await enqueue(r,date);
   }catch{const r=get(id);if(r){r.status='needs_review';save(r);}if(setupAudit)auditFinish(db,setupAudit,'unknown',scheduleSnapshot(r),{at:clock()});logger?.warn?.('agent-repo: native daily schedule needs inspection');}finally{locks.delete(id);}
  }
 }
 function reconcile(){if(!reconciling)reconciling=reconcileOnce().finally(()=>{reconciling=undefined;});return reconciling;}
 async function inspect(id){
  const r=get(id);if(!r)return null;if(r.purged)return {status:'purged',hidden:true};let job,nativeAvailable=true;try{job=(await cron().list({includeDisabled:true})).find(j=>j.id===r.jobId);}catch{nativeAvailable=false;}
  return {nativeConsistent:!!job&&matches(job,r)&&JSON.stringify(job.schedule)===JSON.stringify(nativeSchedule(r.schedule)),schedule:r.schedule,enabled:enabled(id)&&r.status==='enabled'&&job?.enabled===true,status:r.status,readOnly:false,source:'openclaw',nativeAvailable,jobId:r.jobId,nextPlanned:job?.enabled&&enabled(id)&&r.status==='enabled'&&job.state?.nextRunAtMs?{state:'scheduled',at:new Date(job.state.nextRunAtMs).toISOString(),timeZone:r.schedule.timeZone}:{state:nativeAvailable?'disabled':'unavailable'}};
 }
 async function catalog(id,{includeRemoved=false}={}){
  const r=get(id);if(!r||r.purged||!includeRemoved&&r.status==='removed')return [];const native=await inspect(id);const date=localDate(clock(),r.schedule.timeZone);let alreadyAttempted=true;try{alreadyAttempted=await tried(r,date);}catch{}
  let canEnqueue=false;try{canEnqueue=typeof context?.getCron?.()?.enqueueRun==='function';}catch{}
  return [{nativeWarning:!native.nativeAvailable?'原生调度不可读取':r.status!=='removed'&&!native.nativeConsistent?'原生计划缺失或与保存设置不一致，请核验':'',id:repositorySyncTaskId(id),kind:'repository-sync',name:'每日仓库同步',revision:revision(r),schedule:{...nativeSchedule(r.schedule),time:r.schedule.time},status:r.status,busy:!!(r.running||r.queuedDate),sourceValid:enabled(id),canRun:canEnqueue&&native.nativeConsistent&&native.enabled&&!alreadyAttempted,alreadyAttempted,projectId:'全部登记项目',task:'安全同步当前 Agent 仓库和全部已登记项目的 wiki、直接业务子仓库。',constraints:'每天至多尝试一次，失败或中断不自动重试；保留脏工作树、分叉、未推送提交及错误远端，禁止强推、重置、自动 stash。',operations:db.prepare('SELECT body FROM operations WHERE agent=? ORDER BY rowid DESC LIMIT 30').all(id).map(o=>JSON.parse(o.body))}];
 }
 async function administer(id,p,provenance={}){
  if(!p||Object.keys(p).some(k=>!['action','id','requestId','expectedRevision','confirmed','name','time','timeZone'].includes(k))||p.id!==repositorySyncTaskId(id)||p.confirmed!==true||typeof p.requestId!=='string'||!p.requestId||p.requestId.length>150||!['update','pause','resume','remove','run','restore'].includes(p.action))throw Error('同步计划管理参数无效');
  const r=owned(id),key=id+':'+p.requestId,prior=db.prepare('SELECT body FROM operations WHERE key=?').get(key),input=JSON.stringify(p);
  if(prior){const o=JSON.parse(prior.body);if(o.input!==input)throw Error('requestId 已用于其他操作');return o.result??{status:o.status};}
  if(locks.has(id))throw Error('计划正在变更');if(p.expectedRevision!==revision(r))throw Error('计划已改变，请刷新');
  if(r.purged)throw Error('计划已永久清理');
  if(r.status==='removed'&&p.action!=='restore')throw Error('系统计划已移入回收站，请先恢复；历史仍保留');
  if(!['pause','remove'].includes(p.action)&&(!enabled(id)||r.running||r.queuedDate||!['enabled','paused',...(p.action==='restore'?['removed']:[])].includes(r.status)))throw Error('配置未授权同步、任务进行中或状态待核验');
  if(p.action==='restore'&&(r.status!=='removed'||r.restorePending))throw Error('计划不在回收站或先前恢复待核验');
  let schedule=r.schedule;
  if(p.action==='update'){if(typeof p.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time))throw Error('时间须为 HH:mm');if(typeof p.timeZone!=='string'||!p.timeZone)throw Error('请指定时区');new Intl.DateTimeFormat('en',{timeZone:p.timeZone});schedule={time:p.time,timeZone:p.timeZone};}
  else if(['name','time','timeZone'].some(k=>p[k]!==undefined))throw Error('非编辑操作不接受计划字段');
  const date=localDate(clock(),r.schedule.timeZone);
  if(p.action==='run'&&(r.status!=='enabled'||await tried(r,date)))throw Error('今日已有尝试记录，或计划未启用；不重复同步');
  if(locks.has(id)||(get(id).queuedDate||get(id).running)&&!['pause','remove'].includes(p.action)||revision(get(id))!==revision(r))throw Error('计划或运行状态已改变，请刷新');
  if(p.action==='run'&&get(id).attemptedDate===date)throw Error('今日已有尝试记录');
  const auditId=auditBegin(db,{agentId:id,feature:'schedules',targetId:p.id,targetName:'每日仓库同步',action:p.action,...provenance,requestId:p.requestId,before:scheduleSnapshot(r),requested:p.action==='update'?{time:p.time,timeZone:p.timeZone}:null,at:clock()});
  locks.add(id);const op={requestId:p.requestId,action:p.action,input,status:'pending',createdAt:clock()};const record=()=>db.prepare('INSERT OR REPLACE INTO operations VALUES (?,?,?)').run(key,id,JSON.stringify(op));
  try{record();
   if(p.action==='remove'){r.deletedAt??=clock();r.status='removed';r.version++;r.acceptAfter=clock();save(r);}
   const nativeJobs=await cron().list({includeDisabled:true});let job=nativeJobs.find(j=>j.id===r.jobId);
   if(!r.jobId){const candidates=nativeJobs.filter(j=>j.agentId===id&&j.description===description(id));if(candidates.length>1)throw Error('原生计划重复，需核验');job=candidates[0];if(job){r.jobId=job.id;save(r);}}
   if(!job&&r.status==='removed'&&p.action==='restore'){r.restorePending=true;save(r);job=await cron().add({name:'每日仓库同步 · '+id,description:description(id),agentId:id,enabled:false,schedule:nativeSchedule(r.schedule),sessionTarget:'isolated',wakeMode:'next-heartbeat',deleteAfterRun:false,payload:{kind:'script',script,toolsAllow:[],timeoutSeconds:30},delivery:{mode:'none'}});if(!job?.id)throw Error('原生任务未确认创建');r.jobId=job.id;r.status='removed';save(r);}
   if(p.action==='restore'&&job&&JSON.stringify(job.schedule)!==JSON.stringify(nativeSchedule(r.schedule)))throw Error('原生计划已改变，请核验');
   if(job&&!matches(job,r)||!job&&p.action!=='remove')throw Error('原生计划缺失或归属不一致');
   let result;
   if(p.action==='run'){if(!job.enabled||JSON.stringify(job.schedule)!==JSON.stringify(nativeSchedule(r.schedule)))throw Error('原生计划已改变');result=await enqueue(r,date);}
   else{
    const enable=p.action==='resume'||p.action==='update'&&r.status==='enabled';if(p.action==='remove')r.deletedAt??=clock();if(p.action==='restore')r.restorePending=true;r.version++;r.acceptAfter=clock();r.schedule=schedule;r.status=['remove','restore'].includes(p.action)?'removed':enable?'enabled':'paused';save(r);
    if(p.action==='remove'){if(job)await cron().update(r.jobId,{enabled:false});const removed=get(id);delete removed.queuedDate;save(removed);}
    else {await cron().update(r.jobId,{enabled:enable,...(p.action==='update'?{schedule:nativeSchedule(schedule)}:{})});if(p.action==='restore'){const restored=get(id);restored.status='paused';delete restored.deletedAt;delete restored.restorePending;save(restored);}}
   }
   auditFinish(db,auditId,'succeeded',scheduleSnapshot(get(id)),{at:clock()});op.status='succeeded';op.result={id:p.id,status:'succeeded',...(result?{enqueued:result.enqueued===true,skipped:result.skipped===true,runId:result.runId}:{})};record();return op.result;
  }catch{const latest=get(id);if(!['pause','remove'].includes(p.action)){latest.status=p.action==='restore'?'removed':'needs_review';save(latest);}auditFinish(db,auditId,'unknown',scheduleSnapshot(get(id)),{at:clock()});op.status='unknown';record();throw Error('原生操作结果未确认，请核验计划和今日记录，不能重复提交');}
  finally{locks.delete(id);}
 }
 const trash=id=>{const r=get(id);return r?.status==='removed'?[{id:repositorySyncTaskId(id),name:'每日仓库同步',kind:'system-schedule',feature:'schedules',provider:'system-schedules',deletedAt:r.deletedAt,revision:revision(r),busy:!!(r.running||r.queuedDate),restorePending:!!r.restorePending,preview:{schedule:r.schedule}}]:[];};
 async function purgeTrash(id,cutoff){
  if(!Number.isSafeInteger(cutoff)||cutoff<0)throw Error('回收站清理时间无效');const r=get(id);if(!r||r.status!=='removed'||r.deletedAt>cutoff||!r.deletedAt||r.running||r.queuedDate||r.restorePending||locks.has(id))return {purged:[]};
  locks.add(id);try{const job=(await cron().list({includeDisabled:true})).find(j=>j.id===r.jobId);if(job&&(!matches(job,r)||job.enabled!==false||JSON.stringify(job.schedule)!==JSON.stringify(nativeSchedule(r.schedule))))return {purged:[]};
   const auditId=auditBegin(db,{agentId:id,feature:'schedules',targetId:repositorySyncTaskId(id),targetName:'每日仓库同步',action:'purge',actor:{kind:'system',id:'retention-cleanup'},executor:'recycle-bin',before:scheduleSnapshot(r),at:clock()});
   try{if(job)await cron().remove(r.jobId);save({agentId:id,status:'purged',purged:true});auditFinish(db,auditId,'succeeded',null,{at:clock()});return {purged:[repositorySyncTaskId(id)]};}catch{auditFinish(db,auditId,'unknown',scheduleSnapshot(r),{at:clock()});throw Error('清理结果待核验');}
  }finally{locks.delete(id);}
 }
 const bridge={inspect,catalog,trash,purgeTrash:(id,cutoff)=>track(purgeTrash(id,cutoff)),audit:(id,p)=>auditQuery(db,id,p),administer:(id,p,provenance)=>track(administer(id,p,provenance))};
 return {id:'agent-repo-daily-submodule-sync',onCronChanged:event=>track(fire(event)),onCronReconciled:()=>track(reconcile()),
  async start(ctx){if(active)return;context=ctx;if(!ctx?.stateDir||!ctx.getCron){logger?.warn?.('agent-repo: native scheduler required; daily sync inactive');return;}const dir=join(ctx.stateDir,'agent-repo-repository-schedules');mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,'schedules.sqlite');db=new DatabaseSync(file);chmodSync(file,0o600);db.exec('CREATE TABLE IF NOT EXISTS schedules(agent TEXT PRIMARY KEY,body TEXT);CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,agent TEXT,body TEXT)');auditTable(db);importLegacyOperations(db,db.prepare("SELECT * FROM operations o WHERE NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.agent=o.agent AND json_extract(a.body,'$.requestId')=json_extract(o.body,'$.requestId'))").all().map(o=>{const r=JSON.parse(o.body);return {agentId:o.agent,requestId:r.requestId,action:r.action,targetId:repositorySyncTaskId(o.agent),status:r.status,at:r.createdAt};}));for(const row of db.prepare('SELECT body FROM schedules').all()){const previous=JSON.parse(row.body);if(previous.status==='removed'&&!previous.deletedAt){previous.deletedAt=clock();save(previous);}if(previous.running){previous.running=false;previous.lastResult='interrupted';save(previous);}}active=true;Object.assign(repositoryScheduleBridge,bridge);await track(reconcile());},
  async stop(){active=false;for(const [key,value] of Object.entries(bridge))if(repositoryScheduleBridge[key]===value)delete repositoryScheduleBridge[key];await Promise.allSettled([...work]);db?.close();db=undefined;context=undefined;}
 };
}
