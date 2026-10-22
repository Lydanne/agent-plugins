import type {OpenClawPluginApi,OpenClawPluginToolContext} from 'openclaw/plugin-sdk/plugin-entry';
import {SourceTask,sourceTaskBridge,isCompletionSourceCurrent,type TaskLease} from './source-task.js';
import {runFeishuWorkingTurn} from './working-turn-queue.js';
import {resolveFeishuRuntimeAccount} from './accounts.js';
import {sendCardFeishu} from './send.js';
import {workingResultCard} from './working-card.js';
import {assertFeishuCardWithinEnvelope,withinCardTableLimit} from './presentation-card.js';
import type {ClawdbotConfig} from '../runtime-api.js';

type Source=Omit<TaskLease,'signal'> & {agentId:string;sessionId:string};
type Request={trigger?:'manual'|'scheduled';id:string;runKey:string;runAtMs:number;source:Source;projectId:string;task:string;constraints:string;schedule?:{tz?:string}};
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
  const p=request.source;let accepted=false;let jobIds:string[]=[];let stage="queue";const deliveryReceipts:{messageId:string;chatId:string}[]=[];
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
   const body='这是用户先前授权的定时任务触发，不是新的真人消息。仅执行本次保存的任务与范围；群消息整理、每日清单及已有进展汇总由 Main 直接读取原群历史并核对已有任务状态与报告后完成，不委派 Worker 做整理；只有新增业务查询、日志排查或修复才按角色职责交给 agent_worker，使用指定 projectId。最终内容由渠道发为飞书卡片：概览后用 Markdown 表格呈现问题、提问者、状态、证据及下一步，并注明覆盖缺口。不输出卡片 JSON、不另发消息。正文控制在4000字以内、最多5个表格。相对时间以本次触发时刻和 timeZone 计算。整理昨天全天时，先将当地昨天00:00和今天00:00转为Unix秒，固定 start_time/end_time 调用 feishu_group_history，每页 limit=50，保持范围不变传回 next_page_token，直到 has_more=false；空页但 has_more=true 也要继续，按 message_id 去重，逐页提取问题及证据后合并，不能仅看最近50条或用旧摘要替代未读页。最新进展可另查今天00:00至本次触发时刻的同群消息，单独分页并与昨日问题关联，不把今天新问题混入昨日清单。只有全部页成功读完才能声明覆盖所选时间窗内机器人可见消息；读取失败、撤回、附件不可读等缺口必须说明。不得创建新的定时任务。\n'+JSON.stringify({scheduleId:request.id,occurrence:request.runKey,triggeredAt:new Date(request.runAtMs).toISOString(),timeZone:request.schedule?.tz??'Asia/Shanghai',trigger:request.trigger??'scheduled',triggerNote:request.trigger==='manual'?'管理员手动验收；本次时刻不代表计划延误，周期计划保持不变。':undefined,projectId:request.projectId,task:request.task,constraints:request.constraints})+'\n'+source.instruction();
   stage="context_creation";const ctxPayload=core.channel.reply.finalizeInboundContext({Body:body,BodyForAgent:body,RawBody:body,CommandBody:'',SessionKey:p.sessionKey,AccountId:p.accountId,From:'feishu:'+p.senderId,To:'chat:'+p.chatId,ChatType:'group',Provider:'feishu',Surface:'feishu',SenderId:p.senderId,OriginatingChannel:'feishu',OriginatingTo:'chat:'+p.chatId,MessageSid:messageId,CommandAuthorized:false});
   let deliveryError:unknown;
   try{
    assertCurrent();source.activate();
    stage="main_dispatch";await core.channel.inbound.run({channel:'feishu',accountId:p.accountId,raw:request,adapter:{ingest:()=>({id:messageId,rawText:body,textForAgent:body,textForCommands:'',raw:request}),resolveTurn:()=>({cfg,channel:'feishu',accountId:p.accountId,route:{agentId:p.agentId,sessionKey:p.sessionKey},ctxPayload,
     replyOptions:{abortSignal:signal,disableBlockStreaming:true,onAgentRunStart:()=>{assertCurrent();accepted=true;},turnAdoptionLifecycle:{onAdopted:()=>{},onDeferred:()=>false}},
     delivery:{deliver:async(payload,info)=>{if(info.kind!=='final'||payload.isReasoning||payload.isCommentary||!payload.text)return;
      try{assertCurrent();const card=workingResultCard(payload.text,account.config);assertFeishuCardWithinEnvelope(card);if(!withinCardTableLimit(payload.text))throw Error('Scheduled result exceeds the card table limit');const receipt=await sendCardFeishu({cfg,accountId:p.accountId,to:'chat:'+p.chatId,card,replyToMessageId:p.rootId??p.requestMessageIds?.at(-1),replyInThread:p.replyInThread??false});deliveryReceipts.push({messageId:receipt.messageId,chatId:p.chatId});}catch(error){deliveryError=error;throw error;}
     },onError:error=>{deliveryError=error;throw error;}}})}});
    if(deliveryError)throw deliveryError;jobIds=[...(lease.asyncJobIds??[])];if(jobIds.length)accepted=true;
   }finally{source.close();}
  }});
  return {accepted,jobIds,...(deliveryReceipts.length?{deliveryReceipts}:{})};
  }catch(error){throw Object.assign(new Error(error instanceof Error?error.message:String(error),{cause:error}),{scheduledStage:stage});}
 };
 return {capture,current,deliver};
}
export function registerScheduledRequestAdapter(api:OpenClawPluginApi){
 const implementation=createScheduledRequestAdapter(api.runtime);
 // Cross-plugin bridge calls arrive in agent-repo's instance scope. Enter the
 // channel owner's public lifecycle scope before using its named runtime store.
 const lifecycle=api.lifecycle as typeof api.lifecycle & {runInBackgroundContext?:<T>(run:()=>T)=>T};
 const adapter={...implementation,deliver:(request:Request,callbacks:Callbacks)=>lifecycle?.runInBackgroundContext?lifecycle.runInBackgroundContext(()=>implementation.deliver(request,callbacks)):implementation.deliver(request,callbacks)};
 api.registerService({id:'feishu-scheduled-requests',start:()=>{Object.assign(scheduledRequestBridge,adapter);},stop:()=>{for(const key of ['capture','current','deliver'] as const)if(scheduledRequestBridge[key]===adapter[key])delete scheduledRequestBridge[key];}});
}
