import type {AgentTaskPage} from './worker-model';
export interface CatalogOverview {root:string;registrationCommitted:boolean;projects:unknown[];agentSkills?:{state:string;skills:unknown[]};scheduledTasks?:{enabled:boolean}[]}
export interface PeopleOverview {stats?:{missing?:{email?:number};giteaSources?:{email_prefix?:number}}}
export interface MaintenanceOverview {providers:{label:string;scope:string;state:string}[]}
export interface OverviewValues {catalog?:CatalogOverview;people?:PeopleOverview;entities?:{total:number};logs?:{records:unknown[]};worker?:AgentTaskPage;maintenance?:MaintenanceOverview}
export type OverviewSource=keyof OverviewValues;
