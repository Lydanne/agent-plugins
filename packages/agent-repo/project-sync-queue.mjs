// Per-project coalescing and bounded retry; failed fetches never reject task admission.
export function createProjectSyncQueue({clock=Date.now,logger,cooldownMs=60000}={}){
 const pending=new Map(),last=new Map();let running,stopped=false,timer;
 function enqueue(key,run){if(!pending.has(key))pending.set(key,run);return {mode:'background',state:'queued',lastAttemptAt:last.get(key)};}
 async function tick(){
  if(stopped||running)return running;
  running=(async()=>{for(const [key,run] of pending){if(stopped)break;if(clock()-(last.get(key)??-Infinity)<cooldownMs)continue;
   pending.delete(key);last.set(key,clock());try{if(await run()===false)pending.set(key,run);}catch{logger?.warn?.('agent-repo: background project sync failed; inspect repository logs');}
  }})().finally(()=>{running=undefined;});return running;
 }
 return {enqueue,tick,start(){if(timer)return;stopped=false;timer=setInterval(()=>void tick(),1000);timer.unref();},async stop(){stopped=true;clearInterval(timer);timer=undefined;await running;}};
}
