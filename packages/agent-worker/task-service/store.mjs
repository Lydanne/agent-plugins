import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export const terminalStates=new Set(['completed','failed','cancelled']);
export const canonical=value=>JSON.stringify(sort(value));
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function fault(code){return Object.assign(new Error(code),{code});}
const fields={agentId:64,projectId:64,repository:256,workflow:160,requestKey:500,task:40000,context:40000,constraints:4000};
export function validateSubmission(input){
 if(!input||input.version!==1||Object.keys(input).some(k=>!['version',...Object.keys(fields),'useWorkspace','attempt'].includes(k)))throw fault('INVALID_REQUEST');
 for(const [k,max]of Object.entries(fields))if((k!=='repository'||input[k]!==undefined)&&(typeof input[k]!=='string'||!input[k].trim()||input[k].length>max))throw fault('INVALID_REQUEST');
 if(!/^[a-zA-Z0-9_-]+$/.test(input.agentId)||!/^[a-zA-Z0-9_-]+$/.test(input.projectId)||typeof input.useWorkspace!=='boolean'||input.attempt!==undefined&&(typeof input.attempt!=='string'||input.attempt.length>160))throw fault('INVALID_REQUEST');
 const repository=input.repository??'projects/'+input.projectId;
 if(repository!=='projects/'+input.projectId&&!new RegExp('^projects/'+input.projectId+'/repositories/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$').test(repository))throw fault('PROJECT_SCOPE_MISMATCH');
 const {attempt,...request}=input;return {...request,repository};
}
export function openTaskStore(root){
 mkdirSync(root,{recursive:true,mode:0o700});const file=join(root,'automation.sqlite');const db=new DatabaseSync(file);chmodSync(file,0o600);
 db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,owner TEXT NOT NULL,business_key TEXT NOT NULL,generation INTEGER NOT NULL,input_digest TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(owner,business_key,generation));
 CREATE TABLE IF NOT EXISTS attempts(task TEXT,attempt TEXT,created INTEGER,PRIMARY KEY(task,attempt));
 CREATE TABLE IF NOT EXISTS events(task TEXT,id TEXT,status TEXT,body TEXT,PRIMARY KEY(task,id));`);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const get=id=>{const row=db.prepare('SELECT body FROM tasks WHERE id=?').get(id);if(!row)throw fault('TASK_NOT_FOUND');return JSON.parse(row.body);};
 const save=t=>{db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(t),t.taskId);return t;};
 const attempt=(id,a)=>{if(a)db.prepare('INSERT OR IGNORE INTO attempts VALUES(?,?,?)').run(id,a,Date.now());};
 function insert(owner,request,key,generation,predecessorTaskId,policy){
  const taskId=randomUUID(),now=Date.now(),prior=predecessorTaskId?get(predecessorTaskId):undefined;
  const t={version:1,taskId,owner,request,inputDigest:digest(request),generation,predecessorTaskId,...(prior?{predecessor:{taskId:prior.taskId,jobId:prior.jobId,result:prior.result,artifacts:prior.artifacts??[]}}:{}),sessionKey:`agent:${request.agentId}:automation:${taskId}`,state:'accepted',phase:'waiting_session',createdAt:now,updatedAt:now,deadline:now+policy.timeoutMs,policy,jobId:null,result:null,error:null};
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(taskId,owner,key,generation,t.inputDigest,JSON.stringify(t));db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(taskId,'accepted','done',JSON.stringify({createdAt:now,executionJournalVersion:1}));return t;
 }
 return {
  close:()=>db.close(),get,
  // Only a complete, versioned pre-execution journal is affirmative evidence.
  // The transaction rechecks it at settlement; absence in legacy records is not proof.
  settleUnstartedUnknown(id){return tx(()=>{
   const t=get(id),events=db.prepare('SELECT id,status,body FROM events WHERE task=?').all(id);
   if(t.state!=='unknown'||t.phase!=='waiting_session'||t.jobId||t.result||t.cancelRequestedAt||t.delegationAttempts||t.verificationAttempts||
      !['TASK_RECONCILIATION_FAILED','SESSION_RECONCILIATION_FAILED'].includes(t.error?.code)||events.length!==1||events[0].id!=='accepted'||events[0].status!=='done')return null;
   const accepted=JSON.parse(events[0].body);
   if(accepted.executionJournalVersion!==1||accepted.createdAt!==t.createdAt)return null;
   const completedAt=Date.now(),receipt={reason:'NO_EXECUTION_STARTED',previousError:t.error,executionJournalVersion:1,completedAt};
   db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id,'unstarted-settlement','done',JSON.stringify(receipt));
   return save({...t,state:'failed',phase:'finished',settled:true,error:{code:'NO_EXECUTION_STARTED',cause:t.error.code},updatedAt:completedAt});
  });},
  owned(id,owner){const t=get(id);if(t.owner!==owner)throw fault('TASK_NOT_FOUND');return t;},
  list(){return db.prepare('SELECT body FROM tasks ORDER BY rowid').all().map(r=>JSON.parse(r.body));},
  submit(owner,input,policy){const request=validateSubmission(input),key=digest([request.agentId,request.projectId,request.requestKey]);return tx(()=>{
   const row=db.prepare('SELECT body FROM tasks WHERE owner=? AND business_key=? ORDER BY generation DESC LIMIT 1').get(owner,key);let t=row?JSON.parse(row.body):undefined;
   if(t&&t.inputDigest!==digest(request))throw fault('REQUEST_CONFLICT');
   t??=insert(owner,request,key,0,undefined,policy);attempt(t.taskId,input.attempt);return t;
  });},
  rerun(owner,id,operationId){if(typeof operationId!=='string'||!operationId||operationId.length>160)throw fault('INVALID_REQUEST');return tx(()=>{
   const prior=get(id);if(prior.owner!==owner)throw fault('TASK_NOT_FOUND');
   const existing=db.prepare('SELECT events.body FROM events JOIN tasks ON tasks.id=events.task WHERE tasks.owner=? AND tasks.business_key=(SELECT business_key FROM tasks WHERE id=?) AND events.id=?').get(owner,id,'rerun:'+operationId);if(existing)return get(JSON.parse(existing.body).taskId);
   if(!terminalStates.has(prior.state)||prior.settled!==true)throw fault('PREDECESSOR_NOT_SETTLED');
   const row=db.prepare('SELECT business_key FROM tasks WHERE id=?').get(id),latest=db.prepare('SELECT id,generation FROM tasks WHERE owner=? AND business_key=? ORDER BY generation DESC LIMIT 1').get(owner,row.business_key);
   if(latest.id!==id)throw fault('PREDECESSOR_SUPERSEDED');
   const t=insert(owner,prior.request,row.business_key,latest.generation+1,id,prior.policy);
   db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id,'rerun:'+operationId,'done',JSON.stringify({taskId:t.taskId}));return t;
  });},
  update(id,fn){return tx(()=>{const t=get(id),patch=fn(t);if(!patch)return t;return save({...t,...patch,updatedAt:Date.now()});});},
  event(id,key){const r=db.prepare('SELECT status,body FROM events WHERE task=? AND id=?').get(id,key);return r?{status:r.status,...JSON.parse(r.body)}:undefined;},
  claim(id,key,body){return !!db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(id,key,'claimed',JSON.stringify({...body,claimedAt:Date.now()})).changes;},
  finish(id,key,body){db.prepare('UPDATE events SET status=?,body=? WHERE task=? AND id=?').run('done',JSON.stringify({...body,completedAt:Date.now()}),id,key);},
  attempts(id){return db.prepare('SELECT attempt,created FROM attempts WHERE task=? ORDER BY created').all(id);}
 };
}
