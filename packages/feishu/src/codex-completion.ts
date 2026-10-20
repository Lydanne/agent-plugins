import {completionPayloadForMain} from "./completion-payload.js";
import {urgentQuestion} from './question-urgent.js';
import {handleWorkerQuestionAction,handleWorkerQuestionTextReply} from './worker-question-action.js';
import {isFeishuCardValidationRejection} from './api-response.js';
import {workerQuestionBridge,readQuestionCard,listQuestionCards,saveQuestionCard,renderQuestionCard,answerSummary,questionAnswerSourceIds,type Question,type QuestionCard} from './worker-question.js';
import {FeishuWorkingCard} from './working-card.js';
import {continueAsyncTaskCard,sharesAsyncTaskCard} from './async-task-card.js';
import {recentlyMentioned} from './recent-outbound-mentions.js';
import {sendMediaFeishu} from "./media.js";
import {stageBackgroundDocument,activateBackgroundDocument} from "./document-background.js";
import {splitMessageImages,findLocalFileReferences,prepareFeishuDocumentDelivery,unavailableDocumentText} from "./document-delivery.js";
import {renderBusinessMessage} from "./business-config.js";
import {resolveFeishuRuntimeAccount} from "./accounts.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { ClawdbotConfig } from "../runtime-api.js";
import { isCompletionSourceCurrent, isTaskSourceRecalled, sourceTaskBridge } from "./source-task.js";
import { runFeishuWorkingTurn } from "./working-turn-queue.js";
import { editMessageFeishu, sendMessageFeishu, sendCardFeishu } from "./send.js";
import { bindAsyncTaskCard, acceptAsyncCardResult, prepareAsyncCardResult, readAsyncTaskCard, saveAsyncCardQuestion, acceptAsyncCardProgress, prepareAsyncOriginalOverview } from "./async-task-card.js";
import { workingResultCard } from "./working-card.js";
import {savePreparedCompletion,readPreparedCompletion,clearPreparedCompletion} from "./completion-outbox.js";
import {resolveFeishuSenderName} from "./bot-sender-name.js";
import {ColleagueProfiles} from "./colleague-profile.js";
import {buildDepartmentReplyStyleContext} from "./department-reply-style.js";
import {renderSection} from "./context-sections.js";

type Provenance = Parameters<typeof isCompletionSourceCurrent>[0] & {requestMessageIds: string[]; sessionId?: string; rootId?: string; replyInThread?: boolean};
export type CompletionEvent = {type: "agent_worker.completed" | "codex_query.completed" | "agent_worker.context_request"; eventId: string; jobId: string; topic: string;
 contextRequest?: Question;
 status: string; provenance: Provenance;
 request?: {availability: "available" | "unavailable"; task?: string; context?: string; constraints?: string; taskSummary?: string; reason?: string};
 reportContent: string; reportPaths: string[]; reports?: {path: string; content?: string; omittedReason?: string}[]; taskReport?: unknown; experienceReview?: unknown;
 createdAt?: number; startedAt?: number; finishedAt?: number};
type Callbacks = {signal?: AbortSignal; beforeSend: () => void; onReceipt: (receipt: unknown) => void};
type ContextCardState={jobId:string;questionId:string;provenance:Provenance;status:"awaiting_user"|"resumed";contextRequest?:Question};
type Bridge = {contextState?: (event:ContextCardState)=>Promise<{interactive:boolean}|void>;authorizeReply?: (provenance:Provenance)=>boolean; deliver?: (event: CompletionEvent, callbacks: Callbacks) => Promise<{suppressed?: boolean; reason?: string}>};
const symbol = Symbol.for("ada.codex-completion.v1");
const state = globalThis as typeof globalThis & {[symbol]?: Bridge};
const bridge = state[symbol] ??= {};

function isCompletionSourceAndAnswersCurrent(p:Provenance,stateDir:string):boolean{
 return isCompletionSourceCurrent(p,stateDir)&&questionAnswerSourceIds(p,stateDir).every(messageId=>!isTaskSourceRecalled({...p,messageId},stateDir));
}

/** Keep the full persisted report deliverable even if the model omitted its link. */
export function ensureCompletionReportLink(text:string,event:CompletionEvent):string {
 const available=event.reports?.filter(report=>typeof report.content==="string" && !report.omittedReason && event.reportPaths.includes(report.path)).map(report=>report.path) ?? [];
 const report=event.taskReport;
 if(report && typeof report==="object" && "storage" in report) {
  const storage=report.storage;
  if(storage && typeof storage==="object" && "state" in storage && storage.state==="written" && "path" in storage &&
   typeof storage.path==="string" && event.reportPaths.includes(storage.path))available.unshift(storage.path);
 }
 const paths=[...new Set(available)].filter(path=>path.startsWith("/") && !/[\r\n<>]/.test(path));
 if(!paths.length || findLocalFileReferences(text).some(ref=>paths.includes(ref.path)))return text;
 return text+`\n\n[完整报告](<${paths[0]}>)`;
}

/** Keep the original event and reports together with the verified submitted request. */
export function buildCodexCompletionText(event: CompletionEvent, recipientContext?: string): string {
 if(event.type==="agent_worker.context_request")return renderSection('AgentWorkerRequest', JSON.stringify(event));
 const payload = completionPayloadForMain(event,recipientContext);
 return renderSection('AgentWorkerResult', JSON.stringify(payload));
}

export async function deliverCodexCompletion(event: CompletionEvent, callbacks: Callbacks, core: OpenClawPluginApi["runtime"]) {
 const p = event.provenance;
 const questionTurn=event.type==="agent_worker.context_request";
 if(questionTurn && (event.status!=="awaiting_main"||!event.contextRequest||event.contextRequest.expiresAt<=Date.now()))return {suppressed:true,reason:"question_invalid"};
 if (!questionTurn && !["completed", "failed", "timed_out", "cancelled"].includes(event.status)) return {suppressed: true, reason: "job_not_terminal"};
 const stateDir = core.state.resolveStateDir();
 if (!p?.requestMessageIds?.length || !isCompletionSourceAndAnswersCurrent(p, stateDir)) return {suppressed: true, reason: "source_invalid"};
 const controller = new AbortController();
 const signal = callbacks.signal ? AbortSignal.any([controller.signal, callbacks.signal]) : controller.signal;
 const recalled = (e: {accountId: string; chatId: string; messageId: string}) => {
  if (e.accountId === p.accountId && e.chatId === p.chatId && (p.sourceMessageIds.includes(e.messageId)||questionAnswerSourceIds(p,stateDir).includes(e.messageId))) controller.abort();
 };
 sourceTaskBridge.recalls.add(recalled);
 let sent = false, suppressed = false, interrupted = false;
 try {
  await runFeishuWorkingTurn({key: JSON.stringify([p.accountId, p.sessionKey]), senderId: p.senderId, signal,
   prepare: async () => {}, cancel: async () => {interrupted = callbacks.signal?.aborted === true; suppressed = !interrupted;},
   run: async () => {
    if(questionTurn && event.contextRequest!.expiresAt<=Date.now()){suppressed=true;return;}
    if (!isCompletionSourceAndAnswersCurrent(p, stateDir) || signal.aborted) {suppressed = true; return;}
    const cfg = structuredClone(core.config.current()) as ClawdbotConfig;
    const account=resolveFeishuRuntimeAccount({cfg,accountId:p.accountId});
    const accountConfig=account.config;
    const businessMessages=accountConfig.businessMessages;
    const agentId = /^agent:([^:]+):/.exec(p.sessionKey)?.[1];
    if (!agentId) throw Error("Completion session has no agent owner");
    const currentSessionId = () => {
     const storePath = core.agent.session.resolveStorePath(cfg.session?.store, {agentId});
     const entry = core.agent.session.getSessionEntry({storePath,agentId,sessionKey:p.sessionKey,readConsistency:"latest"});
     return entry?.sessionId;
    };
    const sessionCurrent = () => !p.sessionId || currentSessionId() === p.sessionId;
    if (!sessionCurrent()) {suppressed = true; return;}
    const messageId = p.requestMessageIds.at(-1)!;
    let text = buildCodexCompletionText(event);
    const contextPayload = () => core.channel.reply.finalizeInboundContext({Body: text, BodyForAgent: text,
     RawBody: text, CommandBody: "", SessionKey: p.sessionKey, AccountId: p.accountId,
     From: "feishu:" + p.senderId, To: "chat:" + p.chatId, ChatType: "group", Provider: "feishu", Surface: "feishu",
     SenderId: p.senderId, OriginatingChannel: "feishu", OriginatingTo: "chat:" + p.chatId,
     MessageSid: event.eventId, CommandAuthorized: false});
    // This shares the exact FIFO used by human turns. No steer or interrupt mode.
    const completionCfg = {...cfg, messages: {...cfg.messages, queue: {...cfg.messages?.queue, mode: "followup" as const}}};
    let deliveryError: unknown;
    const deliverResult = async (payload: {text?: string; isReasoning?: boolean; isCommentary?: boolean; mediaUrl?: string; mediaUrls?: string[]}, info: {kind: string}) => {
     // Host dispatch may swallow a delivery failure and subsequently deliver a fallback.
     // Neither that fallback nor a partial/status reply is an accepted task report.
     if (deliveryError) throw deliveryError;
     if (sent || info.kind !== "final" || payload.isReasoning || payload.isCommentary || !payload.text) return;
     if (payload.text.startsWith("⚠️ OpenClaw couldn't produce or deliver a reply.")) throw Error("Codex completion received the host's no-visible-reply fallback");
     if (!isCompletionSourceAndAnswersCurrent(p, stateDir) || !sessionCurrent() || signal.aborted) {suppressed = true; return;}
     if(questionTurn){
      const question=readQuestionCard(stateDir,event.contextRequest!.questionId);
      // The requester can submit while Main is still finishing this turn.
      // The rendered card owns the question in every subsequent state; stale
      // Main prose must not repeat it or replace the continuation binding.
      if(question?.rendered && question.jobId===event.jobId && question.messageId){
       callbacks.onReceipt({messageId:question.messageId});sent=true;
       return {visibleReplySent:true,messageIds:[question.messageId],content:''};
      }
      callbacks.beforeSend();
      const questionBinding=readAsyncTaskCard(stateDir,event.jobId,p);
      const receipt=await sendMessageFeishu({cfg:completionCfg,accountId:p.accountId,to:"chat:"+p.chatId,replyToMessageId:questionBinding?.messageId??messageId,text:payload.text,replyInThread:p.replyInThread??false});
      saveAsyncCardQuestion(stateDir,p,event.jobId,receipt.messageId);
      callbacks.onReceipt(receipt);sent=true;return {visibleReplySent:true,messageIds:[receipt.messageId],content:payload.text};
     }
     const finalText=ensureCompletionReportLink(payload.text,event);
     const sessionId=currentSessionId();
     if(sessionId)savePreparedCompletion(stateDir,event,sessionId,{text:finalText,mediaUrl:payload.mediaUrl,mediaUrls:payload.mediaUrls});
     const binding = readAsyncTaskCard(stateDir, event.jobId, p);
     const existingResult=binding?prepareAsyncCardResult(stateDir,binding,finalText,accountConfig):undefined;
     const canStage=!existingResult || (existingResult.fits && Buffer.byteLength(existingResult.combined,"utf8")<20000);
     let staged,stagingFailed=false;
     try {
      staged=canStage ? await stageBackgroundDocument({cfg:completionCfg,accountId:p.accountId,agentId,stateDir,source:p,sessionId,completionJobId:event.jobId,to:"chat:"+p.chatId,text:finalText,
       mediaUrls:[...(payload.mediaUrls ?? []),...(payload.mediaUrl?[payload.mediaUrl]:[])],signal}) : undefined;
     } catch {signal.throwIfAborted();stagingFailed=true;}
     const document=staged ? {text:staged.text} : stagingFailed ? {text:unavailableDocumentText(finalText,cfg.agents?.defaults?.workspace)} : await prepareFeishuDocumentDelivery({cfg:completionCfg,accountId:p.accountId,agentId,mediaRuntime:core.media,to:"chat:"+p.chatId,text:finalText,
      mediaUrls:[...(payload.mediaUrls ?? []),...(payload.mediaUrl?[payload.mediaUrl]:[])],signal});
     if (!isCompletionSourceAndAnswersCurrent(p,stateDir) || !sessionCurrent() || signal.aborted) {suppressed=true;return;}
     const deliveryText=document?.text ?? finalText;
     let receipt;
     let resultMentionsRequester = false;
     if (binding) {
      const result = prepareAsyncCardResult(stateDir, binding, deliveryText, accountConfig);
      // Do not send a duplicate result if an edit has an uncertain outcome.
      // Completion service records this attempt as uncertain for inspection.
      callbacks.beforeSend();
      receipt = await editMessageFeishu({cfg: completionCfg, accountId: p.accountId, messageId: binding.messageId,
       mentionScope:{accountId:p.accountId,to:"chat:"+p.chatId,replyInThread:p.replyInThread,replyToMessageId:p.rootId ?? p.requestMessageIds[0]},
       card: result.fits ? result.card : workingResultCard(renderBusinessMessage(businessMessages,"asyncOversizedResult"),accountConfig)});
      resultMentionsRequester = receipt.mentionedUserIds?.includes(p.senderId) ?? false;
      if (!result.fits) {
       const limit = core.channel.text.resolveTextChunkLimit(completionCfg, "feishu", p.accountId, {fallbackLimit: 4000});
       const mode = core.channel.text.resolveChunkMode(completionCfg, "feishu", p.accountId);
       const chunks = core.channel.text.chunkMarkdownTextWithMode(result.combined, limit, mode);
       let firstReceipt;
       for (const chunk of chunks) {
        if (!isCompletionSourceAndAnswersCurrent(p, stateDir) || !sessionCurrent() || signal.aborted) {suppressed = true; return;}
        const chunkReceipt = await sendMessageFeishu({cfg: completionCfg, accountId: p.accountId, to: "chat:" + p.chatId,
         replyToMessageId: binding.messageId, text: chunk, replyInThread: p.replyInThread ?? false});
        resultMentionsRequester ||= chunkReceipt.mentionedUserIds?.includes(p.senderId) ?? false;
        firstReceipt ??= chunkReceipt;
       }
       if (firstReceipt) receipt = firstReceipt;
      }
      acceptAsyncCardResult(stateDir, binding, deliveryText);
     } else if(staged) {
      callbacks.beforeSend();
      receipt=await sendCardFeishu({cfg:completionCfg,accountId:p.accountId,to:"chat:"+p.chatId,replyToMessageId:messageId,replyInThread:p.replyInThread ?? false,
       card:workingResultCard(`<at id="${p.senderId}"></at>${renderBusinessMessage(businessMessages,"mentionSuffix")}\n`+deliveryText,accountConfig)});
     } else {
      callbacks.beforeSend();
      receipt = await sendMessageFeishu({cfg: completionCfg, accountId: p.accountId, to: "chat:" + p.chatId,
       replyToMessageId: messageId, text: `<at id="${p.senderId}"></at>${renderBusinessMessage(businessMessages,"mentionSuffix")}\n` + deliveryText, replyInThread: p.replyInThread ?? false});
     }
     if(staged) {
      if(binding)activateBackgroundDocument(stateDir,staged,receipt.messageId,false);
      else activateBackgroundDocument(stateDir,staged,receipt.messageId,true,`<at id="${p.senderId}"></at>${renderBusinessMessage(businessMessages,"mentionSuffix")}\n`);
     }
     for(const mediaUrl of document && "mediaUrls" in document ? document.mediaUrls ?? [] : splitMessageImages(finalText,[...(payload.mediaUrls ?? []),...(payload.mediaUrl?[payload.mediaUrl]:[])],cfg.agents?.defaults?.workspace).images) {
      if(!isCompletionSourceAndAnswersCurrent(p,stateDir) || !sessionCurrent() || signal.aborted){suppressed=true;return;}
      await sendMediaFeishu({cfg:completionCfg,mediaRuntime:core.media,accountId:p.accountId,to:"chat:"+p.chatId,replyToMessageId:receipt.messageId,replyInThread:p.replyInThread ?? false,mediaUrl});
     }
     callbacks.onReceipt(receipt); sent = true;
     clearPreparedCompletion(stateDir,event);
     if(binding?.originalMessageId && !listQuestionCards(stateDir).some(card=>card.jobId===event.jobId&&card.messageId===binding.originalMessageId&&card.provenance.accountId===p.accountId&&card.provenance.sessionKey===p.sessionKey) && isCompletionSourceAndAnswersCurrent(p,stateDir) && sessionCurrent() && !signal.aborted){
      try {
       const overview=prepareAsyncOriginalOverview(stateDir,binding,event.status,accountConfig);
       if(overview)await editMessageFeishu({cfg:completionCfg,accountId:p.accountId,messageId:binding.originalMessageId,card:overview});
      }catch{console.warn("Worker result accepted, but initial overview status update failed; latest result remains authoritative");}
     }
     if (binding && isCompletionSourceAndAnswersCurrent(p, stateDir) && sessionCurrent() && !signal.aborted &&
      (!resultMentionsRequester && (binding.imageKey || !recentlyMentioned({accountId:p.accountId,to:'chat:'+p.chatId,replyInThread:p.replyInThread,replyToMessageId:receipt.messageId},p.senderId)))) {
      try {
       await sendMessageFeishu({cfg: completionCfg, accountId: p.accountId, to: "chat:" + p.chatId,
        replyToMessageId: receipt.messageId, replyInThread: p.replyInThread ?? false,
        mentions: [{openId: p.senderId, name: "", key: ""}], plainText: true,
        text: renderBusinessMessage(businessMessages,event.status==="timed_out"?"timeoutMention":event.status==="failed"?"failureMention":event.status==="cancelled"?"cancelledMention":"completionMention")});
      } catch {console.warn("Codex result accepted, but completion mention failed or is unconfirmed");}
     }
     return {visibleReplySent: true, messageIds: [receipt.messageId], content: deliveryText};
    };
    const deliver: typeof deliverResult = async (payload, info) => {
     try {return await deliverResult(payload, info);} catch (error) {deliveryError ??= error; throw error;}
    };
    const sessionId=currentSessionId(),prepared=sessionId ? readPreparedCompletion(stateDir,event,sessionId) : undefined;
    if(prepared){await deliver(prepared,{kind:"final"});return;}
    let directory: Awaited<ReturnType<typeof resolveFeishuSenderName>> = {};
    try {directory=await resolveFeishuSenderName({account,senderId:p.senderId,log:()=>{}});} catch {}
    let profileContext: string;
    try {
     profileContext=new ColleagueProfiles(accountConfig.colleagueProfile?.storagePath ?? stateDir+'/feishu-colleagues/preferences.sqlite',accountConfig.colleagueProfile)
      .context({accountId:p.accountId,appId:account.appId,senderOpenId:p.senderId,...directory,text:""},{readOnly:true});
    } catch {
     profileContext=renderSection('ParticipantProfileUnavailable',JSON.stringify({status:'unavailable'}));
    }
    const recipientContext=profileContext+buildDepartmentReplyStyleContext({senderOpenId:p.senderId,
     departments:directory.departments,rules:accountConfig.departmentReplyStyles});
    text=buildCodexCompletionText(event,recipientContext);
    if (!isCompletionSourceAndAnswersCurrent(p,stateDir) || !sessionCurrent() || signal.aborted) {suppressed=true;return;}
    const ctxPayload=contextPayload();
    let mainStarted=false;
    await core.channel.inbound.run({channel: "feishu", accountId: p.accountId, raw: event, adapter: {
     ingest: () => ({id: event.eventId, rawText: text, textForAgent: text, textForCommands: "", raw: event}),
     resolveTurn: () => ({cfg: completionCfg, channel: "feishu", accountId: p.accountId,
      route: {agentId, sessionKey: p.sessionKey}, ctxPayload,
      // A queued/rejected inbound call has not run Main. Quarantine only once
      // the agent can act (or deliverResult starts a visible send), so a drain
      // rejection before admission remains retryable without replaying a turn.
      replyOptions: {abortSignal: signal, disableBlockStreaming: true,
       onAgentRunStart: () => {if(questionTurn&&!sent){callbacks.beforeSend();mainStarted=true;}},
       // Keep durable retry ownership here instead of leaving callbacks in a
       // host followup queue that can outlive this plugin service generation.
       ...(questionTurn?{turnAdoptionLifecycle:{onAdopted:()=>{},onDeferred:()=>false}}:{})},
      delivery: {deliver, onError: error => {deliveryError ??= error; throw error;}}}),
    }});
    if (deliveryError) throw deliveryError;
    if(questionTurn&&mainStarted&&!sent&&!suppressed&&!signal.aborted){callbacks.onReceipt({kind:"main_context_turn",eventId:event.eventId});sent=true;}
   }});
  return {suppressed, ...(interrupted ? {reason:"service_stopped"} : {}), ...(!sent && !suppressed && !interrupted ? {reason: "no_delivery_receipt"} : {})};
 } finally {sourceTaskBridge.recalls.delete(recalled);}
}

export function registerCodexCompletion(api: OpenClawPluginApi) {
 // Cross-plugin bridge calls inherit the caller's SDK instance scope. Bind the
 // owner's public runtime instead of resolving a named runtime slot on delivery.
 const runtime = api.runtime;
 const deliver: NonNullable<Bridge["deliver"]> = (event, callbacks) => deliverCodexCompletion(event, callbacks, runtime);
 const authorizeReply: NonNullable<Bridge["authorizeReply"]> = p => {
  if(!isCompletionSourceAndAnswersCurrent(p,runtime.state.resolveStateDir()))return false;
  const agentId=/^agent:([^:]+):/.exec(p.sessionKey)?.[1];if(!agentId)return false;
  const cfg=runtime.config.current();const storePath=runtime.agent.session.resolveStorePath(cfg.session?.store,{agentId});
  return !p.sessionId||runtime.agent.session.getSessionEntry({storePath,agentId,sessionKey:p.sessionKey,readConsistency:"latest"})?.sessionId===p.sessionId;
 };
 const contextState:NonNullable<Bridge["contextState"]>=async event=>{
  const p=event.provenance;if(!authorizeReply(p))return;
  const stateDir=runtime.state.resolveStateDir();
  const active=sourceTaskBridge.leases.get(JSON.stringify([p.accountId,p.sessionKey]));
  const liveTarget=event.status==='awaiting_user' && active && !active.signal.aborted && active.chatId===p.chatId && active.senderId===p.senderId
   ? active.questionCardTarget?.()?.messageId : undefined;
  let binding=readAsyncTaskCard(stateDir,event.jobId,p);
  if(!binding && liveTarget && event.contextRequest){
   bindAsyncTaskCard(stateDir,p,[event.jobId],{messageId:liveTarget});binding=readAsyncTaskCard(stateDir,event.jobId,p);
  }
  if(!binding || binding.result!==undefined)return;
  const existing=readQuestionCard(stateDir,event.questionId);
  if(event.status==='resumed' && existing && existing.status!=='accepted'){
   const latest=workerQuestionBridge.read?.({jobId:event.jobId,questionId:event.questionId,provenance:p});
   const accepted:QuestionCard={...existing,status:'accepted',note:existing.note??latest?.question.answer};
   saveQuestionCard(stateDir,accepted);
   try{await editMessageFeishu({cfg:runtime.config.current() as ClawdbotConfig,accountId:p.accountId,messageId:accepted.messageId,card:renderQuestionCard(accepted)});}catch{console.warn('Question answer accepted; history card update failed');}
  }
  if(event.status==='awaiting_user' && event.contextRequest){
   const cfg=runtime.config.current() as ClawdbotConfig;
   const shared=sharesAsyncTaskCard(stateDir,binding);
   // A -> question/answer, B -> work/question/result. Unrelated Main turns cannot steal this task's card.
   const target=shared?liveTarget:binding.messageId;
   if(existing && (existing.status!=='waiting'||existing.jobId!==event.jobId))return {interactive:false};
   const buzz=(card:QuestionCard)=>urgentQuestion({cfg,stateDir,card,authorize:()=>authorizeReply(p),log:message=>api.logger.warn(message)});
   if(existing?.rendered && (!target || target===existing.messageId)){await buzz(existing);return {interactive:true};}
   // Legacy records without an ID also represent an unknown send outcome.
   if(existing && !existing.messageId && existing.creationState!=='retryable')return {interactive:false};
   const previousMessageId=existing?.rendered?existing.messageId:undefined;
   const card:QuestionCard=existing?{...existing,messageId:target??existing.messageId,rendered:false}:{jobId:event.jobId,provenance:p,question:event.contextRequest,messageId:target??binding.messageId,status:'waiting'};
   if(shared&&!existing&&!target)card.messageId='';
   // Validate locally before reserving a send: render failure cannot create a card.
   const rendered=renderQuestionCard(card);
   if(!card.messageId)card.creationState='uncertain';
   saveQuestionCard(stateDir,card);
   if(!card.messageId){
    try{
     const sent=await sendCardFeishu({cfg,accountId:p.accountId,to:'chat:'+p.chatId,replyToMessageId:binding.messageId,replyInThread:p.replyInThread??false,card:rendered});
     card.messageId=sent.messageId;
     delete card.creationState;
    }catch(error){
     if(isFeishuCardValidationRejection(error)){card.creationState='retryable';saveQuestionCard(stateDir,card);}
     throw error;
    }
   }else await editMessageFeishu({cfg,accountId:p.accountId,messageId:card.messageId,card:rendered});
   card.rendered=true;saveQuestionCard(stateDir,card);saveAsyncCardQuestion(stateDir,p,event.jobId,card.messageId);
   if(previousMessageId && previousMessageId!==card.messageId){
    try{await editMessageFeishu({cfg,accountId:p.accountId,messageId:previousMessageId,card:workingResultCard('提问已移至最新工作消息，请在最新卡片填写并提交。')});}
    catch{console.warn('Question moved to current working card; old card cleanup failed');}
   }
   acceptAsyncCardProgress(stateDir,binding,'等待用户在交互卡片中补充信息。');
   await buzz(card);
   return {interactive:true};
  }
  if(event.status==='resumed' && existing?.messageId===binding.messageId)return;
  const progress=event.status==="awaiting_user"?"等待用户补充信息，请回复新的提问消息。":"已收到补充，原任务继续处理。";
  if(binding.progress===progress)return;
  // The continuation is already a working GIF. A nonterminal resume event
  // updates internal progress only; rendering it as a result would remove it.
  if(event.status==='resumed' && existing && existing.messageId!==binding.messageId && binding.imageKey){
   acceptAsyncCardProgress(stateDir,binding,progress);return;
  }
  const cfg=runtime.config.current() as ClawdbotConfig,account=resolveFeishuRuntimeAccount({cfg,accountId:p.accountId});
  const result=prepareAsyncCardResult(stateDir,{...binding,progress},progress,account.config);
  if(!authorizeReply(p))return;
  await editMessageFeishu({cfg,accountId:p.accountId,messageId:binding.messageId,card:result.card});
  acceptAsyncCardProgress(stateDir,binding,progress);
 };
 const submit:NonNullable<typeof workerQuestionBridge.submit>=async card=>{
  const p=card.provenance;
  await runFeishuWorkingTurn({key:JSON.stringify([p.accountId,p.sessionKey]),senderId:p.senderId,prepare:async()=>{},cancel:async()=>{throw Error('Answer turn cancelled');},run:async()=>{
   if(!authorizeReply(p))throw Error('Original task authorization is no longer current');
   const current=workerQuestionBridge.read?.({jobId:card.jobId,questionId:card.question.questionId,provenance:p});
   if(current?.question.answer!==undefined){saveQuestionCard(runtime.state.resolveStateDir(),{...card,status:'accepted'});return;}
   if(current?.status!=='awaiting_user')throw Error('Question is no longer awaiting user');
   const cfg=runtime.config.current() as ClawdbotConfig,stateDir=runtime.state.resolveStateDir();
   const account=resolveFeishuRuntimeAccount({cfg,accountId:p.accountId});
   const working=new FeishuWorkingCard({cfg,accountId:p.accountId,to:'chat:'+p.chatId,replyToMessageId:card.messageId,replyInThread:p.replyInThread??false,requester:{openId:p.senderId,name:'',key:''},log:message=>api.logger.warn(message)});
   if(!card.workingMessageId){
    if(card.workingAttempted)throw Error('Continuation card create was unconfirmed; manual inspection required');
    card={...card,workingAttempted:true};saveQuestionCard(stateDir,card);
    await working.start();const held=await working.holdForBackground();
    if(!held){
     // Upload/preparation failure proves no message was dispatched. Transport
     // uncertainty keeps the durable attempt marker to prevent duplicate cards.
     if(working.placeholderCreationState()==='not_sent'){card={...card,workingAttempted:false};saveQuestionCard(stateDir,card);}
     throw Error('Unable to create continuation card');
    }
    if(!continueAsyncTaskCard(stateDir,p,card.jobId,card.question.questionId,held))throw Error('Continuation binding rejected');
    card={...card,workingMessageId:held.messageId};saveQuestionCard(stateDir,card);
   }
   card={...card,dispatchAttempts:(card.dispatchAttempts??0)+1};saveQuestionCard(stateDir,card);
   const answerEventId='worker-answer:'+card.question.questionId+':'+card.dispatchAttempts;
   const answer=answerSummary(card.question,card.answers??{})+(card.note?'\n补充说明：'+card.note:'');
   const text=renderSection('FeishuAnswer', JSON.stringify({jobId:card.jobId,questionId:card.question.questionId,answers:card.answers,answer,question:card.question,...(card.answerSource==='user_text'?{answerSource:'user_text',answerMessageId:card.answerMessageId}:{})}));
   const answerCfg={...cfg,messages:{...cfg.messages,queue:{...cfg.messages?.queue,mode:'followup' as const}}};
   const agentId=/^agent:([^:]+):/.exec(p.sessionKey)?.[1];if(!agentId)throw Error('Main session owner missing');
   const ctxPayload=runtime.channel.reply.finalizeInboundContext({Body:text,BodyForAgent:text,RawBody:text,CommandBody:'',SessionKey:p.sessionKey,AccountId:p.accountId,From:'feishu:'+p.senderId,To:'chat:'+p.chatId,ChatType:'group',Provider:'feishu',Surface:'feishu',SenderId:p.senderId,OriginatingChannel:'feishu',OriginatingTo:'chat:'+p.chatId,MessageSid:answerEventId,CommandAuthorized:false});
   let clarification:string|undefined;
   // The new working card is the acknowledgement; only the eventual Worker result is user-facing.
   await runtime.channel.inbound.run({channel:'feishu',accountId:p.accountId,raw:card,adapter:{ingest:()=>({id:answerEventId,rawText:text,textForAgent:text,textForCommands:'',raw:card}),resolveTurn:()=>({cfg:answerCfg,channel:'feishu',accountId:p.accountId,route:{agentId,sessionKey:p.sessionKey},ctxPayload,replyOptions:{disableBlockStreaming:true},delivery:{deliver:async(payload,info)=>{if(info.kind==='final'&&!payload.isReasoning&&!payload.isCommentary&&payload.text)clarification=payload.text;}}})}});
   const after=workerQuestionBridge.read?.({jobId:card.jobId,questionId:card.question.questionId,provenance:p});
   if(after?.question.answer===undefined&&after?.status==='awaiting_user'&&card.answerSource==='user_text'){
    const latest=readQuestionCard(stateDir,card.question.questionId)??card;
    saveQuestionCard(stateDir,{...latest,status:'waiting',question:after.question,validationNote:clarification?.slice(0,2000)??'这条文字补充还不足以继续，请填写卡片中的必要信息或重新回复。'});
    return;
   }
   if(after?.question.answer===undefined)throw Error('Main has not accepted the answer; saved for retry');
   const latest=readQuestionCard(stateDir,card.question.questionId)??card;saveQuestionCard(stateDir,{...latest,status:'accepted'});
  }});
 };
 const submission:NonNullable<typeof workerQuestionBridge.submission>=params=>{
  const card=readQuestionCard(runtime.state.resolveStateDir(),params.questionId);
  if(!card||card.jobId!==params.jobId||!card.answers||!['submitted','accepted'].includes(card.status)||!authorizeReply(params.provenance)||['taskId','revision','accountId','chatId','sessionKey','senderId'].some(key=>card.provenance[key as keyof typeof card.provenance]!==params.provenance[key as keyof typeof params.provenance]))return;
  return card.answerSource==='user_text'?{answerSource:'user_text',answerMessageId:card.answerMessageId,userSubmittedAt:card.submittedAt}:{answerValues:card.answers,answerSource:'user_card',userSubmittedAt:card.submittedAt};
 };
 const action:NonNullable<typeof workerQuestionBridge.action>=params=>handleWorkerQuestionAction({...params,stateDir:runtime.state.resolveStateDir()});
 const textReply:NonNullable<typeof workerQuestionBridge.textReply>=params=>handleWorkerQuestionTextReply({...params,stateDir:runtime.state.resolveStateDir()});
 api.registerService({id: "feishu-codex-completion", start: async () => {workerQuestionBridge.submission=submission;workerQuestionBridge.action=action;workerQuestionBridge.textReply=textReply;workerQuestionBridge.submit=submit;workerQuestionBridge.authorize=authorizeReply;bridge.deliver = deliver;bridge.authorizeReply=authorizeReply;bridge.contextState=contextState;
   // Restore visible retry controls without replaying an uncertain Main turn or card create.
   for(const card of listQuestionCards(runtime.state.resolveStateDir())){
    if(card.status!=='submitted'||!card.messageId||!authorizeReply(card.provenance)||card.question.expiresAt<=Date.now())continue;
    try{
     const current=workerQuestionBridge.read?.({jobId:card.jobId,questionId:card.question.questionId,provenance:card.provenance});
     const restored:QuestionCard=current?.question.answer!==undefined?{...card,status:'accepted'}:card;
     saveQuestionCard(runtime.state.resolveStateDir(),restored);
     await editMessageFeishu({cfg:runtime.config.current() as ClawdbotConfig,accountId:card.provenance.accountId,messageId:card.messageId,card:renderQuestionCard(restored,restored.status==='submitted'?'答案已保存，可重试交回 Main。':undefined)});
    }catch{console.warn('Pending question recovery failed; saved answer retained');}
   }
  },
  stop: () => {if(workerQuestionBridge.submission===submission)workerQuestionBridge.submission=undefined;if(workerQuestionBridge.action===action)workerQuestionBridge.action=undefined;if(workerQuestionBridge.textReply===textReply)workerQuestionBridge.textReply=undefined;if(workerQuestionBridge.submit===submit)workerQuestionBridge.submit=undefined;if(workerQuestionBridge.authorize===authorizeReply)workerQuestionBridge.authorize=undefined;if (bridge.deliver === deliver) bridge.deliver = undefined;if(bridge.authorizeReply===authorizeReply)bridge.authorizeReply=undefined;if(bridge.contextState===contextState)bridge.contextState=undefined;}});
}
