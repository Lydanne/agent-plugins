import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,realpath,writeFile,symlink,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyDirectoryPolicy} from '../../packages/agent-worker/directory-policy.mjs';
import {prepareDirectoryInvocation} from '../../packages/agent-worker/directory-sandbox.mjs';
import {hermesCommand,defaultHermesTemplates} from '../../packages/agent-worker/hermes-templates.mjs';
import {runAppServerTurn} from '../../packages/agent-worker/codex-app-server.mjs';
const cli=process.env.WORKER_CODEX_CLI;
const present=async path=>{try{await access(path);return true;}catch{return false;}};
const git=(cwd,args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
for(const adapter of ['codex-jsonl','codex-app-server'])for(const [workspace,adminMode] of [[true,'dangerously-bypass-approvals-and-sandbox'],[true,'workspace-write']])test(`real CLI ${adapter} ${workspace?'workspace':'source'} ${adminMode} sandboxes local MCP startup`,{skip:!cli,timeout:45000},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'worker-directory-cli-'))),source=join(root,'projects/demo'),cwd=workspace?join(root,'workspace/demo-0'):source,home=join(root,'codex-home'),state=join(root,'state'),neighbor=join(root,'workspace/other');
 let server,child,wrapped,timer,networkSeen=false,requests=0,toolCalled=false,commandRan=false;
 try{
  for(const dir of new Set([source,cwd,home,state,neighbor]))await mkdir(dir,{recursive:true});
  const repositories=[{path:'.'}];if(workspace){repositories.push({path:'repositories/child'});await mkdir(join(cwd,'repositories/child'),{recursive:true});}
  for(const repo of repositories){const path=repo.path==='.'?cwd:join(cwd,repo.path);git(path,['init','-b','main']);await writeFile(join(path,'fixture'),'fixture');git(path,['add','fixture']);git(path,['commit','-m','fixture']);}
  if(workspace)await symlink(source,join(cwd,'source-link'));
  const command=`printf command-started; touch own-marker; git switch -c task-branch; ${workspace?'git -C repositories/child switch -c child-branch; touch source-link/symlink-marker; ':''}touch ${JSON.stringify(join(source,'forbidden-marker'))}; touch ${JSON.stringify(join(neighbor,'forbidden-marker'))}; /usr/bin/curl -s "$FIXTURE_URL/probe"`;
  server=createServer(async(req,res)=>{
   if(req.url==='/probe'){networkSeen=true;res.end('network-ok');return;}
   if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-fixture-provider'],'present');requests++;if(requests>1&&body.input.some(item=>item.type==='function_call_output'&&JSON.stringify(item.output).includes('command-started')))commandRan=true;
   let item;if(requests===1){assert(body.tools.some(tool=>tool.name==='exec_command'),'Fixture model must expose native exec_command');toolCalled=true;item={type:'function_call',id:'call_fixture',call_id:'call_fixture',name:'exec_command',arguments:JSON.stringify({cmd:command,yield_time_ms:1000,max_output_tokens:2000})};}else item={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'fixture complete',annotations:[]}]};
   res.writeHead(200,{'content-type':'text/event-stream'});for(const event of [{type:'response.created',response:{id:'resp_fixture',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  // A legacy broad sandbox setting must not defeat the outer profile.
  await writeFile(join(home,'config.toml'),'sandbox_mode = "danger-full-access"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = '+JSON.stringify(url+'/v1')+'\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nhttp_headers = {X-Fixture-Provider = "present"}\n');
  if(adminMode==='workspace-write')await writeFile(join(home,'config.toml'),(await (await import('node:fs/promises')).readFile(join(home,'config.toml'),'utf8'))+'\n[sandbox_workspace_write]\nnetwork_access = true\n');
  const mcpScript='const fs=require("node:fs"); for (const path of '+JSON.stringify([join(source,'mcp-source-marker'),join(home,'mcp-home-marker'),join(cwd,'mcp-own-marker')])+') { try { fs.writeFileSync(path,"started"); } catch {} }';
  await writeFile(join(home,'config.toml'),(await (await import('node:fs/promises')).readFile(join(home,'config.toml'),'utf8'))+'\n[mcp_servers.fixture]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = ["-e",'+JSON.stringify(mcpScript)+']\n');
  const baseTemplate=adapter==='codex-jsonl'?defaultHermesTemplates.codex:defaultHermesTemplates['codex-live'],template={...baseTemplate,args:[...baseTemplate.args,'-c','openai_base_url='+JSON.stringify(url+'/fallback')]};
  const config=applyDirectoryPolicy({cli,cwd,state,codexHome:home,model:'gpt-5.4',reasoningEffort:'low',executorInstructions:'Offline directory boundary test. Execute the fixture command.',approvalMode:adminMode,projectContext:{root,cwd},...(workspace?{workspace:{id:'demo-0'},workspacePool:{repositories}}:{}),hermesExecution:{template,variables:{cli,codexHome:home,model:'gpt-5.4',reasoningEffort:'low',speed:''}}});
  const prompt='Execute fixture command';wrapped=await prepareDirectoryInvocation(config,hermesCommand(config,{prompt}),{env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,FIXTURE_URL:url,OPENAI_BASE_URL:url+'/fallback'}});
  if(adapter==='codex-app-server')assert.equal(await runAppServerTurn({...wrapped,prompt,deadline:Date.now()+30000}),'fixture complete');
  else{
   child=spawn(wrapped.invocation.command,wrapped.invocation.args,{cwd,env:wrapped.env,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',part=>stderr+=part);child.stdout.resume();child.stdin.end(wrapped.invocation.stdin);timer=setTimeout(()=>child.kill('SIGKILL'),30000);const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,0,stderr);
  }
  assert.equal(await present(join(source,'mcp-source-marker')),false);assert.equal(await present(join(home,'mcp-home-marker')),false);assert.equal(await present(join(cwd,'mcp-own-marker')),true,'Local MCP must actually start under its own sandbox');
  assert(toolCalled);assert(commandRan,'Native command must execute inside its sandbox');assert.equal(networkSeen,true,'Original administrator command network ceiling must remain intact');
  assert.equal(await present(join(source,'forbidden-marker')),false);assert.equal(await present(join(neighbor,'forbidden-marker')),false);
  assert.equal(await present(join(cwd,'own-marker')),workspace&&adminMode!=='read-only');assert.equal(git(cwd,['branch','--show-current']),workspace&&adminMode==='dangerously-bypass-approvals-and-sandbox'?'task-branch':'main');
  if(workspace){assert.equal(git(join(cwd,'repositories/child'),['branch','--show-current']),adminMode==='dangerously-bypass-approvals-and-sandbox'?'child-branch':'main');assert.equal(await present(join(source,'symlink-marker')),false);}
 }finally{clearTimeout(timer);child?.kill('SIGKILL');await wrapped?.cleanup();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
});
