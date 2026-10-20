import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createAgentTaskInspector} from './agent-task-inspector.mjs';
import {requestKeyFor} from './jobs.mjs';
import {createSessionInspector,registerInspector} from './session-inspector.mjs';
import {readInspectionResponse} from './inspection-transport.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
test('Agent aggregate verifies scope bindings, separates Agents and counts all conversations before pagination/search',async t=>{
 const state=await mkdtemp(join(tmpdir(),'worker-agent-inspect-'));t.after(()=>rm(state,{recursive:true,force:true}));await mkdir(join(state,'jobs'));
 const rows=[];
 async function save(agent,chat,status,projectId,overrides={}){
  const jobId=randomUUID(),scope='agent:'+agent+':'+chat,params={topic:'topic '+chat,task:'Bearer private-token',context:'',constraints:''},provenance={agentId:agent};
  const saved={jobId,scope:hash(scope),requestKey:requestKeyFor(params,scope,provenance),provenance,topic:params.topic,taskSummary:'summary '+chat,status,projectId,createdAt:rows.length+1,...overrides};rows.push(saved);
  await writeFile(join(state,'jobs',jobId+'.json'),JSON.stringify(saved));await writeFile(join(state,'jobs',jobId+'.request.json'),JSON.stringify({scope,params,runtime:{secret:'must-not-leak'}}));return saved;
 }
 await save('alice','one','running','a');await save('alice','two','queued','b');await save('bob','other','running','a');await save('alice','bad','completed','a',{scope:hash('agent:bob:other')});
 const jobs={status:(id,scope)=>{const job=rows.find(row=>row.jobId===id);assert.equal(job.scope,hash(scope));return job;}};
 const inspect=createAgentTaskInspector({state,jobs,now:()=>100}),ctx={agentId:'alice',sessionKey:'agent:alice:catalog'};
 const result=await inspect(ctx,{limit:1,query:'two'});assert.equal(result.taskTotal,2);assert.equal(result.conversationTotal,2);assert.equal(result.total,1);assert.equal(result.counts.running,1);assert.equal(result.counts.queued,1);assert.equal(result.tasks[0].sessionKey,'agent:alice:two');assert.deepEqual(result.projectIds,['a','b']);assert.ok(!JSON.stringify(result).includes('must-not-leak'));assert.ok(!JSON.stringify(result).includes('private-token'));
 const project=await inspect(ctx,{projectId:'a',status:'queued'});assert.equal(project.counts.running,1);assert.equal(project.total,0);assert.equal(project.taskTotal,1);
 const page=await inspect(ctx,{limit:1});assert.equal(page.hasMore,true);assert.equal((await inspect(ctx,{limit:1,offset:1})).tasks[0].status,'running');
 for(const payload of [{agentId:'bob'},{sessionKey:'agent:bob:other'},{projectId:123},{status:'invented'},{limit:101},{offset:-1}])await assert.rejects(inspect(ctx,payload));
 await assert.rejects(inspect({agentId:'alice',sessionKey:'agent:bob:other'}));await assert.rejects(inspect({sessionKey:'agent:alice:catalog'}));
 const actions=[];registerInspector({registerSessionAction:a=>actions.push(a)},createSessionInspector({state,jobs}));const action=actions.find(a=>a.id==='inspect-agentTasks');assert.deepEqual(action.requiredScopes,['operator.read']);
 const actual=await readInspectionResponse((name,payload)=>actions.find(a=>a.id==='inspect-'+name).handler({...ctx,payload}),'agentTasks',{});assert.equal(actual.taskTotal,2);
 assert.equal((await action.handler({...ctx,payload:{agentId:'bob'}})).ok,false);
});
test('Agent summary reports unknown heartbeat state and never infers missing legacy ownership',async t=>{
 const state=await mkdtemp(join(tmpdir(),'worker-agent-legacy-'));t.after(()=>rm(state,{recursive:true,force:true}));await mkdir(join(state,'jobs'));
 const id=randomUUID(),scope='agent:alice:old',params={topic:'old',task:'task'},provenance={agentId:'alice'},job={jobId:id,scope:hash(scope),requestKey:requestKeyFor(params,scope,provenance),provenance,topic:'old',status:'running'};
 await writeFile(join(state,'jobs',id+'.json'),JSON.stringify(job));const inspect=createAgentTaskInspector({state,jobs:{status:()=>({...job,status:'unknown'})}}),ctx={agentId:'alice',sessionKey:'agent:alice:catalog'};
 assert.equal((await inspect(ctx)).taskTotal,0);await writeFile(join(state,'jobs',id+'.request.json'),JSON.stringify({scope,params}));assert.equal((await inspect(ctx)).counts.unknown,1);assert.equal((await inspect(ctx)).counts.running,0);
});
test('Agent aggregate chunk transfers retain both authenticated Agent and routing scope',async()=>{
 const actions=[];registerInspector({registerSessionAction:a=>actions.push(a)},{agentTasks:async()=>({text:'x'.repeat(70000)})});
 const ctx={agentId:'alice',sessionKey:'agent:alice:catalog'},first=await actions.find(a=>a.id==='inspect-agentTasks').handler(ctx),chunk=actions.find(a=>a.id==='inspect-chunk');
 assert.equal(first.ok,true);const payload={transferId:first.result.transferId,index:1};assert.equal((await chunk.handler({...ctx,payload})).ok,true);
 assert.equal((await chunk.handler({...ctx,agentId:'bob',payload})).ok,false);assert.equal((await chunk.handler({...ctx,sessionKey:'agent:alice:other',payload})).ok,false);
});
