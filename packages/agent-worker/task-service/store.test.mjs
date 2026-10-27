import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTaskStore} from './store.mjs';
const input={version:1,agentId:'main',projectId:'example',workflow:'ci',requestKey:'repo:pr:full-sha:v1',task:'read',context:'source',constraints:'read only',useWorkspace:false,attempt:'1'};
test('durable dedup across attempts and reopen; conflicting inputs never overwrite',()=>{
 const root=mkdtempSync(join(tmpdir(),'automation-store-'));let s=openTaskStore(root);
 try{const a=s.submit('owner',input,{timeoutMs:60000});const b=s.submit('owner',{...input,attempt:'2'},{timeoutMs:60000});assert.equal(a.taskId,b.taskId);assert.equal(s.attempts(a.taskId).length,2);assert.throws(()=>s.submit('owner',{...input,task:'write'},{timeoutMs:60000}),/REQUEST_CONFLICT/);assert.throws(()=>s.submit('owner',{...input,workflow:'other'},{timeoutMs:60000}),/REQUEST_CONFLICT/);s.close();s=openTaskStore(root);assert.equal(s.submit('owner',input,{timeoutMs:60000}).taskId,a.taskId);assert.throws(()=>s.owned(a.taskId,'other'),/TASK_NOT_FOUND/);
 assert.throws(()=>s.rerun('owner',a.taskId,'rerun1'),/PREDECESSOR_NOT_SETTLED/);s.update(a.taskId,()=>({state:'unknown',settled:true}));assert.throws(()=>s.rerun('owner',a.taskId,'rerun1'),/PREDECESSOR_NOT_SETTLED/);s.update(a.taskId,()=>({state:'completed'}));const c=s.rerun('owner',a.taskId,'rerun1');assert.notEqual(c.taskId,a.taskId);assert.equal(c.predecessorTaskId,a.taskId);assert.equal(s.rerun('owner',a.taskId,'rerun1').taskId,c.taskId);assert.equal(s.rerun('owner',c.taskId,'rerun1').taskId,c.taskId);assert.equal(s.submit('owner',input,{timeoutMs:60000}).taskId,c.taskId);
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});
test('source and repository injection rejected',()=>{const root=mkdtempSync(join(tmpdir(),'automation-store-'));const s=openTaskStore(root);try{for(const patch of [{cwd:'/tmp'},{provenance:{senderId:'fake'}},{repository:'projects/other'},{repository:'projects/example/repositories/..'}])assert.throws(()=>s.submit('owner',{...input,...patch},{timeoutMs:60000}));}finally{s.close();rmSync(root,{recursive:true,force:true});}});
