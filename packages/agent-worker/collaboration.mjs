import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {readJson,writeJson} from './jobs.mjs';
import {getPeopleService} from './dist/people-api.mjs';

// Source-bound, stable across tool retries/restarts. One delegation per topic and
// repository in a human source revision; different bodies require explicit intent.
export function hostRequestId(params,p){
 if(params.requestId!==undefined||!p?.taskId||!p?.sessionKey)return params.requestId;
 return 'host:'+createHash('sha256').update(JSON.stringify([p.sessionKey,p.accountId,p.senderId,p.taskId,p.revision,params.topic,params.repository??(params.projectId?'projects/'+params.projectId:'')])).digest('hex');
}
export function localPersonCall(call,p,getService=getPeopleService){
 if(call.capability!=='person_lookup')return {fallback:true};
 if(Object.keys(call.arguments).some(k=>k!=='openId')||typeof call.arguments.openId!=='string')return {fallback:true};
 const people=[p?.people?.requester,...(p?.people?.mentions??[])].filter(Boolean);
 const identity=people.find(person=>person.openId===call.arguments.openId&&person.accountId===p.accountId);
 if(!identity?.appId||!p?.agentId)return {fallback:true};
 const service=getService(p.agentId);if(!service?.lookup)return {fallback:true};
 const person=service.lookup({accountId:p.accountId,appId:identity.appId,openId:identity.openId});
 return {ok:true,source:'local',found:!!person,person:person??null,observedAt:new Date().toISOString()};
}

// Host-only coordinator. Durable sidecar files never race the detached worker's
// heartbeat writer. Unknown/unregistered calls always return to Main.
export function createCollaborationService({root,jobs,bridge,personCall=localPersonCall,logger=console}){
 const directory=join(root,'collaboration');let stopped=true,timer,scheduled,inflight;
 const save=(id,value)=>writeJson(join(directory,id+'.json'),value);
 async function scan(){
  if(stopped||!existsSync(root))return;
  mkdirSync(directory,{recursive:true,mode:0o700});
  for(const name of readdirSync(root).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n))){
   try{
   let job=readJson(join(root,name));const p=job.provenance;
   if(!p?.sessionKey||bridge.authorizeReply?.(p)!==true)continue;
   const file=join(directory,name),state=existsSync(file)?readJson(file):{events:{},calls:{}};
   const observe=async(key,event)=>{
    if(state.events[key])return;
    if(!bridge.observe)throw Error('Main observation unavailable');
    await bridge.observe({jobId:job.jobId,provenance:p,...event});state.events[key]={kind:event.kind,at:Date.now(),callId:event.callId??event.call?.callId,questionId:event.question?.questionId,supplementId:event.supplementId,childJobId:event.childJobId,status:event.status,reason:event.reason};save(job.jobId,state);
   };
   for(const q of job.questions??[])if(q.resumeReason==='user_wait_timeout'&&q.answer!==undefined){
    await observe('timeout:'+q.questionId,{kind:'timeout_continued',question:q});
    if(q.expiresAt>Date.now()&&!state.events['card:'+q.questionId]&&bridge.contextState){
     await bridge.contextState({jobId:job.jobId,questionId:q.questionId,provenance:p,status:'resumed'});
     state.events['card:'+q.questionId]=true;save(job.jobId,state);
    }
   }
   await jobs.processSupplements?.(job.jobId,p.sessionKey,v=>bridge.authorizeReply?.(v)===true,async event=>observe('supplement:'+event.supplementId+':'+event.kind,event));
   job=readJson(join(root,name));
   const q=job.contextRequest,call=q?.pluginCall;
   if(job.status==='awaiting_main'&&call){
    const key=call.callId,body=JSON.stringify(call);let record=state.calls[key];
    if(record&&record.body!==body){await observe('conflict:'+q.questionId,{kind:'plugin_call_conflict',callId:key});continue;}
    if(!record){
     await observe('request:'+q.questionId,{kind:'plugin_requested',callId:key,call});
     let result;try{result=personCall(call,p);}catch{result={ok:false,error:'local_lookup_failed'};}
     if(result.fallback)continue;
     if(JSON.stringify(result).length>12000)result={ok:false,error:'result_too_large'};
     record={body,result};state.calls[key]=record;save(job.jobId,state);
    }
    await observe('result:'+q.questionId,{kind:'plugin_result',callId:key,result:record.result});
    if(bridge.authorizeReply?.(p)!==true)continue;
    await jobs.reply(job.jobId,p.sessionKey,q.questionId,JSON.stringify({callId:key,...record.result}),{senderId:p.senderId,accountId:p.accountId},v=>bridge.authorizeReply?.(v)===true,false,undefined,{answerSource:'main_context',answerBasis:'宿主已登记的原任务人员本地只读查询'});
   }
   }catch{logger.warn?.('Worker collaboration deferred: '+name);}
  }
 }
 const tick=()=>inflight??=(scan().finally(()=>{inflight=undefined;}));
 return {tick,start({scheduler}={}){stopped=false;if(scheduler)scheduled=scheduler.schedule({id:'collaboration-scan',delayMs:0,everyMs:1000,run:tick});else{timer=setInterval(()=>tick().catch(()=>{}),1000);timer.unref();}},async stop(){stopped=true;clearInterval(timer);scheduled?.cancel();await inflight;await scheduled?.stop();}};
}
