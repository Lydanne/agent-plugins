import {connectWorkerCli,readWorkerCliContext} from './worker-cli.mjs';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const kebab=value=>value.replace(/([a-z0-9])([A-Z])/g,'$1-$2').replaceAll('_','-').toLowerCase();
export async function cliParameters(options,read=path=>readFile(path,'utf8')) {
 if(options.params!==undefined&&options.paramsFile!==undefined)throw Error('Use either --params or --params-file');
 const text=options.paramsFile!==undefined?await read(options.paramsFile):options.params??'{}';
 if(Buffer.byteLength(text)>1024*1024)throw Error('CLI parameters exceed 1 MiB');
 let params;try{params=JSON.parse(text);}catch{throw Error('CLI parameters must be valid JSON');}
 if(!object(params))throw Error('CLI parameters must be a JSON object');
 return params;
}
export function cliSession(options) {
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.agent??''))throw Error('Explicit --agent is required');
 const key=options.session??'agent:'+options.agent+':main';
 if(!key.startsWith('agent:'+options.agent+':'))throw Error('--session must belong to --agent');
 return key;
}
// One authenticated connection for the whole command: chunks and diagnostic
// leases are connection-owned. Never weaken their server-side ownership checks.
export async function connectCli(config,options,{sdk,env=process.env}={}) {
 const worker=await connectWorkerCli(options,env);if(worker)return worker;
 sdk??=await import('openclaw/plugin-sdk/gateway-runtime');
 const timeout=Number(options.timeout??30000);
 if(!Number.isInteger(timeout)||timeout<1||timeout>3600000)throw Error('--timeout must be 1..3600000 milliseconds');
 const gateway=config.gateway??{},remote=gateway.mode==='remote';
 const url=options.url??(remote?gateway.remote?.url:(gateway.tls?.enabled?'wss':'ws')+'://127.0.0.1:'+(env.OPENCLAW_GATEWAY_PORT??gateway.port??18789));
 if(typeof url!=='string'||!/^wss?:\/\//.test(url))throw Error('Gateway URL unavailable; provide --url');
 // An explicit endpoint must use explicit credentials; never send the local
 // Gateway secret to a user-supplied endpoint.
 const explicit=options.url!==undefined;
 const auth=explicit?{}:remote?(gateway.remote??{}):sdk.resolveGatewayAuth({authConfig:gateway.auth,env,tailscaleMode:gateway.tailscale?.mode});
 const token=options.token??(explicit?env.OPENCLAW_GATEWAY_TOKEN:(auth.token??env.OPENCLAW_GATEWAY_TOKEN));
 const password=options.password??(explicit?env.OPENCLAW_GATEWAY_PASSWORD:(auth.password??env.OPENCLAW_GATEWAY_PASSWORD));
 if(!explicit&&!remote&&!token&&!password&&(object(gateway.auth?.token)||object(gateway.auth?.password)))throw Error('Unresolved Gateway credential; provide an environment credential or explicit credential');
 for(const value of [token,password])if(value!==undefined&&typeof value!=='string')throw Error('Unresolved Gateway credential; provide --token/--password or an environment credential');
 let client,ready=false,closed=false;
 let rejectConnection;
 const connected=new Promise((resolve,reject)=>{rejectConnection=reject;
  client=new sdk.GatewayClient({url,token,password,clientName:'cli',mode:'cli',clientDisplayName:'Plugin CLI',
   scopes:['operator.admin','operator.read','operator.write','operator.approvals','operator.pairing'],
   tlsFingerprint:options.tlsFingerprint??(!explicit&&remote?gateway.remote?.tlsFingerprint:undefined),requestTimeoutMs:timeout,
   onHelloOk:()=>{ready=true;resolve();},onConnectError:reject,
   onClose:()=>{closed=true;if(!ready)reject(Error('Gateway connection closed'));client?.stop();}});
 });
 const timer=setTimeout(()=>rejectConnection(Error('Gateway connection timed out')),timeout);
 try{client.start();await connected;}catch(error){client.stop();throw error;}finally{clearTimeout(timer);}
 return {request(method,params){if(closed)throw Error('Gateway connection lost; inspect the operation before retrying');return client.request(method,params,{timeoutMs:timeout});},close:()=>client.stop()};
}
function toolOutput(result) {
 if(result?.ok===false||result?.output?.isError===true)throw Object.assign(Error(result.error?.message??'Plugin tool failed'),{result});
 const output=result.output??result.result??result;
 if(output?.isError)throw Object.assign(Error('Plugin tool failed'),{result});
 if(output?.content?.length===1&&output.content[0].type==='text'){
  try{return JSON.parse(output.content[0].text);}catch{return output;}
 }
 return output;
}
export async function sessionOutput(rpc,pluginId,prefix,action,scope,payload) {
 const read=async(name,data)=>{
  const response=await rpc('plugins.sessionAction',{pluginId,actionId:prefix+name,...scope,payload:data});
  if(response?.ok!==true)throw Object.assign(Error(response?.error??'Plugin management action failed'),{result:response,code:response?.code});
  return response.result;
 };
 const first=await read(action,payload);
 if(first?.encoding!=='json-chunks')return first;
 if(typeof first.transferId!=='string'||!Number.isInteger(first.totalChunks)||first.totalChunks<1||first.totalChunks>512)throw Error('Invalid plugin transfer');
 const chunks=[];
 for(let index=0;index<first.totalChunks;index++){
  const part=index===0?first:await read('chunk',{transferId:first.transferId,index});
  if(part?.encoding!=='json-chunks'||part.transferId!==first.transferId||part.totalChunks!==first.totalChunks||part.index!==index||typeof part.chunk!=='string'||part.chunk.length>32000)throw Error('Incomplete plugin transfer');
  chunks.push(part.chunk);
 }
 return JSON.parse(chunks.join(''));
}
export function registerPluginCli(api,{pluginId,tools,actions,prefix,automation,automationClient,local},{connect=connectCli,write=value=>process.stdout.write(JSON.stringify(value)+'\n'),env=process.env}={}) {
 api.registerCli?.(({program,config})=>{
  const root=program.command(pluginId).description('Authenticated '+pluginId+' tools and management; preserves server permissions and source checks');
  const common=command=>command.option('--agent <id>','Agent ID').option('--session <key>','Session key (default: agent:<id>:main)')
   .option('--params <json>','JSON object parameters').option('--params-file <path>','UTF-8 JSON object file')
   .option('--url <url>','Gateway WebSocket URL (requires explicit credentials)').option('--token <token>','Gateway token')
   .option('--password <password>','Gateway password').option('--tls-fingerprint <fingerprint>','Pinned Gateway TLS fingerprint').option('--timeout <ms>','RPC timeout in milliseconds','30000').option('--json','JSON output (always enabled)');
  const execute=(command,handler)=>common(command).action(async options=>{
   let connection;
   try{const worker=readWorkerCliContext(env);options={...options,agent:options.agent??worker?.agentId,session:options.session??worker?.sessionKey};const sessionKey=cliSession(options),params=await cliParameters(options);connection=await connect(config,options,{env});
    const result=await handler(connection.request.bind(connection),params,{agentId:options.agent,sessionKey},options);write({ok:true,result});
   }catch(error){write({ok:false,error:{code:error.code??'PLUGIN_CLI_FAILED',message:error.message},...(error.result?{result:error.result}:{})});process.exitCode=1;}
   finally{connection?.close();}
  });
  root.command('capabilities').description('List all CLI operations and their transport').action(()=>write({ok:true,result:{pluginId,tools,management:actions,automation:automation??[],local:local?['inspect','plan']:[],notice:'Server checks still apply; source-bound tools need a current trusted task. No credential or provenance injection.'}}));
  for(const [index,tool] of tools.entries()){
   if(!tool.actions){execute(root.command(tool.command).description(tool.name+' source-bound tool'),async(rpc,params,scope)=>toolOutput(await rpc('tools.invoke',{name:tool.name,...scope,args:params})));continue;}
   const group=index===0?root:root.command(tool.command).description(tool.name+' tool (subject to tool policy and source checks)');
   for(const action of tool.actions){
    execute(group.command(kebab(action)).description(tool.name+' action='+action),async(rpc,params,scope)=>{
     if(Object.hasOwn(params,'action')&&params.action!==action)throw Error('Parameter action conflicts with the CLI command');
     return toolOutput(await rpc('tools.invoke',{name:tool.name,...scope,args:{...params,action}}));
    });
   }
  }
  const manage=root.command('manage').description('Management actions with the same permissions, revisions and confirmations as Control UI');
  for(const action of actions.filter(action=>action!=='chunk'))execute(manage.command(kebab(action)).description(prefix+action),(rpc,params,scope)=>sessionOutput(rpc,pluginId,prefix,action,scope,params));
  if(actions.includes('diagnosticStart'))execute(manage.command('diagnostic-watch').description('Capture live diagnostics on one connection; bounded duration, cleanup on exit')
   .option('--duration <ms>','Capture duration, 1..3600000 ms','10000'),async(rpc,params,scope,options)=>{
    const duration=Number(options.duration);if(!Number.isInteger(duration)||duration<1||duration>3600000)throw Error('Invalid --duration');
    const request=(action,payload)=>sessionOutput(rpc,pluginId,prefix,action,scope,payload);
    const lease=await request('diagnosticStart',params);let after=0;
    const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{const deadline=Date.now()+duration;while(Date.now()<deadline&&!controller.signal.aborted){
     const result=await request('diagnosticRead',{leaseId:lease.leaseId,afterSeq:after});after=result.nextSeq;write({ok:true,event:'diagnostics',result});
     if(Date.now()<deadline){await request('diagnosticRenew',{leaseId:lease.leaseId});try{await delay(Math.min(1000,deadline-Date.now()),undefined,{signal:controller.signal});}catch(error){if(!controller.signal.aborted)throw error;}}
    }}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await request('diagnosticStop',{leaseId:lease.leaseId});}
    return {stopped:true,leaseId:lease.leaseId};
   });
  if(pluginId==='agent-worker'){
   root.command('context').description('Read the current task-bound Worker CLI context').action(async()=>{
    let connection;
    try{connection=await connectWorkerCli({},env);if(!connection)throw Error('No active Worker context');write({ok:true,result:await connection.request('worker.context',{})});}
    catch(error){write({ok:false,error:{code:error.code??'WORKER_CONTEXT_UNAVAILABLE',message:error.message}});process.exitCode=1;}
    finally{connection?.close();}
   });
   const workerOnly=handler=>(...args)=>{if(!readWorkerCliContext(env))throw Error('Plugin direct calls require a Worker execution context');return handler(...args);};
   const plugin=root.command('plugin').description('Task-bound plugin discovery and direct invocation');
   execute(plugin.command('list'),workerOnly(rpc=>rpc('worker.catalog',{})));
   execute(plugin.command('describe').requiredOption('--tool <name>','Plugin tool name'),workerOnly((rpc,params,scope,options)=>rpc('tools.invoke',{...scope,name:options.tool,args:params},{describe:true})));
   execute(plugin.command('call').requiredOption('--tool <name>','Plugin tool name'),workerOnly(async(rpc,params,scope,options)=>toolOutput(await rpc('tools.invoke',{...scope,name:options.tool,args:params}))));
  }
  if(automation){const group=root.command('automation').description('Source-bound automation RPC; requires configured caller/Agent/project allowlists');
   for(const action of automation)execute(group.command(action),async(rpc,params,scope)=>{
    if(action==='submit'&&(params.agentId!==undefined&&params.agentId!==scope.agentId))throw Error('Automation Agent conflicts with --agent');
    const input=action==='submit'?{...params,agentId:scope.agentId}:params;
    if(automationClient){const client=automationClient(rpc);if(action==='submit')return client.submit(input);if(action==='rerun')return client.rerun(input.taskId,input.operationId,scope.agentId);}
    return rpc(pluginId+'.automation.'+action,input);
   });
  }
  if(local){const group=root.command('local').description('Offline read-only inspection and configuration patch plans; never applies a plan');
   for(const action of ['inspect','plan'])group.command(action).requiredOption('--repo <path>','Agent Repo path').option('--agent-id <id>','Agent ID')
    .option('--config <path>','Configuration input path').option('--default-project <id>','Default project').option('--activate-workspace').option('--installed').option('--prepare-migration').option('--prepare-sync')
    .action(async options=>{try{const args=[action];for(const [key,value]of Object.entries(options))if(value!==undefined&&value!==false){args.push('--'+kebab(key));if(value!==true)args.push(value);}write({ok:true,result:await local(args)});}catch(error){write({ok:false,error:{message:error.message}});process.exitCode=1;}});
  }
 },{commands:[pluginId],descriptors:[{name:pluginId,description:pluginId+' tools and management',hasSubcommands:true}]});
}
