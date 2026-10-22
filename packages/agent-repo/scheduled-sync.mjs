import {open,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {repositorySyncTaskId,repositorySyncRunId} from './scheduled-tasks.mjs';
import {git} from './repository-skills.mjs';

// A durable exclusive receipt prevents reload/restart or another process from
// repeating this Agent's attempt on the same local date. Failed/crashed attempts
// are retained for operator review, never silently replayed.
export async function claimDailySync(root,agentId,date) {
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId)||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Invalid daily sync identity');
 const directory=(await git(root,['rev-parse','--absolute-git-dir'])).trim();
 let handle;
 try{handle=await open(join(directory,`agent-repo-daily-sync-${agentId}-${date}.json`),'wx',0o600);}
 catch(error){if(error.code==='EEXIST')return null;throw error;}
 const record={agentId,date,taskId:repositorySyncTaskId(agentId),runId:repositorySyncRunId(agentId,date),startedAt:new Date().toISOString(),status:'running',logs:[]};
 try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();}finally{await handle.close();}
 const path=join(directory,`agent-repo-daily-sync-${agentId}-${date}.json`);
 let pending=Promise.resolve(),logBytes=0;
 const persist=change=>{
  pending=pending.then(async()=>{
   change();const temp=path+'.'+randomUUID()+'.tmp';
   try{const output=await open(temp,'wx',0o600);try{await output.writeFile(JSON.stringify(record)+'\n');await output.sync();}finally{await output.close();}await rename(temp,path);}
   finally{await unlink(temp).catch(()=>{});}
  });return pending;
 };
 return {
  log(event){return persist(()=>{
   if(record.logs.length>=400){record.logsTruncated=true;return;}
   const row={time:new Date().toISOString()};
   for(const key of ['stage','status','projectId','repository','branch','head','reason'])if(typeof event[key]==='string')row[key]=event[key].slice(0,2000);
   const bytes=Buffer.byteLength(JSON.stringify(row));
   if(logBytes+bytes>256*1024){record.logsTruncated=true;return;}
   logBytes+=bytes;record.logs.push(row);
  });},
  finish(result){return persist(()=>Object.assign(record,{status:result.ok?'completed':'failed',finishedAt:new Date().toISOString(),result}));},
 };
}
export function scheduleDate(now,schedule) {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 return `${parts.hour}:${parts.minute}`>=schedule.time?`${parts.year}-${parts.month}-${parts.day}`:null;
}
export {createDailySyncService} from './native-sync-scheduler.mjs';
