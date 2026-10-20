import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type MessageMetadata = { rootId?: string; threadId?: string; contentType?: string };
export type GroupMessage = MessageMetadata & { messageId: string; senderOpenId: string; timestamp: number; text: string };
export type Turn = { role: 'user' | 'assistant'; content: string };
export type WindowState = { expiresAt: number; lastMessageAt: number; lastMessageId: string; turns: Turn[] };
export type WindowMessage = MessageMetadata & { accountId: string; chatId: string; senderOpenId: string; messageId: string; timestamp: number; text: string; mentionedBot: boolean; replyChainMentionsBot?: boolean; mentionsOthers: boolean; isBot: boolean };
export type Classifier = (turns: Turn[], text: string) => Promise<string>;
export function windowKey(message: Pick<WindowMessage, 'accountId' | 'chatId' | 'senderOpenId'>): string {
  return JSON.stringify([message.accountId, message.chatId, message.senderOpenId]);
}
export class WindowStore {
  constructor(readonly path: string) {}
  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    try {
      db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS windows (key TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL)');
      return fn(db);
    } finally { db.close(); }
  }
  observe(message: WindowMessage, now: number): void {
    if (message.isBot || !message.senderOpenId || !message.messageId || !Number.isFinite(message.timestamp) || message.timestamp > now + 30000 || message.timestamp < now - 600000) return;
    this.withDb(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const active = db.prepare('SELECT key FROM windows WHERE expires > ?').all(now).some(row => {
          const [accountId, chatId] = JSON.parse(String(row.key));
          return accountId === message.accountId && chatId === message.chatId;
        });
        db.exec('CREATE TABLE IF NOT EXISTS group_context (scope TEXT NOT NULL, id TEXT NOT NULL, stamp INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,id))');
        db.prepare('DELETE FROM group_context WHERE stamp < ?').run(now - 86400000);
        if (active) {
          const scope = JSON.stringify([message.accountId, message.chatId]);
          const entry: GroupMessage = {messageId:message.messageId,senderOpenId:message.senderOpenId,timestamp:message.timestamp,rootId:message.rootId,threadId:message.threadId,contentType:message.contentType,text:message.text.slice(0,4000) || (message.contentType && message.contentType !== 'text' ? `[${message.contentType} message]` : '[用户 @ 助手，发起对话]')};
          db.prepare('INSERT OR IGNORE INTO group_context VALUES (?,?,?,?)').run(scope,message.messageId,message.timestamp,JSON.stringify(entry));
          db.prepare('DELETE FROM group_context WHERE scope=? AND id NOT IN (SELECT id FROM group_context WHERE scope=? ORDER BY stamp DESC,id DESC LIMIT 50)').run(scope,scope);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  recentGroup(message: Pick<WindowMessage, 'accountId' | 'chatId' | 'messageId'>, now: number): GroupMessage[] {
    return this.withDb(db => {
      db.exec('CREATE TABLE IF NOT EXISTS group_context (scope TEXT NOT NULL, id TEXT NOT NULL, stamp INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,id))');
      db.prepare('DELETE FROM group_context WHERE stamp < ?').run(now - 86400000);
      return db.prepare('SELECT value FROM group_context WHERE scope=? AND id!=? ORDER BY stamp,id').all(JSON.stringify([message.accountId,message.chatId]),message.messageId).map(row => JSON.parse(String(row.value)));
    });
  }
  get(key: string, now: number): WindowState | undefined {
    return this.withDb(db => {
      db.prepare('DELETE FROM windows WHERE expires <= ?').run(now);
      const row = db.prepare('SELECT value FROM windows WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : undefined;
    });
  }
  accept(key: string, message: WindowMessage, durationMs: number, now: number): boolean {
    return this.withDb(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT value FROM windows WHERE key = ?').get(key) as {value: string} | undefined;
        const old: WindowState | undefined = row ? JSON.parse(row.value) : undefined;
        if (old && (old.lastMessageId === message.messageId || message.timestamp <= old.lastMessageAt)) { db.exec('COMMIT'); return false; }
        // Recheck expiry after an asynchronous classifier call; stale messages never reopen a window.
        if (message.timestamp + durationMs <= now || (!(message.mentionedBot || message.replyChainMentionsBot) && (!old || old.expiresAt <= now))) { db.exec('COMMIT'); return false; }
        const turns = old && old.expiresAt > now ? old.turns : [];
        const state: WindowState = { expiresAt: message.timestamp + durationMs, lastMessageAt: message.timestamp, lastMessageId: message.messageId, turns: [...turns, {role:'user',content:message.text.trim() ? message.text.slice(0,2000) : message.replyChainMentionsBot ? '[用户回复含 @ 助手的消息链，发起对话]' : '[用户 @ 助手，发起对话]' }].slice(-8) as Turn[] };
        db.prepare('INSERT INTO windows VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET expires=excluded.expires,value=excluded.value').run(key,state.expiresAt,JSON.stringify(state));
        db.prepare('DELETE FROM windows WHERE expires <= ?').run(now);
        db.exec('COMMIT'); return true;
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    });
  }
  reply(key: string, messageId: string, text: string, now: number): void {
    this.withDb(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT value FROM windows WHERE key=? AND expires>?').get(key,now) as {value:string}|undefined;
        if (row) {
          const state: WindowState = JSON.parse(row.value);
          // A delayed reply to an older turn must not become context for a newer user task.
          if (state.lastMessageId === messageId) {
            state.turns = [...state.turns,{role:'assistant',content:text.slice(0,2000)}].slice(-8) as Turn[];
            db.prepare('UPDATE windows SET value=? WHERE key=?').run(JSON.stringify(state),key);
          }
        }
        db.exec('COMMIT');
      } catch(err) { db.exec('ROLLBACK'); throw err; }
    });
  }
}
export async function admitWindowMessage(store: WindowStore, message: WindowMessage, classify: Classifier, durationMs = 600000, clock = Date.now): Promise<boolean> {
  if (message.isBot || !message.senderOpenId || !message.messageId || !Number.isFinite(message.timestamp) || message.timestamp > clock() + 30000) return false;
  const key = windowKey(message);
  if (message.mentionedBot) return store.accept(key,message,durationMs,clock());
  if (message.mentionsOthers) return false;
  if (message.replyChainMentionsBot) return store.accept(key,message,durationMs,clock());
  if (!message.text.trim()) return false;
  const current = store.get(key,clock());
  if (!current || message.timestamp <= current.lastMessageAt || message.timestamp + durationMs <= clock()) return false;
  try {
    const verdict = await classify(current.turns,message.text.slice(0,4000));
    if (verdict.trim() !== 'directed') return false;
    return store.accept(key,message,durationMs,clock());
  } catch { return false; }
}
