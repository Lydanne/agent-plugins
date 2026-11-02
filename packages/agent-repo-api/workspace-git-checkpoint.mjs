import {realpath,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {poolGit} from './workspace-pool.mjs';

// Capture tracked state without cleaning the index or worktree. The caller must
// also preserve untracked/ignored files before making the slot reusable.
export async function captureTrackedCheckpoint(path,binding) {
  binding={...binding,checkpointId:binding?.checkpointId??'initial'};
  const fields=['agentId','projectId','jobId','assignmentId','workspaceId','repository','checkpointId'];
  if(fields.some(key=>typeof binding?.[key]!=='string'||!binding[key])) throw Error('Invalid Git checkpoint binding');
  const key=createHash('sha256').update(JSON.stringify(fields.map(key=>binding[key]))).digest('hex');
  const prefix='refs/agent-workspace-checkpoints/'+key;
  const head=await poolGit(path,['rev-parse','HEAD']);
  const branch=await poolGit(path,['symbolic-ref','--quiet','--short','HEAD']).catch(error=>{if(error.code===1)return null;throw error;});
  // Zero old-value prevents overwriting any previous recovery object.
  await poolGit(path,['update-ref',prefix+'/head',head,'0'.repeat(head.length)]);
  const stash=await poolGit(path,['-c','user.name=Workspace Checkpoint','-c','user.email=checkpoint@localhost','stash','create','workspace-checkpoint:'+key]);
  if(stash) await poolGit(path,['update-ref',prefix+'/tracked',stash,'0'.repeat(head.length)]);
  return {repositoryPath:await realpath(path),gitDirectory:await realpath(await poolGit(path,['rev-parse','--absolute-git-dir'])),head,branch,headRef:prefix+'/head',stash:stash||null,stashRef:stash?prefix+'/tracked':null};
}

async function verifyGitCheckpoint(path,saved) {
 if(await realpath(path)!==saved.repositoryPath || await realpath(await poolGit(path,['rev-parse','--show-toplevel']))!==saved.repositoryPath ||
    await realpath(await poolGit(path,['rev-parse','--absolute-git-dir']))!==saved.gitDirectory) throw Error('Original Git repository binding changed');
 if(!/^[a-f0-9]{40,64}$/.test(saved.head)||!/^refs\/agent-workspace-checkpoints\/[a-f0-9]{64}\/head$/.test(saved.headRef))throw Error('Invalid Git checkpoint receipt');
 if(await poolGit(path,['rev-parse',saved.headRef])!==saved.head)throw Error('Saved HEAD reference changed');
 if(saved.stash) {
  if(!/^[a-f0-9]{40,64}$/.test(saved.stash)||saved.stashRef!==saved.headRef.replace(/head$/,'tracked'))throw Error('Invalid stash checkpoint receipt');
  if(await poolGit(path,['rev-parse',saved.stashRef])!==saved.stash || await poolGit(path,['rev-parse',saved.stash+'^1'])!==saved.head)throw Error('Saved stash reference changed');
 }
 for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply']) {
  let present=true;try{await access(resolve(path,await poolGit(path,['rev-parse','--git-path',name])));}catch(error){if(error.code==='ENOENT')present=false;else throw error;}
  if(present)throw Error('Git operation pending; recovery withheld');
 }
}
// The caller must hold the original slot's exclusive restoration lease and
// persist restoring intent before invoking this operation. Never drop refs here.
export async function restoreTrackedCheckpoint(path,saved) {
 await verifyGitCheckpoint(path,saved);
 if(await poolGit(path,['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=all']))throw Error('Restore requires a clean repository');
 if(saved.branch) {
  await poolGit(path,['check-ref-format','--branch',saved.branch]);
  let tip;try{tip=await poolGit(path,['rev-parse','--verify','refs/heads/'+saved.branch]);}catch(error){if(error.code!==128)throw error;}
  if(tip&&tip!==saved.head)throw Error('Original branch changed; recovery withheld');
  await poolGit(path,['checkout','--no-overwrite-ignore',...(tip?[saved.branch]:['-b',saved.branch,saved.head])]);
 } else await poolGit(path,['checkout','--no-overwrite-ignore','--detach',saved.head]);
 if(saved.stash)await poolGit(path,['stash','apply','--index',saved.stash]);
 if(await poolGit(path,['rev-parse','HEAD'])!==saved.head)throw Error('Restored HEAD verification failed');
 if(saved.stash && await poolGit(path,['write-tree'])!==await poolGit(path,['rev-parse',saved.stash+'^2^{tree}']))throw Error('Restored index verification failed');
 await verifyTrackedCheckpointSource(path,saved);
 return {status:'restored',head:saved.head};
}

export async function verifyTrackedCheckpointSource(path,saved) {
 await verifyGitCheckpoint(path,saved);
 if(await poolGit(path,['rev-parse','HEAD'])!==saved.head)throw Error('HEAD changed after capture');
 const branch=await poolGit(path,['symbolic-ref','--quiet','--short','HEAD']).catch(error=>{if(error.code===1)return null;throw error;});
 if(branch!==saved.branch)throw Error('Branch changed after capture');
 const expectedIndex=await poolGit(path,['rev-parse',(saved.stash?saved.stash+'^2':saved.head)+'^{tree}']);
 if(await poolGit(path,['write-tree'])!==expectedIndex)throw Error('Index changed after capture');
 try {await poolGit(path,['diff','--exit-code','--ignore-submodules=all',saved.stash??saved.head,'--']);}
 catch(error){if(error.code===1)throw Error('Tracked files changed after capture');throw error;}
}
// Only after every repository and extra-file snapshot passed verification, under
// an exclusive slot lease and durable releasing intent. Never delete refs.
export async function clearTrackedCheckpointSource(path,saved) {
 await verifyTrackedCheckpointSource(path,saved);
 await poolGit(path,['restore','--source='+saved.head,'--staged','--worktree','--','.']);
}
