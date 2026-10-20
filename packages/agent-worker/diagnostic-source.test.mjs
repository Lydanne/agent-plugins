import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {installWorkerDiagnostics} from './diagnostic-source.mjs';
import {createDiagnosticHub} from './dist/diagnostics-api.mjs';
import {requestKeyFor} from './jobs.mjs';
const ctx=payload=>({agentId:'main',sessionKey:'agent:main:management',client:{connId:'window',scopes:['operator.read','operator.write']},payload});
test('Main tails only authorized Worker events after opt-in and preserves split UTF8',async t=>{
 const root=await mkdtemp(join(tmpdir(),'worker-debug-'));t.after(()=>rm(root,{recursive:true,force:true}));
 async function job(agent='main',valid=true){const id=randomUUID(),scope='agent:'+agent+':chat',params={topic:'topic',task:'task',context:'context',constraints:'constraints'},provenance={agentId:agent};await writeFile(join(root,id+'.request.json'),JSON.stringify({scope,params}));await writeFile(join(root,id+'.json'),JSON.stringify({jobId:id,scope:createHash('sha256').update(scope).digest('hex'),topic:'topic',provenance,requestKey:valid?requestKeyFor(params,scope,provenance):'forged'}));await writeFile(join(root,id+'.events.jsonl'),JSON.stringify({event:'old.secret',time:1})+'\n');return id;}
 const own=await job(),other=await job('other'),forged=await job('main',false);const source=installWorkerDiagnostics({root},Symbol()),hub=createDiagnosticHub();t.after(()=>{hub.dispose();source.dispose();});
 const lease=await hub.actions.diagnosticStart(ctx({sourceIds:['agent-worker.events']}));
 for(const id of [own,other,forged])await appendFile(join(root,id+'.events.jsonl'),JSON.stringify({event:'worker.context_request',message:'new',token:'hidden',time:2})+'\n');
 const read=afterSeq=>hub.actions.diagnosticRead(ctx({leaseId:lease.leaseId,afterSeq}));let result=await read(0);assert.equal(result.rows.length,1);assert.equal(result.rows[0].jobId,own);assert.equal(result.rows[0].sourceId,'agent-worker.events');assert.equal(result.rows[0].data.token,'[redacted]');assert.equal(result.rows[0].traceId,own);
 const line=Buffer.from(JSON.stringify({event:'main.context_reply',message:'中文回复'})+'\n'),split=line.indexOf(Buffer.from('中文'))+1;await appendFile(join(root,own+'.events.jsonl'),line.subarray(0,split));const partial=await read(result.nextSeq);assert.equal(partial.rows.length,0);await appendFile(join(root,own+'.events.jsonl'),line.subarray(split));result=await read(result.nextSeq);assert.equal(result.rows.length,1);assert.equal(result.rows[0].data.message,'中文回复');assert.equal(result.rows[0].phase,'main');
 const added=await job();await appendFile(join(root,added+'.events.jsonl'),JSON.stringify({event:'turn.started'})+'\n');result=await read(result.nextSeq);assert.ok(result.rows.some(row=>row.jobId===added));await hub.actions.diagnosticStop(ctx({leaseId:lease.leaseId}));await assert.rejects(read(result.nextSeq));
});
test('Main adapter rejects symlinked Worker audit files and remains read-only',async t=>{
 const root=await mkdtemp(join(tmpdir(),'worker-debug-link-'));t.after(()=>rm(root,{recursive:true,force:true}));const id=randomUUID();await writeFile(join(root,'external'),JSON.stringify({secret:'hidden'}));await symlink(join(root,'external'),join(root,id+'.json'));const source=installWorkerDiagnostics({root},Symbol()),hub=createDiagnosticHub();t.after(()=>{hub.dispose();source.dispose();});const lease=await hub.actions.diagnosticStart(ctx({sourceIds:['agent-worker.events']}));assert.deepEqual((await hub.actions.diagnosticRead(ctx({leaseId:lease.leaseId}))).rows,[]);
});
test('oversized partial records produce an omission notice and do not corrupt the next event',async t=>{
 const root=await mkdtemp(join(tmpdir(),'worker-debug-large-'));t.after(()=>rm(root,{recursive:true,force:true}));const id=randomUUID(),scope='agent:main:chat',params={topic:'large',task:'task',context:'context',constraints:'readonly'},provenance={agentId:'main'};
 await writeFile(join(root,id+'.json'),JSON.stringify({jobId:id,scope:createHash('sha256').update(scope).digest('hex'),topic:'large',provenance,requestKey:requestKeyFor(params,scope,provenance)}));await writeFile(join(root,id+'.request.json'),JSON.stringify({scope,params}));await writeFile(join(root,id+'.events.jsonl'),'');
 const source=installWorkerDiagnostics({root},Symbol()),hub=createDiagnosticHub();t.after(()=>{hub.dispose();source.dispose();});const lease=await hub.actions.diagnosticStart(ctx({sourceIds:['agent-worker.events']}));await appendFile(join(root,id+'.events.jsonl'),JSON.stringify({event:'large',payload:'x'.repeat(100000)})+'\n'+JSON.stringify({event:'turn.completed'})+'\n');
 let cursor=0,rows=[];for(let i=0;i<3;i++){const result=await hub.actions.diagnosticRead(ctx({leaseId:lease.leaseId,afterSeq:cursor}));cursor=result.nextSeq;rows.push(...result.rows);}assert.equal(rows.filter(row=>row.eventName==='capture.omitted').length,1);assert.ok(rows.some(row=>row.eventName==='turn.completed'));assert.equal(rows.some(row=>row.eventName==='capture.invalid'),false);
});
test('hundreds of idle historical jobs do not delay the first newly active Worker event',async t=>{
 const root=await mkdtemp(join(tmpdir(),'worker-debug-idle-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(let n=0;n<400;n++){const id=String(n).padStart(8,'0')+'-0000-0000-0000-000000000000';await writeFile(join(root,id+'.json'),'{}');await writeFile(join(root,id+'.events.jsonl'),JSON.stringify({event:'old'})+'\n');}
 const source=installWorkerDiagnostics({root},Symbol()),hub=createDiagnosticHub();t.after(()=>{hub.dispose();source.dispose();});const lease=await hub.actions.diagnosticStart(ctx({sourceIds:['agent-worker.events']}));
 const id='ffffffff-ffff-ffff-ffff-ffffffffffff',scope='agent:main:new',params={topic:'new',task:'task',context:'context',constraints:'readonly'},provenance={agentId:'main'};
 await writeFile(join(root,id+'.json'),JSON.stringify({jobId:id,scope:createHash('sha256').update(scope).digest('hex'),topic:'new',provenance,requestKey:requestKeyFor(params,scope,provenance)}));await writeFile(join(root,id+'.request.json'),JSON.stringify({scope,params}));await writeFile(join(root,id+'.events.jsonl'),JSON.stringify({event:'turn.started'})+'\n');
 const result=await hub.actions.diagnosticRead(ctx({leaseId:lease.leaseId}));assert.equal(result.rows.length,1);assert.equal(result.rows[0].jobId,id);assert.equal(result.rows[0].eventName,'turn.started');
});
