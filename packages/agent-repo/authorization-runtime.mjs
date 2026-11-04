import {resolveBuiltinAuthorization} from './authorization-builtins.mjs';
import {createAuthorizationStore} from './authorization-store.mjs';
import {createAuthorizationService} from './authorization-service.mjs';
import {createAuthorizationGraphReader} from './authorization-graph.mjs';
import {createEntityStore} from './entities.mjs';
import {resolveAuthorizedOperation,getAuthorizationScope,registerTaskAuthorization} from './dist/authorization-api.mjs';
export function registerAuthorizationRuntime(api,config,{openStore=createAuthorizationStore,openGraph=createEntityStore,resolveOperation=async(event,host)=>resolveBuiltinAuthorization(event)??await resolveAuthorizedOperation(event,host)}={}){
 const stores=new Map(),services=new Map(),taskDisposers=[];
 const invocationScopes=new Map();
 const invocationKey=host=>JSON.stringify([host.agentId,host.sessionKey,host.toolCallId]);
 const owner=Symbol.for('agent-repo.authorization-task-owner');
 function storeFor(agentId){const binding=config.agents[agentId];if(!binding)return null;if(!stores.has(agentId))stores.set(agentId,openStore(binding.repo,{agentId}));return stores.get(agentId);}
 function serviceFor(agentId,store){
  if(!services.has(agentId))services.set(agentId,createAuthorizationService({store,...createAuthorizationGraphReader(openGraph(config.agents[agentId].repo),agentId),resolveOperation}));
  return services.get(agentId);
 }
 async function prepare(_event,context){
  if(!context?.agentId)return Object.keys(config.agents).length?{toolsAllow:[]}:undefined;
  if(!config.agents[context.agentId])return;
  let mode;
  try{
   const store=storeFor(context.agentId);mode=store.mode();
   const host={...context,requester:{channel:context.channel??context.messageProvider,accountId:context.accountId,senderId:context.senderId}};
   const toolsAllow=await serviceFor(context.agentId,store).discover(host,{scopeId:context.runId&&context.sessionKey?JSON.stringify([context.sessionKey,context.runId]):undefined});
   return mode==='enforce'?{toolsAllow}:undefined;
  }catch{return mode==='audit'?undefined:{toolsAllow:[]};}
 }
 async function filterSkills(catalog,context){
  const store=storeFor(context.agentId);if(!store||store.mode()==='audit')return catalog;
  const invocation=context.toolCallId?invocationScopes.get(invocationKey(context)):undefined;
  if(context.toolCallId&&!invocation)return {...catalog,skills:[],shadowed:[]};
  const host={...context,requester:invocation?.requester??{channel:context.channel??context.messageProvider??context.messageChannel,accountId:context.accountId??context.agentAccountId,senderId:context.senderId??context.requesterSenderId}};
  const scopeId=invocation?.scopeId??(context.runId&&context.sessionKey?JSON.stringify([context.sessionKey,context.runId]):undefined);
  return {...await serviceFor(context.agentId,store).filterSkills(catalog,host,{scopeId}),shadowed:[]};
 }
 async function evaluate(event,host){
  if(!host?.agentId&&Object.keys(config.agents).length)return {block:true,blockReason:'Missing trusted Agent identity'};
  try{const store=storeFor(host.agentId);if(!store)return;
   const scopeId=getAuthorizationScope(host)??(host.runId&&host.sessionKey?JSON.stringify([host.sessionKey,host.runId]):host.sessionKey&&host.toolCallId?JSON.stringify(['tool-call',host.sessionKey,host.toolCallId]):undefined);
   const decision=await serviceFor(host.agentId,store).enforce(event,host,{scopeId});
   if(scopeId&&host.toolCallId&&host.sessionKey){invocationScopes.set(invocationKey(host),{scopeId,requester:host.requester});if(invocationScopes.size>2048)invocationScopes.delete(invocationScopes.keys().next().value);}
   return store.mode()==='enforce'?decision:undefined;
  }catch{return {block:true,blockReason:'Authorization service unavailable'};}
 }
 if(typeof api.registerTrustedToolPolicy!=='function')throw Error('Host lacks trusted tool policy support required by authorization');
 api.on?.('before_prompt_build',prepare,{priority:1000});
 api.registerTrustedToolPolicy({id:'agent-repo-authorization',description:'Entity-bound permission groups for all model tool invocations',evaluate});
 function installTaskAuthorities(){if(taskDisposers.length)return;
 for(const agentId of Object.keys(config.agents))taskDisposers.push(registerTaskAuthorization(agentId,{async admit(task){
  const store=storeFor(agentId),host={agentId,sessionKey:task.sessionKey,requester:task.requester};
  const scopeId=JSON.stringify(['worker-job',task.sessionKey,task.jobId]);
  const parentScopeId=task.parentJobId?JSON.stringify(['worker-job',task.sessionKey,task.parentJobId]):undefined;
  const event=task.phase==='delivery'?{toolName:'agent_worker_result_delivery',params:{}}:{toolName:'agent_worker',params:{...task.parameters,action:'run'}};
  const decision=await serviceFor(agentId,store).enforce(event,host,{scopeId,parentScopeId});
  if(store.mode()==='enforce'&&decision?.block)throw Error(decision.blockReason);
  const skills=task.skillCatalog&&store.mode()==='enforce'?await serviceFor(agentId,store).filterSkills(task.skillCatalog,host,{scopeId}):undefined;
  return {scopeId,...(skills?{skillPaths:skills.skills.map(skill=>skill.path)}:{})};
 }},owner));
 }
 installTaskAuthorities();
 api.registerService?.({id:'agent-repo-authorization',start:installTaskAuthorities,stop:()=>{for(const dispose of taskDisposers.splice(0))dispose();for(const store of stores.values())store.close();stores.clear();services.clear();invocationScopes.clear();}});
 async function authorizeOperation(event,context){
  const store=storeFor(context.agentId);if(!store)return;
  const worker=context.workerContext;
  if(worker&&(worker.agentId!==context.agentId||worker.sessionKey!==context.sessionKey||!worker.jobId))throw Error('Worker permission scope mismatch');
  const invocation=invocationScopes.get(invocationKey(context));
  if(!worker&&!invocation&&store.mode()==='enforce')throw Error('Missing trusted invocation permission scope');
  const host={...context,requester:invocation?.requester??{channel:context.messageChannel,accountId:context.agentAccountId??context.deliveryContext?.accountId,senderId:context.requesterSenderId}};
  const scopeId=worker?JSON.stringify(['worker-job',worker.sessionKey,worker.jobId]):invocation?.scopeId;
  const decision=await serviceFor(context.agentId,store).enforce(event,host,{scopeId});
  if(store.mode()==='enforce'&&decision?.block)throw Error(decision.blockReason);
 }
 async function authorizeSchedule(record,phase,parameters){
  const source=record.source,store=storeFor(source.agentId);if(!store)throw Error('Schedule Agent is no longer configured');
  const scopeId=JSON.stringify(['schedule',source.agentId,record.id]);
  if(phase==='dispatch'&&record.authorizationScope!==scopeId){if(store.mode()==='enforce')throw Error('Schedule has no original permission scope');return;}
  const host={agentId:source.agentId,sessionKey:source.sessionKey,requester:{channel:'feishu',accountId:source.accountId,senderId:source.senderId}};
  const event={toolName:phase==='create'?'agent_schedule':'agent_schedule_dispatch',params:phase==='create'?{...parameters,action:'create'}:{id:record.id,projectId:record.projectId,task:record.task,deliveryMode:record.deliveryMode}};
  const decision=await serviceFor(source.agentId,store).enforce(event,host,{scopeId});
  if(decision?.block){if(store.mode()==='enforce')throw Error(decision.blockReason);return;}
  return scopeId;
 }
 return {storeFor,evaluate,prepare,filterSkills,authorizeSchedule,authorizeOperation};
}
