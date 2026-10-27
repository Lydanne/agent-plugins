import {setTimeout as sleep} from 'node:timers/promises';
const prefix='agent-worker.automation.';
export function createAutomationClient(rpc,{sessionMetadata={}}={}){
 const presentation=Object.fromEntries(['category','label'].filter(k=>typeof sessionMetadata[k]==='string'&&sessionMetadata[k].trim()).map(k=>[k,sessionMetadata[k].trim()]));
 const get=taskId=>rpc(prefix+'get',{taskId});
 async function prepare(task,agentId){
  if(task.phase==='waiting_session'&&!task.sessionId){
   // sessions.create is a public authenticated host RPC. The server selects the key.
   try{await rpc('sessions.create',{key:task.sessionKey,agentId,...presentation});}catch(error){for(let retry=0;retry<5;retry++){try{const current=await get(task.taskId);if(current.sessionId)return current;}catch{break;}await sleep(1000);}throw Object.assign(error,{task,taskId:task.taskId});}
  }
  return task;
 }
 return {
  async submit(input){return prepare(await rpc(prefix+'submit',input),input.agentId);},
  get,
  cancel:taskId=>rpc(prefix+'cancel',{taskId}),
  async rerun(taskId,operationId,agentId){return prepare(await rpc(prefix+'rerun',{taskId,operationId}),agentId);},
  async wait(taskId,{timeoutMs=3600000,intervalMs=15000,delay=sleep,onUpdate=()=>{}}={}){
   const deadline=Date.now()+timeoutMs;let task;
   while(Date.now()<deadline){task=await get(taskId);await onUpdate(task);
    if(['completed','failed','cancelled','unknown'].includes(task.state))return task;
    await delay(Math.min(intervalMs,Math.max(0,deadline-Date.now())));
   }
   throw Object.assign(new Error('AUTOMATION_WAIT_TIMEOUT'),{code:'AUTOMATION_WAIT_TIMEOUT',taskId,task});
  }
 };
}
