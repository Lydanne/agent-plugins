import {registerAuthorizationAdapter,type AuthorizationResource,type PermissionAction} from './authorization.mjs';
const read:PermissionAction='read';
// @ts-expect-error unregistered permission verbs are invalid
const invalid:PermissionAction='superuser';
const resource:AuthorizationResource={id:'adapter://fixture/data',agentId:'ada',kind:'data',provider:'fixture',actions:[read]};
registerAuthorizationAdapter('fixture',{revision:'1',resources:()=>[resource],match:event=>event.toolName==='fixture',resolve:()=>({requirements:[{resourceId:resource.id,action:'read'}]})},Symbol());
void invalid;
import {admitAuthorizedTask,registerTaskAuthorization,type AuthorizationTaskGrant} from './authorization.mjs';
registerTaskAuthorization('ada',{async admit(task){return {scopeId:task.jobId,skillPaths:['skills/read/SKILL.md']};}},Symbol());
const grant:AuthorizationTaskGrant|undefined=await admitAuthorizedTask({agentId:'ada',jobId:'job',sessionKey:'session',requester:{senderId:'person'}});
const paths:string[]|undefined=grant?.skillPaths;
// @ts-expect-error task admission phases cannot be supplied as arbitrary tool names
await admitAuthorizedTask({agentId:'ada',jobId:'job',sessionKey:'session',requester:{},phase:'exec'});
void paths;
