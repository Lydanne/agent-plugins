import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import plugin,{query} from './index.mjs';
import {writeJson,readJson,requestKeyFor} from './jobs.mjs';
import {sourceTaskBridge} from './source-tasks.mjs';
import {completionBridge} from './completion.mjs';
function fixture(){
 const state=mkdtempSync(join(tmpdir(),'steering-admission-')),root=join(state,'jobs'),scope='agent:main:feishu:chat',id=randomUUID(),key=JSON.stringify(['a',scope]);mkdirSync(root);mkdirSync(join(root,'active'));
 const p={taskId:'original',revision:0,accountId:'a',chatId:'chat',chatType:'group',sessionKey:scope,senderId:'alice',sourceMessageIds:['original'],requestMessageIds:['original']};
 const params={topic:'same-task',task:'inspect',context:'fixture',constraints:'read only'},job={jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,p),provenance:p,status:'running',topic:params.topic,heartbeatAt:Date.now(),createdAt:Date.now(),questions:[],schedulerVersion:1};
 writeJson(join(root,id+'.json'),job);writeJson(join(root,id+'.request.json'),{params,scope});
 const previousLease=sourceTaskBridge.leases.get(key),previousAuthorize=completionBridge.authorizeReply;
 plugin.register({pluginConfig:{state,cwd:state,skillsEnabled:false},registerService(){},registerTool(){}});completionBridge.authorizeReply=()=>true;
 const lease={...p,taskId:'new-human-message',sourceMessageIds:['new-human-message'],signal:new AbortController().signal};sourceTaskBridge.leases.set(key,lease);
 const args={action:'steer',jobId:id,answer:'new evidence'},ctx={agentId:'main',agentAccountId:'a',requesterSenderId:'alice',sessionKey:scope};
 return {root,id,lease,args,ctx,close:()=>{completionBridge.authorizeReply=previousAuthorize;if(previousLease)sourceTaskBridge.leases.set(key,previousLease);else sourceTaskBridge.leases.delete(key);rmSync(state,{recursive:true,force:true});}};
}
test('scheduled occurrences cannot impersonate fresh human steering',async()=>{
 const f=fixture();try{
  f.lease.scheduledRequest=true;
  await assert.rejects(query(f.args,f.ctx),/SOURCE_INVALID/);
  assert.equal(readJson(join(f.root,f.id+'.json')).steeringInputs,undefined);
 }finally{f.close();}
});
for(const state of ['blocked','suppressed','dispatched'])test('steering retry reports existing '+state+' receipt accurately',async()=>{
 const f=fixture();try{
  const initial=JSON.parse((await query(f.args,f.ctx)).content[0].text);assert.equal(initial.accepted,true);
  const file=join(f.root,'supplements',initial.steeringId+'.json'),record=readJson(file);
  writeJson(file,{...record,status:state,...(state==='dispatched'?{childJobId:'existing-continuation'}:{reason:'original_session_missing'})});
  const retried=JSON.parse((await query(f.args,f.ctx)).content[0].text);
  assert.equal(retried.state,state);assert.equal(retried.accepted,state==='dispatched');assert.equal(retried.effectiveAt,state==='dispatched'?'already_dispatched':'unavailable');
  if(state==='dispatched'){assert.equal(retried.continuationJobId,'existing-continuation');assert.match(retried.instruction,/未重复排队/);}else{assert.equal(retried.reason,'original_session_missing');assert.match(retried.instruction,/不是等待执行/);}
 }finally{f.close();}
});

for(const state of ['settled','idle','settling'])test('released or settling workspace refuses new steering: '+state,async()=>{
 const f=fixture();try{
  const path=join(f.root,f.id+'.json'),job=readJson(path);
  writeJson(path,{...job,useWorkspace:true,...(state==='settled'?{workspaceSettled:true}:state==='idle'?{workspaceRelease:'idle'}:{workspaceSettlement:{pid:process.pid,token:'settling'}})});
  await assert.rejects(query(f.args,f.ctx),/STEERING_WORKSPACE_UNAVAILABLE/);assert.equal(readJson(path).steeringInputs,undefined);
 }finally{f.close();}
});

for(const status of ['dispatched','blocked','suppressed'])test('read-only '+status+' receipt survives workspace settlement',async()=>{
 const f=fixture();try{
  const initial=JSON.parse((await query(f.args,f.ctx)).content[0].text),file=join(f.root,'supplements',initial.steeringId+'.json');
  writeJson(file,{...readJson(file),status});const path=join(f.root,f.id+'.json');writeJson(path,{...readJson(path),useWorkspace:true,workspaceSettled:true,workspaceRelease:'idle'});
  const retried=JSON.parse((await query(f.args,f.ctx)).content[0].text);assert.equal(retried.state,status);assert.equal(retried.accepted,status==='dispatched');
 }finally{f.close();}
});
