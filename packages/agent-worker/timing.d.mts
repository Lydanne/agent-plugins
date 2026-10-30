export interface TaskTiming {status:string;createdAt?:number;startedAt?:number;finishedAt?:number;heartbeatAt?:number;questions?:{waitingForUserAt?:number;createdAt?:number}[]}
export function duration(ms:number):string;
export function taskTime(task:TaskTiming,now?:number):string;
