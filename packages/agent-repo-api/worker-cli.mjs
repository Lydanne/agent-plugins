import {createServer} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {isAbsolute} from 'node:path';

const authorityKey='openclawWorkerCliV2';
const authorities=globalThis[Symbol.for('openclaw-plugins.worker-cli-authorities.v2')]??=new WeakSet();
const denied=message=>Object.assign(Error(message),{code:'WORKER_CONTEXT_DENIED'});
const repoReads=new Set(['list','inspect','people','person','people_stats','entity_types','entities','entity','relation_types','relations','graph','entity_history']);
function checkArguments(context,name,args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.hasOwn(args,'__openclawWorker'))throw denied('Invalid Worker plugin arguments');
 for(const key of ['accountId','account_id'])if(args[key]!==undefined&&args[key]!==context.accountId)throw denied('Cannot change the original Worker account');
 for(const key of ['projectId','repository'])if(args[key]!==undefined&&args[key]!==context[key])throw denied('Cannot change the original Worker project/repository');
 if(name==='agent_repo'&&!repoReads.has(args.action))throw denied('Repository synchronization and skill management require Main');
 if(name==='agent_worker'&&!['projects','queues','list','status'].includes(args.action))throw denied('Task orchestration requires Main');
 if(['agent_task_result','agent_schedule','agent_entity_sync','feishu_cli_auth'].includes(name)||name==='feishu_cli'&&args.confirmed===true)throw denied('Main decision or authorization required');
}
function capability(context){
 const value=context?.toolBindings?.[authorityKey];
 if(!value||!authorities.has(value))return undefined;
 value.assertCurrent();return value;
}
export function getWorkerCliContext(context){
 const value=capability(context);return value?structuredClone(value.context):undefined;
}
export function workerContextApi(api){
 return new Proxy(api,{get(target,key){
  if(key!=='registerTool')return Reflect.get(target,key);
  return (factory,options)=>target.registerTool(context=>{
   const cap=capability(context),bound=cap?{...context,workerContext:structuredClone(cap.context)}:context;
   const built=typeof factory==='function'?factory(bound):factory;
   const wrap=tool=>!tool||!cap?tool:{...tool,execute:(id,args,signal,...rest)=>{
    cap.assertCurrent();checkArguments(cap.context,tool.name,args);
    const combined=signal?AbortSignal.any([signal,cap.signal]):cap.signal;combined.throwIfAborted();
    return tool.execute(id,args,combined,...rest);
   }};
   return Array.isArray(built)?built.map(wrap):wrap(built);
  },options);
 }});
}
async function sdkSurface(options){
 const harness=await import('openclaw/plugin-sdk/agent-harness');
 const {getPluginToolMeta}=await import('openclaw/plugin-sdk/agent-harness-runtime');
 const create=harness.createOpenClawCodingToolsAsync??harness.createOpenClawCodingTools;
 if(typeof create!=='function'||typeof getPluginToolMeta!=='function')throw denied('Task-bound plugin surface is unavailable in this host');
 const tools=await create({...options,includeCoreTools:false,includeToolSearchControls:false,wrapBeforeToolCallHook:false});
 return tools.flatMap(tool=>{const meta=getPluginToolMeta(tool);return meta?[{tool,pluginId:meta.pluginId}]:[];});
}
async function sdkPolicy(input){
 const {runBeforeToolCallHook}=await import('openclaw/plugin-sdk/agent-harness-runtime');
 if(typeof runBeforeToolCallHook!=='function')throw denied('Original source policy is unavailable');
 return runBeforeToolCallHook(input);
}
/** Prepare policy from the public session/runtime API, never from CLI flags. */
export async function prepareWorkerCliOptions(api,b,config,{resolveSandbox}={}){
 const agent=api.runtime?.agent,session=agent?.session,p=b.provenance,c=b.context;
 if(!session?.resolveStorePath||!session?.getSessionEntry||!agent?.resolveAgentWorkspaceDir)throw denied('Original session policy is unavailable');
 if(p.policyContext?.version!==1)throw denied('Original task has no transferable policy snapshot; ask Main');
 if(!['feishu','local'].includes(p.policyContext.channel)||p.policyContext.channel==='feishu'&&!p.accountId||p.policyContext.channel==='local'&&p.accountId)throw denied('Original channel policy is not transferable; ask Main');
 const entry=await session.getSessionEntry({storePath:session.resolveStorePath(config.session?.store,{agentId:c.agentId}),agentId:c.agentId,sessionKey:c.sessionKey,readConsistency:'latest'});
 if(p.sessionId&&entry?.sessionId!==p.sessionId)throw denied('Original conversation was replaced');
 if(p.policyContext?.requiresOpaqueBindings)throw denied('Original run has nontransferable tool authority; ask Main');
 const workspaceDir=entry?.spawnedBy?(entry.spawnedWorkspaceDir??entry.spawnedCwd??agent.resolveAgentWorkspaceDir(config,c.agentId)):agent.resolveAgentWorkspaceDir(config,c.agentId);
 if(!isAbsolute(workspaceDir))throw denied('Original workspace unavailable');
 let sessionPermissionPolicy;
 if(entry?.permissionMode){
  if(!['read-only','guarded','workspace','full'].includes(entry.permissionMode)||entry.sessionRoot!==undefined&&!isAbsolute(entry.sessionRoot))throw denied('Unknown original session permission boundary');
  sessionPermissionPolicy=Object.freeze({mode:entry.permissionMode,root:entry.sessionRoot??workspaceDir});
 }
 resolveSandbox??=(await import('openclaw/plugin-sdk/agent-harness-runtime')).resolveSandboxContext;
 if(typeof resolveSandbox!=='function')throw denied('Original sandbox policy unavailable');
 const sandbox=await resolveSandbox({config,agentId:c.agentId,sessionKey:c.sessionKey,workspaceDir,requireCurrentConfig:true});
 const policy=p.policyContext??{};
 return {config,workspaceDir,cwd:c.cwd??workspaceDir,sessionPermissionPolicy,sandbox,
  agentId:c.agentId,sessionKey:c.sessionKey,sessionId:p.sessionId??entry?.sessionId,runId:c.workerId,
  messageProvider:p.accountId?'feishu':undefined,messageChannel:p.accountId?'feishu':undefined,
  agentAccountId:p.accountId,senderId:p.senderId,senderName:p.senderName??policy.senderName??undefined,senderUsername:policy.senderUsername??undefined,senderE164:policy.senderE164??undefined,memberRoleIds:policy.memberRoleIds??[],senderIsOwner:policy.senderIsOwner===true,
  nativeChannelId:p.chatId,messageTo:p.chatId?'chat:'+p.chatId:undefined,messageThreadId:p.rootId,
  groupId:['group','topic_group'].includes(p.chatType)||/:feishu:group:/.test(c.sessionKey)?p.chatId:undefined,chatType:p.chatType,
  spawnedBy:entry?.spawnedBy,modelProvider:policy.modelProvider??entry?.providerOverride??entry?.modelProvider,modelId:policy.modelId??entry?.modelOverride??entry?.model,
  sessionConfigSource:'runtime'};
}
export function createWorkerCliService({getConfig,authorize,getJob,prepareContext,createSurface=sdkSurface,runPolicy=sdkPolicy,onAudit=()=>{},pollMs=100}){
 let server,url;const bindings=new Map(),active=new Set();
 function assertCurrent(b){
  const job=getJob(b.context.jobId,b.context.sessionKey);
  if(job.status!=='running'||job.workerId!==b.context.workerId||authorize(job.provenance,b.context.sessionKey)!==true)throw denied('Worker execution or task source is no longer active');
  if(['agentId','sessionKey','accountId','chatId','senderId','taskId','revision','sessionId'].some(k=>job.provenance?.[k]!==b.provenance?.[k]))throw denied('Worker source changed');
 }
 const issue=(job,request)=>{
  if(!url||!job.provenance?.agentId||authorize(job.provenance,request.scope??job.provenance.sessionKey)!==true)return undefined;
  for(const [token,previous] of bindings){try{previous.assertCurrent();if(previous.context.jobId===job.jobId)bindings.delete(token);}catch{bindings.delete(token);}}
  const p=job.provenance,sessionKey=p.sessionKey??request.scope,params=request.resumeParams??request.params,token=randomBytes(32).toString('hex');
  if(typeof sessionKey!=='string'||!sessionKey.startsWith('agent:'+p.agentId+':')||request.scope&&p.sessionKey&&request.scope!==p.sessionKey)throw denied('Invalid original task scope');
  const context={version:1,workerId:job.workerId,jobId:job.jobId,agentId:p.agentId,sessionKey,cwd:request.runtime?.cwd,
   projectId:job.projectId??request.runtime?.projectContext?.projectId,repository:job.repository??request.runtime?.projectContext?.repository,
   source:{taskId:p.taskId,revision:p.revision,sessionId:p.sessionId,requestMessageIds:p.requestMessageIds,sourceMessageIds:p.sourceMessageIds},
   requesterId:p.senderId,accountId:p.accountId,chatId:p.chatId,task:params.task,context:params.context,constraints:params.constraints,...(params.mainReplies?{mainReplies:params.mainReplies}:{})};
  const b={context,provenance:structuredClone(p),assertCurrent:()=>assertCurrent(b)};bindings.set(token,b);return {url,token,context};
 };
 return {issue,async start(){
  server=createServer(async(req,res)=>{
   res.setHeader('Content-Type','application/json');
   const controller=new AbortController();active.add(controller);let timer;
   const abort=()=>controller.abort();req.once('aborted',abort);res.once('close',()=>{if(!res.writableFinished)abort();});
   try{
    if(req.method!=='POST'||req.url!=='/invoke')throw denied('Unsupported Worker CLI endpoint');
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1024*1024)throw denied('Worker request too large');}
    const input=JSON.parse(raw),b=bindings.get(req.headers.authorization?.replace(/^Bearer /,''));
    if(!b||input.identity?.workerId!==b.context.workerId||input.identity?.jobId!==b.context.jobId)throw denied('Invalid Worker execution identity');
    b.assertCurrent();controller.signal.throwIfAborted();
    timer=setInterval(()=>{try{b.assertCurrent();}catch{abort();}},pollMs);timer.unref();
    let result;
    if(input.method==='worker.context')result=b.context;
    else{
     if(!['tools.invoke','worker.catalog'].includes(input.method))throw denied('Worker management and arbitrary RPC are unavailable');
     const {name,args={},agentId=b.context.agentId,sessionKey=b.context.sessionKey}=input.params??{};
     if(agentId!==b.context.agentId||sessionKey!==b.context.sessionKey)throw denied('Worker task scope mismatch');
     const config=getConfig();if(!prepareContext)throw denied('Original session policy is unavailable');
     const options=await prepareContext(b,config);b.assertCurrent();controller.signal.throwIfAborted();
     const cap={context:structuredClone(b.context),signal:controller.signal,assertCurrent:b.assertCurrent};authorities.add(cap);
     try{
      const surface=await createSurface({...options,abortSignal:controller.signal,toolBindings:{...options.toolBindings,[authorityKey]:cap}});
      b.assertCurrent();controller.signal.throwIfAborted();
      if(input.method==='worker.catalog'){
       const plugins=new Map();for(const {tool,pluginId} of surface){const group=plugins.get(pluginId)??{pluginId,tools:[]};group.tools.push({name:tool.name,description:tool.description,taskBound:true});plugins.set(pluginId,group);}result={agentId,plugins:[...plugins.values()]};
      }else{
       const found=surface.find(entry=>entry.tool.name===name);if(!found)throw denied('Plugin is unavailable under the original task policy');
       const {tool,pluginId}=found;
       if(input.describe)result={name,pluginId,parameters:tool.parameters,description:tool.description};
       else{
        checkArguments(b.context,name,args);
        const callId='worker-cli:'+randomUUID();
        const hook=await runPolicy({toolName:name,params:structuredClone(args),toolCallId:callId,signal:controller.signal,approvalMode:'deny',ctx:{
         config,agentId,sessionKey,sessionId:options.sessionId,runId:b.context.workerId,cwd:options.cwd,workspaceDir:options.workspaceDir,
         channelId:b.context.chatId,requester:{channel:options.messageChannel,accountId:b.context.accountId,senderId:b.context.requesterId,senderIsOwner:options.senderIsOwner===true,roleIds:options.memberRoleIds},
         turnSourceChannel:options.messageChannel,turnSourceTo:options.messageTo,turnSourceAccountId:b.context.accountId,turnSourceThreadId:options.messageThreadId,assertActive:b.assertCurrent}});
        if(hook.blocked)throw denied(hook.reason??'Original source policy denied this call');
        checkArguments(b.context,name,hook.params);b.assertCurrent();controller.signal.throwIfAborted();
        const output=await tool.execute(callId,hook.params,controller.signal);
        b.assertCurrent();controller.signal.throwIfAborted();result={ok:true,toolName:name,output,source:'plugin'};
       }
      }
     }finally{authorities.delete(cap);}
    }
    try{onAudit({event:'worker.plugin_cli',workerId:b.context.workerId,jobId:b.context.jobId,tool:input.params?.name,operation:input.describe?'describe':input.method});}catch{/* Audit failure must not turn an accepted write into an unsafe retry. */}
    if(!res.destroyed)res.end(JSON.stringify({ok:true,result}));
   }catch(error){if(!res.destroyed){res.statusCode=403;res.end(JSON.stringify({ok:false,error:{code:error.code??'WORKER_CLI_FAILED',message:error.code?error.message:'Worker plugin invocation failed or was interrupted; inspect existing results before retrying'}}));}}
   finally{clearInterval(timer);active.delete(controller);}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});url='http://127.0.0.1:'+server.address().port+'/invoke';
 },async stop(){url=undefined;for(const controller of active)controller.abort();bindings.clear();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}};
}
export function workerCliEnvironment(lease){
 if(!lease)return {};
 return {OPENCLAW_WORKER_ID:lease.context.workerId,OPENCLAW_JOB_ID:lease.context.jobId,OPENCLAW_WORKER_CONTEXT:JSON.stringify(Object.fromEntries(Object.entries(lease.context).filter(([key])=>!['task','context','constraints','mainReplies'].includes(key)))),...(lease.url&&lease.token?{OPENCLAW_WORKER_CLI_URL:lease.url,OPENCLAW_WORKER_CLI_TOKEN:lease.token}:{})};
}
export function readWorkerCliContext(env=process.env){
 if(!env.OPENCLAW_WORKER_ID&&!env.OPENCLAW_JOB_ID&&!env.OPENCLAW_WORKER_CONTEXT)return undefined;
 let context;try{context=JSON.parse(env.OPENCLAW_WORKER_CONTEXT);}catch{throw denied('Worker context missing or invalid');}
 if(context.version!==1||context.workerId!==env.OPENCLAW_WORKER_ID||context.jobId!==env.OPENCLAW_JOB_ID||!context.agentId||!context.sessionKey?.startsWith('agent:'+context.agentId+':'))throw denied('Worker context identity mismatch');return context;
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
