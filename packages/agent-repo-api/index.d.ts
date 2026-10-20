export interface ProjectSelector {projectId?: string; repository?: string; expectedRegistryRevision?: string}
export interface ProjectCatalog {apiVersion: 1; agentId: string; root: string; registryRevision: string; singleProjectId: string|null; projects: Array<{projectId:string;name:string;repository:string}>}
export interface PreparedExecutionScope {apiVersion:1;agentId:string;root:string;registryRevision:string;projectId:string;repository:string;cwd:string;scopeDirectory:string;skills:Array<{name:string;description:string;source:string;path:string}>;instructions:string[];snapshot:Record<string,unknown>}
export interface AgentRepoServiceV1 {apiVersion:1;agentId:string;root:string;listProjects():Promise<ProjectCatalog>;inspectProject(selector:{projectId:string}):Promise<unknown>;prepareExecutionScope(selector?:ProjectSelector):Promise<PreparedExecutionScope>}
export class AgentRepoError extends Error {readonly code:string;constructor(code:string,message:string)}
export function trustedAgentId(context:{agentId?:string;sessionKey?:string}):string;
export function registerAgentRepoService(service:AgentRepoServiceV1,options:{owner:object|symbol}):()=>void;
export function getAgentRepoService(context:{agentId?:string;sessionKey?:string},options:{required:false}):AgentRepoServiceV1|undefined;
export function getAgentRepoService(context:{agentId?:string;sessionKey?:string},options?:{required?:true}):AgentRepoServiceV1;
