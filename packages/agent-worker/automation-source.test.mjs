import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateAutomationSource} from './adapters/automation-source.mjs';
import {resolveConfiguration} from './configuration.mjs';
import {automationDefaults} from './adapters/automation-policy.mjs';
const id='11111111-1111-4111-8111-111111111111',scope='agent:main:automation:'+id;
test('unknown and partial automation provenance never becomes a local job',()=>{
 const p={agentId:'main',sessionId:'s',automation:{version:1,taskId:id}};assert.doesNotThrow(()=>validateAutomationSource(p,scope));
 for(const bad of [undefined,{agentId:'main'},{...p,automation:{version:2,taskId:id}},{...p,automation:{version:1,taskId:id,owner:true}},{...p,sessionId:undefined}])assert.throws(()=>validateAutomationSource(bad,scope));
 assert.throws(()=>validateAutomationSource(p,'agent:other:automation:'+id));assert.doesNotThrow(()=>validateAutomationSource({taskId:'legacy',senderId:'sender'},'agent:main:feishu:chat'));
});
test('automation queue preserves defaults and is added only for explicit configuration',()=>{
 const before=resolveConfiguration({});assert.deepEqual(Object.keys(before.taskQueues),['short','long']);
 const after=resolveConfiguration({automation:{...automationDefaults,callers:['local-gateway-operator']}});assert.deepEqual(after.taskQueues.short,before.taskQueues.short);assert.deepEqual(after.taskQueues.long,before.taskQueues.long);assert.equal(after.taskQueues.automation.maxConcurrentJobs,1);assert.equal(after.defaultQueueId,before.defaultQueueId);
});
test('automation concurrency is one across configured Agents',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createJobs}=await import('./jobs.mjs');
 const root=mkdtempSync(join(tmpdir(),'automation-queue-')),worker=join(root,'fake.mjs');
 writeFileSync(worker,`import{readFileSync,writeFileSync,existsSync}from'node:fs';const[root,id]=process.argv.slice(2);for await(const c of process.stdin){};const f=root+'/'+id+'.json';const timer=setInterval(()=>{if(!existsSync(root+'/release'))return;const j=JSON.parse(readFileSync(f));j.status='completed';j.finishedAt=Date.now();writeFileSync(f,JSON.stringify(j));clearInterval(timer);},20);`);
 const config={taskQueues:{automation:{name:'Automation',timeoutMs:60000,maxConcurrentJobs:1,maxQueuedJobs:10}},defaultQueueId:'automation'};
 const jobs=createJobs({root,node:process.execPath,worker,getLimits:()=>config,getRuntime:()=>config});
 const source=agentId=>({agentId,sessionId:'session',automation:{version:1,taskId:id}}),params={queueId:'automation',topic:'fixture',task:'read',context:'none',constraints:'read only',waitSeconds:0};
 try{const a=await jobs.run(params,scope,source('main'));const other='agent:other:automation:'+id,b=await jobs.run(params,other,source('other'));assert.equal(a.status,'running');assert.equal(b.status,'queued');writeFileSync(join(root,'release'),'done');assert.equal((await jobs.wait(a.jobId,scope,3)).status,'completed');assert.equal((await jobs.wait(b.jobId,other,3)).status,'completed');}finally{jobs.stop();rmSync(root,{recursive:true,force:true});}
});
