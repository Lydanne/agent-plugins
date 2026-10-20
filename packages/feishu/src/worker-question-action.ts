import {readQuestionCard,saveQuestionCard,claimQuestionAnswer,parseQuestionSubmission,renderQuestionCard,workerQuestionBridge,WORKER_QUESTION_CANCEL,type QuestionCard} from './worker-question.js';
import {editMessageFeishu,sendMessageFeishu} from './send.js';
import type {FeishuCardActionEvent} from './card-action.js';
import type {ClawdbotConfig} from '../runtime-api.js';
const inFlight=new Set<string>();
export async function handleWorkerQuestionAction(params:{cfg:ClawdbotConfig;accountId:string;event:FeishuCardActionEvent;stateDir:string}){
 const {cfg,accountId,event,stateDir}=params;
 const meta=event.action.value.m as Record<string,unknown>|undefined;
 const questionId=typeof meta?.questionId==='string'?meta.questionId:'';
 const card=readQuestionCard(stateDir,questionId);
 if(!card||card.provenance.accountId!==accountId||card.provenance.chatId!==event.context.chat_id||card.provenance.senderId!==event.operator.open_id||card.messageId!==(event.context.open_message_id??event.open_message_id))throw Error('Question card binding mismatch');
 if(card.question.expiresAt<=Date.now()||!workerQuestionBridge.authorize?.(card.provenance))throw Error('Question expired or task is no longer current');
 const key=stateDir+':'+questionId;if(inFlight.has(key))return;
 inFlight.add(key);
 let submitted:QuestionCard|undefined;
 let detached=false;
 try{
  const current=workerQuestionBridge.read?.({jobId:card.jobId,questionId,provenance:card.provenance});
  if(!current)throw Error('Worker question service unavailable');
  if(current.question.answer!==undefined){const accepted={...card,status:'accepted' as const};saveQuestionCard(stateDir,accepted);await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(accepted)});return;}
  if(current.status!=='awaiting_user'||current.question.questionId!==questionId)throw Error('本轮提问已失效');
  if(event.action.value.a===WORKER_QUESTION_CANCEL){
   const cancelled=workerQuestionBridge.cancel?.({jobId:card.jobId,questionId,provenance:card.provenance});
   if(cancelled?.status!=='cancelled')throw Error('任务尚未确认取消');
   const updated:QuestionCard={...card,status:'cancelled'};saveQuestionCard(stateDir,updated);
   await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(updated)});return;
  }
  if(card.status==='submitted'){
   if(meta?.retry!==true)throw Error('答案已保存，请等待或点击重试交回 Main');
   submitted=card;
  }else{
   const field=card.question.fields?.filter(f=>!Object.hasOwn(card.question.knownValues??{},f.id));
   const form=typeof meta?.option==='string'&&field?.length===1&&field[0].type==='single_select'?{[field[0].id]:meta.option}:event.action.form_value;
   const parsed=parseQuestionSubmission(card,form);
   submitted=claimQuestionAnswer(stateDir,card,parsed.answers,parsed.note);
  }
  if(!workerQuestionBridge.submit)throw Error('Main answer adapter unavailable');
  const accepted=submitted,submit=workerQuestionBridge.submit;
  // The provider callback must not wait for a model turn. Answers are already durable.
  detached=true;
  void (async()=>{
   try{
    try{await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(accepted)});}catch{console.warn('Answer saved; submitting card update failed');}
    await submit(accepted);
    const latest=readQuestionCard(stateDir,questionId)??accepted;
    await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(latest)});
   }catch{
    const latest=readQuestionCard(stateDir,questionId)??accepted;
    try{await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(latest,'答案已保存；暂未确认恢复，可重试交回 Main。')});}catch{console.warn('Saved answer recovery card update failed; answer retained');}
   }finally{inFlight.delete(key);}
  })();
 }catch(error){
  const message=error instanceof Error?error.message:'补充信息处理失败';
  if(submitted){
   const latest=readQuestionCard(stateDir,questionId)??submitted;
   try{await editMessageFeishu({cfg,accountId,messageId:card.messageId,card:renderQuestionCard(latest,'答案已保存；暂未确认恢复，可重试交回 Main。')});}catch{await sendMessageFeishu({cfg,accountId,to:'chat:'+card.provenance.chatId,replyToMessageId:card.messageId,text:'答案已保存，暂未确认任务恢复，请稍后重试。'});}
  }else{
   // Do not edit the form on validation errors: preserve the client's locally entered values.
   await sendMessageFeishu({cfg,accountId,to:'chat:'+card.provenance.chatId,replyToMessageId:card.messageId,text:message,replyInThread:card.provenance.replyInThread??false});
  }
 }finally{if(!detached)inFlight.delete(key);}
}
