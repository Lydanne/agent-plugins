import {savedBeforeDeadline} from './jobs.mjs';
/** Read pending questions through the worker-owned state, never callback-supplied job data. */
export function registerQuestionBridge(api,jobs,completionBridge){
 const bridge=globalThis[Symbol.for('ada.worker-question.v1')]??={};
 const contributorRead=({jobId,requestId,provenance})=>{
  const result=jobs.contributorRequest(jobId,provenance.sessionKey,requestId);
  if(['taskId','revision','senderId','accountId','chatId','sessionKey'].some(key=>result.job.provenance?.[key]!==provenance[key]))throw Error('Contributor request source mismatch');
  return result;
 };
 const contributorDecide=async params=>{
  const {job}=contributorRead(params),authorize=p=>completionBridge.authorizeReply?.(p)===true;
  const request=await jobs.decideContributor(job.jobId,params.provenance.sessionKey,params.requestId,params.actor,params.mode,authorize);
  let resumed;
  try{resumed=await jobs.reply(job.jobId,params.provenance.sessionKey,request.questionId,request.answer,{senderId:request.source.senderId,accountId:request.source.accountId},authorize,false,undefined,{answerSource:'main_context',attachmentSource:request.source,contributorApprovalId:request.requestId});}
  catch{
   const latest=jobs.status(job.jobId,params.provenance.sessionKey),q=latest.questions?.find(q=>q.questionId===request.questionId);
   if(q?.resumeReason==='user_wait_timeout'){
    const supplement=await jobs.openSupplement(job.jobId,params.provenance.sessionKey,request.questionId,authorize,{userSubmittedAt:request.createdAt});
    await jobs.submitSupplement(job.jobId,params.provenance.sessionKey,supplement.supplementId,request.answer,{answerSource:'main_context',userSubmittedAt:request.createdAt,attachmentSource:request.source,contributorApprovalId:request.requestId},authorize);
    return {mode:request.mode,resumed:false,queued:true};
   }
   return {mode:request.mode,resumed:false};
  }
  await contextPresentation(completionBridge.contextState,{jobId:job.jobId,questionId:request.questionId,provenance:resumed.provenance,status:'resumed'});
  return {mode:request.mode,resumed:true};
 };
 const verify=({jobId,questionId,provenance},{allowSaved=false}={})=>{
  const job=jobs.status(jobId,provenance.sessionKey);
  if(['taskId','revision','senderId','accountId','chatId','sessionKey'].some(key=>job.provenance?.[key]!==provenance[key])||!completionBridge.authorizeReply?.(job.provenance))throw Error('Task source is no longer current');
  const supplement=jobs.supplement?.(jobId,provenance.sessionKey,questionId);
  const question=supplement?.question??(job.questions??[]).find(q=>q.questionId===questionId);
  const submission=allowSaved?bridge.submission?.({jobId,questionId,provenance}):undefined;
  const saved=question&&submission&&savedBeforeDeadline(question,submission.userSubmittedAt);
  if(!question||question.expiresAt<=Date.now()&&!(allowSaved&&(saved||supplement?.answer!==undefined)))throw Error('Question expired');
  return {job,question,supplement,submission,saved};
 };
 const read=params=>{const {job,question,supplement}=verify(params,{allowSaved:true});return {status:supplement?(supplement.status==='waiting'?'awaiting_user':supplement.status):job.status==='awaiting_main'&&job.contextRequest?.timeoutRequestedAt?'awaiting_user':job.status,question:supplement?.answer?{...question,answer:supplement.answer}:question,latestQuestionId:supplement?question.questionId:job.questions?.at(-1)?.questionId};};
 const cancel=params=>{
  const {job,question}=verify(params);
  if(!(job.status==='awaiting_user'||job.status==='awaiting_main'&&job.contextRequest?.timeoutRequestedAt)||question.answer!==undefined||job.contextRequest?.questionId!==params.questionId)throw Error('Question is no longer awaiting user');
  return jobs.cancel(job.jobId,params.provenance.sessionKey,{senderId:params.provenance.senderId,accountId:params.provenance.accountId});
 };
 const reopen=async params=>{verify(params);return jobs.openSupplement(params.jobId,params.provenance.sessionKey,params.questionId,p=>completionBridge.authorizeReply?.(p)===true);};
 const supplement=async params=>{verify(params);return jobs.submitSupplement(params.jobId,params.provenance.sessionKey,params.questionId,params.answer,params,p=>completionBridge.authorizeReply?.(p)===true);};
 // Read the durable Feishu receipt ourselves. Callback arguments cannot replace
 // its answer, source, or admission time, including on retries after expiry.
 const acceptSubmission=async params=>{
  const {job,question,supplement:existing,submission,saved}=verify(params,{allowSaved:true});
  if(!saved||!['user_card','user_text'].includes(submission.answerSource)||typeof submission.answerText!=='string')throw Error('No trusted saved submission');
  if(!existing&&question.resumeReason!=='user_wait_timeout')throw Error('Question is not a late answer');
  if(!existing&&question.userSubmittedAt===submission.userSubmittedAt&&question.answerMessageId===submission.answerMessageId)return {alreadyApplied:true};
  const authorize=p=>completionBridge.authorizeReply?.(p)===true;
  const record=existing??await jobs.openSupplement(job.jobId,params.provenance.sessionKey,question.questionId,authorize,{userSubmittedAt:submission.userSubmittedAt});
  return jobs.submitSupplement(job.jobId,params.provenance.sessionKey,record.supplementId,submission.answerText,submission,authorize);
 };
 api.registerService({id:'agent-worker-questions',start:async()=>{bridge.contributorRead=contributorRead;bridge.contributorDecide=contributorDecide;bridge.read=read;bridge.cancel=cancel;bridge.acceptSubmission=acceptSubmission;bridge.reopen=reopen;bridge.supplement=supplement;await completionBridge.recoverContextCards?.();},stop:()=>{if(bridge.contributorRead===contributorRead)bridge.contributorRead=undefined;if(bridge.contributorDecide===contributorDecide)bridge.contributorDecide=undefined;if(bridge.acceptSubmission===acceptSubmission)bridge.acceptSubmission=undefined;if(bridge.reopen===reopen)bridge.reopen=undefined;if(bridge.supplement===supplement)bridge.supplement=undefined;if(bridge.read===read)bridge.read=undefined;if(bridge.cancel===cancel)bridge.cancel=undefined;}});
}

export async function contextPresentation(handler,event){
 if(!event.provenance||typeof handler!=='function')return {interactive:false,state:'unavailable'};
 try{const result=await handler(event);return {interactive:result?.interactive===true,state:result?.interactive===true?'delivered':'unavailable'};}
 catch{return {interactive:false,state:'failed'};}
}
export function waitingPresentationInstruction(presentation){
 return presentation.interactive
  ?'原任务已等待用户，交互卡片已成功投递。卡片本身就是提问；直接结束当前轮次，不发送聊天消息，不重复发送投递确认、填写提示、问题正文或完成提醒。应用内加急由宿主处理，不推测或向用户说明加急是否成功。收到有效补充后 reply，不创建新的 run。'
  :'原任务已等待用户，但交互卡片未成功投递。请立即用普通文字列出待补充字段与可选项，请原用户直接回复；不要让用户确认卡片是否存在，不代选、不使用默认答案。收到有效补充后 reply，不创建新的 run。可再次 await_user 重试更新原卡片。';
}
