import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync,readFileSync,statSync,symlinkSync,writeFileSync,unlinkSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {openRepositoryDatabase,withRepositoryDatabase,repositoryTransaction,databaseTransaction,migrateDatabase} from './database.mjs';
import {createEntityStore} from './entities.mjs';
import {createPeopleStore} from './people.mjs';
import {rootAudit,auditBegin,auditQuery} from './audit.mjs';
import {recycleSettings,configureRecycle} from './recycle-bin.mjs';
import {recycledRepositoryLogs} from './repository-log.mjs';
const stamp='2026-01-01T00:00:00.000Z';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'repo-database-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function oldFile(root,parts){const file=join(root,'.runtime',...parts);mkdirSync(join(file,'..'),{recursive:true});return file;}
function seedLegacy(root){
 const store=createEntityStore(root),source=store.forSource({kind:'program',namespace:'fixture',scope:'tenant',actor:'fixture',types:['person','department'],relations:['member_of']}),person=source.upsert({typeId:'person',externalId:'p',name:'Person',observedAt:stamp}).entity,department=source.upsert({typeId:'department',externalId:'d',name:'Dept',observedAt:stamp}).entity;
 const edge=source.connect({typeId:'member_of',externalId:'membership',fromId:person.id,toId:department.id,observedAt:stamp},{kind:'event',id:'membership-event'}).relation;
 const people=createPeopleStore(root),contact=people.observe({accountId:'a',appId:'app',openId:'ou_one',name:'Auto',email:'auto@example.invalid'});people.update({id:contact.id,revision:contact.revision,patch:{name:'Corrected',giteaUsername:'verified'}});
 const central=join(root,'.runtime/agent_repo.sqlite'),legacy=oldFile(root,['entities','entities.sqlite']);copyFileSync(central,legacy);
 const db=new DatabaseSync(legacy);db.exec('DROP TABLE graph_sync_runs;DROP TABLE audit_events;DROP TABLE hidden_logs;DROP TABLE recycle_settings;DROP TABLE recycle_operations;DROP TABLE recycle_cleanup;DROP TABLE repo_schema_migrations;PRAGMA user_version=0');db.prepare('INSERT INTO recycle_items VALUES(?,?,?,?,?)').run('trash-id','entity',123,'trash-revision','Trashed');db.close();unlinkSync(central);
 const audit=oldFile(root,['audit','audit.sqlite']),a=new DatabaseSync(audit);a.exec('CREATE TABLE audit_events(id TEXT PRIMARY KEY,agent TEXT NOT NULL,feature TEXT NOT NULL,target TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL)');a.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run('audit-id','main','logs','target',100,JSON.stringify({id:'audit-id',agentId:'main',feature:'logs',at:100,status:'succeeded'}));a.close();
 const recycle=oldFile(root,['recycle-bin','settings.sqlite']),r=new DatabaseSync(recycle);r.exec('CREATE TABLE settings(agent TEXT PRIMARY KEY,body TEXT);CREATE TABLE operations(agent TEXT,id TEXT,input TEXT,result TEXT,PRIMARY KEY(agent,id));CREATE TABLE cleanup(agent TEXT PRIMARY KEY,body TEXT)');r.prepare('INSERT INTO settings VALUES(?,?)').run('retention',JSON.stringify({retentionDays:17,revision:'settings-revision'}));r.prepare('INSERT INTO operations VALUES(?,?,?,?)').run('main','pending-request','digest',JSON.stringify({status:'pending'}));r.prepare('INSERT INTO cleanup VALUES(?,?)').run('main',JSON.stringify({at:99,status:'partial'}));r.close();
 const logs=oldFile(root,['recycled-logs','logs.sqlite']),l=new DatabaseSync(logs);l.exec('CREATE TABLE hidden_logs(agent TEXT,name TEXT,batch TEXT,deleted INTEGER,revision TEXT,PRIMARY KEY(agent,name))');l.prepare('INSERT INTO hidden_logs VALUES(?,?,?,?,?)').run('main','log.json','batch-id',123,'log-revision');l.close();
 return {person,edge,contact,files:[legacy,audit,recycle,logs]};
}

test('fresh repositories use one private, versioned WAL database and stay isolated',t=>{
 const root=fixture(t),db=openRepositoryDatabase(root);
 try{assert.equal(db.location(),join(realpathSync(root),'.runtime/agent_repo.sqlite'));assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout,5000);assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(statSync(db.location()).mode&0o777,0o600);assert.equal(statSync(join(root,'.runtime')).mode&0o777,0o700);}finally{db.close();}
 rootAudit(root,db=>auditBegin(db,{agentId:'main',feature:'logs',targetId:'x',action:'clear'}));recycleSettings(root,'main');assert.equal(rootAudit(root,db=>auditQuery(db,'main')).total,1);assert.equal(rootAudit(fixture(t),db=>auditQuery(db,'main')).total,0);
 for(const path of ['audit/audit.sqlite','entities/entities.sqlite','recycle-bin/settings.sqlite','recycled-logs/logs.sqlite'])assert.equal(existsSync(join(root,'.runtime',path)),false);
});

test('all legacy repository stores migrate once with IDs, pending receipts, audits and corrections intact',t=>{
 const root=fixture(t),seed=seedLegacy(root),before=seed.files.map(f=>readFileSync(f));
 assert.equal(recycleSettings(root,'main').retentionDays,17);assert.equal(recycledRepositoryLogs(root,'main')[0].revision,'log-revision');assert.equal(rootAudit(root,db=>auditQuery(db,'main')).records[0].id,'audit-id');
 const graph=createEntityStore(root);assert.equal(graph.get(seed.person.id).entity.name,'Person');assert.equal(graph.relations().relations[0].id,seed.edge.id);assert.equal(createPeopleStore(root).all()[0].name,'Corrected');assert.equal(createPeopleStore(root).all()[0].giteaUsername,'verified');
 withRepositoryDatabase(root,db=>{assert.equal(db.prepare('SELECT revision FROM recycle_items WHERE id=?').get('trash-id').revision,'trash-revision');assert.equal(JSON.parse(db.prepare('SELECT result FROM recycle_operations').get().result).status,'pending');assert.equal(JSON.parse(db.prepare('SELECT body FROM recycle_cleanup').get().body).status,'partial');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);});
 seed.files.forEach((file,i)=>assert.deepEqual(readFileSync(file),before[i]));
 // Old files are historical, never authoritative again after cutover.
 const old=new DatabaseSync(seed.files[2]);old.prepare('UPDATE settings SET body=?').run(JSON.stringify({retentionDays:99,revision:'stale'}));old.close();assert.equal(recycleSettings(root,'main').retentionDays,17);assert.equal(graph.relations().total,1);
});

test('failed imports roll back the whole initial migration and can retry without partial duplicates',t=>{
 const root=fixture(t),seed=seedLegacy(root),bad=new DatabaseSync(seed.files[1]);bad.exec('CREATE TABLE unsupported_future_table(value TEXT)');bad.close();
 assert.throws(()=>openRepositoryDatabase(root),/不支持/);const partial=new DatabaseSync(join(root,'.runtime/agent_repo.sqlite'));assert.equal(partial.prepare('PRAGMA user_version').get().user_version,0);assert.equal(partial.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,0);partial.close();
 const repaired=new DatabaseSync(seed.files[1]);repaired.exec('DROP TABLE unsupported_future_table');repaired.close();assert.equal(createEntityStore(root).relations().total,1);assert.equal(recycleSettings(root,'main').retentionDays,17);
});

test('foreign-key violations in historical graph data reject cutover without modifying the source',t=>{
 const root=fixture(t),seed=seedLegacy(root),old=new DatabaseSync(seed.files[0]);old.exec('PRAGMA foreign_keys=OFF;DELETE FROM graph_sources');old.close();const bytes=readFileSync(seed.files[0]);assert.throws(()=>openRepositoryDatabase(root),/FOREIGN KEY|完整性/);assert.deepEqual(readFileSync(seed.files[0]),bytes);
});

test('common transactions support nested savepoints, dry runs and rollback of failed migrations',t=>{
 const root=fixture(t);
 repositoryTransaction(root,db=>{db.prepare('INSERT INTO graph_meta VALUES(?,?)').run('outer','value');assert.throws(()=>databaseTransaction(db,inner=>{inner.prepare('INSERT INTO graph_meta VALUES(?,?)').run('inner','value');throw Error('abort-inner');}),/abort-inner/);databaseTransaction(db,inner=>inner.prepare('INSERT INTO graph_meta VALUES(?,?)').run('dry','value'),{dryRun:true});});
 withRepositoryDatabase(root,db=>{assert.equal(db.prepare('SELECT count(*) n FROM graph_meta').get().n,1);assert.throws(()=>migrateDatabase(db,'failing-migration',()=>{db.prepare('INSERT INTO graph_meta VALUES(?,?)').run('failed','value');throw Error('abort-migration');}),/abort-migration/);assert.equal(db.prepare('SELECT 1 FROM repo_schema_migrations WHERE name=?').get('failing-migration'),undefined);});
 assert.throws(()=>repositoryTransaction(root,db=>{db.prepare('INSERT INTO graph_meta VALUES(?,?)').run('async','value');return Promise.resolve();}),/同步/);assert.equal(withRepositoryDatabase(root,db=>db.prepare('SELECT count(*) n FROM graph_meta').get().n),1);
});

test('WAL permits readers to see committed data while another connection owns a write transaction',t=>{
 const root=fixture(t),writer=openRepositoryDatabase(root);let reader;
 try{writer.exec('BEGIN IMMEDIATE');writer.prepare('INSERT INTO graph_meta VALUES(?,?)').run('uncommitted','value');reader=openRepositoryDatabase(root);assert.equal(reader.prepare('SELECT count(*) n FROM graph_meta').get().n,0);writer.exec('COMMIT');assert.equal(reader.prepare('SELECT count(*) n FROM graph_meta').get().n,1);}finally{reader?.close();writer.close();}
});

test('unknown future versions fail closed instead of downgrading or importing old stores',t=>{
 const root=fixture(t);withRepositoryDatabase(root,db=>db.exec('PRAGMA user_version=99'));assert.throws(()=>openRepositoryDatabase(root),/禁止降级/);
});

test('central files, sidecars and legacy directories cannot redirect storage through symlinks',t=>{
 const outside=fixture(t),sentinel=join(outside,'sentinel');writeFileSync(sentinel,'unchanged');
 for(const suffix of ['', '-wal','-shm','-journal']){const root=fixture(t);mkdirSync(join(root,'.runtime'));symlinkSync(sentinel,join(root,'.runtime/agent_repo.sqlite'+suffix));assert.throws(()=>openRepositoryDatabase(root),/文件无效/);}
 const root=fixture(t);mkdirSync(join(root,'.runtime'));symlinkSync(outside,join(root,'.runtime/entities'));assert.throws(()=>openRepositoryDatabase(root),/目录无效/);assert.equal(readFileSync(sentinel,'utf8'),'unchanged');
});

test('retention updates and their audit share one transaction without opening a competing writer',async t=>{
 const root=fixture(t),prior=recycleSettings(root,'main'),result=await configureRecycle(root,'main',{retentionDays:60,expectedRevision:prior.revision,requestId:'settings-write',confirmed:true},{client:{scopes:['operator.write']}});assert.equal(result.settings.retentionDays,60);const events=rootAudit(root,db=>auditQuery(db,'main'));assert.equal(events.total,1);assert.equal(events.records[0].status,'succeeded');assert.equal(events.records[0].after.retentionDays,60);
});

test('competing processes initialize and import the same repository only once',async t=>{
 const root=fixture(t);seedLegacy(root);const entry=new URL('./database.mjs',import.meta.url).href;
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',`import {openRepositoryDatabase} from ${JSON.stringify(entry)};for(let n=0;n<3;n++){const db=openRepositoryDatabase(process.argv[1]);db.close();}`,root],{stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(error)));});
 await Promise.all([run(),run()]);assert.equal(createEntityStore(root).relations().total,1);assert.equal(withRepositoryDatabase(root,db=>db.prepare("SELECT count(*) n FROM repo_schema_migrations WHERE name='database-v1'").get().n),1);
});
