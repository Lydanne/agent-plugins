import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {rmSync} from 'node:fs';
import {acquireWorkerSkillLock} from './worker-skill-lock.mjs';
import {publishWorkerSkill} from './worker-skill.mjs';

test('live publishers serialize and unknown ownership is preserved',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-skill-lock-')),path=join(root,'lock');
 try {
  const release=await acquireWorkerSkillLock(path);
  await assert.rejects(acquireWorkerSkillLock(path,{timeoutMs:0}),/busy/);
  const waiting=acquireWorkerSkillLock(path);setTimeout(release,40);
  const next=await waiting;next();
  await mkdir(path);await assert.rejects(acquireWorkerSkillLock(path,{timeoutMs:0}),/busy/);
  await writeFile(join(path,'keep'),'unmanaged');assert.equal(await readFile(join(path,'keep'),'utf8'),'unmanaged');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('SIGKILL during first publication leaves no partial public skill and its lock recovers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-skill-crash-'));
 const module=new URL('./worker-skill.mjs',import.meta.url).href;
 // Stop before the ownership marker is published, after the other files were written.
 const code=`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.promises.rename;fs.promises.rename=async(a,b)=>{if(b.endsWith('/.agent-repo.json')){console.log('ready');await new Promise(()=>{});}return original(a,b);};syncBuiltinESMExports();const{publishWorkerSkill}=await import(${JSON.stringify(module)});setInterval(()=>{},1000);await publishWorkerSkill(${JSON.stringify(root)},'main','interrupted');`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','inherit']});
 try {
  await Promise.race([once(child.stdout,'data',{signal:AbortSignal.timeout(10000)}),once(child,'exit').then(()=>{throw Error('child exited before publishing');})]);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  await assert.rejects(readFile(join(root,'skills/openclaw-main-main/SKILL.md')),error=>error.code==='ENOENT');
  const result=await publishWorkerSkill(root,'main','complete');
  assert.equal(await readFile(result.path,'utf8'),'complete');
  // A dead recovery owner is reclaimable too.
  const lock=join(root,'skills/.openclaw-main-main.lock');
  for(const path of [lock,lock+'.recovery']){await mkdir(path);await writeFile(join(path,'owner.json'),JSON.stringify({pid:child.pid,token:path}));}
  assert.equal((await publishWorkerSkill(root,'main','next')).path,result.path);
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});

test('independent publisher processes preserve a complete canonical version under contention',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-skill-processes-'));
 try {
  const module=new URL('./worker-skill.mjs',import.meta.url).href;
  await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
   const code=`const{publishWorkerSkill}=await import(${JSON.stringify(module)});await publishWorkerSkill(${JSON.stringify(root)},'main',${JSON.stringify('version '+i)});`;
   const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});
   let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(stderr)));
  })));
  const directory=join(root,'skills/openclaw-main-main');
  const marker=JSON.parse(await readFile(join(directory,'.agent-repo.json'),'utf8'));
  assert.equal(await readFile(join(directory,'SKILL.md'),'utf8'),await readFile(join(directory,'revisions',marker.revision+'.md'),'utf8'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a publisher retries the owner-removal window while another process releases its directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-skill-release-')),path=join(root,'lock');
 let timer;
 try {
  await mkdir(path);
  timer=setTimeout(()=>rmSync(path,{recursive:true}),30);
  const release=await acquireWorkerSkillLock(path);release();
 }finally{clearTimeout(timer);await rm(root,{recursive:true,force:true});}
});
