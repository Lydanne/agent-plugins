import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

// One private server per execution, in the existing supervised process group.
// No shared daemon, arbitrary thread attachment, turn interrupt or retry.
export async function runAppServerTurn({invocation,config,prompt,threadId,refresh=false,outputSchema,deadline,env,signal,onProgress,onEvent,onLiveSteering}){
 signal?.throwIfAborted();
 const child=spawn(process.execPath,[fileURLToPath(new URL('./execution-supervisor.mjs',import.meta.url))],{cwd:config.cwd,detached:true,stdio:['pipe','pipe','pipe','ipc'],env});
 const pending=new Map();let seq=0,buffer='',bytes=0,closed=false,active,finalText='',complete,fail;
 const done=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});done.catch(()=>{});
 const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
 const stop=error=>{if(closed)return;closed=true;for(const p of pending.values())p.reject(error);pending.clear();fail(error);kill();};
 const abort=()=>stop(Error('Codex query cancelled'));
 const timer=setTimeout(()=>stop(Object.assign(Error('Codex query execution timeout'),{code:'EXECUTION_TIMEOUT'})),Math.max(1,deadline-Date.now()));
 const write=message=>child.stdin.write(JSON.stringify(message)+'\n');
 const rpc=(method,params)=>new Promise((resolve,reject)=>{if(closed)return reject(Error('App server connection closed'));const id=++seq;pending.set(id,{resolve,reject});write({id,method,params});});
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
    if(event.id!==undefined){write({id:event.id,error:{code:-32601,message:'Interactive requests are unavailable in this Worker execution'}});continue;}
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
    if(event.method==='turn/completed'&&p.turn.id===active){active=null;onLiveSteering?.(null);onProgress?.({liveTurn:null});if(p.turn.status!=='completed')throw Error('App server turn '+p.turn.status);if(!finalText)throw Error('Codex returned no final response');complete(finalText);}
   }catch(error){stop(error);}
  }
 });
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{
  onProgress?.({executionPid:child.pid});
  child.send({command:invocation.command,args:invocation.args});
  await rpc('initialize',{clientInfo:{name:'agent-worker',version:'1.0.1'},capabilities:{experimentalApi:true}});write({method:'initialized'});
  const sandbox=refresh||config.approvalMode==='read-only'?'read-only':config.approvalMode==='workspace-write'?'workspace-write':'danger-full-access';
  const params={cwd:config.cwd,model:config.model,approvalPolicy:'never',sandbox,developerInstructions:config.executorInstructions.replaceAll('{projectDir}',config.cwd),config:{model_reasoning_effort:config.reasoningEffort},...(config.speed?{serviceTier:config.speed}:{})};
  const response=await rpc(threadId?'thread/resume':'thread/start',{...params,...(threadId?{threadId,excludeTurns:true}:{})});
  if(threadId&&response.thread?.id!==threadId)throw Error('Original Worker session cannot be resumed safely');
  threadId=response.thread?.id;if(typeof threadId!=='string'||!threadId)throw Error('App server returned no thread');
  onProgress?.({sessionId:threadId});
  await rpc('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}],...(outputSchema?{outputSchema}:{})});
  return await done;
 }finally{
  closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
  for(const p of pending.values())p.reject(Error('App server execution closed'));pending.clear();
  try{onLiveSteering?.(null);onProgress?.({liveTurn:null});}finally{kill();}
 }
}
