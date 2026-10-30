import {randomUUID} from 'node:crypto';
import {graphDatabase} from './graph-storage.mjs';
import {withRepositoryDatabase} from './database.mjs';

// Audit metadata is allowlisted by callers. Never persist tool arguments, auth headers or full chat bodies.
export function auditTable(db){db.exec(`CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,agent TEXT NOT NULL,feature TEXT NOT NULL,target TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS audit_time ON audit_events(agent,at DESC,id DESC);
 CREATE INDEX IF NOT EXISTS audit_scope ON audit_events(agent,feature,target,at);`);}
export function scheduleSnapshot(r){return r?{name:r.name??'每日仓库同步',schedule:r.schedule,status:r.status,deliveryMode:r.deliveryMode??'source',jobId:r.jobId??null,revision:r.managementRevision??r.version??0}:null;}
export function humanAuditActor(source){return {kind:'human',id:source.senderId??null,name:source.people?.requester?.name??null,accountId:source.accountId,chatId:source.chatId,messageIds:source.requestMessageIds??source.sourceMessageIds??[],sessionKey:source.sessionKey};}
export function panelAuditActor(ctx){return {kind:'operator',id:ctx.client?.connId??null,name:null,identityNote:'宿主仅提供控制面板连接身份，未提供实名',sessionKey:ctx.sessionKey??null};}
export function auditBegin(db,{agentId,feature,targetId,targetName,action,actor={kind:'system',id:null},executor,requestId,before=null,requested=null,at=Date.now(),id=randomUUID()}){
 const row={id,agentId,feature,targetId,targetName:targetName??targetId,action,actor,executor,requestId:requestId??null,at,status:'pending',before,requested,after:null,changes:[]};
 db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(id,agentId,feature,targetId,at,JSON.stringify(row));return id;
}
export function auditFinish(db,id,status,after,{at=Date.now(),targetId,targetName}={}){
 const row=JSON.parse(db.prepare('SELECT body FROM audit_events WHERE id=?').get(id).body);
 row.status=status;row.finishedAt=at;row.after=after;if(targetId)row.targetId=targetId;if(targetName)row.targetName=targetName;
 row.changes=[...new Set([...Object.keys(row.before??{}),...Object.keys(after??{})])].filter(k=>JSON.stringify(row.before?.[k]??null)!==JSON.stringify(after?.[k]??null)).map(field=>({field,before:row.before?.[field]??null,after:after?.[field]??null}));
 db.prepare('UPDATE audit_events SET target=?,body=? WHERE id=?').run(row.targetId,JSON.stringify(row),id);
}
export function auditQuery(db,agentId,p={}){
 const {limit=50,offset=0}=p;
 if(Object.keys(p).some(k=>!['feature','targetId','action','status','actorId','from','to','limit','offset'].includes(k))||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw Error('审计筛选或分页参数无效');
 const where=['agent=?'],values=[agentId];
 for(const key of ['feature','targetId','action','status','actorId'])if(p[key]!==undefined){if(typeof p[key]!=='string'||!p[key]||p[key].length>200)throw Error('审计筛选参数无效');where.push(key==='feature'?'feature=?':key==='targetId'?'target=?':`json_extract(body,'$.${key==='actorId'?'actor.id':key}')=?`);values.push(p[key]);}
 for(const [key,op] of [['from','>='],['to','<=']])if(p[key]!==undefined){if(!Number.isSafeInteger(p[key])||p[key]<0)throw Error('审计时间须为毫秒时间戳');where.push('at'+op+'?');values.push(p[key]);}
 if(p.from!==undefined&&p.to!==undefined&&p.from>p.to)throw Error('审计时间范围无效');
 const sql=where.join(' AND '),total=db.prepare('SELECT COUNT(*) n FROM audit_events WHERE '+sql).get(...values).n;
 const records=db.prepare('SELECT body FROM audit_events WHERE '+sql+' ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').all(...values,limit,offset).map(r=>JSON.parse(r.body));
 return {records,total,nextOffset:offset+limit<total?offset+limit:null};
}
export const rootAudit=withRepositoryDatabase;

// Adapt the existing transactional entity audit without inventing human attribution.
export function entityAuditQuery(root,agentId,p={}){
 const db=graphDatabase(root);try{
  const empty={records:[],total:0,nextOffset:null};if(p.feature&&p.feature!=='entities'||p.status&&p.status!=='succeeded')return empty;
  const where=[],values=[];
  for(const [key,column] of [['targetId','target_id'],['action','action'],['actorId','actor']])if(p[key]!==undefined){where.push(column+'=?');values.push(p[key]);}
  for(const [key,op] of [['from','>='],['to','<=']])if(p[key]!==undefined){where.push('at'+op+'?');values.push(new Date(p[key]).toISOString());}
  const sql=where.length?' WHERE '+where.join(' AND '):'',total=db.prepare('SELECT COUNT(*) n FROM graph_audit'+sql).get(...values).n;
  const records=db.prepare('SELECT * FROM graph_audit'+sql+' ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').all(...values,p.limit??50,p.offset??0).map(r=>{
   const before=JSON.parse(r.before_json),after=JSON.parse(r.after_json);
   const changes=[...new Set([...Object.keys(before??{}),...Object.keys(after??{})])].filter(k=>JSON.stringify(before?.[k]??null)!==JSON.stringify(after?.[k]??null)).map(field=>({field,before:before?.[field]??null,after:after?.[field]??null}));
   return {id:'entity:'+r.id,agentId,feature:'entities',targetId:r.target_id,targetName:after?.name??before?.name??r.target_id,at:Date.parse(r.at),action:r.action,actor:{kind:'system',id:r.actor,name:null,identityNote:'实体存储记录的执行器身份；未保存真人指派信息'},executor:'entity-store',status:'succeeded',before,after,changes};
  });return {records,total,nextOffset:(p.offset??0)+(p.limit??50)<total?(p.offset??0)+(p.limit??50):null};
 }finally{db.close();}
}

export function importLegacyOperations(db,rows){
 for(const r of rows){const id='legacy:'+r.agentId+':'+r.requestId;if(db.prepare('SELECT 1 FROM audit_events WHERE id=?').get(id))continue;
  auditBegin(db,{...r,id,feature:'schedules',actor:{kind:'unknown',id:null,identityNote:'旧版操作记录未保存修改人、指派消息和字段前后值'},executor:'legacy-management'});
  const event=JSON.parse(db.prepare('SELECT body FROM audit_events WHERE id=?').get(id).body);event.status=r.status;event.legacy=true;
  db.prepare('UPDATE audit_events SET body=? WHERE id=?').run(JSON.stringify(event),id);
 }
}
