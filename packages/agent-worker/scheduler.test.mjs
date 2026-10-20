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
