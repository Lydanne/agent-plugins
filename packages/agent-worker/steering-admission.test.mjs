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

test('a completed task with a bound parked checkpoint accepts steering for original-workspace recovery',async()=>{
 const f=fixture();try{
  const path=join(f.root,f.id+'.json'),job=readJson(path);
  const workspace={id:'p-0',assignmentId:'assignment',owner:f.id,path:'/fixture/p-0'};
  const workspaceCheckpoint={agentId:'main',projectId:'p',jobId:f.id,workspaceId:workspace.id,assignmentId:workspace.assignmentId,workspacePath:workspace.path};
  writeJson(path,{...job,status:'completed',agentId:'main',projectId:'p',useWorkspace:true,workspace,workspaceCheckpoint,workspaceSettled:true,workspaceRelease:'idle'});
  const result=JSON.parse((await query(f.args,f.ctx)).content[0].text);
  assert.equal(result.accepted,true);
 }finally{f.close();}
});
test('a mismatched checkpoint never authorizes steering into a released workspace',async()=>{
 const f=fixture();try{
  const path=join(f.root,f.id+'.json'),job=readJson(path);
  writeJson(path,{...job,status:'completed',agentId:'main',projectId:'p',useWorkspace:true,workspace:{id:'p-0',owner:f.id,assignmentId:'new',path:'/fixture/p-0'},workspaceCheckpoint:{agentId:'main',projectId:'p',jobId:f.id,workspaceId:'p-0',assignmentId:'old',workspacePath:'/fixture/p-0'},workspaceSettled:true});
  await assert.rejects(query(f.args,f.ctx),/STEERING_WORKSPACE_UNAVAILABLE/);
 }finally{f.close();}
});

test('steering accepts context alias and deduplicates a retry using answer',async()=>{
 const f=fixture();try{
  const answer='  complete evidence\nsecond line  ';
  const initial=JSON.parse((await query({action:'steer',jobId:f.id,context:answer},f.ctx)).content[0].text);
  assert.equal(initial.accepted,true);
  assert.equal(readJson(join(f.root,'supplements',initial.steeringId+'.json')).answer,answer);
  for(const fields of [{answer},{answer,context:answer}]){
   const retry=JSON.parse((await query({action:'steer',jobId:f.id,...fields},f.ctx)).content[0].text);
   assert.equal(retry.steeringId,initial.steeringId);
  }
  assert.equal(readJson(join(f.root,f.id+'.json')).steeringInputs.length,1);
 }finally{f.close();}
});
for(const fields of [{},{context:''},{context:' \n '},{context:123},{context:'x'.repeat(16001)},{answer:null},{answer:''},{answer:'x'.repeat(16001)}])test('steering rejects invalid content with actionable error: '+JSON.stringify(fields).slice(0,75),async()=>{
 const f=fixture();try{
  await assert.rejects(query({action:'steer',jobId:f.id,...fields},f.ctx),/STEERING_INPUT_INVALID.*answer.*原 jobId/);
  assert.equal(readJson(join(f.root,f.id+'.json')).steeringInputs,undefined);
 }finally{f.close();}
});
for(const answer of ['different','',null])test('steering refuses conflicting fields instead of dropping supplied content: '+JSON.stringify(answer),async()=>{
 const f=fixture();try{
  await assert.rejects(query({...f.args,answer,context:'evidence'},f.ctx),/STEERING_INPUT_CONFLICT/);
  assert.equal(readJson(join(f.root,f.id+'.json')).steeringInputs,undefined);
 }finally{f.close();}
});
test('context alias preserves source admission and original authorization',async()=>{
 const f=fixture();try{
  const args={action:'steer',jobId:f.id,context:'new evidence'};
  f.lease.scheduledRequest=true;
  await assert.rejects(query(args,f.ctx),/SOURCE_INVALID/);
  delete f.lease.scheduledRequest;
  completionBridge.authorizeReply=()=>false;
  await assert.rejects(query(args,f.ctx));
  assert.equal(readJson(join(f.root,f.id+'.json')).steeringInputs,undefined);
 }finally{f.close();}
});
test('context alias from another member still requires contributor approval',async()=>{
 const f=fixture();try{
  f.lease.senderId='bob';
  const result=JSON.parse((await query({action:'steer',jobId:f.id,context:'member evidence'},{...f.ctx,requesterSenderId:'bob'})).content[0].text);
  assert.equal(result.accepted,false);
  assert.equal(result.permissionPending,true);
  const stored=readJson(join(f.root,f.id+'.json'));
  assert.equal(stored.steeringInputs[0].answer,'member evidence');
  assert.equal(stored.contributorApprovals[0].status,'pending');
 }finally{f.close();}
});
test('mistaken questionId returns a correctable contract error without saving or restarting',async()=>{
 const f=fixture();try{
  await assert.rejects(query({...f.args,questionId:'invented'},f.ctx),/STEERING_INPUT_INVALID.*questionId.*answer/);
  assert.equal(readJson(join(f.root,f.id+'.json')).steeringInputs,undefined);
  const accepted=JSON.parse((await query(f.args,f.ctx)).content[0].text);assert.equal(accepted.accepted,true);
  assert.equal(readJson(join(f.root,f.id+'.json')).status,'running');
 }finally{f.close();}
});

test('accepted running steering holds the new human card with original business provenance',async()=>{
 const f=fixture();try{
  const path=join(f.root,f.id+'.json');writeJson(path,{...readJson(path),notification:{state:'pending'}});
  const receipt=JSON.parse((await query(f.args,f.ctx)).content[0].text);
  await query(f.args,f.ctx);
  assert.equal(f.lease.asyncDispatchAccepted,true);
  assert.equal(f.lease.asyncContinuations.length,1);
  assert.equal(f.lease.asyncContinuations[0].jobId,f.id);
  assert.equal(f.lease.asyncContinuations[0].questionId,receipt.steeringId);
  assert.equal(f.lease.asyncContinuations[0].provenance.taskId,'original');
 }finally{f.close();}
});
