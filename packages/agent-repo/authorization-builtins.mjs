import {workerAuthorizationOperation,workerAuthorizationResources} from './authorization-worker.mjs';
import {broadExecutorOperation,broadExecutorResources} from './authorization-broad.mjs';
import {fileOperation,fileResources} from './authorization-files.mjs';
import {networkOperation,networkResources} from './authorization-network.mjs';
/** These descriptors cover implementation-audited operations. Unknown actions fail closed. */
const readDomains=[
 {id:'entities',name:'实体库资料',adapter:'agent-repo-entities-v1',actions:['entity_types','entities','entity','relation_types','relations','graph','entity_history']},
 {id:'projects',name:'项目登记与仓库状态',adapter:'agent-repo-projects-v1',actions:['list','inspect']},
 {id:'knowledge',name:'项目知识库资料',adapter:'agent-repo-knowledge-v1',actions:['knowledge_list','knowledge_search','knowledge_read','knowledge_validate','knowledge_graph']},
];
const readDomainByAction=new Map(readDomains.flatMap(domain=>domain.actions.map(action=>[action,domain])));
export function builtinAuthorizationResources(agentId){
 const base={agentId,provider:'agent-repo',status:'active',verification:'verified',enforcement:'enforced',labels:['entities'],behavior:{access:'read',atomicity:'not-applicable',recovery:'not-applicable',idempotency:'guaranteed',externalEffect:'none',sensitivity:'sensitive'}};
 return [...workerAuthorizationResources(agentId),...broadExecutorResources(agentId),...networkResources(agentId),...fileResources(agentId),
  ...readDomains.flatMap(domain=>[
   {...base,id:'data://agent-repo/'+domain.id,kind:'data',name:domain.name,labels:[domain.id],actions:['discover','read'],definition:{adapter:domain.adapter}},
   ...domain.actions.map(action=>({...base,id:'tool://agent-repo/agent_repo/'+action,kind:'tool',name:'agent_repo '+action,labels:[domain.id],actions:['discover','read','execute'],definition:{adapter:domain.adapter,toolName:'agent_repo',action}})),
  ]),
 ];
}
export function resolveBuiltinAuthorization(event){
 const worker=workerAuthorizationOperation(event);if(worker)return worker;
 const broad=broadExecutorOperation(event);if(broad)return broad;
 const file=fileOperation(event);if(file)return file;
 const network=networkOperation(event);if(network)return network;
 if(event.toolName!=='agent_repo')return undefined;
 const domain=readDomainByAction.get(event.params?.action);if(!domain)return undefined;
 return {requirements:[{resourceId:'tool://agent-repo/agent_repo/'+event.params.action,action:'execute'},{resourceId:'data://agent-repo/'+domain.id,action:'read'}]};
}
