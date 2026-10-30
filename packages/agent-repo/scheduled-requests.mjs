import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

// Only installed channel code may supply trusted provenance or dispatch a run.
export const scheduledRequestBridge=globalThis[Symbol.for('ada.scheduled-requests.v1')]??={};
const tickScript='return {};';
const revision=r=>createHash('sha256').update(JSON.stringify([r.id,r.name,r.schedule,r.status,r.managementRevision??0,r.deliveryMode??'source'])).digest('hex');
const deliveryModes=['source','group','thread'];
const editFields=['name','at','expr','timeZone','deliveryMode'];
const stableInput=params=>JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a],[b])=>a.localeCompare(b))));
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
export function createScheduledRequests({stateDir,getCron,bridge=scheduledRequestBridge,now=Date.now}) {
 mkdirSync(stateDir,{recursive:true,mode:0o700});
 const file=join(stateDir,'scheduled-requests.sqlite'),db=new DatabaseSync(file);chmodSync(file,0o600);
 db.exec(`PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS runs(job TEXT, slot INTEGER, status TEXT, detail TEXT, PRIMARY KEY(job,slot));
 CREATE TABLE IF NOT EXISTS operations(agent TEXT, id TEXT, input TEXT, status TEXT, result TEXT, created INTEGER, PRIMARY KEY(agent,id));`);
 const all=()=>db.prepare('SELECT body FROM requests').all().map(r=>JSON.parse(r.body));
 const save=r=>db.prepare('INSERT OR REPLACE INTO requests VALUES (?,?)').run(r.id,JSON.stringify(r));
 const owned=(r,p)=>['agentId','accountId','chatId','sessionKey','senderId','sessionId'].every(k=>r.source[k]===p[k]);
 const snapshot=context=>{const source=bridge.capture?.(context);if(!source)throw Error('A current human Feishu source is required');return structuredClone(source);};
 const cron=()=>{const c=getCron();if(!c)throw Error('Native scheduler is unavailable');return c;};
 const delivery=r=>({mode:r.deliveryMode??'source',target:(r.deliveryMode==='group'||r.deliveryMode!=='thread'&&!r.source.replyInThread)?'group':'thread',canUseThread:!!r.source.rootId,...(r.source.rootId?{threadId:r.source.rootId}:{})});
 const validateDelivery=(mode,source)=>{if(!deliveryModes.includes(mode)||mode==='thread'&&!source.rootId)throw Error('投递位置无效；只能选择原位置、当前群主会话或原请求所在话题');return mode;};
 const publicRecord=r=>({id:r.id,revision:revision(r),delivery:delivery(r),deliveryMode:r.deliveryMode??'source',busy:busy(r),sourceValid:!!bridge.current?.(r.source),jobId:r.jobId,name:r.name,task:r.task,constraints:r.constraints,projectId:r.projectId,schedule:r.schedule,status:r.status,reason:r.reason,lastRun:r.lastRun,runs:db.prepare('SELECT slot,status FROM runs WHERE job=? ORDER BY slot DESC LIMIT 10').all(r.jobId??'')});
 async function createRequest(params,source,paused=false){
   const previous=all().find(r=>owned(r,source)&&r.requestId===params.requestId);
   if(!text(params.requestId,160)||!text(params.name,160)||!text(params.task,4000)||!text(params.constraints,4000)||!text(params.projectId,64))throw Error('requestId, name, projectId, task and constraints are required');
   let schedule;
   if(params.at!==undefined){if(params.expr!==undefined||params.timeZone!==undefined||!text(params.at,100)||!/(Z|[+-]\d{2}:\d{2})$/.test(params.at)||!Number.isFinite(Date.parse(params.at))||(Date.parse(params.at)<=now()&&!previous))throw Error('at must be a future timestamp with timezone');schedule={kind:'at',at:new Date(params.at).toISOString()};}
   else {if(!text(params.expr,120)||params.expr.trim().split(/\s+/).length!==5)throw Error('A five-field cron expression is required');const tz=params.timeZone??'Asia/Shanghai';new Intl.DateTimeFormat('en',{timeZone:tz});schedule={kind:'cron',expr:params.expr,tz,staggerMs:0};}
   const input={name:params.name,task:params.task,constraints:params.constraints,projectId:params.projectId,schedule,deliveryMode:validateDelivery(params.deliveryMode??'source',source)};
   if(previous){if(stableInput({...previous.input,deliveryMode:previous.input.deliveryMode??'source'})!==stableInput(input))throw Error('requestId already belongs to different input');return publicRecord(previous);}
   if(!bridge.current?.(source))throw Error('Source authorization is no longer current');
   const r={id:randomUUID(),source,requestId:params.requestId,input,...input,status:'creating',createdAt:now()};save(r);
   try{
    // A fixed, tool-free script is only a clock tick. Business text stays in the private store.
    const job=await cron().add({name:'Ada: '+r.name,description:'agent-repo scheduled request '+r.id,agentId:source.agentId,enabled:false,schedule,sessionTarget:'isolated',wakeMode:'next-heartbeat',deleteAfterRun:false,payload:{kind:'script',script:tickScript,toolsAllow:[],timeoutSeconds:30},delivery:{mode:'none'}});
    if(!job?.id)throw Error('Scheduler did not return a job ID');r.jobId=job.id;r.schedule=job.schedule??schedule;r.status='paused';save(r);
    if(!bridge.current?.(source))throw Error('Source authorization changed during creation');
    if(!paused){r.status='enabled';save(r);await cron().update(job.id,{enabled:true});}return publicRecord(r);
   }catch(error){r.status='needs_review';save(r);throw Error('Schedule creation is incomplete; inspect the saved request before retrying',{cause:error});}
 }
 async function manage(params,context){
  const source=snapshot(context);
  const allowed={create:['requestId','name','task','constraints','projectId','at','expr','timeZone','deliveryMode'],list:['projectId','status','query','limit','offset'],get:['id'],history:['id','limit','offset'],update:['id','requestId','expectedRevision',...editFields],pause:['id','requestId','expectedRevision'],resume:['id','requestId','expectedRevision'],remove:['id','requestId','expectedRevision'],run:['id','requestId','expectedRevision']};
  if(!params||!Object.hasOwn(allowed,params.action)||Object.keys(params).some(k=>k!=='action'&&!allowed[params.action].includes(k)))throw Error('Unsupported schedule action or parameters');
  const page=()=>{const limit=params.limit??50,offset=params.offset??0;if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw Error('limit must be 1–100 and offset non-negative');return {limit,offset};};
  if(params.action==='list'){
   const {limit,offset}=page();if(params.query!==undefined&&!text(params.query,160))throw Error('Invalid query');
   if(params.status!==undefined&&!['enabled','paused','completed','removed','blocked','creating','needs_review'].includes(params.status))throw Error('Invalid status');
   const rows=all().filter(r=>owned(r,source)&&(!params.projectId||r.projectId===params.projectId)&&(!params.status||r.status===params.status)&&(!params.query||[r.name,r.task].some(v=>v.toLowerCase().includes(params.query.toLowerCase()))));
   return {tasks:rows.slice(offset,offset+limit).map(publicRecord),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null};
  }
  if(params.action==='create')return createRequest(params,source);
  const r=all().find(r=>r.id===params.id&&owned(r,source));if(!r)throw Error('Schedule not found in this requester and conversation');
  if(params.action==='get')return publicRecord(r);
  if(params.action==='history'){
   const {limit,offset}=page(),total=db.prepare('SELECT COUNT(*) AS n FROM runs WHERE job=?').get(r.jobId??'').n;
   const records=db.prepare('SELECT slot,status,detail FROM runs WHERE job=? ORDER BY slot DESC LIMIT ? OFFSET ?').all(r.jobId??'',limit,offset).map(row=>({at:row.slot,status:row.status,...(row.detail?{detail:JSON.parse(row.detail)}:{})}));
   const operations=db.prepare('SELECT id,input,status,result,created FROM operations WHERE agent=? ORDER BY created DESC').all(source.agentId).filter(o=>{const input=JSON.parse(o.input);return input.id===r.id||JSON.parse(o.result||'{}').id===r.id;}).slice(0,30).map(o=>({requestId:o.id,action:JSON.parse(o.input).action,status:o.status,createdAt:o.created,result:JSON.parse(o.result||'{}')}));
   return {id:r.id,jobId:r.jobId,records,total,nextOffset:offset+limit<total?offset+limit:null,operations};
  }
  if(!['pause','remove'].includes(params.action)&&(!text(params.requestId,160)||!text(params.expectedRevision,100)))throw Error('requestId and expectedRevision from list/get are required');
  const prior=params.requestId?db.prepare('SELECT input FROM operations WHERE agent=? AND id=?').get(source.agentId,params.requestId):undefined;
  const expectedRevision=params.expectedRevision??(prior?JSON.parse(prior.input).expectedRevision:revision(r));
  const operation=await administer(source.agentId,{...params,expectedRevision,requestId:params.requestId??randomUUID(),confirmed:true});
  return {...publicRecord(getOwned(source.agentId,r.id)),operation};
 }
 async function fire(event,signal){
  if(event.action!=='finished'||event.status!=='ok'||!Number.isSafeInteger(event.runAtMs))return;
  const r=all().find(r=>r.jobId===event.jobId);if(!r||r.status!=='enabled')return;
  if(event.agentId!==r.source.agentId||event.runAtMs<(r.acceptAfter??0))return;
  if(r.lastRun?.jobIds?.length&&(!bridge.jobsActive||bridge.jobsActive(r.lastRun.jobIds,r.source)))return;
  const jobs=await cron().list({includeDisabled:true});const job=jobs.find(j=>j.id===r.jobId);
  // A user-edited native job cannot silently change the authorized plan or executor.
  if(!job||(job.enabled===false&&r.schedule.kind!=='at')||job.agentId!==r.source.agentId||job.description!=='agent-repo scheduled request '+r.id||job.payload?.kind!=='script'||job.payload?.script!==tickScript||job.delivery?.mode!=='none'||JSON.stringify(job.schedule)!==JSON.stringify(r.schedule))return;
  const latestBeforeClaim=all().find(x=>x.id===r.id);
  if(latestBeforeClaim?.status!=='enabled'||(latestBeforeClaim.managementRevision??0)!==(r.managementRevision??0)||signal?.aborted)return;
  if(!bridge.current)throw Error('Feishu scheduled source validator is unavailable');
  if(!bridge.current(r.source)){r.status='blocked';r.reason='source_or_session_invalid';save(r);await cron().update(r.jobId,{enabled:false});return;}
  if(!bridge.deliver)throw Error('Feishu scheduled request adapter is unavailable');
  // Atomic claim survives duplicates, concurrent callbacks and restart. Unknown turns are never replayed.
  if(!db.prepare('INSERT OR IGNORE INTO runs VALUES (?,?,?,?)').run(r.jobId,event.runAtMs,'dispatching','').changes)return;
  if(db.prepare("SELECT 1 FROM runs WHERE job=? AND slot<>? AND status IN ('dispatching','unknown')").get(r.jobId,event.runAtMs)){db.prepare('UPDATE runs SET status=? WHERE job=? AND slot=?').run('blocked',r.jobId,event.runAtMs);return;}
  const run={...r,trigger:r.manualPending?'manual':'scheduled',runAtMs:event.runAtMs,runKey:r.id+':'+event.runAtMs};
  const assertCurrent=()=>{if(signal?.aborted||all().find(x=>x.id===r.id)?.status!=='enabled'||(all().find(x=>x.id===r.id)?.managementRevision??0)!==(r.managementRevision??0)||!bridge.current?.(r.source))throw Error('Scheduled request authorization is no longer current');};
  try{
   assertCurrent();const receipt=await bridge.deliver(run,{signal,assertCurrent});
   if(!receipt?.accepted)throw Error('No Main admission receipt');
   db.prepare('UPDATE runs SET status=?,detail=? WHERE job=? AND slot=?').run('submitted',JSON.stringify({...receipt,trigger:run.trigger,deliveryMode:r.deliveryMode??'source',scheduleRevision:revision(r)}),r.jobId,event.runAtMs);
   const latest=all().find(x=>x.id===r.id);delete latest.manualPending;latest.lastRun={at:event.runAtMs,status:'submitted',jobIds:receipt.jobIds??[]};
   if(r.schedule.kind==='at'&&latest.status==='enabled')latest.status='completed';save(latest);
  }catch(error){db.prepare('UPDATE runs SET status=?,detail=? WHERE job=? AND slot=?').run('unknown',JSON.stringify({deliveryMode:r.deliveryMode??'source',scheduleRevision:revision(r),stage:error?.scheduledStage??'dispatch',name:error?.name??'Error',message:String(error?.message??error).slice(0,1000)}),r.jobId,event.runAtMs);const latest=all().find(x=>x.id===r.id);delete latest.manualPending;latest.lastRun={at:event.runAtMs,status:'unknown'};save(latest);throw error;}
 }
 const locks=new Set();
 const getOwned=(agentId,id)=>{const r=all().find(r=>r.id===id&&r.source.agentId===agentId);if(!r)throw Error('任务不存在或不属于当前 Agent');return r;};
 const busy=r=>locks.has(r.source.agentId+':'+r.id)||!!r.manualPending||!!db.prepare("SELECT 1 FROM runs WHERE job=? AND status IN ('dispatching','unknown')").get(r.jobId??'')||!!(r.lastRun?.jobIds?.length&&(!bridge.jobsActive||bridge.jobsActive(r.lastRun.jobIds,r.source)));
 async function catalog(agentId){
  let canRun=false;try{canRun=typeof cron().enqueueRun==='function';}catch{}
  return {agentId,available:true,canRun,tasks:all().filter(r=>r.source.agentId===agentId).map(r=>({...publicRecord(r),revision:revision(r),busy:busy(r),sourceValid:!!bridge.current?.(r.source),chatId:r.source.chatId,requester:r.source.people?.requester?.name??r.source.senderId,originId:r.originId??r.id,manualPending:!!r.manualPending})),operations:db.prepare('SELECT id,input,status,result,created FROM operations WHERE agent=? ORDER BY created DESC LIMIT 30').all(agentId).map(o=>({requestId:o.id,action:JSON.parse(o.input).action,status:o.status,createdAt:o.created,result:JSON.parse(o.result||'{}')}))};
 }
 async function administer(agentId,params){
  if(!text(agentId,100)||!params||Object.keys(params).some(k=>!['action','id','sourceId','expectedRevision','requestId','confirmed',...editFields].includes(k))||params.confirmed!==true||!text(params.requestId,160))throw Error('管理参数无效，必须确认操作');
  if(!['create','update','pause','resume','remove','run'].includes(params.action))throw Error('不支持的管理操作');
  if(params.action!=='create'&&params.sourceId!==undefined||params.action==='create'&&params.id!==undefined)throw Error('任务来源参数无效');
  if(!['create','update'].includes(params.action)&&editFields.some(k=>params[k]!==undefined))throw Error('操作包含无效编辑参数');
  const encoded=stableInput(params),prior=db.prepare('SELECT * FROM operations WHERE agent=? AND id=?').get(agentId,params.requestId);
  if(prior){if(stableInput(JSON.parse(prior.input))!==encoded)throw Error('requestId 已用于其他操作');return {...JSON.parse(prior.result||'{}'),status:prior.status};}
  const id=params.action==='create'?params.sourceId:params.id,r=getOwned(agentId,id),key=agentId+':'+id;
  if(locks.has(key))throw Error('任务正在变更，请稍后刷新');
  if(params.expectedRevision!==revision(r))throw Error('任务已改变，请刷新后重试');
  if(r.status==='removed'&&params.action!=='create')throw Error('任务已删除，历史记录仍保留');
  if(!['pause','remove'].includes(params.action)&&busy(r))throw Error('已有运行中或结果待核验的任务，请先核验，不能重复执行');
  if(!['pause','remove'].includes(params.action)&&!bridge.current?.(r.source))throw Error('原群请求已失效，不能恢复或新建');
  if(['resume','run','update'].includes(params.action)&&!['enabled','paused',...(params.action==='update'?['completed']:[])].includes(r.status))throw Error('任务状态需要核验，不能直接恢复或修改');
  if(params.action==='create'&&!['enabled','paused','completed','removed'].includes(r.status))throw Error('来源计划需要先核验');
  if(params.action==='run'&&(r.status!=='enabled'||typeof cron().enqueueRun!=='function'))throw Error('仅支持立即执行已启用任务；需要宿主原生入队接口');
  let schedule;
  if(['create','update'].includes(params.action)){
   if(params.action==='update'&&!editFields.some(k=>params[k]!==undefined))throw Error('请提供至少一个需要修改的字段');
   if((params.action==='create'||params.name!==undefined)&&!text(params.name,160))throw Error('请输入任务名称');
   if(params.at!==undefined){if(params.expr!==undefined||params.timeZone!==undefined||!text(params.at,100)||!/(Z|[+-]\d{2}:\d{2})$/.test(params.at)||!Number.isFinite(Date.parse(params.at))||Date.parse(params.at)<=now())throw Error('一次性时间必须带时区且在未来，不能同时提交 Cron 或时区');schedule={kind:'at',at:new Date(params.at).toISOString()};}
   else if(params.action==='create'||params.expr!==undefined||params.timeZone!==undefined){const expr=params.expr??(r.schedule.kind==='cron'?r.schedule.expr:undefined);if(!text(expr,120)||expr.trim().split(/\s+/).length!==5)throw Error('请输入五字段 cron');const tz=params.timeZone??(r.schedule.kind==='cron'?r.schedule.tz:undefined)??'Asia/Shanghai';new Intl.DateTimeFormat('en',{timeZone:tz});schedule={kind:'cron',expr,tz,staggerMs:0};}
   if(params.deliveryMode!==undefined)validateDelivery(params.deliveryMode,r.source);
  }
  if(params.action==='resume'&&r.schedule.kind==='at'&&Date.parse(r.schedule.at)<=now())throw Error('一次性时间已过期，请先修改时间');
  locks.add(key);
  db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?)').run(agentId,params.requestId,encoded,'pending','{}',now());
  try{
   let result;
   if(params.action==='create'){
    result=await createRequest({action:'create',requestId:'panel:'+params.requestId,name:params.name,task:r.task,constraints:r.constraints,projectId:r.projectId,deliveryMode:params.deliveryMode??r.deliveryMode??'source',...(schedule.kind==='at'?{at:schedule.at}:{expr:schedule.expr,timeZone:schedule.tz})},structuredClone(r.source),true);
    const created=getOwned(agentId,result.id);created.originId=r.originId??r.id;created.managementRevision=1;save(created);
   }else if(params.action==='run'){
    const job=(await cron().list({includeDisabled:true})).find(j=>j.id===r.jobId);
    if(!job?.enabled||job.agentId!==agentId||job.description!=='agent-repo scheduled request '+r.id||job.payload?.kind!=='script'||job.payload.script!==tickScript||job.delivery?.mode!=='none'||JSON.stringify(job.schedule)!==JSON.stringify(r.schedule))throw Error('原生计划不一致，请核验');
    r.manualPending={requestId:params.requestId,at:now()};save(r);
    result=await cron().enqueueRun(r.jobId,'force');
    if(!result?.ok||result.enqueued!==true)throw Error('原生调度未确认入队，请核验后再操作');
   }else{
    // Revoke admission before awaiting a native mutation. A failed write remains
    // needs_review and never resumes business dispatch automatically.
    const enabled=params.action==='resume'||params.action==='update'&&r.status==='enabled';
    r.managementRevision=(r.managementRevision??0)+1;r.status=params.action==='remove'?'removed':'paused';r.acceptAfter=now();save(r);
    if(params.action==='remove'){
     const job=(await cron().list({includeDisabled:true})).find(j=>j.id===r.jobId);
     if(job&&(job.agentId!==agentId||job.description!=='agent-repo scheduled request '+r.id))throw Error('原生计划归属不一致');
     result=job?await cron().remove(r.jobId):{removed:false};
    }
    else{
     const job=(await cron().list({includeDisabled:true})).find(j=>j.id===r.jobId);
     if(!job||job.agentId!==agentId||job.description!=='agent-repo scheduled request '+r.id||job.payload?.kind!=='script'||job.payload.script!==tickScript||job.delivery?.mode!=='none')throw Error('原生计划不一致，请核验');
     if(!schedule&&JSON.stringify(job.schedule)!==JSON.stringify(r.schedule))throw Error('原生计划已改变，请先编辑核验');
     if(params.name!==undefined)r.name=params.name;if(schedule)r.schedule=schedule;if(params.deliveryMode!==undefined)r.deliveryMode=params.deliveryMode;
     save(r);
     result=await cron().update(r.jobId,{enabled,...(params.name!==undefined?{name:'Ada: '+r.name}:{}),...(schedule?{schedule:r.schedule}:{})});
     if(enabled&&result?.schedule&&JSON.stringify(result.schedule)!==JSON.stringify(r.schedule))throw Error('原生计划返回不一致');
     if(!bridge.current?.(r.source)&&enabled)throw Error('原群请求已失效');
     r.status=enabled?'enabled':'paused';save(r);
    }
   }
   const receipt={id:params.action==='create'?result.id:r.id,action:params.action,...(params.action==='run'?{runId:result.runId,enqueued:true}:{})};
   db.prepare('UPDATE operations SET status=?,result=? WHERE agent=? AND id=?').run('succeeded',JSON.stringify(receipt),agentId,params.requestId);return {...receipt,status:'succeeded'};
  }catch(error){
   if(params.action!=='create'&&!['pause','remove'].includes(params.action)){const latest=getOwned(agentId,r.id);latest.status='needs_review';save(latest);}
   db.prepare('UPDATE operations SET status=?,result=? WHERE agent=? AND id=?').run('unknown',JSON.stringify({id:r.id,action:params.action,reason:'操作结果未确认，请刷新并核验；不要重复提交。'}),agentId,params.requestId);
   throw Error('操作结果未确认，请刷新并核验；不要重复提交。',{cause:error});
  }finally{locks.delete(key);}
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
    const logs=[{time:new Date(row.slot).toISOString(),stage:'OpenClaw 原生调度',status:'completed',reason:(detail.trigger==='manual'?'管理员手动执行，计划时间不变；':'')+'时钟触发成功，不代表业务完成'},{time:new Date(row.slot).toISOString(),stage:'Main 交接',status:row.status,reason:reason??'Main 已接纳；业务结果另行核验'}];
    for(const id of detail.jobIds??[])logs.push({stage:'Worker 任务',status:'worker_submitted',reason:'任务 ID：'+id+'；此处不推断完成状态'});
    for(const receipt of receipts)logs.push({stage:'原群回复',status:'delivered',reason:'飞书消息回执：'+receipt.messageId});
    return {taskId,runId:taskId+':'+row.slot,date:new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(row.slot),startedAt:new Date(row.slot).toISOString(),status,reason,logs};
   });
   const next=job?.state?.nextRunAtMs??job?.nextRunAtMs;
   return {taskId,name:r.name,type:'scheduled-request',source:'openclaw',readOnly:true,enabled:r.status==='enabled'&&job?.enabled===true,status:r.status,reason:r.reason,
    schedule:r.schedule,delivery:delivery(r),deliveryMode:r.deliveryMode??'source',scope:{kind:'group',label:'项目 '+r.projectId+' · 群 '+r.source.chatId,projectIds:[r.projectId]},requester:r.source.people?.requester?.name??r.source.senderId,
    jobId:r.jobId,chatId:r.source.chatId,nativeAvailable,nativeMissing:nativeAvailable&&!job,nativeLastStatus:job?.state?.lastRunStatus??null,
    nextPlanned:!nativeAvailable?{state:'unavailable'}:next&&job.enabled&&r.status==='enabled'?{state:'scheduled',at:new Date(next).toISOString(),timeZone:tz}:{state:'disabled'},lastRun:records[0]??null,records,hasMore:rows.length>30};
  });
 }
 async function recover(signal){for(const job of await cron().list({includeDisabled:true})){if(job.state?.lastRunStatus==='ok'&&Number.isSafeInteger(job.state.lastRunAtMs))await fire({action:'finished',status:'ok',jobId:job.id,agentId:job.agentId,runAtMs:job.state.lastRunAtMs},signal);}}
 return {manage,fire,recover,inspect,catalog,administer,close:()=>db.close()};
}

export function registerScheduledRequests(api,config){
 if(!api.registerService||!api.on)return;
 let manager,controller;const pending=new Set();const inspect=agentId=>manager?.inspect(agentId)??Promise.resolve([]);const catalog=agentId=>{if(!manager)throw Error('定时任务服务不可用');return manager.catalog(agentId);};const administer=(agentId,params)=>{if(!manager)throw Error('定时任务服务不可用');const work=manager.administer(agentId,params).finally(()=>pending.delete(work));pending.add(work);return work;};
 api.registerService({id:'agent-repo-scheduled-requests',start:ctx=>{if(!ctx?.getCron||!ctx.stateDir)return;controller=new AbortController();manager=createScheduledRequests({stateDir:join(ctx.stateDir,'agent-repo-scheduled-requests'),getCron:()=>ctx.getCron?.()});Object.assign(scheduledRequestBridge,{inspect,catalog,administer});},stop:async()=>{controller?.abort();await Promise.allSettled([...pending]);manager?.close();manager=undefined;for(const [key,value] of Object.entries({inspect,catalog,administer}))if(scheduledRequestBridge[key]===value)delete scheduledRequestBridge[key];}});
 api.on('cron_reconciled',()=>{if(!manager)return;const work=manager.recover(controller.signal).catch(()=>api.logger.warn('Scheduled request recovery needs inspection')).finally(()=>pending.delete(work));pending.add(work);return work;},{timeoutMs:120000});
 api.on('cron_changed',event=>{if(!manager)return;const work=manager.fire(event,controller.signal).catch(()=>api.logger.warn('Scheduled request failed; inspect its saved status before retrying')).finally(()=>pending.delete(work));pending.add(work);return work;},{timeoutMs:120000});
 api.registerTool(context=>!config.agents[context.agentId]?null:{name:'agent_schedule',label:'Ada scheduled requests',description:'Manage this human requester’s saved schedules in the current Feishu conversation. list/get/history are read-only; update patches name, time/timezone or deliveryMode without replacing the plan. group sends future results to the same group main chat; thread uses only the original thread. get/list return revision: pass it as expectedRevision and a stable requestId for update/resume/run. run requires explicit immediate-execution authorization, uses the native queue, and is not business completion. Unknown results must be inspected, never recreated. No arbitrary recipients or task/permission changes.',parameters:scheduledRequestToolParameters,async execute(_id,params){if(!manager)throw Error('Scheduled request service is unavailable');if(['create','update','resume','run'].includes(params.action)){const {readProjects}=await import('./repositories.mjs');const projects=await readProjects(config.agents[context.agentId].repo);const projectId=params.action==='create'?params.projectId:(await manager.manage({action:'get',id:params.id},context)).projectId;if(!Object.hasOwn(projects,projectId))throw Error('Registered project required');}return {content:[{type:'text',text:JSON.stringify(await manager.manage(params,context))}]};}},{optional:true});
}

export const scheduledRequestToolParameters={type:'object',additionalProperties:false,required:['action'],properties:{
 action:{type:'string',enum:['create','list','get','history','update','pause','resume','remove','run']},
 id:{type:'string',description:'Saved schedule ID returned by create/list/get; not native jobId.'},
 requestId:{type:'string',maxLength:160,description:'Stable idempotency key; reuse identical input after uncertain results.'},
 expectedRevision:{type:'string',description:'Current revision from list/get; required for update/resume/run.'},
 name:{type:'string',maxLength:160},task:{type:'string',maxLength:4000,description:'Create only; existing business scope cannot be expanded by update.'},constraints:{type:'string',maxLength:4000},projectId:{type:'string',maxLength:64},
 at:{type:'string',description:'Future ISO timestamp including timezone; exclusive with expr/timeZone.'},expr:{type:'string',description:'Five-field cron expression.'},timeZone:{type:'string',description:'IANA timezone, e.g. Asia/Shanghai.'},
 deliveryMode:{type:'string',enum:deliveryModes,description:'source (default): original position; group: same group main chat, no reply target; thread: original known thread only. Applies to future Main and Worker results.'},
 status:{type:'string',enum:['enabled','paused','completed','removed','blocked','creating','needs_review'],description:'List filter.'},query:{type:'string',maxLength:160,description:'List filter by saved name/task.'},limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0}
}};
