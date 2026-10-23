import {isFeishuCardValidationRejection} from './api-response.js';
import {readQuestionCard,saveQuestionCard,canClaimQuestionAnswer,isSavedQuestionAnswer,findQuestionCardsForReply,claimQuestionAnswer,answerSummary,parseQuestionSubmission,renderQuestionCard,workerQuestionBridge,WORKER_QUESTION_CANCEL,WORKER_QUESTION_REOPEN,type QuestionCard,type QuestionTextReply} from './worker-question.js';
import {sendCardFeishu} from './send.js';
import {isTaskSourceRecalled} from './source-task.js';
import {editMessageFeishu,sendMessageFeishu} from './send.js';
import type {FeishuCardActionEvent} from './card-action.js';
import type {ClawdbotConfig} from '../runtime-api.js';
const inFlight=new Set<string>();
async function submitSavedAnswer(params:{cfg:ClawdbotConfig;accountId:string;stateDir:string;card:QuestionCard;submit:(card:QuestionCard)=>Promise<void>}){
 const {cfg,accountId,stateDir,card,submit}=params,questionId=card.question.questionId;
 try{
  try{await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(card)});}catch{console.warn('Answer saved; submitting card update failed');}
  await submit(card);
  const latest=readQuestionCard(stateDir,questionId)??card;
  await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(latest)});
 }catch{
  const latest=readQuestionCard(stateDir,questionId)??card;
  try{await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(latest,latest.supplementOf?'补充已保存；暂未确认接续，可重试补充。':'答案已保存；暂未确认恢复，可重试交回 Main。')});}catch{console.warn('Saved answer recovery card update failed; answer retained');}
 }finally{inFlight.delete(stateDir+':'+questionId);}
}

/** Only an authenticated direct reply to the requester's own question is an answer. */
export async function handleWorkerQuestionTextReply(params:QuestionTextReply&{stateDir:string}):Promise<boolean>{
 const {cfg,accountId,chatId,messageId,parentId,stateDir}=params;
 if(!parentId||!messageId||!params.text.trim())return false;
 const cards=findQuestionCardsForReply(stateDir,params);
 if(!cards.length)return false;
 if(isTaskSourceRecalled({accountId,chatId,messageId},stateDir))return true;
 if(cards.some(c=>c.answerMessageId===messageId))return true;
 const notice=async(text:string)=>{await sendMessageFeishu({cfg,accountId,to:'chat:'+chatId,replyToMessageId:messageId,replyInThread:cards[0].provenance.replyInThread??false,text});};
 const pending=cards.filter(c=>canClaimQuestionAnswer(c)&&c.question.expiresAt>Date.now());
 if(pending.length!==1){await notice(pending.length?'这张卡片关联多个待补充问题，请使用卡片内的对应提交按钮。':'本轮补充已提交或失效，请查看最新卡片。');return true;}
 const card=pending[0],questionId=card.question.questionId,key=stateDir+':'+questionId;
 if(inFlight.has(key))return true;
 inFlight.add(key);let detached=false;
 try{
  if(!workerQuestionBridge.authorize?.(card.provenance))throw Error('原任务已失效，不能继续接收本轮补充。');
  const current=workerQuestionBridge.read?.({jobId:card.jobId,questionId,provenance:card.provenance});
  if(!current||!workerQuestionBridge.submit)throw Error('补充服务暂不可用，请稍后重新回复这张卡片。');
  const late=current.question.resumeReason==='user_wait_timeout'&&current.question.answer!==undefined&&!['cancelled','failed','timed_out','unknown','cancelling'].includes(current.status);
  if((!late&&(current.status!=='awaiting_user'||current.question.answer!==undefined))||current.question.questionId!==questionId)throw Error('本轮补充已受理或失效，请查看最新卡片。');
  const note=params.text.trim(),answers={...card.question.knownValues};
  if((answerSummary(card.question,answers)+'\n补充说明：'+note).length>16000)throw Error('补充文字过长，请缩短后重新回复这张卡片。');
  renderQuestionCard({...card,status:'submitted',answers,note,answerSource:'user_text'});
  const submitted=claimQuestionAnswer(stateDir,card,answers,note,messageId);
  detached=true;
  void submitSavedAnswer({cfg,accountId,stateDir,card:submitted,submit:workerQuestionBridge.submit});
  return true;
 }catch(error){await notice(error instanceof Error?error.message:'补充信息暂未受理，请稍后重试。');return true;}
 finally{if(!detached)inFlight.delete(key);}
}
export async function handleWorkerQuestionAction(params:{cfg:ClawdbotConfig;accountId:string;event:FeishuCardActionEvent;stateDir:string}){
 const {cfg,accountId,event,stateDir}=params;
 const meta=event.action.value.m as Record<string,unknown>|undefined;
 const questionId=typeof meta?.questionId==='string'?meta.questionId:'';
 const card=readQuestionCard(stateDir,questionId);
 if(!card||card.provenance.accountId!==accountId||card.provenance.chatId!==event.context.chat_id||card.provenance.senderId!==event.operator.open_id||card.messageId!==(event.context.open_message_id??event.open_message_id))throw Error('Question card binding mismatch');
 if((card.question.expiresAt<=Date.now()&&!(meta?.retry===true&&isSavedQuestionAnswer(card)))||!workerQuestionBridge.authorize?.(card.provenance))throw Error('Question expired or task is no longer current');
 const key=stateDir+':'+questionId;if(inFlight.has(key))return;
 inFlight.add(key);
 let submitted:QuestionCard|undefined;
 let detached=false;
 try{
  const current=workerQuestionBridge.read?.({jobId:card.jobId,questionId,provenance:card.provenance});
  if(!current)throw Error('Worker question service unavailable');
  if(event.action.value.a===WORKER_QUESTION_REOPEN){
   if(!card.reopenAllowed||!workerQuestionBridge.reopen)throw Error('当前问题不能重新补充');
   const reopened=await workerQuestionBridge.reopen({jobId:card.jobId,questionId,provenance:card.provenance});
   let next=readQuestionCard(stateDir,reopened.question.questionId);
   if(next?.creationState==='uncertain')throw Error('补充卡片发送结果待核实，请勿重复创建');
   if(!next?.messageId){
    next={jobId:card.jobId,provenance:card.provenance,question:reopened.question,messageId:'',status:'waiting',supplementOf:questionId,creationState:'uncertain'};
    const rendered=renderQuestionCard(next);saveQuestionCard(stateDir,next);
    try{
     const receipt=await sendCardFeishu({cfg,accountId,to:'chat:'+card.provenance.chatId,replyToMessageId:card.messageId,replyInThread:card.provenance.replyInThread??false,card:rendered});
     next={...next,messageId:receipt.messageId,rendered:true};delete next.creationState;saveQuestionCard(stateDir,next);
    }catch(error){if(isFeishuCardValidationRejection(error)){next.creationState='retryable';saveQuestionCard(stateDir,next);}throw error;}
   }
   const updated={...card,reopenedQuestionId:next.question.questionId};saveQuestionCard(stateDir,updated);
   await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(updated)});return;
  }
  const late=current.question.resumeReason==='user_wait_timeout'&&current.question.answer!==undefined&&!['cancelled','failed','timed_out','unknown','cancelling'].includes(current.status);
  if(current.question.answer!==undefined&&!late){
   if(!isSavedQuestionAnswer(card))throw Error('本轮提问已处理，本次输入尚未受理，请查看最新卡片。');
   const accepted={...card,status:'accepted' as const};saveQuestionCard(stateDir,accepted);await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(accepted)});return;
  }
  if((current.status!=='awaiting_user'&&!late)||current.question.questionId!==questionId)throw Error('本轮提问已失效');
  if(card.status==='accepted'&&!canClaimQuestionAnswer(card)){await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(card)});return;}
  if(event.action.value.a===WORKER_QUESTION_CANCEL){
   const cancelled=workerQuestionBridge.cancel?.({jobId:card.jobId,questionId,provenance:card.provenance});
   if(cancelled?.status!=='cancelled')throw Error('任务尚未确认取消');
   const updated:QuestionCard={...card,status:'cancelled'};saveQuestionCard(stateDir,updated);
   await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(updated)});return;
  }
  if(card.status==='submitted'){
   if(meta?.retry!==true)throw Error(card.supplementOf?'补充已保存，请等待或点击重试补充':'答案已保存，请等待或点击重试交回 Main');
   submitted=card;
  }else{
   const field=card.question.fields?.filter(f=>!Object.hasOwn(card.question.knownValues??{},f.id));
   const form=typeof meta?.option==='string'&&field?.length===1&&field[0].type==='single_select'?{[field[0].id]:meta.option}:event.action.form_value;
   const parsed=parseQuestionSubmission(card,form);
   submitted=claimQuestionAnswer(stateDir,card,parsed.answers,parsed.note);
  }
  if(!workerQuestionBridge.submit)throw Error('Main answer adapter unavailable');
  // The provider callback must not wait for a model turn. Answers are already durable.
  detached=true;
  void submitSavedAnswer({cfg,accountId,stateDir,card:submitted,submit:workerQuestionBridge.submit});
 }catch(error){
  const message=error instanceof Error?error.message:'补充信息处理失败';
  if(submitted){
   const latest=readQuestionCard(stateDir,questionId)??submitted;
   try{await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(latest,latest.supplementOf?'补充已保存；暂未确认接续，可重试补充。':'答案已保存；暂未确认恢复，可重试交回 Main。')});}catch{await sendMessageFeishu({cfg,accountId,to:'chat:'+card.provenance.chatId,replyToMessageId:card.messageId,text:'答案已保存，暂未确认任务恢复，请稍后重试。'});}
  }else{
   // Do not edit the form on validation errors: preserve the client's locally entered values.
   await sendMessageFeishu({cfg,accountId,to:'chat:'+card.provenance.chatId,replyToMessageId:card.messageId,text:message,replyInThread:card.provenance.replyInThread??false});
  }
 }finally{if(!detached)inFlight.delete(key);}
}
