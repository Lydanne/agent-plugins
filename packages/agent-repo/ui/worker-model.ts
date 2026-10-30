import type {TaskTiming} from '../../agent-worker/timing.mjs';
export const workerLabels:Record<string,string>={running:'运行中',queued:'排队中',awaiting_main:'等待 Main',awaiting_user:'等待用户',completed:'已完成',failed:'失败',timed_out:'超时',cancelled:'已取消',cancelling:'取消中',unknown:'状态待核实'};
export interface ManagedTask extends TaskTiming {jobId:string;topic:string;taskSummary?:string;projectId?:string;sessionKey:string;executionScope?:string;notificationState?:string;notificationErrorCode?:string;createdAt:number}
export interface AgentTaskPage {taskTotal:number;conversationTotal:number;counts:Record<string,number>;coverage:string;tasks:ManagedTask[];projectIds:string[];total:number;hasMore:boolean;scannedAt:string;diagnostics?:{deliveryUncertain?:number;awaitingMainOverdue?:number}}
