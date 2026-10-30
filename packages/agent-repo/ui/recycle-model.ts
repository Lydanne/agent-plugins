export interface RecycleItem{id:string;name:string;kind:string;provider:string;revision:string;deletedAt:number;expiresAt:number;expired?:boolean;busy?:boolean;restorePending?:boolean;preview?:unknown}
export interface RecyclePage{agentId:string;settings:{retentionDays:number;revision:string};records:RecycleItem[];total:number;nextOffset:number|null;unavailable?:string[];cleanup?:{at:number;status:string}}
export interface Confirmation{action:string;label:string;payload:Record<string,unknown>}
export const recycleLabels:Record<string,string>={logs:'日志批次','group-schedule':'群定时计划','system-schedule':'系统同步计划',person:'人员资料',entity:'实体资料'};
