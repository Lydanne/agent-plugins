import {createHash} from "node:crypto";
import {chmodSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {CompletionEvent} from "./codex-completion.js";

export type PreparedCompletion = {text: string; mediaUrl?: string; mediaUrls?: string[]};
const fingerprint = (event: CompletionEvent) => createHash("sha256").update(JSON.stringify(event)).digest("hex");
function database(stateDir: string) {
 const directory=join(stateDir,"feishu-completion-outbox");
 mkdirSync(directory,{recursive:true,mode:0o700});
 const file=join(directory,"outbox.sqlite"),db=new DatabaseSync(file);
 chmodSync(file,0o600);
 db.exec("PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS drafts (job TEXT PRIMARY KEY, event_hash TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL)");
 return db;
}

/** Store only Ada's final accepted prose, before document preparation or visible delivery. */
export function savePreparedCompletion(stateDir: string,event: CompletionEvent,sessionId: string,payload: PreparedCompletion) {
 const db=database(stateDir);
 try {db.prepare("INSERT OR REPLACE INTO drafts VALUES (?,?,?,?)").run(event.jobId,fingerprint(event),sessionId,JSON.stringify(payload));}
 finally {db.close();}
}

/** Retry delivery without resubmitting a deduplicated model turn or changing its task authority. */
export function readPreparedCompletion(stateDir: string,event: CompletionEvent,sessionId: string): PreparedCompletion | undefined {
 const db=database(stateDir);
 try {
  const row=db.prepare("SELECT event_hash,session,payload FROM drafts WHERE job=?").get(event.jobId) as {event_hash:string;session:string;payload:string}|undefined;
  if(!row || row.event_hash!==fingerprint(event) || row.session!==sessionId)return;
  const payload:PreparedCompletion=JSON.parse(row.payload);
  if(typeof payload.text!=="string" || (payload.mediaUrl!==undefined && typeof payload.mediaUrl!=="string") ||
   (payload.mediaUrls!==undefined && (!Array.isArray(payload.mediaUrls) || !payload.mediaUrls.every(url=>typeof url==="string"))))throw Error("Invalid prepared completion payload");
  return payload;
 } finally {db.close();}
}

export function clearPreparedCompletion(stateDir: string,event: CompletionEvent) {
 const db=database(stateDir);
 try {db.prepare("DELETE FROM drafts WHERE job=? AND event_hash=?").run(event.jobId,fingerprint(event));}
 finally {db.close();}
}
