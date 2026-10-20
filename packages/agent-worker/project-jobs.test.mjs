import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createJobs,readJson,writeJson} from './jobs.mjs';
import {completionEvent,readCompletionRequest} from './completion.mjs';
import {createSessionInspector} from './session-inspector.mjs';
const scope='agent:main:test';
async function fixture(t){
 const base=fileURLToPath(new URL('../../.tmp/project-jobs-tests/',import.meta.url));await mkdir(base,{recursive:true});const temp=await mkdtemp(join(base,'case-')),root=join(temp,'jobs');await mkdir(root);t.after(()=>rm(temp,{recursive:true,force:true}));
 const worker=join(root,'fake.mjs');await writeFile(worker,`import{readFileSync,writeFileSync,renameSync}from'node:fs';const[root,id]=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;await new Promise(resolve=>setTimeout(resolve,300));const path=root+'/'+id+'.json',job=JSON.parse(readFileSync(path));job.status='completed';job.finishedAt=Date.now();job.result={content:[{type:'text',text:JSON.stringify({result:'fixture complete',project:JSON.parse(input).runtime.projectContext})}]};writeFileSync(path+'.tmp',JSON.stringify(job));renameSync(path+'.tmp',path);`);
 const calls=[];const runtime=params=>{if(calls.unavailable)throw Error('Project provider unavailable');calls.push(params);const id=params.projectId??params.repository?.split('/')[1]??'a';return {node:process.execPath,cwd:root+'/projects/'+id,projectContext:{agentId:'main',root,projectId:id,repository:params.repository??'projects/'+id,cwd:root+'/projects/'+id},executionScope:createHash('sha256').update(id+':'+(params.repository??'projects/'+id)).digest('hex')};};
 const jobs=createJobs({root,node:process.execPath,worker,getRuntime:runtime,getLimits:()=>({maxConcurrentJobs:3,maxQueuedJobs:20})});t.after(()=>jobs.stop());
 return {root,jobs,calls};
}
const params={topic:'same',task:'fixture',context:'fixture',constraints:'read only',waitSeconds:0};
test('project jobs normalize equivalent selectors and retry original binding without preparing again',async t=>{
 const f=await fixture(t);
 const a=await f.jobs.run({...params,requestId:'stable'},scope,{agentId:'main'});
 const explicit=await f.jobs.run({...params,projectId:'a',requestId:'stable'},scope,{agentId:'main'});
 const repository=await f.jobs.run({...params,repository:'projects/a',requestId:'stable'},scope,{agentId:'main'});
 assert.equal(explicit.jobId,a.jobId);assert.equal(repository.jobId,a.jobId);assert.equal(f.calls.length,1);
 await assert.rejects(f.jobs.run({...params,projectId:'b',requestId:'stable'},scope,{agentId:'main'}),{code:'REQUEST_ID_CONFLICT'});
 await assert.rejects(f.jobs.run({...params,task:'different',requestId:'stable'},scope,{agentId:'main'}),{code:'REQUEST_ID_CONFLICT'});
 await assert.rejects(f.jobs.run({...params,projectId:'b',repository:'projects/a',requestId:'stable'},scope,{agentId:'main'}),{code:'PROJECT_SELECTOR_CONFLICT'});
 const request=readJson(join(f.root,a.jobId+'.request.json'));assert.equal(request.runtime.cwd,f.root+'/projects/a');assert.equal(request.params.projectId,'a');assert.equal(readCompletionRequest(f.root,readJson(join(f.root,a.jobId+'.json'))).availability,'available');
 await f.jobs.wait(a.jobId,scope,3);
 const retry=await f.jobs.run({...params,requestId:'stable'},scope,{agentId:'main'});assert.equal(retry.jobId,a.jobId);assert.equal(f.calls.length,1);
 assert.equal(completionEvent(f.jobs.status(a.jobId,scope)).projectId,'a');
});
test('different projects can run same topic concurrently while same scope and global resource keys serialize',async t=>{
 const f=await fixture(t);
 const a=await f.jobs.run({...params,projectId:'a'},scope,{agentId:'main'}),b=await f.jobs.run({...params,projectId:'b'},scope,{agentId:'main'});
 assert.equal(a.status,'running');assert.equal(b.status,'running');
 const same=await f.jobs.run({...params,task:'second',projectId:'a'},scope,{agentId:'main'});assert.equal(same.status,'queued');assert.equal(same.waitingReason,'session_busy');
 await Promise.all([f.jobs.wait(a.jobId,scope,3),f.jobs.wait(b.jobId,scope,3),f.jobs.wait(same.jobId,scope,3)]);
 const one=await f.jobs.run({...params,task:'resource-1',projectId:'a',resourceKeys:['global-resource']},scope,{agentId:'main'});
 const two=await f.jobs.run({...params,task:'resource-2',projectId:'b',resourceKeys:['global-resource']},scope,{agentId:'main'});assert.equal(two.status,'queued');assert.equal(two.waitingReason,'resource_busy');
 await Promise.all([f.jobs.wait(one.jobId,scope,3),f.jobs.wait(two.jobId,scope,3)]);
 const inspector=createSessionInspector({state:join(f.root,'..'),jobs:f.jobs});const rows=(await inspector.list(scope)).sessions;assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(row=>row.projectId)),new Set(['a','b']));
 const detail=await inspector.detail(scope,{topic:'same',jobId:b.jobId});assert.equal(detail.session.projectId,'b');assert.ok(detail.records.every(row=>row.projectId==='b'));
});
test('legacy unfinished topic remains a conservative barrier for project jobs',async t=>{
 const f=await fixture(t),legacy=await f.jobs.run({...params,projectId:'a'},scope,{agentId:'main'});
 const file=join(f.root,legacy.jobId+'.json'),saved=readJson(file);delete saved.executionScope;delete saved.project;writeJson(file,saved);
 const next=await f.jobs.run({...params,projectId:'b'},scope,{agentId:'main'});assert.equal(next.status,'queued');assert.equal(next.waitingReason,'session_busy');
 await Promise.all([f.jobs.wait(legacy.jobId,scope,3),f.jobs.wait(next.jobId,scope,3)]);
 const inspector=createSessionInspector({state:join(f.root,'..'),jobs:f.jobs});
 const detail=await inspector.detail(scope,{topic:'same',executionScope:null});assert.equal(detail.total,1);assert.equal(detail.records[0].jobId,legacy.jobId);
 const selected=await inspector.detail(scope,{topic:'same',jobId:legacy.jobId});assert.equal(selected.total,1);assert.equal(selected.records[0].jobId,legacy.jobId);
});
test('context reply stays bound to accepted project when project provider is unavailable',async t=>{
 const f=await fixture(t),provenance={agentId:'main',senderId:'alice',accountId:'test'};
 const job=await f.jobs.run({...params,projectId:'a'},scope,provenance);await f.jobs.wait(job.jobId,scope,3);
 const requestFile=join(f.root,job.jobId+'.request.json'),original=readJson(requestFile),file=join(f.root,job.jobId+'.json');
 const question={questionId:'project-question',question:'Which environment?',expiresAt:Date.now()+60000};
 writeJson(file,{...readJson(file),status:'awaiting_main',contextRequest:question,questions:[question]});
 f.calls.unavailable=true;
 const resumed=await f.jobs.reply(job.jobId,scope,question.questionId,'Test environment',provenance);assert.equal(resumed.jobId,job.jobId);
 const done=await f.jobs.wait(job.jobId,scope,3),request=readJson(requestFile);
 assert.equal(done.status,'completed');assert.equal(done.projectId,'a');assert.equal(f.calls.length,1);
 assert.deepEqual(request.runtime,original.runtime);assert.deepEqual(request.params,original.params);
 assert.equal(request.resumeParams.projectId,'a');assert.equal(request.resumeParams.repository,'projects/a');
 assert.deepEqual(request.resumeParams.mainReplies,[{questionId:question.questionId,question:question.question,answer:'Test environment'}]);
 assert.equal(JSON.parse(done.result.content[0].text).project.projectId,'a');
});
