import {permissionActions} from './authorization-policy.mjs';
/** Broad executors cannot claim read-only or object-scoped confinement. Explicit grants only. */
const executors=new Set(['exec','process','browser','python','code_execution']);
export function broadExecutorResources(agentId){
 return [...executors].map(name=>({id:'tool://openclaw/'+name,agentId,kind:'executor',provider:'openclaw',name:name+'（宽泛执行）',actions:[...permissionActions],status:'active',verification:'verified',enforcement:'enforced',defaultAuthorization:'explicit-only',labels:['broad-execution'],behavior:{access:'mixed',atomicity:'unknown',recovery:'unknown',idempotency:'unknown',externalEffect:'present',sensitivity:'restricted',executionScope:'host-authority'},definition:{adapter:'broad-executor-v1',toolName:name,requiresAllActions:true,confinement:'none-added'}}));
}
export function broadExecutorOperation(event){
 if(!executors.has(event.toolName))return undefined;
 return {requirements:permissionActions.map(action=>({resourceId:'tool://openclaw/'+event.toolName,action}))};
}
