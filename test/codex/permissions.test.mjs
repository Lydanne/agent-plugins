import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runAppServerTurn} from '../../packages/agent-worker/codex-app-server.mjs';

// Opt-in protocol tests against a real CLI binary, never the real account or model.
const cli=process.env.WORKER_CODEX_CLI;
if(!cli)throw Error('Set WORKER_CODEX_CLI to the Codex CLI executable to run these isolated protocol tests');
const restrictions=['--disable','shell_tool','--disable','view_image','--disable','multi_agent','--disable','goals','--disable','hooks','--disable','plugins','-c','web_search="disabled"','-c','tools.experimental_request_user_input.enabled=false'];
const model={slug:'worker-permission-fixture',display_name:'Fixture',description:null,supported_reasoning_levels:[],shell_type:'disabled',visibility:'list',supported_in_api:true,priority:0,availability_nux:null,upgrade:null,support_verbosity:false,default_verbosity:null,apply_patch_tool_type:null,truncation_policy:{mode:'bytes',limit:10000},experimental_supported_tools:[],node_repl_disabled:true,tool_mode:'direct',multi_agent_version:'disabled',base_instructions:'Offline permission fixture'};

async function probe({restricted=true,mcp=false,mcpOverrides=[],attack=false,patch=false,appServer=false,resume=false}={}){
 const root=await mkdtemp(join(tmpdir(),'worker-permission-probe-')),requests=[];
 let child,server,timer,stdout='',stderr='';
 try{
  await writeFile(join(root,'models.json'),JSON.stringify({models:[{...model,apply_patch_tool_type:patch?'freeform':null}]}));
  if(mcp)await writeFile(join(root,'config.toml'),'[mcp_servers.fixture]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = ["-e",'+JSON.stringify('require("node:fs").writeFileSync('+JSON.stringify(join(root,'mcp-marker'))+',"started")')+']\n');
  server=createServer(async(req,res)=>{
   try{
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2*1024*1024)throw Error('Fixture request too large');}
    if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
    const body=JSON.parse(raw);requests.push({tools:body.tools,input:body.input});
    assert.equal(req.headers.authorization,undefined,'No real authentication may reach the fixture');
    const item=(attack||appServer)&&requests.length===1||appServer&&resume&&requests.length===3?{type:'function_call',id:'call_fixture_'+requests.length,call_id:'call_fixture_'+requests.length,name:appServer?'worker_plugin':'exec_command',arguments:JSON.stringify(appServer?{action:'catalog'}:{cmd:'printf forbidden > marker'})}:{type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'fixture complete',annotations:[]}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id:'resp_fixture',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(event)+'\n\n');
    res.end();
   }catch{res.writeHead(400);res.end('Invalid fixture request');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const args=['exec','--skip-git-repo-check','--sandbox','read-only','--json','-c','model_provider="fixture"','-c',`model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",request_max_retries=0,stream_max_retries=0}`,'-m',model.slug,
   ...(restricted?['-c','model_catalog_json='+JSON.stringify(join(root,'models.json')),...restrictions]:[]),...mcpOverrides,'Return fixture complete.'];
  if(appServer){
   const calls=[];
   const serverArgs=['app-server',...args.slice(5,-1)];
   const modelFlag=serverArgs.indexOf('-m');serverArgs.splice(modelFlag,2);
   let threadId;const sessions=[];
   const options={invocation:{command:cli,args:serverArgs},config:{cwd:root,model:model.slug,approvalMode:'read-only',executorInstructions:'Offline fixture',reasoningEffort:'low'},prompt:'Call worker_plugin catalog.',deadline:Date.now()+20000,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root},onProgress:progress=>{if(progress.sessionId){threadId=progress.sessionId;sessions.push(threadId);}},toolBridge:{definitions:[{type:'function',name:'worker_plugin',description:'Fixture catalog',inputSchema:{type:'object',properties:{action:{type:'string'}},required:['action'],additionalProperties:false}}],invoke:async input=>{calls.push({name:input.name,arguments:input.arguments});return {fixture:'host-authorized-result'};}}};
   const result=await runAppServerTurn(options);
   if(resume)assert.equal(await runAppServerTurn({...options,threadId,deadline:Date.now()+20000,toolBridge:{...options.toolBridge,invoke:async input=>{calls.push({name:input.name,arguments:input.arguments});return {fixture:'resumed-host-result'};}}}),'fixture complete');
   return {requests,calls,result,sessions};
  }
  child=spawn(cli,args,{cwd:root,detached:true,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},20000);
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  assert.equal(code,0,stderr);assert.ok(requests.length,'CLI did not reach the local fixture');
  return {requests,stdout,stderr,marker:existsSync(join(root,'marker')),mcpStarted:existsSync(join(root,'mcp-marker'))};
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
