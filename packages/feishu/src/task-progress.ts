import {resolveFeishuRuntimeAccount} from "./accounts.js";
import {defaultProgressTemplate,renderBusinessMessage} from "./business-config.js";
import type {FeishuConfig} from "./types.js";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";

export type ProgressSnapshot = {
  completed: string[]; current: string; remaining: string[];
  estimate?: { minMinutes: number; maxMinutes: number; basis: string };
};
const safe = (text: string) => text.replace(/<[^>]*>/g, "").replace(/[\r\n]+/g, " ").replace(/([\\`*_\[\]<>])/g, "\\$1").slice(0, 300);
export class TaskProgress {
  constructor(private readonly config: Pick<FeishuConfig,"workingCard"|"businessMessages"> = {}) {}
  private snapshot?: ProgressSnapshot;
  private updatedAt = 0;
  private tool?: string;
  private message(key: Parameters<typeof renderBusinessMessage>[1], values: Record<string,string> = {}) { return renderBusinessMessage(this.config.businessMessages,key,values); }
  update(snapshot: ProgressSnapshot) { this.snapshot = structuredClone(snapshot); this.updatedAt = Date.now(); }
  plan(steps: {step: string; status: string}[]) {
    if (!steps.length) return;
    this.update({ completed: steps.filter(s => s.status === "completed").map(s => s.step),
      current: steps.filter(s => s.status === "in_progress").map(s => s.step).join(this.message("progressSeparator")) || this.message("progressNext"),
      remaining: steps.filter(s => s.status === "pending").map(s => s.step) });
  }
  toolStarted(name?: string, args?: Record<string, unknown>) {
    // Never echo tool arguments, command output, or reasoning to a shared chat.
    const actions: Record<string, Parameters<typeof renderBusinessMessage>[1]> = {
      run: "progressRun", wait: "progressWait", status: "progressStatus", list: "progressList", cancel: "progressCancel",
    };
    this.tool = this.message((name === "agent_worker" || name === "codex_query") && typeof args?.action === "string"
      ? actions[args.action] ?? "progressBackground" : "progressTool");
  }
  render(now = Date.now()): string {
    const s = this.snapshot;
    const age = s ? Math.max(0, Math.floor((now - this.updatedAt) / 60_000)) : 0;
    const estimate = s?.estimate;
    const left = estimate ? estimate.maxMinutes - (now - this.updatedAt) / 60_000 : 0;
    const eta = estimate && left > 0
      ? this.message("progressEstimate", {minMinutes:String(Math.max(1, Math.ceil(estimate.minMinutes - (now - this.updatedAt) / 60_000))),maxMinutes:String(Math.ceil(left)),basis:safe(estimate.basis)})
      : this.message(estimate ? "progressEstimateExpired" : "progressEstimateUnknown");
    const separator=this.message("progressSeparator");
    const values: Record<string,string> = {
      greeting:this.message("progressGreeting"), ageNotice:age>=1?this.message("progressAge",{minutes:String(age)}):"",
      completed:s?.completed.length?s.completed.slice(0,8).map(safe).join(separator):this.message("progressNoCompleted"),
      current:safe(s?.current||this.tool||this.message("progressInitial")),
      remaining:s?(s.remaining.length?s.remaining.slice(0,8).map(safe).join(separator):this.message("progressDeliver")):this.message("progressAwait"), eta,
    };
    return (this.config.workingCard?.progressTemplate ?? defaultProgressTemplate).replace(/\{(\w+)\}/g,(token,name:string)=>values[name]??token);
  }
}
const active = new Map<string, {progress: TaskProgress; sender: string}>();
const progressKey = (session: string, account: string) => JSON.stringify([session, account]);
export function registerTaskProgress(session: string, account: string, sender: string, progress: TaskProgress) {
  const key = progressKey(session, account);
  const owner = {progress, sender}; active.set(key, owner);
  return () => { if (active.get(key) === owner) active.delete(key); };
}
const line = Type.String({minLength: 1, maxLength: 300});
const schema = Type.Object({completed: Type.Array(line, {maxItems: 8}), current: line,
  remaining: Type.Array(line, {maxItems: 8}), estimate: Type.Optional(Type.Object({
    minMinutes: Type.Number({minimum: 1, maximum: 1440}), maxMinutes: Type.Number({minimum: 1, maximum: 1440}), basis: line,
  }, {additionalProperties: false})),
}, {additionalProperties: false});
export function registerAdaTaskProgressTool(api: OpenClawPluginApi) {
  api.registerTool(context => {
    if (!context.sessionKey || context.messageChannel !== "feishu") return null;
    const config=api.config ? resolveFeishuRuntimeAccount({cfg:api.config,accountId:context.agentAccountId}).config.workingCard : undefined;
    // Bind once to this run; a retained tool cannot write a successor's progress.
    let bound: ReturnType<typeof active.get>;
    return {name: config?.progressToolName ?? "ada_task_progress", label: config?.progressToolLabel ?? "Ada task progress", parameters: schema,
      description: "记录当前任务可公开的真实阶段进展，供用户催问时展示。只写已确认成果和剩余工作；只有可靠依据时填写估时。不得含凭证、内部推理、原始日志。不发送消息、不启动或完成业务任务。",
      async execute(_id, raw) {
        const owner = context.agentAccountId ? active.get(progressKey(context.sessionKey!, context.agentAccountId)) : undefined;
        if (!bound) bound = owner;
        if (!owner || owner !== bound || !context.requesterSenderId || owner.sender !== context.requesterSenderId) {
          return {content: [{type: "text" as const, text: "当前运行没有可写入的进度卡片。"}], details: {recorded: false}, isError: true};
        }
        const s = (raw ?? {}) as ProgressSnapshot;
        if (!Array.isArray(s.completed) || !Array.isArray(s.remaining) || typeof s.current !== "string" ||
          [...s.completed, s.current, ...s.remaining].some(x => typeof x !== "string" || !x.trim() || x.length > 300) ||
          s.completed.length > 8 || s.remaining.length > 8 ||
          (s.estimate && (!Number.isFinite(s.estimate.minMinutes) || !Number.isFinite(s.estimate.maxMinutes) || s.estimate.minMinutes < 1 || s.estimate.maxMinutes > 1440 || s.estimate.maxMinutes < s.estimate.minMinutes || typeof s.estimate.basis !== "string" || !s.estimate.basis.trim() || s.estimate.basis.length > 300))) {
          return {content: [{type: "text" as const, text: "进度字段或估时依据无效。"}], details: {recorded: false}, isError: true};
        }
        owner.progress.update(s);
        return {content: [{type: "text" as const, text: "已记录阶段进度；这不代表任务完成或消息已发送。"}], details: {recorded: true}};
      }};
  });
}
