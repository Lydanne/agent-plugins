export interface WorkerCliContext {
 readonly version:1;
 readonly workerId:string;
 readonly jobId:string;
 readonly agentId:string;
 readonly sessionKey:string;
 readonly cwd?:string;
 readonly source?:Readonly<{taskId?:string;revision?:number;sessionId?:string;requestMessageIds?:string[];sourceMessageIds?:string[]}>;
 readonly projectId?:string;
 readonly repository?:string;
 readonly requesterId?:string;
 readonly accountId?:string;
 readonly chatId?:string;
 readonly task?:string;
 readonly context?:string;
 readonly constraints?:string;
 readonly mainReplies?:ReadonlyArray<unknown>;
}
export function workerContextApi<T>(api:T):T;
export function getWorkerCliContext(context:unknown):Readonly<WorkerCliContext>|undefined;
export function readWorkerCliContext(env?:NodeJS.ProcessEnv):Readonly<WorkerCliContext>|undefined;
