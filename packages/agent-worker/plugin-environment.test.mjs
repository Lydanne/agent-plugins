import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {workerEnvironment} from './plugin-environment.mjs';

test('both worker process boundaries preserve independent CLI access but remove host plugin credentials',()=>{
 const source={PATH:process.env.PATH,CODEX_HOME:'/tmp/codex-fixture',OPENCLAW_STATE_DIR:'/tmp/state-fixture',
  FEISHU_APP_SECRET:'fixture-private-secret',FEISHU_APP_ID:'cli_fixture',LARK_APP_SECRET:'fixture-host-secret',
  LARKSUITE_CLI_USER_ACCESS_TOKEN:'fixture-cli-token',LARKSUITE_CLI_TENANT_ACCESS_TOKEN:'fixture-cli-bot-token',
  LARKSUITE_CLI_CONFIG_DIR:'/tmp/cli-fixture',LARKSUITE_CLI_AUTH_PROXY:'http://127.0.0.1:1',
  LARKSUITE_CLI_PROFILE:'operator',OPENCLAW_GATEWAY_TOKEN:'fixture-gateway',OPENCLAW_GATEWAY_PASSWORD:'fixture-password'};
 const env=workerEnvironment(workerEnvironment(source));
 assert.equal(source.FEISHU_APP_SECRET,'fixture-private-secret');
 const expected={...source};
 for(const key of ['FEISHU_APP_SECRET','FEISHU_APP_ID','LARK_APP_SECRET','OPENCLAW_GATEWAY_TOKEN','OPENCLAW_GATEWAY_PASSWORD'])delete expected[key];
 assert.deepEqual(env,expected);
 const output=execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify({secret:!!process.env.FEISHU_APP_SECRET,token:process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,profile:process.env.LARKSUITE_CLI_PROFILE,gateway:!!process.env.OPENCLAW_GATEWAY_TOKEN,codex:process.env.CODEX_HOME}))'],{env,encoding:'utf8'});
 assert.deepEqual(JSON.parse(output),{secret:false,token:'fixture-cli-token',profile:'operator',gateway:false,codex:'/tmp/codex-fixture'});
});

test('stale Worker identities and task credentials cannot leak into a different execution',()=>{
 const env=workerEnvironment({PATH:'/bin',OPENCLAW_WORKER_ID:'old',OPENCLAW_JOB_ID:'old-job',OPENCLAW_WORKER_CONTEXT:'old-context',OPENCLAW_WORKER_CLI_URL:'old-url',OPENCLAW_WORKER_CLI_TOKEN:'old-token'});
 assert.deepEqual(env,{PATH:'/bin'});
});

test('Codex CLI shell commands inherit host-injected execution identity and context',async()=>{
 const {mkdtemp,writeFile,chmod,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {executeQuery}=await import('./index.mjs');
 const root=await mkdtemp(join(tmpdir(),'worker-cli-environment-'));
 try{
  const cli=join(root,'codex.mjs');
  await writeFile(cli,`#!${process.execPath}\nimport{execFileSync}from'node:child_process';let input='';for await(const c of process.stdin)input+=c;const p=JSON.parse(input);const env=JSON.parse(execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify({workerId:process.env.OPENCLAW_WORKER_ID,jobId:process.env.OPENCLAW_JOB_ID,context:JSON.parse(process.env.OPENCLAW_WORKER_CONTEXT),gateway:process.env.OPENCLAW_GATEWAY_TOKEN}))'],{encoding:'utf8'}));console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(env)}}));`);
  await chmod(cli,0o700);
  const context={version:1,workerId:'execution',jobId:'job',agentId:'main',sessionKey:'agent:main:main',task:'read',constraints:'read-only'};
  const response=await executeQuery({action:'run',topic:'environment',task:'read',context:'fixture',constraints:'read-only'},{sessionKey:context.sessionKey},{state:join(root,'state'),cwd:root,codexHome:root,cli,skillsEnabled:false,memoryRequired:false,workerCli:{context}});
  const result=JSON.parse(JSON.parse(response.content[0].text).result);const {task,constraints,...identity}=context;assert.deepEqual(result,{workerId:context.workerId,jobId:context.jobId,context:identity});
 }finally{await rm(root,{recursive:true,force:true});}
});
