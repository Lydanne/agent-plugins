export const repositoryScheduleBridge=globalThis[Symbol.for('agent-repo.repository-schedules.v1')]??={};
// Logical task identities are independent of the day-keyed legacy receipt files.
export const repositorySyncTaskId=agentId=>`repo-sync:${agentId}`;
export const repositorySyncRunId=(agentId,date)=>`${repositorySyncTaskId(agentId)}:${date}`;
function nextPlan(schedule,enabled,records,now){
 if(!schedule)return {state:'unconfigured'};
 if(!enabled)return {state:'disabled'};
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(part=>[part.type,part.value]));
 const today=`${parts.year}-${parts.month}-${parts.day}`,attempted=records.some(record=>record.date===today);
 if(!attempted&&`${parts.hour}:${parts.minute}`>=schedule.time)return {state:'due',date:today,...schedule};
 const day=attempted?new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)+1)).toISOString().slice(0,10):today;
 return {state:'scheduled',date:day,...schedule};
}
export function repositorySyncTasks(binding,agentId,history,projects,now=Date.now()){
 const schedule=binding.sync?.submoduleSchedule??null;
 if(!schedule&&!history.records.length)return [];
 const taskId=repositorySyncTaskId(agentId),enabled=binding.sync?.enabled===true&&!!schedule;
 const records=history.records.map(record=>({...record,taskId,runId:repositorySyncRunId(agentId,record.date),trigger:'scheduled'}));
 return [{taskId,name:'每日仓库同步',type:'repository-sync',source:'system',readOnly:true,enabled,schedule,
  scope:{kind:'all-projects',label:'全部登记项目',projectIds:Object.keys(projects)},
  nextPlanned:nextPlan(schedule,enabled,records,now),lastRun:records[0]??null,records,hasMore:history.hasMore}];
}
