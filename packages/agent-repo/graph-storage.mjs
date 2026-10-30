import {recycleTable,recyclePut} from './recycle-store.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,realpathSync,chmodSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const revision=()=>randomUUID();
export const now=()=>new Date().toISOString();
export function privateFile(root,parts){
 let path=realpathSync(root);
 for(const part of ['.runtime',...parts.slice(0,-1)]){path=join(path,part);mkdirSync(path,{recursive:true,mode:0o700});const st=lstatSync(path);if(st.isSymbolicLink()||!st.isDirectory())throw Error('资料存储目录无效');chmodSync(path,0o700);}
 path=join(path,parts.at(-1));try{const st=lstatSync(path);if(st.isSymbolicLink()||!st.isFile())throw Error('资料存储文件无效');}catch(error){if(error.code!=='ENOENT')throw error;}return path;
}
export function putNode(db,node){db.prepare('INSERT INTO graph_nodes(id,type_id,source_id,external_id,status,value) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value').run(node.id,node.typeId,node.sourceId,node.source.externalId,node.status??'active',JSON.stringify(node));}
export const nodeById=(db,id)=>{const r=db.prepare('SELECT value FROM graph_nodes WHERE id=?').get(id);return r?JSON.parse(r.value):null;};
export function sourceRecord(db,source){
 const id='source:'+hash([source.kind,source.namespace,source.scope??'default']);
 db.prepare('INSERT OR IGNORE INTO graph_sources VALUES (?,?)').run(id,JSON.stringify({id,kind:source.kind,namespace:source.namespace,scope:source.scope??'default'}));return id;
}
export function audit(db,actor,action,id,before,after,evidence){db.prepare('INSERT INTO graph_audit VALUES(?,?,?,?,?,?,?,?)').run(revision(),now(),actor,action,id,JSON.stringify(before),JSON.stringify(after),JSON.stringify(evidence??null));}
export function graphDatabase(root){
 const path=privateFile(root,['entities','entities.sqlite']),db=new DatabaseSync(path);chmodSync(path,0o600);
 try{
 db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS graph_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS graph_sources(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS entity_types(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS graph_relation_types(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS graph_nodes(id TEXT PRIMARY KEY,type_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES graph_sources(id),external_id TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(type_id,source_id,external_id));
 CREATE INDEX IF NOT EXISTS graph_nodes_type ON graph_nodes(type_id,status);
 CREATE TABLE IF NOT EXISTS graph_edges(id TEXT PRIMARY KEY,type_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES graph_sources(id),external_id TEXT NOT NULL,from_id TEXT NOT NULL REFERENCES graph_nodes(id),to_id TEXT NOT NULL REFERENCES graph_nodes(id),status TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(type_id,source_id,external_id));
 CREATE INDEX IF NOT EXISTS graph_edges_from ON graph_edges(from_id,type_id,status);
 CREATE INDEX IF NOT EXISTS graph_edges_to ON graph_edges(to_id,type_id,status);
 CREATE TABLE IF NOT EXISTS graph_people(id TEXT PRIMARY KEY,node_id TEXT NOT NULL UNIQUE REFERENCES graph_nodes(id),value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS graph_audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,evidence TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS graph_operations(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS graph_snapshots(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,watermark TEXT NOT NULL,value TEXT NOT NULL);
 `);
 recycleTable(db);
 if(!db.prepare("SELECT 1 FROM graph_meta WHERE key='migration-v2'").get()){
  db.exec('BEGIN IMMEDIATE');try{
   if(db.prepare("SELECT 1 FROM graph_meta WHERE key='migration-v2'").get()){db.exec('COMMIT');return db;}
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").get()){
    for(const row of db.prepare('SELECT value FROM entities').all()){const old=JSON.parse(row.value),sourceId=sourceRecord(db,old.source);putNode(db,{...old,source:{...old.source,scope:old.source.scope??'default'},sourceId,status:'active'});}
    db.exec('DROP TABLE entities');
   }
   const legacy=join(realpathSync(root),'.runtime/people/people.sqlite');
   if(existsSync(legacy)){
    // Check every path component before opening the retired database read-only.
    for(const p of [join(realpathSync(root),'.runtime/people'),legacy])if(lstatSync(p).isSymbolicLink())throw Error('旧人员存储路径无效');
    const people=new DatabaseSync(legacy,{readOnly:true});try{for(const row of people.prepare('SELECT value FROM people').all())savePerson(db,JSON.parse(row.value),false);}finally{people.close();}
   }
   db.prepare('INSERT INTO graph_meta VALUES(?,?)').run('migration-v2',now());db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 if(!db.prepare("SELECT 1 FROM graph_meta WHERE key='recycle-v1'").get()){db.exec('BEGIN IMMEDIATE');try{for(const row of db.prepare("SELECT value FROM graph_nodes WHERE status='deleted'").all()){const node=JSON.parse(row.value);if(!node.legacyPersonId&&!db.prepare('SELECT 1 FROM recycle_items WHERE id=?').get(node.id))recyclePut(db,{id:node.id,kind:'entity',name:node.name,revision:node.revision});}db.prepare('INSERT OR IGNORE INTO graph_meta VALUES(?,?)').run('recycle-v1',now());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 return db;
 }catch(e){db.close();throw e;}
}
export function graphTransaction(root,callback,{dryRun=false}={}){const db=graphDatabase(root);try{db.exec('BEGIN IMMEDIATE');const result=callback(db);db.exec(dryRun?'ROLLBACK':'COMMIT');return result;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}}
export function personView(record){
 const {directory,overrides,...data}=record,merged={...directory,...overrides},prefix=merged.email?.split('@')[0],explicit=overrides.giteaUsername,valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
 return {...data,...merged,giteaUsername:explicit??(valid(prefix)?prefix:null),giteaSource:explicit?'admin':valid(prefix)?'email_prefix':'unknown'};
}
export function savePerson(db,record,recordAudit=true){
 const p=personView(record),id='person:'+p.id,source={kind:'channel',namespace:'feishu',scope:JSON.stringify([p.accountId,p.appId]),externalId:JSON.stringify([p.accountId,p.appId,p.openId])},sourceId=sourceRecord(db,source),before=nodeById(db,id);
 const node={id,typeId:'person',name:p.name||'姓名未知',summary:p.departments.map(d=>d.name||d.id).join('、'),attributes:{email:p.email,department:p.departments.map(d=>d.name||d.id).join('、'),giteaUsername:p.giteaUsername,giteaSource:p.giteaSource},sourceId,source,status:before?.status==='deleted'?'deleted':'active',observedAt:p.observedAt,updatedAt:p.updatedAt,revision:p.revision,legacyPersonId:p.id};
 putNode(db,node);db.prepare('INSERT OR REPLACE INTO graph_people VALUES(?,?,?)').run(p.id,id,JSON.stringify(record));
 if(!recordAudit){
  for(const department of record.directory.departments??[]){
   if(!department.id||typeof department.id!=='string')throw Error('旧人员部门身份无效');
   const externalId=department.id,departmentId='entity:'+hash(['department',source.kind,source.namespace,source.scope,externalId]),prior=nodeById(db,departmentId);
   if(!prior||prior.observedAt<p.observedAt)putNode(db,{id:departmentId,typeId:'department',name:department.name||department.id,summary:'历史飞书人员资料中的部门引用',attributes:{},sourceId,source:{...source,externalId},status:'active',observedAt:p.observedAt,updatedAt:p.updatedAt,revision:revision()});
   const edgeExternal=JSON.stringify([p.id,departmentId]),edgeId='relation:'+hash(['member_of',sourceId,edgeExternal]),edge={id:edgeId,typeId:'member_of',fromId:id,toId:departmentId,attributes:{},sourceId,source:{...source,externalId:edgeExternal},status:'active',observedAt:p.observedAt,updatedAt:p.updatedAt,revision:revision()};
   db.prepare('INSERT OR IGNORE INTO graph_edges VALUES(?,?,?,?,?,?,?,?)').run(edgeId,'member_of',sourceId,edgeExternal,id,departmentId,'active',JSON.stringify(edge));
  }
 }
 if(recordAudit)audit(db,'people-compat','observe_or_correct',id,before,node,{kind:'compatibility'});return p;
}
