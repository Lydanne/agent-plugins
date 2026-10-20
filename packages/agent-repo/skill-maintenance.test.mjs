import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createSkillMaintenance} from './skill-maintenance.mjs';
import {publishWorkerSkill} from './worker-skill.mjs';
import {registerAgentRepoService} from './dist/agent-repo-api.mjs';
const ctx={agentId:'main',sessionKey:'agent:main:maintenance',client:{scopes:['operator.read','operator.write']}};
test('Main skill inspection is read-only, first generation works, partial entrypoints and corrupt revisions stay distinct',async()=>{
 const root=await mkdtemp(join(tmpdir(),'main-maintenance-'));
 let dispose;
 try{
  const api=createSkillMaintenance(()=>({plugins:{entries:{'agent-worker':{config:{codexHome:root}}}}}));
  dispose=registerAgentRepoService({apiVersion:1,agentId:'main',root,listProjects(){},inspectProject(){},prepareExecutionScope(){},prepareWorkerSkill:()=>publishWorkerSkill(root,'main','committed fixture')},{owner:{}});
  const before=await api.snapshot(ctx);assert.equal(before.state,'not_installed');
  const input={providerId:'agent-repo.main-skill',action:'regenerate',confirmed:true,requestId:randomUUID(),expectedRevision:before.revision};
  const operation=await api.run(ctx,input);
  for(let i=0;i<50;i++){if((await api.snapshot(ctx)).history[0]?.status==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,10));}
  const after=await api.snapshot(ctx);assert.equal(after.state,'available');assert.equal(after.history[0].status,'succeeded');
  assert.equal((await api.run(ctx,input)).id,operation.id);
  await assert.rejects(api.run({...ctx,client:{scopes:['operator.read']}},input));
  await assert.rejects(api.run(ctx,{...input,requestId:randomUUID()}),/状态已变化/);
  const directory=join(root,'skills/openclaw-main-main');await writeFile(join(directory,'SKILL.md'),'interrupted update');
  const partial=await api.snapshot(ctx);assert.equal(partial.state,'available');assert.equal(partial.body,'committed fixture');assert.match(partial.fields.find(f=>f.label==='入口状态').value,/未提交/);
  const marker=JSON.parse(await readFile(join(directory,'.agent-repo.json'),'utf8'));await writeFile(join(directory,'revisions',marker.revision+'.md'),'tamper');assert.equal((await api.snapshot(ctx)).state,'unavailable');
 }finally{dispose?.();await rm(root,{recursive:true,force:true});}
});
