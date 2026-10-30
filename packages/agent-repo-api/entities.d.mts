export type EntityValue=string|number|boolean|string[]|null;
export interface EntityType {id:string;label:string;description?:string;fields:Record<string,{label:string;type:'string'|'number'|'boolean'|'strings'}>}
export interface EntitySource {kind:'ai'|'program'|'channel'|'manual';namespace:string;scope?:string;externalId:string}
export interface EntityRecord {id:string;typeId:string;name:string;summary:string;attributes:Record<string,EntityValue>;source:EntitySource;observedAt:string;updatedAt:string;revision:string;legacyPersonId?:string}
export interface EntityObservation {typeId:string;name:string;summary?:string;attributes?:Record<string,EntityValue>;source:{kind:'ai'|'program';namespace:string;externalId:string};observedAt:string;revision?:string}
export interface EntityService {types():{sources:Array<{namespace:string;count:number}>;types:Array<EntityType&{builtin:boolean;count:number}>;total:number};list(input?:{typeId?:string;query?:string;source?:string;offset?:number;limit?:number}):{entities:EntityRecord[];total:number;offset:number;limit:number;nextOffset:number|null};get(id:string):{entity:EntityRecord|null};registerType(input:EntityType):EntityType&{builtin:boolean};upsert(input:EntityObservation):{entity:EntityRecord;created:boolean;unchanged:boolean}}
export function getEntityService(context:{agentId?:string;sessionKey?:string}):EntityService|undefined;
export function registerEntityService(agentId:string,service:EntityService,owner:object|symbol):()=>void;

export interface SourceGrant {kind:'channel'|'program'|'ai'|'manual';namespace:string;scope:string;actor:string;types:string[];relations:string[];manual?:boolean;schema?:boolean}
export interface ChangeEvidence {kind:'observation'|'event'|'snapshot'|'manual';id:string;reason?:string}
export interface GraphObservation {typeId:string;externalId:string;name:string;summary?:string;attributes?:Record<string,EntityValue>;observedAt:string;revision?:string;validFrom?:string;validTo?:string}
export interface RelationObservation {typeId:string;externalId:string;fromId:string;toId:string;attributes?:Record<string,EntityValue>;observedAt:string;revision?:string;validFrom?:string;validTo?:string}
export interface GraphEntity extends EntityRecord {sourceId:string;status:'active'|'deleted';validFrom?:string;validTo?:string}
export interface RelationRecord {id:string;typeId:string;fromId:string;toId:string;attributes:Record<string,EntityValue>;sourceId:string;source:EntitySource;status:'active'|'ended';observedAt:string;updatedAt:string;revision:string;validFrom?:string;validTo?:string}
export type GraphChange={action:'upsert';record:GraphObservation;evidence:ChangeEvidence}|{action:'connect';record:RelationObservation;evidence:ChangeEvidence}|{action:'end'|'delete';id:string;revision:string;observedAt:string;evidence:ChangeEvidence};
export interface GraphBatch {requestId:string;changes:GraphChange[]}
export interface GraphBatchResult {results:unknown[]}
export interface SourceCapability {
 upsert(input:GraphObservation):{entity:GraphEntity;created:boolean;unchanged:boolean};
 connect(input:RelationObservation,evidence:ChangeEvidence):{relation:RelationRecord;created:boolean;unchanged:boolean};
 end(input:{id:string;revision:string;observedAt:string;evidence:ChangeEvidence}):RelationRecord;
 remove(input:{id:string;revision:string;observedAt:string;evidence:ChangeEvidence}):GraphEntity;
 applyRelationChanges(input:GraphBatch):GraphBatchResult;
 validateRelationChange(input:GraphBatch):{allowed:boolean;reason?:string;results?:unknown[]};
 syncSnapshot(input:{requestId:string;observedAt:string;complete:true;relationTypes:string[];changes:GraphChange[]}):GraphBatchResult;
}
export interface RelationType extends EntityType {fromTypes:string[];toTypes:string[];rules:{sameSource?:boolean;noSelf?:boolean;acyclic?:boolean;maxOutgoing?:number;maxIncoming?:number;connectEvidence?:ChangeEvidence['kind'][];endEvidence?:Array<'event'|'snapshot'|'manual'>;conditions?:{connect?:RelationCondition[];end?:RelationCondition[]}}}
export interface GraphService extends EntityService {
 version:2;forSource(grant:SourceGrant):SourceCapability;
 relationTypes():{types:RelationType[]};registerRelationType(input:RelationType):RelationType;
 sources():{sources:Array<{id:string;kind:string;namespace:string;scope:string}>};
 relations(input?:{id?:string;fromId?:string;toId?:string;typeId?:string;sourceId?:string;status?:'active'|'ended';offset?:number;limit?:number}):{relations:RelationRecord[];total:number;offset:number;limit:number;nextOffset:number|null};
 traverse(input:{id:string;depth?:number;limit?:number;direction?:'both'|'in'|'out';typeIds?:string[]}):{entities:GraphEntity[];relations:RelationRecord[];relationTypes:RelationType[];truncated:boolean};
 history(input?:{id?:string;offset?:number;limit?:number}):{history:unknown[];total:number;nextOffset:number|null};
}
export function getGraphService(context:{agentId?:string;sessionKey?:string}):GraphService|undefined;

export interface RelationCondition {field:string;op:'present'|'equals'|'in';value?:string|number|boolean|null|Array<string|number|boolean|null>}
