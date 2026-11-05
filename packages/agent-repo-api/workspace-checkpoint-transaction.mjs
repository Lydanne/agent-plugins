import {mkdir,realpath,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {acquireLock} from './workspace-lock.mjs';
import {createCheckpoint,readCheckpoint,updateCheckpoint} from './workspace-checkpoints.mjs';
import {captureTrackedCheckpoint,restoreTrackedCheckpoint,verifyTrackedCheckpointSource,clearTrackedCheckpointSource} from './workspace-git-checkpoint.mjs';
import {captureExtraFiles,restoreExtraFiles,verifyExtraCheckpointSource,clearExtraCheckpointSource} from './workspace-files-checkpoint.mjs';
import {poolGit} from './workspace-pool.mjs';

// The pool must fence the slot and confirm the Worker process group is gone
// before calling. This transaction captures only; it never cleans or releases.
export async function saveWorkspaceCheckpoint(stateRoot,binding,repositories) {
 if(!Array.isArray(repositories)||!repositories.length||new Set(repositories.map(r=>r.path)).size!==repositories.length)throw Error('Invalid checkpoint repositories');
 const root=await realpath(binding.workspacePath);
 if(root!==binding.workspacePath)throw Error('Workspace identity changed');
 const verified=[];
 for(const repo of repositories) {
  if(repo.path!=='.'&&!/^(?:wiki|repositories\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(repo.path))throw Error('Invalid checkpoint repository path');
  const path=resolve(root,repo.path);
  if(await realpath(path)!==path||await realpath(await poolGit(path,['rev-parse','--show-toplevel']))!==path||await poolGit(path,['remote','get-url','origin'])!==repo.url)throw Error('Checkpoint repository identity changed');
  verified.push({...repo,absolutePath:path});
 }
 // Create/validate the journal directory before an operation lock lives in it.
 let record=await createCheckpoint(stateRoot,binding);
 const id=createHash('sha256').update(JSON.stringify(record.binding)).digest('hex');
 const dir=join(await realpath(stateRoot),'workspace-checkpoints');
 if((await lstat(dir)).isSymbolicLink())throw Error('Checkpoint directory changed');
 const release=await acquireLock(join(dir,id+'.operation.lock'));
 try {
  record=await createCheckpoint(stateRoot,binding);
  if(record.status==='saved')return record;
  if(record.status!=='saving'||record.repositories.length)throw Error('Interrupted checkpoint requires recovery; original files preserved');
  const filesRoot=join(dir,id+'.files');await mkdir(filesRoot,{mode:0o700});
  for(const repo of verified) {
   const receipt={path:repo.path,url:repo.url,stage:'capturing',filesDirectory:join(filesRoot,createHash('sha256').update(repo.path).digest('hex'))};
   record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'saving',repositories:[...record.repositories,receipt]});
   const git=await captureTrackedCheckpoint(repo.absolutePath,{...binding,repository:repo.path});
   record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'saving',repositories:record.repositories.map(r=>r.path===repo.path?{...r,git,stage:'git_saved'}:r)});
   const exclude=repo.path==='.'?verified.filter(r=>r.path!=='.').map(r=>r.path):[];
   const files=await captureExtraFiles(repo.absolutePath,receipt.filesDirectory,{exclude});
   record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'saving',repositories:record.repositories.map(r=>r.path===repo.path?{...r,files,stage:'saved'}:r)});
  }
  return await updateCheckpoint(stateRoot,binding,record.revision,{status:'saved',repositories:record.repositories});
 } catch(error) {
  if(record.status==='saving') {
   // If this write fails, the earlier saving intent remains a fail-closed record.
   await updateCheckpoint(stateRoot,binding,record.revision,{status:'recovery_required',repositories:record.repositories}).catch(()=>{});
  }
  throw error;
 } finally {release();}
}

// Called only after the pool has exclusively claimed the original slot. A
// restoring/recovery_required record is deliberately not automatically replayed:
// Git apply may have succeeded before its receipt was durably written.
export async function restoreWorkspaceCheckpoint(stateRoot,binding,{protectedCheckpoints=[]}={}) {
 let record=await readCheckpoint(stateRoot,binding);
 const id=createHash('sha256').update(JSON.stringify(record.binding)).digest('hex');
 const dir=join(await realpath(stateRoot),'workspace-checkpoints');
 const release=await acquireLock(join(dir,id+'.operation.lock'));
 try {
  record=await readCheckpoint(stateRoot,binding);
  if(record.status!=='parked')throw Error('Checkpoint is not ready for restoration; inspect existing recovery');
  if(await realpath(binding.workspacePath)!==binding.workspacePath)throw Error('Original workspace identity changed');
  if(!record.repositories.length||record.repositories.some(repo=>repo.stage!=='released'))throw Error('Incomplete repository checkpoint');
  // Validate every repository identity before touching the first repository.
  for(const repo of record.repositories) {
   if(repo.path!=='.'&&!/^(?:wiki|repositories\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(repo.path))throw Error('Invalid checkpoint repository path');
   const path=resolve(binding.workspacePath,repo.path);
   if(await realpath(path)!==path||await realpath(await poolGit(path,['rev-parse','--show-toplevel']))!==path||await poolGit(path,['remote','get-url','origin'])!==repo.url)throw Error('Original repository identity changed');
   const expected=join(dir,id+'.files',createHash('sha256').update(repo.path).digest('hex'));
   if(repo.filesDirectory!==expected||await realpath(expected)!==expected)throw Error('Checkpoint file directory changed');
  }
  const protectedRecords=[];
  for(const other of protectedCheckpoints){
   if(other.workspaceId!==binding.workspaceId||other.workspacePath!==binding.workspacePath||other.projectId!==binding.projectId||other.assignmentId===binding.assignmentId)throw Error('Branch preservation belongs to another workspace');
   const proof=await readCheckpoint(stateRoot,other);
   const expectedStage=proof.status==='parked'?'released':proof.status==='restored'?'restored':undefined;
   if(!expectedStage||!proof.repositories.length||proof.repositories.some(repo=>repo.stage!==expectedStage))throw Error('Branch preservation checkpoint is incomplete');
   protectedRecords.push(proof);
  }
  record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'restoring',repositories:record.repositories});
  for(const repo of record.repositories) {
   const path=resolve(binding.workspacePath,repo.path);
   record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'restoring',repositories:record.repositories.map(r=>r.path===repo.path?{...r,stage:'restoring_git'}:r)});
   await restoreTrackedCheckpoint(path,repo.git,{protectedBranches:protectedRecords.flatMap(proof=>proof.repositories.filter(other=>other.path===repo.path&&other.url===repo.url).map(other=>other.git))});
   record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'restoring',repositories:record.repositories.map(r=>r.path===repo.path?{...r,stage:'restoring_files'}:r)});
   await restoreExtraFiles(path,repo.filesDirectory,repo.files,{expectedRoot:path});
   record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'restoring',repositories:record.repositories.map(r=>r.path===repo.path?{...r,stage:'restored'}:r)});
  }
  return await updateCheckpoint(stateRoot,binding,record.revision,{status:'restored',repositories:record.repositories});
 } catch(error) {
  if(record.status==='restoring')await updateCheckpoint(stateRoot,binding,record.revision,{status:'recovery_required',repositories:record.repositories}).catch(()=>{});
  throw error;
 } finally {release();}
}


// A saved checkpoint is not a free slot. The pool may mark the slot reusable
// only after this transaction reaches parked, while retaining the binding.
export async function releaseCheckpointContents(stateRoot,binding) {
 let record=await readCheckpoint(stateRoot,binding);
 const id=createHash('sha256').update(JSON.stringify(record.binding)).digest('hex');
 const dir=join(await realpath(stateRoot),'workspace-checkpoints');
 const release=await acquireLock(join(dir,id+'.operation.lock'));
 try {
  record=await readCheckpoint(stateRoot,binding);
  if(record.status!=='saved'||!record.repositories.length||record.repositories.some(repo=>repo.stage!=='saved'))throw Error('Checkpoint is not ready for release');
  if(await realpath(binding.workspacePath)!==binding.workspacePath)throw Error('Original workspace identity changed');
  const prepared=[];
  for(const repo of record.repositories) {
   if(repo.path!=='.'&&!/^(?:wiki|repositories\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(repo.path))throw Error('Invalid checkpoint repository path');
   const path=resolve(binding.workspacePath,repo.path);
   if(await realpath(path)!==path||await poolGit(path,['remote','get-url','origin'])!==repo.url)throw Error('Repository identity changed before release');
   const expected=join(dir,id+'.files',createHash('sha256').update(repo.path).digest('hex'));
   if(repo.filesDirectory!==expected||await realpath(expected)!==expected)throw Error('Checkpoint file directory changed');
   const options={exclude:repo.path==='.'?record.repositories.filter(r=>r.path!=='.').map(r=>r.path):[]};
   await verifyTrackedCheckpointSource(path,repo.git);
   await verifyExtraCheckpointSource(path,repo.filesDirectory,repo.files,options);
   prepared.push({repo,path,options});
  }
  record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'releasing',repositories:record.repositories});
  for(const {repo,path,options} of prepared) {
   record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'releasing',repositories:record.repositories.map(r=>r.path===repo.path?{...r,stage:'releasing'}:r)});
   await clearExtraCheckpointSource(path,repo.filesDirectory,repo.files,options);
   await clearTrackedCheckpointSource(path,repo.git);
   record=await updateCheckpoint(stateRoot,binding,record.revision,{status:'releasing',repositories:record.repositories.map(r=>r.path===repo.path?{...r,stage:'released'}:r)});
  }
  return await updateCheckpoint(stateRoot,binding,record.revision,{status:'parked',repositories:record.repositories});
 } catch(error) {
  if(record.status==='releasing')await updateCheckpoint(stateRoot,binding,record.revision,{status:'recovery_required',repositories:record.repositories}).catch(()=>{});
  throw error;
 } finally {release();}
}

// A completed restore can lose its scheduler acknowledgement. Verify the full
// original snapshot before acknowledging it; never apply the stash a second time.
export async function verifyRestoredWorkspaceCheckpoint(stateRoot,binding) {
 const record=await readCheckpoint(stateRoot,binding);
 if(record.status!=='restored'||!record.repositories.length||record.repositories.some(r=>r.stage!=='restored'))throw Error('Checkpoint restoration is incomplete; recovery required');
 const id=createHash('sha256').update(JSON.stringify(record.binding)).digest('hex');
 const dir=join(await realpath(stateRoot),'workspace-checkpoints');
 if(await realpath(binding.workspacePath)!==binding.workspacePath)throw Error('Original workspace identity changed');
 for(const repo of record.repositories){
  if(repo.path!=='.'&&!/^(?:wiki|repositories\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(repo.path))throw Error('Invalid checkpoint repository path');
  const path=resolve(binding.workspacePath,repo.path);
  if(await realpath(path)!==path||await poolGit(path,['remote','get-url','origin'])!==repo.url)throw Error('Original repository identity changed');
  const expected=join(dir,id+'.files',createHash('sha256').update(repo.path).digest('hex'));
  if(repo.filesDirectory!==expected||await realpath(expected)!==expected)throw Error('Checkpoint file directory changed');
  await verifyTrackedCheckpointSource(path,repo.git);
  await verifyExtraCheckpointSource(path,repo.filesDirectory,repo.files,{exclude:repo.path==='.'?record.repositories.filter(r=>r.path!=='.').map(r=>r.path):[]});
 }
 return record;
}
