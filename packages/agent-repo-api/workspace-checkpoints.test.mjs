import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCheckpoint,readCheckpoint,updateCheckpoint} from './workspace-checkpoints.mjs';
const binding={agentId:'agent',projectId:'project',jobId:'job',assignmentId:'assignment',workspaceId:'project-0',workspacePath:'/fixture/project-0'};
async function fixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'checkpoint-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('intent survives a restarted caller and duplicate creation preserves receipts',async t=>{
 const root=await fixture(t),initial=await createCheckpoint(root,binding);
 const partial=await updateCheckpoint(root,binding,initial.revision,{status:'saving',repositories:[{path:'.',head:'retained',stage:'head-pinned'}]});
 assert.deepEqual(await createCheckpoint(root,binding),partial);
 assert.deepEqual(await readCheckpoint(root,binding),partial);
});
test('only one concurrent writer can advance a checkpoint revision',async t=>{
 const root=await fixture(t),initial=await createCheckpoint(root,binding);
 const attempts=await Promise.allSettled(Array.from({length:5},()=>updateCheckpoint(root,binding,initial.revision,{status:'saving',repositories:[]})));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await readCheckpoint(root,binding)).revision,2);
});
test('restoration cannot skip saving, and different jobs cannot read each others records',async t=>{
 const root=await fixture(t);await createCheckpoint(root,binding);
 await assert.rejects(updateCheckpoint(root,binding,1,{status:'restored',repositories:[]}),/transition/);
 await assert.rejects(readCheckpoint(root,{...binding,jobId:'other'}),{code:'ENOENT'});
 assert.equal((await readCheckpoint(root,binding)).status,'saving');
});
