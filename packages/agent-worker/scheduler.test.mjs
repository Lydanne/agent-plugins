import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createJobs,writeJson,readJson} from './jobs.mjs';
import {spawn} from 'node:child_process';
import {tryLock} from './locks.mjs';
const params={topic:'same',task:'fixture',context:'fixture',constraints:'read-only',waitSeconds:0};
function fixture(capacity=2,queued=100){
 const root=mkdtempSync(join(tmpdir(),'codex-scheduler-')),worker=join(root,'worker.mjs');
 writeFileSync(worker,`import{readFileSync,writeFileSync,renameSync,existsSync,appendFileSync}from'node:fs';
 const[root,id]=process.argv.slice(2);for await(const c of process.stdin){};
 const path=root+'/'+id+'.json';const job=JSON.parse(readFileSync(path));
 appendFileSync(root+'/launches',id+'\\n');writeFileSync(root+'/'+id+'.started','yes');
 const timer=setInterval(()=>{job.heartbeatAt=Date.now();
 if(existsSync(root+'/'+id+'.release')||existsSync(root+'/'+id+'.cancel')){job.status=existsSync(root+'/'+id+'.cancel')?'cancelled':'completed';job.finishedAt=Date.now();clearInterval(timer);}
 writeFileSync(path+'.worker',JSON.stringify(job));renameSync(path+'.worker',path);},20);`);
 const options={root,node:process.execPath,worker,getLimits:()=>({maxConcurrentJobs:capacity,maxQueuedJobs:queued})};
 return {root,options,jobs:createJobs(options),release:id=>writeFileSync(join(root,id+'.release'),'yes')};
}
async function until(check){for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture did not reach expected state');}
async function cleanup(f){f.jobs.stop();for(const file of (await import('node:fs')).readdirSync(f.root).filter(x=>/^[0-9a-f-]{36}\.json$/.test(x)))f.release(file.slice(0,-5));await new Promise(r=>setTimeout(r,100));rmSync(f.root,{recursive:true,force:true});}

test('different execution sessions run concurrently while requests for one session stay serialized',async()=>{
 const f=fixture();
 const getRuntime=params=>({modelId:params.modelId,harness:'codex',model:'fixture-'+params.modelId,modelSessionScope:createHash('sha256').update(params.modelId).digest('hex')});
 f.jobs=createJobs({...f.options,getRuntime});
 try{
  const quick=await f.jobs.run({...params,modelId:'quick'},'models');
  const higher=await f.jobs.run({...params,modelId:'quick',requestId:'followup'},'models');
  const deep=await f.jobs.run({...params,modelId:'deep',requestId:'followup'},'models');
  assert.equal(quick.status,'running');assert.equal(deep.status,'running');assert.equal(higher.status,'queued');assert.equal(higher.waitingReason,'session_busy');
  assert.equal(higher.modelId,'quick');assert.equal(higher.thinkingLevel,undefined);
  await until(()=>existsSync(join(f.root,quick.jobId+'.started'))&&existsSync(join(f.root,deep.jobId+'.started')));
  f.release(quick.jobId);await until(()=>f.jobs.status(quick.jobId,'models').status==='completed');f.jobs.tick();
  await until(()=>existsSync(join(f.root,higher.jobId+'.started')));
 }finally{await cleanup(f);}
});

test('resource locks still serialize writes across different model sessions',async()=>{
 const f=fixture();
 f.jobs=createJobs({...f.options,getRuntime:params=>({modelId:params.modelId,modelSessionScope:createHash('sha256').update(params.modelId).digest('hex')})});
 try{
  const quick=await f.jobs.run({...params,modelId:'quick',resourceKeys:['shared-record']},'models');
  const deep=await f.jobs.run({...params,modelId:'deep',resourceKeys:['shared-record']},'models');
  assert.equal(quick.status,'running');assert.equal(deep.status,'queued');assert.equal(deep.waitingReason,'resource_busy');
 }finally{await cleanup(f);}
});

test('parallel workers respect capacity and topic FIFO without head-of-line blocking',async()=>{
 const f=fixture();
 try{
  const a=await f.jobs.run(params,'group'),a2=await f.jobs.run({...params,requestId:'second'},'group');
  const b=await f.jobs.run({...params,topic:'other'},'group'),c=await f.jobs.run({...params,topic:'third'},'group');
  assert.equal(a.status,'running');assert.equal(b.status,'running');
  assert.equal(a2.status,'queued');assert.equal(a2.waitingReason,'session_busy');assert.equal(c.status,'queued');assert.equal(c.waitingReason,'capacity');
  await until(()=>existsSync(join(f.root,a.jobId+'.started'))&&existsSync(join(f.root,b.jobId+'.started')));
  assert.ok(!existsSync(join(f.root,a2.jobId+'.started')));
  f.release(b.jobId);await until(()=>f.jobs.status(b.jobId,'group').status==='completed');f.jobs.tick();
  await until(()=>existsSync(join(f.root,c.jobId+'.started')));
  assert.equal(f.jobs.status(a2.jobId,'group').status,'queued');
  f.release(a.jobId);await until(()=>f.jobs.status(a.jobId,'group').status==='completed');f.jobs.tick();
  await until(()=>existsSync(join(f.root,a2.jobId+'.started')));
  assert.ok(readJson(join(f.root,a2.jobId+'.json')).startedAt>=readJson(join(f.root,a.jobId+'.json')).finishedAt);
 }finally{await cleanup(f);}
});

test('restart dispatches durable queued requests and cancels queued work without spawning it',async()=>{
 const f=fixture(1);
 try{
  const a=await f.jobs.run(params,'group'),b=await f.jobs.run({...params,topic:'next'},'group');
  const retry=await f.jobs.run({...params,topic:'next',tags:['new']},'group');assert.equal(retry.jobId,b.jobId);
  const request=readJson(join(f.root,b.jobId+'.request.json'));assert.equal(request.scope,'group');
  const stored=readJson(join(f.root,b.jobId+'.json'));writeJson(join(f.root,b.jobId+'.json'),{...stored,heartbeatAt:0});
  const restarted=createJobs(f.options);assert.equal(restarted.status(b.jobId,'group').status,'queued');
  restarted.start();f.release(a.jobId);
  await until(()=>existsSync(join(f.root,b.jobId+'.started')));restarted.stop();
  const cancelled=await f.jobs.run({...params,topic:'cancel'},'group');
  f.jobs.cancel(cancelled.jobId,'group');f.jobs.tick();
  assert.equal(f.jobs.status(cancelled.jobId,'group').status,'cancelled');
  assert.ok(!existsSync(join(f.root,cancelled.jobId+'.started')));
 }finally{await cleanup(f);}
});

test('resource conflicts serialize across conversations; full queues still deduplicate accepted requests',async()=>{
 const f=fixture(2,1);
 try{
  const p={...params,resourceKeys:['demo:prod:user:target']};
  const a=await f.jobs.run(p,'a'),b=await f.jobs.run(p,'b');
  assert.equal(b.status,'queued');assert.equal(b.waitingReason,'resource_busy');
  assert.equal((await f.jobs.run(p,'b')).jobId,b.jobId);
  const spare=await f.jobs.run({...params,topic:'independent'},'c');assert.equal(spare.status,'running');
  const full=await f.jobs.run({...p,topic:'overflow'},'c');assert.equal(full.status,'queue_full');assert.equal(full.accepted,false);assert.equal(full.jobId,undefined);
  f.release(a.jobId);await until(()=>f.jobs.status(a.jobId,'a').status==='completed');f.jobs.tick();
  await until(()=>existsSync(join(f.root,b.jobId+'.started')));
 }finally{await cleanup(f);}
});

test('unknown reservations never rerun or release their topic, while independent slots remain usable',async()=>{
 const f=fixture(2);
 try{
  const id=randomUUID(),scope=createHash('sha256').update('group').digest('hex');
  writeJson(join(f.root,id+'.json'),{jobId:id,scope,topic:'same',status:'unknown',startedAt:1,heartbeatAt:0,createdAt:1,schedulerVersion:1});
  assert.equal(f.jobs.status(id,'group').status,'unknown');
  const blocked=await f.jobs.run(params,'group'),other=await f.jobs.run({...params,topic:'other'},'group');
  assert.equal(blocked.status,'queued');assert.equal(other.status,'running');
  f.jobs.tick();assert.equal(f.jobs.status(id,'group').status,'unknown');assert.ok(!existsSync(join(f.root,id+'.started')));
  assert.ok(!existsSync(join(f.root,blocked.jobId+'.started')));
 }finally{await cleanup(f);}
});

test('legacy global admission is preserved and short metadata locks recover only confirmed dead owners',async()=>{
 const f=fixture();
 try{
  mkdirSync(join(f.root,'active'));const job=await f.jobs.run(params,'group');
  assert.equal(job.status,'queued');assert.equal(job.waitingReason,'legacy_executor');
  assert.ok(!existsSync(join(f.root,job.jobId+'.started')));
  rmSync(join(f.root,'active'),{recursive:true});f.jobs.tick();await until(()=>existsSync(join(f.root,job.jobId+'.started')));
  const lock=join(f.root,'test-lock'),release=tryLock(lock);assert.equal(tryLock(lock),undefined);release();
  mkdirSync(lock);writeJson(join(lock,'owner.json'),{pid:2147483647,token:'dead'});
  const recovered=tryLock(lock);assert.equal(typeof recovered,'function');recovered();
  mkdirSync(lock);assert.equal(tryLock(lock),undefined); // missing owner must not be guessed dead
 }finally{await cleanup(f);}
});


test('concurrent scheduler processes admit an identical request only once',async()=>{
 const f=fixture();
 try{
  const client=join(f.root,'client.mjs');
  writeFileSync(client,`import {createJobs} from ${JSON.stringify(new URL('./jobs.mjs',import.meta.url).href)};
const jobs=createJobs(${JSON.stringify({root:f.root,node:process.execPath,worker:join(f.root,'worker.mjs')})});
console.log(JSON.stringify(await jobs.run(${JSON.stringify(params)},'group')));`);
  const launch=()=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[client],{stdio:['ignore','pipe','pipe']});let output='',error='';
   child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);
   child.on('close',code=>code===0?resolve(JSON.parse(output)):reject(Error(error)));
  });
  const [a,b]=await Promise.all([launch(),launch()]);assert.equal(a.jobId,b.jobId);
  await until(()=>existsSync(join(f.root,a.jobId+'.started')));
  assert.deepEqual(readFileSync(join(f.root,'launches'),'utf8').trim().split('\n'),[a.jobId]);
 }finally{await cleanup(f);}
});


test('short and long queues have independent per-Agent admission, capacity and positions',async()=>{
 const f=fixture(3,1);
 f.jobs=createJobs({...f.options,getRuntime:()=>({}),getLimits:()=>({maxConcurrentJobs:3,maxQueuedJobs:1,maxConcurrentLongJobs:1,maxQueuedLongJobs:1})});
 const run=(topic,taskClass='short',agentId='ada')=>f.jobs.run({...params,topic,taskClass},agentId,{agentId});
 try{
  for(let n=0;n<3;n++)assert.equal((await run('short-'+n)).status,'running');
  const short=await run('short-wait');assert.equal(short.status,'queued');assert.equal(short.queuePosition,1);
  assert.equal((await run('short-full')).status,'queue_full');
  const long=await run('long','long');assert.equal(long.status,'running');assert.equal(long.timeoutMs,10800000);
  const waitingLong=await run('long-wait','long');assert.equal(waitingLong.status,'queued');assert.equal(waitingLong.queuePosition,1);
  assert.equal((await run('long-full','long')).status,'queue_full');
  assert.equal((await run('short-other','short','other')).status,'running');
  assert.equal((await run('long-other','long','other')).status,'running');
  assert.equal(short.timeoutMs,1800000);
  await until(()=>existsSync(join(f.root,long.jobId+'.started')));
  f.release(long.jobId);await until(()=>f.jobs.status(long.jobId,'ada').status==='completed');
  const restarted=createJobs(f.options);restarted.tick();
  assert.equal(restarted.status(waitingLong.jobId,'ada').status,'running');
  assert.equal(restarted.status(short.jobId,'ada').status,'queued');
 }finally{await cleanup(f);}
});

test('task classes preserve locks, idempotency and admitted timeout snapshots',async()=>{
 const f=fixture();let timeoutMs=1800000,longTimeoutMs=10800000;
 f.jobs=createJobs({...f.options,getRuntime:()=>({timeoutMs,longTimeoutMs})});
 try{
  const p={...params,requestId:'stable',resourceKeys:['record']},who={agentId:'ada'};
  const short=await f.jobs.run(p,'ada',who);
  assert.equal((await f.jobs.run({...p,taskClass:'short'},'ada',who)).jobId,short.jobId);
  await assert.rejects(f.jobs.run({...p,taskClass:'long'},'ada',who),/different task/);
  const long=await f.jobs.run({...p,topic:'long',requestId:'long',taskClass:'long'},'ada',who);
  assert.equal(long.waitingReason,'resource_busy');
  const session=await f.jobs.run({...p,requestId:'same-session-long',taskClass:'long',resourceKeys:[]},'ada',who);
  assert.equal(session.waitingReason,'session_busy');
  timeoutMs=1000;longTimeoutMs=2000;
  const retry=await f.jobs.run({...p,topic:'long',requestId:'long',taskClass:'long'},'ada',who);
  assert.equal(retry.jobId,long.jobId);assert.equal(retry.timeoutMs,10800000);
  assert.equal(readJson(join(f.root,long.jobId+'.request.json')).runtime.timeoutMs,10800000);
  await assert.rejects(f.jobs.run({...params,taskClass:'invalid'},'ada',who),/Invalid taskClass/);
 }finally{await cleanup(f);}
});


test('legacy tasks retain their snapshot and unknown long jobs occupy only their own queue',async()=>{
 const f=fixture(1);
 try{
  const old=await f.jobs.run(params,'legacy');
  await until(()=>existsSync(join(f.root,old.jobId+'.started')));
  f.release(old.jobId);await until(()=>f.jobs.status(old.jobId,'legacy').status==='completed');
  const stored=readJson(join(f.root,old.jobId+'.json'));delete stored.taskClass;delete stored.agentId;
  writeJson(join(f.root,old.jobId+'.json'),stored);
  assert.equal((await f.jobs.run({...params,taskClass:'short'},'legacy')).jobId,old.jobId);
  const id=randomUUID();writeJson(join(f.root,id+'.json'),{jobId:id,scope:createHash('sha256').update('ada').digest('hex'),topic:'unknown',agentId:'ada',taskClass:'long',status:'unknown',heartbeatAt:0});
  const long=await f.jobs.run({...params,topic:'long',taskClass:'long'},'ada',{agentId:'ada'});
  assert.equal(long.status,'queued');assert.equal(long.waitingReason,'capacity');
  assert.equal((await f.jobs.run({...params,topic:'short'},'ada',{agentId:'ada'})).status,'running');
  assert.equal((await f.jobs.run({...params,topic:'other-long',taskClass:'long'},'other',{agentId:'other'})).status,'running');
 }finally{await cleanup(f);}
});


test('custom queues isolate agents, freeze admission and drain after configuration removal',async()=>{
 const f=fixture();
 let settings={taskQueues:{short:{name:'短',timeoutMs:1800000,maxConcurrentJobs:1,maxQueuedJobs:1},build:{name:'构建',timeoutMs:7200000,maxConcurrentJobs:2,maxQueuedJobs:1}},defaultQueueId:'build'};
 f.jobs=createJobs({...f.options,getRuntime:()=>settings,getLimits:()=>settings});
 const run=(topic,queueId,agentId='ada')=>f.jobs.run({...params,topic,queueId,requestId:topic},agentId,{agentId});
 try{
  const first=await run('first'),second=await run('second','build'),pending=await run('pending','build');
  assert.equal(first.queueId,'build');assert.equal(first.timeoutMs,7200000);assert.equal(first.status,'running');assert.equal(second.status,'running');
  assert.equal(pending.queuePosition,1);assert.equal((await run('full','build')).status,'queue_full');
  assert.equal((await run('short','short')).status,'running');assert.equal((await run('other','build','other')).status,'running');
  await assert.rejects(run('bad','missing'),/Unknown task queue/);
  await assert.rejects(f.jobs.run({...params,queueId:'build',taskClass:'short'},'ada'),/conflicts/);
  settings={taskQueues:{short:settings.taskQueues.short},defaultQueueId:'short'};
  assert.equal((await run('first')).jobId,first.jobId);
  await assert.rejects(run('first','short'),/different queue/);
  assert.equal((await run('pending','build')).jobId,pending.jobId);
  await assert.rejects(run('removed','build'),/Unknown task queue/);
  await until(()=>existsSync(join(f.root,first.jobId+'.started')));
  f.release(first.jobId);await until(()=>f.jobs.status(first.jobId,'ada').status==='completed');
  const restarted=createJobs({...f.options,getRuntime:()=>settings,getLimits:()=>settings});restarted.tick();
  assert.equal(restarted.status(pending.jobId,'ada').status,'running');
  assert.equal(readJson(join(f.root,pending.jobId+'.request.json')).runtime.timeoutMs,7200000);
 }finally{await cleanup(f);}
});
