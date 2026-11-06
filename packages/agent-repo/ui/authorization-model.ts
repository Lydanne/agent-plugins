export interface PermissionRow {id:string;revision:number;name?:string;status?:string;groupId?:string;entityId?:string;entityType?:string;membership?:string;kind?:string;effect?:string;actions?:string[];[key:string]:unknown}
export const actionNames:Record<string,string>={discover:'发现',read:'读取',create:'新增',update:'修改',delete:'删除',execute:'调用',transfer:'传输',delegate:'委派',grant:'授权'};
export const valueNames:Record<string,string>={active:'启用',disabled:'停用',pending:'待核验',verified:'已核验',enforced:'已接入拦截',unknown:'未知',read:'只读',write:'写入',mixed:'读写混合',guaranteed:'有保证','not-guaranteed':'无保证','not-applicable':'不适用',reversible:'可撤销',compensatable:'可补偿',irreversible:'不可撤销',none:'无',present:'有',ordinary:'普通',sensitive:'敏感',restricted:'受限',skill:'技能',tool:'工具',cli:'命令',data:'数据',file:'文件',network:'网络',executor:'宽泛执行',delivery:'结果交付',allow:'允许',deny:'明确禁止',allow_all:'全部授权',deny_all:'全部拒绝',draft:'待发布',published:'已发布'};
export const displayValue=(value:unknown)=>valueNames[String(value)]??String(value??'未提供');
export const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export const array=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];
export const defaultCategories:Array<{id:string;label:string;conditions:Record<string,string[]>}>=[
 {id:'read',label:'已核验只读',conditions:{access:['read']}},
 {id:'ordinary',label:'普通写入',conditions:{access:['write'],atomicity:['not-guaranteed','not-applicable'],recovery:['irreversible','compensatable','not-applicable']}},
 {id:'atomic',label:'仅原子性写入',conditions:{access:['write'],atomicity:['guaranteed'],recovery:['irreversible','compensatable','not-applicable']}},
 {id:'reversible',label:'仅可撤销写入',conditions:{access:['write'],atomicity:['not-guaranteed','not-applicable'],recovery:['reversible']}},
 {id:'atomic-reversible',label:'原子且可撤销写入',conditions:{access:['write'],atomicity:['guaranteed'],recovery:['reversible']}},
];
export function ruleSummary(row:PermissionRow){
 const s=record(row.selector),c=record(row.conditions);
 const scope=[array(s.resourceIds).length?`${array(s.resourceIds).length} 项指定资源`:'',...array(s.labels).map(v=>'标签 '+v),...array(s.kinds).map(displayValue),...array(s.providers)].filter(Boolean).join(' · ')||'全部资源';
 const conditions=Object.entries(c).map(([key,value])=>`${({access:'操作',atomicity:'原子性',recovery:'恢复性',sensitivity:'数据',externalEffect:'外部影响'} as Record<string,string>)[key]??key}：${array(value).map(displayValue).join(' / ')}`).join('；');
 return `${displayValue(row.effect)} ${(row.actions??[]).map(a=>actionNames[a]??a).join('、')} · ${scope}${conditions?' · '+conditions:''}`;
}
export function categoryRules(rules:PermissionRow[],categoryId:string){
 const category=defaultCategories.find(c=>c.id===categoryId);if(!category)return [];
 return rules.filter(r=>{const c=record(r.conditions);return Object.entries(category.conditions).every(([key,values])=>!array(c[key]).length||values.some(v=>array(c[key]).includes(v)));});
}
export const reasonNames:Record<string,string>={ALLOW:'命中允许规则',DENIED:'存在未通过的权限检查',NO_ALLOW:'没有匹配的允许规则',EXPLICIT_DENY:'命中明确禁止规则',RESOURCE_UNVERIFIED:'资源未启用、未核验或未接入拦截',UNKNOWN_RESOURCE:'资源尚未登记',UNSUPPORTED_ACTION:'资源不支持此操作',STALE_MEMBERSHIP:'成员资料已超过一小时有效期或采集时间异常',UNVERIFIED_MEMBERSHIP:'成员关系资料不完整或来源无法核验',UNVERIFIED_SUBJECT:'人员身份未核验',UNCLASSIFIED_OPERATION:'操作尚未分类',TASK_SCOPE_DENIED:'超出任务受理时的权限范围',TASK_CEILING_DENIED:'超出任务权限上限',AUTHORIZATION_UNAVAILABLE:'权限服务不可用',ADAPTER_REVISION_MISMATCH:'适配器版本不一致'};
export const explainReason=(value:unknown)=>reasonNames[String(value)]??String(value??'未提供判定原因');
export function auditSummary(row:PermissionRow){
 const v=record(row.value),names:Record<string,string>={'execution.decision':'调用权限判定','execution.audit':'调用权限审计','policy.draft':'保存规则草稿','policy.publish':'发布规则','mode.set':'切换运行模式','groups.save':'更新权限组','bindings.save':'更新实体绑定','resources.save':'更新资源','rules.save':'更新规则','default.apply':'应用新增资源默认授权','default.recompute':'重算存量资源授权','task.scope':'记录任务权限范围'};
 return {title:names[String(row.action)]??String(row.action??'权限事件'),result:typeof v.allowed==='boolean'?(v.allowed?'策略允许':v.mode==='audit'?'按策略将拒绝（仅记录）':v.mode==='enforce'?'已拦截':'策略拒绝'):row.action==='policy.draft'?'待发布':'已记录',reason:typeof v.reason==='string'?explainReason(v.reason):'',at:row.at?new Date(String(row.at)).toLocaleString('zh-CN',{hour12:false}):'时间未提供'};
}
