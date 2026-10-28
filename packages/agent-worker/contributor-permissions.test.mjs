import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createJobs,writeJson,readJson,requestKeyFor} from './jobs.mjs';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'contributor-permission-')),scope='agent:main:feishu:group',actor={senderId:'alice',accountId:'a'},requester={senderId:'bob',accountId:'a'};
 mkdirSync(join(root,'active'));const jobs=createJobs({root,node:process.execPath,worker:'unused'});
 function job(patch={}){
  const id=randomUUID(),p={taskId:randomUUID(),revision:0,accountId:'a',chatId:'chat',chatType:'group',senderId:'alice',sessionKey:scope,sourceMessageIds:['original'],...patch};
  const q={questionId:randomUUID(),question:'context',waitKind:'required',expiresAt:Date.now()+60000};
  const params={topic:'test',task:'read only',context:'fixture',constraints:'read only'};
  writeJson(join(root,id+'.json'),{jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,p),provenance:p,status:'awaiting_user',questions:[q],contextRequest:q,schedulerVersion:1,topic:'test'});
  writeJson(join(root,id+'.request.json'),{scope,params});return {id,q,p};
 }
 function source(j,patch={}){return {taskId:randomUUID(),revision:0,accountId:'a',chatId:j.p.chatId,sessionKey:scope,senderId:'bob',chatType:'group',kind:'group_context',sourceMessageIds:[randomUUID()],attachments:[],...patch};}
 const request=(j,s)=>jobs.requestContributor(j.id,scope,j.q.questionId,'hint',requester,s,()=>true);
 return {root,scope,actor,requester,jobs,job,source,request,close:()=>rmSync(root,{recursive:true,force:true})};
}
for(const mode of ['once','worker','always'])test('contributor approval scope and persistence: '+mode,async()=>{
 const f=fixture();try{
  const j=f.job(),s=f.source(j),pending=await f.request(j,s);
  assert.equal(pending.approved,false);assert.equal((await f.request(j,s)).request.requestId,pending.request.requestId);
  await assert.rejects(f.jobs.reply(j.id,f.scope,j.q.questionId,'hint',f.requester,()=>true,false,undefined,{attachmentSource:s}),/requester/);
  await assert.rejects(f.jobs.decideContributor(j.id,f.scope,pending.request.requestId,f.requester,mode,()=>true),/requester/);
  await f.jobs.decideContributor(j.id,f.scope,pending.request.requestId,f.actor,mode,()=>true);
  await f.jobs.decideContributor(j.id,f.scope,pending.request.requestId,f.actor,mode,()=>true);
  assert.equal((await f.request(j,s)).approved,true);
  const restored=createJobs({root:f.root,node:process.execPath,worker:'unused'});
  assert.equal((await restored.requestContributor(j.id,f.scope,j.q.questionId,'hint',f.requester,s,()=>true)).approved,true);
  const nextSource=f.source(j);
  assert.equal((await f.request(j,nextSource)).approved,mode!=='once');
  const otherJob=f.job();assert.equal((await f.request(otherJob,f.source(otherJob))).approved,mode==='always');
  const otherOwner=f.job({senderId:'carol'});assert.equal((await f.request(otherOwner,f.source(otherOwner))).approved,false);
  const otherChat=f.job({chatId:'other'});assert.equal((await f.request(otherChat,f.source(otherChat))).approved,false);
  const anotherSender={...f.requester,senderId:'carol'};
  assert.equal((await f.jobs.requestContributor(j.id,f.scope,j.q.questionId,'hint',anotherSender,f.source(j,{senderId:'carol'}),()=>true)).approved,false);
  await assert.rejects(f.jobs.decideContributor(j.id,f.scope,pending.request.requestId,f.actor,mode==='once'?'always':'once',()=>true),/differently/);
  await assert.rejects(f.jobs.decideContributor(j.id,f.scope,pending.request.requestId,f.actor,mode,()=>false),/source/);
 }finally{f.close();}
});
test('once cannot answer another question with the same approval ID',async()=>{
 const f=fixture();try{
  const j=f.job(),s=f.source(j),pending=await f.request(j,s);await f.jobs.decideContributor(j.id,f.scope,pending.request.requestId,f.actor,'once',()=>true);
  const file=join(f.root,j.id+'.json'),stored=readJson(file),q={...j.q,questionId:randomUUID()};writeJson(file,{...stored,contextRequest:q,questions:[...stored.questions,q]});
  await assert.rejects(f.jobs.reply(j.id,f.scope,q.questionId,'hint',f.requester,()=>true,false,undefined,{attachmentSource:s,contributorApprovalId:pending.request.requestId}),/requester/);
 }finally{f.close();}
});
test('expired or cancelled approvals and invalid contributor sources never grant permission',async()=>{
 const f=fixture();try{
  for(const reason of ['expired','cancelled','source']){
   const j=f.job(),s=f.source(j),pending=await f.request(j,s),file=join(f.root,j.id+'.json'),stored=readJson(file);
   if(reason==='expired')stored.contributorApprovals[0].expiresAt=0;
   if(reason==='cancelled')stored.status='cancelled';writeJson(file,stored);
   await assert.rejects(f.jobs.decideContributor(j.id,f.scope,pending.request.requestId,f.actor,'always',()=>reason!=='source'));
   assert.equal(readJson(file).contributorApprovals[0].status,'pending');
  }
 }finally{f.close();}
});
