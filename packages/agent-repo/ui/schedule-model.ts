export interface Schedule {kind?:'cron'|'at';time?:string;tz?:string;expr?:string;at?:string}
export interface ManagedTask {id:string;revision:string;name:string;kind?:string;status:string;sourceValid:boolean;busy?:boolean;chatId?:string;requester?:string;projectId?:string;task?:string;constraints?:string;schedule:Schedule;deliveryMode?:string;delivery?:{canUseThread?:boolean};canRun?:boolean;alreadyAttempted?:boolean;nativeWarning?:string}
export interface ScheduleCatalog {available:boolean;canRun?:boolean;tasks:ManagedTask[];operations?:{createdAt:string;action:string;status:string;result?:{id?:string}}[]}
export type ManageAction='create'|'update'|'pause'|'resume'|'remove'|'run';
export type ScheduleFields={name?:string;deliveryMode?:string;at?:string;expr?:string;timeZone?:string;time?:string};
export type ScheduleConfirmation=ScheduleFields&{action:ManageAction;sourceId?:string;id?:string;expectedRevision:string;requestId:string;confirmed:true};
export interface ScheduleDraft {name:string;delivery:string;kind:string;mode:string;expr:string;tz:string;at:string;daily:string}
export const labels:Record<ManageAction,string>={create:'新建任务',update:'保存设置',pause:'暂停',resume:'启用',remove:'删除',run:'立即执行'};
export const taskStatuses:Record<string,string>={enabled:'已启用',paused:'已暂停',removed:'已删除',completed:'已结束',blocked:'来源失效',needs_review:'待核验',creating:'创建中'};
export const deliveryLabels:Record<string,string>={source:'原请求位置',group:'群主会话',thread:'原请求话题'};
export const dailyTime=(s?:Schedule)=>{const m=/^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(s?.expr??'');return m&&+m[1]!<60&&+m[2]!<24?`${m[2]!.padStart(2,'0')}:${m[1]!.padStart(2,'0')}`:null;};
export const scheduleText=(s?:Schedule)=>s?.kind==='at'?`一次性 · ${s.at}`:`${s?.time||dailyTime(s)?'每天 '+(s?.time||dailyTime(s)):'Cron · '+(s?.expr??'未配置')} · ${s?.tz??'Asia/Shanghai'}`;
export function scheduleDraft(source:ManagedTask,creating:boolean):ScheduleDraft {return {name:creating?source.name+'（新计划）':source.name,delivery:source.deliveryMode??'source',kind:source.schedule.kind??'cron',mode:dailyTime(source.schedule)?'daily':'custom',expr:source.schedule.expr??'0 9 * * *',tz:source.schedule.tz??'Asia/Shanghai',at:source.schedule.at??'',daily:source.kind==='repository-sync'?source.schedule.time??'09:00':dailyTime(source.schedule)??'09:00'};}
