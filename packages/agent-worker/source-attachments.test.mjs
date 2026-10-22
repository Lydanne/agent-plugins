import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectSourceAttachments,snapshotSourceAttachments} from './source-attachments.mjs';
import {taskProvenance,sourceTaskBridge} from './source-tasks.mjs';
import {buildTaskPrompt} from './index.mjs';
import {runWorker} from './worker.mjs';
import {writeJson,requestKeyFor} from './jobs.mjs';

test('source snapshot is independent, drops unrelated files, and ignores model-supplied attachments',()=>{
 const item={messageId:'m',kind:'image',path:'/tmp/photo.png',availability:'available'};
 const lease={taskId:'t',revision:0,accountId:'a',chatId:'c',sessionKey:'s',senderId:'u',sourceMessageIds:['m'],attachments:[item,{...item,messageId:'unrelated',path:'/private/other'}],signal:new AbortController().signal};
 sourceTaskBridge.leases.set(JSON.stringify(['a','s']),lease);
 try {
  const p=taskProvenance(lease);item.path='/changed';assert.equal(p.attachments.length,1);assert.equal(p.attachments[0].path,'/tmp/photo.png');
  assert.notEqual(requestKeyFor({topic:'image',task:'inspect',context:'same',constraints:'read only'},'s',p),requestKeyFor({topic:'image',task:'inspect',context:'same',constraints:'read only'},'s',{...p,attachments:[{...p.attachments[0],path:'/new-image.png'}]}));
  const params={task:'inspect',context:'none',constraints:'read only',attachments:[item]};
  assert.equal(JSON.parse(buildTaskPrompt(params)).attachments,undefined);
  const prompt=JSON.parse(buildTaskPrompt(params,{attachments:p.attachments}));assert.equal(prompt.attachments[0].path,'/tmp/photo.png');assert.match(prompt.attachmentPolicy,/不代表.*已经分析/u);
 }finally{sourceTaskBridge.leases.clear();}
 assert.throws(()=>snapshotSourceAttachments([{...item,path:'relative'}],['m']),/Invalid trusted/);
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
