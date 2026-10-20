import {createAgentTaskInspector} from './agent-task-inspector.mjs';
import {trustedAgentId} from './dist/agent-repo-api.mjs';
import {bindingKey,modelFields} from './project-binding.mjs';
import {requestKeyFor} from './jobs.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {inspectionChunkSize,inspectionMaxChunks} from './inspection-transport.mjs';
import {readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
const uuid=/^[0-9a-f-]{36}$/i;
const active=new Set(['queued','running','cancelling','unknown','awaiting_main','awaiting_user']);
const listGroup=row=>row.status==='unknown'?'unknown':active.has(row.status)?'active':'history';
const groupPriority={active:2,unknown:1,history:0};
function listProgress(job){
 if(job.status==='awaiting_user')return '等待用户补充上下文';
 if(job.status==='awaiting_main')return job.contextRequest?.question??'等待 Main 补充上下文';
 if(job.status==='completed')return job.notification?.state==='delivered'?'结果已交付':'执行已完成';
 if(job.status==='queued')return '等待调度';
 if(['failed','timed_out','cancelled','cancelling','unknown'].includes(job.status))return ({failed:'执行失败',timed_out:'执行超时',cancelled:'已取消',cancelling:'正在取消',unknown:'执行状态待核实'})[job.status];
 const text=typeof job.progress==='string'?job.progress.trim():'';
 return !text||text.startsWith('{')?'正在执行':text.slice(0,160);
}
const hash=value=>createHash('sha256').update(value).digest('hex');
export function redactInspection(value){
 if(typeof value==='string')return value.replace(/\b(Bearer\s+)\S+/gi,'$1[redacted]').replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)([^\s,;]+)/gi,'$1[redacted]').replace(/([?&](?:token|key|signature|access_token)=)[^&#\s]+/gi,'$1[redacted]');
 if(Array.isArray(value))return value.map(redactInspection);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/token|secret|password|authorization|api.?key/i.test(key)?'[redacted]':redactInspection(item)]));
 return value;
}
export function inspectionEvent(event,phase='business',now=Date.now()){
 if(phase!=='business'||!['item.started','item.updated','item.completed','turn.started','turn.completed','turn.failed'].includes(event.type))return null;
 const item=event.item;
 if(item&&!['agent_message','command_execution','mcp_tool_call','web_search','file_change'].includes(item.type))return null;
 return redactInspection({time:now,event:event.type,...(item?{item:{id:item.id,type:item.type,text:item.text,command:item.command,aggregated_output:item.aggregated_output,exit_code:item.exit_code,status:item.status,server:item.server,tool:item.tool,arguments:item.arguments,result:item.result,error:item.error,query:item.query,action:item.action,changes:item.changes}}:{error:event.error})});
}
async function json(file){return JSON.parse(await readFile(file,'utf8'));}
async function optionalJson(file){try{return await json(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function createSessionInspector({state,jobs,now=()=>Date.now()}){
 const root=join(state,'jobs');
 async function scoped(scope){
  if(typeof scope!=='string'||!scope)throw Error('Conversation identity required');
  let files;try{files=await readdir(root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const result=[];
  for(const name of files.filter(name=>uuid.test(name.slice(0,-5))&&name.endsWith('.json'))){
   const saved=await json(join(root,name));
   if(saved.scope===hash(scope))result.push(jobs.status(saved.jobId,scope));
  }
  return result.sort((a,b)=>b.createdAt-a.createdAt);
 }
 async function sessionSummaries(scope,all){
  const groups=new Map();
   const bindings=await optionalJson(join(state,hash(scope)+'.json'));
   for(const entry of Object.values(bindings??{}))groups.set(bindingKey(entry.topic,entry),{topic:entry.topic,...modelFields(entry),...(entry.project?{projectId:entry.project.projectId,repository:entry.project.repository,executionScope:entry.executionScope}:{}),sessionId:entry.sessionId,tags:[],taskCount:0,interactionCount:0,heat:0,updatedAt:Date.parse(entry.updatedAt)||0,status:'unknown',progress:'历史任务记录不可用'});
   for(const job of all){
    const group=bindingKey(job.topic,job);
    const row=groups.get(group)??{topic:job.topic,...modelFields(job),...(job.project?{projectId:job.projectId,repository:job.repository,executionScope:job.executionScope}:{}),tags:[],taskCount:0,interactionCount:0,heat:0,updatedAt:0};
    row.createdAt=row.createdAt?Math.min(row.createdAt,job.createdAt):job.createdAt;row.taskCount++;row.interactionCount+=1+(job.status==='completed'?1:0);
    // Only accepted work and terminal Worker replies contribute; polls and heartbeats do not.
    row.heat+=10*Math.pow(0.5,Math.max(0,now()-job.createdAt)/(7*86400000));
    if(job.status==='completed')row.heat+=5*Math.pow(0.5,Math.max(0,now()-(job.finishedAt??job.createdAt))/(7*86400000));
    row.tags=[...new Set([...row.tags,...(job.tags??[])])];
    if(!row.jobId||(active.has(job.status)&&!active.has(row.status))||(job.status==='running'&&row.status!=='running')||(['awaiting_main','awaiting_user'].includes(job.status)&&row.status==='queued')){Object.assign(row,{jobId:job.jobId,sessionId:job.sessionId??row.sessionId,status:job.status,progress:listProgress(job),notificationState:job.notification?.state});}
    row.updatedAt=Math.max(row.updatedAt,job.createdAt,job.finishedAt??0,...(job.questions??[]).flatMap(q=>[q.createdAt??0,q.answeredAt??0,q.waitingForUserAt??0]),...(job.executionRounds??[]).map(r=>r.startedAt??0));
    row.activeCount=(row.activeCount??0)+(active.has(job.status)?1:0);
    groups.set(group,row);
   }
  return [...groups.values()];
 }
 return {
  agentTasks:createAgentTaskInspector({state,jobs,now}),
  async list(scope,{query='',sort='heat',offset=0,limit=30,projectId}={}){
   if(typeof query!=='string'||query.length>500||!['heat','recent'].includes(sort)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid list parameters');
   if(projectId!==undefined&&(typeof projectId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(projectId)))throw Error('Invalid project filter');
   const unfiltered=await scoped(scope),all=projectId?unfiltered.filter(job=>job.projectId===projectId):unfiltered;
   const allSummaries=await sessionSummaries(scope,all),summaries=projectId?allSummaries.filter(row=>row.projectId===projectId):allSummaries;
   const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
   const rows=summaries.filter(row=>terms.every(term=>[row.topic,row.projectId,row.repository,row.modelId,row.model,row.harness,row.status,...row.tags].join(' ').toLocaleLowerCase().includes(term))).sort((a,b)=>groupPriority[listGroup(b)]-groupPriority[listGroup(a)]||(sort==='heat'?b.heat-a.heat:b.updatedAt-a.updatedAt)||a.topic.localeCompare(b.topic));
   return redactInspection({projectId:projectId??null,projectIds:[...new Set([...unfiltered.map(job=>job.projectId),...allSummaries.map(row=>row.projectId)].filter(Boolean))].sort(),sessions:rows.slice(offset,offset+limit).map(row=>({...row,heat:Math.round(row.heat*10)/10})),total:rows.length,hasMore:offset+limit<rows.length,offset,limit,groupCounts:{active:rows.filter(row=>listGroup(row)==='active').length,unknown:rows.filter(row=>listGroup(row)==='unknown').length,history:rows.filter(row=>listGroup(row)==='history').length},counts:{awaitingUser:all.filter(j=>j.status==='awaiting_user').length,awaitingMain:all.filter(j=>j.status==='awaiting_main').length,running:all.filter(j=>j.status==='running').length,queued:all.filter(j=>j.status==='queued').length},heatPolicy:'任务受理 +10，Worker 完成 +5；7天半衰期。交互次数为受理任务及已完成回复次数；查询、等待和心跳不计入。'});
  },
  async detail(scope,{topic,offset=0,limit=1,historyOffset=0,jobId,executionScope,modelSessionScope,projectId}={}){
   if(typeof topic!=='string'||!topic||topic.length>160||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1||!Number.isInteger(historyOffset)||historyOffset<0)throw Error('Invalid detail parameters');
   if(executionScope!==undefined&&executionScope!==null&&(typeof executionScope!=='string'||!/^[a-f0-9]{64}$/.test(executionScope)))throw Error('Invalid execution scope');
   const all=await scoped(scope),selected=jobId?all.find(job=>job.jobId===jobId&&job.topic===topic):undefined,chosenScope=executionScope!==undefined?executionScope:selected?selected.executionScope??null:undefined;
   if(modelSessionScope!==undefined&&modelSessionScope!==null&&(typeof modelSessionScope!=='string'||!/^[a-f0-9]{64}$/.test(modelSessionScope)))throw Error('Invalid model session scope');
   const chosenModel=modelSessionScope!==undefined?modelSessionScope:selected?selected.modelSessionScope??null:undefined;
   const inScope=entry=>(chosenScope===undefined||chosenScope===null&&!entry.executionScope||entry.executionScope===chosenScope)&&(chosenModel===undefined||chosenModel===null&&!entry.modelSessionScope||entry.modelSessionScope===chosenModel);
   if(projectId!==undefined&&(typeof projectId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(projectId)))throw Error('Invalid project filter');
   const matches=all.filter(j=>j.topic===topic&&inScope(j)&&(!projectId||j.projectId===projectId)),records=[];
   if(chosenModel===undefined&&new Set(matches.map(job=>job.modelSessionScope??null)).size>1)throw Error('Choose a model session scope for this topic');
   if(jobId!==undefined){if(typeof jobId!=='string'||!uuid.test(jobId))throw Error('Invalid job identifier');offset=matches.findIndex(job=>job.jobId===jobId);if(offset<0)throw Error('Task not found in conversation');}
   const summary=(await sessionSummaries(scope,all)).find(row=>row.topic===topic&&inScope(row)&&(!projectId||row.projectId===projectId));
   const session=summary?{...summary,heat:Math.round(summary.heat*10)/10,awaitingUserCount:matches.filter(job=>job.status==='awaiting_user').length,awaitingMainCount:matches.filter(job=>job.status==='awaiting_main').length,runningCount:matches.filter(job=>job.status==='running').length,queuedCount:matches.filter(job=>job.status==='queued').length}:null;
   for(const job of matches.slice(offset,offset+limit)){
    const request=await optionalJson(join(root,job.jobId+'.request.json'));
    const bound=request?.scope===scope&&request?.params?.topic===topic&&job.requestKey===requestKeyFor(request.params,scope,job.provenance);
    let events=[],availability='unavailable',omitted=0;
    try{
     const file=join(root,job.jobId+'.events.jsonl');
     if((await stat(file)).size>6*1024*1024)throw Error('Event log exceeds inspection budget');
     const lines=(await readFile(file,'utf8')).trim().split('\n').filter(Boolean);
     for(const line of lines){const event=JSON.parse(line);if(event.event==='inspection.omitted')omitted+=event.count;else events.push(event);}
     availability='available';
    }catch(e){if(e.code!=='ENOENT')availability='unreadable';}
    let result;try{result=JSON.parse(job.result?.content?.find(c=>c.type==='text')?.text??'null')?.result;}catch{ /* Raw invalid output is not displayed as a final reply. */ }
    if(typeof result==='string'){try{const nested=JSON.parse(result);if(nested.protocol==='codex_result_v1'&&typeof nested.result==='string')result=nested.result;}catch{ /* Plain text replies remain intact. */ }}
    records.push({jobId:job.jobId,...modelFields(job),...(job.project?{projectId:job.projectId,repository:job.repository,cwd:job.cwd}:{}),status:job.status,createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt,progress:job.progress,error:job.error,notificationState:job.notification?.state,notificationKind:['awaiting_main','awaiting_user'].includes(job.status)?'context_request':'result',questions:job.questions??[],executionRounds:job.executionRounds??[],request:bound?{availability:'available',task:request.params.task,context:request.params.context,constraints:request.params.constraints}:{availability:'unavailable'},result,events,eventsAvailability:availability,omitted});
   }
   // Summaries come from accepted jobs; full requests and logs remain lazy and bound above.
   const taskSummary=(job,index)=>({jobId:job.jobId,index,status:job.status,task:typeof job.taskSummary==='string'?redactInspection(job.taskSummary).slice(0,500):null,createdAt:job.createdAt,finishedAt:job.finishedAt});
   const indexed=matches.map(taskSummary),history=indexed.filter(job=>!active.has(job.status));
   return redactInspection({topic,session,currentTasks:indexed.filter(job=>active.has(job.status)),taskHistory:history.slice(historyOffset,historyOffset+30),historyTotal:history.length,historyOffset,historyHasMore:historyOffset+30<history.length,records:records.reverse(),total:matches.length,offset,hasMore:offset+limit<matches.length});
  }
 };
}
export function registerInspector(api,inspector,{now=()=>Date.now()}={}){
 const register=api.session?.controls?.registerSessionAction?.bind(api.session.controls)??api.registerSessionAction?.bind(api);
 if(!register){api.logger?.warn?.('Codex session panel unavailable: host lacks public session actions');return;}
 const transfers=new Map();
 const prune=()=>{for(const [id,value] of transfers)if(value.expiresAt<=now())transfers.delete(id);};
 const part=(transferId,value,index)=>({encoding:'json-chunks',transferId,totalChunks:Math.ceil(value.text.length/inspectionChunkSize),index,chunk:value.text.slice(index*inspectionChunkSize,(index+1)*inspectionChunkSize)});
 for(const action of ['list','detail','chunk','agentTasks'])register({id:'inspect-'+action,description:action==='agentTasks'?'Read current Agent task summaries across conversations':'Read current conversation Codex '+action,requiredScopes:['operator.read'],handler:async context=>{
  try{
   if(typeof context.sessionKey!=='string'||!context.sessionKey)throw Error('Missing scope');
   prune();
   if(action==='chunk'){
    const {transferId,index}=context.payload??{},value=transfers.get(transferId);
    if(!value||value.scope!==context.sessionKey||(value.agentId!==undefined&&value.agentId!==trustedAgentId(context))||!Number.isInteger(index)||index<0||index>=Math.ceil(value.text.length/inspectionChunkSize))throw Error('Invalid transfer');
    return {ok:true,result:part(transferId,value,index)};
   }
   const text=JSON.stringify(redactInspection(await inspector[action](action==='agentTasks'?context:context.sessionKey,context.payload??{})));
   if(typeof text!=='string'||text.length>inspectionChunkSize*inspectionMaxChunks)throw Error('Record exceeds transfer budget');
   // Encoding the entire document also avoids host depth, node and object-key limits.
   const transferId=randomUUID(),value={scope:context.sessionKey,...(action==='agentTasks'?{agentId:trustedAgentId(context)}:{}),text,expiresAt:now()+120000};
   if(text.length>inspectionChunkSize){
    while(transfers.size>=4||[...transfers.values()].reduce((sum,value)=>sum+value.text.length,0)+text.length>inspectionChunkSize*inspectionMaxChunks)transfers.delete(transfers.keys().next().value);
    transfers.set(transferId,value);
   }
   return {ok:true,result:part(transferId,value,0)};
  }
  catch{return {ok:false,error:action==='agentTasks'?'无法读取当前 Agent 的 Worker 任务，请核对插件版本、参数和存储状态。':'无法读取当前会话记录，请核对参数和存储状态。',code:'INSPECTION_UNAVAILABLE'};}
 }});
}
