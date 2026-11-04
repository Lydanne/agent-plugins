import {registerAuthorizationAdapter,type AuthorizationResource,type PermissionAction} from './authorization.mjs';
const read:PermissionAction='read';
// @ts-expect-error unregistered permission verbs are invalid
const invalid:PermissionAction='superuser';
const resource:AuthorizationResource={id:'adapter://fixture/data',agentId:'ada',kind:'data',provider:'fixture',actions:[read]};
registerAuthorizationAdapter('fixture',{revision:'1',resources:()=>[resource],match:event=>event.toolName==='fixture',resolve:()=>({requirements:[{resourceId:resource.id,action:'read'}]})},Symbol());
void invalid;
