import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {git,RepositoryGitCheckError} from './repository-skills.mjs';

async function fakeGit(t,body){
 const base=fileURLToPath(new URL('../../.tmp/git-check-tests/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'case-')),binary=join(root,'git');
 await writeFile(binary,`#!${process.execPath}\n${body}\n`);await chmod(binary,0o700);
 const previous=process.env.PATH;process.env.PATH=root+(previous?':'+previous:'');
 t.after(async()=>{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;await rm(root,{recursive:true,force:true});});
 return root;
}
test('a bounded Git check survives a slow local inspection beyond the former five-second deadline',{skip:process.platform==='win32'},async t=>{
 const root=await fakeGit(t,"setTimeout(()=>process.stdout.write('fixture-head\\n'),5500);");
 assert.equal(await git(root,['rev-parse','HEAD']),'fixture-head\n');
});
test('a timed-out Git child returns a safe actionable error without replaying the command',{skip:process.platform==='win32'},async t=>{
 const root=await fakeGit(t,'setTimeout(()=>{},2000);');
 await assert.rejects(git(root,['rev-parse','private-value'],{timeoutMs:100}),error=>{assert(error instanceof RepositoryGitCheckError);assert.equal(error.kind,'timeout');assert(!error.message.includes('private-value'));return true;});
});
test('output exhaustion remains distinct from timeout and never exposes child stdout',{skip:process.platform==='win32'},async t=>{
 const root=await fakeGit(t,"process.stdout.write('private-value'.repeat(300000));");
 await assert.rejects(git(root,['ls-tree','HEAD']),error=>{assert(error instanceof RepositoryGitCheckError);assert.equal(error.kind,'output_limit');assert(!error.message.includes('private-value'));return true;});
});
