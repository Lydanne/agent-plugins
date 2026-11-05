import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {acquireProjectReadLease,projectHasReaders} from './project-read-lease.mjs';
test('multiple readers coexist; a writer blocks new readers without clearing its lock',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'project-reader-'));t.after(()=>rm(cwd,{recursive:true,force:true}));execFileSync('git',['init',cwd],{stdio:'ignore'});
 const a=await acquireProjectReadLease(cwd),b=await acquireProjectReadLease(cwd);assert.equal(await projectHasReaders(cwd),true);await a();assert.equal(await projectHasReaders(cwd),true);await b();assert.equal(await projectHasReaders(cwd),false);
 await writeFile(join(cwd,'.git/ada-workspace-sync.lock'),String(process.pid));await assert.rejects(acquireProjectReadLease(cwd,{timeoutMs:1}),/synchronization/);assert.equal(await projectHasReaders(cwd),false);
});
test('shared child sources require the declared branch and preserve dirty contents',async t=>{
 const {mkdir,realpath,readFile}=await import('node:fs/promises'),{checkProjectChildren}=await import('./project-read-lease.mjs');
 const temp=await mkdtemp(join(tmpdir(),'project-children-'));t.after(()=>rm(temp,{recursive:true,force:true}));const root=await realpath(temp),child=join(root,'repositories/demo');await mkdir(child,{recursive:true});
 const git=(cwd,args)=>execFileSync('git',args,{cwd,stdio:'ignore'});for(const cwd of [root,child]){git(cwd,['init','-b','main']);git(cwd,['config','user.name','Fixture']);git(cwd,['config','user.email','fixture@example.invalid']);}
 git(child,['remote','add','origin','https://example.invalid/demo']);await writeFile(join(child,'code'),'initial');git(child,['add','code']);git(child,['commit','-m','fixture']);
 await writeFile(join(root,'.gitmodules'),'[submodule "demo"]\npath = repositories/demo\nurl = https://example.invalid/demo\nbranch = main\n');git(root,['add','.gitmodules']);git(root,['commit','-m','fixture']);
 await checkProjectChildren(root,'main');git(child,['switch','-c','task']);await assert.rejects(checkProjectChildren(root,'main'),/default branch/);git(child,['switch','main']);await writeFile(join(child,'code'),'preserved');await assert.rejects(checkProjectChildren(root,'main'),/local changes/);assert.equal(await readFile(join(child,'code'),'utf8'),'preserved');
});
