import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import plugin,{query} from './index.mjs';
import {readJson,writeJson,requestKeyFor} from './jobs.mjs';
import {registerAgentRepoService} from './dist/agent-repo-api.mjs';
import {completionBridge} from './completion.mjs';
import {hasSourceProvenance} from './source-tasks.mjs';

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
