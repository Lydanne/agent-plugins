import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectSourceAttachments,snapshotSourceAttachments} from './source-attachments.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {taskProvenance,sourceTaskBridge} from './source-tasks.mjs';
import {buildTaskPrompt} from './index.mjs';
import {runWorker} from './worker.mjs';
import {writeJson,readJson,requestKeyFor,createJobs} from './jobs.mjs';
import {readCompletionRequest,completionEvent} from './completion.mjs';

test('source snapshot is independent, drops unrelated files, and ignores model-supplied attachments',()=>{
 const item={messageId:'m',kind:'image',path:'/tmp/photo.png',availability:'available'};
 const lease={taskId:'t',revision:0,accountId:'a',chatId:'c',sessionKey:'s',senderId:'u',sourceMessageIds:['m'],attachments:[item,{...item,messageId:'unrelated',path:'/private/other'}],signal:new AbortController().signal};
 sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);
 try {
  const p=taskProvenance(lease);item.path='/changed';assert.equal(p.attachments.length,1);assert.equal(p.attachments[0].path,'/tmp/photo.png');
  assert.equal(requestKeyFor({topic:'image',task:'inspect',context:'same',constraints:'read only'},'s',p),requestKeyFor({topic:'image',task:'inspect',context:'same',constraints:'read only'},'s',{...p,attachments:[{...p.attachments[0],path:'/new-image.png'}]}));
  const params={task:'inspect',context:'none',constraints:'read only',attachments:[item]};
  assert.equal(JSON.parse(buildTaskPrompt(params)).attachments,undefined);
  const prompt=JSON.parse(buildTaskPrompt(params,{attachments:p.attachments}));assert.equal(prompt.attachments[0].path,'/tmp/photo.png');assert.match(prompt.attachmentPolicy,/不代表.*已经分析/u);
 }finally{sourceTaskBridge.leases.clear();}
 assert.throws(()=>snapshotSourceAttachments([{...item,path:'relative'}],['m']),/Invalid trusted/);
});

test('cache redownload returns the accepted job while a different resource conflicts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'stable-media-')),scope='stable',id=randomUUID();
 try {
  mkdirSync(join(root,'active')); // No real executor is started by this fixture.
  const params={topic:'video',task:'inspect',context:'same',constraints:'read only',requestId:'stable-request',waitSeconds:0};
  const attachments=[{messageId:'m',kind:'video',resourceId:'resource-one',path:'/cache/one.mp4',availability:'available'}];
  const provenance={accountId:'a',senderId:'u',sourceMessageIds:['m'],attachments};
  const job={jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope,provenance),project:{projectId:'demo'},projectId:'demo',repository:'projects/demo',requestId:params.requestId,provenance,topic:params.topic,status:'queued',schedulerVersion:1,tags:[],heartbeatAt:Date.now(),createdAt:Date.now()};
  writeJson(join(root,id+'.json'),job);
  const jobs=createJobs({root,node:process.execPath,worker:'/unused',getRuntime:()=>{throw Error('Retry must not prepare or start another job');}});
  const redownload={...provenance,attachments:[{...attachments[0],path:'/cache/new.mp4',availability:'unavailable',contentType:'application/octet-stream'}]};
  assert.equal(requestKeyFor(params,scope,provenance),requestKeyFor(params,scope,redownload));
  assert.equal((await jobs.run(params,scope,redownload)).jobId,id);
  await assert.rejects(jobs.run(params,scope,{...redownload,attachments:[{...redownload.attachments[0],resourceId:'different-resource'}]}),{code:'REQUEST_ID_CONFLICT'});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('reply preserves the original request and passes supplemental files after restart; recall cancels them',async()=>{
 const root=mkdtempSync(join(tmpdir(),'reply-media-')),id=randomUUID(),scope='reply-media';
 try {
  const image=join(root,'one.png'),video=join(root,'two.mp4');writeFileSync(image,'image');writeFileSync(video,'video');
  const params={topic:'media',task:'inspect',context:'none',constraints:'read only'};
  const original={taskId:'original',revision:0,accountId:'a',chatId:'c',sessionKey:scope,senderId:'u',sourceMessageIds:['m1'],attachments:[{messageId:'m1',kind:'image',resourceId:'image',path:image,availability:'available'}]};
  const requestKey=requestKeyFor(params,scope,original);
  writeJson(join(root,id+'.json'),{jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey,provenance:original,topic:params.topic,status:'running',schedulerVersion:1,tags:[],heartbeatAt:Date.now(),createdAt:Date.now()});writeJson(join(root,id+'.request.json'),{params,scope});
  const waiting=await runWorker({root,id,params,scope,execute:async()=>({content:[{type:'text',text:JSON.stringify({contextRequest:{question:'请补视频',reason:'缺少原文件',progress:'waiting'},sessionId:'thread'})}]})});
  const supplement={...original,taskId:'supplement',sourceMessageIds:['m2'],attachments:[{messageId:'m2',kind:'video',resourceId:'video',path:video,availability:'available'}]};
  const q=waiting.contextRequest.questionId;mkdirSync(join(root,'active'));
  let jobs=createJobs({root,node:process.execPath,worker:'/unused'});
  const reply=(source,authorize=()=>true)=>jobs.reply(id,scope,q,'已补视频',{accountId:'a',senderId:'u'},authorize,false,undefined,{answerSource:'user_text',attachmentSource:source});
  for(const key of ['accountId','chatId','sessionKey','senderId'])await assert.rejects(reply({...supplement,[key]:'other'}),/does not match/);
  await assert.rejects(reply(supplement,p=>!p.attachmentSources?.length),/authorization/);
  assert.equal(jobs.status(id,scope).status,'awaiting_main');
  const resumed=await reply(supplement);assert.equal(resumed.jobId,id);assert.equal(resumed.requestKey,requestKey);assert.deepEqual(resumed.provenance.attachments,original.attachments);assert.equal(resumed.provenance.attachmentSources[0].questionId,q);
  supplement.attachments[0].path='/later-mutation';assert.equal(resumed.provenance.attachmentSources[0].attachments[0].path,video);
  assert.equal((await reply({...supplement,attachments:[{...supplement.attachments[0],path:'/new-cache.mp4'}]})).jobId,id);
  assert.equal((await jobs.reply(id,scope,q,'已补视频',{accountId:'a',senderId:'u'})).jobId,id);
  await assert.rejects(reply({...supplement,attachments:[{...supplement.attachments[0],resourceId:'another'}]}),/differently/);
  jobs=createJobs({root,node:process.execPath,worker:'/unused'});let received;
  const done=await runWorker({root,id,params:readJson(join(root,id+'.request.json')).resumeParams,scope,execute:async(_params,ctx)=>{received=ctx.attachments;return {content:[{type:'text',text:'{}'}]};}});
  assert.deepEqual(received.map(a=>a.path),[image,video]);assert.equal(readCompletionRequest(root,done).availability,'available');assert.equal(completionEvent(done).provenance.attachmentSources[0].taskId,'supplement');
  writeJson(join(root,id+'.json'),{...done,status:'queued',resumePending:true});assert.deepEqual(jobs.cancelSources({accountId:'other',chatId:'c',messageId:'m2'}),[]);assert.deepEqual(jobs.cancelSources({accountId:'a',chatId:'c',messageId:'m2'}),[id]);
  let calls=0;const cancelled=await runWorker({root,id,params,scope,execute:async()=>{calls++;}});assert.equal(calls,0);assert.equal(cancelled.status,'cancelled');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('background execution receives persisted media and rechecks files after a queue or resume',async()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-media-')),path=join(root,'clip.mp4'),id='fixture';
 try {
  writeFileSync(path,'video');
  const items=[{messageId:'m',kind:'video',path,availability:'available'},{messageId:'m',kind:'image',availability:'unavailable'}];
  const provenance={sourceMessageIds:['m'],attachments:items};
  writeJson(join(root,id+'.json'),{jobId:id,status:'queued',provenance});
  let seen;
  await runWorker({root,id,params:{},scope:'s',execute:async(_params,context)=>{seen=context.attachments;return {content:[{type:'text',text:'{}'}]};}});
  assert.equal(seen[0].path,path);assert.equal(seen[0].sizeBytes,5);assert.equal(seen[1].reason,'not_downloaded');
  rmSync(path);assert.equal(inspectSourceAttachments(items,['m'])[0].reason,'file_unreadable');
  assert.deepEqual(inspectSourceAttachments(items,['different']),[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
