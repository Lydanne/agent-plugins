// Actual CLI/plugin registration against a disposable Gateway and repositories.
// No production config, credentials, model calls or Worker execution.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,openSync,readFileSync,readdirSync,existsSync,cpSync,symlinkSync} from 'node:fs';
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
// Freeze the plugin sources before starting the host so subsequent edits cannot
// race the Gateway source-digest guard or alter this probe's acceptance boundary.
const release=root+'/release/packages';mkdirSync(release,{recursive:true});
for(const name of ['agent-repo','agent-worker']){
 const source=repository+'packages/'+name,target=release+'/'+name;
 cpSync(source,target,{recursive:true,filter:path=>!path.split('/').includes('node_modules')});
 symlinkSync(source+'/node_modules',target+'/node_modules','dir');
}
const cfg={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token:'isolated-cli-probe'}},agents:{defaults:{workspace}},plugins:{allow:['agent-repo','agent-worker'],load:{paths:[release+'/agent-repo',release+'/agent-worker']},entries:{'agent-repo':{enabled:true,config:{agents:{main:{repo:workspace}}}},'agent-worker':{enabled:true,config:{state:root+'/worker',codexHome:root+'/codex',cwd:workspace,asyncCompletion:true}}}}};
const fixture=root+'/worker-cli-fixture';mkdirSync(fixture);
const job={jobId:'11111111-1111-4111-8111-111111111111',workerId:'22222222-2222-4222-8222-222222222222',status:'running',provenance:{agentId:'main',sessionKey:'agent:main:main',senderId:'original-requester',accountId:'fixture-account',chatId:'fixture-group',taskId:'fixture-source',revision:1,policyContext:{version:1,channel:'feishu',senderName:'Fixture User',memberRoleIds:[]}}};
writeFileSync(root+'/bound-job.json',JSON.stringify(job));
writeFileSync(fixture+'/package.json',JSON.stringify({name:'worker-cli-fixture',type:'module',openclaw:{extensions:['./index.mjs']}}));
writeFileSync(fixture+'/openclaw.plugin.json',JSON.stringify({id:'worker-cli-fixture',activation:{onStartup:true},contracts:{tools:['fixture_worker_read']},configSchema:{type:'object',properties:{}}}));
writeFileSync(fixture+'/index.mjs',`import{readFileSync,writeFileSync}from'node:fs';import{workerContextApi,createWorkerCliService,workerCliEnvironment,prepareWorkerCliOptions}from ${JSON.stringify(release+'/agent-worker/dist/worker-cli.mjs')};import{connectCli}from ${JSON.stringify(release+'/agent-worker/dist/plugin-cli.mjs')};export default{id:'worker-cli-fixture',register(api){if(api.registrationMode==='cli-metadata')return;api=workerContextApi(api);api.on('before_tool_call',(event,ctx)=>{if(ctx.runId!==${JSON.stringify(job.workerId)})return;writeFileSync(${JSON.stringify(root+'/hook.json')},JSON.stringify({senderId:ctx.requester?.senderId,owner:ctx.requester?.senderIsOwner,args:event.params}));if(event.params.value==='hook-block')return{block:true,blockReason:'fixture policy'};if(event.params.value==='account-change')return{params:{accountId:'another-account'}};if(event.params.value==='admin-change')return{params:{action:'sync'}};});api.registerTool(ctx=>({name:'fixture_worker_read',description:'isolated task context probe',parameters:{type:'object',properties:{value:{type:'string'}},additionalProperties:false},execute:async(id,args)=>({content:[{type:'text',text:JSON.stringify({value:args.value,requester:ctx.requesterSenderId,workerContext:ctx.workerContext})}]})}));const read=()=>JSON.parse(readFileSync(${JSON.stringify(root+'/bound-job.json')},'utf8'));const service=createWorkerCliService({connect:connectCli,getConfig:()=>api.config,getJob:read,prepareContext:(b,c)=>prepareWorkerCliOptions(api,b,c),authorize:()=>true});api.registerService({id:'worker-cli-fixture',start:async()=>{await service.start();const lease=service.issue(read(),{params:{task:'fixture read',context:'authorized fixture context',constraints:'read only'},runtime:{}});writeFileSync(${JSON.stringify(root+'/worker-env.json')},JSON.stringify(workerCliEnvironment(lease)),{mode:384});},stop:()=>service.stop()});}};`);
cfg.plugins.allow.push('worker-cli-fixture');cfg.plugins.load.paths.push(fixture);cfg.plugins.entries['worker-cli-fixture']={enabled:true,hooks:{allowConversationAccess:true}};
writeFileSync(root+'/config.json',JSON.stringify(cfg));
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^OPENCLAW_(?:WORKER_.*|JOB_ID)$/.test(key))),OPENCLAW_STATE_DIR:root+'/state',OPENCLAW_CONFIG_PATH:root+'/config.json',OPENCLAW_GATEWAY_TOKEN:'isolated-cli-probe',OPENCLAW_GATEWAY_PORT:String(port)};
const cli=process.env.PLUGIN_CLI_PROBE_OPENCLAW??'openclaw';
const run=(args,{jsonLines=false,workerEnv}={})=>new Promise((resolveResult,reject)=>{let out='',err='';const child=spawn(cli,args,{env:workerEnv?{...env,...workerEnv,OPENCLAW_GATEWAY_TOKEN:''}:env});child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>{if(code!==0)return reject(Error(args.join(' ')+' failed: '+err+' '+out));try{resolveResult(jsonLines?out.trim().split('\n').map(line=>JSON.parse(line)):JSON.parse(out));}catch{reject(Error('Invalid JSON: '+out+' '+err));}});});
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
 const workerEnv=JSON.parse(readFileSync(root+'/worker-env.json','utf8'));
 const context=await run(['agent-worker','context'],{workerEnv});assert.equal(context.result.context,'authorized fixture context');assert.equal(context.result.jobId,job.jobId);
 const capabilities=await run(['agent-worker','plugin','list'],{workerEnv});assert.ok(capabilities.result.plugins.some(p=>p.tools?.some(t=>t.name==='fixture_worker_read'&&t.taskBound)));
 const description=await run(['agent-worker','plugin','describe','--tool','fixture_worker_read'],{workerEnv});assert.equal(description.result.parameters.properties.value.type,'string');
 const direct=await run(['agent-worker','plugin','call','--tool','fixture_worker_read','--params','{"value":"bound"}'],{workerEnv});assert.equal(direct.result.requester,'original-requester');assert.equal(direct.result.workerContext.jobId,job.jobId);assert.equal(direct.result.value,'bound');
 const hook=JSON.parse(readFileSync(root+'/hook.json','utf8'));assert.equal(hook.senderId,'original-requester');assert.equal(hook.owner,false);assert.deepEqual(hook.args,{value:'bound'});
 for(const value of ['hook-block','account-change'])await assert.rejects(run(['agent-worker','plugin','call','--tool','fixture_worker_read','--params',JSON.stringify({value})],{workerEnv}));
 assert.equal((await run(['agent-repo','list'],{workerEnv})).ok,true);
 await assert.rejects(run(['agent-repo','list','--agent','other'],{workerEnv}));
 await assert.rejects(run(['agent-worker','manage','agent-tasks'],{workerEnv}));
 writeFileSync(root+'/bound-job.json',JSON.stringify({...job,status:'cancelled'}));
 await assert.rejects(run(['agent-worker','plugin','call','--tool','fixture_worker_read','--params','{"value":"denied"}'],{workerEnv}));
 const local=await run(['agent-repo','local','inspect','--repo',workspace]);assert.equal(local.ok,true);
 writeFileSync(root+'/params.json',JSON.stringify({}));
 assert.equal((await run(['agent-worker','queues','--agent','main','--params-file',root+'/params.json'])).ok,true);
 await assert.rejects(run(['agent-worker','run','--agent','main','--params',JSON.stringify({topic:'source-refusal',task:'never execute',context:'isolated fixture',constraints:'no execution',memory:{status:'unavailable',queries:[],items:[],reason:'isolated fixture has no memory tools'}})]),/tool execution failed/);
 assert.match(readFileSync(root+'/stderr.log','utf8'),/SOURCE_INVALID/);
 assert.deepEqual(existsSync(root+'/worker/jobs')?readdirSync(root+'/worker/jobs').filter(name=>name.endsWith('.json')):[],[]);
 await assert.rejects(run(['agent-repo','list','--agent','main','--session','agent:other:main']));
 console.log(JSON.stringify({passed:true,evidence:root,checks:['discovery','tools','management','live diagnostics','automation catalog','local inspection','parameter file','Agent rejection','unbound run rejection','bound Worker context','direct plugin schema and invocation','dedicated CLI inheritance','Worker scope and cancellation rejection']}));
}finally{child.kill('SIGTERM');await exited;}
