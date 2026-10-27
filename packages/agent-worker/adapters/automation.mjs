import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {openTaskStore,fault} from '../task-service/store.mjs';
import {createTaskService} from '../task-service/service.mjs';
import {automationCaller} from './automation-policy.mjs';
export function registerAutomation(api,{configuration,jobs,invoke}){
 const agent=api.runtime?.agent,session=agent?.session,policy=configuration.automation;
 const capable=typeof api.registerGatewayMethod==='function'&&typeof api.runtime?.config?.current==='function'&&typeof agent?.resolveAgentWorkspaceDir==='function'&&typeof agent?.resolveThinkingDefault==='function'&&typeof agent?.runEmbeddedAgent==='function'&&typeof session?.runWithWorkAdmission==='function'&&typeof session?.getSessionEntry==='function'&&typeof session?.resolveStorePath==='function';
 const store=openTaskStore(join(configuration.state,'automation'));
 const config=()=>api.runtime.config.current();
 const location=t=>({storePath:session.resolveStorePath(config().session?.store,{agentId:t.request.agentId}),sessionKey:t.sessionKey,readConsistency:'latest'});
 const holds=new Map();
 const main={
  async protect(t){
   if(holds.has(t.taskId))return;
   let release,admitted,rejected;const done=new Promise(r=>{release=r;}),ready=new Promise((r,j)=>{admitted=r;rejected=j;});
   const work=session.runWithWorkAdmission(location(t),async()=>{admitted();await done;});
   // A lifecycle deletion must wait for durable execution and verification to settle.
   // The hold has no business side effects; reload explicitly releases it in stop().
   work.catch(rejected);holds.set(t.taskId,{release,work});try{await ready;}catch(e){holds.delete(t.taskId);throw e;}
  },
  release(t){holds.get(t.taskId)?.release();holds.delete(t.taskId);},
  releaseAll(){for(const h of holds.values())h.release();holds.clear();},
  session:async t=>{
  if(!capable)throw fault('HOST_CAPABILITY_UNAVAILABLE');const entry=session.getSessionEntry(location(t));
  if(t.sessionId&&!entry)throw fault('SESSION_MISSING');return entry;
 },run:async(t,{phase,payload,binding,signal})=>{
  const cfg=config(),a=cfg.agents?.list?.find(a=>a.id===t.request.agentId),configured=a?.model??cfg.agents?.defaults?.model;
  const selection=typeof configured==='string'?configured:configured?.primary;
  const entry=session.getSessionEntry(location(t));if(entry?.sessionId!==t.sessionId)throw fault('SESSION_REPLACED');
  const slash=selection?.indexOf('/'),provider=entry.providerOverride??entry.modelProvider??(slash>0?selection.slice(0,slash):agent.defaults.provider),model=entry.modelOverride??entry.model??(slash>0?selection.slice(slash+1):selection??agent.defaults.model);
  const prompt='宿主自动化任务，来源已绑定。仅完成此任务，不等待真人，不调用消息发送。首次阶段通过 agent_worker 委派一个主任务；后续补充只回复原 job/question。核验阶段禁止新 run，核验 Worker 报告后用 agent_task_result 提交 outcome 和业务 result。缺必要信息或授权使用 await_user 明确失败，不猜测。存在 predecessor 时先核对前序交付与产物，避免重复外部操作。\n'+JSON.stringify({phase,taskId:t.taskId,request:t.request,jobId:t.jobId,predecessorTaskId:t.predecessorTaskId,predecessor:t.predecessor,worker:payload});
  return session.runWithWorkAdmission({...location(t),signal},abortSignal=>agent.runEmbeddedAgent({agentId:t.request.agentId,sessionKey:t.sessionKey,sessionId:t.sessionId,config:cfg,workspaceDir:agent.resolveAgentWorkspaceDir(cfg,t.request.agentId),provider,model,thinkLevel:entry.thinkingLevel??agent.resolveThinkingDefault({cfg,provider,model}),runId:randomUUID(),prompt,timeoutMs:Math.max(1,t.deadline-Date.now()),abortSignal,disableMessageTool:true,toolBindings:{agentWorkerAutomation:binding}}));
 }};
 const service=createTaskService({store,jobs,main,invoke,policy,logger:api.logger});
 for(const action of ['submit','get','cancel','rerun'])api.registerGatewayMethod?.('agent-worker.automation.'+action,async({client,params,respond})=>{
  try{if(config().gateway?.auth?.mode==='none')throw fault('AUTHENTICATION_REQUIRED');const owner=automationCaller(client,policy);if(action!=='submit'&&(!params||typeof params.taskId!=='string'||Object.keys(params).some(k=>!(action==='rerun'?['taskId','operationId']:['taskId']).includes(k))))throw fault('INVALID_REQUEST');if(!capable&&['submit','rerun'].includes(action))throw fault('HOST_CAPABILITY_UNAVAILABLE');
   const result=action==='submit'?service.submit(owner,params):action==='get'?service.get(owner,params.taskId):action==='cancel'?service.cancel(owner,params.taskId):service.rerun(owner,params.taskId,params.operationId);respond(true,result);
  }catch(e){respond(false,undefined,{code:e.code??'AUTOMATION_UNAVAILABLE',message:e.code??'AUTOMATION_UNAVAILABLE'});}
 },{scope:action==='get'?'operator.read':'operator.write'});
 if(capable)api.registerTool(context=>context.toolBindings?.agentWorkerAutomation?{name:'agent_task_result',description:'核验阶段提交当前宿主绑定任务的最终业务结果。succeeded 只用于已核验成功，blocked 表示业务未完成。',parameters:{type:'object',properties:{outcome:{type:'string',enum:['succeeded','blocked']},result:{type:'object',additionalProperties:true}},required:['outcome','result'],additionalProperties:false},execute:(_id,p)=>service.result(p,context)}:null);
 api.registerService({apiVersion:2,id:'agent-worker-automation',start:ctx=>service.start(ctx.scheduler),stop:()=>service.stop()});
 return service;
}
