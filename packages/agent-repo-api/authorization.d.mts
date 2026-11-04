export type PermissionAction='discover'|'read'|'create'|'update'|'delete'|'execute'|'transfer'|'delegate'|'grant';
export interface AuthorizationEvent {toolName:string;params:Record<string,unknown>}
export interface AuthorizationContext {agentId?:string;sessionKey?:string;toolCallId?:string;requester?:{channel?:string;accountId?:string;senderId?:string}}
export interface AuthorizationOperation {requirements:Array<{resourceId:string;action:PermissionAction}>;context?:Record<string,string>;adapter?:{id:string;revision:string}}
export interface AuthorizationAdapter {revision?:string;resources?(context:AuthorizationContext):AuthorizationResource[]|Promise<AuthorizationResource[]>;match(event:AuthorizationEvent,context:AuthorizationContext):boolean;resolve(event:AuthorizationEvent,context:AuthorizationContext):AuthorizationOperation|undefined|Promise<AuthorizationOperation|undefined>}
export function registerAuthorizationAdapter(id:string,adapter:AuthorizationAdapter,owner:symbol):()=>void;
export function resolveAuthorizedOperation(event:AuthorizationEvent,context:AuthorizationContext):Promise<AuthorizationOperation|undefined>;
export interface AuthorizationInvocationContext extends AuthorizationContext {runId?:string}
export function bindAuthorizationScope(context:AuthorizationInvocationContext,jobId:string):()=>void;
export function getAuthorizationScope(context:AuthorizationInvocationContext):string|undefined;

export interface AuthorizationResource {id:string;agentId:string;kind:string;provider:string;name?:string;actions:PermissionAction[];labels?:string[];behavior?:Record<string,string>;definition?:Record<string,unknown>}
export function authorizationAdapterResources(context:AuthorizationContext):Promise<Array<AuthorizationResource & {adapter:{id:string;revision:string};status:"active";verification:"verified";enforcement:"enforced"}>>;
