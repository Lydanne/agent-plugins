import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Only installed channel code may supply trusted provenance or dispatch a run.
export const scheduledRequestBridge=globalThis[Symbol.for('ada.scheduled-requests.v1')]??={};
const tickScript='return {};';
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
export function createScheduledRequests({stateDir,getCron,bridge=scheduledRequestBridge,now=Date.now}) {
 mkdirSync(stateDir,{recursive:true,mode:0o700});
 const file=join(stateDir,'scheduled-requests.sqlite'),db=new DatabaseSync(file);chmodSync(file,0o600);
 db.exec(`PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS runs(job TEXT, slot INTEGER, status TEXT, detail TEXT, PRIMARY KEY(job,slot));`);
 const all=()=>db.prepare('SELECT body FROM requests').all().map(r=>JSON.parse(r.body));
 const save=r=>db.prepare('INSERT OR REPLACE INTO requests VALUES (?,?)').run(r.id,JSON.stringify(r));
 const owned=(r,p)=>['agentId','accountId','chatId','sessionKey','senderId','sessionId'].every(k=>r.source[k]===p[k]);
 const snapshot=context=>{const source=bridge.capture?.(context);if(!source)throw Error('A current human Feishu source is required');return structuredClone(source);};
 const cron=()=>{const c=getCron();if(!c)throw Error('Native scheduler is unavailable');return c;};
 const publicRecord=r=>({id:r.id,jobId:r.jobId,name:r.name,task:r.task,projectId:r.projectId,schedule:r.schedule,status:r.status,reason:r.reason,lastRun:r.lastRun,runs:db.prepare('SELECT slot,status FROM runs WHERE job=? ORDER BY slot DESC LIMIT 10').all(r.jobId??'')});
 async function manage(params,context){
  const source=snapshot(context);
  if(params.action==='list')return {tasks:all().filter(r=>owned(r,source)).map(publicRecord)};
  if(params.action==='create'){
   const previous=all().find(r=>owned(r,source)&&r.requestId===params.requestId);
   if(!text(params.requestId,160)||!text(params.name,160)||!text(params.task,4000)||!text(params.constraints,4000)||!text(params.projectId,64))throw Error('requestId, name, projectId, task and constraints are required');
   let schedule;
   if(params.at!==undefined){if(params.expr!==undefined||!text(params.at,100)||!/(Z|[+-]\d{2}:\d{2})$/.test(params.at)||!Number.isFinite(Date.parse(params.at))||(Date.parse(params.at)<=now()&&!previous))throw Error('at must be a future timestamp with timezone');schedule={kind:'at',at:new Date(params.at).toISOString()};}
   else {if(!text(params.expr,120)||params.expr.trim().split(/\s+/).length!==5)throw Error('A five-field cron expression is required');const tz=params.timeZone??'Asia/Shanghai';new Intl.DateTimeFormat('en',{timeZone:tz});schedule={kind:'cron',expr:params.expr,tz,staggerMs:0};}
   const input={name:params.name,task:params.task,constraints:params.constraints,projectId:params.projectId,schedule};
   if(previous){if(JSON.stringify(previous.input)!==JSON.stringify(input))throw Error('requestId already belongs to different input');return publicRecord(previous);}
   if(!bridge.current?.(source))throw Error('Source authorization is no longer current');
   const r={id:randomUUID(),source,requestId:params.requestId,input,...input,status:'creating',createdAt:now()};save(r);
   try{
    // A fixed, tool-free script is only a clock tick. Business text stays in the private store.
    const job=await cron().add({name:'Ada: '+r.name,description:'agent-repo scheduled request '+r.id,agentId:source.agentId,enabled:false,schedule,sessionTarget:'isolated',wakeMode:'next-heartbeat',deleteAfterRun:false,payload:{kind:'script',script:tickScript,toolsAllow:[],timeoutSeconds:30},delivery:{mode:'none'}});
    if(!job?.id)throw Error('Scheduler did not return a job ID');r.jobId=job.id;r.schedule=job.schedule??schedule;r.status='paused';save(r);
    if(!bridge.current?.(source))throw Error('Source authorization changed during creation');
    r.status='enabled';save(r);await cron().update(job.id,{enabled:true});return publicRecord(r);
   }catch(error){r.status='needs_review';save(r);throw Error('Schedule creation is incomplete; inspect the saved request before retrying',{cause:error});}
  }
  const r=all().find(r=>r.id===params.id&&owned(r,source));if(!r)throw Error('Schedule not found in this requester and conversation');
  if(params.action!=='pause'&&params.action!=='remove')throw Error('Unsupported schedule action');
  // Persist revocation before an awaited scheduler call; late events cannot start new work.
  r.status=params.action==='pause'?'paused':'removed';save(r);
  if(r.jobId){if(params.action==='remove')await cron().remove(r.jobId);else await cron().update(r.jobId,{enabled:false});}
  return publicRecord(r);
 }
 async function fire(event,signal){
  if(event.action!=='finished'||event.status!=='ok'||!Number.isSafeInteger(event.runAtMs))return;
  const r=all().find(r=>r.jobId===event.jobId);if(!r||r.status!=='enabled')return;
  if(event.agentId!==r.source.agentId)return;
  if(r.lastRun?.jobIds?.length&&(!bridge.jobsActive||bridge.jobsActive(r.lastRun.jobIds,r.source)))return;
  const jobs=await cron().list({includeDisabled:true});const job=jobs.find(j=>j.id===r.jobId);
  // A user-edited native job cannot silently change the authorized plan or executor.
  if(!job||(job.enabled===false&&r.schedule.kind!=='at')||job.agentId!==r.source.agentId||job.description!=='agent-repo scheduled request '+r.id||job.payload?.kind!=='script'||job.payload?.script!==tickScript||job.delivery?.mode!=='none'||JSON.stringify(job.schedule)!==JSON.stringify(r.schedule))return;
  if(all().find(x=>x.id===r.id)?.status!=='enabled'||signal?.aborted)return;
  if(!bridge.current)throw Error('Feishu scheduled source validator is unavailable');
  if(!bridge.current(r.source)){r.status='blocked';r.reason='source_or_session_invalid';save(r);await cron().update(r.jobId,{enabled:false});return;}
  if(!bridge.deliver)throw Error('Feishu scheduled request adapter is unavailable');
  // Atomic claim survives duplicates, concurrent callbacks and restart. Unknown turns are never replayed.
  if(!db.prepare('INSERT OR IGNORE INTO runs VALUES (?,?,?,?)').run(r.jobId,event.runAtMs,'dispatching','').changes)return;
  if(db.prepare("SELECT 1 FROM runs WHERE job=? AND slot<>? AND status IN ('dispatching','unknown')").get(r.jobId,event.runAtMs)){db.prepare('UPDATE runs SET status=? WHERE job=? AND slot=?').run('blocked',r.jobId,event.runAtMs);return;}
  const run={...r,runAtMs:event.runAtMs,runKey:r.id+':'+event.runAtMs};
  const assertCurrent=()=>{if(signal?.aborted||all().find(x=>x.id===r.id)?.status!=='enabled'||!bridge.current?.(r.source))throw Error('Scheduled request authorization is no longer current');};
  try{
   assertCurrent();const receipt=await bridge.deliver(run,{signal,assertCurrent});
   if(!receipt?.accepted)throw Error('No Main admission receipt');
   db.prepare('UPDATE runs SET status=?,detail=? WHERE job=? AND slot=?').run('submitted',JSON.stringify(receipt),r.jobId,event.runAtMs);
   const latest=all().find(x=>x.id===r.id);latest.lastRun={at:event.runAtMs,status:'submitted',jobIds:receipt.jobIds??[]};
   if(r.schedule.kind==='at'&&latest.status==='enabled')latest.status='completed';save(latest);
  }catch(error){db.prepare('UPDATE runs SET status=?,detail=? WHERE job=? AND slot=?').run('unknown',JSON.stringify({stage:error?.scheduledStage??'dispatch',name:error?.name??'Error',message:String(error?.message??error).slice(0,1000)}),r.jobId,event.runAtMs);const latest=all().find(x=>x.id===r.id);latest.lastRun={at:event.runAtMs,status:'unknown'};save(latest);throw error;}
 }
 async function inspect(agentId){
  if(typeof agentId!=='string'||!agentId)return [];
  let jobs=[],nativeAvailable=true;try{jobs=await cron().list({includeDisabled:true});}catch{nativeAvailable=false;}
  return all().filter(r=>r.source.agentId===agentId).map(r=>{
   const taskId='scheduled-request:'+r.id,job=jobs.find(j=>j.id===r.jobId&&j.agentId===agentId),tz=r.schedule.tz??'Asia/Shanghai';
   const rows=db.prepare('SELECT slot,status,detail FROM runs WHERE job=? ORDER BY slot DESC LIMIT 31').all(r.jobId);
   const records=rows.slice(0,30).map(row=>{
    let detail={};try{detail=JSON.parse(row.detail||'{}');}catch{}
    const receipts=(detail.deliveryReceipts??[]).filter(x=>x.chatId===r.source.chatId&&typeof x.messageId==='string');
    const status=receipts.length?'delivered':row.status;
    const reason=row.status==='unknown'?'交接结果不确定，请核对后处理'+(detail.stage?'；阶段：'+detail.stage:''):row.status==='verified_not_executed'?'已核对未执行，原记录保留':row.status==='blocked'?'前次交接结果未确认，已阻止重复执行':null;
    const logs=[{time:new Date(row.slot).toISOString(),stage:'OpenClaw 原生调度',status:'completed',reason:'时钟触发成功，不代表业务完成'},{time:new Date(row.slot).toISOString(),stage:'Main 交接',status:row.status,reason:reason??'Main 已接纳；业务结果另行核验'}];
    for(const id of detail.jobIds??[])logs.push({stage:'Worker 任务',status:'worker_submitted',reason:'任务 ID：'+id+'；此处不推断完成状态'});
    for(const receipt of receipts)logs.push({stage:'原群回复',status:'delivered',reason:'飞书消息回执：'+receipt.messageId});
    return {taskId,runId:taskId+':'+row.slot,date:new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(row.slot),startedAt:new Date(row.slot).toISOString(),status,reason,logs};
   });
   const next=job?.state?.nextRunAtMs??job?.nextRunAtMs;
   return {taskId,name:r.name,type:'scheduled-request',source:'openclaw',readOnly:true,enabled:r.status==='enabled'&&job?.enabled===true,status:r.status,reason:r.reason,
    schedule:r.schedule,scope:{kind:'group',label:'项目 '+r.projectId+' · 群 '+r.source.chatId,projectIds:[r.projectId]},requester:r.source.people?.requester?.name??r.source.senderId,
    jobId:r.jobId,chatId:r.source.chatId,nativeAvailable,nativeMissing:nativeAvailable&&!job,nativeLastStatus:job?.state?.lastRunStatus??null,
    nextPlanned:!nativeAvailable?{state:'unavailable'}:next&&job.enabled&&r.status==='enabled'?{state:'scheduled',at:new Date(next).toISOString(),timeZone:tz}:{state:'disabled'},lastRun:records[0]??null,records,hasMore:rows.length>30};
  });
 }
 async function recover(signal){for(const job of await cron().list({includeDisabled:true})){if(job.state?.lastRunStatus==='ok'&&Number.isSafeInteger(job.state.lastRunAtMs))await fire({action:'finished',status:'ok',jobId:job.id,agentId:job.agentId,runAtMs:job.state.lastRunAtMs},signal);}}
 return {manage,fire,recover,inspect,close:()=>db.close()};
}

export function registerScheduledRequests(api,config){
 if(!api.registerService||!api.on)return;
 let manager,controller;const pending=new Set();const inspect=agentId=>manager?.inspect(agentId)??Promise.resolve([]);
 api.registerService({id:'agent-repo-scheduled-requests',start:ctx=>{if(!ctx?.getCron||!ctx.stateDir)return;controller=new AbortController();manager=createScheduledRequests({stateDir:join(ctx.stateDir,'agent-repo-scheduled-requests'),getCron:()=>ctx.getCron?.()});scheduledRequestBridge.inspect=inspect;},stop:async()=>{controller?.abort();await Promise.allSettled([...pending]);manager?.close();manager=undefined;if(scheduledRequestBridge.inspect===inspect)delete scheduledRequestBridge.inspect;}});
 api.on('cron_reconciled',()=>{if(!manager)return;const work=manager.recover(controller.signal).catch(()=>api.logger.warn('Scheduled request recovery needs inspection')).finally(()=>pending.delete(work));pending.add(work);return work;},{timeoutMs:120000});
 api.on('cron_changed',event=>{if(!manager)return;const work=manager.fire(event,controller.signal).catch(()=>api.logger.warn('Scheduled request failed; inspect its saved status before retrying')).finally(()=>pending.delete(work));pending.add(work);return work;},{timeoutMs:120000});
 api.registerTool(context=>!config.agents[context.agentId]?null:{name:'agent_schedule',label:'Ada scheduled requests',description:'Create a scheduled request in the current Feishu conversation, preserving its requester. Explicit recurring authorization required. list/pause/remove are requester-scoped. A submitted tick is not business completion. Reuse requestId after uncertain creation; never create a replacement blindly.',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['create','list','pause','remove']},id:{type:'string'},requestId:{type:'string'},name:{type:'string'},task:{type:'string'},constraints:{type:'string'},projectId:{type:'string'},at:{type:'string'},expr:{type:'string'},timeZone:{type:'string'}}},async execute(_id,params){if(!manager)throw Error('Scheduled request service is unavailable');if(params.action==='create'){const {readProjects}=await import('./repositories.mjs');const projects=await readProjects(config.agents[context.agentId].repo);if(!projects[params.projectId])throw Error('Registered project required');}return {content:[{type:'text',text:JSON.stringify(await manager.manage(params,context))}]};}},{optional:true});
}
