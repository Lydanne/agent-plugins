export interface TaskTiming {status:string;createdAt?:number;startedAt?:number;finishedAt?:number;heartbeatAt?:number;questions?:{waitingForUserAt?:number;createdAt?:number}[]}
export interface ToolItem {id?:string;type:string;status?:string;command?:string;exit_code?:number|null;server?:string;tool?:string;arguments?:unknown;aggregated_output?:unknown;result?:unknown;error?:unknown;action?:unknown;changes?:{kind?:string;path?:string;[key:string]:unknown}[];[key:string]:unknown}
export interface ToolEvent {event:string;time?:number;item?:ToolItem;[key:string]:unknown}
export interface ObservedToolCall extends ToolEvent {item:ToolItem;callKey:string;startedAt?:number;finishedAt?:number}
export function duration(ms:number):string;
export function taskTime(task:TaskTiming,now?:number):string;
export function toolCalls(events:ToolEvent[]):ObservedToolCall[];
export function callTime(call:ObservedToolCall,task:TaskTiming,now?:number):string;
export function bindTiming<T extends HTMLElement>(node:T,textAt:(now:number)=>string):T;
export function updateTimings(root:ParentNode,now?:number):void;
