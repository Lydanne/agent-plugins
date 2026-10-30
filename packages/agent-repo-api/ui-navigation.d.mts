export interface WorkerTaskTarget {agentId:string;sessionKey:string;topic:string;jobId:string;projectId?:string;executionScope?:string}
export interface WorkerProjectTarget {agentId:string;projectId:string;sessionKey:string}
export type WorkerNavigationTarget=WorkerTaskTarget|WorkerProjectTarget;
export function canOpenWorkerProject():boolean;
export function openWorkerTask(target:WorkerTaskTarget):void;
export function openWorkerProject(target:WorkerProjectTarget):void;
export function subscribeWorkerNavigation(listener:()=>void):()=>void;
export function registerWorkerNavigation(open:(target:WorkerNavigationTarget)=>void):()=>void;
export interface UiTargetContext {props:{agentId?:string;sessionKey?:string};host:{agents:{selectedId?:string|null;defaultId?:string|null};connection:{assistantAgentId?:string|null};sessions:{selectedKey:string}}}
export function currentUiTarget(context:UiTargetContext):{agentId:string|undefined;sessionKey:string|undefined};
export function projectInspectionTarget(context:UiTargetContext):{agentId:string|undefined;sessionKey:string|undefined};
