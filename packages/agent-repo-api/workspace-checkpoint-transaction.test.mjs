import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {poolGit} from './workspace-pool.mjs';
import {saveWorkspaceCheckpoint,restoreWorkspaceCheckpoint,releaseCheckpointContents} from './workspace-checkpoint-transaction.mjs';
import {readCheckpoint} from './workspace-checkpoints.mjs';
test('workspace save persists Git and file receipts without cleaning the original clone',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'save-workspace-')));t.after(()=>rm(root,{recursive:true,force:true}));const repo=join(root,'repo');await mkdir(repo);
 await poolGit(repo,['init','-b','main']);await poolGit(repo,['remote','add','origin','fixture-origin']);await writeFile(join(repo,'code'),'base');await poolGit(repo,['add','.']);await poolGit(repo,['-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','commit','-m','base']);
 await writeFile(join(repo,'code'),'pending');await writeFile(join(repo,'result'),'artifact');
 const binding={agentId:'a',projectId:'p',jobId:'j',assignmentId:'lease',workspaceId:'p-0',workspacePath:repo};
 const saved=await saveWorkspaceCheckpoint(root,binding,[{path:'.',url:'fixture-origin'}]);
 assert.equal(saved.status,'saved');assert.equal(saved.repositories[0].stage,'saved');assert.equal(saved.repositories[0].files[0].path,'result');
 assert.equal(await readFile(join(repo,'code'),'utf8'),'pending');assert.equal(await readFile(join(repo,'result'),'utf8'),'artifact');
 assert.deepEqual(await readCheckpoint(root,binding),saved);
 assert.deepEqual(await saveWorkspaceCheckpoint(root,binding,[{path:'.',url:'fixture-origin'}]),saved);
 await assert.rejects(restoreWorkspaceCheckpoint(root,binding),/not ready/);
 await writeFile(join(repo,'result'),'late artifact');
 await assert.rejects(releaseCheckpointContents(root,binding),/verification/);
 assert.equal(await readFile(join(repo,'code'),'utf8'),'pending');
 assert.equal((await readCheckpoint(root,binding)).status,'saved');
 await writeFile(join(repo,'result'),'artifact');
 const parked=await releaseCheckpointContents(root,binding);
 assert.equal(parked.status,'parked');
 assert.equal(await poolGit(repo,['status','--porcelain']),'');
 const restored=await restoreWorkspaceCheckpoint(root,binding);
 assert.equal(restored.status,'restored');assert.equal(restored.repositories[0].stage,'restored');
 assert.equal(await readFile(join(repo,'code'),'utf8'),'pending');assert.equal(await readFile(join(repo,'result'),'utf8'),'artifact');
 await assert.rejects(restoreWorkspaceCheckpoint(root,binding),/not ready/);
 assert.equal(await poolGit(repo,['rev-parse',saved.repositories[0].git.stashRef]),saved.repositories[0].git.stash);
});

test('independent child repositories retain separate snapshots and parent release cannot erase child results',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'multi-checkpoint-')));t.after(()=>rm(root,{recursive:true,force:true}));const repo=join(root,'repo');await mkdir(repo);
 const commit=async path=>{await poolGit(path,['add','.']);await poolGit(path,['-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','commit','-m','fixture']);};
 for(const relative of ['.','wiki','repositories/service']) {
  const path=join(repo,relative);await mkdir(path,{recursive:true});await poolGit(path,['init','-b','main']);await poolGit(path,['remote','add','origin','fixture-'+relative]);await writeFile(join(path,'code'),'base');
  if(relative==='.')await writeFile(join(path,'.gitignore'),'repositories/\n');
  await commit(path);
 }
 await poolGit(repo,['add','wiki']);await commit(repo);
 const repositories=['.','wiki','repositories/service'].map(path=>({path,url:'fixture-'+path}));
 for(const {path} of repositories){await writeFile(join(repo,path,'code'),'pending '+path);await writeFile(join(repo,path,'artifact'),'artifact '+path);}
 const binding={agentId:'a',projectId:'p',jobId:'multi',assignmentId:'lease',workspaceId:'p-0',workspacePath:repo};
 const saved=await saveWorkspaceCheckpoint(root,binding,repositories);
 assert.equal(saved.repositories.length,3);assert.deepEqual(saved.repositories[0].files.map(f=>f.path),['artifact']);
 await releaseCheckpointContents(root,binding);
 await restoreWorkspaceCheckpoint(root,binding);
 for(const {path} of repositories){assert.equal(await readFile(join(repo,path,'code'),'utf8'),'pending '+path);assert.equal(await readFile(join(repo,path,'artifact'),'utf8'),'artifact '+path);}
});
