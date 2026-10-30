import {createServer} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';

const state=globalThis[Symbol.for('openclaw-plugins.worker-cli.v1')]??={bindings:new Map(),tools:new Map()};
const marker='__openclawWorker';
const denied=message=>Object.assign(Error(message),{code:'WORKER_CONTEXT_DENIED'});
const taskTools=new Set(['agent_worker','agent_task_result','agent_schedule','agent_entity_sync','feishu_cli_auth']);
function binding(proof,context){
 const b=state.bindings.get(proof?.token);
 if(!b||proof.workerId!==b.context.workerId||proof.jobId!==b.context.jobId)throw denied('Invalid Worker execution identity');
 b.assertCurrent();
 if(context&&(context.agentId!==b.context.agentId||context.sessionKey!==b.context.sessionKey))throw denied('Worker Agent/session mismatch');
 return b;
}
export function getWorkerCliContext(context){return context?.workerContext?structuredClone(context.workerContext):undefined;}
export function workerContextApi(api){
 return new Proxy(api,{get(target,key){
  if(key!=='registerTool')return Reflect.get(target,key);
  return (factory,options)=>target.registerTool(context=>{
   const built=typeof factory==='function'?factory(context):factory;
   const wrap=tool=>{
    if(!tool)return tool;
    state.tools.set(tool.name,{pluginId:api.id??api.pluginId,resolve:taskContext=>{const built=typeof factory==='function'?factory({...context,...taskContext,senderIsOwner:false}):factory;const actual=(Array.isArray(built)?built:[built]).find(t=>t?.name===tool.name);if(!actual)throw denied('Plugin capability unavailable in the original task');return {parameters:actual.parameters,description:actual.description};}});
    return {...tool,execute:async(id,args,signal,...rest)=>{
     if(!Object.hasOwn(args??{},marker))return tool.execute(id,args,signal,...rest);
     const b=binding(args[marker],context),input={...args};delete input[marker];
     // Task orchestration and administrative writes remain Main-owned decisions.
     if(taskTools.has(tool.name)&&!(tool.name==='agent_worker'&&['projects','queues','list','status'].includes(input.action)))throw denied('Main decision or authorization required');
     const bound={...context,...b.toolContext,workerContext:structuredClone(b.context),senderIsOwner:false};
     const resolved=typeof factory==='function'?factory(bound):factory;
     const actual=(Array.isArray(resolved)?resolved:[resolved]).find(t=>t?.name===tool.name);
     if(!actual)throw denied('Plugin capability unavailable in the original task');
     b.assertCurrent();signal?.throwIfAborted();
     return actual.execute(id,input,signal,...rest);
    }};
   };
   return Array.isArray(built)?built.map(wrap):wrap(built);
  },options);
 }});
}
export function createWorkerCliService({connect,getConfig,authorize,getJob,onAudit=()=>{}}){
 let server,url;const tokens=new Set();
 const current=b=>{
  const job=getJob(b.context.jobId);
  if(job.status!=='running'||job.workerId!==b.context.workerId||authorize(job.provenance,b.context.sessionKey)!==true)throw denied('Worker execution or task source is no longer active');
  if(['agentId','sessionKey','accountId','chatId','senderId','taskId','revision','sessionId'].some(k=>job.provenance?.[k]!==b.provenance?.[k]))throw denied('Worker Agent changed');
 };
 const issue=(job,request)=>{
  if(!url||!job.provenance?.agentId||authorize(job.provenance,request.scope??job.provenance.sessionKey)!==true)return undefined;
  for(const token of tokens){const previous=state.bindings.get(token);let remove=previous?.context.jobId===job.jobId;try{previous?.assertCurrent();}catch{remove=true;}if(remove){tokens.delete(token);state.bindings.delete(token);}}
  const p=job.provenance,sessionKey=p.sessionKey??request.scope,params=request.resumeParams??request.params,token=randomBytes(32).toString('hex');
  const context={version:1,workerId:job.workerId,jobId:job.jobId,agentId:p.agentId,sessionKey,cwd:request.runtime?.cwd,projectId:job.projectId??request.runtime?.projectContext?.projectId,source:{taskId:p.taskId,revision:p.revision,sessionId:p.sessionId,requestMessageIds:p.requestMessageIds,sourceMessageIds:p.sourceMessageIds},repository:job.repository??request.runtime?.projectContext?.repository,requesterId:p.senderId,accountId:p.accountId,chatId:p.chatId,task:params.task,context:params.context,constraints:params.constraints,...(params.mainReplies?{mainReplies:params.mainReplies}:{})};
  const b={context,provenance:structuredClone(p),toolContext:{workspaceDir:request.runtime?.skillContextRoot,agentId:p.agentId,sessionKey,sessionId:p.sessionId,messageChannel:p.accountId?'feishu':undefined,agentAccountId:p.accountId,requesterSenderId:p.senderId,agentTo:p.chatId?'chat:'+p.chatId:undefined,agentThreadId:p.rootId,conversationReadOrigin:'delegated'},assertCurrent:()=>current(b)};
  tokens.add(token);state.bindings.set(token,b);return {url,token,context};
 };
 return {issue,async start(){
  server=createServer(async(req,res)=>{
   res.setHeader('Content-Type','application/json');
   try{
    if(req.method!=='POST'||req.url!=='/invoke')throw denied('Unsupported Worker CLI endpoint');
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1024*1024)throw denied('Worker request too large');}
    const input=JSON.parse(raw),b=binding({...input.identity,token:req.headers.authorization?.replace(/^Bearer /,'')});
    let result;
    if(input.method==='worker.context')result=b.context;
    else{
     if(input.method!=='tools.invoke'&&input.method!=='worker.catalog')throw denied('Worker management and arbitrary RPC are unavailable');
     const {name,args={},agentId=b.context.agentId,sessionKey=b.context.sessionKey}=input.params??{};
     if(agentId!==b.context.agentId||sessionKey!==b.context.sessionKey||input.method!=='worker.catalog'&&typeof name!=='string'||!args||typeof args!=='object'||Array.isArray(args)||Object.hasOwn(args,marker))throw denied('Worker task scope mismatch');
     if(args.projectId!==undefined&&args.projectId!==b.context.projectId||args.repository!==undefined&&args.repository!==b.context.repository)throw denied('Cannot change the original Worker project/repository');
     // Refresh the public catalog under the original Agent before each call.
     const connection=await connect(getConfig(),{},{env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^OPENCLAW_(?:WORKER_.*|JOB_ID)$/.test(key)))});
     try{
      const catalog=await connection.request('tools.catalog',{agentId,includePlugins:true});
      if(input.method==='worker.catalog'){result={agentId,plugins:catalog.groups?.filter(g=>g.source==='plugin').map(g=>({pluginId:g.pluginId,tools:g.tools?.map(t=>({name:t.id,description:t.description,taskBound:state.tools.has(t.id)}))}))};}
      else {
      const pluginTool=catalog.groups?.some(g=>g.source==='plugin'&&g.tools?.some(t=>t.id===name));
      if(!pluginTool||!state.tools.has(name))throw denied('Plugin has not enabled task-bound CLI invocation');
      b.assertCurrent();
      if(input.describe){const metadata=state.tools.get(name);result={name,pluginId:metadata.pluginId,...metadata.resolve({...b.toolContext,workerContext:structuredClone(b.context)})};}
      else result=await connection.request('tools.invoke',{name,agentId,sessionKey,args:{...args,[marker]:{token:req.headers.authorization.replace(/^Bearer /,''),workerId:b.context.workerId,jobId:b.context.jobId}}});
      }
     }finally{connection.close();}
    }
    onAudit({event:'worker.plugin_cli',workerId:b.context.workerId,jobId:b.context.jobId,tool:input.params?.name,operation:input.describe?'describe':input.method});
    res.end(JSON.stringify({ok:true,result}));
   }catch(error){res.statusCode=403;res.end(JSON.stringify({ok:false,error:{code:error.code??'WORKER_CLI_FAILED',message:error.code?error.message:'Worker plugin invocation failed'}}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  url='http://127.0.0.1:'+server.address().port+'/invoke';
 },async stop(){url=undefined;for(const token of tokens)state.bindings.delete(token);tokens.clear();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}};
}
export function workerCliEnvironment(lease){
 if(!lease)return {};
 return {OPENCLAW_WORKER_ID:lease.context.workerId,OPENCLAW_JOB_ID:lease.context.jobId,OPENCLAW_WORKER_CONTEXT:JSON.stringify(Object.fromEntries(Object.entries(lease.context).filter(([key])=>!['task','context','constraints','mainReplies'].includes(key)))),...(lease.url&&lease.token?{OPENCLAW_WORKER_CLI_URL:lease.url,OPENCLAW_WORKER_CLI_TOKEN:lease.token}:{})};
}
export function readWorkerCliContext(env=process.env){
 if(!env.OPENCLAW_WORKER_ID&&!env.OPENCLAW_JOB_ID&&!env.OPENCLAW_WORKER_CONTEXT)return undefined;
 let context;try{context=JSON.parse(env.OPENCLAW_WORKER_CONTEXT);}catch{throw denied('Worker context missing or invalid');}
 if(context.version!==1||context.workerId!==env.OPENCLAW_WORKER_ID||context.jobId!==env.OPENCLAW_JOB_ID||!context.agentId||!context.sessionKey?.startsWith('agent:'+context.agentId+':'))throw denied('Worker context identity mismatch');
 return context;
}
export async function connectWorkerCli(options={},env=process.env){
 const context=readWorkerCliContext(env);if(!context)return undefined;
 if(options.url||options.token||options.password||options.agent&&options.agent!==context.agentId||options.session&&options.session!==context.sessionKey)throw denied('Cannot override Worker connection or task identity');
 if(!/^http:\/\/127\.0\.0\.1:\d+\/invoke$/.test(env.OPENCLAW_WORKER_CLI_URL??'')||!env.OPENCLAW_WORKER_CLI_TOKEN)throw denied('Worker CLI lease unavailable');
 return {context,close(){},async request(method,params,extra={}){
  const response=await fetch(env.OPENCLAW_WORKER_CLI_URL,{method:'POST',headers:{authorization:'Bearer '+env.OPENCLAW_WORKER_CLI_TOKEN,'content-type':'application/json'},body:JSON.stringify({method,params,identity:{workerId:context.workerId,jobId:context.jobId},...extra}),signal:AbortSignal.timeout(Number(options.timeout??30000))});
  const output=await response.json();if(!response.ok||!output.ok)throw Object.assign(Error(output.error?.message??'Worker CLI failed'),{code:output.error?.code});return output.result;
 }};
}
