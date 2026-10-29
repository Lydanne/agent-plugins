import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {resolveConfiguration,resolveQueueExecution} from './configuration.mjs';
import {defaultHermesTemplates} from './hermes-templates.mjs';
import {executeQuery} from './index.mjs';
const params={topic:'supervisor',task:'test',context:'fixture',constraints:'test processes only'};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(check){for(let n=0;n<300;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Fixture did not reach expected state');}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'supervisor-review-')),script=join(root,'cli.mjs');
 const config=resolveQueueExecution(resolveConfiguration({cwd:root,state:join(root,'state'),codexHome:join(root,'codex'),node:process.execPath,skillsEnabled:false,memoryRequired:false,hermesTemplates:{codex:{...defaultHermesTemplates.codex,command:process.execPath,args:[script,...defaultHermesTemplates.codex.args]}}}));
 return {root,script,config};
}
for(const exitCode of [0,1])test('CLI exit '+exitCode+' preserves its result and terminates lingering same-group descendants',async()=>{
 const f=fixture();let supervisorPid,descendant;
 writeFileSync(f.script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';for await(const chunk of process.stdin){};const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();writeFileSync('descendant',String(child.pid));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture complete'}}));process.exit(${exitCode});`);
 try{
  const result=executeQuery(params,{sessionKey:'isolated',onProgress:p=>{if(p.executionPid)supervisorPid=p.executionPid;}},f.config);
  if(exitCode===0)assert.equal(JSON.parse((await result).content[0].text).result,'fixture complete');
  else await assert.rejects(result);
  descendant=Number(readFileSync(join(f.root,'descendant'),'utf8'));
  await until(()=>!alive(supervisorPid)&&!alive(descendant));
 }finally{if(supervisorPid)try{process.kill(-supervisorPid,'SIGKILL');}catch{}if(descendant&&alive(descendant))try{process.kill(descendant,'SIGKILL');}catch{}rmSync(f.root,{recursive:true,force:true});}
});
test('initial progress persistence failure never starts the CLI and lets its owning process exit',async()=>{
 const f=fixture(),wrapper=join(f.root,'owner.mjs');let owner,supervisorPid;
 writeFileSync(f.script,"import{writeFileSync}from'node:fs';writeFileSync('cli-started','yes');setInterval(()=>{},1000);");
 writeFileSync(wrapper,`import{writeFileSync}from'node:fs';import{executeQuery}from ${JSON.stringify(new URL('./index.mjs',import.meta.url).href)};try{await executeQuery(${JSON.stringify(params)},{sessionKey:'isolated',onProgress:p=>{if(p.executionPid){writeFileSync(${JSON.stringify(join(f.root,'supervisor-pid'))},String(p.executionPid));throw Error('fixture persistence failed');}}},${JSON.stringify(f.config)});process.exitCode=2;}catch(error){writeFileSync(${JSON.stringify(join(f.root,'owner-result'))},error.message);}`);
 try{
  owner=spawn(process.execPath,[wrapper],{stdio:'ignore'});
  let exited=false;owner.once('exit',()=>{exited=true;});
  await until(()=>exited);
  assert.equal(owner.exitCode,0);assert.match(readFileSync(join(f.root,'owner-result'),'utf8'),/fixture persistence failed/);
  supervisorPid=Number(readFileSync(join(f.root,'supervisor-pid'),'utf8'));assert.equal(alive(supervisorPid),false);assert.equal(existsSync(join(f.root,'cli-started')),false);
 }finally{if(owner?.exitCode===null)owner.kill('SIGKILL');if(supervisorPid)try{process.kill(-supervisorPid,'SIGKILL');}catch{}rmSync(f.root,{recursive:true,force:true});}
});
