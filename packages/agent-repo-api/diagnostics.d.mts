export type DiagnosticContext={agentId:string;sessionKey?:string};
export type DiagnosticEvent={level?:'debug'|'info'|'warn'|'error';message:string;time?:number|string;eventName?:string;category?:string;jobId?:string;traceId?:string;projectId?:string;phase?:string;data?:unknown};
export type DiagnosticCapture={read(context:{signal:AbortSignal}):Promise<DiagnosticEvent[]>;close?():void};
export type DiagnosticSource={apiVersion:1;id:string;pluginId:string;label:string;open?(context:{agentId:string;signal:AbortSignal}):Promise<DiagnosticCapture>};
export function registerDiagnosticSource(source:DiagnosticSource,owner:symbol):{log(context:DiagnosticContext,event:DiagnosticEvent|(()=>DiagnosticEvent)):boolean;dispose():void};
export function diagnosticSnapshot(value:unknown):unknown;
export function createDiagnosticHub(options?:{now?:()=>number;ttlMs?:number;maxRows?:number;maxBytes?:number}):{actions:Record<string,(context:DiagnosticContext&{client?:{connId?:string;scopes:string[]};payload?:Record<string,unknown>})=>Promise<unknown>>;canReadTransfer(context:DiagnosticContext&{client?:{connId?:string;scopes:string[]}},leaseId:string):boolean;start():void;dispose():void};
