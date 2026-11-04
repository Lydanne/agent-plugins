import {workerAuthorizationOperation,workerAuthorizationResources} from './authorization-worker.mjs';
import {broadExecutorOperation,broadExecutorResources} from './authorization-broad.mjs';
import {fileOperation,fileResources} from './authorization-files.mjs';
import {networkOperation,networkResources} from './authorization-network.mjs';
/** These descriptors cover implementation-audited operations. Unknown actions fail closed. */
const reads=new Set(['entity_types','entities','entity','relation_types','relations','graph','entity_history']);
export function builtinAuthorizationResources(agentId){
 const base={agentId,provider:'agent-repo',status:'active',verification:'verified',enforcement:'enforced',labels:['entities'],behavior:{access:'read',atomicity:'not-applicable',recovery:'not-applicable',idempotency:'guaranteed',externalEffect:'none',sensitivity:'sensitive'}};
 return [...workerAuthorizationResources(agentId),...broadExecutorResources(agentId),...networkResources(agentId),...fileResources(agentId),
  {...base,id:'data://agent-repo/entities',kind:'data',name:'实体库资料',actions:['discover','read'],definition:{adapter:'agent-repo-entities-v1'}},
  ...[...reads].map(action=>({...base,id:'tool://agent-repo/agent_repo/'+action,kind:'tool',name:'agent_repo '+action,actions:['discover','read','execute'],definition:{adapter:'agent-repo-entities-v1',toolName:'agent_repo',action}})),
 ];
}
export function resolveBuiltinAuthorization(event){
 const worker=workerAuthorizationOperation(event);if(worker)return worker;
 const broad=broadExecutorOperation(event);if(broad)return broad;
 const file=fileOperation(event);if(file)return file;
 const network=networkOperation(event);if(network)return network;
 if(event.toolName!=='agent_repo'||!reads.has(event.params?.action))return undefined;
 return {requirements:[{resourceId:'tool://agent-repo/agent_repo/'+event.params.action,action:'execute'},{resourceId:'data://agent-repo/entities',action:'read'}]};
}
