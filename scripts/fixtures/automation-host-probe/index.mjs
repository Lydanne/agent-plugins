import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {registerAutomation} from '../../../packages/agent-worker/adapters/automation.mjs';
export default {id:'automation-probe',register(api){
 const file=api.config.agents.defaults.workspace+'/fixture-jobs.json';const data=new Map(existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[]);const save=()=>writeFileSync(file,JSON.stringify([...data]));const jobs={findAutomation:id=>[...data.values()].find(j=>j.taskId===id),status:id=>data.get(id),cancel:id=>{data.get(id).status='cancelled';save();}};
 const service=registerAutomation(api,{configuration:{state:api.config.agents.defaults.workspace+'/worker-state',automation:{enabled:true,callers:['local-gateway-operator'],agents:['main'],projects:['probe'],queueId:'automation',timeoutMs:120000}},jobs,invoke:async(p,ctx)=>{
  const job={jobId:randomUUID(),taskId:ctx.automationTask.taskId,status:p.task==='hold'?'running':'completed',result:{text:'isolated read-only fixture'}};data.set(job.jobId,job);save();return {content:[{type:'text',text:JSON.stringify(job)}]};
 }});
 api.registerTool(ctx=>({name:'agent_worker',description:'Delegate the bound read-only fixture',parameters:{type:'object',additionalProperties:true},execute:(_id,p)=>service.tool(p,ctx)}));
}};
