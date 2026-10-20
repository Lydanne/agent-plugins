import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createJobs,readJson,writeJson} from './jobs.mjs';
test('background polling, durable results, duplicate prevention, isolation and cancellation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-jobs-'));const worker=join(root,'fake.mjs');
 writeFileSync(worker,`import {readFileSync,writeFileSync,renameSync,existsSync,rmSync} from 'node:fs';
 const [root,id]=process.argv.slice(2);for await(const c of process.stdin){};
 const path=root+'/'+id+'.json';let j=JSON.parse(readFileSync(path));
 const save=()=>{writeFileSync(path+'.tmp',JSON.stringify(j));renameSync(path+'.tmp',path)};
 j.status='running';j.heartbeatAt=Date.now();save();
 setTimeout(()=>{j.status=existsSync(root+'/'+id+'.cancel')?'cancelled':'completed';j.result={text:'done'};save();rmSync(root+'/active',{recursive:true});},300);`);
 const options={root,node:process.execPath,worker};const jobs=createJobs(options);
 const p={topic:'task',task:'read',context:'test',constraints:'read-only',tags:['ou_target','打卡异常'],waitSeconds:0};
 try{
  const first=await jobs.run(p,'group-a');assert.ok(['queued','running'].includes(first.status));assert.deepEqual(first.tags,p.tags);assert.equal(first.taskSummary,'read');
  const second=await jobs.run({...p,tags:['其他标签'],memory:{status:'no_match',queries:['new recall'],items:[]}},'group-a');assert.equal(second.jobId,first.jobId);
  assert.equal(second.memoryReview.status,'not_searched');
  const parallel=await jobs.run(p,'group-b');assert.notEqual(parallel.jobId,first.jobId);assert.equal(parallel.status,'running');
  assert.throws(()=>jobs.status(first.jobId,'group-b'));
  assert.throws(()=>jobs.status('../escape','group-a'));
  await assert.rejects(jobs.wait(first.jobId,'group-a',31));
  const fresh=createJobs(options);const done=await fresh.wait(first.jobId,'group-a',2);
  assert.equal(done.status,'completed');assert.equal(done.result.text,'done');
  assert.equal((await jobs.run({...p,memory:{status:'unavailable',queries:[],items:[],reason:'offline'}},'group-a')).jobId,first.jobId);
  const next=await jobs.run({...p,requestId:'explicit-second-run'},'group-a');
  assert.notEqual(next.jobId,first.jobId);assert.equal(jobs.cancel(next.jobId,'group-a').status,'cancelling');
  assert.equal((await jobs.wait(next.jobId,'group-a',2)).status,'cancelled');
  const file=join(root,next.jobId+'.json');writeJson(file,{...readJson(file),status:'running',heartbeatAt:0});
  assert.equal(jobs.status(next.jobId,'group-a').status,'unknown');
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('stable requests across source revisions keep original job and cancellation belongs to requester',async()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-owner-jobs-'));
 const worker=join(root,'fake.mjs');
 writeFileSync(worker,`import{readFileSync,writeFileSync,rmSync}from'node:fs';const[root,id]=process.argv.slice(2);for await(const c of process.stdin){};const p=root+'/'+id+'.json';const j=JSON.parse(readFileSync(p));j.status='completed';writeFileSync(p,JSON.stringify(j));rmSync(root+'/active',{recursive:true});`);
 const jobs=createJobs({root,node:process.execPath,worker});
 const scope='agent:main:feishu:group:test';
 const params={topic:'operation',task:'mock',context:'mock',constraints:'read-only',requestId:'stable',waitSeconds:2};
 const owner={senderId:'alice',accountId:'a'};
 const provenance={...owner,taskId:'message-1',revision:0};
 try {
  const first=await jobs.run({...params,waitSeconds:0},scope,provenance);
  const activeDuplicate=await jobs.run(params,scope,{...provenance,taskId:'active-followup',revision:1});
  assert.equal(activeDuplicate.jobId,first.jobId);
  assert.equal((await jobs.wait(first.jobId,scope,2)).status,'completed');
  const second=await jobs.run(params,scope,{...provenance,taskId:'message-2',revision:1});
  assert.equal(second.jobId,first.jobId);
  const file=join(root,first.jobId+'.json');
  writeJson(file,{...readJson(file),status:'running',heartbeatAt:0});
  for(const caller of [undefined,{...owner,senderId:'bob'},{...owner,accountId:'b'}])assert.throws(()=>jobs.cancel(first.jobId,scope,caller),/requester/);
  assert.equal(existsSync(join(root,first.jobId+'.cancel')),false);
  assert.equal(jobs.cancel(first.jobId,scope,owner).status,'unknown');
  assert.equal(existsSync(join(root,first.jobId+'.cancel')),true);
  writeJson(file,{...readJson(file),status:'cancelled'});
  assert.equal((await jobs.run(params,scope,{...provenance,taskId:'message-3'})).jobId,first.jobId);
  const explicit=await jobs.run({...params,requestId:'explicit-redo'},scope,{...provenance,taskId:'message-4'});
  assert.notEqual(explicit.jobId,first.jobId);
  const other=await jobs.run(params,scope,{...provenance,senderId:'bob'});
  assert.notEqual(other.jobId,first.jobId);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('passes the memory snapshot to the detached worker while status exposes only counts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-memory-job-')),worker=join(root,'fake.mjs');
 writeFileSync(worker,`import{readFileSync,writeFileSync,rmSync}from'node:fs';const[root,id]=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;const {params}=JSON.parse(input);const p=root+'/'+id+'.json';const j=JSON.parse(readFileSync(p));j.status='completed';j.result={memory:params.memory};writeFileSync(p,JSON.stringify(j));rmSync(root+'/active',{recursive:true});`);
 const jobs=createJobs({root,node:process.execPath,worker});
 const memory={status:'matched',queries:['fixture'],items:[{summary:'example experience',source:'memory/fixture.md:1',applicability:'fixture only',observedAt:null,verification:'historical_unverified'}]};
 try {
  const job=await jobs.run({topic:'test',task:'read',context:'test',constraints:'read-only',memory,waitSeconds:2},'fixture');
  assert.equal(job.status,'completed');assert.deepEqual(job.result.memory,memory);
  assert.deepEqual(job.memoryReview,{status:'matched',queryCount:1,itemCount:1,reportedBy:'openclaw_main_session'});
  const {result,...status}=job;assert.ok(!JSON.stringify(status).includes('example experience'));
  assert.ok(!JSON.stringify(status).includes('memory/fixture.md'));
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('list returns newest ten jobs for this conversation, omits report bodies and keeps old jobs accessible',()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-job-list-'));
 const jobs=createJobs({root});const scope='group-list';
 const scopeKey=value=>createHash('sha256').update(value).digest('hex');
 const ids=[];
 try {
  for(let i=0;i<15;i++){
   const jobId=randomUUID();ids.push(jobId);
   writeJson(join(root,jobId+'.json'),{jobId,scope:scopeKey(scope),status:'completed',createdAt:i,result:{text:'report-'+i},reports:[{path:'/report.md',content:'full report'}]});
  }
  const foreign=randomUUID();writeJson(join(root,foreign+'.json'),{jobId:foreign,scope:scopeKey('other-group'),status:'completed',createdAt:999});
  const listed=jobs.list(scope);
  assert.equal(listed.length,10);
  assert.deepEqual(listed.map(j=>j.createdAt),[14,13,12,11,10,9,8,7,6,5]);
  assert.ok(listed.every(j=>!('result' in j)&&!('reports' in j)));
  assert.equal(jobs.status(ids[0],scope).result.text,'report-0');
  assert.equal(jobs.status(ids[0],scope).reports[0].content,'full report');
  assert.equal(jobs.list('other-group').length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('search limits newest matching metadata and tags within the trusted conversation',()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-search-'));const jobs=createJobs({root});
 const scope='search-group',hash=value=>createHash('sha256').update(value).digest('hex');
 try{
  for(let i=0;i<12;i++){const jobId=randomUUID();writeJson(join(root,jobId+'.json'),{jobId,scope:hash(scope),topic:'打卡',taskSummary:'核对业务记录',tags:['ou_target','生产'],status:'completed',createdAt:i});}
  const foreign=randomUUID();writeJson(join(root,foreign+'.json'),{jobId:foreign,scope:hash('other'),tags:['ou_target','生产'],createdAt:99});
  const page=jobs.search(scope,{query:'OU_TARGET 生产',limit:3});
  assert.deepEqual(page.jobs.map(j=>j.createdAt),[11,10,9]);
  assert.deepEqual(page.jobPage,{total:12,limit:3,hasMore:true});
  assert.equal(jobs.search(scope,{query:'核对 打卡',limit:100}).jobPage.total,12);
  assert.equal(jobs.search(scope,{query:'不存在'}).jobPage.total,0);
  assert.equal(jobs.search(scope,{limit:100}).jobPage.hasMore,false);
  for(const options of [{limit:0},{limit:101},{query:'.'.repeat(501)}])assert.throws(()=>jobs.search(scope,options));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('tag edits survive worker snapshots and enforce ownership without executing a task',()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-tags-'));const jobs=createJobs({root});
 const scope='agent:main:feishu:group:tags',jobId=randomUUID(),owner={senderId:'ou_owner',accountId:'account'};
 const file=join(root,jobId+'.json');
 const stored={jobId,scope:createHash('sha256').update(scope).digest('hex'),provenance:owner,tags:['打卡'],status:'running',createdAt:1,heartbeatAt:Date.now()};
 try{
  writeJson(file,stored);
  assert.throws(()=>jobs.tag(jobId,scope,['目标'],{...owner,senderId:'other'}),/requester/);
  assert.throws(()=>jobs.tag(jobId,'foreign',['目标'],owner),/conversation/);
  assert.deepEqual(jobs.tag(jobId,scope,['ou_target','Production','production'],owner).tags,['打卡','ou_target','production']);
  writeJson(file,{...stored,heartbeatAt:Date.now()+1}); // detached worker still holds old snapshot
  assert.deepEqual(jobs.status(jobId,scope).tags,['打卡','ou_target','production']);
  assert.equal(jobs.search(scope,{query:'ou_target'}).jobPage.total,1);
  assert.equal(jobs.search(scope,{query:'ou_owner'}).jobPage.total,1);
  assert.deepEqual(jobs.tag(jobId,scope,['问题'],owner,'replace').tags,['问题']);
  assert.deepEqual(jobs.tag(jobId,scope,[],owner,'replace').tags,[]);
  assert.throws(()=>jobs.tag(jobId,scope,[' '],owner));
  assert.throws(()=>jobs.tag(jobId,scope,['a'.repeat(161)],owner));
  assert.throws(()=>jobs.tag(jobId,scope,['a'],owner,'invalid'));
  writeJson(file,{...stored,provenance:undefined});
  assert.throws(()=>jobs.tag(jobId,scope,['a'],owner),/unknown/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('two async jobs release their submitter before either worker finishes without waitSeconds',async()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-async-dispatch-')),worker=join(root,'fake.mjs');
 writeFileSync(worker,`import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
 const [root,id]=process.argv.slice(2);for await(const c of process.stdin){};
 writeFileSync(root+'/'+id+'.started','started');
 const timer=setInterval(()=>{if(!existsSync(root+'/release'))return;
 clearInterval(timer);const file=root+'/'+id+'.json';const job=JSON.parse(readFileSync(file));
 writeFileSync(file+'.tmp',JSON.stringify({...job,status:'completed',result:{text:'done'},finishedAt:Date.now()}));renameSync(file+'.tmp',file);},20);`);
 const jobs=createJobs({root,node:process.execPath,worker});let deadline;
 const submit=topic=>Promise.race([jobs.run({topic,task:'delayed output',context:'test',constraints:'read-only',notify:true},'same-group'),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('async submission waited for worker completion')),1000);})]).finally(()=>clearTimeout(deadline));
 try {
  const first=await submit('delay-a'),second=await submit('delay-b');
  assert.notEqual(first.jobId,second.jobId);assert.equal(first.status,'running');assert.equal(second.status,'running');
  assert.equal(existsSync(join(root,'release')),false);
  const until=Date.now()+2000;
  while((!existsSync(join(root,first.jobId+'.started'))||!existsSync(join(root,second.jobId+'.started')))&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  assert.equal(existsSync(join(root,first.jobId+'.started')),true);assert.equal(existsSync(join(root,second.jobId+'.started')),true);
  writeFileSync(join(root,'release'),'finish');
  assert.equal((await jobs.wait(first.jobId,'same-group',2)).status,'completed');
  assert.equal((await jobs.wait(second.jobId,'same-group',2)).status,'completed');
 } finally {
  writeFileSync(join(root,'release'),'finish');
  await new Promise(r=>setTimeout(r,150));rmSync(root,{recursive:true,force:true});
 }
});
