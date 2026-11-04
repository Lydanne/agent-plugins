const actions={list:['read'],get:['read'],history:['read'],audit:['read'],create:['create','delegate'],update:['update'],pause:['update'],resume:['update','delegate'],remove:['delete'],run:['delegate']};
const id=action=>'tool://agent-repo/agent_schedule/'+action;
export function scheduleResources(agentId){
 const base={agentId,provider:'agent-repo',status:'active',verification:'verified',enforcement:'enforced',labels:['schedules']};
 return [...Object.entries(actions).map(([action,permissions])=>{
  const readOnly=permissions.length===1&&permissions[0]==='read';
  return {...base,id:id(action),kind:'tool',name:'agent_schedule '+action,actions:['discover','execute',...permissions],behavior:{access:readOnly?'read':'write',atomicity:readOnly?'not-applicable':'unknown',recovery:readOnly?'not-applicable':'unknown',idempotency:'unknown',externalEffect:readOnly?'none':'present',sensitivity:'sensitive'},definition:{adapter:'agent-schedule-v1',toolName:'agent_schedule',action}};
 }),{...base,id:'delivery://agent-repo/schedule',kind:'delivery',name:'定时任务交给 Main 执行',actions:['execute','delegate','transfer'],behavior:{access:'write',atomicity:'unknown',recovery:'irreversible',idempotency:'unknown',externalEffect:'present',sensitivity:'sensitive'},definition:{adapter:'agent-schedule-dispatch-v1'}}];
}
export function scheduleOperation(event){
 if(event.toolName==='agent_schedule_dispatch')return {requirements:['execute','delegate','transfer'].map(action=>({resourceId:'delivery://agent-repo/schedule',action}))};
 if(event.toolName!=='agent_schedule'||!Object.hasOwn(actions,event.params?.action))return undefined;
 return {requirements:['execute',...actions[event.params.action]].map(action=>({resourceId:id(event.params.action),action}))};
}
