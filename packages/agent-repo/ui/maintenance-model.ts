import type {MaintenanceSnapshot,MaintenanceInput} from '../../agent-repo-api/maintenance.mjs';
export type Provider=Omit<MaintenanceSnapshot,'skills'>&{skills:(MaintenanceSnapshot['skills'][number]&{scope?:string})[]};
export type Action=Provider['actions'][number];
export interface RepositorySkill {name:string;description?:string;path:string;status?:string;disabledReason?:string;updatedAt?:string|number;updatedCommit?:string;appliesWhen?:string;overriddenBy?:string}
export interface SkillSource {source:string;directory?:string;state?:string;warning?:string;skills:RepositorySkill[]}
export interface Skill {key:string;name:string;label:string;sourceLabel:string;scope:string;state:string;description?:string;path?:string;updatedCommit?:string;updatedAt?:string|number;appliesWhen?:string;overriddenBy?:string;disabledReason?:string;warning?:string;provider?:Provider;cli?:Provider|null}
export type Policy={autoUpdate:boolean;version:string;updateCheckIntervalHours:number};
export type Confirmation={providerId:string;action:Action;revision:string;settings?:Policy};
export type Retry=MaintenanceInput;
export const states:Record<string,string>={available:'CLI 可用',fallback:'使用已验证旧版',not_installed:'未安装',disabled:'已禁用',unavailable:'不可读取',degraded:'需处理',running:'执行中',succeeded:'成功',failed:'失败',unknown:'结果待核查',unsupported:'版本不支持'};
export const time=(value?:string|number)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未记录';
export const summary=(value?:string)=>{const text=String(value??'').replace(/\s+/g,' ').trim();return text.length>100?text.slice(0,100)+'…':text;};
export const sourceName=(source:string)=>({agent:'Agent 仓库',project:'项目仓库',repository:'子仓库'} as Record<string,string>)[source]??'仓库技能';
export const skillState=(skill:Skill)=>skill.provider?(skill.cli?(skill.state==='available'?'CLI 可用':states[skill.state]??'未知'):skill.state==='available'?'已生成':states[skill.state]??'未知'):({candidate:'范围内候选',pending_commit:'待提交变化',shadowed:'同名覆盖',disabled:'已禁用'} as Record<string,string>)[skill.state]??'状态待核验';
export const providerStatus=(provider:Provider)=>provider.versions?.available&&provider.versions.available!==provider.versions.current?provider.policy?.version?'待切换至固定版本':'有新版本可用':states[provider.state]??'未知';
