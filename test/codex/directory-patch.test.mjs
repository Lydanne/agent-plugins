import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,realpath,writeFile,readFile,symlink,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyDirectoryPolicy} from '../../packages/agent-worker/directory-policy.mjs';
import {prepareDirectoryInvocation} from '../../packages/agent-worker/directory-sandbox.mjs';
import {hermesCommand,defaultHermesTemplates} from '../../packages/agent-worker/hermes-templates.mjs';

// Opt-in real CLI, isolated HOME/auth and a loopback-only Responses fixture.
const cli=process.env.WORKER_CODEX_CLI;
const model={slug:'worker-patch-fixture',display_name:'Fixture',description:null,supported_reasoning_levels:[],shell_type:'disabled',visibility:'list',supported_in_api:true,priority:0,availability_nux:null,upgrade:null,support_verbosity:false,default_verbosity:null,apply_patch_tool_type:'freeform',truncation_policy:{mode:'bytes',limit:10000},experimental_supported_tools:[],node_repl_disabled:true,tool_mode:'direct',multi_agent_version:'disabled',base_instructions:'Offline patch fixture'};
const present=async path=>{try{await access(path);return true;}catch{return false;}};
const git=(cwd,args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
for(const workspace of [false,true])test(`real CLI native apply_patch ${workspace?'workspace':'source'} protects shared project files`,{skip:!cli,timeout:45000},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'worker-directory-patch-'))),source=join(root,'projects/demo'),cwd=workspace?join(root,'workspace/demo-0'):source,home=join(root,'codex-home'),state=join(root,'state');
 let server,child,wrapped,timer,requests=0,serverError;const outputs=[];
 const stop=()=>{if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}};
 try{
  for(const dir of new Set([source,cwd,home,state]))await mkdir(dir,{recursive:true});
  for(const dir of new Set([source,cwd])){git(dir,['init','-b','main']);await writeFile(join(dir,'fixture'),'original\n');git(dir,['add','fixture']);git(dir,['commit','-m','fixture']);}
  if(workspace)await symlink(source,join(cwd,'source-link'));
  const patches=[
   `*** Begin Patch\n*** Update File: ${join(cwd,'fixture')}\n@@\n-original\n+own change\n*** End Patch`,
   `*** Begin Patch\n*** Update File: ${join(source,'fixture')}\n@@\n-original\n+forbidden change\n*** End Patch`,
   `*** Begin Patch\n*** Add File: ${join(source,'forbidden-created')}\n+forbidden\n*** End Patch`,
   `*** Begin Patch\n*** Delete File: ${join(source,'fixture')}\n*** End Patch`,
   ...(workspace?[`*** Begin Patch\n*** Add File: ${join(cwd,'source-link','forbidden-link')}\n+forbidden\n*** End Patch`]:[]),
  ];
  server=createServer(async(req,res)=>{
   try{
    assert.equal(req.headers.authorization,undefined,'Real authentication must never reach the fixture');
    if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests++;
    for(const output of body.input.filter(item=>item.type==='custom_tool_call_output'))if(!outputs.some(saved=>saved.call_id===output.call_id))outputs.push(output);
    const tool=body.tools.find(tool=>tool.name==='apply_patch');assert.equal(tool?.type,'custom','Fixture must exercise the native freeform apply_patch tool');
    const item=requests<=patches.length?{type:'custom_tool_call',id:'patch_'+requests,call_id:'patch_'+requests,name:'apply_patch',input:patches[requests-1]}:{type:'message',id:'message_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'patch fixture complete',annotations:[]}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id:'response_'+requests,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'response_'+requests,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
   }catch(error){serverError=error;res.writeHead(400);res.end('Invalid fixture request');}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(join(home,'models.json'),JSON.stringify({models:[model]}));
  await writeFile(join(home,'config.toml'),'model_catalog_json = '+JSON.stringify(join(home,'models.json'))+'\nsandbox_mode = "danger-full-access"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = '+JSON.stringify('http://127.0.0.1:'+server.address().port+'/v1')+'\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n');
  const config=applyDirectoryPolicy({cli,cwd,state,codexHome:home,model:model.slug,reasoningEffort:'low',executorInstructions:'Offline native patch boundary test. Execute the fixture patches.',approvalMode:'dangerously-bypass-approvals-and-sandbox',projectContext:{root,cwd},...(workspace?{workspace:{id:'demo-0'},workspacePool:{repositories:[{path:'.'}]}}:{}),hermesExecution:{template:defaultHermesTemplates.codex,variables:{cli,codexHome:home,model:model.slug,reasoningEffort:'low',speed:''}}});
  const deadline=Date.now()+30000;wrapped=await prepareDirectoryInvocation(config,hermesCommand(config,{prompt:'Execute fixture patches'}),{deadline,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,OPENAI_BASE_URL:'http://127.0.0.1:'+server.address().port+'/v1'}});
  child=spawn(wrapped.invocation.command,wrapped.invocation.args,{cwd,env:wrapped.env,detached:true,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',part=>stderr+=part);child.stdout.resume();child.stdin.end(wrapped.invocation.stdin);timer=setTimeout(stop,Math.max(1,deadline-Date.now()));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});if(serverError)throw serverError;assert.equal(code,0,stderr);
  assert.equal(outputs.length,patches.length,'Every requested native patch must produce a tool result');assert(!JSON.stringify(outputs).includes('unsupported call'),'Do not mistake unavailable tooling for sandbox enforcement');
  assert.equal(await readFile(join(source,'fixture'),'utf8'),'original\n');assert.equal(await present(join(source,'forbidden-created')),false);assert.equal(await present(join(source,'forbidden-link')),false);
  if(workspace)assert.equal(await readFile(join(cwd,'fixture'),'utf8'),'own change\n','Own workspace patch must succeed');
 }finally{clearTimeout(timer);stop();await wrapped?.cleanup();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
});
