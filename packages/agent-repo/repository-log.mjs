import {withRepositoryDatabase,repositoryTransaction} from './database.mjs';
import {rootAudit,auditBegin,auditFinish} from './audit.mjs';
import {open,readdir,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {git} from './repository-skills.mjs';
const purgeLocks=new Set();
const validAgent=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const fields=['time','repository','stage','status','reason','effect','code','cause','errorType','runId'];
const clean=value=>value.replace(/https?:\/\/\S+/g,'[URL omitted]').slice(0,2000);
async function location(root,agentId){
 if(!validAgent(agentId))throw Error('Invalid repository log Agent');
 return {directory:(await git(root,['rev-parse','--absolute-git-dir'])).trim(),prefix:`agent-repo-log-${agentId}-`};
}
async function names(directory,prefix){return (await readdir(directory)).filter(name=>name.startsWith(prefix)&&/^\d{13}-[a-f0-9-]{36}\.json$/.test(name.slice(prefix.length))).sort().reverse();}
export async function writeRepositoryLog(root,agentId,entry){
 const {directory,prefix}=await location(root,agentId),record={agentId,time:new Date().toISOString()};
 for(const field of fields.filter(key=>key!=='time'))if(typeof entry[field]==='string')record[field]=clean(entry[field]);
 const handle=await open(join(directory,`${prefix}${Date.now()}-${randomUUID()}.json`),'wx',0o600);
 try{await handle.writeFile(JSON.stringify(record));}finally{await handle.close();}
 const retained=hidden(root,agentId);for(const name of (await names(directory,prefix)).filter(n=>!retained.has(n)).slice(100))await unlink(join(directory,name)).catch(()=>{});
}
export async function readRepositoryLogs(root,agentId){
 const {directory,prefix}=await location(root,agentId),records=[],retained=hidden(root,agentId);
 for(const name of (await names(directory,prefix)).filter(n=>!retained.has(n)).slice(0,100)){
  let handle;
  try{
   handle=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   const stat=await handle.stat();if(!stat.isFile()||stat.size>32*1024)continue;
   const record=JSON.parse(await handle.readFile('utf8'));if(record.agentId!==agentId)continue;
   records.push(Object.fromEntries(fields.flatMap(key=>typeof record[key]==='string'?[[key,clean(record[key])]]:[])));
  }catch{}finally{await handle?.close();}
 }
 return {agentId,records,limit:100};
}
const trashDb=withRepositoryDatabase;
const hidden=(root,agentId)=>trashDb(root,db=>new Set(db.prepare('SELECT name FROM hidden_logs WHERE agent=?').all(agentId).map(r=>r.name)));
export async function clearRepositoryLogs(root,agentId){
 const {directory,prefix}=await location(root,agentId),already=hidden(root,agentId),selected=(await names(directory,prefix)).filter(n=>!already.has(n));
 if(selected.length){const batch=randomUUID(),revision=randomUUID(),at=Date.now();repositoryTransaction(root,db=>{for(const name of selected)db.prepare('INSERT OR IGNORE INTO hidden_logs VALUES(?,?,?,?,?)').run(agentId,name,batch,at,revision);});}
 return {...await readRepositoryLogs(root,agentId),cleared:selected.length,recycled:true};
}
export function recycledRepositoryLogs(root,agentId){return trashDb(root,db=>db.prepare('SELECT batch,deleted,revision,count(*) count FROM hidden_logs WHERE agent=? GROUP BY batch ORDER BY deleted DESC').all(agentId).map(r=>({id:r.batch,name:'仓库日志 · '+r.count+' 条',feature:'logs',provider:'logs',kind:'logs',deletedAt:r.deleted,revision:r.revision,restorePending:r.revision.startsWith('purging:')})));}
export async function restoreRepositoryLogs(root,agentId,{id,expectedRevision}){
 const {directory,prefix}=await location(root,agentId),present=new Set(await names(directory,prefix));
 return repositoryTransaction(root,db=>{const rows=db.prepare('SELECT name,revision FROM hidden_logs WHERE agent=? AND batch=?').all(agentId,id);if(!rows.length||rows.some(r=>r.revision.startsWith('purging:')||r.revision!==expectedRevision||!present.has(r.name)))throw Error('日志已变化或原文件缺失，不能恢复');db.prepare('DELETE FROM hidden_logs WHERE agent=? AND batch=?').run(agentId,id);return {restored:true,id};});
}
export async function purgeRepositoryLogs(root,agentId,cutoff){
 if(!Number.isSafeInteger(cutoff)||cutoff<0)throw Error('回收站清理时间无效');const {directory,prefix}=await location(root,agentId),purged=[];
 for(const batch of recycledRepositoryLogs(root,agentId)){
  if(batch.deletedAt>cutoff)continue;const key=JSON.stringify([root,agentId,batch.id]);if(purgeLocks.has(key))continue;purgeLocks.add(key);try{
  // Claim with a new revision so stale restore requests cannot race permanent unlink.
  const claim='purging:'+randomUUID(),selected=repositoryTransaction(root,db=>{const rows=db.prepare('SELECT name FROM hidden_logs WHERE agent=? AND batch=? AND revision=?').all(agentId,batch.id,batch.revision);db.prepare('UPDATE hidden_logs SET revision=? WHERE agent=? AND batch=? AND revision=?').run(claim,agentId,batch.id,batch.revision);return rows;});if(!selected.length)continue;
  const auditId=rootAudit(root,db=>auditBegin(db,{agentId,feature:'logs',targetId:batch.id,action:'purge',actor:{kind:'system',id:'retention-cleanup'},executor:'recycle-bin'}));
  try{for(const {name} of selected){if(!name.startsWith(prefix)||!/^\d{13}-[a-f0-9-]{36}\.json$/.test(name.slice(prefix.length)))throw Error('日志记录路径无效');try{await unlink(join(directory,name));}catch(e){if(e.code!=='ENOENT')throw e;}}trashDb(root,db=>db.prepare('DELETE FROM hidden_logs WHERE agent=? AND batch=? AND revision=?').run(agentId,batch.id,claim));rootAudit(root,db=>auditFinish(db,auditId,'succeeded',null));purged.push(batch.id);}catch{rootAudit(root,db=>auditFinish(db,auditId,'unknown',null));throw Error('日志清理结果待核验');}
  }finally{purgeLocks.delete(key);}
 }return {purged};
}
