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
export function createDailySyncService(config,synchronize,logger,{clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
 let active=false,timer,pending;
 const attempted=new Map();
 async function tick() {
  for(const [agentId,binding] of Object.entries(config.agents)) {
   if(!active)break;
   if(!binding.sync?.enabled||!binding.sync.submoduleSchedule)continue;
   const date=scheduleDate(new Date(clock()),binding.sync.submoduleSchedule);
   if(!date||attempted.get(agentId)===date)continue;
   // Mark before awaiting so slow or failed preparations cannot be reentered.
   attempted.set(agentId,date);
   try{
    const result=await synchronize(agentId,date);
    if(!result?.skipped){
     if(result?.ok)logger?.info?.(`agent-repo: daily submodule sync completed for ${agentId} (${date})`);
     else logger?.warn?.(`agent-repo: daily submodule sync failed for ${agentId} (${date}); inspect Git daily sync receipt`);
    }
   }catch{logger?.warn?.(`agent-repo: daily submodule sync failed for ${agentId} (${date}); inspect repository state and Git daily sync receipt`);}
  }
 }
 function loop(){
  pending=tick().finally(()=>{pending=undefined;if(active){timer=setTimer(loop,60000-clock()%60000);timer?.unref?.();}});
  return pending;
 }
 return {id:'agent-repo-daily-submodule-sync',start(){if(active)return pending;active=true;return loop();},async stop(){active=false;clearTimer(timer);await pending;}};
}
