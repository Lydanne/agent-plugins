import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
export function automationDeletionBlocked(state,jobs){
 const ids=jobs.filter(j=>j.provenance?.automation).map(j=>j.provenance.automation.taskId);if(!ids.length)return false;
 const file=join(state,'automation','automation.sqlite');if(!existsSync(file))return true;
 let db;try{db=new DatabaseSync(file,{readOnly:true});return ids.some(id=>{const row=db.prepare('SELECT body FROM tasks WHERE id=?').get(id);if(!row)return true;const t=JSON.parse(row.body);return !['completed','failed','cancelled'].includes(t.state)||!t.settled;});}catch{return true;}finally{db?.close();}
}
