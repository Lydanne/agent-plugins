export type EntityValue=string|number|boolean|string[]|null;
export interface EntityType {id:string;label:string;description?:string;fields:Record<string,{label:string;type:'string'|'number'|'boolean'|'strings'}>}
export interface EntitySource {kind:'ai'|'program'|'channel';namespace:string;externalId:string}
export interface EntityRecord {id:string;typeId:string;name:string;summary:string;attributes:Record<string,EntityValue>;source:EntitySource;observedAt:string;updatedAt:string;revision:string;legacyPersonId?:string}
export interface EntityObservation {typeId:string;name:string;summary?:string;attributes?:Record<string,EntityValue>;source:{kind:'ai'|'program';namespace:string;externalId:string};observedAt:string;revision?:string}
export interface EntityService {types():{sources:Array<{namespace:string;count:number}>;types:Array<EntityType&{builtin:boolean;count:number}>;total:number};list(input?:{typeId?:string;query?:string;source?:string;offset?:number;limit?:number}):{entities:EntityRecord[];total:number;offset:number;limit:number;nextOffset:number|null};get(id:string):{entity:EntityRecord|null};registerType(input:EntityType):EntityType&{builtin:boolean};upsert(input:EntityObservation):{entity:EntityRecord;created:boolean;unchanged:boolean}}
export function getEntityService(context:{agentId?:string;sessionKey?:string}):EntityService|undefined;
export function registerEntityService(agentId:string,service:EntityService,owner:object|symbol):()=>void;
