// Actual CLI/plugin registration against a disposable Gateway and repositories.
// No production config, credentials, model calls or Worker execution.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,openSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const repository=fileURLToPath(new URL('../',import.meta.url));mkdirSync(resolve(repository,'.tmp'),{recursive:true});
const root=mkdtempSync(resolve(repository,'.tmp/plugin-cli-host-')),workspace=root+'/workspace';mkdirSync(workspace);
for(const file of ['SOUL.md','AGENTS.md'])writeFileSync(workspace+'/'+file,'isolated CLI fixture');
writeFileSync(workspace+'/projects.json',JSON.stringify({schemaVersion:1,projects:{}}));
execFileSync('git',['init','-b','main'],{cwd:workspace,stdio:'ignore'});
execFileSync('git',['add','SOUL.md','AGENTS.md','projects.json'],{cwd:workspace});
execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture'],{cwd:workspace,stdio:'ignore'});
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const cfg={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token:'isolated-cli-probe'}},agents:{defaults:{workspace}},plugins:{allow:['agent-repo','agent-worker'],load:{paths:[repository+'packages/agent-repo',repository+'packages/agent-worker']},entries:{'agent-repo':{enabled:true,config:{agents:{main:{repo:workspace}}}},'agent-worker':{enabled:true,config:{state:root+'/worker',codexHome:root+'/codex',cwd:workspace,asyncCompletion:true}}}}};
writeFileSync(root+'/config.json',JSON.stringify(cfg));
const env={...process.env,OPENCLAW_STATE_DIR:root+'/state',OPENCLAW_CONFIG_PATH:root+'/config.json',OPENCLAW_GATEWAY_TOKEN:'isolated-cli-probe',OPENCLAW_GATEWAY_PORT:String(port)};
const cli=process.env.PLUGIN_CLI_PROBE_OPENCLAW??'openclaw';
const run=(args,{jsonLines=false}={})=>new Promise((resolveResult,reject)=>{let out='',err='';const child=spawn(cli,args,{env});child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>{if(code!==0)return reject(Error(args.join(' ')+' failed: '+err+' '+out));try{resolveResult(jsonLines?out.trim().split('\n').map(line=>JSON.parse(line)):JSON.parse(out));}catch{reject(Error('Invalid JSON: '+out+' '+err));}});});
const child=spawn(cli,['gateway','run','--port',String(port),'--bind','loopback'],{env,stdio:['ignore',openSync(root+'/gateway.log','a'),openSync(root+'/stderr.log','a')]});
const exited=new Promise(r=>child.once('exit',r));
try{
 let ready=false;for(let i=0;i<20;i++){try{await run(['gateway','call','health','--json','--timeout','2000']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
 assert.ok(ready,'Isolated Gateway readiness; inspect '+root);
 for(const plugin of ['agent-repo','agent-worker']){const c=await run([plugin,'capabilities']);assert.equal(c.ok,true);assert.equal(c.result.pluginId,plugin);}
 const list=await run(['agent-repo','list','--agent','main','--json']);assert.equal(list.ok,true);assert.deepEqual(list.result.projects,[]);
 const projects=await run(['agent-worker','projects','--agent','main']);assert.equal(projects.ok,true);assert.deepEqual(projects.result.projects,[]);
 const queues=await run(['agent-worker','queues','--agent','main']);assert.equal(queues.ok,true);assert.ok(queues.result.queues.length);
 const management=await run(['agent-repo','manage','list','--agent','main']);assert.equal(management.ok,true);
 const tasks=await run(['agent-worker','manage','agent-tasks','--agent','main']);assert.equal(tasks.ok,true);
 const capture=await run(['agent-repo','manage','diagnostic-watch','--agent','main','--duration','1'],{jsonLines:true});assert.equal(capture.at(-1).result.stopped,true);assert.ok(capture.some(r=>r.event==='diagnostics'));
 const local=await run(['agent-repo','local','inspect','--repo',workspace]);assert.equal(local.ok,true);
 writeFileSync(root+'/params.json',JSON.stringify({}));
 assert.equal((await run(['agent-worker','queues','--agent','main','--params-file',root+'/params.json'])).ok,true);
 await assert.rejects(run(['agent-worker','run','--agent','main','--params',JSON.stringify({topic:'source-refusal',task:'never execute',context:'isolated fixture',constraints:'no execution',memory:{status:'unavailable',queries:[],items:[],reason:'isolated fixture has no memory tools'}})]),/tool execution failed/);
 assert.match(readFileSync(root+'/stderr.log','utf8'),/SOURCE_INVALID/);
 assert.deepEqual(existsSync(root+'/worker/jobs')?readdirSync(root+'/worker/jobs').filter(name=>name.endsWith('.json')):[],[]);
 await assert.rejects(run(['agent-repo','list','--agent','main','--session','agent:other:main']));
 console.log(JSON.stringify({passed:true,evidence:root,checks:['discovery','tools','management','live diagnostics','automation catalog','local inspection','parameter file','Agent rejection','unbound run rejection']}));
}finally{child.kill('SIGTERM');await exited;}
