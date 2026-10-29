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
 const f=fixture();let current;
 const jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused',sourceCurrent:p=>p.accountId==='a'?current:true});
 try{
  mkdirSync(join(f.root,'active')); // Hold unrelated fixtures without spawning.
  const ids=['queued','running','unknown','awaiting_main','awaiting_user'].map(status=>f.seed(status));
  const other=f.seed('running',{provenance:{...f.provenance,accountId:'other'}}),local=f.seed('running',{provenance:{agentId:'main'}}),automation=f.seed('running',{provenance:{automation:{version:1}}}),done=f.seed('completed');
  jobs.tick();for(const id of ids)assert.equal(f.marked(id),false);
  current=false;jobs.tick();
  for(const id of ids)assert.equal(f.marked(id),true);
  for(const id of [ids[0],ids[3],ids[4]])assert.equal(f.read(id).status,'cancelled');
  for(const id of [other,local,automation,done])assert.equal(f.marked(id),false);
 }finally{jobs.stop();f.close();}
});
test('unavailable or throwing source validator holds queued jobs and retries without cancelling in-flight jobs',()=>{
 const f=fixture();let current,fail=false;
 const jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused',sourceCurrent:()=>{if(fail)throw Error('unavailable');return current;}});
 try{
  const queued=f.seed('queued'),running=f.seed('running');
  for(const throws of [false,true]){fail=throws;jobs.tick();assert.equal(f.read(queued).status,'queued');assert.equal(existsSync(join(f.root,queued+'.process.json')),false);assert.equal(f.marked(running),false);}
  fail=false;current=false;jobs.tick();assert.equal(f.read(queued).status,'cancelled');assert.equal(f.marked(running),true);
 }finally{jobs.stop();f.close();}
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
 const f=fixture(),jobs=createJobs({root:f.root,node:process.execPath,worker:'/unused',sourceCurrent:()=>false});
 try{
  const id=f.seed('running'),marker=join(f.root,id+'.cancel');mkdirSync(marker);
  assert.throws(()=>jobs.cancelSources({...f.provenance,messageId:'request'}));
  rmSync(marker,{recursive:true});jobs.tick();assert.equal(f.marked(id),true);
 }finally{f.close();}
});
