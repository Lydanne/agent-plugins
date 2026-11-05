import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,unlink,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const exec=promisify(execFile);
const exists=async file=>{try{await access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
async function paths(cwd){const {stdout}=await exec('git',['rev-parse','--absolute-git-dir'],{cwd,timeout:5000});const root=stdout.trim();return {readers:join(root,'agent-repo-readers'),writer:join(root,'ada-workspace-sync.lock')};}
// Sync owns writer before checking readers; readers publish then recheck writer.
// This handshake prevents checkout while any Worker reads the shared project.
export async function projectHasReaders(cwd){
 const {readers}=await paths(cwd);let names;try{names=await readdir(readers);}catch(e){if(e.code==='ENOENT')return false;throw e;}
 for(const name of names){const file=join(readers,name);let pid;try{pid=JSON.parse(await readFile(file,'utf8')).pid;}catch(e){if(e.code==='ENOENT')continue;return true;}
 if(!Number.isSafeInteger(pid)||pid<1)return true;
 try{process.kill(pid,0);return true;}catch(e){if(e.code!=='ESRCH')return true;await unlink(file).catch(()=>{});}
 }return false;
}
export async function acquireProjectReadLease(cwd,{signal,timeoutMs=35000}={}){
 const {readers,writer}=await paths(cwd),deadline=Date.now()+timeoutMs;
 await mkdir(readers,{recursive:true,mode:0o700});const file=join(readers,randomUUID()+'.json');
 for(;;){signal?.throwIfAborted();
  if(!await exists(writer)){
   await writeFile(file,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
   if(!await exists(writer))return async()=>{await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});};
   await unlink(file);
  }
  if(Date.now()>=deadline)throw Error('Project synchronization is still active; retry after it settles');
  await new Promise(resolve=>setTimeout(resolve,50));
 }
}

// Registered direct child repositories are part of the shared read-only copy.
export async function checkProjectChildren(cwd,defaultBranch){
 const git=async (root,args)=>(await exec('git',['--no-optional-locks','-c','core.fsmonitor=false',...args],{cwd:root,timeout:10000,maxBuffer:2*1024*1024})).stdout.trim();
 let modules;try{modules=await git(cwd,['config','--blob','HEAD:.gitmodules','--get-regexp','^submodule\\..*\\.path$']);}catch(error){if([1,128].includes(error.code))return;throw error;}
 for(const row of modules.split('\n').filter(Boolean)){
  const [key,path]=row.split(/\s+/);if(!/^(?:wiki|repositories\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(path))throw Error('Unsupported shared project repository layout');
  const prefix=key.slice(0,-4),root=join(cwd,path);
  const {realpath}=await import('node:fs/promises');
  if(await realpath(root)!==root||await git(root,['rev-parse','--show-toplevel'])!==root)throw Error('Shared child repository is not initialized or its path changed');
  let branch;try{branch=await git(cwd,['config','--blob','HEAD:.gitmodules','--get',prefix+'branch']);}catch(error){if(error.code!==1)throw error;branch=defaultBranch;}
  if(await git(root,['branch','--show-current'])!==branch)throw Error('Shared child repository must stay on its registered default branch');
  if(await git(root,['remote','get-url','origin'])!==await git(cwd,['config','--blob','HEAD:.gitmodules','--get',prefix+'url']))throw Error('Shared child repository origin changed');
  if(await git(root,['status','--porcelain=v1','--untracked-files=all']))throw Error('Shared child repository has local changes; source preserved');
 }
}
