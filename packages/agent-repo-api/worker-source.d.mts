export type SourceRef={namespace:string;scope:string;id:string};
export type SourceRevocation={apiVersion:1;eventId:string;reason:string;sources:SourceRef[]};
export type RevocationReceipt={accepted:true;eventId:string;jobIds:string[]};
export function normalizeSourceRevocation(event:unknown):SourceRevocation;
export function registerWorkerSourceControl(service:{apiVersion:1;invalidate:(event:SourceRevocation)=>RevocationReceipt},options:{owner:unknown}):()=>void;
export function revokeWorkerSources(event:SourceRevocation):RevocationReceipt|{accepted:false;reason:'unavailable'};
