import {jobSourceAttachments} from './source-attachments.mjs';
import {randomUUID} from 'node:crypto';
import {captureReports} from './completion.mjs';
import {finalizeJobReport} from './task-report.mjs';
import {appendFileSync,statSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson,writeJson} from './jobs.mjs';
import {executeQuery} from './index.mjs';

export async function runWorker({root,id,params,scope,runtime,execute=executeQuery,pollMs=1000}) {
 const file=join(root,id+'.json');
 let job=readJson(file);
 const controller=new AbortController();
 const eventFile=join(root,id+'.events.jsonl');let eventBytes=existsSync(eventFile)?statSync(eventFile).size:0,omitted=0;
 function recordEvent(event){const line=JSON.stringify(event)+'\n';const bytes=Buffer.byteLength(line);if(eventBytes+bytes>5*1024*1024){omitted++;return;}appendFileSync(eventFile,line,{mode:0o600});eventBytes+=bytes;}
 function persist(){job.heartbeatAt=Date.now();writeJson(file,job);}
 function checkCancellation(){if(existsSync(join(root,id+'.cancel'))){job.status='cancelling';controller.abort();}}
 const timer=setInterval(()=>{
  try{checkCancellation();persist();}catch{controller.abort();}
 },pollMs);
 try {
  // A cancelled queued job must never start a subprocess or a business operation.
  checkCancellation();controller.signal.throwIfAborted();
  job.executionRounds=[...(job.executionRounds??[]),{startedAt:Date.now(),resumed:!!job.resumeSessionId}];
  job.status='running';delete job.result;delete job.error;appendFileSync(eventFile,'',{mode:0o600});persist();
  const attachments=jobSourceAttachments(job.provenance);
  const response=await execute(params,{...(attachments.length?{attachments}:{}),people:job.provenance?.people,sessionKey:scope,expectedSessionId:job.resumeSessionId,reportDirectory:(runtime?.reportDirectory??'.tmp/codex-query')+'/'+id,signal:controller.signal,onInspectionEvent:recordEvent,onProgress:progress=>{job={...job,...progress};persist();}},runtime);
  checkCancellation();controller.signal.throwIfAborted();
  job.result=response;
  checkCancellation();controller.signal.throwIfAborted();
  const output=JSON.parse(response.content.find(c=>c.type==='text').text);
  if(output.contextRequest){
   const kind=output.contextRequest.requestKind??'context',questions=job.questions??[];
   const count=questions.filter(question=>(question.requestKind??'context')===kind).length;
   if(count>=(kind==='plugin'?50:5))throw Error(kind==='plugin'?'Plugin request limit reached':'Context question limit reached');
   if(typeof output.sessionId!=='string')throw Error('Context request has no Worker session');
   const question={...output.contextRequest,questionId:randomUUID(),createdAt:Date.now(),expiresAt:Date.now()+24*60*60*1000};
   job.questions=[...(job.questions??[]),question];job.contextRequest=question;job.resumeSessionId=output.sessionId;job.status='awaiting_main';job.progress=question.question;
   if(job.notification)job.notification={state:'pending',eventKey:question.questionId,createdAt:Date.now()};
   recordEvent({event:'worker.context_request',time:Date.now(),...question});
  }else {job.status='completed';delete job.contextRequest;}

 }catch(e){delete job.result;job.status=controller.signal.aborted?'cancelled':e.code==='EXECUTION_TIMEOUT' || String(e.message).includes('exceeded 10 minutes')?'timed_out':'failed';job.error=String(e.message);}
 finally {
  clearInterval(timer);if(omitted)appendFileSync(eventFile,JSON.stringify({event:'inspection.omitted',count:omitted})+'\n',{mode:0o600});if(job.status!=='awaiting_main')job.finishedAt=Date.now();
  if(job.status!=='awaiting_main')await finalizeJobReport({job,params,runtime});
  job.reports=await captureReports(job.result);
  // Persist terminal result before releasing admission. On storage failure stay blocked.
  persist();
  const owner=join(root,'active','owner.json');
  if(existsSync(owner)&&readJson(owner).jobId===id)rmSync(join(root,'active'),{recursive:true,force:true});
  rmSync(join(root,id+'.cancel'),{force:true});
 }
 return job;
}
if(process.argv[1] && realpathSync(resolve(process.argv[1]))===fileURLToPath(import.meta.url)) {
 const [root,id]=process.argv.slice(2);
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const {params,scope,runtime}=JSON.parse(input);
 await runWorker({root,id,params,scope,runtime});
}
