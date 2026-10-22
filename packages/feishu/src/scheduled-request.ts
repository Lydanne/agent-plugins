import type {OpenClawPluginApi,OpenClawPluginToolContext} from 'openclaw/plugin-sdk/plugin-entry';
import {SourceTask,sourceTaskBridge,isCompletionSourceCurrent,type TaskLease} from './source-task.js';
import {runFeishuWorkingTurn} from './working-turn-queue.js';
import {resolveFeishuRuntimeAccount} from './accounts.js';
import {sendMessageFeishu} from './send.js';
import type {ClawdbotConfig} from '../runtime-api.js';

type Source=Omit<TaskLease,'signal'> & {agentId:string;sessionId:string};
type Request={id:string;runKey:string;runAtMs:number;source:Source;projectId:string;task:string;constraints:string;schedule?:{tz?:string}};
type Callbacks={signal?:AbortSignal;assertCurrent:()=>void};
type Bridge={capture?:(context:OpenClawPluginToolContext)=>Source;current?:(source:Source)=>boolean;deliver?:(request:Request,callbacks:Callbacks)=>Promise<{accepted:boolean;jobIds:string[]}>};
const symbol=Symbol.for('ada.scheduled-requests.v1');
export const scheduledRequestBridge:Bridge=(globalThis as typeof globalThis & {[symbol]?:Bridge})[symbol]??=((globalThis as typeof globalThis & {[symbol]?:Bridge})[symbol]={});

export function createScheduledRequestAdapter(core:OpenClawPluginApi['runtime']) {
 const current=(p:Source)=>{
  if(!p.agentId||!p.sessionId||!p.requestMessageIds?.length||!p.sessionKey.startsWith('agent:'+p.agentId+':'))return false;
  if(!isCompletionSourceCurrent(p,core.state.resolveStateDir()))return false;
  const cfg=core.config.current();const storePath=core.agent.session.resolveStorePath(cfg.session?.store,{agentId:p.agentId});
  return core.agent.session.getSessionEntry({storePath,agentId:p.agentId,sessionKey:p.sessionKey,readConsistency:'latest'})?.sessionId===p.sessionId;
 };
 const capture=(context:OpenClawPluginToolContext):Source=>{
  const lease=sourceTaskBridge.leases.get(JSON.stringify([context.agentAccountId,context.sessionKey]));
  if(!lease||lease.signal.aborted||lease.scheduledRequest||!context.requesterSenderId||context.requesterSenderId!==lease.senderId||!context.agentId||!context.sessionId||!['group','topic_group'].includes(lease.chatType??''))throw Error('An active human group request is required');
  const {taskId,revision,accountId,chatId,sessionKey,senderId,sourceMessageIds,requestMessageIds,rootId,replyInThread,chatType,people}=lease;
  const p:Source=structuredClone({taskId,revision,accountId,chatId,sessionKey,senderId,sourceMessageIds,requestMessageIds,rootId,replyInThread,chatType,people,agentId:context.agentId,sessionId:context.sessionId});
  if(!current(p))throw Error('Schedule source is no longer current');return p;
 };
 const deliver=async(request:Request,callbacks:Callbacks)=>{
  const p=request.source;let accepted=false;let jobIds:string[]=[];let stage="queue";
  try{
  await runFeishuWorkingTurn({key:JSON.stringify([p.accountId,p.sessionKey]),senderId:p.senderId,signal:callbacks.signal,prepare:async()=>{},cancel:async()=>{throw Error('Scheduled Main turn cancelled');},run:async()=>{
   stage="source_validation";callbacks.assertCurrent();if(!current(p))throw Error('Schedule source or session is no longer current');
   stage="account_resolution";const base=core.config.current() as ClawdbotConfig;const account=resolveFeishuRuntimeAccount({cfg:base,accountId:p.accountId});
   if(!account.enabled||!account.configured)throw Error('Feishu account is unavailable');
   const cfg={...base,messages:{...base.messages,queue:{...base.messages?.queue,mode:'followup' as const}}};
   const messageId='scheduled:'+request.runKey;
   stage="source_creation";const source=new SourceTask({accountId:p.accountId,chatId:p.chatId,sessionKey:p.sessionKey,senderId:p.senderId,chatType:p.chatType,rootId:p.rootId,replyInThread:p.replyInThread,people:p.people},[
    ...p.sourceMessageIds.map(id=>({messageId:id,text:'',kind:p.requestMessageIds?.includes(id)?'request' as const:'reference' as const})),
    {messageId,text:'Scheduled occurrence',kind:'reference'},
   ]);
   const lease=source.begin();lease.scheduledRequest=true;
   const signal=callbacks.signal?AbortSignal.any([callbacks.signal,lease.signal]):lease.signal;
   const assertCurrent=()=>{callbacks.assertCurrent();signal.throwIfAborted();if(!current(p))throw Error('Schedule authorization changed');};
   const body='这是用户先前授权的定时任务触发，不是新的真人消息。仅执行本次保存的任务与范围；业务执行仍交给 agent_worker，使用指定 projectId。相对时间以本次触发时刻计算。不得创建新的定时任务。\n'+JSON.stringify({scheduleId:request.id,occurrence:request.runKey,triggeredAt:new Date(request.runAtMs).toISOString(),timeZone:request.schedule?.tz??'Asia/Shanghai',projectId:request.projectId,task:request.task,constraints:request.constraints})+'\n'+source.instruction();
   stage="context_creation";const ctxPayload=core.channel.reply.finalizeInboundContext({Body:body,BodyForAgent:body,RawBody:body,CommandBody:'',SessionKey:p.sessionKey,AccountId:p.accountId,From:'feishu:'+p.senderId,To:'chat:'+p.chatId,ChatType:'group',Provider:'feishu',Surface:'feishu',SenderId:p.senderId,OriginatingChannel:'feishu',OriginatingTo:'chat:'+p.chatId,MessageSid:messageId,CommandAuthorized:false});
   let deliveryError:unknown;
   try{
    assertCurrent();source.activate();
    stage="main_dispatch";await core.channel.inbound.run({channel:'feishu',accountId:p.accountId,raw:request,adapter:{ingest:()=>({id:messageId,rawText:body,textForAgent:body,textForCommands:'',raw:request}),resolveTurn:()=>({cfg,channel:'feishu',accountId:p.accountId,route:{agentId:p.agentId,sessionKey:p.sessionKey},ctxPayload,
     replyOptions:{abortSignal:signal,disableBlockStreaming:true,onAgentRunStart:()=>{assertCurrent();accepted=true;},turnAdoptionLifecycle:{onAdopted:()=>{},onDeferred:()=>false}},
     delivery:{deliver:async(payload,info)=>{if(info.kind!=='final'||payload.isReasoning||payload.isCommentary||!payload.text)return;
      try{assertCurrent();await sendMessageFeishu({cfg,accountId:p.accountId,to:'chat:'+p.chatId,text:payload.text,replyToMessageId:p.rootId??p.requestMessageIds?.at(-1),replyInThread:p.replyInThread??false});}catch(error){deliveryError=error;throw error;}
     },onError:error=>{deliveryError=error;throw error;}}})}});
    if(deliveryError)throw deliveryError;jobIds=[...(lease.asyncJobIds??[])];if(jobIds.length)accepted=true;
   }finally{source.close();}
  }});
  return {accepted,jobIds};
  }catch(error){throw Object.assign(new Error(error instanceof Error?error.message:String(error),{cause:error}),{scheduledStage:stage});}
 };
 return {capture,current,deliver};
}
export function registerScheduledRequestAdapter(api:OpenClawPluginApi){
 const adapter=createScheduledRequestAdapter(api.runtime);
 api.registerService({id:'feishu-scheduled-requests',start:()=>{Object.assign(scheduledRequestBridge,adapter);},stop:()=>{for(const key of ['capture','current','deliver'] as const)if(scheduledRequestBridge[key]===adapter[key])delete scheduledRequestBridge[key];}});
}
