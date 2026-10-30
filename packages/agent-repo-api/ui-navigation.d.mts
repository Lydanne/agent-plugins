export interface WorkerTaskTarget {agentId:string;sessionKey:string;topic:string;jobId:string;projectId?:string;executionScope?:string}
export function canOpenWorkerProject():boolean;
export function openWorkerTask(target:WorkerTaskTarget):void;
export function openWorkerProject(target:{agentId:string;projectId:string;sessionKey:string}):void;
export function subscribeWorkerNavigation(listener:()=>void):()=>void;
export function registerWorkerNavigation(open:(target:WorkerTaskTarget)=>void):()=>void;
