import {permissionActions} from './authorization-policy.mjs';
import {builtinAuthorizationResources} from './authorization-builtins.mjs';
const adapter='operator-reviewed-tool-v1';
const reservedToolNames=new Set(builtinAuthorizationResources('reserved').map(row=>row.definition?.toolName).filter(Boolean));
/** Operator attestation authorizes whole-tool behavior; it is not a sandbox or code analysis. */
export function canReviewResource(resource,{includeInactive=false}={}){
 const definition=resource?.definition;
 if(!resource?.definitionHash||resource.adapter||definition?.adapter||typeof definition?.toolName!=='string'||!definition.toolName)return false;
 if(!includeInactive&&!['pending','active'].includes(resource.status))return false;
 if(reservedToolNames.has(definition.toolName))return false;
 if(resource.kind==='tool')return resource.id==='tool://'+encodeURIComponent(resource.provider)+'/'+encodeURIComponent(definition.toolName);
 return resource.kind==='cli'&&definition.transport==='tool'&&typeof definition.action==='string'&&!!definition.action;
}
export function reviewedActions(behavior){
 if(!['read','write','mixed'].includes(behavior?.access)||!['none','present'].includes(behavior.externalEffect)||!['ordinary','sensitive','restricted'].includes(behavior.sensitivity))throw Error('Classify access, external effect and sensitivity before review');
 if(behavior.access==='mixed')return [...permissionActions];
 return ['discover','execute',...(behavior.access==='read'?['read']:['create','update','delete']),...(behavior.externalEffect==='present'?['transfer']:[])];
}
export function reviewResource(resource,actor){
 if(!canReviewResource(resource))throw Error('Only scanned tools without a dedicated adapter can be reviewed');
 const actions=reviewedActions(resource.behavior);
 return {...resource,status:'active',verification:'verified',enforcement:'enforced',actions,
  defaultAuthorization:resource.behavior.access==='mixed'?'explicit-only':undefined,
  review:{adapter,definitionHash:resource.definitionHash,behavior:JSON.stringify(resource.behavior),actor,at:new Date().toISOString()}};
}
export function resolveReviewedOperation(store,event){
 const candidates=store.list('resources').filter(row=>row.definition?.toolName===event.toolName&&canReviewResource(row,{includeInactive:true}));
 if(!candidates.length||new Set(candidates.map(row=>row.provider)).size!==1)return undefined;
 const commands=candidates.filter(row=>row.kind==='cli');
 const selected=commands.length?commands.filter(row=>row.definition.action===event.params?.action):candidates.filter(row=>row.kind==='tool');
 if(selected.length!==1)return undefined;
 const resource=selected[0],review=resource.review;
 if(review?.adapter!==adapter||review.definitionHash!==resource.definitionHash||review.behavior!==JSON.stringify(resource.behavior))return undefined;
 const actions=reviewedActions(resource.behavior).filter(action=>action!=='discover');
 return {requirements:actions.map(action=>({resourceId:resource.id,action}))};
}
