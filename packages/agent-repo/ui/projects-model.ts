import type {SkillSource} from './maintenance-model';
import type {ScheduledTask} from './task-directory-model';
export interface Subagent {name:string;provider:string;path:string;definitionPath?:string;description?:string;status?:string;model?:string;reasoningEffort?:string;mode?:string;hidden?:boolean;appliesWhen?:string;disabledReason?:string;overriddenBy?:string;updatedAt?:string|number;updatedCommit?:string}
export interface SubagentSource {state:string;warning?:string;warnings?:string[];subagents:Subagent[]}
export interface ProjectEntry {projectId:string;name:string;repository:string}
export interface ProjectCatalog {agentId:string;root:string;registrationCommitted:boolean;projects:ProjectEntry[];agentSkills?:SkillSource;agentSubagents?:SubagentSource;scheduledTasks?:ScheduledTask[];scheduledRequestsAvailable?:boolean;scannedAt?:string|number}
export interface ProjectDetail {agentId:string;projectId:string;name:string;cwd:string;repository:string;scopes:{repository:string;label:string}[];sources:SkillSource[];subagentSources?:(SubagentSource&{source:string})[];effectiveSkillCount:number;candidateSubagentCount?:number;inspection:{git:{state:string;branch?:string;dirty?:boolean;branchMatches?:boolean;remoteMatches?:boolean}};scannedAt?:string|number}
