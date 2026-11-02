import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {poolGit} from './dist/workspace-pool.mjs';
import {prepareJobWorkspace,settleJobWorkspace,checkJobWorkspace,holdJobWorkspace} from './workspace-runtime.mjs';
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'runtime-checkpoint-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source'),remote=join(root,'remote.git');await mkdir(source);await poolGit(root,['init','--bare',remote]);await poolGit(source,['init','-b','main']);
 await writeFile(join(source,'code'),'base');await poolGit(source,['add','.']);await poolGit(source,['-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','commit','-m','base']);await poolGit(source,['remote','add','origin',remote]);await poolGit(source,['push','origin','main']);
 const baseSha=await poolGit(source,['rev-parse','HEAD']);
 return {root,source,runtime:{cwd:source,workspacePool:{root,projectId:'p',projectRepository:'projects/p',maxSize:1,target:'.',repositories:[{path:'.',source,url:remote,baseBranch:'main',baseSha}]},projectContext:{agentId:'agent',projectId:'p',repository:'projects/p',cwd:source,scopeDirectory:source},executionScope:'source',executorInstructions:source,delegationInstructions:source,scopedSkillSnapshot:{repository:'projects/p',catalog:['projects/p'],repositorySources:[{root:source}],instructionSources:[{root:source,paths:['projects/p/AGENTS.md']}]}}};
}
test('actual runtime parks A, runs B in that clone, then restores A without remapping its scope or replaying B',async t=>{
 const f=await fixture(t),aId=randomUUID(),bId=randomUUID();
 const a=await prepareJobWorkspace(f.runtime,aId);await writeFile(join(a.cwd,'code'),'A edit');await writeFile(join(a.cwd,'artifact'),'A artifact');
 const parked=await settleJobWorkspace(a),pending={...a,workspaceCheckpoint:parked.checkpoint};
 const b=await prepareJobWorkspace(f.runtime,bId);assert.equal(b.cwd,a.cwd);assert.equal(await readFile(join(b.cwd,'code'),'utf8'),'base');
 assert.equal(await prepareJobWorkspace(pending,aId),null);
 const replayed=await settleJobWorkspace(a);assert.deepEqual(replayed.checkpoint,parked.checkpoint);
 assert.equal(await readFile(join(b.cwd,'code'),'utf8'),'base');
 await writeFile(join(b.cwd,'code'),'B edit');const bSaved=await settleJobWorkspace(b);
 const restored=await prepareJobWorkspace(pending,aId);
 assert.equal(restored.cwd,a.cwd);assert.equal(restored.executionScope,a.executionScope);assert.deepEqual(restored.scopedSkillSnapshot,a.scopedSkillSnapshot);assert.equal(restored.workspaceCheckpoint,undefined);
 assert.equal(await readFile(join(restored.cwd,'code'),'utf8'),'A edit');assert.equal(await readFile(join(restored.cwd,'artifact'),'utf8'),'A artifact');
 assert.equal(await readFile(join(f.source,'code'),'utf8'),'base');
 const aAgain=await settleJobWorkspace(restored);assert.notEqual(aAgain.checkpoint.checkpointId,parked.checkpoint.checkpointId);
 const bAgain=await prepareJobWorkspace({...b,workspaceCheckpoint:bSaved.checkpoint},bId);
 assert.equal(await readFile(join(bAgain.cwd,'code'),'utf8'),'B edit');
});
test('read-only runtime remains in its default directory and never creates workspace state',async t=>{
 const f=await fixture(t),runtime={cwd:f.source,projectContext:f.runtime.projectContext};
 assert.equal(await prepareJobWorkspace(runtime,randomUUID()),runtime);
 await checkJobWorkspace(runtime);await holdJobWorkspace(runtime);assert.equal(await settleJobWorkspace(runtime),undefined);
 await assert.rejects(readFile(join(f.root,'workspace','state.json')),{code:'ENOENT'});
});
