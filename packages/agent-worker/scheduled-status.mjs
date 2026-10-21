// Read-only status capability; callers cannot start, cancel or change a Worker job.
export function registerScheduledWorkerStatus(api,getJobs){
 const bridge=globalThis[Symbol.for('ada.scheduled-requests.v1')]??={};
 const jobsActive=(ids,source)=>ids.some(id=>{
  const job=getJobs().status(id,source.sessionKey);
  if(['agentId','accountId','chatId','sessionKey','senderId'].some(key=>job.provenance?.[key]!==source[key]))throw Error('Scheduled Worker source mismatch');
  return !['completed','failed','timed_out','cancelled'].includes(job.status);
 });
 api.registerService({id:'agent-worker-scheduled-status',start:()=>{bridge.jobsActive=jobsActive;},stop:()=>{if(bridge.jobsActive===jobsActive)delete bridge.jobsActive;}});
}
