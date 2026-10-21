import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createSessionInspector,registerInspector} from './session-inspector.mjs';
import {bindingKey} from './project-binding.mjs';
import {requestKeyFor} from './jobs.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const scope='agent:main:chat',executionScope=hash('project'),modelSessionScope=hash('model');
async function fixture(t){
 const state=await mkdtemp(join(tmpdir(),'worker-delete-'));t.after(()=>rm(state,{recursive:true,force:true}));await mkdir(join(state,'jobs'));
 const rows=[],bindings={};
 const inspector=createSessionInspector({state,jobs:{status:id=>{const {scope,...job}=rows.find(j=>j.jobId===id);return job;}}});
 async function add(index,patch={},chat=scope){
  const job={jobId:`${String(index).padStart(8,'0')}-1111-4111-8111-111111111111`,scope:hash(chat),topic:'same',project:{projectId:'demo'},projectId:'demo',executionScope,modelSessionScope,sessionId:'native-'+index,status:'completed',createdAt:index,notification:{state:'delivered'},...patch};
  const params={topic:job.topic,task:'fixture',context:'fixture',constraints:'read only'};job.requestKey=requestKeyFor(params,chat);rows.push(job);
  const key=bindingKey(job.topic,job);if(chat===scope)bindings[key]={topic:job.topic,executionScope:job.executionScope,modelSessionScope:job.modelSessionScope,sessionId:job.sessionId,projectId:job.projectId,project:job.project};
  await writeFile(join(state,'jobs',job.jobId+'.json'),JSON.stringify(job));await writeFile(join(state,'jobs',job.jobId+'.request.json'),JSON.stringify({scope:chat,params}));
  await writeFile(join(state,'jobs',job.jobId+'.events.jsonl'),'fixture');await writeFile(join(state,hash(scope)+'.json'),JSON.stringify(bindings));return job;
 }
 async function selection(){const row=(await inspector.list(scope)).sessions.find(j=>j.modelSessionScope===modelSessionScope&&j.executionScope===executionScope);return {topic:row.topic,executionScope,modelSessionScope,projectId:'demo',revision:row.deletionRevision,confirmed:true};}
 return {state,rows,bindings,inspector,add,selection};
}
test('delete archives the exact chat/project/model session and clears its binding and task summaries',async t=>{
 const f=await fixture(t),a=await f.add(1),b=await f.add(2),otherModel=await f.add(3,{modelSessionScope:hash('other model')}),otherProject=await f.add(4,{executionScope:hash('other project'),projectId:'other',project:{projectId:'other'}}),otherChat=await f.add(5,{},'agent:main:other');
 await writeFile(join(f.state,'report.md'),'keep report');
 const result=await f.inspector.deleteSession(scope,await f.selection());assert.deepEqual(result,{deleted:true,taskCount:2});
 const names=await readdir(join(f.state,'jobs'));for(const j of [a,b])assert.ok(!names.some(n=>n.startsWith(j.jobId)));for(const j of [otherModel,otherProject,otherChat])assert.ok(names.includes(j.jobId+'.json'));
 assert.equal((await f.inspector.list(scope)).total,2);assert.equal((await f.inspector.detail(scope,{topic:'same',executionScope,modelSessionScope})).total,0);
 assert.equal((await f.inspector.agentTasks({agentId:'main',sessionKey:scope},{})).taskTotal,3);
 const saved=JSON.parse(await readFile(join(f.state,hash(scope)+'.json')));assert.ok(!saved[bindingKey('same',{executionScope,modelSessionScope})]);assert.equal(Object.keys(saved).length,2);
 const archives=await readdir(join(f.state,'deleted-sessions'));assert.equal(archives.length,1);assert.equal((await readdir(join(f.state,'deleted-sessions',archives[0],'jobs'))).length,6);assert.equal(await readFile(join(f.state,'report.md'),'utf8'),'keep report');
 await assert.rejects(f.inspector.deleteSession(scope,await f.selection().catch(()=>({topic:'same',executionScope,modelSessionScope,revision:hash('old'),confirmed:true}))),/不存在/);
});
test('delete blocks every nonterminal state and unsettled result delivery without moving files',async t=>{
 for(const status of ['queued','running','cancelling','unknown','awaiting_main','awaiting_user','unexpected']){
  const f=await fixture(t);await f.add(1,{status});const row=(await f.inspector.list(scope)).sessions[0];assert.equal(row.canDelete,false);await assert.rejects(f.inspector.deleteSession(scope,await f.selection()),/未结束/);assert.equal((await readdir(join(f.state,'jobs'))).length,3);
 }
 for(const state of ['pending','processing','sending','uncertain']){const f=await fixture(t);await f.add(1,{notification:{state}});await assert.rejects(f.inspector.deleteSession(scope,await f.selection()),/交付/);}
});
test('delete requires confirmation and exact selectors, refuses stale revisions and cross-chat/project requests',async t=>{
 const f=await fixture(t);await f.add(1);const selection=await f.selection();
 for(const patch of [{confirmed:false},{executionScope:undefined},{modelSessionScope:undefined},{executionScope:'../bad'},{sessionKey:scope},{projectId:'other'}])await assert.rejects(f.inspector.deleteSession(scope,{...selection,...patch}));
 await assert.rejects(f.inspector.deleteSession('agent:main:other',selection),/不存在/);
 await f.add(2);await assert.rejects(f.inspector.deleteSession(scope,selection),/已变化/);assert.equal((await readdir(join(f.state,'jobs'))).length,6);
 await f.inspector.deleteSession(scope,await f.selection());
});
test('legacy binding-only sessions can be removed without inventing a job or touching other bindings',async t=>{
 const f=await fixture(t);await writeFile(join(f.state,hash(scope)+'.json'),JSON.stringify({legacy:{topic:'legacy',sessionId:'old'},other:{topic:'other',sessionId:'keep'}}));
 const row=(await f.inspector.list(scope)).sessions.find(j=>j.topic==='legacy');assert.equal(row.canDelete,true);
 assert.deepEqual(await f.inspector.deleteSession(scope,{topic:'legacy',executionScope:null,modelSessionScope:null,revision:row.deletionRevision,confirmed:true}),{deleted:true,taskCount:0});assert.equal((await f.inspector.list(scope)).total,1);
});
test('storage failure rolls back task moves and preserves the original binding',async t=>{
 const f=await fixture(t),job=await f.add(1),payload=await f.selection();await writeFile(join(f.state,'deleted-sessions'),'block archive directory');
 await assert.rejects(f.inspector.deleteSession(scope,payload));assert.ok((await readdir(join(f.state,'jobs'))).includes(job.jobId+'.json'));assert.equal((await f.inspector.list(scope)).total,1);
});
test('delete action requires operator.write, trusts host scope and does not leak storage errors',async()=>{
 const actions=[],seen=[];registerInspector({registerSessionAction:a=>actions.push(a)},{deleteSession:async(scope,payload)=>{seen.push({scope,payload});if(payload.fail)throw Error('/private/secret');return {deleted:true};}});
 const action=actions.find(a=>a.id==='inspect-deleteSession');assert.deepEqual(action.requiredScopes,['operator.write']);assert.deepEqual(await action.handler({sessionKey:scope,payload:{confirmed:true}}),{ok:true,result:{deleted:true}});assert.equal(seen[0].scope,scope);assert.equal((await action.handler({sessionKey:scope,payload:{fail:true}})).ok,false);assert.ok(!JSON.stringify(await action.handler({sessionKey:scope,payload:{fail:true}})).includes('/private'));
});

test('admission during deletion lock acquisition is rechecked before any files move',async t=>{
 const {acquireLock}=await import('./locks.mjs');
 const f=await fixture(t);await f.add(1);const payload=await f.selection(),release=await acquireLock(join(f.state,'jobs','scheduler-lock'));
 const pending=f.inspector.deleteSession(scope,payload);await new Promise(resolve=>setTimeout(resolve,30));await f.add(2,{status:'queued'});release();
 await assert.rejects(pending,/未结束/);assert.equal((await readdir(join(f.state,'jobs'))).length,6);
});
test('mixed history cannot be deleted when an older task remains active',async t=>{
 const f=await fixture(t);await f.add(1,{status:'awaiting_main'});await f.add(2);await assert.rejects(f.inspector.deleteSession(scope,await f.selection()),/未结束/);assert.equal((await readdir(join(f.state,'jobs'))).length,6);
});
test('deleting a session invalidates cached inspection transfers from that conversation only',async()=>{
 const actions=[];registerInspector({registerSessionAction:a=>actions.push(a)},{detail:async()=>({text:'x'.repeat(80000)}),deleteSession:async()=>({deleted:true})});
 const detail=actions.find(a=>a.id==='inspect-detail'),chunk=actions.find(a=>a.id==='inspect-chunk'),remove=actions.find(a=>a.id==='inspect-deleteSession');
 const a=await detail.handler({sessionKey:scope}),b=await detail.handler({sessionKey:'other'});await remove.handler({sessionKey:scope,payload:{}});
 assert.equal((await chunk.handler({sessionKey:scope,payload:{transferId:a.result.transferId,index:1}})).ok,false);assert.equal((await chunk.handler({sessionKey:'other',payload:{transferId:b.result.transferId,index:1}})).ok,true);
});
