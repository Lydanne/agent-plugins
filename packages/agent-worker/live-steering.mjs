// The scheduler authorizes delivery; the owning Worker alone sends it to its
// active turn. Persist 'sending' before crossing the RPC boundary: uncertainty
// must never become a second delivery or a fresh business turn.
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {acquireLock} from './locks.mjs';
import {readJson,writeJson} from './jobs.mjs';

export function grantLiveSteering(root,job,record){
 const turn=job.liveTurn;
 if(record.jobId!==job.jobId||record.kind!=='steering'||record.status!=='accepted'||job.status!=='running'||typeof job.workerId!=='string'||!turn||turn.workerId!==job.workerId||!turn.threadId||!turn.turnId)return record;
 if(record.liveDelivery)return record;
 const next={...record,liveDelivery:{...turn,state:'ready',authorizedAt:Date.now()}};
 // Revocation and final delivery must include the newly admitted source.
 const sources=[...(job.provenance.attachmentSources??[]),record.attachmentSource].filter(Boolean);
 job.provenance={...job.provenance,attachmentSources:[...new Map(sources.map(s=>[JSON.stringify(s),s])).values()]};
 writeJson(join(root,job.jobId+'.json'),job);
 writeJson(join(root,'supplements',record.supplementId+'.json'),next);
 return next;
}
export async function deliverLiveSteering({root,id,workerId,turn,send,signal}){
 const dir=join(root,'supplements');if(!existsSync(dir))return;
 const records=readdirSync(dir).filter(n=>/^[0-9a-f-]{36}\.json$/i.test(n)).map(n=>readJson(join(dir,n))).filter(r=>r.jobId===id&&r.kind==='steering').sort((a,b)=>a.admissionSequence-b.admissionSequence);
 for(const candidate of records){
  const file=join(dir,candidate.supplementId+'.json');let record;
  const unlock=await acquireLock(join(root,'scheduler-lock'));
  try{
   record=readJson(file);const job=readJson(join(root,id+'.json')),d=record.liveDelivery;
   if(signal.aborted||existsSync(join(root,id+'.cancel'))||job.status!=='running'||job.workerId!==workerId)return;
   if(record.status!=='accepted'||d?.state!=='ready')continue;
   if(d.workerId!==workerId||d.threadId!==turn.threadId||d.turnId!==turn.turnId||job.liveTurn?.turnId!==turn.turnId)continue;
   record={...record,liveDelivery:{...d,state:'sending',sentAt:Date.now()}};writeJson(file,record);
  }finally{unlock();}
  let result,error;
  try{signal.throwIfAborted();result=await send({id:record.supplementId,text:JSON.stringify({kind:'task_steering',instruction:'原请求范围内的新证据或方向，请及时核验并继续当前任务，保留已完成结果。不扩大 task/constraints，不把线索视为新的写入授权。',answer:record.answer,attachments:record.attachmentSource?.attachments??[]})});}catch(e){error=e;}
  const release=await acquireLock(join(root,'scheduler-lock'));
  try{
   const latest=readJson(file);
   if(latest.status!=='accepted'||latest.liveDelivery?.state!=='sending')continue;
   if(signal.aborted||existsSync(join(root,id+'.cancel'))){writeJson(file,{...latest,status:'suppressed',reason:'task_cancelled'});continue;}
   const accepted=result?.turnId===turn.turnId;
   const state=accepted?'delivered':error?.definitelyRejected?'rejected':'unknown';
   writeJson(file,{...latest,liveDelivery:{...latest.liveDelivery,state,finishedAt:Date.now()},...(accepted?{status:'dispatched',childJobId:id}:state==='unknown'?{status:'blocked',reason:'live_delivery_unknown'}:{})});
  }finally{release();}
 }
}
