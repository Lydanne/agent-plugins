import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {join} from 'node:path';

export const repositoryDatabaseName='agent_repo.sqlite';
const version=1;
let savepointSequence=0;

function regularFile(file){
 try{const stat=lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile())throw Error('资料存储文件无效');return true;}
 catch(error){if(error.code==='ENOENT')return false;throw error;}
}
function sidecars(file){for(const suffix of ['-wal','-shm','-journal'])regularFile(file+suffix);}
export function privateFile(root,parts){
 let path=realpathSync(root);
 for(const part of ['.runtime',...parts.slice(0,-1)]){
  path=join(path,part);mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('资料存储目录无效');chmodSync(path,0o700);
 }
 path=join(path,parts.at(-1));regularFile(path);sidecars(path);return path;
}
/** Read historical files without creating directories, changing modes or following links. */
export function legacyDatabasePath(root,parts){
 let path=realpathSync(root);
 for(const part of ['.runtime',...parts.slice(0,-1)]){
  path=join(path,part);let stat;try{stat=lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('旧资料存储目录无效');
 }
 path=join(path,parts.at(-1));if(!regularFile(path))return null;sidecars(path);return path;
}

/** Callbacks are synchronous. Nested writes use savepoints on the same connection. */
export function databaseTransaction(db,callback,{dryRun=false}={}){
 const nested=db.isTransaction,savepoint='repo_tx_'+(++savepointSequence);
 db.exec(nested?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');
 try{
  const result=callback(db);
  if(result&&typeof result.then==='function')throw Error('数据库事务回调必须同步完成');
  if(dryRun)db.exec(nested?'ROLLBACK TO '+savepoint:'ROLLBACK');
  if(nested)db.exec('RELEASE '+savepoint);else if(!dryRun)db.exec('COMMIT');
  return result;
 }catch(error){
  if(db.isTransaction){if(nested){db.exec('ROLLBACK TO '+savepoint);db.exec('RELEASE '+savepoint);}else db.exec('ROLLBACK');}
  throw error;
 }
}
export function migrateDatabase(db,name,callback){
 if(db.prepare('SELECT 1 FROM repo_schema_migrations WHERE name=?').get(name))return;
 return databaseTransaction(db,()=>{
  if(db.prepare('SELECT 1 FROM repo_schema_migrations WHERE name=?').get(name))return;
  const result=callback(db);if(result&&typeof result.then==='function')throw Error('数据库迁移回调必须同步完成');
  db.prepare('INSERT INTO repo_schema_migrations VALUES(?,?)').run(name,new Date().toISOString());
 });
}

const schema=`
 CREATE TABLE repo_schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
 CREATE TABLE graph_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE graph_sources(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE entity_types(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE graph_relation_types(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE graph_nodes(id TEXT PRIMARY KEY,type_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES graph_sources(id),external_id TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(type_id,source_id,external_id));
 CREATE INDEX graph_nodes_type ON graph_nodes(type_id,status);
 CREATE TABLE graph_edges(id TEXT PRIMARY KEY,type_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES graph_sources(id),external_id TEXT NOT NULL,from_id TEXT NOT NULL REFERENCES graph_nodes(id),to_id TEXT NOT NULL REFERENCES graph_nodes(id),status TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(type_id,source_id,external_id));
 CREATE INDEX graph_edges_from ON graph_edges(from_id,type_id,status);
 CREATE INDEX graph_edges_to ON graph_edges(to_id,type_id,status);
 CREATE TABLE graph_people(id TEXT PRIMARY KEY,node_id TEXT NOT NULL UNIQUE REFERENCES graph_nodes(id),value TEXT NOT NULL);
 CREATE TABLE graph_audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,evidence TEXT NOT NULL);
 CREATE INDEX graph_audit_target ON graph_audit(target_id,at DESC);
 CREATE TABLE graph_operations(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL);
 CREATE TABLE graph_snapshots(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,watermark TEXT NOT NULL,value TEXT NOT NULL);
 CREATE INDEX graph_snapshots_source ON graph_snapshots(source_id,watermark);
 CREATE TABLE recycle_items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,deleted INTEGER NOT NULL,revision TEXT NOT NULL,name TEXT NOT NULL);
 CREATE TABLE audit_events(id TEXT PRIMARY KEY,agent TEXT NOT NULL,feature TEXT NOT NULL,target TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);
 CREATE INDEX audit_time ON audit_events(agent,at DESC,id DESC);
 CREATE INDEX audit_scope ON audit_events(agent,feature,target,at);
 CREATE TABLE hidden_logs(agent TEXT,name TEXT,batch TEXT,deleted INTEGER,revision TEXT,PRIMARY KEY(agent,name));
 CREATE TABLE recycle_settings(agent TEXT PRIMARY KEY,body TEXT);
 CREATE TABLE recycle_operations(agent TEXT,id TEXT,input TEXT,result TEXT,PRIMARY KEY(agent,id));
 CREATE TABLE recycle_cleanup(agent TEXT PRIMARY KEY,body TEXT);
`;
const graphTables=['graph_meta','graph_sources','entity_types','graph_relation_types','graph_nodes','graph_edges','graph_people','graph_audit','graph_operations','graph_snapshots','recycle_items'];
const legacyFiles=[
 {parts:['entities','entities.sqlite'],tables:Object.fromEntries([...graphTables,'entities'].map(name=>[name,name]))},
 {parts:['audit','audit.sqlite'],tables:{audit_events:'audit_events'}},
 {parts:['recycled-logs','logs.sqlite'],tables:{hidden_logs:'hidden_logs'}},
 {parts:['recycle-bin','settings.sqlite'],tables:{settings:'recycle_settings',operations:'recycle_operations',cleanup:'recycle_cleanup'}},
];
function importLegacy(db,root){
 for(const {parts,tables} of legacyFiles){
  const file=legacyDatabasePath(root,parts);if(!file)continue;
  const old=new DatabaseSync(file,{readOnly:true});
  try{
   old.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN');
   if(old.prepare('PRAGMA user_version').get().user_version!==0)throw Error('Unsupported legacy database version');
   const found=old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>row.name);
   if(found.some(name=>!Object.hasOwn(tables,name)))throw Error('旧数据库含不支持的数据表，请先核对版本');
   for(const [source,target] of Object.entries(tables)){
    if(!found.includes(source))continue;
    // v1 JSON entities are transformed by graph-storage after the copy commits.
    if(source==='entities')db.exec('CREATE TABLE entities(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const columns=db.prepare(`PRAGMA table_info(${target})`).all().map(row=>row.name),previous=old.prepare(`PRAGMA table_info(${source})`).all().map(row=>row.name);
    if(columns.length!==previous.length||columns.some((name,index)=>name!==previous[index]))throw Error('旧数据库字段版本不兼容');
    const insert=db.prepare(`INSERT INTO ${target} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
    let copied=0;for(const row of old.prepare(`SELECT * FROM ${source}`).iterate()){insert.run(...columns.map(name=>row[name]));copied++;}
    if(copied!==old.prepare(`SELECT count(*) AS n FROM ${source}`).get().n)throw Error('旧数据库迁移数量不一致');
   }
  }finally{old.close();}
 }
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('旧数据库关系完整性校验失败');
}
export function openRepositoryDatabase(root){
 const file=privateFile(root,[repositoryDatabaseName]),db=new DatabaseSync(file);
 try{
  chmodSync(file,0o600);db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF');
  const current=db.prepare('PRAGMA user_version').get().user_version;
  if(current<0||current>version)throw Error('AgentRepo 数据库版本不受当前代码支持，禁止降级或猜测写入');
  if(current===0)databaseTransaction(db,()=>{
   // A competing process may have completed migration while BEGIN was waiting.
   if(db.prepare('PRAGMA user_version').get().user_version!==0)return;
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get())throw Error('AgentRepo 数据库缺少版本信息，请先核对');
   db.exec(schema);importLegacy(db,root);
   db.prepare('INSERT INTO repo_schema_migrations VALUES(?,?)').run('database-v1',new Date().toISOString());db.exec('PRAGMA user_version=1');
  });
  if(!db.prepare("SELECT 1 FROM repo_schema_migrations WHERE name='database-v1'").get())throw Error('AgentRepo 数据库迁移记录缺失');
  db.exec('PRAGMA journal_mode=WAL');
  return db;
 }catch(error){db.close();throw error;}
}
export function withRepositoryDatabase(root,callback){
 const db=openRepositoryDatabase(root);
 try{const result=callback(db);if(result&&typeof result.then==='function')throw Error('数据库连接回调必须同步完成');return result;}finally{db.close();}
}
export function repositoryTransaction(root,callback,options){return withRepositoryDatabase(root,db=>databaseTransaction(db,callback,options));}
