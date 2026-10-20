import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,statSync,readdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {finalizeJobReport} from './task-report.mjs';
import {runWorker} from './worker.mjs';
import {completionEvent} from './completion.mjs';
import {readJson,writeJson,createJobs} from './jobs.mjs';
const fixture=async run=>{const cwd=mkdtempSync(join(tmpdir(),'query-report-'));try{await run(cwd);}finally{rmSync(cwd,{recursive:true,force:true});}};
const params={topic:'test',task:'等待后输出 aaa',context:'用户明确要求后台等待模拟',constraints:'只输出，不修改业务'};
const response=result=>({content:[{type:'text',text:JSON.stringify(result)}]});
test('every accepted task persists a private full report even for a short result and without async notification',()=>fixture(async cwd=>{
 const root=join(cwd,'jobs');mkdirSync(root);const id=randomUUID();writeJson(join(root,id+'.json'),{jobId:id,topic:params.topic,status:'queued',createdAt:1});
 const job=await runWorker({root,id,params,scope:'test',runtime:{cwd},execute:async()=>response({result:'aaa'})});
 assert.equal(job.status,'completed');assert.equal(job.taskReport.request.task,params.task);assert.equal(job.taskReport.resultContent,'aaa');
 const saved=readJson(join(root,id+'.json'));assert.deepEqual(saved.taskReport,JSON.parse(JSON.stringify(job.taskReport)));
 const event=completionEvent(saved);assert.equal(event.reportPaths.length,1);assert.ok(event.reports[0].content.includes('aaa'));
 assert.ok(event.reports[0].content.includes(params.constraints));assert.equal(statSync(event.reportPaths[0]).mode&0o777,0o600);
 assert.equal(JSON.parse(saved.result.content[0].text).taskReport.storage.path,event.reportPaths[0]);
}));
test('uses the existing Worker report without generating another host report',()=>fixture(async cwd=>{
 const id=randomUUID(),directory='.tmp/codex-query/'+id;mkdirSync(join(cwd,directory),{recursive:true});
 const artifact=join(cwd,directory,'executor.md');writeFileSync(artifact,'证据正文');
 const result='姓名 张测试；OpenID full-openid；https://download.test/_cos/a.zip?sign=a%2Fb%3D&expires=123';
 const job={jobId:id,topic:'export',status:'completed',result:response({cwd,result,reportPaths:[artifact]})};
 finalizeJobReport({job,params,runtime:{cwd}});
 assert.equal(job.taskReport.resultContent,result);assert.deepEqual(job.taskReport.artifactPaths,[artifact]);
 assert.deepEqual(JSON.parse(job.result.content[0].text).reportPaths,[artifact]);
 assert.deepEqual(job.taskReport.storage,{state:'written',path:artifact,producer:'worker'});
 assert.deepEqual(readdirSync(join(cwd,directory)),['executor.md']);assert.equal(readFileSync(artifact,'utf8'),'证据正文');
}));
for(const status of ['failed','timed_out','cancelled'])test('terminal '+status+' produces a report without claiming business success',()=>fixture(async cwd=>{
 const root=join(cwd,'jobs');mkdirSync(root);const id=randomUUID();writeJson(join(root,id+'.json'),{jobId:id,status:'queued'});
 if(status==='cancelled')writeFileSync(join(root,id+'.cancel'),'cancel');
 let calls=0;const job=await runWorker({root,id,params,scope:'test',runtime:{cwd},execute:async()=>{calls++;throw Object.assign(Error('未完成测试'),{code:status==='timed_out'?'EXECUTION_TIMEOUT':'FAILED'});}});
 assert.equal(job.status,status);assert.equal(job.taskReport.status,status);assert.equal(job.taskReport.verification,'not_independently_verified');
 assert.ok(job.taskReport.limitations.some(item=>item.includes('回滚')));assert.ok(completionEvent(job).reportPaths.length);
 if(status==='cancelled')assert.equal(calls,0);
}));
test('report storage failure and symlink escape retain full inline results without failing or repeating the task',()=>fixture(async cwd=>{
 const outside=mkdtempSync(join(tmpdir(),'query-report-outside-'));
 try {
  symlinkSync(outside,join(cwd,'.tmp'),'dir');
  const job={jobId:randomUUID(),status:'completed',result:response({result:'完整结果'})};
  finalizeJobReport({job,params,runtime:{cwd}});
  assert.equal(job.status,'completed');assert.equal(job.taskReport.storage.reason,'report_scope_invalid');
  assert.equal(completionEvent(job).taskReport.resultContent,'完整结果');
  assert.deepEqual((await import('node:fs')).readdirSync(outside),[]);
 }finally{rmSync(outside,{recursive:true,force:true});}
}));
test('queued cancellations and missing queued requests receive reports without starting a worker; list stays compact',()=>fixture(async cwd=>{
 const root=join(cwd,'jobs');mkdirSync(root);
 const scope='chat',hash=(await import('node:crypto')).createHash('sha256').update(scope).digest('hex');
 const jobs=createJobs({root,node:process.execPath,worker:'/must-not-execute',getRuntime:()=>({cwd})});
 for(const cancelled of [true,false]) {
  const id=randomUUID();writeJson(join(root,id+'.json'),{jobId:id,topic:'test',scope:hash,schedulerVersion:1,status:'queued',taskSummary:'原请求摘要',createdAt:1});
  if(cancelled)writeFileSync(join(root,id+'.cancel'),'cancel');jobs.tick();
  const saved=jobs.status(id,scope);assert.equal(saved.status,cancelled?'cancelled':'failed');assert.ok(saved.taskReport);assert.equal(saved.taskReport.storage.state,'written');
 }
 for(const summary of jobs.list(scope)){assert.equal(summary.taskReport,undefined);assert.equal(summary.result,undefined);assert.equal(summary.reports,undefined);}
}));

test('plain text executor responses survive report creation without dropping the original result',()=>fixture(async cwd=>{
 const job={jobId:randomUUID(),status:'completed',result:{content:[{type:'text',text:'plain final result'}]}};
 finalizeJobReport({job,params,runtime:{cwd}});assert.equal(completionEvent(job).reportContent,'plain final result');
}));

test('rejects empty, missing and out-of-scope reports and captures a 60KB primary report without an extra wrapper',()=>fixture(async cwd=>{
 const {captureReports}=await import('./completion.mjs');
 const id=randomUUID(),directory='.tmp/codex-query/'+id;mkdirSync(join(cwd,directory),{recursive:true});
 const primary=join(cwd,directory,'primary.md'),empty=join(cwd,directory,'empty.md'),outside=join(cwd,'outside.md');
 const body='x'.repeat(60000);writeFileSync(primary,body);writeFileSync(empty,'');writeFileSync(outside,'unrelated');
 const job={jobId:id,status:'completed',result:response({cwd,result:body,reportPaths:[empty,outside,primary,primary]})};
 finalizeJobReport({job,params,runtime:{cwd}});
 assert.equal(job.taskReport.storage.path,primary);assert.equal(job.taskReport.storage.producer,'worker');
 const reports=await captureReports(job.result);assert.equal(reports[0].path,primary);assert.equal(reports[0].content,body);
 assert.equal(reports.filter(r=>r.path===primary).length,1);assert.ok(!readdirSync(join(cwd,directory)).some(p=>p.startsWith('completion-report-')));
 const invalid={jobId:randomUUID(),status:'completed',result:response({result:'未落盘',reportPaths:[outside]})};
 finalizeJobReport({job:invalid,params,runtime:{cwd}});assert.equal(invalid.taskReport.storage.producer,'host');
}));
