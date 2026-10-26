import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJobs,requestKeyFor} from './jobs.mjs';
const params={topic:'fix',task:'test',context:'test',constraints:'authorized fixture',waitSeconds:0};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<300;i++){if(await check())return;await delay(10);}throw Error('Fixture deadline');}
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'pool-scheduler-')),worker=join(root,'worker.mjs');
 writeFileSync(worker,`import{readFileSync,writeFileSync,renameSync,existsSync}from'node:fs';const[root,id]=process.argv.slice(2);let input='';for await(const c of process.stdin)input+=c;writeFileSync(root+'/'+id+'.input',input);let j=JSON.parse(readFileSync(root+'/'+id+'.json'));const timer=setInterval(()=>{j.heartbeatAt=Date.now();if(existsSync(root+'/'+id+'.cancel')||existsSync(root+'/'+id+'.done')){j.status='completed';j.finishedAt=Date.now();clearInterval(timer);}writeFileSync(root+'/'+id+'.tmp',JSON.stringify(j));renameSync(root+'/'+id+'.tmp',root+'/'+id+'.json');},15);`);
 let jobs;const options={root,worker,node:process.execPath,getLimits:()=>({maxConcurrentJobs:1,maxQueuedJobs:10}),getRuntime:p=>p.useWorkspace?{workspacePool:{},projectContext:{projectId:'xgj',repository:'projects/xgj'},executionScope:'source'}:{}};
 const start=extra=>jobs=createJobs({...options,...extra});
 t.after(async()=>{jobs?.stop();for(const f of readdirSync(root).filter(f=>f.endsWith('.input')))writeFileSync(join(root,f.slice(0,-6)+'.done'),'');await delay(80);rmSync(root,{recursive:true,force:true});});
 return {root,start,finish:id=>writeFileSync(join(root,id+'.done'),'')};
}
test('workspace full jobs remain queued without consuming execution capacity and dispatch after release',async t=>{
 const f=fixture(t);let available=false;const jobs=f.start({prepareWorkspace:async(runtime,owner)=>available?{...runtime,workspace:{id:'xgj-0',assignmentId:owner,owner,path:f.root},cwd:f.root}:null});
 const waiting=await jobs.run({...params,useWorkspace:true},'a');assert.equal(waiting.status,'queued');assert.equal(waiting.waitingReason,'waiting_workspace');
 const plain=await jobs.run({...params,topic:'plain'},'b');assert.equal(plain.status,'running');await until(()=>existsSync(join(f.root,plain.jobId+'.input')));
 f.finish(plain.jobId);await until(()=>jobs.status(plain.jobId,'b').status==='completed');available=true;
 await until(async()=>{jobs.tick();return jobs.status(waiting.jobId,'a').status==='running';});await until(()=>existsSync(join(f.root,waiting.jobId+'.input')));
 const input=JSON.parse(readFileSync(join(f.root,waiting.jobId+'.input')));assert.equal(input.runtime.cwd,f.root);assert.equal((await jobs.run({...params,useWorkspace:true},'a')).jobId,waiting.jobId);
});
test('cancellation while initialization is in flight cannot launch a Worker and keeps allocation for settlement',async t=>{
 const f=fixture(t);let unblock,entered=false;const gate=new Promise(r=>unblock=r),released=[];
 const jobs=f.start({prepareWorkspace:async(runtime,owner)=>{entered=true;await gate;return {...runtime,workspace:{id:'xgj-0',assignmentId:owner,owner},cwd:f.root};},settleWorkspace:async runtime=>{released.push(runtime.workspace.owner);return {status:'idle'};}});
 const accepted=await jobs.run({...params,useWorkspace:true},'a');await until(()=>entered);jobs.cancel(accepted.jobId,'a');jobs.tick();unblock();
 await until(async()=>{jobs.tick();return released.length===1;});assert.equal(jobs.status(accepted.jobId,'a').status,'cancelled');assert.equal(existsSync(join(f.root,accepted.jobId+'.input')),false);
});
test('preparation failures are terminal without executing in the shared checkout',async t=>{
 const f=fixture(t),jobs=f.start({prepareWorkspace:async()=>{throw Error('workspace blocked');}});const j=await jobs.run({...params,useWorkspace:true},'a');await until(()=>jobs.status(j.jobId,'a').status==='failed');assert.equal(existsSync(join(f.root,j.jobId+'.input')),false);
});
test('useWorkspace participates in request identity; false preserves legacy identity',()=>{
 assert.notEqual(requestKeyFor(params,'a'),requestKeyFor({...params,useWorkspace:true},'a'));assert.equal(requestKeyFor(params,'a'),requestKeyFor({...params,useWorkspace:false},'a'));
});

test('pool waits respect maxQueuedJobs even when execution capacity is free',async t=>{
 const f=fixture(t),jobs=f.start({getLimits:()=>({maxConcurrentJobs:3,maxQueuedJobs:1}),prepareWorkspace:async()=>null});
 const first=await jobs.run({...params,useWorkspace:true},'a');assert.equal(first.status,'queued');
 const second=await jobs.run({...params,topic:'other',useWorkspace:true},'b');assert.equal(second.status,'queue_full');
 assert.equal((await jobs.run({...params,useWorkspace:true},'a')).jobId,first.jobId);
});

test('settlement claims survive scheduler instances and gate continuations until release completes',async t=>{
 const f=fixture(t);let releases=0,unblock;const gate=new Promise(r=>unblock=r),options={prepareWorkspace:async(runtime,owner)=>({...runtime,workspace:{id:'xgj-0',assignmentId:owner,owner},cwd:f.root}),settleWorkspace:async()=>{releases++;await gate;return {status:'idle'};}};
 const first=f.start(options),j=await first.run({...params,useWorkspace:true},'a');
 await until(()=>{first.tick();return existsSync(join(f.root,j.jobId+'.input'));});f.finish(j.jobId);
 await until(()=>first.status(j.jobId,'a').status==='completed');await delay(60);first.tick();await until(()=>releases===1);
 const second=f.start(options);second.tick();await delay(30);assert.equal(releases,1);
 const original=JSON.parse(readFileSync(join(f.root,j.jobId+'.json')));assert.ok(original.workspaceSettlement.token);
 const childId='11111111-1111-4111-8111-111111111111',child={...original,jobId:childId,status:'queued',resumePending:true};delete child.workspaceSettlement;
 writeFileSync(join(f.root,childId+'.json'),JSON.stringify(child));writeFileSync(join(f.root,childId+'.request.json'),readFileSync(join(f.root,j.jobId+'.request.json')));
 second.tick();assert.equal(existsSync(join(f.root,childId+'.input')),false);
 unblock();await until(()=>first.status(j.jobId,'a').workspaceSettled===true);
 await until(()=>{second.tick();return existsSync(join(f.root,childId+'.input'));});assert.equal(releases,1);
});

test('blocked settlement backs off and recovers legacy settled records without rerunning the old job',async t=>{
 const f=fixture(t);let calls=0,available=true;
 const jobs=f.start({prepareWorkspace:async(runtime,owner)=>available?{...runtime,workspace:{id:'xgj-0',assignmentId:owner,owner},cwd:f.root}:null,
  settleWorkspace:async()=>{calls++;if(calls===1)return {status:'blocked',releaseFailure:{repository:'wiki',stage:'fetch',code:'FETCH_FAILED',retryable:true}};available=true;return {status:'idle'};}});
 const original=await jobs.run({...params,useWorkspace:true},'a');
 await until(()=>{jobs.tick();return existsSync(join(f.root,original.jobId+'.input'));});available=false;f.finish(original.jobId);
 await until(()=>jobs.status(original.jobId,'a').status==='completed');await delay(70);
 await until(()=>{jobs.tick();return jobs.status(original.jobId,'a').workspaceRelease==='blocked';});
 const failed=jobs.status(original.jobId,'a');assert.equal(failed.workspaceSettled,false);assert.equal(failed.workspaceReleaseFailure.repository,'wiki');assert.ok(failed.workspaceReleaseRetryAt>Date.now());
 for(let i=0;i<10;i++)jobs.tick();await delay(30);assert.equal(calls,1);
 const next=await jobs.run({...params,topic:'next',useWorkspace:true},'b');assert.equal(next.status,'queued');
 const file=join(f.root,original.jobId+'.json'),legacy=JSON.parse(readFileSync(file));legacy.workspaceSettled=true;legacy.workspaceReleaseRetryAt=Date.now()-1;writeFileSync(file,JSON.stringify(legacy));
 await until(()=>{jobs.tick();return jobs.status(original.jobId,'a').workspaceRelease==='idle';});
 await until(()=>{jobs.tick();return existsSync(join(f.root,next.jobId+'.input'));});
 assert.equal(calls,2);assert.equal(jobs.status(original.jobId,'a').status,'completed');assert.equal(jobs.status(original.jobId,'a').workspaceReleaseRetryAt,undefined);
});
test('settlement exceptions are rate limited instead of retried on every scheduler tick',async t=>{
 const f=fixture(t);let calls=0;
 const jobs=f.start({prepareWorkspace:async(runtime,owner)=>({...runtime,workspace:{id:'xgj-0',assignmentId:owner,owner},cwd:f.root}),settleWorkspace:async()=>{calls++;throw Error('private remote detail');}});
 const j=await jobs.run({...params,useWorkspace:true},'a');await until(()=>{jobs.tick();return existsSync(join(f.root,j.jobId+'.input'));});f.finish(j.jobId);
 await until(()=>jobs.status(j.jobId,'a').status==='completed');await delay(70);
 await until(()=>{jobs.tick();return jobs.status(j.jobId,'a').workspaceReleaseRetryAt>Date.now();});
 for(let i=0;i<10;i++)jobs.tick();await delay(30);assert.equal(calls,1);assert.equal(JSON.stringify(jobs.status(j.jobId,'a')).includes('private remote detail'),false);
});
