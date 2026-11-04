import {evaluatePermissions} from './authorization-policy.mjs';
import {resolvePermissionGroups} from './authorization-membership.mjs';

/** Readers/adapters are trusted code, never model arguments. */
export function createAuthorizationService({store,resolveIdentity,readMembership,resolveOperation,now=()=>Date.now()}){
 for(const method of [resolveIdentity,readMembership,resolveOperation])if(typeof method!=='function')throw Error('Authorization adapters are required');
 async function decide(event,host,{ceiling,scopeId}={}){
  const subject=await resolveIdentity(host);
  const reject=reason=>({allowed:false,reason,checks:[],bindingIds:[]});
  if(subject?.verified!==true||subject.agentId!==store.agentId)return reject('UNVERIFIED_SUBJECT');
  const operation=await resolveOperation(event,host);
  if(!operation||!Array.isArray(operation.requirements)||!operation.requirements.length)return reject('UNCLASSIFIED_OPERATION');
  const snapshot=await readMembership(subject);
  const membership=resolvePermissionGroups({agentId:store.agentId,subject,snapshot,bindings:store.list('bindings'),groups:store.list('groups'),now:now()});
  if(!membership.verified)return reject(membership.reason);
  const taskScope=scopeId?store.taskScope(scopeId,subject.id,membership.groupIds):null;
  const checks=[];
  for(const requirement of operation.requirements){
   const resource=store.get('resources',requirement.resourceId);
   if(!resource){checks.push({allowed:false,reason:'UNKNOWN_RESOURCE',resourceId:requirement.resourceId,action:requirement.action});continue;}
   if(resource.adapter&&(resource.adapter.id!==operation.adapter?.id||resource.adapter.revision!==operation.adapter?.revision)){checks.push({resourceId:resource.id,action:requirement.action,allowed:false,reason:'ADAPTER_REVISION_MISMATCH'});continue;}
   const result=evaluatePermissions({agentId:store.agentId,subject,groups:membership.groupIds,rules:store.effectiveRules(resource.id),requirements:[{resource,action:requirement.action}],context:operation.context??{},parameters:event.params??{},ceiling});
   if(taskScope){
    const frozen=taskScope.resources.find(item=>item.id===resource.id&&item.revision===resource.revision);
    const original=frozen?evaluatePermissions({agentId:store.agentId,subject,groups:taskScope.groupIds,rules:frozen.rules,requirements:[{resource,action:requirement.action}],context:operation.context??{},parameters:event.params??{}}):null;
    if(!original?.allowed){checks.push({resourceId:resource.id,revision:resource.revision,action:requirement.action,allowed:false,reason:'TASK_SCOPE_DENIED',ruleIds:[]});continue;}
   }
   checks.push(...result.checks);
  }
  return {allowed:checks.length>0&&checks.every(check=>check.allowed),reason:checks.length>0&&checks.every(check=>check.allowed)?'ALLOW':'DENIED',checks,bindingIds:membership.bindingIds,subjectId:subject.id};
 }
 return {
  decide,
  async discover(host,{scopeId}={}){
   const subject=await resolveIdentity(host);if(!subject?.verified||subject.agentId!==store.agentId)return [];
   const snapshot=await readMembership(subject),membership=resolvePermissionGroups({agentId:store.agentId,subject,snapshot,bindings:store.list('bindings'),groups:store.list('groups'),now:now()});
   if(!membership.verified)return [];
   const scope=scopeId?store.taskScope(scopeId,subject.id,membership.groupIds):null,names=new Set();
   for(const resource of store.list('resources')){
    const name=resource.definition?.toolName;if(!name)continue;
    const input={agentId:store.agentId,subject,groups:membership.groupIds,rules:store.effectiveRules(resource.id),requirements:[{resource,action:'discover'}]};
    if(!evaluatePermissions(input).allowed)continue;
    if(scope){const frozen=scope.resources.find(item=>item.id===resource.id&&item.revision===resource.revision);if(!frozen||!evaluatePermissions({...input,groups:scope.groupIds,rules:frozen.rules}).allowed)continue;}
    names.add(name);
   }
   return [...names].sort();
  },
  async enforce(event,host,options){
   let result;
   try{result=await decide(event,host,options);}catch{result={allowed:false,reason:'AUTHORIZATION_UNAVAILABLE',checks:[],bindingIds:[]};}
   // A failed audit must also prevent execution. Do not persist untrusted params.
   store.audit(result.subjectId??'unresolved','execution.decision',host?.toolCallId??'unknown',{allowed:result.allowed,reason:result.reason,checks:result.checks,bindingIds:result.bindingIds});
   return result.allowed?undefined:{block:true,blockReason:'Permission denied: '+result.reason};
  },
 };
}
