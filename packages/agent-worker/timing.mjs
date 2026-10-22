// Shared by both Worker views; timestamps are observations, not inferred tool work.
const valid=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const terminal=new Set(['completed','failed','timed_out','cancelled']);
export function duration(ms){
 if(!valid(ms))return '未记录';
 if(ms<1000)return ms===0?'0s':'<1s';
 const seconds=Math.floor(ms/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
 return (hours?hours+'h':'')+(minutes?minutes+'m':'')+(seconds%60||!hours&&!minutes?seconds%60+'s':'');
}
export function taskTime(task,now=Date.now()){
 if(!valid(task.createdAt))return '用时未记录';
 const ended=terminal.has(task.status),unknown=task.status==='unknown';
 const end=ended?task.finishedAt:unknown?task.heartbeatAt:now;
 if(!valid(end))return '用时未记录'+(unknown?' · 状态待确认':'');
 const total='总用时 '+duration(Math.max(0,end-task.createdAt));
 if(ended)return total;
 if(unknown)return total+'（截至最后心跳，状态待确认）';
 if(task.status==='queued')return total+' · 排队中';
 if(['awaiting_main','awaiting_user'].includes(task.status)){
  const question=(task.questions??[]).at(-1),start=task.status==='awaiting_user'?question?.waitingForUserAt??question?.createdAt:question?.createdAt;
  return total+' · '+(task.status==='awaiting_user'?'等待用户':'等待 Main')+(valid(start)?' '+duration(Math.max(0,end-start)):'');
 }
 return total;
}
export function toolCalls(events){
 const calls=new Map();let round=0;
 for(const event of events){
  if(event.event==='turn.started')round++;
  const item=event.item;if(!item||item.type==='agent_message')continue;
  const key=round+':'+(item.id??JSON.stringify(item)),previous=calls.get(key);
  // An update/completion must never overwrite the observed start time.
  calls.set(key,{...event,callKey:key,startedAt:previous?.startedAt??(event.event==='item.started'&&valid(event.time)?event.time:undefined),finishedAt:previous?.finishedAt??(event.event==='item.completed'&&valid(event.time)?event.time:undefined)});
 }
 return [...calls.values()];
}
export function callTime(call,task,now=Date.now()){
 if(!valid(call.startedAt)||call.event==='item.completed'&&!valid(call.finishedAt))return '—';
 if(valid(call.finishedAt))return call.finishedAt>=call.startedAt?duration(call.finishedAt-call.startedAt):'—';
 const ended=terminal.has(task.status),unknown=task.status==='unknown';
 const end=ended?task.finishedAt:unknown?task.heartbeatAt:now;
 if(!valid(end)||end<call.startedAt)return '—';
 return duration(end-call.startedAt)+(ended?' · 未返回':unknown?' · 待确认':'');
}
export function bindTiming(node,textAt){node.dataset.workerClock='';node.workerTimingText=textAt;node.textContent=textAt(Date.now());return node;}
export function updateTimings(root,now=Date.now()){for(const node of root.querySelectorAll('[data-worker-clock]')){const text=node.workerTimingText?.(now);if(text!==undefined&&node.textContent!==text)node.textContent=text;}}
