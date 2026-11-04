import {resolveBuiltinAuthorization} from './authorization-builtins.mjs';
import {createAuthorizationStore} from './authorization-store.mjs';
import {createAuthorizationService} from './authorization-service.mjs';
import {createAuthorizationGraphReader} from './authorization-graph.mjs';
import {createEntityStore} from './entities.mjs';
import {resolveAuthorizedOperation,getAuthorizationScope,registerTaskAuthorization} from './dist/authorization-api.mjs';
export function registerAuthorizationRuntime(api,config,{openStore=createAuthorizationStore,openGraph=createEntityStore,resolveOperation=async(event,host)=>resolveBuiltinAuthorization(event)??await resolveAuthorizedOperation(event,host)}={}){
 const stores=new Map(),services=new Map(),taskDisposers=[];
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
  const host={...context,requester:{channel:context.channel??context.messageProvider,accountId:context.accountId,senderId:context.senderId}};
  return serviceFor(context.agentId,store).filterSkills(catalog,host,{scopeId:context.runId&&context.sessionKey?JSON.stringify([context.sessionKey,context.runId]):undefined});
 }
 async function evaluate(event,host){
  if(!host?.agentId&&Object.keys(config.agents).length)return {block:true,blockReason:'Missing trusted Agent identity'};
  try{const store=storeFor(host.agentId);if(!store)return;
   const decision=await serviceFor(host.agentId,store).enforce(event,host,{scopeId:getAuthorizationScope(host)??(host.runId&&host.sessionKey?JSON.stringify([host.sessionKey,host.runId]):undefined)});return store.mode()==='enforce'?decision:undefined;
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
 api.registerService?.({id:'agent-repo-authorization',start:installTaskAuthorities,stop:()=>{for(const dispose of taskDisposers.splice(0))dispose();for(const store of stores.values())store.close();stores.clear();services.clear();}});
 return {storeFor,evaluate,prepare,filterSkills};
}
