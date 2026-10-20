import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export type ReceiptScope = {agentId: string; sessionId: string; accountId: string; chatId: string};
export const replyTextHash = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
const key = (scope: ReceiptScope) => JSON.stringify([scope.agentId, scope.sessionId, scope.accountId, scope.chatId]);
// Only provider receipt IDs and hashes; no chat bodies or identity profiles.
export function recordContextReceipts(path: string, scope: ReceiptScope, ids: string[], text: string): void {
  if (!ids.length || !text.trim()) return;
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS receipts (scope TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope,id))');
    db.exec('BEGIN IMMEDIATE');
    const now = Date.now();
    const statement = db.prepare('INSERT OR REPLACE INTO receipts VALUES (?,?,?,?)');
    for (const id of ids) statement.run(key(scope), id, replyTextHash(text), now);
    db.prepare('DELETE FROM receipts WHERE updated_at < ?').run(now - 30 * 86400000);
    db.exec('COMMIT');
  } finally {db.close();}
}
export function readContextReceipts(path: string, scope: ReceiptScope): Map<string, string> {
  if (!existsSync(path)) return new Map();
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const rows = db.prepare('SELECT id,hash FROM receipts WHERE scope=? ORDER BY updated_at DESC LIMIT 2000').all(key(scope)) as {id:string;hash:string}[];
    return new Map(rows.map(r => [r.id, r.hash]));
  } finally {db.close();}
}


// Replaceable index of confirmed visible context, never an append-only seen set.
type ContextStateScope = ReceiptScope & {sessionKey: string};
const stateKey = (scope: ContextStateScope) => JSON.stringify([scope.agentId,scope.sessionKey,scope.sessionId,scope.accountId,scope.chatId]);
export function readContextState(path: string, scope: ContextStateScope, snapshot: string): Map<string,string> | undefined {
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, {readOnly:true});
  try {
    const row = db.prepare('SELECT value FROM context_state WHERE scope=? AND snapshot=?').get(stateKey(scope),snapshot) as {value:string}|undefined;
    return row ? new Map(JSON.parse(row.value)) : undefined;
  } finally {db.close();}
}
export function recordContextState(path: string, scope: ContextStateScope, snapshot: string, known: Map<string,string>): void {
  mkdirSync(dirname(path), {recursive:true,mode:0o700});
  const db = new DatabaseSync(path); chmodSync(path,0o600);
  try {
    db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS context_state (scope TEXT PRIMARY KEY, snapshot TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO context_state VALUES (?,?,?,?)').run(stateKey(scope),snapshot,JSON.stringify([...known]),Date.now());
    db.prepare('DELETE FROM context_state WHERE updated_at < ?').run(Date.now()-30*86400000);
  } finally {db.close();}
}
