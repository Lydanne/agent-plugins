import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm,symlink} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,delimiter} from 'node:path';
import {createHash} from 'node:crypto';
import {defaultConfiguration,resolveConfiguration,executionFingerprint,cliArguments,resolveExecution,resolveQueueExecution} from './configuration.mjs';
import plugin,{executeQuery,buildTaskPrompt,delegationDescription,memorySchema} from './index.mjs';
import {createJobs,readJson} from './jobs.mjs';
import {fileURLToPath} from 'node:url';
import {bindingKey} from './project-binding.mjs';
const singleModel=(model,reasoningEffort='low')=>({taskQueues:Object.fromEntries(Object.entries(defaultConfiguration.taskQueues).map(([id,q])=>[id,{...q,hermesVariables:{model,reasoningEffort,speed:''}}]))});
const requireManifestText=await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8');

test('UI defaults match runtime defaults; configured policies and optional integrations are effective',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 for(const [key,value] of Object.entries(defaultConfiguration)) {
  assert.deepEqual(manifest.configSchema.properties[key].default,key==='taskQueues'?undefined:value,key);
  assert.ok(manifest.uiHints[key].label,key);
 }
 const config=resolveConfiguration({cwd:'/tmp/custom-workspace',...singleModel('fixture-model','high'),approvalMode:'workspace-write',businessDataPolicy:'Public identifiers only'});
 assert.equal(executionFingerprint(resolveConfiguration()),undefined);
 assert.notEqual(executionFingerprint(config),executionFingerprint(resolveConfiguration({...config,...singleModel('another-model')})));
 const args=cliArguments(config);
 assert.equal(args[args.indexOf('--model')+1],'fixture-model');
 assert.equal(args[args.indexOf('--sandbox')+1],'workspace-write');
 assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
 assert.ok(args.join(' ').includes('/tmp/custom-workspace'));
 assert.equal(cliArguments(config,{refresh:true})[4],'read-only');
 assert.equal(JSON.parse(buildTaskPrompt({task:'one',context:'none',constraints:'read only'},{},config)).dataPolicy,'Public identifiers only');
 const description=delegationDescription(config,true);
 assert.ok(description.includes('fixture-model high, workspace-write'));
 assert.ok(description.includes('memory_search'));
 assert.ok(JSON.stringify(memorySchema(config)).includes('memory_get'));
 assert.ok(!JSON.stringify(memorySchema(config)).includes('ada_memory'));
 assert.ok(!description.includes(defaultConfiguration.cwd));
 for(const bad of [{cwd:'relative'},{timeoutMs:0},{longTimeoutMs:0},{skillDirectories:['../private']},{skillDirectories:null},{reportDirectory:'/absolute'},{approvalMode:'invented'}])assert.throws(()=>resolveConfiguration(bad));
});

test('portable published paths resolve at runtime without writing a build-machine home into the manifest',()=>{
 const manifest=JSON.parse(requireManifestText),config=resolveConfiguration();
 assert.equal(defaultConfiguration.state,'~/.openclaw/codex-query-sessions');
 assert.equal(defaultConfiguration.cwd,'~/.openclaw/workspace');
 assert.equal(defaultConfiguration.codexHome,'~/.codex');
 assert.equal(config.state,join(homedir(),'.openclaw/codex-query-sessions'));
 assert.equal(config.cwd,join(homedir(),'.openclaw/workspace'));
 assert.equal(config.codexHome,join(homedir(),'.codex'));
 assert.equal(config.node,'node');assert.equal(config.cli,'codex');assert.equal(config.pathPrefix,'');
 assert.ok(!JSON.stringify(manifest).includes(homedir()));
 assert.ok(!delegationDescription(config).includes('{projectDir}'));
 const input={state:'/fixture/private state',cwd:'/fixture/business workspace',codexHome:'/fixture/codex',skillContextRoot:'~/fixture-agent',node:'~/bin/node',cli:'~/bin/codex',pathPrefix:['~/bin','/fixture/bin'].join(delimiter),...singleModel('fixture-model')};
 const custom=resolveConfiguration(input);
 assert.equal(custom.state,input.state);assert.equal(custom.cwd,input.cwd);assert.equal(custom.codexHome,input.codexHome);
 assert.equal(custom.skillContextRoot,join(homedir(),'fixture-agent'));
 assert.equal(custom.node,join(homedir(),'bin/node'));assert.equal(custom.cli,join(homedir(),'bin/codex'));
 assert.equal(custom.pathPrefix,[join(homedir(),'bin'),'/fixture/bin'].join(delimiter));
 assert.equal(resolveExecution(custom).cli,join(homedir(),'bin/codex'));

 const args=cliArguments(custom),instructions=JSON.parse(args.find(value=>value.startsWith('developer_instructions=')).slice('developer_instructions='.length));
 assert.ok(instructions.includes(custom.cwd));assert.ok(!instructions.includes('{projectDir}'));
 assert.ok(delegationDescription(custom).includes(custom.cwd));
 for(const bad of [{state:'relative'},{codexHome:'~other/user'},{skillContextRoot:'~other/user'}])assert.throws(()=>resolveConfiguration(bad));
});

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'config-executor-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const cli=join(root,'fixture-cli.mjs');
 await writeFile(cli,`#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nimport {randomUUID} from 'node:crypto';\nlet input='';for await(const c of process.stdin)input+=c;\nappendFileSync('seen.jsonl',JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,path:process.env.PATH,prompt:JSON.parse(input)})+'\\n');\nconsole.log(JSON.stringify({type:'thread.started',thread_id:process.argv.includes('resume')?process.argv[process.argv.indexOf('resume')+1]:randomUUID()}));\nif(JSON.parse(input).task==='slow')await new Promise(resolve=>setTimeout(resolve,2000));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.parse(input).task==='ask'&&!JSON.parse(input).mainReplies?JSON.stringify({type:'request',question:'fixture question',reason:'fixture missing input',progress:'fixture ready'}):'fixture completed'}}));\n`);
 await chmod(cli,0o700);
 return resolveConfiguration({state:join(root,'state'),cwd:root,cli,node:process.execPath,codexHome:join(root,'codex'),skillsEnabled:false,memoryRequired:false,...singleModel('fixture-model','high'),approvalMode:'read-only',businessDataPolicy:'fixture data',executorInstructions:'fixture executor',pathPrefix:'',reportDirectory:'reports'});
}

test('real fixture CLI receives UI policy; sessions resume and migrate on policy change without a Feishu publisher',async t=>{
 const config=await fixture(t),context={sessionKey:'trusted-fixture'},params={action:'run',topic:'topic',task:'read',constraints:'read only',context:'none'};
 const decode=response=>JSON.parse(response.content[0].text);
 const first=decode(await executeQuery(params,context,config));
 const second=decode(await executeQuery(params,context,config));
 assert.equal(second.sessionId,first.sessionId);assert.equal(second.reused,true);
 const changed={...config,...singleModel('second-model')};
 assert.equal(decode(await executeQuery({action:'list'},context,changed)).tasks[0].needsMigration,true);
 const migrated=decode(await executeQuery(params,context,changed));
 assert.notEqual(migrated.sessionId,first.sessionId);assert.equal(migrated.migratedFrom,undefined);
 const file=join(config.state,createHash('sha256').update(context.sessionKey).digest('hex')+'.json');
 assert.equal(readJson(file)[bindingKey('topic',resolveQueueExecution(config))].sessionId,first.sessionId);
 assert.equal(Object.keys(readJson(file)).length,2);
 const seen=(await readFile(join(config.cwd,'seen.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(seen.length,3);assert.equal(seen[0].home,config.codexHome);assert.equal(seen[0].path,process.env.PATH);assert.equal(seen[0].prompt.dataPolicy,'fixture data');
 assert.equal(first.skillsStatus,'disabled');assert.equal(migrated.model,'second-model');
});

test('an explicit PATH prefix reaches the CLI while an empty prefix inherits host PATH exactly',async t=>{
 const config={...await fixture(t),pathPrefix:'/fixture/tool bin'};
 await executeQuery({action:'run',topic:'path-prefix',task:'read',context:'none',constraints:'read only'},{sessionKey:'path-prefix-fixture'},config);
 const call=JSON.parse((await readFile(join(config.cwd,'seen.jsonl'),'utf8')).trim());
 assert.equal(call.path,[config.pathPrefix,process.env.PATH].filter(Boolean).join(delimiter));
});

test('new tasks migrate previous execution policies while preserving the old session ID',async t=>{
 const config=await fixture(t),context={sessionKey:'policy-migration-fixture'},params={action:'run',topic:'policy',task:'read',context:'none',constraints:'read only'};
 const decode=response=>JSON.parse(response.content[0].text),first=decode(await executeQuery(params,context,config));
 const file=join(config.state,createHash('sha256').update(context.sessionKey).digest('hex')+'.json');
 const bindings=readJson(file);bindings[bindingKey('policy',resolveQueueExecution(config))].executionPolicyVersion=6;await writeFile(file,JSON.stringify(bindings));
 assert.equal(decode(await executeQuery({action:'list'},context,config)).tasks[0].needsMigration,true);
 const next=decode(await executeQuery(params,context,config));
 assert.notEqual(next.sessionId,first.sessionId);assert.equal(next.migratedFrom,first.sessionId);
 assert.ok(readJson(file)[bindingKey('policy',resolveQueueExecution(config))].previousSessionIds.includes(first.sessionId));
});

test('detached workers consume persisted configuration even after the scheduling configuration changes',async t=>{
 const config=await fixture(t),scope='trusted-worker',params={topic:'frozen',task:'read',context:'none',constraints:'read only',waitSeconds:0};
 let current=config;
 const jobs=createJobs({root:join(config.state,'jobs'),node:'/nonexistent/scheduler-default-node',worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:()=>current,logger:console});
 const accepted=await jobs.run(params,scope);
 current={...config,...singleModel('changed-after-admission')};
 const complete=await jobs.wait(accepted.jobId,scope,5);
 assert.equal(complete.status,'completed');
 const result=JSON.parse(complete.result.content[0].text);
 assert.equal(result.model,'fixture-model');assert.equal(result.reportDirectory,'reports/'+accepted.jobId);
 assert.equal(readJson(join(config.state,'jobs',accepted.jobId+'.request.json')).runtime.model,'fixture-model');
});

test('registration uses configured storage',async t=>{
 const config=await fixture(t),factories=[],services=[];
 plugin.register({pluginConfig:config,logger:console,registerService:s=>services.push(s),registerTool:f=>factories.push(f)});
 assert.equal(factories.length,1);assert.deepEqual(services.map(service=>service.id),['agent-worker-automation','agent-worker-diagnostics','agent-worker-scheduled-status','agent-worker-scheduler','agent-worker-questions','agent-worker-collaboration','agent-worker-completion']);
 const tool=factories[0]({sessionKey:'plain-conversation'});
 const response=await tool.execute('',{action:'run',topic:'registered',task:'read',context:'none',constraints:'read only',waitSeconds:5});
 assert.equal(JSON.parse(response.content[0].text).status,'completed');
 assert.ok((await readFile(join(config.cwd,'seen.jsonl'),'utf8')).includes('fixture-model'));
});

test('configured execution timeout survives dispatch and marks the original job timed_out',async t=>{
 const config={...await fixture(t),taskQueues:undefined,timeoutMs:1000};
 const jobs=createJobs({root:join(config.state,'jobs'),node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:()=>config,logger:console});
 const result=await jobs.run({topic:'slow',task:'slow',context:'none',constraints:'read only',waitSeconds:5},'timeout-fixture');
 assert.equal(result.status,'timed_out');assert.match(result.error,/1000 ms/);
});

test('memory feature combinations advertise the actual admission and native tool protocols',()=>{
 for(const memoryRequired of [false,true]) {
  const config=resolveConfiguration({memoryRequired});
  const description=delegationDescription(config),schema=memorySchema(config);
  assert.equal(description.includes('constraints AND memory'),memoryRequired);
  assert.ok(!description.includes('memory_search action='));
  assert.ok(!description.includes('ada_memory')&&!description.includes('project_memory'));
  assert.ok(description.includes('native memory_search'));
  assert.ok(description.includes('write/edit'));
  if(!memoryRequired)assert.ok(!JSON.stringify(schema).includes('新的 run 会拒绝'));
 }
});

test('registration and manifest expose only delegation without inactive history configuration',()=>{
 const manifest=JSON.parse(requireManifestText);
 assert.deepEqual(manifest.contracts.tools,['agent_worker','agent_task_result']);
 for(const key of ['memoryRoot','memoryToolName','memoryEnabled','memorySemanticEnabled','memoryEmbeddingTimeoutMs','larkCli','openclawHome','larkPathPrefix','historyEnabled','historyLimit','historyTimeoutMs']) {
  assert.ok(!(key in defaultConfiguration));
  assert.ok(!(key in manifest.configSchema.properties));
  assert.ok(!(key in manifest.uiHints));
 }
 const factories=[];
 plugin.register({pluginConfig:{},registerService:()=>{},registerTool:factory=>factories.push(factory)});
 assert.deepEqual(factories.map(factory=>factory({sessionKey:'fixture'}).name).sort(),['agent_worker']);
 assert.equal(factories[0]({sessionKey:'fixture'}).parameters.properties.thinkingLevel,undefined);
});


test('retired selectors are rejected instead of silently overriding queues',()=>{
 for(const key of ['modelProfiles','defaultModelId','thinkingLevel','thinkingProfiles'])assert.throws(()=>resolveConfiguration({[key]:{}}),/removed/);
 assert.throws(()=>resolveQueueExecution({}, {modelId:'old'}),/removed/);
 assert.throws(()=>resolveExecution({},6),/removed/);
});

test('queue Hermes variables reach the CLI and changes retain separate sessions',async t=>{
 const base=await fixture(t),config={...base,taskQueues:{...base.taskQueues,long:{...base.taskQueues.long,hermesVariables:{model:'analysis-model',reasoningEffort:'high',speed:'fast'}}}};
 const context={sessionKey:'queue-routing-fixture'},params={action:'run',topic:'queue-topic',task:'read',constraints:'read only',context:'none',queueId:'long'};
 const decode=response=>JSON.parse(response.content[0].text);
 const first=decode(await executeQuery(params,context,config));
 assert.equal(first.thinkingLevel,undefined);assert.equal(first.model,'analysis-model');assert.equal(first.reasoningEffort,'high');
 assert.equal(decode(await executeQuery({action:'list'},context,config)).tasks[0].needsMigration,false);
 assert.equal(decode(await executeQuery(params,context,config)).sessionId,first.sessionId);
 const changed={...config,taskQueues:{...config.taskQueues,long:{...config.taskQueues.long,hermesVariables:{model:'other-model'}}}};
 assert.notEqual(decode(await executeQuery(params,context,changed)).sessionId,first.sessionId);
 assert.equal(decode(await executeQuery(params,context,config)).sessionId,first.sessionId);
 const calls=(await readFile(join(config.cwd,'seen.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(calls[0].args.includes('service_tier="fast"'));assert.ok(calls[0].args.includes('analysis-model'));
});

test('admitted jobs freeze Hermes templates and variables while future jobs use updated configuration',async t=>{
 let config=await fixture(t);
 config={...config,taskQueues:{...config.taskQueues,short:{...config.taskQueues.short,hermesVariables:{model:'accepted-model',speed:'fast'}}}};
 const jobs=createJobs({root:join(config.state,'jobs'),node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:params=>resolveQueueExecution(config,params),logger:console});
 const params={topic:'snapshot-template',task:'read',context:'none',constraints:'read only',waitSeconds:0};
 const accepted=await jobs.run(params,'snapshot-template-fixture');
 config={...config,taskQueues:{...config.taskQueues,short:{...config.taskQueues.short,hermesVariables:{model:'later-model'}}}};
 const request=readJson(join(config.state,'jobs',accepted.jobId+'.request.json'));
 assert.equal(request.runtime.hermesExecution.variables.model,'accepted-model');assert.equal(request.runtime.speed,'fast');
 const completed=await jobs.wait(accepted.jobId,'snapshot-template-fixture',5);assert.equal(completed.status,'completed');
 assert.equal(JSON.parse(completed.result.content[0].text).model,'accepted-model');
 assert.equal((await jobs.run(params,'snapshot-template-fixture')).jobId,accepted.jobId);
 const next=await jobs.run({...params,topic:'next-template',waitSeconds:5},'snapshot-template-fixture');
 assert.equal(JSON.parse(next.result.content[0].text).model,'later-model');
});

test('old level fields remain in historical request identity for safe continuation',async()=>{
 const {requestKeyFor}=await import('./jobs.mjs');
 const params={topic:'same',task:'same',context:'none',constraints:'read only'};
 assert.equal(requestKeyFor(params,'scope'),requestKeyFor({...params,thinkingLevel:0},'scope'));
 assert.notEqual(requestKeyFor(params,'scope'),requestKeyFor({...params,thinkingLevel:5},'scope'));
});


test('a captured legacy worker path can launch through a temporary compatibility symlink',async t=>{
 const config=await fixture(t),worker=join(config.cwd,'legacy-worker.mjs');
 await symlink(fileURLToPath(new URL('./worker.mjs',import.meta.url)),worker);
 const jobs=createJobs({root:join(config.state,'jobs'),node:process.execPath,worker,getRuntime:()=>config,logger:console});
 const result=await jobs.run({topic:'legacy-path',task:'read',context:'none',constraints:'read only',waitSeconds:5},'legacy-worker-fixture');
 assert.equal(result.status,'completed');
 assert.equal(JSON.parse(result.result.content[0].text).model,'fixture-model');
});


test('renamed plugin identity matches the manifest and Control UI session routing',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 assert.equal(plugin.id,'agent-worker');assert.equal(manifest.id,plugin.id);
 const ui=await readFile(new URL('./control-ui.mjs',import.meta.url),'utf8');
 assert.ok(ui.includes("pluginId:'agent-worker'"));assert.ok(!ui.includes("pluginId:'codex-query'"));
});

test('Agent-owned skill context root changes session policy independently of the business cwd',()=>{
 const baseline=resolveConfiguration(),separated=resolveConfiguration({skillContextRoot:'/agent-repo',cwd:'/agent-repo/project',skillDirectories:['skills','project/.agents/skills']});
 assert.notEqual(executionFingerprint(separated),executionFingerprint({...separated,skillContextRoot:'/other-agent'}));
 assert.equal(cliArguments(separated)[2],'/agent-repo/project');assert.equal(baseline.skillContextRoot,'');assert.throws(()=>resolveConfiguration({skillContextRoot:'relative'}));
});

test('project branch and origin changes invalidate CLI conversation reuse',()=>{
 const config={...resolveConfiguration(),scopedSkillSnapshot:{projectRegistration:{branch:'main',url:'https://example.test/a.git'}}};
 assert.notEqual(executionFingerprint(config),executionFingerprint({...config,scopedSkillSnapshot:{projectRegistration:{branch:'other',url:'https://example.test/a.git'}}}));
 assert.notEqual(executionFingerprint(config),executionFingerprint({...config,scopedSkillSnapshot:{projectRegistration:{branch:'main',url:'https://example.test/b.git'}}}));
 assert.equal(executionFingerprint(config),executionFingerprint({...config,scopedSkillSnapshot:{...config.scopedSkillSnapshot,registryRevision:'new-agent-head'}}));
});

test('v5 frozen default fingerprint remains compatible without treating new runs as legacy',()=>{
 const legacy=resolveConfiguration({executorInstructions:defaultConfiguration.executorInstructions.replace('专注执行和核验，完整报告保持客观，不按提问者的身份、部门或详略偏好裁剪；面向用户的表达由主会话负责。','')});
 assert.equal(executionFingerprint(legacy,{policyVersion:5}),undefined);
 assert.notEqual(executionFingerprint(legacy),undefined);
 assert.notEqual(executionFingerprint({...legacy,model:'changed'},{policyVersion:5}),undefined);
});

test('skill acknowledgement schema applies to new and resumed refresh turns only',()=>{
 const config=resolveConfiguration();
 for(const threadId of [undefined,'00000000-0000-0000-0000-000000000001']){
  const args=cliArguments(config,{refresh:true,threadId,outputSchemaPath:'/tmp/schema path.json'});
  assert.equal(args[args.indexOf('--output-schema')+1],'/tmp/schema path.json');
  assert.ok(args.includes('read-only'));
  if(threadId)assert.ok(args.indexOf('--output-schema')>args.indexOf('resume'));
 }
 assert.ok(!cliArguments(config,{outputSchemaPath:'/tmp/schema.json'}).includes('--output-schema'));
});

test('task-class timeout defaults and administrator overrides are validated',()=>{
 const config=resolveConfiguration();assert.equal(config.timeoutMs,1800000);assert.equal(config.longTimeoutMs,10800000);
 const custom=resolveConfiguration({timeoutMs:90000,longTimeoutMs:7200000});assert.equal(custom.timeoutMs,90000);assert.equal(custom.longTimeoutMs,7200000);
});


test('configurable queue catalog validates IDs, defaults, limits and legacy migration',async t=>{
 const custom={name:'构建',description:'代码构建',timeoutMs:7200000,maxConcurrentJobs:2,maxQueuedJobs:12};
 const config=resolveConfiguration({taskQueues:{...defaultConfiguration.taskQueues,build:custom},defaultQueueId:'build'});
 assert.equal(config.taskQueues.build.timeoutMs,7200000);
 const legacy=resolveConfiguration({timeoutMs:90000,maxConcurrentJobs:2,maxConcurrentLongJobs:4});
 assert.equal(legacy.taskQueues.short.timeoutMs,90000);assert.equal(legacy.taskQueues.short.maxConcurrentJobs,2);assert.equal(legacy.taskQueues.long.maxConcurrentJobs,4);
 assert.equal(resolveConfiguration({...config,timeoutMs:1000}).taskQueues.short.timeoutMs,1800000);
 for(const bad of [{taskQueues:null},{defaultQueueId:null},{taskQueues:{}},{defaultQueueId:'missing'},{taskQueues:{'bad/id':custom},defaultQueueId:'bad/id'},{taskQueues:{build:{...custom,maxConcurrentJobs:0}},defaultQueueId:'build'},{taskQueues:{build:{...custom,timeoutMs:0}},defaultQueueId:'build'}])assert.throws(()=>resolveConfiguration(bad));
 const factories=[];
 plugin.register({pluginConfig:{...await fixture(t),taskQueues:config.taskQueues,defaultQueueId:config.defaultQueueId},logger:console,registerService:()=>{},registerTool:f=>factories.push(f)});
 const tool=factories[0]({sessionKey:'queue-catalog'});
 const result=JSON.parse((await tool.execute('',{action:'queues'})).content[0].text);
 assert.equal(result.defaultQueueId,'build');assert.equal(result.queues.find(q=>q.id==='build').hermesVariables.model,'gpt-6.1-sol');
 await assert.rejects(tool.execute('',{action:'reply',queueId:'build'}),/QUEUE_SELECTION_INVALID/);
});
