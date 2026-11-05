import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

// One private server per execution, in the existing supervised process group.
// No shared daemon, arbitrary thread attachment, turn interrupt or retry.
export async function runAppServerTurn({invocation,config,prompt,threadId,refresh=false,outputSchema,deadline,env,signal,onProgress,onEvent,onLiveSteering,toolBridge}){
 signal?.throwIfAborted();
 const definitions=structuredClone(toolBridge?.definitions??[]);
 if(!Array.isArray(definitions))throw Error('Invalid Worker tool bridge');
 const toolNames=new Set(definitions.map(tool=>tool?.name));
 if(toolBridge&&(typeof toolBridge.invoke!=='function'||toolNames.size!==definitions.length||definitions.some(tool=>tool?.type!=='function'||typeof tool.name!=='string'||!tool.name||typeof tool.description!=='string'||!tool.inputSchema)))throw Error('Invalid Worker tool bridge');
 const toolController=new AbortController(),toolSignal=signal?AbortSignal.any([signal,toolController.signal]):toolController.signal,toolCalls=new Set(),pendingTools=new Set();
 const child=spawn(process.execPath,[fileURLToPath(new URL('./execution-supervisor.mjs',import.meta.url))],{cwd:config.cwd,detached:true,stdio:['pipe','pipe','pipe','ipc'],env});
 const pending=new Map();let seq=0,buffer='',bytes=0,closed=false,active,finalText='',complete,fail;
 const done=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});done.catch(()=>{});
 const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
 const stop=error=>{if(closed)return;closed=true;for(const p of pending.values())p.reject(error);pending.clear();fail(error);kill();};
 const abort=()=>stop(Error('Codex query cancelled'));
 const timer=setTimeout(()=>stop(Object.assign(Error('Codex query execution timeout'),{code:'EXECUTION_TIMEOUT'})),Math.max(1,deadline-Date.now()));
 const write=message=>child.stdin.write(JSON.stringify(message)+'\n');
 const rpc=(method,params)=>new Promise((resolve,reject)=>{if(closed)return reject(Error('App server connection closed'));const id=++seq;pending.set(id,{resolve,reject});write({id,method,params});});
 const handleTool=async event=>{
  const p=event.params;let result={success:false,contentItems:[{type:'inputText',text:'Worker tool call denied or interrupted; do not retry writes without checking their outcome.'}]};
  try{
   if(refresh||closed||!active||p?.threadId!==threadId||p.turnId!==active||p.namespace||!toolNames.has(p.tool)||typeof p.callId!=='string'||!p.callId||toolCalls.has(p.callId)||toolCalls.size>=1000||pendingTools.size>=8)throw Error('Invalid Worker tool invocation');
   toolCalls.add(p.callId);pendingTools.add(event);toolSignal.throwIfAborted();
   const output=await toolBridge.invoke({name:p.tool,arguments:p.arguments,callId:p.callId,signal:toolSignal});
   toolSignal.throwIfAborted();
   if(closed||p.turnId!==active)return;
   const text=JSON.stringify(output);if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)throw Error('Worker tool output exceeds limit');
   result={success:true,contentItems:[{type:'inputText',text}]};
  }catch{/* Never return provider errors or task credentials as a tool error. */}
  finally{pendingTools.delete(event);}
  if(!closed)write({id:event.id,result});
 };
 child.stdin.on('error',stop);child.on('error',stop);
 child.stderr.on('data',()=>{}); // Never expose server diagnostics containing local configuration.
 child.on('message',event=>{if(event?.type==='execution_exit')stop(Error('App server exited before turn completed'));});
 child.on('close',()=>{if(!closed)stop(Error('App server connection closed'));});
 const decoder=new StringDecoder('utf8');
 child.stdout.on('data',chunk=>{
  bytes+=chunk.length;if(bytes>8*1024*1024)return stop(Error('Codex output limit exceeded'));
  buffer+=decoder.write(chunk);let pos;
  while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);if(!line.trim())continue;
   try{
    const event=JSON.parse(line);
    if(event.id!==undefined&&!event.method){const p=pending.get(event.id);if(!p)continue;pending.delete(event.id);if(event.error)p.reject(Object.assign(Error('App server rejected '+(event.error.code??'request')),{definitelyRejected:true}));else p.resolve(event.result);continue;}
    if(event.id!==undefined){
     if(event.method==='item/tool/call'&&toolBridge){void handleTool(event).catch(stop);continue;}
     write({id:event.id,error:{code:-32601,message:'Interactive requests are unavailable in this Worker execution'}});continue;
    }
    const p=event.params;
    if(!p||p.threadId!==threadId)continue;
    if(event.method==='turn/started'){
     active=p.turn.id;finalText='';onProgress?.({liveTurn:refresh?null:{threadId,turnId:active}});
     if(!refresh)onLiveSteering?.({threadId,turnId:active,send:async({id,text})=>{
      if(!active||closed)throw Object.assign(Error('Turn no longer active'),{definitelyRejected:true});
      return rpc('turn/steer',{threadId,expectedTurnId:active,clientUserMessageId:id,input:[{type:'text',text,text_elements:[]}]});
     }});
    }
    if(event.method==='item/completed'&&active&&p.turnId===active){
     const item=p.item;
     if(refresh&&!['agentMessage','reasoning','userMessage','plan'].includes(item.type))throw Error('Skill refresh attempted a tool action; user task was not started');
     if(item.type==='agentMessage'){if(item.phase!=='commentary')finalText=item.text;onEvent?.({type:'item.completed',item:{type:'agent_message',text:item.text}});}
     else if(item.type==='commandExecution')onEvent?.({type:'item.completed',item:{type:'command_execution',command:item.command,exit_code:item.exitCode,aggregated_output:item.aggregatedOutput}});
    }
    if(event.method==='turn/completed'&&p.turn.id===active){if(pendingTools.size)throw Error('App server completed with unfinished Worker tools');active=null;onLiveSteering?.(null);onProgress?.({liveTurn:null});if(p.turn.status!=='completed')throw Error('App server turn '+p.turn.status);if(!finalText)throw Error('Codex returned no final response');complete(finalText);}
   }catch(error){stop(error);}
  }
 });
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{
  onProgress?.({executionPid:child.pid});
  child.send({command:invocation.command,args:invocation.args});
  await rpc('initialize',{clientInfo:{name:'agent-worker',version:'1.0.1'},capabilities:{experimentalApi:true}});write({method:'initialized'});
  const sandbox=refresh||config.approvalMode==='read-only'?'read-only':config.approvalMode==='workspace-write'?'workspace-write':'danger-full-access';
  const params={cwd:config.cwd,model:config.model,approvalPolicy:'never',...(config.directoryPermissionProfile?{permissions:config.directoryPermissionProfile}:{sandbox}),developerInstructions:config.executorInstructions.replaceAll('{projectDir}',config.cwd),config:{...config.directoryPermissionConfig,model_reasoning_effort:config.reasoningEffort},...(config.speed?{serviceTier:config.speed}:{})};
  const response=await rpc(threadId?'thread/resume':'thread/start',{...params,...(threadId?{threadId,excludeTurns:true}:toolBridge?{dynamicTools:definitions}:{})});
  if(config.directoryPermissionProfile&&response.activePermissionProfile?.id!==config.directoryPermissionProfile)throw Error('Codex CLI did not apply the required directory permission profile');
  if(threadId&&response.thread?.id!==threadId)throw Error('Original Worker session cannot be resumed safely');
  threadId=response.thread?.id;if(typeof threadId!=='string'||!threadId)throw Error('App server returned no thread');
  onProgress?.({sessionId:threadId});
  await rpc('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}],...(outputSchema?{outputSchema}:{})});
  return await done;
 }finally{
  closed=true;toolController.abort();clearTimeout(timer);signal?.removeEventListener('abort',abort);
  for(const p of pending.values())p.reject(Error('App server execution closed'));pending.clear();
  try{onLiveSteering?.(null);onProgress?.({liveTurn:null});}finally{kill();}
 }
}
