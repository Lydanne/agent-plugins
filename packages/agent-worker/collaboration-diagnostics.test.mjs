import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collaborationDiagnostics} from './collaboration-diagnostics.mjs';
test('collaboration diagnostics distinguish budgets and delivery receipt from execution or actual skill reads',()=>{
 const job={questions:[{questionId:'a'},{questionId:'b',requestKind:'plugin'}],contextRequest:{questionId:'b',requestKind:'plugin',createdAt:100,expiresAt:10000},notification:{state:'uncertain',attempts:2,retryAt:2000,lastErrorCode:'delivery_failed'}};
 const value=collaborationDiagnostics(job,{mainSkillNotifiedRevision:'a'.repeat(64),updatedAt:'2026-10-20'},1100);
 assert.deepEqual(value.requests,{plugin:{used:1,limit:50},context:{used:1,limit:5}});assert.equal(value.waiting.ageMs,1000);assert.match(value.delivery.meaning,/先核查原事件/);assert.equal(value.skill.actualRead,'unknown');
 const receipt=collaborationDiagnostics({notification:{state:'delivered'}});assert.match(receipt.delivery.meaning,/不代表业务/);assert.equal(receipt.skill.lastNotifiedRevision,null);
});
test('session inspection attaches diagnostics from only the current scoped binding',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');
 const {createSessionInspector}=await import('./session-inspector.mjs');const {bindingKey}=await import('./project-binding.mjs');
 const state=await mkdtemp(join(tmpdir(),'collaboration-inspection-')),scope='agent:main:fixture',hash=value=>createHash('sha256').update(value).digest('hex');
 try{
  await mkdir(join(state,'jobs'));const job={jobId:'11111111-1111-4111-8111-111111111111',scope:hash(scope),topic:'fixture',status:'awaiting_main',createdAt:1,questions:[{requestKind:'plugin',questionId:'q'}],contextRequest:{requestKind:'plugin',questionId:'q',createdAt:100},notification:{state:'pending',attempts:2,retryAt:300}};
  await writeFile(join(state,'jobs',job.jobId+'.json'),JSON.stringify(job));
  await writeFile(join(state,hash(scope)+'.json'),JSON.stringify({[bindingKey(job.topic,job)]:{topic:job.topic,mainSkillNotifiedRevision:'a'.repeat(64)}}));
  await writeFile(join(state,hash('agent:other:fixture')+'.json'),JSON.stringify({[bindingKey(job.topic,job)]:{mainSkillNotifiedRevision:'b'.repeat(64)}}));
  const inspector=createSessionInspector({state,now:()=>1100,jobs:{status:()=>job}}),detail=await inspector.detail(scope,{topic:'fixture'});
  const diagnostic=detail.records[0].collaboration;assert.equal(diagnostic.skill.lastNotifiedRevision,'a'.repeat(64));assert.equal(diagnostic.skill.actualRead,'unknown');assert.equal(diagnostic.requests.plugin.used,1);assert.equal(diagnostic.delivery.attempts,2);assert.equal(diagnostic.waiting.ageMs,1000);
  assert.equal((await inspector.detail('agent:other:fixture',{topic:'fixture'})).total,0);
 }finally{await rm(state,{recursive:true,force:true});}
});
