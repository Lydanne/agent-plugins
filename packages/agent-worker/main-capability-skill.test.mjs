import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {mainSkillNotice} from './main-capability-skill.mjs';
import {executeQuery} from './index.mjs';
import {requestKeyFor} from './jobs.mjs';

async function skill(root,body){const path=join(root,'skills/openclaw-main-main/SKILL.md'),revision=createHash('sha256').update(body).digest('hex'),revisionPath=join(root,'skills/openclaw-main-main/revisions',revision+'.md');await mkdir(join(root,'skills/openclaw-main-main/revisions'),{recursive:true});await writeFile(path,body);await writeFile(revisionPath,body);await writeFile(join(root,'skills/openclaw-main-main/.agent-repo.json'),JSON.stringify({owner:'agent-repo',agentId:'main',revision}));return {name:'openclaw-main-main',agentId:'main',path,revision,revisionPath};}
test('load/reuse/reload use pinned Agent Repo versions and reject tampering or cross-Agent descriptors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-skill-consumer-'));
 try {
  const a=await skill(root,'protocol v1');
  assert.equal((await mainSkillNotice(a,undefined,'main')).action,'load');
  assert.equal((await mainSkillNotice(a,a.revision,'main')).action,'reuse');
  const b=await skill(root,'protocol v2');
  assert.equal((await mainSkillNotice(a,a.revision,'main')).action,'reload');
  await assert.rejects(mainSkillNotice(a,undefined,'other'),/descriptor/);
  await writeFile(b.revisionPath,'modified');await assert.rejects(mainSkillNotice(a,undefined,'main'),/revision mismatch/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('real session reuse notifies version changes in delegated tasks, never in developer instructions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-global-skill-'));
 try {
  const cli=join(root,'fake.mjs');await writeFile(cli,`#!${process.execPath}\nimport{appendFileSync}from'node:fs';import{randomUUID}from'node:crypto';let text='';for await(const c of process.stdin)text+=c;const p=JSON.parse(text),args=process.argv.slice(2);appendFileSync('seen.jsonl',JSON.stringify({p,args})+'\\n');if(p.task==='fail')process.exit(1);console.log(JSON.stringify({type:'thread.started',thread_id:args.includes('resume')?args[args.indexOf('resume')+1]:randomUUID()}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));`);await chmod(cli,0o700);
  const config={state:join(root,'state'),cwd:root,codexHome:root,cli,skillsEnabled:false,memoryRequired:false,projectContext:{agentId:'main'},mainCapabilitySkill:await skill(root,'first protocol')};
  const params={action:'run',topic:'same',task:'read',context:'none',constraints:'read only',responsibility:'只读诊断'};
  const decode=r=>JSON.parse(r.content[0].text);
  const a=decode(await executeQuery(params,{sessionKey:'chat'},config));
  const b=decode(await executeQuery(params,{sessionKey:'chat'},config));assert.equal(a.sessionId,b.sessionId);
  config.mainCapabilitySkill=await skill(root,'updated plugin list');
  await assert.rejects(executeQuery({...params,task:'fail'},{sessionKey:'chat'},config));
  const c=decode(await executeQuery(params,{sessionKey:'chat'},config));assert.equal(c.sessionId,a.sessionId);
  const seen=(await readFile(join(root,'seen.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(seen.map(s=>s.p.collaborationSkill.action),['load','reuse','reload','reload']);
  for(const {p,args} of seen){assert.equal(p.responsibility,'只读诊断');assert.ok(!args.join(' ').includes('openclaw-main-main'));assert.ok(!p.pluginCapabilityInstructions);}
  assert.notEqual(requestKeyFor(params,'chat'),requestKeyFor({...params,responsibility:'另一项职责'},'chat'));
 }finally{await rm(root,{recursive:true,force:true});}
});
