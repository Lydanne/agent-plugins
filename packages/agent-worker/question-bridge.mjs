/** Read pending questions through the worker-owned state, never callback-supplied job data. */
export function registerQuestionBridge(api,jobs,completionBridge){
 const bridge=globalThis[Symbol.for('ada.worker-question.v1')]??={};
 const verify=({jobId,questionId,provenance})=>{
  const job=jobs.status(jobId,provenance.sessionKey);
  if(['taskId','revision','senderId','accountId','chatId','sessionKey'].some(key=>job.provenance?.[key]!==provenance[key])||!completionBridge.authorizeReply?.(job.provenance))throw Error('Task source is no longer current');
  const question=(job.questions??[]).find(q=>q.questionId===questionId);
  if(!question||question.expiresAt<=Date.now())throw Error('Question expired');
  return {job,question};
 };
 const read=params=>{const {job,question}=verify(params);return {status:job.status,question,latestQuestionId:job.questions?.at(-1)?.questionId};};
 const cancel=params=>{
  const {job,question}=verify(params);
  if(job.status!=='awaiting_user'||question.answer!==undefined||job.contextRequest?.questionId!==params.questionId)throw Error('Question is no longer awaiting user');
  return jobs.cancel(job.jobId,params.provenance.sessionKey,{senderId:params.provenance.senderId,accountId:params.provenance.accountId});
 };
 api.registerService({id:'agent-worker-questions',start:async()=>{bridge.read=read;bridge.cancel=cancel;await completionBridge.recoverContextCards?.();},stop:()=>{if(bridge.read===read)bridge.read=undefined;if(bridge.cancel===cancel)bridge.cancel=undefined;}});
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
