import {databaseTransaction} from './database.mjs';
// Native force queue entries survive enabled=false. Keep terminal identity and
// consume reservations atomically; recovery must not discard this evidence.
export function nativeRunFence(db){
 db.exec(`CREATE TABLE IF NOT EXISTS revoked_native_runs(job TEXT,run_id TEXT,PRIMARY KEY(job,run_id));
 CREATE TABLE IF NOT EXISTS native_run_receipts(job TEXT,slot INTEGER,run_id TEXT,status TEXT,PRIMARY KEY(job,slot));
 CREATE INDEX IF NOT EXISTS native_receipt_id ON native_run_receipts(job,run_id);
 CREATE TABLE IF NOT EXISTS revoked_native_slots(job TEXT,slot INTEGER,PRIMARY KEY(job,slot));`);
 const valid=id=>typeof id==='string'&&id.length>0;
 const has=(job,id,slot)=>valid(id)?!!db.prepare('SELECT 1 FROM revoked_native_runs WHERE job=? AND run_id=?').get(job,id):Number.isSafeInteger(slot)&&!!db.prepare('SELECT 1 FROM revoked_native_slots WHERE job=? AND slot=?').get(job,slot);
 const receipt=(job,id)=>valid(id)?db.prepare('SELECT slot,run_id,status FROM native_run_receipts WHERE job=? AND run_id=? ORDER BY slot LIMIT 1').get(job,id):undefined;
 const revoke=(job,id)=>{if(!valid(id))return false;db.prepare('INSERT OR IGNORE INTO revoked_native_runs VALUES(?,?)').run(job,id);db.prepare('INSERT OR IGNORE INTO revoked_native_slots SELECT job,slot FROM native_run_receipts WHERE job=? AND run_id=?').run(job,id);return true;};
 return {has,receipt,revoke,
  record(job,event){if(event.recovery)return;db.prepare(`INSERT INTO native_run_receipts VALUES(?,?,?,?) ON CONFLICT(job,slot) DO UPDATE SET run_id=COALESCE(excluded.run_id,native_run_receipts.run_id),status=CASE WHEN excluded.run_id IS NOT NULL THEN excluded.status ELSE native_run_receipts.status END`).run(job,event.runAtMs,valid(event.runId)?event.runId:null,event.status??'unknown');if(has(job,event.runId))db.prepare('INSERT OR IGNORE INTO revoked_native_slots VALUES(?,?)').run(job,event.runAtMs);},
  resolve(job,event){if(valid(event.runId))return event.runId;const row=db.prepare('SELECT run_id FROM native_run_receipts WHERE job=? AND slot=?').get(job,event.runAtMs);if(row)return row.run_id??undefined;
   // Live automatic cron events omit runId in the supported SDK. Only a
   // state-only recovery lacks trusted evidence of how this occurrence ran.
   return event.recovery&&db.prepare('SELECT 1 FROM revoked_native_runs WHERE job=? LIMIT 1').get(job)?null:undefined;
  },
  consume(job,id,save){if(!valid(id))return false;return databaseTransaction(db,()=>{revoke(job,id);save();return true;});},
 };
}
