import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import plugin,{query} from './index.mjs';
import {readJson,writeJson,requestKeyFor} from './jobs.mjs';
import {registerAgentRepoService} from './dist/agent-repo-api.mjs';

for(const behavior of ['reject','hang'])test(`Main reply persists and remains idempotent when skill refreshes ${behavior}`,async t=>{
 const state=await mkdtemp(join(tmpdir(),'worker-reply-refresh-')),root=join(state,'jobs'),scope='agent:main:review',id=randomUUID();
 let dispose,calls=0,timer;
 t.mock.method(console,'error',()=>{});
 try {
  await mkdir(join(root,'active'),{recursive:true}); // Preserve a simulated older executor; do not launch a CLI.
  plugin.register({pluginConfig:{state,cwd:state,skillsEnabled:false},registerService(){},registerTool(){}});
  dispose=registerAgentRepoService({apiVersion:1,agentId:'main',listProjects(){},inspectProject(){},prepareExecutionScope(){},prepareWorkerSkill:async()=>{calls++;if(behavior==='hang')return new Promise(()=>{});throw Error('catalog unavailable');}},{owner:{}});
  const params={action:'run',topic:'test',task:'read',context:'fixture',constraints:'read only'},question={questionId:randomUUID(),question:'Main plugin result?',reason:'continue',progress:'ready',expiresAt:Date.now()+60000};
  writeJson(join(root,id+'.json'),{jobId:id,scope:createHash('sha256').update(scope).digest('hex'),requestKey:requestKeyFor(params,scope),topic:'test',schedulerVersion:1,status:'awaiting_main',createdAt:Date.now(),project:{projectId:'test'},contextRequest:question,questions:[question]});
  writeJson(join(root,id+'.request.json'),{params,scope});
  const reply={action:'reply',jobId:id,questionId:question.questionId,answer:'confirmed'},context={agentId:'main',sessionKey:scope};
  const result=await Promise.race([query(reply,context),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('reply blocked on metadata')),2000);})]);clearTimeout(timer);
  assert.equal(JSON.parse(result.content[0].text).accepted,true);
  assert.equal(readJson(join(root,id+'.json')).questions[0].answer,'confirmed');
  assert.equal(JSON.parse((await query(reply,context)).content[0].text).accepted,true);
  assert.equal(calls,2);
  await assert.rejects(query({...reply,questionId:'invalid'},context));
  assert.equal(calls,2);
 }finally{clearTimeout(timer);dispose?.();await rm(state,{recursive:true,force:true});}
});
