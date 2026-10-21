import {test} from 'node:test';
import assert from 'node:assert/strict';
import {refreshSkillSession,skillRefreshPlan,revisionOf,readSkillVersion,skillTaskContext} from './skill-refresh.mjs';
import {mkdtemp,mkdir,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const v=n=>({protocol:1,root:'/fixture',skills:hash(n),roles:hash('role'),catalog:['skills/a/SKILL.md'],skillEntries:[n]});
test('updates changed content and dependencies; deletion and role changes migrate',()=>{
 assert.equal(skillRefreshPlan(v('1'),v('1')).needsUpdate,false);
 assert.equal(skillRefreshPlan(v('1'),v('2')).migrate,false);
 assert.equal(skillRefreshPlan(v('1'),{...v('2'),catalog:[]}).migrate,true);
 assert.equal(skillRefreshPlan(v('1'),{...v('1'),roles:hash('new role')}).migrate,true);
 assert.equal(skillRefreshPlan(undefined,v('1')).needsUpdate,true);
});
test('refreshes before business execution, acknowledges exact pinned version only',async()=>{
 const order=[],current=v('2');let applied;
 await refreshSkillSession({previous:v('1'),current,runTurn:async(prompt,options)=>{
  order.push('refresh');assert.equal(options.refresh,true);const input=JSON.parse(prompt);
  assert.deepEqual(input.changed,['skills/a/SKILL.md']);assert.equal(input.task,undefined);
  return JSON.stringify({status:'catalog_applied',revision:input.revision});
 },onApplied:async s=>{applied=s;order.push('persist');}});
 order.push('business failed');
 assert.deepEqual(order,['refresh','persist','business failed']);assert.equal(revisionOf(applied),revisionOf(current));
 assert.equal(skillRefreshPlan(applied,v('3')).needsUpdate,true);
});
test('bad acknowledgement and cancellation never advance state; unchanged skips refresh',async()=>{
 for(const result of ['not JSON',JSON.stringify({status:'catalog_applied',revision:'wrong'})]) {
  let saved=false;await assert.rejects(refreshSkillSession({current:v('1'),runTurn:async()=>result,onApplied:async()=>{saved=true;}}));assert.equal(saved,false);
 }
 const controller=new AbortController();let saved=false;
 await assert.rejects(refreshSkillSession({current:v('1'),signal:controller.signal,runTurn:async()=>{controller.abort();return JSON.stringify({status:'catalog_applied',revision:revisionOf(v('1'))});},onApplied:async()=>{saved=true;}}));assert.equal(saved,false);
 assert.equal(await refreshSkillSession({previous:v('1'),current:v('1'),runTurn:()=>{throw Error('must not run');}}),false);
});
test('reads atomically published per-workspace metadata and rejects corruption or wrong root',async()=>{
 const state=await mkdtemp(join(tmpdir(),'skills-refresh-'));
 try{await mkdir(join(state,'skill-versions'));const file=join(state,'skill-versions',hash('/fixture')+'.json');
  await writeFile(file,JSON.stringify(v('1')));assert.deepEqual(await readSkillVersion(state,'/fixture'),v('1'));
  await writeFile(file,JSON.stringify({...v('1'),skillEntries:['tampered']}));await assert.rejects(readSkillVersion(state,'/fixture'));
  await assert.rejects(readSkillVersion(state,'/other'));
 }finally{await rm(state,{recursive:true,force:true});}
});

import {executeQuery,executionPolicyVersion} from './index.mjs';
test('executor resumes after refresh, persists ack before business failure, and flags later publication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'skills-executor-'));
 try{
  const state=join(root,'state'),cwd=root,cli=join(root,'fake CLI.mjs');
  await mkdir(join(state,'skill-versions'),{recursive:true});
  const snapshot={...v('1'),root};const publish=s=>writeFile(join(state,'skill-versions',hash(root)+'.json'),JSON.stringify(s));await publish(snapshot);
  // Fake CLI protocol only; no model calls, real host credentials or business operations.
  await writeFile(cli,`#!${process.execPath}
const fs=await import('node:fs');const modeFile=${JSON.stringify(join(root,'mode'))};const mode=fs.existsSync(modeFile)?JSON.parse(fs.readFileSync(modeFile,'utf8')):{};let text='';for await(const part of process.stdin)text+=part;
const prompt=JSON.parse(text);const args=process.argv.slice(2);
if(args[args.indexOf('--model')+1]!=='gpt-6.1-sol' || !args.includes('model_reasoning_effort="low"'))process.exit(7);
const id=args.includes('resume')?args[args.indexOf('resume')+1]:(await import('node:crypto')).randomUUID();
const developer=JSON.parse(args.find(x=>x.startsWith('developer_instructions=')).slice('developer_instructions='.length));
if(developer.includes('Main 协作技能') || prompt.contextRequestInstructions || prompt.pluginCapabilityInstructions)process.exit(11);
const developerFile=${JSON.stringify(join(root,'developer-'))}+id;
if(fs.existsSync(developerFile) && fs.readFileSync(developerFile,'utf8')!==developer)process.exit(8);
fs.writeFileSync(developerFile,developer);
if(developer.includes('本轮仅确认技能索引，禁止工具调用和业务执行。') || !developer.includes('执行阶段只由当前输入的 kind 决定'))process.exit(9);
console.log(JSON.stringify({type:'thread.started',thread_id:id}));
if(prompt.kind==='skill_catalog_refresh'){
 if(!args.includes('read-only'))process.exit(3);
 if(mode.tool)console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',exit_code:0}}));
 if(mode.bump)fs.writeFileSync(${JSON.stringify(join(state,'skill-versions',hash(root)+'.json'))},JSON.stringify(mode.bump));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'catalog_applied',revision:mode.bad?'wrong':prompt.revision})}}));
}else{
 if(!args.includes('resume')||!prompt.skills||prompt.kind!=='business_task')process.exit(4);
 if(prompt.task==='memory-check' && (prompt.memory?.status!=='matched' || prompt.memory.items[0].source!=='memory/fixture.md:1' || !prompt.memoryPolicy))process.exit(5);
 if(!prompt.memory || !prompt.experienceInstructions)process.exit(6);
 if(prompt.task==='fail')process.exit(1);
 console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',exit_code:0}}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:prompt.task==='experience-check'?JSON.stringify({protocol:'codex_result_v1',result:'business complete',experienceCandidates:[{lesson:'fixture lesson',applicability:'fixture v1',evidence:['report.md:1'],verification:'unverified',invalidation:'version change'}]}):'business complete'}}));
}`);
  await chmod(cli,0o700);
  const runtime={state,cwd,cli},context={sessionKey:'trusted-test'},params={action:'run',topic:'one',task:'fail',context:'evidence',constraints:'read only'};
  const file=join(state,hash(context.sessionKey)+'.json');
  const legacyId='00000000-0000-0000-0000-000000000004';
  await writeFile(file,JSON.stringify({one:{topic:'one',sessionId:legacyId,cwd,executionPolicyVersion:4,skillsSnapshot:snapshot}}));
  const before=JSON.parse((await executeQuery({action:'list'},context,runtime)).content[0].text);
  assert.equal(before.tasks[0].needsMigration,true);
  await assert.rejects(executeQuery(params,context,runtime));
  const {readFile}=await import('node:fs/promises');let entry=Object.values(JSON.parse(await readFile(file,'utf8'))).find(entry=>entry.topic==='one');
  assert.notEqual(entry.sessionId,legacyId);assert.ok(entry.previousSessionIds.includes(legacyId));
  assert.equal(revisionOf(entry.skillsSnapshot),revisionOf(snapshot));assert.equal(entry.skillsRefreshFailed,false);
  const result=await executeQuery({...params,task:'success'},context,runtime);
  assert.equal(JSON.parse(result.content[0].text).reused,true);
  assert.deepEqual(JSON.parse(result.content[0].text).commands,[{exitCode:0}]);
  assert.equal(JSON.parse(result.content[0].text).model,'gpt-6.1-sol');
  assert.equal(JSON.parse(result.content[0].text).memoryReview.status,'not_searched');
  const learned=JSON.parse((await executeQuery({...params,task:'experience-check'},context,runtime)).content[0].text);
  assert.equal(learned.result,'business complete');assert.equal(learned.experienceReview.status,'pending');assert.equal(learned.experienceReview.persisted,false);
  assert.equal(learned.experienceReview.candidates[0].verification,'unverified');
  const memory={status:'matched',queries:['fixture'],items:[{summary:'旧经验',source:'memory/fixture.md:1',applicability:'测试任务',observedAt:null,verification:'historical_unverified'}]};
  const withMemory=await executeQuery({...params,task:'memory-check',memory},context,runtime);
  assert.equal(JSON.parse(withMemory.content[0].text).reused,true);
  assert.equal(JSON.parse(withMemory.content[0].text).memoryReview.status,'matched');
  await publish({...snapshot,skills:hash('2'),skillEntries:['2']});
  const list=await executeQuery({action:'list'},context,runtime);
  assert.equal(JSON.parse(list.content[0].text).tasks[0].needsSkillsUpdate,true);
  await executeQuery({...params,task:'success'},context,runtime);
  entry=Object.values(JSON.parse(await readFile(file,'utf8'))).find(entry=>entry.topic==='one');assert.equal(entry.executionPolicyVersion,executionPolicyVersion);assert.equal(entry.skillsSnapshot.skills,hash('2'));
  await publish({...snapshot,skills:hash('3'),skillEntries:['3']});await writeFile(join(root,'mode'),JSON.stringify({bad:true}));
  await assert.rejects(executeQuery({...params,task:'success'},context,runtime),/acknowledgement mismatch/);
  entry=Object.values(JSON.parse(await readFile(file,'utf8'))).find(entry=>entry.topic==='one');assert.equal(entry.skillsSnapshot.skills,hash('2'));assert.equal(entry.skillsRefreshFailed,true);
  await writeFile(join(root,'mode'),JSON.stringify({tool:true}));
  await assert.rejects(executeQuery({...params,task:'success'},context,runtime),/Skill refresh attempted a tool action/);
  const failedSession=Object.values(JSON.parse(await readFile(file,'utf8'))).find(entry=>entry.topic==='one').sessionId;await rm(join(root,'mode'));
  await executeQuery({...params,task:'success'},context,runtime);
  entry=Object.values(JSON.parse(await readFile(file,'utf8'))).find(entry=>entry.topic==='one');assert.notEqual(entry.sessionId,failedSession);assert.ok(entry.previousSessionIds.includes(failedSession));
  await publish({...snapshot,skills:hash('4'),skillEntries:['4']});
  await writeFile(join(root,'mode'),JSON.stringify({bump:{...snapshot,skills:hash('5'),skillEntries:['5']}}));
  await assert.rejects(executeQuery({...params,task:'success'},context,runtime),/Skills changed during refresh/);
  entry=Object.values(JSON.parse(await readFile(file,'utf8'))).find(entry=>entry.topic==='one');assert.equal(entry.skillsSnapshot.skills,hash('4'));
  assert.equal(JSON.parse((await executeQuery({action:'list'},context,runtime)).content[0].text).tasks[0].needsSkillsUpdate,true);
  await rm(join(root,'mode')); // concurrent topics share a binding file, not an execution lock
  await Promise.all(['parallel-a','parallel-b','parallel-c'].map(topic=>executeQuery({...params,topic,task:'success'},context,runtime)));
  const bindings=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(Object.values(bindings).map(entry=>entry.topic).sort(),['one','parallel-a','parallel-b','parallel-c']);
  assert.equal(new Set(Object.values(bindings).map(entry=>entry.sessionId)).size,4);


 }finally{await rm(root,{recursive:true,force:true});}
});

test('combined skill snapshot uses the explicit Agent root and keeps the project prefix',async t=>{
 const state=await mkdtemp(join(tmpdir(),'combined-skills-'));t.after(()=>rm(state,{recursive:true,force:true}));await mkdir(join(state,'skill-versions'));
 const root='/agent',snapshot={protocol:1,root,skills:hash('entry'),roles:hash('role'),catalog:['skills/a/SKILL.md','project/.agents/skills/business/SKILL.md'],skillEntries:['entry']};
 await writeFile(join(state,'skill-versions',hash(root)+'.json'),JSON.stringify(snapshot));
 const loaded=await readSkillVersion(state,root,['skills','project/.agents/skills']);assert.deepEqual(skillTaskContext(loaded).catalog,snapshot.catalog);assert.equal(skillTaskContext(loaded).root,root);
 await assert.rejects(readSkillVersion(state,'/agent/project',['skills','.agents/skills']));await assert.rejects(readSkillVersion(state,root,['skills']));
});


test('reviewed continuation is exact-session and exact-revision only and cannot retain removed skills',async()=>{
 const {reviewedContinuationMatches,revisionOf}=await import('./skill-refresh.mjs');
 const previous={skills:'old',roles:'old',catalog:['skills/a/SKILL.md']},current={skills:'new',roles:'new',catalog:['skills/a/SKILL.md']};
 const review={sessionId:'original',previousRevision:revisionOf(previous),currentRevision:revisionOf(current),reason:'administrator reviewed'};
 assert.equal(reviewedContinuationMatches(review,'original',previous,current),true);
 for(const value of [undefined,{...review,sessionId:'other'},{...review,previousRevision:'wrong'},{...review,currentRevision:'wrong'}])assert.equal(reviewedContinuationMatches(value,'original',previous,current),false);
 assert.equal(reviewedContinuationMatches(review,undefined,previous,current),false);
 assert.equal(reviewedContinuationMatches({...review,currentRevision:revisionOf({...current,catalog:[]})},'original',previous,{...current,catalog:[]}),false);
});
