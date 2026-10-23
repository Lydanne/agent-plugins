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
