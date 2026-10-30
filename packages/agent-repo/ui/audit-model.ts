export const auditFeatures:Record<string,string>={recycle:'回收站',schedules:'定时任务',entities:'实体与人员',workspace:'工作区',skills:'技能维护',logs:'日志管理'};
export const statuses:Record<string,string>={accepted:'已受理，执行结果另查',failed:'失败',pending:'处理中或中断待核验',succeeded:'成功',unknown:'结果待核验'};
export const actions:Record<string,string>={restore:'恢复',purge:'到期永久清理',configureRetention:'修改回收站保留期限',create:'创建',update:'修改',pause:'停止',resume:'开始',remove:'删除',run:'立即执行',workspacePoolSave:'保存工作区配置',maintenanceRun:'技能维护',syncPeople:'请求人员同步',updatePerson:'更正人员',deletePerson:'删除人员',clearRepositoryLogs:'清空仓库日志',diagnosticClearHistory:'清空历史日志'};
export const fields:Record<string,string>={name:'名称',task:'任务正文',schedule:'执行时间与时区',status:'状态',deliveryMode:'投递位置',jobId:'原生任务 ID',revision:'版本',enabled:'启用',maxSize:'工作区容量'};
const deliveryLabels:Record<string,string>={source:'原请求位置',group:'群主会话',thread:'原请求话题'};
export const display=(value:unknown,field?:string):string=>value===null||value===undefined?'未记录':typeof value==='object'?JSON.stringify(value):field==='deliveryMode'&&typeof value==='string'&&Object.hasOwn(deliveryLabels,value)?deliveryLabels[value]!:String(value);
export interface AuditRecord {
 id:string;at:number;targetId?:string;targetName?:string;action:string;status:string;executor?:string;requestId?:string;
 actor?:{name?:string;id?:string;kind?:string;identityNote?:string;accountId?:string;chatId?:string;messageIds?:string[]};
 changes?:{field:string;before?:unknown;after?:unknown}[];requested?:Record<string,unknown>;
}
export interface AuditPage {records:AuditRecord[];total:number;nextOffset:number|null;notice?:string;unavailable?:string[]}
export interface AuditOptions {invoke:(action:string,payload:Record<string,unknown>)=>Promise<AuditPage>;safe?:(value:unknown)=>string;feature?:string;targetId?:string;onClose?:()=>void}
