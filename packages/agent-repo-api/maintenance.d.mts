export interface MaintenanceContext {agentId:string;sessionKey:string;client:{scopes:string[]}}
export interface MaintenanceInput {providerId:string;action:string;expectedRevision:string;requestId:string;confirmed:true;settings?:Record<string,unknown>}
export interface MaintenanceOperation {id:string;action:string;status:string;createdAt:string;finishedAt:string|null;errorCode:string|null;actorAgentId?:string|null}
export interface MaintenanceSnapshot {apiVersion:1;id:string;label:string;scope:string;state:string;kind?:'cli'|'generated-skill';ownerLabel?:string;versions?:{current?:string;available?:string};revision?:string;observedAt:string;fields?:Array<{label:string;value:string}>;skills:Array<{name:string;description?:string}>;actions:Array<{id:string;label:string;settings?:boolean;effect?:string}>;history?:MaintenanceOperation[];body?:string;bodyTruncated?:boolean;policy?:{autoUpdate:boolean;version?:string;updateCheckIntervalHours:number}}
export interface MaintenanceProvider {apiVersion:1;id:string;label:string;scope:string;snapshot(ctx:MaintenanceContext):Promise<MaintenanceSnapshot>;run(ctx:MaintenanceContext,input:MaintenanceInput):Promise<MaintenanceOperation>}
export class MaintenanceError extends Error {code:string;constructor(code:string,message:string)}
export function maintenanceRevision(value:unknown):string;
export function maintenanceContext(ctx:unknown,write?:boolean):MaintenanceContext;
export function registerMaintenanceProvider(provider:MaintenanceProvider,owner:object|symbol):()=>void;
export function maintenanceCatalog(ctx:MaintenanceContext):Promise<{apiVersion:1;agentId:string;observedAt:string;providers:MaintenanceSnapshot[]}>;
export function runMaintenance(ctx:MaintenanceContext,input:MaintenanceInput):Promise<MaintenanceOperation>;
export function createMaintenanceOperations(directory:string):{find(ctx:MaintenanceContext,input:MaintenanceInput):Promise<MaintenanceOperation|null>;history():Promise<MaintenanceOperation[]>;start(ctx:MaintenanceContext,input:MaintenanceInput,execute:()=>Promise<unknown>):Promise<MaintenanceOperation>};
