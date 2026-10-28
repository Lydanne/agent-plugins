import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import plugin,{query} from './index.mjs';
import {readJson,writeJson,requestKeyFor,createJobs} from './jobs.mjs';
import {registerAgentRepoService} from './dist/agent-repo-api.mjs';
import {completionBridge} from './completion.mjs';
import {hasSourceProvenance,sourceTaskBridge} from './source-tasks.mjs';

for(const behavior of ['reject','hang'])for(const localMetadata of [false,true])test(`Main reply persists when skill refreshes ${behavior} (local metadata=${localMetadata})`,async t=>{
 const state=await mkdtemp(join(tmpdir(),'worker-reply-refresh-')),root=join(state,'jobs'),scope='agent:main:review',id=randomUUID();
 let dispose,calls=0,timer,authorizationCalls=0;
 const previousAuthorize=completionBridge.authorizeReply;
 completionBridge.authorizeReply=()=>{authorizationCalls++;return false;};
 t.mock.method(console,'error',()=>{});
 try {
  await mkdir(join(root,'active'),{recursive:true}); // Preserve a simulated older executor; do not launch a CLI.
  plugin.register({pluginConfig:{state,cwd:state,skillsEnabled:false},registerService(){},registerTool(){}});
  dispose=registerAgentRepoService({apiVersion:1,agentId:'main',listProjects(){},inspectProject(){},prepareExecutionScope(){},prepareWorkerSkill:async()=>{calls++;if(behavior==='hang')return new Promise(()=>{});throw Error('catalog unavailable');}},{owner:{}});
  const params={action:'run',topic:'test',task:'read',context:'fixture',constraints:'read only'},question={questionId:randomUUID(),question:'Main plugin result?',reason:'continue',progress:'ready',expiresAt:Date.now()+60000};
  writeJson(join(root,id+'.json'),{jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope),...(localMetadata?{provenance:{agentId:'main',sessionId:'local-native-session'}}:{}),topic:'test',schedulerVersion:1,status:'awaiting_main',createdAt:Date.now(),project:{projectId:'test'},contextRequest:question,questions:[question]});
  writeJson(join(root,id+'.request.json'),{params,scope});
  const reply={action:'reply',jobId:id,questionId:question.questionId,answer:'confirmed'},context={agentId:'main',sessionKey:scope};
  const result=await Promise.race([query(reply,context),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('reply blocked on metadata')),2000);})]);clearTimeout(timer);
  assert.equal(JSON.parse(result.content[0].text).accepted,true);
  assert.equal(readJson(join(root,id+'.json')).questions[0].answer,'confirmed');
  assert.equal(JSON.parse((await query(reply,context)).content[0].text).accepted,true);
  assert.equal(calls,2);
  await assert.rejects(query({...reply,questionId:'invalid'},context));
  assert.equal(calls,2);
  assert.equal(authorizationCalls,0);
  await assert.rejects(query(reply,{agentId:'main',sessionKey:'agent:main:other-conversation'}));
  if(localMetadata) {
   const tagged=JSON.parse((await query({action:'tag',jobId:id,tags:['local-check']},context)).content[0].text);
   assert.deepEqual(tagged.tags,['local-check']);
   const cancelled=JSON.parse((await query({action:'cancel',jobId:id},context)).content[0].text);
   assert.equal(cancelled.status,'cancelling');
  }
 }finally{completionBridge.authorizeReply=previousAuthorize;clearTimeout(timer);dispose?.();await rm(state,{recursive:true,force:true});}
});

test('partial channel provenance never becomes local operator metadata',()=>{
 assert.equal(hasSourceProvenance(undefined),false);
 assert.equal(hasSourceProvenance({agentId:'main',sessionId:'local'}),false);
 for(const field of ['taskId','revision','accountId','chatId','sessionKey','senderId','sourceMessageIds','requestMessageIds']) {
  assert.equal(hasSourceProvenance({agentId:'main',[field]:undefined}),true,field);
 }
});

for(const provenance of [{senderId:'alice'}, {taskId:'t',accountId:'test',senderId:'alice'}])test('Main reply preserves channel-source authorization checks '+JSON.stringify(provenance),async()=>{
 const state=await mkdtemp(join(tmpdir(),'worker-channel-reply-')),root=join(state,'jobs'),scope='agent:main:channel',id=randomUUID();
 const previousAuthorize=completionBridge.authorizeReply;
 try {
  await mkdir(root,{recursive:true});
  plugin.register({pluginConfig:{state,cwd:state,skillsEnabled:false},registerService(){},registerTool(){}});
  completionBridge.authorizeReply=()=>false;
  writeJson(join(root,id+'.json'),{jobId:id,scope:createHash('sha256').update(scope).digest('hex'),provenance,status:'awaiting_main'});
  await assert.rejects(query({action:'reply',jobId:id,questionId:'q',answer:'untrusted'},{agentId:'main',sessionKey:scope}),/CONTEXT_REPLY_FORBIDDEN/);
  assert.equal(readJson(join(root,id+'.json')).status,'awaiting_main');
 }finally{completionBridge.authorizeReply=previousAuthorize;await rm(state,{recursive:true,force:true});}
});

test('real reply entry retries failed presentation without replaying the business resume',async()=>{
 const state=await mkdtemp(join(tmpdir(),'worker-presentation-retry-')),root=join(state,'jobs'),scope='agent:main:review',id=randomUUID();
 const previousAuthorize=completionBridge.authorizeReply,previousPresentation=completionBridge.contextState;
 let calls=0;
 try{
  await mkdir(join(root,'active'),{recursive:true});
  plugin.register({pluginConfig:{state,cwd:state,skillsEnabled:false},registerService(){},registerTool(){}});
  const provenance={taskId:'task',revision:0,senderId:'alice',accountId:'a',chatId:'chat',sessionKey:scope,sourceMessageIds:['message'],requestMessageIds:['message']};
  completionBridge.authorizeReply=()=>true;
  completionBridge.contextState=async event=>{assert.equal(event.status,'resumed');calls++;if(calls===1)throw Error('upload failed before send');};
  const params={action:'run',topic:'test',task:'read',context:'fixture',constraints:'read only'},question={questionId:randomUUID(),question:'依据',reason:'缺少',progress:'准备',expiresAt:Date.now()+60000};
  writeJson(join(root,id+'.json'),{jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,provenance),provenance,topic:'test',schedulerVersion:1,status:'awaiting_main',createdAt:Date.now(),contextRequest:question,questions:[question]});
  writeJson(join(root,id+'.request.json'),{params,scope});
  const reply={action:'reply',jobId:id,questionId:question.questionId,answer:'confirmed'},context={agentId:'main',sessionKey:scope,requesterSenderId:'alice',agentAccountId:'a'};
  const first=JSON.parse((await query(reply,context)).content[0].text);assert.equal(first.presentation.state,'failed');
  const saved=readJson(join(root,id+'.json'));const request=readJson(join(root,id+'.request.json'));
  const second=JSON.parse((await query(reply,context)).content[0].text);assert.equal(second.accepted,true);assert.notEqual(second.presentation.state,'failed');assert.equal(calls,2);
  assert.deepEqual(readJson(join(root,id+'.json')),saved);assert.deepEqual(readJson(join(root,id+'.request.json')),request);
  await assert.rejects(query({...reply,answer:'different'},context));assert.equal(calls,2);
 }finally{completionBridge.authorizeReply=previousAuthorize;completionBridge.contextState=previousPresentation;await rm(state,{recursive:true,force:true});}
});

test('real reply entry binds current trusted media to the original job',async()=>{
 const state=await mkdtemp(join(tmpdir(),'worker-reply-media-')),root=join(state,'jobs'),scope='agent:main:media',id=randomUUID(),leaseKey=JSON.stringify(['a',scope]);
 const previousAuthorize=completionBridge.authorizeReply,previousPresentation=completionBridge.contextState,previousLease=sourceTaskBridge.leases.get(leaseKey);
 try{
  await mkdir(join(root,'active'),{recursive:true});
  plugin.register({pluginConfig:{state,cwd:state,skillsEnabled:false},registerService(){},registerTool(){}});
  const provenance={taskId:'original',revision:0,senderId:'alice',accountId:'a',chatId:'chat',sessionKey:scope,sourceMessageIds:['message'],requestMessageIds:['message']};
  completionBridge.authorizeReply=()=>true;
  completionBridge.contextState=async()=>({interactive:false});
  const params={action:'run',topic:'test',task:'read',context:'fixture',constraints:'read only'},question={questionId:randomUUID(),question:'视频？',reason:'缺少',progress:'准备',expiresAt:Date.now()+60000},requestKey=requestKeyFor(params,scope,provenance);
  writeJson(join(root,id+'.json'),{jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey,provenance,topic:'test',schedulerVersion:1,status:'awaiting_main',createdAt:Date.now(),contextRequest:question,questions:[question]});
  writeJson(join(root,id+'.request.json'),{params,scope});
  const attachment={messageId:'new-media',resourceId:'video-resource',kind:'video',availability:'available',path:join(state,'video.mp4')};
  sourceTaskBridge.leases.set(leaseKey,{...provenance,taskId:'supplement',sourceMessageIds:['new-media'],requestMessageIds:['new-media'],attachments:[attachment],signal:new AbortController().signal});
  const result=JSON.parse((await query({action:'reply',jobId:id,questionId:question.questionId,answer:'视频已补充'},{agentId:'main',sessionKey:scope,requesterSenderId:'alice',agentAccountId:'a'})).content[0].text);
  assert.equal(result.accepted,true);
  const saved=readJson(join(root,id+'.json'));
  assert.equal(saved.requestKey,requestKey);assert.equal(saved.provenance.taskId,'original');
  assert.deepEqual(saved.provenance.sourceMessageIds,['message']);
  assert.deepEqual(saved.provenance.attachmentSources,[{taskId:'supplement',revision:0,accountId:'a',chatId:'chat',sessionKey:scope,senderId:'alice',sourceMessageIds:['new-media'],attachments:[attachment],questionId:question.questionId}]);
 }finally{
  completionBridge.authorizeReply=previousAuthorize;completionBridge.contextState=previousPresentation;
  if(previousLease)sourceTaskBridge.leases.set(leaseKey,previousLease);else sourceTaskBridge.leases.delete(leaseKey);
  await rm(state,{recursive:true,force:true});
 }
});

for(const scenario of ['accepted','decision','authorization','plugin','private','other-chat','other-account','other-session','no-lease','recalled','original-recalled'])test('group context reply: '+scenario,async()=>{
 const state=await mkdtemp(join(tmpdir(),'worker-group-context-')),root=join(state,'jobs'),scope='agent:main:group-context',id=randomUUID(),leaseKey=JSON.stringify(['a',scope]);
 const previousAuthorize=completionBridge.authorizeReply,previousPresentation=completionBridge.contextState,previousLease=sourceTaskBridge.leases.get(leaseKey);
 try{
  await mkdir(join(root,'active'),{recursive:true});
  plugin.register({pluginConfig:{state,cwd:state,skillsEnabled:false},registerService(){},registerTool(){}});
  const provenance={taskId:'original',revision:0,senderId:'alice',accountId:'a',chatId:'chat',chatType:'group',sessionKey:scope,sourceMessageIds:['request'],requestMessageIds:['request']};
  const lease={...provenance,taskId:'bob-context',senderId:'bob',sourceMessageIds:['hint'],signal:new AbortController().signal};
  if(scenario==='private')lease.chatType='p2p';
  if(scenario==='other-chat')lease.chatId='other';
  if(scenario==='other-account')lease.accountId='other';
  if(scenario==='other-session')lease.sessionKey='other';
  if(scenario!=='no-lease')sourceTaskBridge.leases.set(leaseKey,lease);
  completionBridge.authorizeReply=p=>scenario!=='original-recalled'&&!(scenario==='recalled'&&p.attachmentSources?.length);
  completionBridge.contextState=async()=>({interactive:false});
  const params={action:'run',topic:'test',task:'read',context:'fixture',constraints:'read only'},question={questionId:randomUUID(),question:'查询链路线索？',reason:'缺少',progress:'准备',waitKind:['decision','authorization'].includes(scenario)?scenario:'required',...(scenario==='plugin'?{requestKind:'plugin'}:{}),expiresAt:Date.now()+60000};
  const initial={jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,provenance),provenance,topic:'test',schedulerVersion:1,status:'awaiting_user',createdAt:Date.now(),contextRequest:question,questions:[question]};
  writeJson(join(root,id+'.json'),initial);writeJson(join(root,id+'.request.json'),{params,scope});
  const reply={action:'reply',jobId:id,questionId:question.questionId,answer:'请沿 notify 链路核查'},context={agentId:'main',sessionKey:scope,requesterSenderId:'bob',agentAccountId:'a'};
  if(scenario!=='accepted'){
   await assert.rejects(query(reply,context));assert.deepEqual(readJson(join(root,id+'.json')),initial);return;
  }
  for(const answer of [undefined,'','   '])await assert.rejects(query({...reply,answer},context));
  const pending=JSON.parse((await query(reply,context)).content[0].text);
  assert.equal(pending.accepted,false);assert.equal(pending.permissionPending,true);
  assert.equal(readJson(join(root,id+'.json')).status,'awaiting_user');
  const permission=readJson(join(root,id+'.json')).contributorApprovals[0];
  const jobs=createJobs({root,node:process.execPath,worker:'unused'});
  await jobs.decideContributor(id,scope,permission.requestId,{senderId:'alice',accountId:'a'},'worker',()=>true);
  assert.equal(JSON.parse((await query(reply,context)).content[0].text).accepted,true);
  const saved=readJson(join(root,id+'.json')),request=readJson(join(root,id+'.request.json'));
  assert.equal(saved.provenance.senderId,'alice');assert.equal(saved.provenance.taskId,'original');
  assert.equal(saved.provenance.attachmentSources[0].senderId,'bob');assert.deepEqual(saved.provenance.attachmentSources[0].sourceMessageIds,['hint']);
  assert.match(request.resumeParams.mainReplies[0].answer,/待核验线索/);assert.match(request.resumeParams.mainReplies[0].answer,/不扩大原 task/);
  assert.equal(JSON.parse((await query(reply,context)).content[0].text).accepted,true);
  assert.deepEqual(readJson(join(root,id+'.json')),saved);
  await assert.rejects(query({action:'cancel',jobId:id},context));
  await assert.rejects(query({action:'await_user',jobId:id,questionId:question.questionId},context));
 }finally{
  completionBridge.authorizeReply=previousAuthorize;completionBridge.contextState=previousPresentation;
  if(previousLease)sourceTaskBridge.leases.set(leaseKey,previousLease);else sourceTaskBridge.leases.delete(leaseKey);
  await rm(state,{recursive:true,force:true});
 }
});
