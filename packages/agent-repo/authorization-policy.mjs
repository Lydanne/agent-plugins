/** Pure policy evaluator. Identity and membership must be resolved by a trusted adapter. */
export const permissionActions=Object.freeze(['discover','read','create','update','delete','execute','transfer','delegate','grant']);
export const defaultPermissionGroups=Object.freeze([
 Object.freeze({id:'administrator',name:'管理员组',description:'管理权限与全部已核验资源；不绕过明确禁止和执行边界'}),
 Object.freeze({id:'internal',name:'内部组',description:'内部成员的业务权限，由资源范围和规则授予'}),
 Object.freeze({id:'external',name:'外部组',description:'外部成员的受限权限，默认不授予业务能力'}),
]);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const contextFields=new Set(['projectId','environment','accountId','destinationHost','destinationOrigin','protocol']);
const fields=new Set(['projectId','environment','accountId','sensitivity','atomicity','recovery','idempotency','externalEffect','access','destinationHost','destinationOrigin','protocol']);
export function validatePermissionRule(rule){
 if(!plain(rule)||Object.keys(rule).some(k=>!['id','groupId','effect','actions','selector','conditions','parameters','origin'].includes(k)))throw Error('Invalid permission rule');
 if(typeof rule.id!=='string'||!rule.id||typeof rule.groupId!=='string'||!rule.groupId||!['allow','deny'].includes(rule.effect))throw Error('Invalid permission rule identity');
 if(!Array.isArray(rule.actions)||!rule.actions.length||rule.actions.some(a=>!permissionActions.includes(a)))throw Error('Invalid permission actions');
 const selector=rule.selector;
 if(!plain(selector)||Object.keys(selector).some(k=>!['resourceIds','kinds','providers','labels'].includes(k))||Object.values(selector).some(v=>!Array.isArray(v)||!v.length||v.some(x=>typeof x!=='string'||!x)))throw Error('Invalid resource selector');
 if(rule.conditions!==undefined&&(!plain(rule.conditions)||Object.entries(rule.conditions).some(([k,v])=>!fields.has(k)||!Array.isArray(v)||!v.length||v.some(x=>typeof x!=='string'))))throw Error('Invalid permission conditions');
 if(rule.parameters!==undefined){
  if(!Array.isArray(rule.parameters)||rule.parameters.length>32)throw Error('Invalid parameter predicates');
  for(const predicate of rule.parameters){
   if(!plain(predicate)||Object.keys(predicate).some(key=>!['path','op','value'].includes(key))||typeof predicate.path!=='string'||!predicate.path||predicate.path.split('.').length>8||predicate.path.split('.').some(key=>!/^[_a-zA-Z0-9-]+$/.test(key)||['__proto__','prototype','constructor'].includes(key))||!['equals','in','subset','present','max','min'].includes(predicate.op))throw Error('Invalid parameter predicate');
   const scalar=value=>value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value);
   if(['in','subset'].includes(predicate.op)?(!Array.isArray(predicate.value)||!predicate.value.length||predicate.value.length>100||!predicate.value.every(scalar)):['max','min'].includes(predicate.op)?!Number.isFinite(predicate.value):predicate.op==='present'?typeof predicate.value!=='boolean':!scalar(predicate.value))throw Error('Invalid parameter predicate value');
  }
 }
 return structuredClone(rule);
}
export function permissionRuleMatches(rule,resource,context){
 const s=rule.selector;
 if(s.resourceIds&&!s.resourceIds.includes(resource.id)||s.kinds&&!s.kinds.includes(resource.kind)||s.providers&&!s.providers.includes(resource.provider)||s.labels&&!s.labels.every(label=>resource.labels?.includes(label)))return false;
 return Object.entries(rule.conditions??{}).every(([key,values])=>{
  const value=contextFields.has(key)?context[key]:resource.behavior?.[key];
  return value!==undefined&&value!=='unknown'&&values.includes(value);
 });
}
/** Discovery has no invocation context. Keep those predicates on the resulting grant. */
export function permissionDefaultMatches(rule,resource){
 const conditions=Object.fromEntries(Object.entries(rule.conditions??{}).filter(([key])=>!contextFields.has(key)));
 return permissionRuleMatches({...rule,conditions},resource,{});
}
/** Discovery has no call payload. Conditional allows expose metadata, not execution rights. */
export function permissionDiscoveryRules(rules){
 return rules.map(validatePermissionRule).flatMap(rule=>{
  const conditions=Object.fromEntries(Object.entries(rule.conditions??{}).filter(([key])=>!contextFields.has(key)));
  const needsInvocation=(rule.parameters?.length??0)>0||Object.keys(rule.conditions??{}).some(key=>contextFields.has(key));
  // Only a deny that is decidable without invocation data may hide metadata.
  if(rule.effect==='deny'&&needsInvocation)return [];
  const {parameters,...metadataRule}=rule;
  return [{...metadataRule,conditions}];
 });
}
export function permissionParametersMatch(predicates,parameters){
 return (predicates??[]).every(({path,op,value})=>{
  let current=parameters,present=true;
  for(const key of path.split('.')){if(!current||typeof current!=='object'||!Object.hasOwn(current,key)){present=false;break;}current=current[key];}
  if(op==='present')return present===value;if(!present)return false;
  if(op==='equals')return current===value;
  if(op==='in')return value.includes(current);
  if(op==='subset')return Array.isArray(current)&&current.every(item=>value.includes(item));
  return typeof current==='number'&&Number.isFinite(current)&&(op==='max'?current<=value:current>=value);
 });
}
/** No empty requirements, unknown capabilities, or unverified enforcement may pass. */
export function evaluatePermissions({agentId,subject,groups,rules,requirements,context={},parameters={},ceiling}){
 const fail=reason=>({allowed:false,reason,checks:[]});
 if(!agentId||subject?.agentId!==agentId||subject?.verified!==true||!subject.id)return fail('UNVERIFIED_SUBJECT');
 if(!Array.isArray(requirements)||!requirements.length)return fail('EMPTY_REQUIREMENTS');
 const applicable=rules.filter(rule=>groups.includes(rule.groupId)).map(validatePermissionRule);
 const checks=[];
 for(const {resource,action} of requirements){
  let reason,matched=[];
  if(!permissionActions.includes(action)||!resource?.actions?.includes(action))reason='UNSUPPORTED_ACTION';
  else if(resource.agentId!==agentId)reason='RESOURCE_SCOPE_MISMATCH';
  else if(resource.status!=='active'||resource.verification!=='verified'||resource.enforcement!=='enforced')reason='RESOURCE_UNVERIFIED';
  else if(ceiling&&!ceiling.some(item=>item.resourceId===resource.id&&item.revision===resource.revision&&item.action===action))reason='TASK_CEILING_DENIED';
  else{
   matched=applicable.filter(rule=>rule.actions.includes(action)&&permissionRuleMatches(rule,resource,context)&&permissionParametersMatch(rule.parameters,parameters));
   reason=matched.some(rule=>rule.effect==='deny')?'EXPLICIT_DENY':matched.some(rule=>rule.effect==='allow')?'ALLOW':'NO_ALLOW';
  }
  checks.push({resourceId:resource?.id,revision:resource?.revision,action,allowed:reason==='ALLOW',reason,ruleIds:matched.map(rule=>rule.id)});
 }
 return {allowed:checks.every(check=>check.allowed),reason:checks.every(check=>check.allowed)?'ALLOW':'DENIED',checks};
}
