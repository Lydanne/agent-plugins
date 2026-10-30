import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,statSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditTable,auditBegin,auditFinish,auditQuery,rootAudit,importLegacyOperations,panelAuditActor} from './audit.mjs';
function dbFixture(t){const db=new DatabaseSync(':memory:');auditTable(db);t.after(()=>db.close());return db;}
test('audit queries combine Agent, feature, target, actor, result and time filters before pagination',t=>{
 const db=dbFixture(t);
 for(let i=0;i<130;i++){const id=auditBegin(db,{agentId:i===0?'other':'main',feature:i===1?'entities':'schedules',targetId:'plan',action:'update',actor:{id:'human'},at:i,before:{deliveryMode:'source'}});if(i%2)auditFinish(db,id,'succeeded',{deliveryMode:'group'});}
 const p={feature:'schedules',targetId:'plan',actorId:'human',status:'succeeded',from:3,to:129,limit:10};const first=auditQuery(db,'main',p);assert.equal(first.total,64);assert.equal(first.records.length,10);assert.equal(first.records[0].at,129);assert.equal(first.nextOffset,10);
 const second=auditQuery(db,'main',{...p,offset:first.nextOffset});assert.equal(second.records[0].at,109);assert.equal(auditQuery(db,'other',{}).total,1);
 for(const invalid of [{agentId:'other'},{limit:101},{offset:-1},{from:'yesterday'},{from:10,to:2},{actorId:"x' OR 1=1"}]){if(invalid.actorId)assert.equal(auditQuery(db,'main',invalid).total,0);else assert.throws(()=>auditQuery(db,'main',invalid));}
});
test('legacy operations migrate once and explicitly preserve missing identity and snapshots',t=>{
 const db=dbFixture(t),rows=[{agentId:'main',requestId:'old',action:'update',targetId:'plan',status:'unknown',at:1}];importLegacyOperations(db,rows);importLegacyOperations(db,rows);
 const result=auditQuery(db,'main');assert.equal(result.total,1);const record=result.records[0];assert.equal(record.actor.id,null);assert.match(record.actor.identityNote,/未保存/);assert.equal(record.after,null);assert.deepEqual(record.changes,[]);assert.equal(record.status,'unknown');
});
test('private audit survives reopen and refuses symlinked paths; panel identity never trusts payload or credentials',t=>{
 const root=mkdtempSync(join(tmpdir(),'audit-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let id;
 rootAudit(root,db=>{id=auditBegin(db,{agentId:'main',feature:'logs',targetId:'logs',action:'clear'});});assert.equal(statSync(join(root,'.runtime/agent_repo.sqlite')).mode&0o777,0o600);
 assert.equal(rootAudit(root,db=>auditQuery(db,'main')).records[0].status,'pending');rootAudit(root,db=>auditFinish(db,id,'unknown',null));assert.equal(rootAudit(root,db=>auditQuery(db,'main')).records[0].status,'unknown');
 const actor=panelAuditActor({client:{connId:'trusted',token:'SECRET'},payload:{actorId:'forged',name:'forged'}});assert.equal(actor.id,'trusted');assert.equal(actor.name,null);assert.ok(!JSON.stringify(actor).includes('SECRET'));assert.ok(!JSON.stringify(actor).includes('forged'));
 const linked=join(root,'linked');mkdirSync(linked);symlinkSync(join(root,'.runtime'),join(linked,'.runtime'));assert.throws(()=>rootAudit(linked,()=>{}),/目录/);
});
