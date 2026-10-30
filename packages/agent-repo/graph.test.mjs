import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createGraphStore} from './graph.mjs';
import {createPeopleStore} from './people.mjs';
const stamp=i=>`2026-01-${String(i).padStart(2,'0')}T00:00:00.000Z`;
const proof={kind:'event',id:'trusted-event'};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'graph-v2-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const store=createGraphStore(root),grant={kind:'channel',namespace:'feishu',scope:'tenant-a',actor:'fixture',types:['person','department','organization','asset'],relations:['member_of','primary_department','parent_department','belongs_to']},source=store.forSource(grant);const node=(typeId,externalId)=>source.upsert({typeId,externalId,name:externalId,observedAt:stamp(1)}).entity;return {root,store,source,grant,node};}
const relation=(typeId,from,to,externalId=from.id+to.id,at=1)=>({typeId,externalId,fromId:from.id,toId:to.id,observedAt:stamp(at)});
test('all nodes and edges have immutable source and stable identity; capabilities isolate tenants',t=>{
 const {store,source,grant,node}=fixture(t),p=node('person','p'),d=node('department','d');assert.ok(p.sourceId);assert.equal(p.source.scope,'tenant-a');const edge=source.connect(relation('member_of',p,d),proof).relation;assert.ok(edge.sourceId);
 const foreign=store.forSource({...grant,scope:'tenant-b'}),other=foreign.upsert({typeId:'department',externalId:'d',name:'d',observedAt:stamp(1)}).entity;
 assert.notEqual(d.id,other.id);assert.throws(()=>source.connect(relation('member_of',p,other),proof),/来源范围/);
 assert.throws(()=>foreign.end({id:edge.id,revision:edge.revision,observedAt:stamp(2),evidence:proof}),/不属于/);
 assert.throws(()=>source.upsert({typeId:'asset',externalId:'x',name:'x',observedAt:stamp(1),source:{kind:'program'}}),/参数/);
 assert.throws(()=>store.forSource({...grant,kind:'program'}),/冒充/);
 assert.throws(()=>source.connect(relation('member_of',p,d,'other'),undefined),/参数/);
 assert.throws(()=>source.connect(relation('member_of',d,p),proof),/类型不匹配/);
});
test('cardinality and acyclic constraints rollback the entire transaction',t=>{
 const {store,source,node}=fixture(t),p=node('person','p'),a=node('department','a'),b=node('department','b'),c=node('department','c');
 source.connect(relation('parent_department',a,b),proof);source.connect(relation('parent_department',b,c),proof);
 assert.throws(()=>source.connect(relation('parent_department',c,a),proof),/成环/);assert.equal(store.relations().total,2);
 const edge=source.connect(relation('primary_department',p,a),proof).relation;
 assert.throws(()=>source.connect(relation('primary_department',p,b),proof),/数量/);
 // Establish then end, in either request order, is checked against final atomic state.
 source.applyRelationChanges({requestId:'transfer',changes:[{action:'connect',record:relation('primary_department',p,b,'new',2),evidence:proof},{action:'end',id:edge.id,revision:edge.revision,observedAt:stamp(2),evidence:proof}]});
 assert.equal(store.relations({typeId:'primary_department',status:'active'}).relations[0].toId,b.id);
 assert.throws(()=>source.remove({id:b.id,revision:b.revision,observedAt:stamp(3),evidence:proof}),/端点/);assert.equal(store.get(b.id).entity.status,'active');
});
test('preflight is non-mutating and actual commit repeats rules and revision checks',t=>{
 const {store,source,node}=fixture(t),p=node('person','p'),a=node('department','a'),b=node('department','b');const batch={requestId:'proposal',changes:[{action:'connect',record:relation('primary_department',p,b),evidence:proof}]};
 const before=store.history().total;assert.equal(source.validateRelationChange(batch).allowed,true);assert.equal(store.relations().total,0);assert.equal(store.history().total,before);
 source.connect(relation('primary_department',p,a),proof);assert.throws(()=>source.applyRelationChanges(batch),/数量/);
 assert.throws(()=>source.remove({id:b.id,revision:'stale',observedAt:stamp(2),evidence:proof}),/变化/);
});
test('detachment requires evidence, source permission, version and monotonic time; keeps history',t=>{
 const {store,source,node}=fixture(t),p=node('person','p'),d=node('department','d'),edge=source.connect(relation('member_of',p,d),proof).relation;
 const input={id:edge.id,revision:edge.revision,observedAt:stamp(2)};
 assert.throws(()=>source.end({...input,evidence:{kind:'observation',id:'missing'}}),/断联/);
 assert.throws(()=>source.end({...input,evidence:{kind:'manual',id:'admin',reason:'left'}}),/权限/);
 assert.throws(()=>source.end({...input,evidence:{kind:'snapshot',id:'fake'}}),/完整同步/);
 assert.throws(()=>source.end({...input,observedAt:stamp(1),evidence:proof}),/过期/);
 source.end({...input,evidence:proof});assert.equal(store.relations({status:'active'}).total,0);assert.equal(store.relations({status:'ended'}).total,1);assert.ok(store.history({id:edge.id}).history.some(e=>e.action==='end'));
});
test('full snapshots are atomic, scope-limited, idempotent and reject stale/partial input',t=>{
 const {store,source,grant,node}=fixture(t),p=node('person','p'),a=node('department','a'),b=node('department','b');source.connect(relation('member_of',p,a),proof);source.connect(relation('primary_department',p,a),proof);
 const other=store.forSource({...grant,scope:'other'}),x=other.upsert({typeId:'person',externalId:'p',name:'p',observedAt:stamp(1)}).entity,y=other.upsert({typeId:'department',externalId:'a',name:'a',observedAt:stamp(1)}).entity;other.connect(relation('member_of',x,y),proof);
 const snapshot={requestId:'full-1',observedAt:stamp(2),complete:true,relationTypes:['member_of'],changes:[{action:'connect',record:relation('member_of',p,b,'b',2),evidence:proof}]};
 assert.throws(()=>source.syncSnapshot({...snapshot,complete:false}),/未完成/);assert.equal(store.relations({status:'active'}).total,3);
 const result=source.syncSnapshot(snapshot);assert.deepEqual(source.syncSnapshot(snapshot),result);assert.equal(store.relations({status:'active'}).total,3);
 assert.throws(()=>source.syncSnapshot({...snapshot,requestId:'older',observedAt:stamp(1),changes:[]}),/过期/);
 assert.throws(()=>source.syncSnapshot({...snapshot,requestId:'invalid',observedAt:stamp(3),changes:[{action:'connect',record:{...relation('member_of',p,b,'invalid',3),toId:'missing'},evidence:proof}]}),/FOREIGN KEY|端点/);assert.equal(store.relations({status:'active'}).total,3);
});
test('operation deduplication rejects altered content and graph query is bounded',t=>{
 const {store,source,node}=fixture(t),p=node('person','p'),d=node('department','d'),batch={requestId:'same',changes:[{action:'connect',record:relation('member_of',p,d),evidence:proof}]};const result=source.applyRelationChanges(batch);assert.deepEqual(source.applyRelationChanges(batch),result);
 assert.throws(()=>source.applyRelationChanges({...batch,changes:[]}),/幂等/);assert.equal(store.traverse({id:p.id}).relations.length,1);assert.throws(()=>store.traverse({id:p.id,depth:6}),/范围/);assert.throws(()=>store.relations({limit:101}),/分页/);
});
test('typed custom relations enforce registered fields and endpoint types',t=>{
 const {store,grant,node}=fixture(t);store.registerRelationType({id:'uses',label:'使用',fields:{purpose:{label:'用途',type:'string'}},fromTypes:['person'],toTypes:['asset'],rules:{noSelf:true,maxIncoming:1}});const producer=store.forSource({...grant,relations:['uses']}),p=node('person','p'),asset=node('asset','a');producer.connect({...relation('uses',p,asset),attributes:{purpose:'work'}},proof);
 assert.throws(()=>producer.connect({...relation('uses',p,asset,'bad'),attributes:{unknown:true}},proof),/未注册/);
 assert.throws(()=>store.registerRelationType({id:'bad',label:'bad',fields:{},fromTypes:['person'],toTypes:['asset'],rules:{script:'anything'}}),/参数/);
});
test('legacy databases migrate transactionally once, preserve IDs, corrections and mappings, retire old writes',t=>{
 const {root,store}=fixture(t);mkdirSync(join(root,'.runtime/people'),{recursive:true});mkdirSync(join(root,'.runtime/entities'),{recursive:true});
 const raw={id:'legacy',accountId:'a',appId:'app',openId:'ou_one',directory:{name:'auto',email:'auto@example.invalid',departments:[{id:'d',name:'Dept'}]},overrides:{name:'corrected',giteaUsername:'verified',departments:[{id:'manual',name:'Display only'}]},observedAt:stamp(1),updatedAt:stamp(1),revision:'old-revision'};
 const legacyPath=join(root,'.runtime/people/people.sqlite'),legacy=new DatabaseSync(legacyPath);legacy.exec('CREATE TABLE people(id TEXT PRIMARY KEY,value TEXT NOT NULL)');legacy.prepare('INSERT INTO people VALUES(?,?)').run(raw.id,JSON.stringify(raw));legacy.close();
 const path=join(root,'.runtime/entities/entities.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE entities(id TEXT PRIMARY KEY,value TEXT NOT NULL)');const old={id:'entity:old',typeId:'service',name:'old',summary:'',attributes:{},source:{kind:'program',namespace:'cmdb',externalId:'old'},observedAt:stamp(1),updatedAt:stamp(1),revision:'old'};db.prepare('INSERT INTO entities VALUES(?,?)').run(old.id,JSON.stringify(old));db.close();
 assert.equal(store.types().total,3);assert.equal(store.relations({typeId:'member_of'}).total,1);assert.equal(store.list({typeId:'department'}).entities[0].name,'Dept');assert.equal(store.get('person:legacy').entity.name,'corrected');assert.equal(store.get('entity:old').entity.revision,'old');assert.equal(store.get('person:legacy').entity.attributes.giteaUsername,'verified');
 const people=createPeopleStore(root);assert.equal(people.all()[0].revision,'old-revision');people.update({id:'legacy',revision:'old-revision',patch:{name:'after'}});assert.equal(createGraphStore(root).get('person:legacy').entity.name,'after');
 const retired=new DatabaseSync(legacyPath,{readOnly:true});assert.equal(JSON.parse(retired.prepare('SELECT value FROM people').get().value).overrides.name,'corrected');retired.close();assert.ok(existsSync(path));
});
test('declared business conditions constrain both connect and end without executing scripts',t=>{
 const {store,grant,node}=fixture(t);store.registerType({id:'contract',label:'合同',fields:{state:{label:'状态',type:'string'}}});
 store.registerRelationType({id:'contract_owner',label:'合同归属',fields:{},fromTypes:['contract'],toTypes:['person'],rules:{sameSource:true,conditions:{connect:[{field:'from.attributes.state',op:'equals',value:'approved'}],end:[{field:'from.attributes.state',op:'in',value:['closed','cancelled']}]}}});
 const source=store.forSource({...grant,types:['contract','person'],relations:['contract_owner']}),person=node('person','owner'),draft=source.upsert({typeId:'contract',externalId:'c',name:'合同',attributes:{state:'draft'},observedAt:stamp(1)}).entity;
 assert.throws(()=>source.connect(relation('contract_owner',draft,person),proof),/业务条件/);
 const approved=source.upsert({typeId:'contract',externalId:'c',name:'合同',attributes:{state:'approved'},observedAt:stamp(2)}).entity,edge=source.connect(relation('contract_owner',approved,person,'owner',2),proof).relation;
 assert.throws(()=>source.end({id:edge.id,revision:edge.revision,observedAt:stamp(3),evidence:proof}),/业务条件/);
 source.upsert({typeId:'contract',externalId:'c',name:'合同',attributes:{state:'closed'},observedAt:stamp(3)});source.end({id:edge.id,revision:edge.revision,observedAt:stamp(4),evidence:proof});assert.equal(store.relations({typeId:'contract_owner',status:'active'}).total,0);
});
