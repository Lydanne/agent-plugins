import {permissionActions} from './authorization-policy.mjs';
import {scheduleOperation,scheduleResources} from './authorization-schedules.mjs';
import {workerAuthorizationOperation,workerAuthorizationResources} from './authorization-worker.mjs';
import {broadExecutorOperation,broadExecutorResources} from './authorization-broad.mjs';
import {fileOperation,fileResources} from './authorization-files.mjs';
import {networkOperation,networkResources} from './authorization-network.mjs';
/** These descriptors cover implementation-audited operations. Unknown actions fail closed. */
const readDomains=[
 {id:'skills',name:'技能目录',adapter:'agent-repo-skills-v1',actions:['skills']},
 {id:'entities',name:'实体库资料',adapter:'agent-repo-entities-v1',actions:['entity_types','entities','entity','relation_types','relations','graph','entity_history','people','person','people_stats']},
 {id:'projects',name:'项目登记与仓库状态',adapter:'agent-repo-projects-v1',actions:['list','inspect']},
 {id:'knowledge',name:'项目知识库资料',adapter:'agent-repo-knowledge-v1',actions:['knowledge_list','knowledge_search','knowledge_read','knowledge_validate','knowledge_graph']},
];
const readDomainByAction=new Map(readDomains.flatMap(domain=>domain.actions.map(action=>[action,domain])));
export function builtinAuthorizationResources(agentId){
 const base={agentId,provider:'agent-repo',status:'active',verification:'verified',enforcement:'enforced',labels:['entities'],behavior:{access:'read',atomicity:'not-applicable',recovery:'not-applicable',idempotency:'guaranteed',externalEffect:'none',sensitivity:'sensitive'}};
 return [{...base,id:'tool://agent-repo/agent_repo/worker_skill',kind:'tool',name:'发布 Worker 协作技能',actions:['discover','execute','read','create','update'],labels:['skills'],behavior:{access:'write',atomicity:'unknown',recovery:'irreversible',idempotency:'unknown',externalEffect:'none',sensitivity:'sensitive'},definition:{adapter:'agent-repo-worker-skill-v1',toolName:'agent_repo',action:'worker_skill'}},{...base,id:'tool://agent-repo/agent_repo/sync',kind:'executor',name:'仓库同步（含 Git 配置执行权限）',actions:[...permissionActions],defaultAuthorization:'explicit-only',labels:['repositories','broad-execution'],behavior:{access:'mixed',atomicity:'unknown',recovery:'unknown',idempotency:'unknown',externalEffect:'present',sensitivity:'restricted'},definition:{adapter:'agent-repo-sync-v1',toolName:'agent_repo',action:'sync',requiresAllActions:true,confinement:'none-added'}},{...base,id:'data://agent-repo/people-enrichment',kind:'data',name:'人员远程补采及入库',actions:['read','create','update','transfer'],behavior:{access:'write',atomicity:'unknown',recovery:'irreversible',idempotency:'unknown',externalEffect:'present',sensitivity:'sensitive'},definition:{adapter:'agent-repo-people-enrichment-v1'}},...scheduleResources(agentId),...workerAuthorizationResources(agentId),...broadExecutorResources(agentId),...networkResources(agentId),...fileResources(agentId),
  ...readDomains.flatMap(domain=>[
   {...base,id:'data://agent-repo/'+domain.id,kind:'data',name:domain.name,labels:[domain.id],actions:['discover','read'],definition:{adapter:domain.adapter}},
   ...domain.actions.map(action=>({...base,id:'tool://agent-repo/agent_repo/'+action,kind:'tool',name:'agent_repo '+action,labels:[domain.id],actions:['discover','read','execute'],definition:{adapter:domain.adapter,toolName:'agent_repo',action}})),
  ]),
 ];
}
export function resolveBuiltinAuthorization(event){
 if(event.toolName==='agent_repo'&&event.params?.action==='worker_skill')return {requirements:['execute','read','create','update'].map(action=>({resourceId:'tool://agent-repo/agent_repo/worker_skill',action}))};
 if(event.toolName==='agent_repo'&&event.params?.action==='sync')return {requirements:permissionActions.map(action=>({resourceId:'tool://agent-repo/agent_repo/sync',action}))};
 if(event.toolName==='agent_repo_people_enrich')return {requirements:['read','create','update','transfer'].map(action=>({resourceId:'data://agent-repo/people-enrichment',action}))};
 const schedule=scheduleOperation(event);if(schedule)return schedule;
 const worker=workerAuthorizationOperation(event);if(worker)return worker;
 const broad=broadExecutorOperation(event);if(broad)return broad;
 const file=fileOperation(event);if(file)return file;
 const network=networkOperation(event);if(network)return network;
 if(event.toolName!=='agent_repo')return undefined;
 const domain=readDomainByAction.get(event.params?.action);if(!domain)return undefined;
 return {requirements:[{resourceId:'tool://agent-repo/agent_repo/'+event.params.action,action:'execute'},{resourceId:'data://agent-repo/'+domain.id,action:'read'}]};
}
