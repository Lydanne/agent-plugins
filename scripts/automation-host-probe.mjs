// Real external-plugin execution against an isolated Gateway and deterministic local model.
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,openSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createAutomationClient} from '../packages/agent-worker/automation-client.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));mkdirSync(resolve(repo,'.tmp'),{recursive:true});
const root=mkdtempSync(resolve(repo,'.tmp/automation-host-'));mkdirSync(root+'/plugin');mkdirSync(root+'/workspace');
const fixture=readFileSync(new URL('./fixtures/automation-host-probe/index.mjs',import.meta.url),'utf8').replace("'../../../packages/agent-worker/adapters/automation.mjs'",JSON.stringify(new URL('../packages/agent-worker/adapters/automation.mjs',import.meta.url).href));
writeFileSync(root+'/plugin/index.mjs',fixture);writeFileSync(root+'/plugin/package.json',JSON.stringify({name:'automation-probe',type:'module',openclaw:{extensions:['./index.mjs']}}));
writeFileSync(root+'/plugin/openclaw.plugin.json',JSON.stringify({id:'automation-probe',name:'Isolated automation probe',configSchema:{type:'object',additionalProperties:false,properties:{}},activation:{onStartup:true},contracts:{tools:['agent_worker','agent_task_result']}}));
let calls=0;
const mock=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const body=JSON.parse(text||'{}');calls++;
 const messages=body.messages??[],last=messages.at(-1),verify=JSON.stringify(messages).includes('\\"phase\\":\\"verify\\"')||JSON.stringify(messages).includes('"phase":"verify"');
 const invoke=last?.role!=='tool';const args=verify?{outcome:'succeeded',result:{status:'ok',evidence:'isolated fixture'}}:{action:'run',projectId:'probe',repository:'projects/probe',useWorkspace:false,task:JSON.stringify(messages).includes('hold fixture')?'hold':'read',context:'fixture',constraints:'read only'};
 const delta=invoke?{role:'assistant',tool_calls:[{index:0,id:'probe-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({id:verify?'agent_task_result':'agent_worker',args})}}]}:{role:'assistant',content:'done'};
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'probe',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'probe',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));const modelPort=mock.address().port;
const reservation=tcpServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const gatewayPort=reservation.address().port;await new Promise(r=>reservation.close(r));
const cfg={gateway:{mode:'local',port:gatewayPort,bind:'loopback',auth:{mode:'token',token:'isolated-probe-token'}},agents:{defaults:{workspace:root+'/workspace',model:{primary:'probe/probe'}}},models:{providers:{probe:{baseUrl:`http://127.0.0.1:${modelPort}/v1`,apiKey:'test-only',api:'openai-completions',models:[{id:'probe',name:'Probe',contextWindow:100000,maxTokens:2000}]}}},plugins:{allow:['automation-probe'],load:{paths:[root+'/plugin']},entries:{'automation-probe':{enabled:true}}}};
writeFileSync(root+'/config.json',JSON.stringify(cfg));const env={...process.env,OPENCLAW_STATE_DIR:root+'/state',OPENCLAW_CONFIG_PATH:root+'/config.json',OPENCLAW_GATEWAY_TOKEN:'isolated-probe-token'};delete env.OPENCLAW_GATEWAY_PORT;
const launch=()=>spawn('openclaw',['gateway','run','--port',String(gatewayPort),'--bind','loopback'],{env,stdio:['ignore',openSync(root+'/gateway.log','a'),openSync(root+'/stderr.log','a')]});let child=launch();
const run=args=>new Promise((resolveResult,reject)=>{let out='',err='';const p=spawn('openclaw',args,{env});p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',code=>code===0?resolveResult(JSON.parse(out)):reject(Error('Gateway call failed '+args[2]+': '+err+'; inspect '+root)));});
const rpc=(method,params)=>run(['gateway','call',method,'--params',JSON.stringify(params),'--json','--timeout','30000']);
try{let ready=false;for(let i=0;i<20;i++){try{await rpc('health',{});ready=true;break;}catch{}await new Promise(r=>setTimeout(r,500));}assert.ok(ready,'isolated Gateway readiness');
 const client=createAutomationClient(rpc),input={version:1,agentId:'main',projectId:'probe',workflow:'read-only-probe',requestKey:'fixture',task:'read fixture',context:'isolated',constraints:'read only',useWorkspace:false};
 const [a,b]=await Promise.all([client.submit({...input,attempt:'1'}),client.submit({...input,attempt:'2'})]);assert.equal(a.taskId,b.taskId);
 const result=await client.wait(a.taskId,{timeoutMs:90000,intervalMs:1000});assert.equal(result.state,'completed');assert.equal(result.result.result.status,'ok');assert.ok(result.jobId);
 const again=await client.submit({...input,attempt:'3'});assert.equal(again.jobId,result.jobId);
 const hold=await client.submit({...input,requestKey:'hold',task:'hold fixture'});
 let held;for(let i=0;i<20;i++){held=await client.get(hold.taskId);if(held.jobId)break;await new Promise(r=>setTimeout(r,500));}assert.ok(held.jobId,'held worker admitted');
 // Hot reload must preserve the durable task and its single existing worker.
 await run(['plugins','reload','automation-probe','--json']);
 assert.equal((await client.get(held.taskId)).jobId,held.jobId);
 const afterReload=await client.submit({...input,requestKey:'after-hot-reload'});
 const reloadedResult=await client.wait(afterReload.taskId,{timeoutMs:90000,intervalMs:1000});assert.equal(reloadedResult.state,'completed','new Main turns after hot reload use host scheduler admission');
 const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await stopped;child=launch();
 for(let i=0;i<20;i++){try{await rpc('health',{});break;}catch{}await new Promise(r=>setTimeout(r,500));}
 assert.equal((await client.get(held.taskId)).jobId,held.jobId,'Gateway restart retains original worker');
 let deleted=false;const deletion=rpc('sessions.delete',{key:held.sessionKey}).then(r=>{writeFileSync(root+'/deletion.json',JSON.stringify(r));deleted=r.deleted!==false;return r;});
 await new Promise(r=>setTimeout(r,2000));assert.equal(deleted,false,'active task protects Main session');
 await client.cancel(held.taskId);const cancelled=await client.wait(held.taskId,{timeoutMs:30000,intervalMs:500});assert.equal(cancelled.state,'cancelled');
 await deletion;assert.equal((await client.get(held.taskId)).state,'cancelled','ledger survives chat deletion');
 writeFileSync(root+'/result.json',JSON.stringify({passed:true,calls,taskId:result.taskId,jobId:result.jobId}));console.log(JSON.stringify({passed:true,calls,evidence:root}));
}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));mock.close();}
