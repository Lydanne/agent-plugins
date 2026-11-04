import {resolveReviewedOperation} from './authorization-reviewed.mjs';
import {resolveBuiltinAuthorization} from './authorization-builtins.mjs';
import {createAuthorizationStore} from './authorization-store.mjs';
import {createAuthorizationService} from './authorization-service.mjs';
import {createAuthorizationGraphReader} from './authorization-graph.mjs';
import {createEntityStore} from './entities.mjs';
import {authorizationAdapterClaims,resolveAuthorizedOperation,getAuthorizationScope,registerTaskAuthorization} from './dist/authorization-api.mjs';
export function registerAuthorizationRuntime(api,config,{openStore=createAuthorizationStore,openGraph=createEntityStore,resolveOperation}={}){
 const stores=new Map(),services=new Map(),taskDisposers=[];
 const owner=Symbol.for('agent-repo.authorization-task-owner');
 function storeFor(agentId){const binding=config.agents[agentId];if(!binding)return null;if(!stores.has(agentId))stores.set(agentId,openStore(binding.repo,{agentId}));return stores.get(agentId);}
 function serviceFor(agentId,store){
  if(!services.has(agentId))services.set(agentId,createAuthorizationService({store,...createAuthorizationGraphReader(openGraph(config.agents[agentId].repo),agentId),resolveOperation:resolveOperation??(async(event,host)=>resolveBuiltinAuthorization(event)??(authorizationAdapterClaims(event,host)?await resolveAuthorizedOperation(event,host):resolveReviewedOperation(store,event)))}));
  return services.get(agentId);
 }
 async function filterSkills(catalog,context){
  const worker=context.workerContext;if(!worker)return catalog;
  if(worker.agentId!==context.agentId||worker.sessionKey!==context.sessionKey||!worker.jobId)throw Error('Worker permission scope mismatch');
  const store=storeFor(context.agentId);if(!store||store.mode()==='audit')return catalog;
  const host={agentId:context.agentId,sessionKey:worker.sessionKey,requester:{channel:context.messageChannel,accountId:worker.accountId,senderId:worker.requesterId}};
  return {...await serviceFor(context.agentId,store).filterSkills(catalog,host,{scopeId:JSON.stringify(['worker-job',worker.sessionKey,worker.jobId])}),shadowed:[]};
 }
 async function evaluate(event,host){
  const scopeId=host?getAuthorizationScope(host):undefined;
  // Ordinary Main calls remain governed solely by OpenClaw. A stale Worker
  // transport call must not become a Main call after losing its scope lease.
  if(!scopeId)return String(host?.toolCallId??event.toolCallId??'').startsWith('worker-cli:')?{block:true,blockReason:'Missing trusted Worker permission scope'}:undefined;
  try{const store=storeFor(host.agentId);if(!store)return;
   const decision=await serviceFor(host.agentId,store).enforce(event,host,{scopeId});
   return store.mode()==='enforce'?decision:undefined;
  }catch{return {block:true,blockReason:'Worker authorization service unavailable'};}
 }
 if(typeof api.registerTrustedToolPolicy!=='function')throw Error('Host lacks trusted tool policy support required by Worker authorization');
 api.registerTrustedToolPolicy({id:'agent-repo-authorization',description:'Entity-bound permission groups for task-bound Worker calls only',evaluate});
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
 async function authorizeOperation(event,context){
  const worker=context.workerContext;if(!worker)return;
  if(worker.agentId!==context.agentId||worker.sessionKey!==context.sessionKey||!worker.jobId)throw Error('Worker permission scope mismatch');
  const store=storeFor(context.agentId);if(!store)return;
  const host={agentId:context.agentId,sessionKey:worker.sessionKey,requester:{channel:context.messageChannel,accountId:worker.accountId,senderId:worker.requesterId}};
  const scopeId=JSON.stringify(['worker-job',worker.sessionKey,worker.jobId]);
  const decision=await serviceFor(context.agentId,store).enforce(event,host,{scopeId});
  if(store.mode()==='enforce'&&decision?.block)throw Error(decision.blockReason);
 }
 return {storeFor,evaluate,filterSkills,authorizeOperation};
}
