import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mainCapabilitySkill,prepareMainCapabilitySkill} from './main-capability-skill.mjs';
import {cliArguments,defaultConfiguration} from './configuration.mjs';

test('publishes one complete private skill for concurrent sessions and keeps business prompts free of its body',async()=>{
 const state=await mkdtemp(join(tmpdir(),'main-skill-'));
 try {
  const paths=await Promise.all(Array.from({length:8},()=>prepareMainCapabilitySkill(state)));
  assert.equal(new Set(paths).size,1);
  const path=paths[0];
  assert.equal(await readFile(path,'utf8'),mainCapabilitySkill);
  assert.equal((await stat(path)).mode&0o777,0o600);
  for(const options of [{},{threadId:'resumed-session'},{refresh:true}]) {
   const args=cliArguments(defaultConfiguration,{...options,mainCapabilitySkill:path});
   const instructions=JSON.parse(args.find(value=>value.startsWith('developer_instructions=')).slice('developer_instructions='.length));
   assert.ok(instructions.includes(JSON.stringify(path)));
   assert.ok(instructions.includes('先读取 Main 协作技能'));
   assert.ok(!instructions.includes(mainCapabilitySkill));
   assert.ok(!instructions.includes('questionId'));
  }
  assert.equal(await prepareMainCapabilitySkill(state),path);
  await writeFile(path,'modified contract');
  await assert.rejects(prepareMainCapabilitySkill(state),/content mismatch/);
 } finally { await rm(state,{recursive:true,force:true}); }
});
