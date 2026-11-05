import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {allocateWorkspace,prepareWorkspace,validateWorkspace,releaseWorkspace,poolGit,workspacePlan} from './workspace-pool.mjs';
async function commit(path,message='test'){await poolGit(path,['add','.']);await poolGit(path,['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m',message]);return poolGit(path,['rev-parse','HEAD']);}
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'workspace-pool-')));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'source'),remote=join(root,'origin.git');await mkdir(source);await poolGit(root,['init','--bare',remote]);await poolGit(source,['init','-b','main']);await writeFile(join(source,'.gitignore'),'node_modules/\n.tmp/\n');await writeFile(join(source,'package.json'),'{"name":"fixture","private":true}');await writeFile(join(source,'code.txt'),'base');const baseSha=await commit(source);await poolGit(source,['remote','add','origin',remote]);await poolGit(source,['push','-u','origin','main']);
 const plan={root,projectId:'xgj',projectRepository:'projects/xgj',maxSize:2,target:'.',repositories:[{path:'.',source,url:remote,baseBranch:'main',baseSha}]};let installs=0;const install=async cwd=>{installs++;await mkdir(join(cwd,'node_modules'),{recursive:true});};
 return {root,source,remote,plan,install,get installs(){return installs;}};
}
test('atomic allocation never exceeds the project pool; blocked and preparing slots count',async t=>{
 const f=await fixture(t),rows=await Promise.all(Array.from({length:8},()=>allocateWorkspace(f.plan,randomUUID())));assert.equal(rows.filter(Boolean).length,2);assert.deepEqual(rows.filter(Boolean).map(s=>s.id).sort(),['xgj-0','xgj-1']);
 const state=JSON.parse(await readFile(join(f.root,'workspace/state.json')));assert.equal(Object.keys(state.workspaces).length,2);assert.ok(Object.values(state.workspaces).every(s=>s.status==='preparing'));
});
test('clones isolate edits and branches; published clean slots reuse without reinstalling unchanged package.json',async t=>{
 const f=await fixture(t),a=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install}),b=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});assert.equal(f.installs,2);
 await writeFile(join(a.path,'code.txt'),'fixed');const sha=await commit(a.path);assert.equal(await readFile(join(b.path,'code.txt'),'utf8'),'base');assert.equal(await readFile(join(f.source,'code.txt'),'utf8'),'base');
 await poolGit(a.path,['push','origin','HEAD:refs/heads/'+a.branch]);assert.equal((await releaseWorkspace(f.plan,a)).status,'idle');
 const next=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});assert.equal(next.path,a.path);assert.notEqual(next.branch,a.branch);assert.equal(f.installs,2);assert.equal(await poolGit(next.path,['rev-parse','HEAD']),f.plan.repositories[0].baseSha);
 assert.equal(await poolGit(next.path,['rev-parse','refs/remotes/origin/'+a.branch]),sha);await assert.rejects(validateWorkspace(f.plan,a),/assignment/);
});
test('only package.json changes trigger dependency installation; failed installs do not advance fingerprint',async t=>{
 const f=await fixture(t);f.plan.maxSize=1;let slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});const old=slot.dependencies['.'].packageJsonHash;await releaseWorkspace(f.plan,slot);
 await writeFile(join(f.source,'package-lock.json'),'{}');f.plan.repositories[0].baseSha=await commit(f.source);await poolGit(f.source,['push']);slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});assert.equal(f.installs,1);await releaseWorkspace(f.plan,slot);
 await writeFile(join(f.source,'package.json'),'{"name":"changed","private":true}');f.plan.repositories[0].baseSha=await commit(f.source);await poolGit(f.source,['push']);slot=await allocateWorkspace(f.plan,randomUUID());await assert.rejects(prepareWorkspace(f.plan,slot,{install:async()=>{throw Error('private token');}}),/initialization failed/);
 const state=JSON.parse(await readFile(join(f.root,'workspace/state.json')));assert.equal(state.workspaces[slot.id].dependencies['.'].packageJsonHash,old);assert.equal(state.workspaces[slot.id].status,'blocked');assert.equal(await allocateWorkspace(f.plan,randomUUID()),null);
});
test('dirty and unpushed work remains blocked; cancellation cannot discard files',async t=>{
 for(const pushed of [false,true]){const f=await fixture(t);const slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});await writeFile(join(slot.path,'code.txt'),'unfinished');if(pushed)await commit(slot.path);assert.equal((await releaseWorkspace(f.plan,slot)).status,'blocked');assert.equal(await readFile(join(slot.path,'code.txt'),'utf8'),'unfinished');}
});
test('resume retains assignment and branch; stale releases and symlink paths are rejected',async t=>{
 const f=await fixture(t);const owner=randomUUID(),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,owner),{install:f.install});assert.equal((await allocateWorkspace(f.plan,owner,slot)).assignmentId,slot.assignmentId);await assert.rejects(releaseWorkspace(f.plan,{...slot,assignmentId:randomUUID()}),/assignment/);
 await poolGit(slot.path,['switch','-c','other']);await assert.rejects(validateWorkspace(f.plan,slot),/branch/);
 const g=await fixture(t);await symlink(f.root,join(g.root,'workspace'));await assert.rejects(allocateWorkspace(g.plan,randomUUID()),/linked/);
});
test('recovery never treats an interrupted preparation as idle and lowering max does not reclaim occupied work',async t=>{
 const f=await fixture(t);const a=await allocateWorkspace(f.plan,randomUUID()),b=await allocateWorkspace(f.plan,randomUUID());const file=join(f.root,'workspace/state.json'),s=JSON.parse(await readFile(file));s.workspaces[a.id].preparerPid=2147483647;await writeFile(file,JSON.stringify(s));assert.equal((await allocateWorkspace(f.plan,a.owner)).blocked,true);assert.equal(await allocateWorkspace({...f.plan,maxSize:1},randomUUID()),null);assert.equal((await allocateWorkspace(f.plan,b.owner)).assignmentId,b.assignmentId);
});
test('workspace plan pins source commit and rejects disabled pools',async t=>{
 const f=await fixture(t);const result={root:f.root,cwd:f.source,repository:'projects/xgj',snapshot:{repositorySources:[{root:f.source,head:f.plan.repositories[0].baseSha}]}};
 const project={projectId:'xgj',repository:'projects/xgj',url:f.remote,branch:'main',workspacePool:{enabled:true,maxSize:2}};
 const plan=await workspacePlan(project,result);assert.equal(plan.repositories[0].baseSha,f.plan.repositories[0].baseSha);assert.equal(plan.target,'.');await assert.rejects(workspacePlan({...project,workspacePool:{enabled:false,maxSize:2}},result),/not enabled/);
});

test('only the initial allocation may prepare; reuse rejects changed repository layouts',async t=>{
 const f=await fixture(t),owner=randomUUID(),slot=await allocateWorkspace(f.plan,owner);
 assert.equal(slot.needsPreparation,true);
 assert.equal((await allocateWorkspace(f.plan,owner)).needsPreparation,undefined);
 const ready=await prepareWorkspace(f.plan,slot,{install:f.install});await releaseWorkspace(f.plan,ready);
 await assert.rejects(allocateWorkspace({...f.plan,repositories:[...f.plan.repositories,{path:'repositories/extra',url:'changed'}]},randomUUID()),/layout changed/);
});

test('operational pool updates preserve registry identity but cannot change repository or accept invalid limits',async()=>{
 const {sameRegistryExceptPool}=await import('./workspace-pool.mjs');const manifest={schemaVersion:1,projects:{xgj:{repository:'projects/xgj',url:'trusted',branch:'main'}}},before=JSON.stringify(manifest);
 manifest.projects.xgj.workspacePool={enabled:true,maxSize:2};assert.equal(sameRegistryExceptPool(before,JSON.stringify(manifest)),true);
 manifest.projects.xgj.workspacePool.maxSize=0;assert.equal(sameRegistryExceptPool(before,JSON.stringify(manifest)),false);
 manifest.projects.xgj.workspacePool.maxSize=2;manifest.projects.xgj.url='other';assert.equal(sameRegistryExceptPool(before,JSON.stringify(manifest)),false);
});

test('shrinking pool counts occupied high indices before reusing an idle low index',async t=>{
 const f=await fixture(t);f.plan.maxSize=3;
 const low=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await allocateWorkspace(f.plan,randomUUID());await allocateWorkspace(f.plan,randomUUID());await releaseWorkspace(f.plan,low);
 assert.equal(await allocateWorkspace({...f.plan,maxSize:2},randomUUID()),null);
});
test('deleted remote branches cannot prove a local commit was published for release',async t=>{
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await writeFile(join(slot.path,'code.txt'),'fix');await commit(slot.path);await poolGit(slot.path,['push','origin','HEAD:refs/heads/'+slot.branch]);
 await poolGit(f.source,['push','origin','--delete',slot.branch]);
 assert.equal((await releaseWorkspace(f.plan,slot)).status,'blocked');
});

test('separate scheduler processes share the same atomic capacity limit',async t=>{
 const f=await fixture(t),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile);
 const script=`import {allocateWorkspace} from ${JSON.stringify(new URL('./workspace-pool.mjs',import.meta.url).href)};process.stdout.write(JSON.stringify(await allocateWorkspace(JSON.parse(process.argv[1]),process.argv[2])));`;
 const results=await Promise.all(Array.from({length:5},()=>run(process.execPath,['--input-type=module','-e',script,JSON.stringify(f.plan),randomUUID()])));
 const slots=results.map(r=>JSON.parse(r.stdout)).filter(Boolean);assert.equal(slots.length,2);assert.equal(new Set(slots.map(s=>s.id)).size,2);
});

test('release failures retain safe stage diagnostics and recover after remote returns',async t=>{
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 const {rename}=await import('node:fs/promises');await rename(f.remote,f.remote+'.offline');
 const blocked=await releaseWorkspace(f.plan,slot);
 assert.equal(blocked.status,'blocked');assert.equal(blocked.releaseFailure.repository,'.');assert.equal(blocked.releaseFailure.stage,'remote-refs');assert.equal(blocked.releaseFailure.code,'REMOTE_REFS_FAILED');assert.equal(blocked.releaseFailure.retryable,true);
 assert.equal(blocked.error.includes(f.remote),false);
 await rename(f.remote+'.offline',f.remote);
 assert.equal((await releaseWorkspace(f.plan,slot)).status,'idle');
 const saved=JSON.parse(await readFile(join(f.root,'workspace/state.json'))).workspaces[slot.id];assert.equal(saved.releaseFailure,undefined);assert.equal(saved.error,undefined);
});
test('rechecking blocked dirty or unpublished work never discards it; a later push allows release',async t=>{
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await writeFile(join(slot.path,'code.txt'),'keep me');
 for(let i=0;i<2;i++)assert.equal((await releaseWorkspace(f.plan,slot)).releaseFailure.code,'WORKTREE_DIRTY');
 assert.equal(await readFile(join(slot.path,'code.txt'),'utf8'),'keep me');await commit(slot.path);
 assert.equal((await releaseWorkspace(f.plan,slot)).releaseFailure.code,'HEAD_NOT_ON_ORIGIN');
 await poolGit(slot.path,['push','origin','HEAD:refs/heads/'+slot.branch]);assert.equal((await releaseWorkspace(f.plan,slot)).status,'idle');
});
test('legacy generic release blocks can be rechecked but preparation blocks cannot',async t=>{
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 const file=join(f.root,'workspace/state.json');let state=JSON.parse(await readFile(file));state.workspaces[slot.id].status='blocked';state.workspaces[slot.id].error='Workspace has uncommitted, unpushed or unverifiable changes; preserved';await writeFile(file,JSON.stringify(state));
 assert.equal((await releaseWorkspace(f.plan,slot)).status,'idle');
 state=JSON.parse(await readFile(file));state.workspaces[slot.id].status='blocked';state.workspaces[slot.id].error='Workspace initialization failed';await writeFile(file,JSON.stringify(state));
 await assert.rejects(releaseWorkspace(f.plan,slot),/not executable/);
});
test('release retry refuses changed remote identity rather than treating its refs as publication',async t=>{
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await writeFile(join(slot.path,'code.txt'),'preserve');await releaseWorkspace(f.plan,slot);
 await poolGit(slot.path,['remote','set-url','origin',f.remote+'.other']);
 await assert.rejects(releaseWorkspace(f.plan,slot),/identity/);assert.equal(await readFile(join(slot.path,'code.txt'),'utf8'),'preserve');
});

test('release fetches only a moved relevant branch, not unrelated remote history',async t=>{
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await writeFile(join(f.source,'code.txt'),'remote advancement');await commit(f.source);await poolGit(f.source,['push']);
 await poolGit(f.source,['switch','-c','unrelated']);await writeFile(join(f.source,'unrelated.txt'),'unrelated history');const other=await commit(f.source);await poolGit(f.source,['push','origin','HEAD:refs/heads/unrelated']);
 assert.equal((await releaseWorkspace(f.plan,slot)).status,'idle');
 await assert.rejects(poolGit(slot.path,['cat-file','-e',other+'^{commit}']));
});
test('a rewritten remote cannot validate a stale containing branch',async t=>{
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await writeFile(join(slot.path,'code.txt'),'local change');await commit(slot.path);await poolGit(slot.path,['push','origin','HEAD:refs/heads/'+slot.branch]);
 // Rewriting a disposable local test remote models a branch changed elsewhere.
 await poolGit(f.source,['push','--force','origin','main:refs/heads/'+slot.branch]);
 assert.equal((await releaseWorkspace(f.plan,slot)).releaseFailure.code,'HEAD_NOT_ON_ORIGIN');
});

test('parked task restores only after its original slot becomes idle, retaining staged and extra contents',async t=>{
 const {parkWorkspace,restoreParkedWorkspace}=await import('./workspace-pool.mjs');
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await writeFile(join(slot.path,'code.txt'),'unpublished');const unpublished=await commit(slot.path);
 await writeFile(join(slot.path,'code.txt'),'unfinished');await writeFile(join(slot.path,'artifact'),'saved output');
 const parked=await parkWorkspace(f.plan,slot,{agentId:'agent'});assert.equal(parked.status,'idle');
 const other=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});assert.equal(other.id,slot.id);
 assert.equal(await readFile(join(other.path,'code.txt'),'utf8'),'base');
 await writeFile(join(other.path,'code.txt'),'other task result');await commit(other.path);
 assert.equal(await restoreParkedWorkspace(f.plan,slot,{agentId:'agent'}),null);
 await parkWorkspace(f.plan,other,{agentId:'agent'});
 const restored=await restoreParkedWorkspace(f.plan,slot,{agentId:'agent'});
 assert.equal(restored.assignmentId,slot.assignmentId);assert.equal(restored.path,slot.path);assert.equal(await poolGit(slot.path,['rev-parse','HEAD']),unpublished);
 assert.equal(await readFile(join(slot.path,'code.txt'),'utf8'),'unfinished');assert.equal(await readFile(join(slot.path,'artifact'),'utf8'),'saved output');
 await validateWorkspace(f.plan,restored);
 const firstGeneration=parked.preservedCheckpoint.checkpointId;
 await writeFile(join(restored.path,'artifact'),'second round');
 const again=await parkWorkspace(f.plan,restored,{agentId:'agent'});
 assert.notEqual(again.preservedCheckpoint.checkpointId,firstGeneration);
 await assert.rejects(restoreParkedWorkspace(f.plan,slot,{agentId:'agent',checkpointId:firstGeneration}),/generation/);
 const second=await restoreParkedWorkspace(f.plan,slot,{agentId:'agent',checkpointId:again.preservedCheckpoint.checkpointId});
 assert.equal(await readFile(join(second.path,'artifact'),'utf8'),'second round');
 const state=JSON.parse(await readFile(join(f.root,'workspace/state.json')));
 assert.equal(state.checkpointHistory[firstGeneration].status,'restored');
});

test('lost pool acknowledgement recovers the original journal without capturing the cleaned checkout',async t=>{
 const {parkWorkspace,parkedWorkspaceReceipt,restoreParkedWorkspace}=await import('./workspace-pool.mjs');
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await writeFile(join(slot.path,'code.txt'),'saved before interruption');
 const parked=await parkWorkspace(f.plan,slot,{agentId:'agent'});
 const file=join(f.root,'workspace/state.json'),state=JSON.parse(await readFile(file));
 const saved=state.checkpoints[slot.assignmentId];delete state.checkpoints[slot.assignmentId];
 state.workspaces[slot.id]={...slot,status:'saving',pendingCheckpoint:{binding:saved.binding,lease:saved.lease}};
 await writeFile(file,JSON.stringify(state));
 const receipt=await parkedWorkspaceReceipt(f.plan,slot,{agentId:'agent'});
 assert.deepEqual(receipt.checkpoint,parked.preservedCheckpoint);
 const restored=await restoreParkedWorkspace(f.plan,slot,{agentId:'agent',checkpointId:receipt.checkpoint.checkpointId});
 assert.equal(await readFile(join(restored.path,'code.txt'),'utf8'),'saved before interruption');
});

test('completed restoration with lost acknowledgement verifies files instead of applying again',async t=>{
 const {parkWorkspace,restoreParkedWorkspace}=await import('./workspace-pool.mjs');
 const f=await fixture(t),slot=await prepareWorkspace(f.plan,await allocateWorkspace(f.plan,randomUUID()),{install:f.install});
 await writeFile(join(slot.path,'code.txt'),'original unfinished');await writeFile(join(slot.path,'output'),'artifact');
 const parked=await parkWorkspace(f.plan,slot,{agentId:'agent'});
 const options={agentId:'agent',checkpointId:parked.preservedCheckpoint.checkpointId};
 await restoreParkedWorkspace(f.plan,slot,options);
 const file=join(f.root,'workspace/state.json'),state=JSON.parse(await readFile(file));
 state.workspaces[slot.id].status='restoring';state.checkpoints[slot.assignmentId].status='restoring';await writeFile(file,JSON.stringify(state));
 assert.equal((await restoreParkedWorkspace(f.plan,slot,options)).status,'ready');
 assert.equal((await restoreParkedWorkspace(f.plan,slot,options)).status,'ready');
 assert.equal(await readFile(join(slot.path,'code.txt'),'utf8'),'original unfinished');
 await writeFile(join(slot.path,'output'),'unexpected edit');
 await assert.rejects(restoreParkedWorkspace(f.plan,slot,options));
 assert.equal(await readFile(join(slot.path,'output'),'utf8'),'unexpected edit');
});
test('new workspace policy permits branch switching while preserving assignment and source branch',async t=>{
 const f=await fixture(t),plan={...f.plan,allowBranchSwitch:true};const slot=await prepareWorkspace(plan,await allocateWorkspace(plan,randomUUID()),{install:f.install});
 await poolGit(slot.path,['switch','-c','inspect-release']);assert.equal((await validateWorkspace(plan,slot)).assignmentId,slot.assignmentId);assert.equal(await poolGit(f.source,['branch','--show-current']),'main');
 await assert.rejects(validateWorkspace(plan,{...slot,owner:randomUUID()}),/assignment/);
});
