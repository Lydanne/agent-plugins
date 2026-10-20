import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskLease } from "./source-task.js";
import { withinCardTableLimit } from "./presentation-card.js";
import {renderBusinessMessage} from "./business-config.js";
import type {FeishuConfig} from "./types.js";
import { workingResultCard } from "./working-card.js";

type Source = Pick<TaskLease, "taskId" | "revision" | "accountId" | "chatId" | "sessionKey" | "senderId">;
export type AsyncTaskCard = Source & {jobId: string; messageId: string; imageKey?: string; result?: string; progress?: string; questionMessageId?: string; continuationQuestionIds?: string[]; originalMessageId?: string};
const sameSource = (a: Source, b: Source) =>
  a.taskId === b.taskId && a.revision === b.revision && a.accountId === b.accountId &&
  a.chatId === b.chatId && a.sessionKey === b.sessionKey && a.senderId === b.senderId;

function database(stateDir: string) {
  const dir = join(stateDir, "feishu-async-cards");
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = join(dir, "cards.sqlite");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS cards (job TEXT PRIMARY KEY, metadata TEXT NOT NULL)");
  return db;
}

/** Idempotent ownership: a retry cannot steal the original task's card. */
export function bindAsyncTaskCard(stateDir: string, source: Source, jobs: string[], card: {messageId: string; imageKey?: string}) {
  const db = database(stateDir);
  try {
    for (const jobId of jobs) {
      db.prepare("INSERT OR IGNORE INTO cards VALUES (?,?)").run(jobId, JSON.stringify({...source, ...card, jobId}));
    }
  } finally { db.close(); }
}

export function readAsyncTaskCard(stateDir: string, jobId: string, source: Source): AsyncTaskCard | undefined {
  const db = database(stateDir);
  try {
    const row = db.prepare("SELECT metadata FROM cards WHERE job=?").get(jobId) as {metadata: string} | undefined;
    const card: AsyncTaskCard | undefined = row ? JSON.parse(row.metadata) : undefined;
    return card && sameSource(card, source) ? card : undefined;
  } finally { db.close(); }
}

/** Completion turns share the human FIFO, so updates to one card are serialized. */
export function prepareAsyncCardResult(stateDir: string, binding: AsyncTaskCard, text: string, config: Pick<FeishuConfig,"workingCard"|"businessMessages"> = {}) {
  const db = database(stateDir);
  let siblings: AsyncTaskCard[];
  try {
    siblings = (db.prepare("SELECT metadata FROM cards ORDER BY rowid").all() as {metadata: string}[])
      .map(row => JSON.parse(row.metadata) as AsyncTaskCard)
      .filter(card => card.messageId === binding.messageId && card.accountId===binding.accountId && card.chatId===binding.chatId && card.sessionKey===binding.sessionKey && card.senderId===binding.senderId)
      .map(card => card.jobId === binding.jobId ? {...card, result: text} : card);
  } finally { db.close(); }
  const results = siblings.filter(card => card.result !== undefined || card.progress !== undefined).map(card => card.result ?? card.progress!);
  const combined = results.join("\n\n---\n\n");
  const remaining = siblings.some(card => card.result === undefined);
  const card = workingResultCard(combined,config);
  if (remaining && binding.imageKey) {
    const body = card.body as {elements: Record<string, unknown>[]};
    body.elements.unshift({tag: "img", img_key: binding.imageKey, alt: {tag: "plain_text", content: renderBusinessMessage(config.businessMessages,"workingAlt")}, scale_type: "crop_center", size: config.workingCard?.imageSize ?? "240px 240px", preview: false});
  }
  return {card, combined, fits: Buffer.byteLength(JSON.stringify(card), "utf8") <= 28_000 && withinCardTableLimit(combined)};
}

/** Save accepted output only after Feishu confirmed the edit/send. */
export function acceptAsyncCardResult(stateDir: string, binding: AsyncTaskCard, text: string) {
  const db = database(stateDir);
  try {db.prepare("UPDATE cards SET metadata=? WHERE job=?").run(JSON.stringify({...binding, result: text}), binding.jobId);}
  finally {db.close();}
}

/** Presentation follows a new human reply; business ownership remains the original source. */
export function continueAsyncTaskCard(stateDir: string, source: Source, jobId: string, questionId: string, card: {messageId: string; imageKey?: string}): boolean {
 const db=database(stateDir);
 try {
  db.exec("BEGIN IMMEDIATE");
  const row=db.prepare("SELECT metadata FROM cards WHERE job=?").get(jobId) as {metadata:string}|undefined;
  const binding:AsyncTaskCard|undefined=row?JSON.parse(row.metadata):undefined;
  if(!binding){
   db.prepare("INSERT INTO cards VALUES (?,?)").run(jobId,JSON.stringify({...source,...card,jobId,continuationQuestionIds:[questionId]}));db.exec("COMMIT");return true;
  }
  if(!sameSource(binding,source) || binding.result!==undefined || binding.continuationQuestionIds?.includes(questionId)){db.exec("ROLLBACK");return false;}
  const next:AsyncTaskCard={...binding,...card,originalMessageId:binding.originalMessageId??binding.messageId,continuationQuestionIds:[...(binding.continuationQuestionIds??[]),questionId]};
  delete next.progress;
  db.prepare("UPDATE cards SET metadata=? WHERE job=?").run(JSON.stringify(next),jobId);db.exec("COMMIT");return true;
 } finally {db.close();}
}

export function saveAsyncCardQuestion(stateDir:string, source:Source, jobId:string, messageId:string) {
 const binding=readAsyncTaskCard(stateDir,jobId,source);if(!binding)return;
 const db=database(stateDir);
 try {db.prepare("UPDATE cards SET metadata=? WHERE job=?").run(JSON.stringify({...binding,questionMessageId:messageId}),jobId);} finally {db.close();}
}

export function acceptAsyncCardProgress(stateDir:string, binding:AsyncTaskCard, progress:string) {
 const current=readAsyncTaskCard(stateDir,binding.jobId,binding);if(!current || current.messageId!==binding.messageId || current.result!==undefined)return;
 const db=database(stateDir);
 try {db.prepare("UPDATE cards SET metadata=? WHERE job=?").run(JSON.stringify({...current,progress}),binding.jobId);} finally {db.close();}
}

/** The initial card is an overview; detailed results stay on each continuation card. */
export function prepareAsyncOriginalOverview(stateDir:string, binding:AsyncTaskCard, status:string, config:Pick<FeishuConfig,"workingCard"|"businessMessages">={}) {
 if(!binding.originalMessageId || binding.originalMessageId===binding.messageId)return undefined;
 const db=database(stateDir);
 try {
  const siblings=(db.prepare("SELECT metadata FROM cards ORDER BY rowid").all() as {metadata:string}[]).map(row=>JSON.parse(row.metadata) as AsyncTaskCard)
   .filter(card=>(card.messageId===binding.originalMessageId||card.originalMessageId===binding.originalMessageId)&&card.accountId===binding.accountId&&card.chatId===binding.chatId&&card.sessionKey===binding.sessionKey&&card.senderId===binding.senderId);
  const label=({completed:"已完成",failed:"失败",timed_out:"超时",cancelled:"已取消"} as Record<string,string>)[status]??"已结束";
  const text=siblings.map(card=>card.jobId===binding.jobId?`任务${label}，结果见本轮最新工作消息。`:card.messageId===binding.originalMessageId&&card.result!==undefined?card.result:card.result!==undefined?"任务已结束，结果见后续工作消息。":card.progress??"任务仍在处理中，进度见对应工作消息。").join("\n\n---\n\n");
  const card=workingResultCard(text,config);
  return Buffer.byteLength(JSON.stringify(card),"utf8")<=28_000&&withinCardTableLimit(text)?card:undefined;
 } finally {db.close();}
}

export function sharesAsyncTaskCard(stateDir:string,binding:AsyncTaskCard):boolean {
 const db=database(stateDir);try{return (db.prepare("SELECT metadata FROM cards").all() as {metadata:string}[]).map(row=>JSON.parse(row.metadata) as AsyncTaskCard).some(other=>other.jobId!==binding.jobId&&other.messageId===binding.messageId&&other.accountId===binding.accountId&&other.chatId===binding.chatId);}finally{db.close();}
}
