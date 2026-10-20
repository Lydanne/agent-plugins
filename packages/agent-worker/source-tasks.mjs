// Versioned in-process contract shared with the Feishu channel. Tool parameters
// never supply provenance or choose the task to cancel.
const key = Symbol.for('ada.source-tasks.v1');
export const sourceTaskBridge = globalThis[key] ??= {leases: new Map(), recalls: new Set()};
export function bindSourceTask(context) {
 const lease = context.agentAccountId ? sourceTaskBridge.leases.get(JSON.stringify([context.agentAccountId,context.sessionKey])) : undefined;
 if (!lease) return undefined;
 if (context.requesterSenderId && context.requesterSenderId !== lease.senderId) throw Error('Task requester mismatch');
 return lease;
}
export function taskProvenance(lease) {
 if (!lease) return undefined;
 lease.signal.throwIfAborted();
 if(sourceTaskBridge.leases.get(JSON.stringify([lease.accountId,lease.sessionKey]))!==lease) throw Error("Source task is no longer the active run");
 const {taskId,revision,accountId,chatId,sessionKey,senderId,sourceMessageIds,requestMessageIds,rootId,replyInThread}=lease;
 return {taskId,revision,accountId,chatId,sessionKey,senderId,sourceMessageIds:[...sourceMessageIds],requestMessageIds:[...(requestMessageIds??[])],...(rootId?{rootId}:{}),...(replyInThread!==undefined?{replyInThread}:{}),...(lease.people?{people:structuredClone(lease.people)}:{})};
}
export function rememberAsyncJob(lease, job) {
 if (!lease || !job.jobId || !job.notification ||
     ['accountId','chatId','sessionKey','senderId'].some(key=>job.provenance?.[key] !== lease[key])) return;
 taskProvenance(lease);
 lease.asyncDispatchAccepted = true;
 // An idempotent retry ends dispatch but cannot acquire the old task's card.
 if (job.provenance.taskId !== lease.taskId || job.provenance.revision !== lease.revision) return;
 lease.asyncJobIds ??= [];
 if (!lease.asyncJobIds.includes(job.jobId)) lease.asyncJobIds.push(job.jobId);
}

/** Continue presentation on the current human turn without replacing business provenance. */
export function rememberAsyncContinuation(lease,job,questionId) {
 if(!lease || !job.notification || !job.provenance || ['accountId','chatId','sessionKey','senderId'].some(key=>job.provenance[key]!==lease[key]))return false;
 taskProvenance(lease);lease.asyncDispatchAccepted=true;lease.asyncContinuations??=[];
 lease.asyncUserQuestions=lease.asyncUserQuestions?.filter(item=>item.jobId!==job.jobId||item.questionId!==questionId);
 if(!lease.asyncContinuations.some(item=>item.jobId===job.jobId&&item.questionId===questionId))lease.asyncContinuations.push({jobId:job.jobId,questionId,provenance:job.provenance});
 return true;
}

/** Waiting is a business state, not completion of the current Main turn. */
export function rememberUserQuestion(lease,job,questionId) {
 if(!lease || job.status!=='awaiting_user' || !job.provenance || ['accountId','chatId','sessionKey','senderId'].some(key=>job.provenance[key]!==lease[key]))return false;
 taskProvenance(lease);lease.asyncUserQuestions??=[];
 if(!lease.asyncUserQuestions.some(item=>item.jobId===job.jobId&&item.questionId===questionId))lease.asyncUserQuestions.push({jobId:job.jobId,questionId});
 return true;
}
