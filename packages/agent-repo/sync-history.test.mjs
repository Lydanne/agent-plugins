import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {git} from './repository-skills.mjs';
import {readSyncHistory} from './sync-history.mjs';
test('history bounds results and rejects oversized, malformed, foreign and symlink receipts',async t=>{
 const base=fileURLToPath(new URL('../../.tmp/daily-sync-tests/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'bounded-'));t.after(()=>rm(root,{recursive:true,force:true}));await git(root,['init','-b','main']);
 const path=day=>join(root,'.git',`agent-repo-daily-sync-main-${day}.json`);
 for(let i=1;i<=31;i++){const day=`2026-10-${String(i).padStart(2,'0')}`;await writeFile(path(day),JSON.stringify({agentId:'main',date:day,status:'completed'}));}
 const history=await readSyncHistory(root,'main');assert.equal(history.records.length,30);assert.equal(history.hasMore,true);assert.equal(history.records[0].date,'2026-10-31');
 const outside=join(root,'private.json');await writeFile(outside,'private contents');await symlink(outside,path('2026-11-01'));
 await writeFile(path('2026-11-02'),'x'.repeat(512*1024+1));await writeFile(path('2026-11-03'),'{');
 await writeFile(path('2026-11-04'),JSON.stringify({agentId:'other',date:'2026-11-04',status:'completed'}));
 const result=await readSyncHistory(root,'main');assert(result.records.slice(0,4).every(row=>row.status==='unavailable'));assert(!JSON.stringify(result).includes('private contents'));
 for(const day of ['2026-11-01','2026-11-02','2026-11-03','2026-11-04'])await assert.rejects(readSyncHistory(root,'main',day));
 await assert.rejects(readSyncHistory(root,'../main'));await assert.rejects(readSyncHistory(root,'main','../private'));
});
