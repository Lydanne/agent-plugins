import type {TaskPeople} from './people-directory.js';
import { renderContextData, renderSection } from "./context-sections.js";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getFeishuRuntime } from "./runtime.js";
import type {FeishuChatType} from "./types.js";

export type TaskAttachment = {messageId:string;kind:string;resourceId?:string;path?:string;contentType?:string;availability:"available"|"unavailable"};
export type TaskSource = { messageId: string; text: string; kind?: "request" | "reference"; attachments?:Omit<TaskAttachment,"messageId">[] };
export type RecallIdentity = { accountId: string; chatId: string; messageId: string };
export type TaskAttachmentSource = Pick<TaskLease,"taskId"|"revision"|"accountId"|"chatId"|"sessionKey"|"senderId"|"sourceMessageIds"> & {attachments?:TaskAttachment[];questionId?:string};
export type TaskLease = {
  taskId: string; revision: number; accountId: string; chatId: string;
  sessionKey: string; senderId: string; sourceMessageIds: string[]; requestMessageIds?: string[]; rootId?: string; replyInThread?: boolean;
  chatType?: FeishuChatType;
  people?: TaskPeople;
  attachments?: TaskAttachment[];
  attachmentSources?: TaskAttachmentSource[];
  signal: AbortSignal;
  /** Scheduler-created turns cannot grant new recurring authorization. */
  scheduledRequest?: boolean;
  /** Trusted executor acknowledgements only; never filled from model prose. */
  asyncJobIds?: string[];
  asyncDispatchAccepted?: boolean;
  asyncUserQuestions?: {jobId:string;questionId:string}[];
  /** Live channel-owned placeholder; never supplied by tool parameters or persisted. */
  questionCardTarget?: () => {messageId:string} | undefined;
  asyncContinuations?: {jobId:string;questionId:string;provenance:Pick<TaskLease,"taskId"|"revision"|"accountId"|"chatId"|"sessionKey"|"senderId">}[];
};
// Shared only inside this Gateway. codex-query consumes this versioned contract;
// it never accepts source identity from model-supplied tool parameters.
type Bridge = {
  leases: Map<string, TaskLease>;
  recalls: Set<(event: RecallIdentity) => void>;
};
const symbol = Symbol.for("ada.source-tasks.v1");
const globalState = globalThis as typeof globalThis & { [symbol]?: Bridge };
export const sourceTaskBridge = globalState[symbol] ??= { leases: new Map(), recalls: new Set() };
const tasks = new Set<SourceTask>();
export const sourceLeaseKey = (accountId: string, sessionKey: string) => JSON.stringify([accountId, sessionKey]);

function database(stateDir?: string) {
  const file = join(stateDir ?? getFeishuRuntime().state.resolveStateDir(), "feishu-source-tasks", "tasks.sqlite");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS recalls (account TEXT, chat TEXT, message TEXT, at INTEGER, PRIMARY KEY(account,chat,message));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, updated INTEGER NOT NULL);`);
  return db;
}
export function isTaskSourceRecalled(event: RecallIdentity, stateDir?:string): boolean {
  const db = database(stateDir);
  try { return Boolean(db.prepare("SELECT 1 FROM recalls WHERE account=? AND chat=? AND message=?").get(event.accountId, event.chatId, event.messageId)); }
  finally { db.close(); }
}

/** Called only by the authenticated channel event dispatcher, never from model text. */
export function recallTaskSource(event: RecallIdentity): void {
  if (!event.accountId || !event.chatId || !event.messageId) throw Error("Incomplete recall identity");
  const db = database();
  try { db.prepare("INSERT OR IGNORE INTO recalls VALUES (?,?,?,?)").run(event.accountId, event.chatId, event.messageId, Date.now()); }
  finally { db.close(); }
  // Repeat events intentionally reattempt background cancellation after an I/O failure.
  // In-memory invalidation is idempotent and runs before any asynchronous cleanup.
  const failures: unknown[] = [];
  for (const task of tasks) {
    try { task.recall(event); } catch (error) { failures.push(error); }
  }
  for (const handler of sourceTaskBridge.recalls) {
    try { handler(event); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Background recall cancellation failed");
}

export class SourceTask {
  readonly id: string;
  readonly stopped = new AbortController();
  readonly sources = new Map<string, TaskSource>();
  readonly withdrawn = new Set<string>();
  revision = 0;
  private controller?: AbortController;
  private lease?: TaskLease;
  private status = "queued";
  constructor(readonly scope: { accountId: string; chatId: string; sessionKey: string; senderId: string; chatType?:FeishuChatType; rootId?: string; replyInThread?: boolean; people?:TaskPeople }, sources: TaskSource[]) {
    const {people: _people, chatType: _chatType, ...sourceIdentity} = scope;
    this.id = "ada_" + createHash("sha256").update(JSON.stringify([sourceIdentity, sources.map(s => s.messageId).sort()])).digest("hex").slice(0, 24);
    for (const source of sources) {
      this.sources.set(source.messageId, source);
      if (isTaskSourceRecalled({ ...scope, messageId: source.messageId })) this.withdrawn.add(source.messageId);
    }
    this.revision = this.withdrawn.size;
    if (!this.remainingRequests().length) this.stopped.abort();
    this.persist();
    tasks.add(this);
  }
  remaining() { return [...this.sources.values()].filter(source => !this.withdrawn.has(source.messageId)); }
  remainingRequests() { return this.remaining().filter(source => source.kind !== "reference"); }
  attachments(): TaskAttachment[] {return this.remaining().flatMap(source=>(source.attachments??[]).map(item=>({...item,messageId:source.messageId})));}
  private persist() {
    const db = database();
    try { db.prepare("INSERT OR REPLACE INTO tasks VALUES (?,?,?)").run(this.id, JSON.stringify({
      ...this.scope, revision: this.revision, status: this.status,
      sourceMessageIds: [...this.sources.keys()], withdrawnMessageIds: [...this.withdrawn],
    }), Date.now()); } finally { db.close(); }
  }
  add(source: TaskSource) {
    this.sources.set(source.messageId, source);
    if (this.lease) { this.lease.sourceMessageIds = this.remaining().map(s => s.messageId); this.lease.requestMessageIds = this.remainingRequests().map(s => s.messageId); this.lease.attachments=this.attachments(); }
    if (isTaskSourceRecalled({ ...this.scope, messageId: source.messageId })) this.recall({ ...this.scope, messageId: source.messageId });
    this.persist();
  }
  recall(event: RecallIdentity) {
    if (event.accountId !== this.scope.accountId || event.chatId !== this.scope.chatId || !this.sources.has(event.messageId) || this.withdrawn.has(event.messageId)) return;
    this.withdrawn.add(event.messageId);
    if(this.lease)this.lease.attachments=this.attachments();
    this.revision++;
    this.status = this.remainingRequests().length ? "adjusting" : "cancelled";
    this.controller?.abort();
    if (!this.remainingRequests().length) this.stopped.abort();
    this.persist();
  }
  begin(): TaskLease {
    this.controller = new AbortController();
    if (this.stopped.signal.aborted) this.controller.abort();
    this.lease = { ...this.scope, taskId: this.id, revision: this.revision,
      ...(this.attachments().length?{attachments:this.attachments()}:{}),
      sourceMessageIds: this.remaining().map(source => source.messageId), requestMessageIds: this.remainingRequests().map(s => s.messageId), signal: this.controller.signal };
    this.status = this.stopped.signal.aborted ? "cancelled" : "queued";
    this.persist();
    return this.lease;
  }
  activate() {
    if (this.lease && !this.lease.signal.aborted) {
      this.status = "running"; this.persist();
      sourceTaskBridge.leases.set(sourceLeaseKey(this.scope.accountId, this.scope.sessionKey), this.lease);
    }
  }
  endRevision() {
    if (sourceTaskBridge.leases.get(sourceLeaseKey(this.scope.accountId, this.scope.sessionKey)) === this.lease) sourceTaskBridge.leases.delete(sourceLeaseKey(this.scope.accountId, this.scope.sessionKey));
  }
  close() {
    this.endRevision(); tasks.delete(this);
    this.status = this.stopped.signal.aborted ? "cancelled" : "settled";
    this.persist();
  }
  // Retain the old optional argument for callers; compact data now applies to all chats.
  instruction(referencesInContext = false, _options: {compactPrivate?: boolean} = {}) {
    const references=this.remaining().filter(s=>s.kind==='reference').map(s=>s.messageId);
    return renderContextData('TaskSource', {taskId:this.id, revision:this.revision, sourceMessageIds:this.remaining().map(s => s.messageId), ...(references.length?{referenceMessageIds:references}:{})}) +
      (this.withdrawn.size ? "\n" + renderContextData('TaskSourceWithdrawal', {withdrawnMessageIds:[...this.withdrawn],cancellationRequested:true}) + "\n" + renderSection('RemainingMessages', JSON.stringify(this.remaining().map(s => referencesInContext && s.kind === "reference" ? {...s,text:"原文见本轮历史上下文"} : s))) : "");
  }
}

/** Completion events remain reference results, never new business authorization. */
export function isCompletionSourceCurrent(p: Pick<TaskLease,"taskId"|"revision"|"accountId"|"chatId"|"chatType"|"sessionKey"|"senderId"|"sourceMessageIds"|"attachmentSources">, stateDir?: string): boolean {
 const db = database(stateDir);
 try {
  const valid=(source:TaskAttachmentSource)=>{
   if(typeof source.taskId!=="string"||!Array.isArray(source.sourceMessageIds))return false;
   const row = db.prepare("SELECT metadata FROM tasks WHERE id=?").get(source.taskId) as {metadata: string} | undefined;
   if (!row) return false;
   const current = JSON.parse(row.metadata);
   if (current.revision !== source.revision || current.status === "cancelled" || current.accountId !== source.accountId || current.chatId !== source.chatId || current.sessionKey !== source.sessionKey || current.senderId !== source.senderId) return false;
   if (current.sourceMessageIds.length !== source.sourceMessageIds.length || current.sourceMessageIds.some((id: string) => !source.sourceMessageIds.includes(id))) return false;
   return source.sourceMessageIds.every(messageId => !db.prepare("SELECT 1 FROM recalls WHERE account=? AND chat=? AND message=?").get(source.accountId, source.chatId, messageId));
  };
  if(!valid(p))return false;
  if(p.attachmentSources!==undefined&&(!Array.isArray(p.attachmentSources)||p.attachmentSources.length>64))return false;
  return (p.attachmentSources??[]).every(source=>source&&source.accountId===p.accountId&&source.chatId===p.chatId&&source.sessionKey===p.sessionKey&&source.senderId===p.senderId&&valid(source));
 } finally {db.close();}
}
