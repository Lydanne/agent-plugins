// Isolated actual host/hooks, deterministic model, no production state or business tools.
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,openSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const repo=resolve('.'),root=mkdtempSync(resolve('.tmp/repo-gate-host-')),workspace=root+'/workspace';mkdirSync(workspace);mkdirSync(workspace+'/skills/probe',{recursive:true});
const skill='---\nname: probe\ndescription: fixture\n---\nDo not call tools.\n';
writeFileSync(workspace+'/skills/probe/SKILL.md',skill);writeFileSync(workspace+'/AGENTS.md','Isolated fixture. Reply OK; never execute tools.');
for(const name of ['SOUL.md','IDENTITY.md','USER.md'])writeFileSync(workspace+'/'+name,'Fixture role.');
writeFileSync(workspace+'/projects.json',JSON.stringify({schemaVersion:1,projects:Object.fromEntries(['one','two'].map(id=>[id,{name:id,url:'https://example.invalid/'+id+'.git',branch:'main',repository:'projects/'+id,skills:[]}]))}));
const git=args=>execFileSync('git',['-C',workspace,...args],{stdio:'pipe'});git(['init','-b','main']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','fixture']);
let calls=0;const mock=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}})+'\n\ndata: [DONE]\n\n');});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));const reserve=tcpServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const cfg={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token:'fixture-gate-token'}},agents:{defaults:{workspace,model:{primary:'probe/fixture'}},entries:{main:{workspace}}},models:{providers:{probe:{baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'fixture-only',api:'openai-completions',models:[{id:'fixture',name:'Fixture',contextWindow:100000,maxTokens:2000}]}}},plugins:{allow:['agent-repo'],load:{paths:[repo+'/packages/agent-repo']},entries:{'agent-repo':{enabled:true,hooks:{allowConversationAccess:true,allowPromptInjection:true},config:{agents:{main:{repo:workspace,sync:{enabled:true}}}}}}}};
writeFileSync(root+'/config.json',JSON.stringify(cfg));const env={...process.env,OPENCLAW_STATE_DIR:root+'/state',OPENCLAW_CONFIG_PATH:root+'/config.json',OPENCLAW_GATEWAY_TOKEN:'fixture-gate-token'};delete env.OPENCLAW_GATEWAY_PORT;
const child=spawn('openclaw',['gateway','run','--port',String(port),'--bind','loopback'],{env,stdio:['ignore',openSync(root+'/gateway.log','a'),openSync(root+'/stderr.log','a')]});
const rpc=(method,params={},final=false)=>new Promise((res,rej)=>{let out='',err='';const p=spawn('openclaw',['gateway','call',method,'--params',JSON.stringify(params),'--json','--timeout','30000',...(final?['--expect-final']:[])],{env});p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',rej);p.on('exit',code=>{try{code===0?res(JSON.parse(out)):rej(Error(err+' '+out));}catch(e){rej(e);}});});
try{
 let ready=false;for(let i=0;i<20;i++){try{await rpc('health');ready=true;break;}catch{}await new Promise(r=>setTimeout(r,300));}assert.ok(ready);
 const run=()=>rpc('agent',{agentId:'main',sessionKey:'agent:main:gate-probe',message:'Reply OK. Do not call tools.',deliver:false,idempotencyKey:randomUUID()},true);
 const first=await run();writeFileSync(root+'/first.json',JSON.stringify(first));assert.equal(calls,1,'valid prompt should reach deterministic model');
 writeFileSync(workspace+'/skills/probe/SKILL.md',skill+'uncommitted');
 let blocked;try{blocked=await run();}catch(e){blocked={error:String(e)};}writeFileSync(root+'/blocked.json',JSON.stringify(blocked));assert.equal(calls,1,'dirty skill blocked before model');assert.match(JSON.stringify(blocked),/AGENT_REPO_SKILLS_UNCOMMITTED/);
 writeFileSync(workspace+'/skills/probe/SKILL.md',skill);const next=await run();writeFileSync(root+'/next.json',JSON.stringify(next));assert.equal(calls,2,'new clean run is not poisoned');
 console.log(JSON.stringify({passed:true,modelCalls:calls,businessCalls:0,evidence:root}));
}finally{const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await stopped;mock.close();}
