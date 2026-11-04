import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runAppServerTurn} from '../../packages/agent-worker/codex-app-server.mjs';
import {hermesCommand} from '../../packages/agent-worker/hermes-templates.mjs';

// Opt-in protocol tests against a real CLI binary, never the real account or model.
const cli=process.env.WORKER_CODEX_CLI;
if(!cli)throw Error('Set WORKER_CODEX_CLI to the Codex CLI executable to run these isolated protocol tests');
const restrictions=['--disable','shell_tool','--disable','view_image','--disable','multi_agent','--disable','goals','--disable','hooks','--disable','plugins','-c','web_search="disabled"','-c','tools.experimental_request_user_input.enabled=false'];
const model={slug:'worker-permission-fixture',display_name:'Fixture',description:null,supported_reasoning_levels:[],shell_type:'disabled',visibility:'list',supported_in_api:true,priority:0,availability_nux:null,upgrade:null,support_verbosity:false,default_verbosity:null,apply_patch_tool_type:null,truncation_policy:{mode:'bytes',limit:10000},experimental_supported_tools:[],node_repl_disabled:true,tool_mode:'direct',multi_agent_version:'disabled',base_instructions:'Offline permission fixture'};

async function probe({restricted=true,mcp=false,mcpOverrides=[],attack=false,patch=false,appServer=false,resume=false,skills=false,skillRestrictions=false,workerJsonl=false,mcpAttack=false}={}){
 const root=await mkdtemp(join(tmpdir(),'worker-permission-probe-')),requests=[];
 const cwd=join(root,'project');await mkdir(cwd);
 let child,server,timer,stdout='',stderr='';
 try{
  await writeFile(join(root,'models.json'),JSON.stringify({models:[{...model,apply_patch_tool_type:patch?'freeform':null}]}));
  if(skills){
   await writeFile(join(root,'AGENTS.md'),'FIXTURE_GLOBAL_USER_INSTRUCTION');
   await writeFile(join(cwd,'AGENTS.md'),'FIXTURE_PRIVATE_PROJECT_INSTRUCTION');
   for(const directory of ['skills/private-fixture','.agents/skills/private-fixture','project/.agents/skills/private-fixture']){
    await mkdir(join(root,directory),{recursive:true});
    await writeFile(join(root,directory,'SKILL.md'),'---\nname: private-fixture\ndescription: FIXTURE_PRIVATE_SKILL_DESCRIPTION\n---\nFIXTURE_PRIVATE_SKILL_BODY\n');
   }
  }
  if(mcp)await writeFile(join(root,'config.toml'),'[mcp_servers.fixture]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = ["-e",'+JSON.stringify('require("node:fs").writeFileSync('+JSON.stringify(join(root,'mcp-marker'))+',"started")')+']\n');
  server=createServer(async(req,res)=>{
   try{
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2*1024*1024)throw Error('Fixture request too large');}
    if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
    const body=JSON.parse(raw);requests.push({tools:body.tools,input:body.input,instructions:body.instructions});
    assert.equal(req.headers.authorization,undefined,'No real authentication may reach the fixture');
    const item=(attack||appServer)&&requests.length===1||appServer&&resume&&requests.length===3?{type:'function_call',id:'call_fixture_'+requests.length,call_id:'call_fixture_'+requests.length,name:mcpAttack?'read_mcp_resource':appServer?'worker_plugin':'exec_command',arguments:JSON.stringify(mcpAttack?{server:'fixture',uri:'fixture://private'}:appServer?{action:'catalog'}:{cmd:'printf forbidden > marker'})}:{type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'fixture complete',annotations:[]}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id:'resp_fixture',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(event)+'\n\n');
    res.end();
   }catch{res.writeHead(400);res.end('Invalid fixture request');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const args=['exec','--skip-git-repo-check','--sandbox','read-only','--json','-c','model_provider="fixture"','-c',`model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",request_max_retries=0,stream_max_retries=0}`,'-m',model.slug,
   ...(restricted?['-c','model_catalog_json='+JSON.stringify(join(root,'models.json')),...restrictions]:[]),...(skillRestrictions?['--enable','skip_host_skill_discovery','-c','skills.include_instructions=false','-c','skills.bundled.enabled=false','-c','project_doc_max_bytes=0']:[]),...mcpOverrides,'Return fixture complete.'];
  if(appServer){
   const calls=[];
   const serverArgs=['app-server',...args.slice(5,-1)];
   const modelFlag=serverArgs.indexOf('-m');serverArgs.splice(modelFlag,2);
   let threadId;const sessions=[];
   const options={invocation:{command:cli,args:serverArgs},config:{cwd,model:model.slug,approvalMode:'read-only',executorInstructions:'Offline fixture',reasoningEffort:'low'},prompt:'Call worker_plugin catalog.',deadline:Date.now()+20000,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root},onProgress:progress=>{if(progress.sessionId){threadId=progress.sessionId;sessions.push(threadId);}},toolBridge:{definitions:[{type:'function',name:'worker_plugin',description:'Fixture catalog',inputSchema:{type:'object',properties:{action:{type:'string'}},required:['action'],additionalProperties:false}}],invoke:async input=>{calls.push({name:input.name,arguments:input.arguments});return {fixture:'host-authorized-result'};}}};
   const result=await runAppServerTurn(options);
   if(resume)assert.equal(await runAppServerTurn({...options,threadId,deadline:Date.now()+20000,toolBridge:{...options.toolBridge,invoke:async input=>{calls.push({name:input.name,arguments:input.arguments});return {fixture:'resumed-host-result'};}}}),'fixture complete');
   return {requests,calls,result,sessions,mcpStarted:existsSync(join(root,'mcp-marker'))};
  }
  const generated=workerJsonl?hermesCommand({cli,cwd,model:model.slug,reasoningEffort:'low',executorInstructions:'Fixture worker instructions',approvalMode:'read-only',codexHome:root}).args:undefined;
  const providerArgs=args.slice(5);const modelIndex=providerArgs.indexOf('-m');providerArgs.splice(modelIndex,2);
  const finalArgs=generated?[...generated.slice(0,-1),'--skip-git-repo-check',...providerArgs]:args;
  child=spawn(cli,finalArgs,{cwd,detached:true,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},20000);
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  assert.equal(code,0,stderr);assert.ok(requests.length,'CLI did not reach the local fixture');
  return {requests,stdout,stderr,marker:existsSync(join(cwd,'marker')),mcpStarted:existsSync(join(root,'mcp-marker'))};
 }finally{
  clearTimeout(timer);if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
 }
}
const names=result=>result.requests[0].tools.map(tool=>tool.name??tool.type);
test('read-only sandbox alone still exposes native shell tools',async()=>{
 const result=await probe({restricted:false});assert.ok(names(result).includes('exec_command'));
});
test('restricted empty configuration rejects an invented native shell call before dispatch',async()=>{
 const result=await probe({attack:true});assert.deepEqual(names(result),[]);assert.equal(result.marker,false);
 assert.equal(result.requests.length,2);assert.match(JSON.stringify(result.requests[1].input),/unsupported call: exec_command/);
 assert.doesNotMatch(result.stdout,/command_execution/);
});
test('an empty MCP table override does not erase inherited servers',async()=>{
 const result=await probe({mcp:true,mcpOverrides:['-c','mcp_servers={}']});
 assert.equal(result.mcpStarted,true);assert.ok(names(result).includes('read_mcp_resource'));
});
test('explicitly disabling an inherited MCP server prevents startup and resource exposure',async()=>{
 const result=await probe({mcp:true,mcpOverrides:['-c','mcp_servers.fixture.enabled=false']});
 assert.equal(result.mcpStarted,false);assert.deepEqual(names(result),[]);
});
test('model metadata can introduce apply_patch despite the other native restrictions',async()=>{
 const result=await probe({patch:true});assert.ok(names(result).includes('apply_patch'));
});
test('real App Server dispatches dynamic calls through the Worker host bridge',async()=>{
 const result=await probe({appServer:true});
 assert.deepEqual(names(result),['worker_plugin']);
 assert.deepEqual(result.calls,[{name:'worker_plugin',arguments:{action:'catalog'}}]);
 assert.equal(result.result,'fixture complete');
 assert.match(JSON.stringify(result.requests[1].input),/host-authorized-result/);
});
test('real App Server resume retains dynamic declarations and uses the current host callback',async()=>{
 const result=await probe({appServer:true,resume:true});
 assert.equal(result.calls.length,2);assert.equal(result.sessions.length,2);
 assert.equal(result.sessions[0],result.sessions[1]);
 assert.deepEqual(result.requests[2].tools.map(tool=>tool.name??tool.type),['worker_plugin']);
 assert.match(JSON.stringify(result.requests[3].input),/resumed-host-result/);
});
test('native tool restrictions alone still expose automatically loaded skill and project instructions',async()=>{
 const result=await probe({skills:true});
 assert.match(JSON.stringify(result.requests),/FIXTURE_PRIVATE_PROJECT_INSTRUCTION/);
 assert.match(JSON.stringify(result.requests),/FIXTURE_PRIVATE_SKILL_DESCRIPTION/);
});
test('skill and project loading can be disabled but global user instructions remain',async()=>{
 const result=await probe({skills:true,skillRestrictions:true});
 assert.doesNotMatch(JSON.stringify(result.requests),/FIXTURE_PRIVATE_/);
 assert.match(JSON.stringify(result.requests),/FIXTURE_GLOBAL_USER_INSTRUCTION/);
});
test('Worker App Server suppresses native skill catalogs while retaining project rules',async()=>{
 const result=await probe({appServer:true,skills:true,resume:true});
 assert.doesNotMatch(JSON.stringify(result.requests),/FIXTURE_PRIVATE_SKILL_/);
 assert.match(JSON.stringify(result.requests),/FIXTURE_PRIVATE_PROJECT_INSTRUCTION/);
 assert.equal(result.calls.length,2);
});
test('Worker JSONL command suppresses native skill catalogs while retaining project rules',async()=>{
 const result=await probe({workerJsonl:true,skills:true});
 assert.doesNotMatch(JSON.stringify(result.requests),/FIXTURE_PRIVATE_SKILL_/);
 assert.match(JSON.stringify(result.requests),/FIXTURE_PRIVATE_PROJECT_INSTRUCTION/);
});
test('Worker App Server disables inherited native MCP before start and resume',async()=>{
 const result=await probe({appServer:true,mcp:true,resume:true});
 assert.equal(result.mcpStarted,false);
 for(const request of result.requests)assert.deepEqual(request.tools.map(tool=>tool.name??tool.type),['worker_plugin']);
 assert.equal(result.calls.length,2);
});
test('invented native MCP calls are rejected without starting the inherited server',async()=>{
 const result=await probe({appServer:true,mcp:true,mcpAttack:true});
 assert.equal(result.mcpStarted,false);assert.equal(result.calls.length,0);
 assert.match(JSON.stringify(result.requests[1].input),/unsupported call: read_mcp_resource/);
});
