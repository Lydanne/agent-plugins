import type {DiagnosticEvent} from '../../agent-repo-api/diagnostics.mjs';
export type LogEvent=DiagnosticEvent&{eventId:string;agentId:string;sourceId:string;pluginId:string;observedAt?:string|number;level:string};
export interface LogSource {id:string;label:string;live?:boolean;capabilities?:{live:boolean;history:boolean;clearHistory:boolean}}
export interface HistoryResult {agentId:string;rows:LogEvent[];warnings?:unknown[];dropped?:number}
export interface LiveResult extends HistoryResult {leaseId:string;nextSeq:number;gap?:boolean}
export type LogEntry={type:'group';key:string;group:string;label:string;count:number}|{type:'date';key:string;label:string}|{type:'event';key:string;event:LogEvent;events?:LogEvent[];child?:boolean};
export const moment=(event:LogEvent)=>new Date(event.time??event.observedAt??'');
export const fullTime=(event:LogEvent)=>Number.isNaN(moment(event).getTime())?'时间未记录':moment(event).toLocaleString();
export const day=(event:LogEvent)=>Number.isNaN(moment(event).getTime())?'时间未记录':moment(event).toLocaleDateString();
export const capabilities=(source?:LogSource|null)=>source?.capabilities??{live:source?.live===true,history:false,clearHistory:false};
export function repeatKey(event:LogEvent){const data=event.data&&typeof event.data==='object'&&!Array.isArray(event.data)?Object.fromEntries(Object.entries(event.data).filter(([key,value])=>!(['time','timestamp','observedAt'].includes(key)&&[event.time,event.observedAt].some(t=>t!==undefined&&String(t)===String(value))))):event.data;return JSON.stringify([event.sourceId,event.level,event.message,event.jobId,event.traceId,event.projectId,event.eventName,event.category,event.phase,data]);}
export function repeatGroups(events:LogEvent[],merge:boolean){const result:{key:string;events:LogEvent[]}[]=[];for(const event of events){const key=repeatKey(event),prior=result.at(-1);if(merge&&prior?.key===key&&day(prior.events[0]!)===day(event))prior.events.push(event);else result.push({key,events:[event]});}return result;}
