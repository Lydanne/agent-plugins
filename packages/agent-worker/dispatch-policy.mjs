import {validateHistoryFilter,matchesHistoryFilter} from './project-binding.mjs';
/** Plugin configuration owns foreground blocking; tool arguments cannot disable async. */
export function asyncRunRequested(params, context) {
 if(context.asyncCompletionEnabled && params.deliveryMode === 'wait')
  throw Error('Async completion is enabled; deliveryMode=wait is not allowed');
 return context.asyncCompletionEnabled === true || params.deliveryMode === 'async';
}

export async function waitForQueryJob(params, context, jobs) {
 const current = jobs.status(params.jobId, context.sessionKey);
 if(context.asyncCompletionEnabled || current.notification) {
  return {...current, deliveryMode:'async', waitSkipped:true,
   instruction:'本次仅立即查询状态，不等待后台完成。结束当前轮次；结果由完成事件排队交付，不轮询或重跑。'};
 }
 return jobs.wait(params.jobId, context.sessionKey, params.waitSeconds ?? 20);
}

/** Match before bounding: an older topic remains discoverable by query or matching job tags. */
export function discoverTopics(topics, {query='', limit=10, jobTopics=[],projectId,repository}={}) {
 validateHistoryFilter({projectId,repository});
 const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 const key=value=>typeof value==='string'?value:JSON.stringify([value.topic,value.projectId??null,value.repository??null,value.modelSessionScope??null]);
 const fromJobs=new Set(jobTopics.filter(t=>typeof t==='string'?projectId===undefined&&repository===undefined:matchesHistoryFilter(t,{projectId,repository})).map(key));
 const matches=topics.filter(t=>matchesHistoryFilter(t,{projectId,repository})&&(fromJobs.has(t.topic)||fromJobs.has(key(t)) || terms.every(term=>[t.topic,t.projectId,t.repository,t.modelId,t.model,t.harness].filter(Boolean).join(' ').toLocaleLowerCase().includes(term))))
  .sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0)||a.topic.localeCompare(b.topic));
 return {tasks:matches.slice(0,limit), topicPage:{total:matches.length,limit,hasMore:matches.length>limit}};
}
