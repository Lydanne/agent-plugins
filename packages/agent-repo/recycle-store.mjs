import {randomUUID} from 'node:crypto';
export const dayMs=86400000;
export function recycleTable(db){db.exec('CREATE TABLE IF NOT EXISTS recycle_items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,deleted INTEGER NOT NULL,revision TEXT NOT NULL,name TEXT NOT NULL)');}
export function recyclePut(db,{id,kind,name,deletedAt=Date.now(),revision=randomUUID()}){db.prepare('INSERT INTO recycle_items VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET deleted=recycle_items.deleted,revision=excluded.revision,name=excluded.name').run(id,kind,deletedAt,revision,name);}
export function recycleRows(db){return db.prepare('SELECT * FROM recycle_items ORDER BY deleted DESC,id').all().map(r=>({id:r.id,kind:r.kind,name:r.name,deletedAt:r.deleted,revision:r.revision,feature:'entities',provider:'entities'}));}
export function recycleEntry(db,id,expectedRevision){const row=db.prepare('SELECT * FROM recycle_items WHERE id=?').get(id);if(!row||row.revision!==expectedRevision)throw Error('回收站记录已变化，请刷新');return row;}
