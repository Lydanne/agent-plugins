export function collaborationDiagnostics(job,binding,now=Date.now()){
 const questions=job.questions??[],plugin=questions.filter(question=>question.requestKind==='plugin').length,context=questions.length-plugin;
 const pending=job.contextRequest,notification=job.notification??{};
 return {observedAt:new Date(now).toISOString(),requests:{plugin:{used:plugin,limit:50},context:{used:context,limit:5}},
  waiting:pending&&!questions.find(question=>question.questionId===pending.questionId)?.answer?{kind:pending.requestKind??'context',ageMs:Math.max(0,now-(pending.createdAt??now)),expiresAt:pending.expiresAt??null}:null,
  delivery:{state:notification.state??'unavailable',attempts:notification.attempts??0,retryAt:notification.retryAt??null,lastErrorCode:notification.lastErrorCode??null,sendingAt:notification.sendingAt??null,deliveredAt:notification.deliveredAt??null,
   meaning:notification.state==='uncertain'?'Main 可能已启动或已开始发送；先核查原事件，不自动重复执行业务':notification.state==='delivered'?'事件已取得回执，不代表业务或 Worker 已完成':notification.state==='pending'?'按原事件等待投递或重试':'以原任务状态和事件回执为准'},
  skill:{lastNotifiedRevision:binding?.mainSkillNotifiedRevision??null,bindingUpdatedAt:binding?.updatedAt??null,actualRead:'unknown'}};
}
