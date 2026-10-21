// Only allowlisted public explanations cross into chat; never raw stderr or tool arguments.
export const queryDiagnostics = globalThis[Symbol.for('ada.codex-query-diagnostics.v1')] ??= new Map();
export function diagnosticKey(context) {
 return context.agentAccountId && context.sessionKey && context.requesterSenderId
  ? JSON.stringify([context.agentAccountId,context.sessionKey,context.requesterSenderId]) : undefined;
}
export function explainQueryError(error) {
 const text=String(error?.message ?? error ?? '');
 const rules=[
  [/No matching pending question|Question expired|Task cannot accept a reply|Question already answered differently/,'QUESTION_UNAVAILABLE','问题已过期、已回答或任务已结束；请核对原 jobId/questionId 和状态，不创建新的 run 或覆盖已有回答。'],
  [/Original task authorization is no longer current|Original Worker session cannot be resumed safely|Only the task requester Main can reply/,'CONTEXT_REPLY_FORBIDDEN','原任务授权、请求人或 Worker 会话校验未通过，未恢复执行；请核对原消息和原任务，不扩大权限或新建任务重做。'],
  [/Waiting queue is full; question remains pending/,'CONTEXT_REPLY_QUEUE_FULL','执行队列已满，问题仍待回答；稍后用相同 jobId、questionId 和回答重试，不创建新的 run。'],
  [/^Async completion is enabled; deliveryMode=wait is not allowed/,'ASYNC_REQUIRED','插件已开启异步，run 不接受 deliveryMode=wait。请用 async 提交并结束当前轮次，结果由完成事件交付；进度用 status 立即查询。'],
  [/^list does not accept limit or offset;/,'LIST_SETTINGS_ONLY','list 不接受 limit/offset；返回数量由插件设置 jobListLimit 控制。请移除分页参数，仅传 query 搜索。'],
  [/^No enabled model profiles/,'MODEL_NOT_CONFIGURED','未启用任何 Worker 模型，新任务未创建。请在 OpenClaw 插件设置的模型配置中添加并启用模型，再提交任务。'],
  [/^Invalid modelId|^Invalid thinkingLevel|^modelId and thinkingLevel are only supported for run/,'MODEL_SELECTION_INVALID','模型选择参数无效，新任务未启动。先用 action=models 核对可用 modelId，并在 run 传 0–6 的 thinkingLevel；reply 沿用原任务模型与等级。'],
  [/model.{0,200}(not supported|not available|does not exist)|unsupported model|model_not_found/i,'MODEL_UNAVAILABLE','模型请求被拒绝：当前模型不受此 CLI 或账户支持。请管理员核对执行器版本和模型可用性；本次未因此自动切换模型或重做业务任务。'],
  [/Memory preflight required|Invalid memory handoff/i,'MEMORY_HANDOFF_REQUIRED','尚未完成记忆检索交接，新任务未启动。请先 memory_search 并提供 memory 状态、查询和相关来源；工具不可用则明确填 unavailable 及原因。已有任务请继续 status/wait，不要重做。'],
  [/^Codex query exceeded \d+ ms/,'TIMEOUT','执行超过配置的时限，已请求停止。请先核对原任务及已发生的业务操作，不要直接重做。'],
  [/exceeded 10 minutes/i,'TIMEOUT','执行超过 10 分钟上限，已请求停止。请先核对原任务及已发生的业务操作，不要直接重做。'],
  [/aborted|cancelled|canceled/i,'INTERRUPTED','本次调用被中断。中断等待不等于后台任务失败，请查询原任务状态。'],
  [/source.bound|source task|Task requester mismatch/i,'SOURCE_INVALID','当前任务来源绑定缺失或已失效，未获准开始新的执行。请核对原消息及任务状态。'],
  [/Invalid |provide |Choose a stable|trusted OpenClaw|does not belong/i,'INVALID_REQUEST','工具参数或会话校验未通过，请核对参数和当前会话，不要重复发起业务操作。'],
  [/busy|already running|EEXIST/i,'BUSY','已有任务运行或状态待核实，请先查询原任务状态。'],
  [/rate.?limit|429|quota|usage limit/i,'RATE_LIMIT','执行服务返回限额或频率限制，请稍后查询原任务状态。'],
  [/unauthorized|401|authentication|not logged|login required/i,'AUTH','执行服务认证失败，需要管理员核对登录状态。'],
  [/ECONN|ENOTFOUND|network|connection|fetch failed/i,'NETWORK','执行服务连接失败，请核对网络及原任务状态。'],
  [/ENOENT|Could not start/i,'START_FAILED','执行程序或任务记录不可用，需要管理员核对本机运行环境。'],
  [/output limit/i,'OUTPUT_LIMIT','执行输出超过大小上限，已请求停止，请核对已完成部分。'],
  [/no final response/i,'NO_RESULT','执行进程结束但没有返回最终结果，请核对原任务记录。'],
 ];
 for(const [pattern,code,message] of rules) if(pattern.test(text) || text.includes(message) || text.startsWith(`[${code}]`))return {code,message};
 return {code:'UNKNOWN',message:'执行未完成，尚未取得可确认的具体原因。请核对原任务记录，不要直接重做业务操作。'};
}
export function describeQueryJob(job) {
 const id=/^[0-9a-f-]{36}$/i.test(job?.jobId??'') ? `（任务 ${job.jobId}）` : '';
 if(job?.status==='completed')return `本次调用报告异常，但原后台任务已完成${id}。请读取原任务结果，不要重新执行。`;
 if(['queued','running','cancelling'].includes(job?.status))return `本次调用未完成，原后台任务${job.status==='cancelling'?'正在取消':'仍在执行'}${id}。请继续查询原任务状态，不要重新执行。`;
 if(job?.status==='awaiting_user')return `任务正在等待用户补充上下文${id}。保留原任务，用户回答后 reply。`;
 if(job?.status==='awaiting_main')return `Worker 正在等待 Main 补充上下文${id}。请核对原任务并 reply，不创建新的 run。`;
 if(job?.status==='unknown')return `原后台任务心跳失联，暂时无法确认执行状态${id}。请先核验原任务，不要重新执行。`;
 return `Codex 查询未完成${id}：${explainQueryError(job?.error).message}`;
}
export function rememberDiagnostic(context, read) {
 const key=diagnosticKey(context);if(!key)return;
 const now=Date.now();
 for(const [k,v] of queryDiagnostics)if(now-v.updatedAt>600000)queryDiagnostics.delete(k);
 queryDiagnostics.set(key,{updatedAt:now,read});
}
