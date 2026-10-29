import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeSourceRevocation} from './dist/worker-source-api.mjs';
export function messageSource(accountId,chatId,messageId){if([accountId,chatId,messageId].some(value=>typeof value!=='string'||!value))throw Error('Incomplete source identity');return {namespace:'message',scope:JSON.stringify([accountId,chatId]),id:messageId};}
function dependencies(job){
 const p=job.provenance;if(!p)return [];
 const sources=[p,...(p.attachmentSources??[])];
 const refs=sources.flatMap(source=>Array.isArray(source.sourceRefs)?source.sourceRefs:[]);
 refs.push(...sources.flatMap(source=>typeof source.accountId==='string'&&typeof source.chatId==='string'?(source.sourceMessageIds??[]).map(id=>messageSource(source.accountId,source.chatId,id)):[]));
 if(typeof p.accountId==='string'&&typeof p.chatId==='string')for(const q of job.questions??[])if(q.answerSource==='user_text'&&q.answerMessageId)refs.push(messageSource(p.accountId,p.chatId,q.answerMessageId));
 return refs;
}
export function createSourceRevocations(root){
 const file=join(root,'source-revocations.sqlite');
 function database(){
  mkdirSync(root,{recursive:true,mode:0o700});const db=new DatabaseSync(file);
  try{chmodSync(file,0o600);db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sources(namespace TEXT,scope TEXT,id TEXT,reason TEXT,at INTEGER,PRIMARY KEY(namespace,scope,id));');return db;}catch(error){db.close();throw error;}
 }
 return {
  record(event){
   const input=normalizeSourceRevocation(event),digest=createHash('sha256').update(JSON.stringify(input)).digest('hex'),db=database();
   try{
    db.exec('BEGIN IMMEDIATE');const previous=db.prepare('SELECT digest FROM events WHERE id=?').get(input.eventId);
    if(previous&&previous.digest!==digest)throw Error('Source revocation event conflicts with its original payload');
    db.prepare('INSERT OR IGNORE INTO events VALUES (?,?)').run(input.eventId,digest);
    const insert=db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?,?,?,?)');
    for(const source of input.sources)insert.run(source.namespace,source.scope,source.id,input.reason,Date.now());
    db.exec('COMMIT');return input;
   }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
  },
  // One bounded connection per reconciliation, independent of channel services.
  revokedJobs(jobs){
   if(!existsSync(file))return new Set();const db=database(),ids=new Set();
   try{const query=db.prepare('SELECT 1 FROM sources WHERE namespace=? AND scope=? AND id=?');for(const job of jobs)if(['queued','running','cancelling','unknown','awaiting_main','awaiting_user'].includes(job.status)&&dependencies(job).some(source=>query.get(source.namespace,source.scope,source.id)))ids.add(job.jobId);return ids;}finally{db.close();}
  },
 };
}
