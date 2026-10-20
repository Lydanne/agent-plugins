export interface PersonIdentity {accountId:string;appId:string;openId:string}
export interface PersonObservation extends PersonIdentity {name?:string;email?:string;departments?:Array<{id:string;name?:string}>}
export interface Person extends PersonIdentity {id:string;name:string|null;email:string|null;departments:Array<{id:string;name?:string}>;giteaUsername:string|null;giteaSource:'admin'|'email_prefix'|'unknown';revision:string;observedAt:string;updatedAt:string}
export interface PeopleService {observe(input:PersonObservation):Person;lookup(identity:PersonIdentity):Person|null}
export function getPeopleService(agentId:string):PeopleService|undefined;
export function registerPeopleService(agentId:string,service:PeopleService,owner:object|symbol):()=>void;
export interface PeopleLookupRequest {agentId:string;openId?:string;email?:string;name?:string;accountId?:string;appId?:string;contextAccountId?:string;sessionKey?:string}
export interface PeopleLookupResult {status:'found'|'not_found'|'unavailable'|'unsupported'|'account_required'|'error';people:PersonObservation[];reason?:string;code?:number;requiredScopes?:string[];truncated?:boolean}
export type PeopleResolver=(input:PeopleLookupRequest)=>Promise<PeopleLookupResult>;
export function getPeopleResolver():PeopleResolver|undefined;
export function registerPeopleResolver(resolve:PeopleResolver,owner:object|symbol):()=>void;
export interface PeopleGroupContext {agentId:string;sessionKey:string;accountId?:string}
export interface PeopleGroupSyncRun {id:string;agentId:string;accountId:string;chatId:string;source:'button'|'bot_join'|'member_join';status:'running'|'completed'|'partial'|'failed'|'cancelled';discovered:number;processed:number;saved:number;profiled:number;identityOnly:number;failed:number;created:number;updated:number;startedAt:string;finishedAt?:string;reason?:string;errors:Array<{openId?:string;reason:string;code?:number;requiredScopes?:string[]}>}
export interface PeopleJoinEvent {chat_id?:string;event_id?:string;app_id?:string;users?:Array<{name?:string;user_id?:{open_id?:string}}>}
export interface PeopleGroupSyncService {info(input:PeopleGroupContext):{available:boolean;reason?:string;accounts:Array<{accountId:string;appId?:string}>;onJoin?:boolean};start(input:PeopleGroupContext):PeopleGroupSyncRun;status(input:PeopleGroupContext):PeopleGroupSyncRun|null;join(accountId:string,event:PeopleJoinEvent,kind:'bot_join'|'member_join'):void;stop():Promise<void>}
export function getPeopleGroupSync():PeopleGroupSyncService|undefined;
export function registerPeopleGroupSync(service:PeopleGroupSyncService,owner:object|symbol):()=>void;
