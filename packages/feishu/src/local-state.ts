import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getFeishuRuntime } from './runtime.js';

export function localStatePath(): string {
  return join(getFeishuRuntime().state.resolveStateDir(), 'feishu-conversation', 'state.sqlite');
}
export function localTransaction<T>(path: string, fn: (db: DatabaseSync) => T): T {
  mkdirSync(dirname(path), {recursive:true,mode:0o700});
  const db = new DatabaseSync(path);
  try {
    chmodSync(path,0o600);
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS plugin_records (scope TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, stamp INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,id)); BEGIN IMMEDIATE');
    const result=fn(db); db.exec('COMMIT'); return result;
  } catch(error) { if(db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally {db.close();}
}
export function localStore<T>(scope:string,path=localStatePath(),maxEntries=128) {
  return {
    async lookup(id:string):Promise<T|undefined> {return localTransaction(path,db=>{
      const row=db.prepare('SELECT value FROM plugin_records WHERE scope=? AND id=?').get(scope,id) as {value:string}|undefined;
      return row ? JSON.parse(row.value) as T : undefined;
    });},
    async register(id:string,value:T):Promise<void> {localTransaction(path,db=>{
      db.prepare('INSERT INTO plugin_records VALUES (?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET stamp=excluded.stamp,value=excluded.value').run(scope,id,'value',Date.now(),JSON.stringify(value));
      db.prepare('DELETE FROM plugin_records WHERE scope=? AND id NOT IN (SELECT id FROM plugin_records WHERE scope=? ORDER BY stamp DESC LIMIT ?)').run(scope,scope,maxEntries);
    });},
  };
}
