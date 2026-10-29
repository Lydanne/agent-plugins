import {createSourceRevocations,messageSource} from './source-revocations.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createJobs,readJson,writeJson} from './jobs.mjs';
import {runWorker} from './worker.mjs';
import {resolveConfiguration,resolveQueueExecution} from './configuration.mjs';
import {defaultHermesTemplates} from './hermes-templates.mjs';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'worker-source-cancel-'));
 const provenance={taskId:'request',revision:0,accountId:'a',chatId:'chat',sessionKey:'agent:main:feishu:chat',senderId:'owner',sourceMessageIds:['request']};
 const seed=(status,extra={})=>{const id=randomUUID();writeJson(join(root,id+'.json'),{jobId:id,status,schedulerVersion:1,heartbeatAt:Date.now(),createdAt:Date.now(),topic:id,provenance,...extra});return id;};
 return {root,provenance,seed,read:id=>readJson(join(root,id+'.json')),marked:id=>existsSync(join(root,id+'.cancel')),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('scheduler recovers missed recall after restart for every active state and isolates other authority',()=>{
 const f=fixture();
 const jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});
 try{
  mkdirSync(join(f.root,'active')); // Hold unrelated fixtures without spawning.
  const ids=['queued','running','unknown','awaiting_main','awaiting_user'].map(status=>f.seed(status));
  const other=f.seed('running',{provenance:{...f.provenance,accountId:'other'}}),local=f.seed('running',{provenance:{agentId:'main'}}),automation=f.seed('running',{provenance:{automation:{version:1}}}),done=f.seed('completed');
  jobs.tick();for(const id of ids)assert.equal(f.marked(id),false);
  createSourceRevocations(f.root).record({apiVersion:1,eventId:'recall-before-restart',reason:'source-recalled',sources:[messageSource('a','chat','request')]});jobs.tick();
  for(const id of ids)assert.equal(f.marked(id),true);
  for(const id of [ids[0],ids[3],ids[4]])assert.equal(f.read(id).status,'cancelled');
  for(const id of [other,local,automation,done])assert.equal(f.marked(id),false);
 }finally{jobs.stop();f.close();}
});
test('revocation before admission blocks only the revoked dependency and never consults a channel adapter',()=>{
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});
 try{
  jobs.invalidateSources({apiVersion:1,eventId:'before-admission',reason:'recalled',sources:[messageSource('a','chat','request')]});
  mkdirSync(join(f.root,'active'));
  const queued=f.seed('queued'),remaining=f.seed('queued',{provenance:{...f.provenance,revision:1,sourceMessageIds:['remaining']}});
  jobs.tick();assert.equal(f.read(queued).status,'cancelled');assert.equal(f.marked(remaining),false);assert.equal(f.read(remaining).status,'queued');
  // Additive host metadata is independent of an explicit source withdrawal.
  const expanded={...f.read(remaining),provenance:{...f.read(remaining).provenance,sourceMessageIds:['remaining','later']}};
  writeJson(join(f.root,remaining+'.json'),expanded);jobs.tick();assert.equal(f.marked(remaining),false);
 }finally{f.close();}
});
test('cancel marker outlives waiting-state writes and prevents a finishing Worker from reviving a recalled question',async()=>{
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});
 try{
  const id=f.seed('running');
  const result=await runWorker({root:f.root,id,params:{},scope:'s',execute:async()=>{
   writeJson(join(f.root,id+'.json'),{...f.read(id),status:'awaiting_main'});
   jobs.cancelSources({...f.provenance,messageId:'request'});
   assert.equal(f.marked(id),true);assert.equal(f.read(id).status,'cancelled');
   return {content:[{type:'text',text:JSON.stringify({sessionId:'fixture',contextRequest:{question:'obsolete'}})}]};
  }});
  assert.equal(result.status,'cancelled');assert.equal(result.contextRequest,undefined);assert.equal(result.taskReport.status,'cancelled');
 }finally{f.close();}
});
test('durable cancellation retries an interrupted waiting-state finalization',()=>{
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});
 try{
  const id=f.seed('awaiting_user');writeFileSync(join(f.root,id+'.cancel'),'source-recalled');
  jobs.tick();assert.equal(f.read(id).status,'cancelled');assert.equal(f.marked(id),true);
 }finally{f.close();}
});
test('recall stops a real CLI process group including its child process',async()=>{
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});let pids;
 const script=join(f.root,'cli.mjs');
 writeFileSync(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
 const template={...defaultHermesTemplates.codex,command:process.execPath,args:[script,...defaultHermesTemplates.codex.args]};
 const runtime=resolveQueueExecution(resolveConfiguration({cwd:f.root,state:join(f.root,'state'),codexHome:join(f.root,'codex'),skillsEnabled:false,memoryRequired:false,hermesTemplates:{codex:template}}));
 runtime.timeoutMs=5000;
 const id=f.seed('running');
 try{
  const pending=runWorker({root:f.root,id,params:{topic:'kill',task:'fixture',context:'none',constraints:'test only'},scope:'s',runtime,pollMs:10});
  for(let n=0;n<200&&!existsSync(join(f.root,'pids.json'));n++)await new Promise(r=>setTimeout(r,10));
  if(!existsSync(join(f.root,'pids.json'))){await pending;assert.fail('CLI did not start');}
  pids=readJson(join(f.root,'pids.json'));jobs.cancelSources({...f.provenance,messageId:'request'});
  const result=await pending;assert.equal(result.status,'cancelled');assert.equal(result.taskReport.status,'cancelled');
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  for(let n=0;n<200&&pids.some(alive);n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(pids.some(alive),false);
 }finally{if(pids)try{process.kill(-pids[0],'SIGKILL');}catch{}f.close();}
});
test('scheduler retries failed cancellation persistence without needing the recall event again',()=>{
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});
 try{
  const id=f.seed('running'),marker=join(f.root,id+'.cancel');mkdirSync(marker);
  assert.throws(()=>jobs.cancelSources({...f.provenance,messageId:'request'}));
  rmSync(marker,{recursive:true});jobs.tick();assert.equal(f.marked(id),true);
 }finally{f.close();}
});
test('provider-neutral sources persist across job stores and reject event payload conflicts',()=>{
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});
 const source={namespace:'example-system',scope:'tenant/conversation',id:'record'};
 const event={apiVersion:1,eventId:'external-event',reason:'request withdrawn',sources:[source]};
 try{
  const id=f.seed('running',{provenance:{sourceRefs:[source]}}),other=f.seed('running',{provenance:{sourceRefs:[{...source,namespace:'other-system'}]}});
  assert.equal(jobs.invalidateSources(event).accepted,true);assert.equal(f.marked(id),true);assert.equal(f.marked(other),false);
  assert.equal(jobs.invalidateSources(event).accepted,true);
  assert.throws(()=>jobs.invalidateSources({...event,sources:[{...source,id:'other'}]}),/conflicts/);
  const admittedLater=f.seed('running',{provenance:{sourceRefs:[source]}});
  createJobs({root:f.root,node:process.execPath,worker:'/unused'}).tick();assert.equal(f.marked(admittedLater),true);
 }finally{f.close();}
});
test('owner process death stops the supervisor, CLI and child without trusting a stored PID',async()=>{
 const {fileURLToPath}=await import('node:url');
 const f=fixture();let wrapperPid,supervisorPid,pids=[];
 const script=join(f.root,'orphan-cli.mjs');
 writeFileSync(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync('orphan-pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
 const config=resolveQueueExecution(resolveConfiguration({cwd:f.root,state:join(f.root,'state'),codexHome:join(f.root,'codex'),node:process.execPath,skillsEnabled:false,memoryRequired:false,hermesTemplates:{codex:{...defaultHermesTemplates.codex,command:process.execPath,args:[script,...defaultHermesTemplates.codex.args]}}}));
 const jobs=createJobs({root:f.root,node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:()=>config});
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 try{
  const job=await jobs.run({topic:'orphan',task:'test',context:'fixture',constraints:'test processes only',waitSeconds:0},'isolated');
  wrapperPid=readJson(join(f.root,job.jobId+'.process.json')).pid;
  for(let n=0;n<300&&!existsSync(join(f.root,'orphan-pids.json'));n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(existsSync(join(f.root,'orphan-pids.json')),true);pids=readJson(join(f.root,'orphan-pids.json'));
  supervisorPid=f.read(job.jobId).executionPid;assert.ok(supervisorPid);assert.notEqual(supervisorPid,pids[0]);
  process.kill(wrapperPid,'SIGKILL');
  for(let n=0;n<300&&[wrapperPid,supervisorPid,...pids].some(alive);n++)await new Promise(r=>setTimeout(r,10));
  assert.equal([wrapperPid,supervisorPid,...pids].some(alive),false);
  const stored=f.read(job.jobId);writeJson(join(f.root,job.jobId+'.json'),{...stored,heartbeatAt:0});
  assert.equal(jobs.status(job.jobId,'isolated').status,'unknown');
  assert.equal(f.marked(job.jobId),false); // No fabricated cancellation acknowledgement.
 }finally{
  if(wrapperPid&&alive(wrapperPid))try{process.kill(wrapperPid,'SIGKILL');}catch{}
  if(supervisorPid)try{process.kill(-supervisorPid,'SIGKILL');}catch{}
  for(const pid of pids)if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}
  f.close();
 }
});
test('one cancellation write failure does not prevent cancellation attempts for other matching jobs',()=>{
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});
 try{
  const broken=f.seed('running'),healthy=f.seed('running');mkdirSync(join(f.root,broken+'.cancel'));
  assert.throws(()=>jobs.cancelSources({...f.provenance,messageId:'request'}));
  assert.equal(f.marked(healthy),true);
  rmSync(join(f.root,broken+'.cancel'),{recursive:true});jobs.tick();assert.equal(f.marked(broken),true);
 }finally{f.close();}
});
test('explicit provider references override legacy message identifiers, including native answer metadata',()=>{
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused'});
 const source={namespace:'other-provider',scope:'tenant/chat',id:'request'};
 try{
  const id=f.seed('running',{provenance:{...f.provenance,sourceRefs:[source]},questions:[{answerSource:'user_text',answerMessageId:'request'}]});
  jobs.cancelSources({...f.provenance,messageId:'request'});assert.equal(f.marked(id),false);
  jobs.invalidateSources({apiVersion:1,eventId:'other-provider-recall',reason:'recalled',sources:[source]});assert.equal(f.marked(id),true);
 }finally{f.close();}
});
