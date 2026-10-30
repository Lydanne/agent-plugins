import {recycledRepositoryLogs,restoreRepositoryLogs,purgeRepositoryLogs} from './repository-log.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {withRepositoryDatabase,repositoryTransaction} from './database.mjs';
import {createEntityStore} from './entities.mjs';
import {scheduledRequestBridge} from './scheduled-requests.mjs';
import {repositoryScheduleBridge} from './scheduled-tasks.mjs';
import {rootAudit,auditBegin,auditFinish,panelAuditActor} from './audit.mjs';
import {readProjects} from './repositories.mjs';
import {dayMs} from './recycle-store.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const database=withRepositoryDatabase;
export function recycleSettings(root,agentId){return database(root,db=>{const row=db.prepare('SELECT body FROM recycle_settings WHERE agent=?').get('retention');return row?JSON.parse(row.body):{retentionDays:30,revision:hash([30])};});}
const writer=ctx=>{if(!ctx.client?.scopes?.some(s=>['operator.write','operator.admin'].includes(s)))throw Error('回收站管理需要写入权限');};
function operation(root,agentId,p,fn){
 if(typeof p.requestId!=='string'||!p.requestId||p.requestId.length>160||p.confirmed!==true)throw Error('请确认操作并提供稳定请求 ID');
 const input=hash(Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b)))),prior=database(root,db=>db.prepare('SELECT input,result FROM recycle_operations WHERE agent=? AND id=?').get(agentId,p.requestId));if(prior){if(prior.input!==input)throw Error('请求 ID 已用于其他操作');return Promise.resolve(JSON.parse(prior.result));}
 database(root,db=>db.prepare('INSERT INTO recycle_operations VALUES(?,?,?,?)').run(agentId,p.requestId,input,JSON.stringify({status:'pending'})));
 return Promise.resolve().then(fn).then(result=>{const receipt={status:'succeeded',...result};database(root,db=>db.prepare('UPDATE recycle_operations SET result=? WHERE agent=? AND id=?').run(JSON.stringify(receipt),agentId,p.requestId));return receipt;},error=>{database(root,db=>db.prepare('UPDATE recycle_operations SET result=? WHERE agent=? AND id=?').run(JSON.stringify({status:'unknown'}),agentId,p.requestId));throw error;});
}
export async function recycleCatalog(root,agentId,p={},now=Date.now()){
 if(Object.keys(p).some(k=>!['feature','query','limit','offset'].includes(k))||p.feature!==undefined&&!['schedules','entities','logs'].includes(p.feature)||p.query!==undefined&&(typeof p.query!=='string'||p.query.length>160))throw Error('回收站筛选无效');
 const {limit=25,offset=0}=p;if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw Error('回收站分页无效');
 const settings=recycleSettings(root,agentId),records=[],unavailable=[];
 if(!p.feature||p.feature==='logs')records.push(...recycledRepositoryLogs(root,agentId));
 if(!p.feature||p.feature==='entities')records.push(...createEntityStore(root).trash());
 if(!p.feature||p.feature==='schedules')for(const [name,bridge] of [['群计划',scheduledRequestBridge],['系统计划',repositoryScheduleBridge]]){if(!bridge.trash){unavailable.push(name);continue;}try{records.push(...await bridge.trash(agentId));}catch{unavailable.push(name);}}
 const rows=records.filter(r=>(!p.feature||r.feature===p.feature)&&(!p.query||[r.name,r.id].some(s=>s.toLowerCase().includes(p.query.toLowerCase())))).map(r=>({...r,expiresAt:r.deletedAt+settings.retentionDays*dayMs,expired:r.deletedAt+settings.retentionDays*dayMs<=now})).sort((a,b)=>b.deletedAt-a.deletedAt||a.id.localeCompare(b.id));
 const cleanup=database(root,db=>{const row=db.prepare('SELECT body FROM recycle_cleanup WHERE agent=?').get(agentId);return row?JSON.parse(row.body):null;});
 return {agentId,settings,cleanup,records:rows.slice(offset,offset+limit),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,unavailable};
}
export async function restoreRecycled(root,agentId,p,ctx){
 writer(ctx);if(Object.keys(p).some(k=>!['provider','id','expectedRevision','requestId','confirmed'].includes(k))||!['entities','group-schedules','system-schedules','logs'].includes(p.provider)||typeof p.id!=='string'||!p.id||p.id.length>200||typeof p.expectedRevision!=='string'||!p.expectedRevision||p.expectedRevision.length>200||typeof p.requestId!=='string'||p.requestId.length>120)throw Error('回收站恢复参数无效');
 return operation(root,agentId,p,async()=>{
  const actor=panelAuditActor(ctx),auditId=rootAudit(root,db=>auditBegin(db,{agentId,feature:'recycle',targetId:p.id,action:'restore',actor,executor:'control-ui',requestId:p.requestId}));
  try{let result;
   if(p.provider==='logs')result=await restoreRepositoryLogs(root,agentId,p);
   else if(p.provider==='entities')result=createEntityStore(root).restore({id:p.id,expectedRevision:p.expectedRevision,actor:actor.id??'operator'});
   else{
    const bridge=p.provider==='group-schedules'?scheduledRequestBridge:repositoryScheduleBridge;if(!bridge.administer||!bridge.trash)throw Error('计划回收站服务不可用');
    const entry=(await bridge.trash(agentId)).find(r=>r.id===p.id);if(!entry||entry.revision!==p.expectedRevision)throw Error('回收站记录已变化，请刷新');
    if(p.provider==='group-schedules'){const catalog=await bridge.catalog(agentId,{includeRemoved:true}),task=catalog.tasks.find(r=>r.id===p.id),projects=await readProjects(root);if(!task||!Object.hasOwn(projects,task.projectId))throw Error('原项目未登记，不能恢复');}
    result=await bridge.administer(agentId,{action:'restore',id:p.id,expectedRevision:p.expectedRevision,requestId:'recycle:'+p.requestId,confirmed:true},{actor,executor:'recycle-bin'});
    if(result.status!=='succeeded'){rootAudit(root,db=>auditFinish(db,auditId,'unknown',null));return {status:result.status};}
   }
   rootAudit(root,db=>auditFinish(db,auditId,'succeeded',null));return {restored:true,id:p.id};
  }catch(error){rootAudit(root,db=>auditFinish(db,auditId,'unknown',null));throw error;}
 });
}
export async function configureRecycle(root,agentId,p,ctx){
 writer(ctx);if(Object.keys(p).some(k=>!['retentionDays','expectedRevision','requestId','confirmed'].includes(k))||!Number.isInteger(p.retentionDays)||p.retentionDays<1||p.retentionDays>3650)throw Error('保留天数必须为 1–3650 的整数');
 return operation(root,agentId,p,()=>repositoryTransaction(root,db=>{
  const old=db.prepare('SELECT body FROM recycle_settings WHERE agent=?').get('retention'),before=old?JSON.parse(old.body):{retentionDays:30,revision:hash([30])};if(before.revision!==p.expectedRevision)throw Error('配置已变化，请刷新');
   const after={retentionDays:p.retentionDays,revision:randomUUID()};const auditId=auditBegin(db,{agentId,feature:'recycle',targetId:'retention',action:'configureRetention',actor:panelAuditActor(ctx),executor:'control-ui',requestId:p.requestId,before:{retentionDays:before.retentionDays},requested:{retentionDays:p.retentionDays}});
   db.prepare('INSERT OR REPLACE INTO recycle_settings VALUES(?,?)').run('retention',JSON.stringify(after));auditFinish(db,auditId,'succeeded',{retentionDays:after.retentionDays});return {settings:after};
 }));
}
export async function sweepRecycled(root,agentId,now=Date.now()){
 const {retentionDays}=recycleSettings(root,agentId),cutoff=now-retentionDays*dayMs,purged=[],unavailable=[];
 if(cutoff>=0){for(const [name,clean] of [['仓库日志',()=>purgeRepositoryLogs(root,agentId,cutoff)],['实体资料',()=>createEntityStore(root).purgeTrash({cutoff})]])try{purged.push(...(await clean()).purged);}catch{unavailable.push(name);}
 for(const [name,bridge] of [['群计划',scheduledRequestBridge],['系统计划',repositoryScheduleBridge]]){if(!bridge.purgeTrash){unavailable.push(name);continue;}try{purged.push(...(await bridge.purgeTrash(agentId,cutoff)).purged);}catch{unavailable.push(name);}}}
 const result={at:now,retentionDays,status:unavailable.length?'partial':'succeeded',purged:purged.length,unavailable};database(root,db=>db.prepare('INSERT OR REPLACE INTO recycle_cleanup VALUES(?,?)').run(agentId,JSON.stringify(result)));return result;
}

const cleanupScript='return {};';
const cleanupSchedule={kind:'cron',expr:'17 * * * *',tz:'UTC',staggerMs:0};
export function registerRecycleService(api,config,{clock=Date.now,sweep=sweepRecycled}={}){
 let context,active=false,reconciling;const jobs=new Map(),work=new Set();
 const track=promise=>{work.add(promise);promise.finally(()=>work.delete(promise)).catch(()=>{});return promise;};
 const description=id=>'agent-repo recycle cleanup '+id;
 const matches=(job,id)=>job.agentId===id&&job.description===description(id)&&job.payload?.kind==='script'&&job.payload.script===cleanupScript&&job.delivery?.mode==='none'&&JSON.stringify(job.schedule)===JSON.stringify(cleanupSchedule);
 async function reconcile(){if(reconciling)return reconciling;reconciling=(async()=>{const cron=context?.getCron?.();if(!active||!cron)return;
  for(const [id,binding] of Object.entries(config.agents)){if(!active)return;try{const native=await cron.list({includeDisabled:true});if(!active)return;const candidates=native.filter(j=>j.description===description(id));if(candidates.length>1||candidates[0]&&!matches(candidates[0],id))throw Error('Cleanup job requires inspection');const job=candidates[0]??await cron.add({name:'回收站到期清理 · '+id,description:description(id),agentId:id,enabled:true,schedule:cleanupSchedule,sessionTarget:'isolated',wakeMode:'next-heartbeat',deleteAfterRun:false,payload:{kind:'script',script:cleanupScript,toolsAllow:[],timeoutSeconds:30},delivery:{mode:'none'}});if(!job?.id||!matches(job,id)||job.enabled===false)throw Error('Cleanup scheduler unavailable');jobs.set(id,job.id);if(active)await sweep(binding.repo,id,clock());}catch{api.logger?.warn?.('agent-repo: recycle cleanup requires inspection');}}
 })().finally(()=>reconciling=undefined);return reconciling;}
 api.registerService?.({id:'agent-repo-recycle-cleanup',start:ctx=>{context=ctx;active=true;if(!ctx?.getCron){api.logger?.warn?.('agent-repo: recycle cleanup needs native scheduler');return;}return track(reconcile());},stop:async()=>{active=false;jobs.clear();await Promise.allSettled([...work]);context=undefined;}});
 api.on?.('cron_reconciled',()=>active?track(reconcile()):undefined,{timeoutMs:120000});
 api.on?.('cron_changed',event=>{if(!active||event.action!=='finished'||event.status!=='ok'||jobs.get(event.agentId)!==event.jobId)return;return track((async()=>{const job=(await context.getCron().list({includeDisabled:true})).find(j=>j.id===event.jobId);if(active&&job?.enabled&&matches(job,event.agentId))await sweep(config.agents[event.agentId].repo,event.agentId,clock());})());},{timeoutMs:120000});
}
