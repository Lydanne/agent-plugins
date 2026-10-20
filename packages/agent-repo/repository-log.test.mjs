import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink,writeFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {git} from './repository-skills.mjs';
import {writeRepositoryLog,readRepositoryLogs} from './repository-log.mjs';
test('repository diagnostics are bounded, private, Agent scoped and reject unsafe files',async t=>{
 const base=fileURLToPath(new URL('../../.tmp/repository-log-tests/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));t.after(()=>rm(root,{recursive:true,force:true}));await git(root,['init','-b','main']);
 for(let i=0;i<102;i++)await writeRepositoryLog(root,'main',{stage:'sync',status:'skipped',reason:'safe https://secret.example/token?signature=secret',chat:'never saved'});
 await writeRepositoryLog(root,'other',{stage:'other'});
 const result=await readRepositoryLogs(root,'main');assert.equal(result.records.length,100);assert(result.records.every(row=>row.stage==='sync'));assert(!JSON.stringify(result).includes('signature'));assert(!JSON.stringify(result).includes('never saved'));
 const files=(await readdir(join(root,'.git'))).filter(name=>name.startsWith('agent-repo-log-main-'));assert.equal(files.length,100);assert.equal((await stat(join(root,'.git',files[0]))).mode&0o777,0o600);
 const prefix='agent-repo-log-main-9999999999999-',suffix='00000000-0000-0000-0000-00000000000';
 const outside=join(root,'private');await writeFile(outside,'private contents');await symlink(outside,join(root,'.git',prefix+suffix+'1.json'));
 await writeFile(join(root,'.git',prefix+suffix+'2.json'),JSON.stringify({agentId:'other',stage:'foreign'}));
 assert(!(await readRepositoryLogs(root,'main')).records.some(row=>row.stage==='foreign'));
 await assert.rejects(readRepositoryLogs(root,'../main'));await assert.rejects(writeRepositoryLog(root,'../main',{}));
});

test('clearing removes only current Agent diagnostic files and preserves receipts, other Agents and symlink targets',async t=>{
 const base=fileURLToPath(new URL('../../.tmp/repository-log-tests/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'clear-'));t.after(()=>rm(root,{recursive:true,force:true}));await git(root,['init','-b','main']);
 const {clearRepositoryLogs}=await import('./repository-log.mjs'),{readFile}=await import('node:fs/promises');
 await writeRepositoryLog(root,'main',{reason:'clear this'});await writeRepositoryLog(root,'other',{reason:'keep this'});
 const receipt=join(root,'.git','agent-repo-daily-sync-main-2026-10-14.json'),outside=join(root,'outside');await writeFile(receipt,'receipt');await writeFile(outside,'preserved target');
 await symlink(outside,join(root,'.git','agent-repo-log-main-9999999999999-00000000-0000-0000-0000-000000000001.json'));
 const result=await clearRepositoryLogs(root,'main');assert.equal(result.cleared,2);assert.deepEqual(result.records,[]);assert.equal((await readRepositoryLogs(root,'other')).records[0].reason,'keep this');assert.equal(await readFile(receipt,'utf8'),'receipt');assert.equal(await readFile(outside,'utf8'),'preserved target');
 assert.equal((await clearRepositoryLogs(root,'main')).cleared,0);await assert.rejects(clearRepositoryLogs(root,'../other'));
 await writeRepositoryLog(root,'main',{reason:'new after clear'});assert.equal((await readRepositoryLogs(root,'main')).records[0].reason,'new after clear');
});
