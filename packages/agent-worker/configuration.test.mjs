import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm,symlink} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,delimiter} from 'node:path';
import {createHash} from 'node:crypto';
import {defaultConfiguration,resolveConfiguration,executionFingerprint,cliArguments,resolveExecution,modelCatalog} from './configuration.mjs';
import plugin,{executeQuery,buildTaskPrompt,delegationDescription,memorySchema} from './index.mjs';
import {createJobs,readJson} from './jobs.mjs';
import {fileURLToPath} from 'node:url';
import {bindingKey} from './project-binding.mjs';
const profilesOf=models=>Object.fromEntries(models.map(({id,...model})=>[id,{enabled:true,...model}]));
const singleModel=(model,reasoningEffort='low')=>({modelProfiles:profilesOf([{id:'default',harness:'codex',model,reasoningEffort}])});
const requireManifestText=await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8');

test('UI defaults match runtime defaults; configured policies and optional integrations are effective',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 for(const [key,value] of Object.entries(defaultConfiguration)) {
  assert.deepEqual(manifest.configSchema.properties[key].default,value,key);
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
 for(const bad of [{cwd:'relative'},{timeoutMs:0},{skillDirectories:['../private']},{skillDirectories:null},{reportDirectory:'/absolute'},{approvalMode:'invented'}])assert.throws(()=>resolveConfiguration(bad));
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
 const input={state:'/fixture/private state',cwd:'/fixture/business workspace',codexHome:'/fixture/codex',skillContextRoot:'~/fixture-agent',node:'~/bin/node',cli:'~/bin/codex',pathPrefix:['~/bin','/fixture/bin'].join(delimiter),modelProfiles:profilesOf([{id:'custom',harness:'codex',model:'fixture-model',cli:'~/bin/model-codex'}])};
 const custom=resolveConfiguration(input);
 assert.equal(custom.state,input.state);assert.equal(custom.cwd,input.cwd);assert.equal(custom.codexHome,input.codexHome);
 assert.equal(custom.skillContextRoot,join(homedir(),'fixture-agent'));
 assert.equal(custom.node,join(homedir(),'bin/node'));assert.equal(custom.cli,join(homedir(),'bin/codex'));
 assert.equal(custom.pathPrefix,[join(homedir(),'bin'),'/fixture/bin'].join(delimiter));
 assert.equal(resolveExecution(custom,2).cli,join(homedir(),'bin/model-codex'));
 assert.equal(input.modelProfiles.custom.cli,'~/bin/model-codex');
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
 assert.equal(readJson(file)[bindingKey('topic',resolveExecution(config))].sessionId,first.sessionId);
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
 const bindings=readJson(file);bindings[bindingKey('policy',resolveExecution(config))].executionPolicyVersion=6;await writeFile(file,JSON.stringify(bindings));
 assert.equal(decode(await executeQuery({action:'list'},context,config)).tasks[0].needsMigration,true);
 const next=decode(await executeQuery(params,context,config));
 assert.notEqual(next.sessionId,first.sessionId);assert.equal(next.migratedFrom,first.sessionId);
 assert.ok(readJson(file)[bindingKey('policy',resolveExecution(config))].previousSessionIds.includes(first.sessionId));
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
 assert.equal(factories.length,1);assert.deepEqual(services.map(service=>service.id),['agent-worker-diagnostics','agent-worker-scheduler','agent-worker-questions','agent-worker-completion']);
 const tool=factories[0]({sessionKey:'plain-conversation'});
 const response=await tool.execute('',{action:'run',topic:'registered',task:'read',context:'none',constraints:'read only',waitSeconds:5});
 assert.equal(JSON.parse(response.content[0].text).status,'completed');
 assert.ok((await readFile(join(config.cwd,'seen.jsonl'),'utf8')).includes('fixture-model'));
});

test('configured execution timeout survives dispatch and marks the original job timed_out',async t=>{
 const config={...await fixture(t),timeoutMs:1000};
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
 assert.deepEqual(manifest.contracts.tools,['agent_worker']);
 for(const key of ['memoryRoot','memoryToolName','memoryEnabled','memorySemanticEnabled','memoryEmbeddingTimeoutMs','larkCli','openclawHome','larkPathPrefix','historyEnabled','historyLimit','historyTimeoutMs','thinkingProfiles']) {
  assert.ok(!(key in defaultConfiguration));
  assert.ok(!(key in manifest.configSchema.properties));
  assert.ok(!(key in manifest.uiHints));
 }
 const factories=[];
 plugin.register({pluginConfig:{},registerService:()=>{},registerTool:factory=>factories.push(factory)});
 assert.deepEqual(factories.map(factory=>factory({sessionKey:'fixture'}).name).sort(),['agent_worker']);
 assert.deepEqual(factories.map(factory=>factory({sessionKey:'fixture'})).find(tool=>tool.name==='agent_worker').parameters.properties.thinkingLevel,{type:'integer',minimum:0,maximum:6,description:'仅 run：所选模型的智慧等级 0–6。0 使用该模型默认参数，1–6 由低到高，省略使用默认等级；等级不改变所选模型或会话。'});
});


test('seven thinking levels inherit baseline at zero and use per-model profiles',()=>{
 const config=resolveConfiguration(singleModel('baseline-model','medium'));
 assert.equal(resolveExecution(config,0).reasoningEffort,'medium');
 for(const [level,effort] of ['minimal','low','medium','high','xhigh','max'].entries())assert.equal(resolveExecution(config,level+1).reasoningEffort,effort);
 const custom=resolveExecution({...config,thinkingLevel:2,modelProfiles:profilesOf([{id:'custom',harness:'codex',cli:'/fixture/custom-codex',model:'other-model',thinkingProfiles:{'2':{reasoningEffort:'high',speed:'fast'}}}])});
 assert.equal(custom.thinkingLevel,2);assert.equal(custom.cli,'/fixture/custom-codex');assert.equal(custom.model,'other-model');
 assert.ok(cliArguments(custom).includes('service_tier="fast"'));assert.ok(cliArguments(custom).includes('model_reasoning_effort="high"'));
 assert.equal(executionFingerprint(custom),executionFingerprint({...custom,speed:'default'}));
 for(const level of [-1,7,1.5,'3',null])assert.throws(()=>resolveExecution(config,level),/thinkingLevel/);
 for(const thinkingProfiles of [[],null,{'7':{}},{'1':{harness:'claude'}},{'0':{speed:'invalid'}},{'2':{shell:'command'}},{'3':{model:' '}}])assert.throws(()=>resolveConfiguration({modelProfiles:profilesOf([{id:'custom',harness:'codex',model:'fixture-model',thinkingProfiles}])}));
});

test('selected level reaches the local CLI; effective routing changes migrate without hiding unchanged topics',async t=>{
 const base=await fixture(t),config={...base,modelProfiles:profilesOf([{id:'level',harness:'codex',model:'level-three',thinkingProfiles:{'3':{speed:'fast'}}}])};
 const context={sessionKey:'level-routing-fixture'},params={action:'run',topic:'level-topic',task:'read',constraints:'read only',context:'none',thinkingLevel:3};
 const decode=response=>JSON.parse(response.content[0].text);
 const first=decode(await executeQuery(params,context,config));
 assert.equal(first.thinkingLevel,3);assert.equal(first.model,'level-three');assert.equal(first.reasoningEffort,'medium');
 assert.equal(decode(await executeQuery({action:'list'},context,config)).tasks[0].needsMigration,false);
 const resumed=decode(await executeQuery(params,context,config));assert.equal(resumed.sessionId,first.sessionId);
 const migrated=decode(await executeQuery({...params,thinkingLevel:0},context,config));
 assert.equal(migrated.model,'level-three');assert.equal(migrated.migratedFrom,undefined);
 assert.equal(decode(await executeQuery(params,context,config)).sessionId,first.sessionId);
 const calls=(await readFile(join(config.cwd,'seen.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.ok(calls[0].args.includes('service_tier="fast"'));assert.ok(calls[0].args.includes('level-three'));
});

test('admitted jobs freeze level routing while future jobs use the updated operator configuration',async t=>{
 let config={...await fixture(t),modelProfiles:profilesOf([{id:'snapshot',harness:'codex',model:'accepted-model',thinkingProfiles:{'5':{speed:'fast'}}}])};
 const jobs=createJobs({root:join(config.state,'jobs'),node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:params=>resolveExecution(config,params?.thinkingLevel),logger:console});
 const params={topic:'snapshot-level',task:'read',context:'none',constraints:'read only',thinkingLevel:5,waitSeconds:0};
 const accepted=await jobs.run(params,'snapshot-level-fixture');
 config={...config,modelProfiles:profilesOf([{id:'snapshot',harness:'codex',model:'later-model'}])};
 const request=readJson(join(config.state,'jobs',accepted.jobId+'.request.json'));
 assert.equal(request.runtime.model,'accepted-model');assert.equal(request.runtime.thinkingLevel,5);assert.equal(request.runtime.speed,'fast');
 const completed=await jobs.wait(accepted.jobId,'snapshot-level-fixture',5);assert.equal(completed.status,'completed');
 const result=JSON.parse(completed.result.content[0].text);assert.equal(result.model,'accepted-model');
 const retry=await jobs.run(params,'snapshot-level-fixture');assert.equal(retry.jobId,accepted.jobId);
 const next=await jobs.run({...params,topic:'next-level',waitSeconds:5},'snapshot-level-fixture');
 assert.equal(JSON.parse(next.result.content[0].text).model,'later-model');
});


test('level selection participates in retry identity without invalidating legacy default requests',async()=>{
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

const modelOptions=()=>[
 {id:'quick',name:'快速模型',description:'常规查询和轻量任务',harness:'codex',model:'fixture-quick',reasoningEffort:'low',speed:'fast',thinkingProfiles:{'6':{reasoningEffort:'high',speed:'default'}}},
 {id:'deep',name:'分析模型',description:'复杂排查',harness:'codex',model:'fixture-deep',reasoningEffort:'medium'},
];

test('model catalog exposes seven levels per harness/model and rejects invalid operator configuration',()=>{
 const config=resolveConfiguration({modelProfiles:profilesOf(modelOptions()),defaultModelId:'deep'}),catalog=modelCatalog(config);
 assert.equal(catalog.defaultModelId,'deep');assert.equal(catalog.defaultThinkingLevel,0);
 assert.deepEqual(catalog.models.map(model=>model.id),['quick','deep']);
 assert.deepEqual(catalog.models[1].levels.map(level=>level.reasoningEffort),['medium','minimal','low','medium','high','xhigh','max']);
 assert.deepEqual(catalog.models[0].levels[6],{thinkingLevel:6,reasoningEffort:'high',speed:'default'});
 assert.equal(resolveExecution(config).model,'fixture-deep');
 assert.equal(resolveExecution(config,6,'quick').model,'fixture-quick');
 assert.deepEqual(modelCatalog({modelProfiles:{}}).models,[]);
 assert.throws(()=>resolveExecution({modelProfiles:{}}),/No enabled model profiles/);
 assert.equal(resolveExecution({modelProfiles:profilesOf(modelOptions()),defaultModelId:'missing'}).modelId,'quick');
 for(const id of ['missing','',null,42])assert.throws(()=>resolveExecution(config,0,id),/modelId/);
 const input={modelProfiles:profilesOf([{...modelOptions()[0],cli:'~/bin/model-codex'}])};
 assert.equal(resolveExecution(input).cli,join(homedir(),'bin/model-codex'));assert.equal(input.modelProfiles.quick.cli,'~/bin/model-codex');
});

test('levels reuse a model session, model switches preserve both sessions, and policy changes migrate only that model',async t=>{
 const config={...await fixture(t),modelProfiles:profilesOf(modelOptions())},context={sessionKey:'model-session-fixture'},params={action:'run',topic:'same',task:'read',context:'none',constraints:'read only'};
 const decode=response=>JSON.parse(response.content[0].text),run=extra=>executeQuery({...params,...extra},context,config).then(decode);
 const quick=await run({modelId:'quick',thinkingLevel:1}),deep=await run({modelId:'deep',thinkingLevel:6});
 assert.equal(quick.model,'fixture-quick');assert.equal(quick.reasoningEffort,'minimal');assert.equal(deep.reasoningEffort,'max');
 assert.notEqual(quick.sessionId,deep.sessionId);
 const higher=await run({modelId:'quick',thinkingLevel:6});
 assert.equal(higher.sessionId,quick.sessionId);assert.equal(higher.reused,true);assert.equal(higher.reasoningEffort,'high');assert.equal(higher.speed,'default');
 assert.equal((await run({modelId:'deep',thinkingLevel:0})).sessionId,deep.sessionId);
 const renamed={...config,modelProfiles:profilesOf([{...modelOptions()[0],id:'renamed'},modelOptions()[1]])};
 assert.equal(decode(await executeQuery({...params,modelId:'renamed'},context,renamed)).sessionId,quick.sessionId);
 const listed=decode(await executeQuery({action:'list'},context,renamed));
 assert.equal(listed.tasks.length,2);assert.ok(listed.tasks.every(task=>!task.needsMigration));
 const removed=decode(await executeQuery({action:'list'},context,{...config,modelProfiles:profilesOf([modelOptions()[1]])}));
 assert.equal(removed.tasks.find(task=>task.model==='fixture-quick').needsMigration,true);
 const changed={...config,executorInstructions:'changed read-only policy'},migrated=decode(await executeQuery({...params,modelId:'quick'},context,changed));
 assert.notEqual(migrated.sessionId,quick.sessionId);assert.equal(migrated.migratedFrom,quick.sessionId);
 assert.equal((await run({modelId:'deep',thinkingLevel:2})).sessionId,deep.sessionId);
 const calls=(await readFile(join(config.cwd,'seen.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(calls[0].args.includes('model_reasoning_effort="minimal"'));assert.ok(calls[0].args.includes('fixture-quick'));
 assert.ok(calls[1].args.includes('fixture-deep'));assert.ok(calls[2].args.includes('service_tier="default"'));
 const selected=resolveExecution(config,0,'quick');
 assert.notEqual(bindingKey('same',{...selected,executionScope:'project-a'}),bindingKey('same',{...selected,executionScope:'project-b'}));
});

test('queued model selections stay frozen after removal and accepted retries do not resolve a new model',async t=>{
 let config={...await fixture(t),modelProfiles:profilesOf(modelOptions())};
 const jobs=createJobs({root:join(config.state,'jobs'),node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:params=>resolveExecution(config,params?.thinkingLevel,params?.modelId),getLimits:()=>({maxConcurrentJobs:1,maxQueuedJobs:10}),logger:console});
 const params={topic:'frozen-model',task:'slow',context:'none',constraints:'read only',modelId:'quick',thinkingLevel:6,waitSeconds:0};
 const first=await jobs.run(params,'model-snapshot'),queued=await jobs.run({...params,task:'read',requestId:'queued'},'model-snapshot');
 assert.equal(queued.status,'queued');
 config={...config,modelProfiles:profilesOf([modelOptions()[1]])};
 const request=readJson(join(config.state,'jobs',queued.jobId+'.request.json'));
 assert.equal(request.runtime.modelId,'quick');assert.equal(request.runtime.model,'fixture-quick');assert.equal(request.runtime.thinkingLevel,6);
 const completed=await jobs.wait(first.jobId,'model-snapshot',5);assert.equal(completed.status,'completed');
 jobs.tick();const next=await jobs.wait(queued.jobId,'model-snapshot',5);assert.equal(next.status,'completed');
 const result=JSON.parse(next.result.content[0].text);assert.equal(result.model,'fixture-quick');assert.equal(result.reasoningEffort,'high');
 assert.equal((await jobs.run(params,'model-snapshot')).jobId,first.jobId);
 await assert.rejects(jobs.run({...params,requestId:'new'},'model-snapshot'),/modelId/);
});

test('tool advertises configured models and rejects changing a continuation selection',async t=>{
 const config={...await fixture(t),modelProfiles:profilesOf(modelOptions()),defaultModelId:'deep'},factories=[];
 plugin.register({pluginConfig:config,logger:console,registerService:()=>{},registerTool:factory=>factories.push(factory)});
 const tool=factories[0]({sessionKey:'model-tool-fixture'});
 assert.deepEqual(tool.parameters.properties.modelId.enum,['quick','deep']);
 assert.ok(tool.description.includes('复杂排查'));assert.ok(tool.description.includes('0–6'));
 const catalog=JSON.parse((await tool.execute('',{action:'models'})).content[0].text);
 assert.equal(catalog.defaultModelId,'deep');assert.ok(!JSON.stringify(catalog).includes(config.cwd));
 await assert.rejects(tool.execute('',{action:'reply',modelId:'quick'}),/MODEL_SELECTION_INVALID/);
 await assert.rejects(tool.execute('',{action:'run',topic:'invalid',task:'read',context:'none',constraints:'read only',modelId:'missing'}),/MODEL_SELECTION_INVALID/);
});


test('reply resumes the frozen model and level after the operator removes that model',async t=>{
 let config={...await fixture(t),modelProfiles:profilesOf(modelOptions())};
 const jobs=createJobs({root:join(config.state,'jobs'),node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:params=>resolveExecution(config,params?.thinkingLevel,params?.modelId),logger:console});
 const scope='model-reply',params={topic:'paused-model',task:'ask',context:'none',constraints:'read only',modelId:'quick',thinkingLevel:6,waitSeconds:5};
 const waiting=await jobs.run(params,scope);assert.equal(waiting.status,'awaiting_main');
 config={...config,modelProfiles:{}};
 await jobs.reply(waiting.jobId,scope,waiting.contextRequest.questionId,'fixture answer');
 const done=await jobs.wait(waiting.jobId,scope,5);assert.equal(done.status,'completed');
 const result=JSON.parse(done.result.content[0].text);
 assert.equal(result.sessionId,waiting.resumeSessionId);assert.equal(result.modelId,'quick');assert.equal(result.model,'fixture-quick');assert.equal(result.thinkingLevel,6);assert.equal(result.reasoningEffort,'high');assert.equal(result.speed,'default');
});


test('native model dictionary has no legacy options or implicit fallback',()=>{
 const manifest=JSON.parse(requireManifestText),schema=manifest.configSchema.properties.modelProfiles;
 const seed=schema.additionalProperties.default;
 for(const key of ['models','model','reasoningEffort']){
  assert.ok(!Object.hasOwn(manifest.configSchema.properties,key));
  assert.ok(!Object.hasOwn(manifest.uiHints,key));
 }
 const config={model:'removed-model',reasoningEffort:'max',models:modelOptions(),modelProfiles:{draft:{...seed},second:{...seed}}};
 assert.deepEqual(modelCatalog(config).models,[]);
 assert.equal(modelCatalog(config).defaultModelId,'');
 assert.throws(()=>resolveExecution(config),/No enabled model profiles/);
 assert.ok(manifest.uiHints['modelProfiles.*.thinkingProfiles.6.reasoningEffort']);
});

test('native model dictionary selects enabled IDs with model-specific levels and safe default fallback',()=>{
 const modelProfiles={quick:{enabled:true,harness:'codex',model:'fixture-quick',name:'Quick',cli:'~/bin/codex',reasoningEffort:'low'},deep:{enabled:true,harness:'codex',model:'fixture-deep',thinkingProfiles:{'6':{reasoningEffort:'high',speed:'fast'}}}};
 const input={modelProfiles,defaultModelId:'deep'};
 const execution=resolveExecution(input,6);
 assert.equal(execution.modelId,'deep');assert.equal(execution.model,'fixture-deep');
 assert.equal(execution.reasoningEffort,'high');assert.equal(execution.speed,'fast');
 assert.equal(resolveExecution(input,0,'quick').cli,join(homedir(),'bin/codex'));
 assert.equal(input.modelProfiles.quick.cli,'~/bin/codex');
 assert.deepEqual(modelCatalog(input).models.map(model=>model.id),['quick','deep']);
 const disabled={...input,modelProfiles:{...modelProfiles,deep:{...modelProfiles.deep,enabled:false}}};
 assert.equal(modelCatalog(disabled).defaultModelId,'quick');
 assert.equal(resolveExecution(disabled).modelId,'quick');
 assert.throws(()=>resolveExecution(disabled,0,'deep'),/modelId/);
 assert.equal(resolveExecution({...input,defaultModelId:'deleted'}).modelId,'quick');
 assert.deepEqual(modelCatalog({...input,modelProfiles:{}}).models,[]);
});

test('native dictionary rejects malformed keys, incomplete seeds and unsupported execution fields',()=>{
 const seed={enabled:false,harness:'codex',model:'fixture-model'};
 for(const modelProfiles of [null,[],{'bad id':seed},{draft:{enabled:true,harness:'codex'}},{draft:{...seed,model:''}},{draft:{...seed,enabled:'true'}},{draft:{...seed,id:'duplicate'}},{draft:{...seed,harness:'unknown'}},{draft:{...seed,thinkingProfiles:{'6':{model:'arbitrary'}}}}])assert.throws(()=>resolveConfiguration({modelProfiles}),/modelProfiles/);
});

test('native parameter presets for the same model preserve model session identity',()=>{
 const modelProfiles={regular:{enabled:true,harness:'codex',model:'same',reasoningEffort:'low'},analysis:{enabled:true,harness:'codex',model:'same',reasoningEffort:'high'}};
 const regular=resolveExecution({modelProfiles},0,'regular'),analysis=resolveExecution({modelProfiles},0,'analysis');
 assert.equal(regular.modelSessionScope,analysis.modelSessionScope);
 assert.equal(executionFingerprint(regular),executionFingerprint(analysis));
 assert.equal(regular.reasoningEffort,'low');assert.equal(analysis.reasoningEffort,'high');
});


test('an unconfigured worker exposes history and rejects new work before admission',async t=>{
 const config={...await fixture(t),modelProfiles:{}},factories=[];
 plugin.register({pluginConfig:config,logger:console,registerService:()=>{},registerTool:factory=>factories.push(factory)});
 const tool=factories[0]({sessionKey:'unconfigured-models'});
 assert.ok(!Object.hasOwn(tool.parameters.properties.modelId,'enum'));
 assert.deepEqual(JSON.parse((await tool.execute('',{action:'models'})).content[0].text).models,[]);
 assert.equal(JSON.parse((await tool.execute('',{action:'list'})).content[0].text).tasks.length,0);
 await assert.rejects(tool.execute('',{action:'run',topic:'unconfigured',task:'read',context:'none',constraints:'read only'}),/MODEL_NOT_CONFIGURED/);
 await assert.rejects(readFile(join(config.cwd,'seen.jsonl')),/ENOENT/);
});
