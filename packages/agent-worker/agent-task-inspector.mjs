import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {trustedAgentId} from './dist/agent-repo-api.mjs';
import {requestKeyFor} from './jobs.mjs';
import {modelFields} from './project-binding.mjs';
const states=['running','queued','awaiting_main','awaiting_user','completed','failed','timed_out','cancelled','cancelling','unknown'];
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
// Worker owns history and status projection. Repo consumes only this read-only view.
export function createAgentTaskInspector({state,jobs,now=()=>Date.now()}){
 return async function agentTasks(context,payload={}){
  const agentId=trustedAgentId(context),{projectId,status,query='',offset=0,limit=20}=payload;
  if(Object.keys(payload).some(key=>!['projectId','status','query','offset','limit'].includes(key))||projectId!==undefined&&(typeof projectId!=='string'||!idPattern.test(projectId))||status!==undefined&&!states.includes(status)||typeof query!=='string'||query.length>500||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid Agent task filters');
  const root=join(state,'jobs');let files;
  try{files=await readdir(root);}catch(error){if(error.code!=='ENOENT')throw error;files=[];}
  const all=[];
  for(const file of files.filter(name=>/^[a-f0-9-]{36}\.json$/i.test(name))){
   let saved;try{saved=JSON.parse(await readFile(join(root,file),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
   if(saved.jobId+'.json'!==file)throw Error('Invalid saved job identity');
   if(saved.provenance?.agentId&&saved.provenance.agentId!==agentId)continue;
   let request;try{request=JSON.parse(await readFile(join(root,saved.jobId+'.request.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
   const scope=request.scope;
   if(typeof scope!=='string'||!scope.startsWith('agent:'+agentId+':')||saved.scope!==hash(scope)||request.params?.topic!==saved.topic||saved.requestKey!==requestKeyFor(request.params,scope,saved.provenance))continue;
   let job;try{job=jobs.status(saved.jobId,scope);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   all.push({jobId:job.jobId,topic:job.topic,...modelFields(job),projectId:job.projectId??null,repository:job.repository??null,executionScope:job.executionScope??null,notificationState:job.notification?.state??null,notificationErrorCode:job.notification?.lastErrorCode??null,waitingSince:job.contextRequest?.createdAt??null,sessionKey:scope,status:states.includes(job.status)?job.status:'unknown',createdAt:job.createdAt,finishedAt:job.finishedAt??null,taskSummary:typeof job.taskSummary==='string'?job.taskSummary.slice(0,500):null});
  }
  const scoped=all.filter(job=>!projectId||job.projectId===projectId),counts=Object.fromEntries(states.map(status=>[status,scoped.filter(job=>job.status===status).length]));
  const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered=scoped.filter(job=>(!status||job.status===status)&&terms.every(term=>[job.jobId,job.topic,job.taskSummary,job.projectId,job.modelId,job.model,job.harness,job.status].join(' ').toLocaleLowerCase().includes(term))).sort((a,b)=>b.createdAt-a.createdAt||a.jobId.localeCompare(b.jobId));
  return {diagnostics:{deliveryUncertain:scoped.filter(job=>job.notificationState==='uncertain').length,awaitingMainOverdue:scoped.filter(job=>job.status==='awaiting_main'&&job.waitingSince&&now()-job.waitingSince>30*60*1000).length},agentId,scannedAt:new Date(now()).toISOString(),counts,taskTotal:scoped.length,conversationTotal:new Set(scoped.map(job=>job.sessionKey)).size,projectIds:[...new Set(all.map(job=>job.projectId).filter(Boolean))].sort(),tasks:filtered.slice(offset,offset+limit),total:filtered.length,offset,limit,hasMore:offset+limit<filtered.length,coverage:'仅包含可核验 Agent 与会话绑定的已保存任务；无绑定的旧记录不纳入统计。'};
 };
}
