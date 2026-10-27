import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {defaultHermesTemplates,hermesCommand} from './hermes-templates.mjs';
import {resolveConfiguration,resolveQueueExecution} from './configuration.mjs';
import {executeQuery} from './index.mjs';
import {createJobs,readJson} from './jobs.mjs';
const params={action:'run',topic:'hermes',task:'read',context:'none',constraints:'read only'};
const decode=result=>JSON.parse(result.content[0].text);
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'hermes-template-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const script=join(root,'fixture cli.mjs');
 await writeFile(script,`import{appendFileSync}from'node:fs';import{randomUUID}from'node:crypto';let input='';for await(const c of process.stdin)input+=c;const args=process.argv.slice(2),p=JSON.parse(input);appendFileSync('calls.jsonl',JSON.stringify({args,p,home:process.env.CODEX_HOME})+'\\n');const id=args.includes('resume')?args[args.indexOf('resume')+1]:randomUUID();console.log(JSON.stringify({type:'thread.started',thread_id:id}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:p.task==='ask'&&!p.mainReplies?JSON.stringify({type:'request',question:'fixture question',reason:'fixture input',progress:'fixture ready'}):'fixture complete'}}));`);
 const template={...structuredClone(defaultHermesTemplates.codex),command:process.execPath,args:[script,...defaultHermesTemplates.codex.args,'--profile','{{profile}}'],variables:{profile:'base'}};
 const config=resolveConfiguration({state:join(root,'state'),cwd:root,codexHome:join(root,'codex'),node:process.execPath,skillsEnabled:false,memoryRequired:false,approvalMode:'read-only',hermesTemplates:{wrapper:template},taskQueues:{custom:{name:'自定义',timeoutMs:1800000,maxConcurrentJobs:1,maxQueuedJobs:5,hermesTemplateId:'wrapper',hermesVariables:{model:'fixture-model',profile:'a b; $(touch injected) "quote"'}}},defaultQueueId:'custom'});
 return {root,config,template};
}
test('default Codex template renders start, resume, JSON strings and read-only refresh',()=>{
 const config=resolveQueueExecution({});
 const prompt='{"task":"quoted \\"input\\""}';
 const first=hermesCommand(config,{prompt});assert.equal(first.command,'codex');assert.equal(first.stdin,prompt);assert.ok(first.args.includes('--json'));assert.ok(!first.args.includes('resume'));
 const next=hermesCommand(config,{prompt,threadId:'session id',refresh:true,outputSchemaPath:'/tmp/schema file.json'});
 assert.equal(next.args[next.args.indexOf('resume')+1],'session id');assert.equal(next.args[next.args.indexOf('--output-schema')+1],'/tmp/schema file.json');assert.ok(next.args.includes('read-only'));assert.ok(!next.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('templates reject unknown variables, malformed placeholders, reserved overrides and unsupported adapters',()=>{
 const template=structuredClone(defaultHermesTemplates.codex);
 for(const change of [{command:'{{missing}}'},{command:'{{cli}'},{adapter:'unimplemented'},{stdin:'changed'},{args:['exec','--json','-']},{variables:{cwd:'/wrong'}},{resumeArgs:['resume']}])assert.throws(()=>resolveConfiguration({hermesTemplates:{codex:{...template,...change}}}),/Hermes|hermesTemplates/);
 assert.throws(()=>resolveConfiguration({taskQueues:{short:{name:'short',timeoutMs:1000,maxConcurrentJobs:1,maxQueuedJobs:1,hermesTemplateId:'missing'}}}),/Unknown Hermes/);
 assert.throws(()=>resolveConfiguration({taskQueues:{short:{name:'short',timeoutMs:1000,maxConcurrentJobs:1,maxQueuedJobs:1,hermesVariables:{undeclared:'x'}}}}),/Undeclared Hermes/);
 const conflict=resolveQueueExecution({hermesTemplates:{codex:{...template,args:[...template.args,'--dangerously-bypass-approvals-and-sandbox']}}});
 assert.throws(()=>hermesCommand(conflict,{refresh:true}),/policy conflict/);
});
test('variable substitution is single pass and never splits or evaluates argument values',()=>{
 const source=structuredClone(defaultHermesTemplates.codex);source.variables={profile:'default'};source.args.push('{{profile}}');
 const config=resolveQueueExecution({hermesTemplates:{codex:source},taskQueues:{short:{name:'short',timeoutMs:1000,maxConcurrentJobs:1,maxQueuedJobs:1,hermesVariables:{profile:'{{prompt}} ; $(echo nope)\nquoted "x"'}}}});
 const call=hermesCommand(config,{prompt:'private prompt'});assert.equal(call.args.at(-1),'{{prompt}} ; $(echo nope)\nquoted "x"');
 assert.ok(!call.args.includes('private prompt'));
});
test('configured executable and argv reach a real fixture process and resume the same session',async t=>{
 const {root,config}=await fixture(t),context={sessionKey:'template-cli'};
 const first=decode(await executeQuery(params,context,config)),second=decode(await executeQuery(params,context,config));
 assert.equal(first.hermesTemplateId,'wrapper');assert.equal(first.model,'fixture-model');assert.equal(second.sessionId,first.sessionId);assert.equal(second.reused,true);
 const calls=(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls[0].args.at(-1),'a b; $(touch injected) "quote"');assert.equal(calls[0].p.task,'read');assert.equal(calls[0].home,join(root,'codex'));
 assert.ok(calls[1].args.includes(first.sessionId));await assert.rejects(readFile(join(root,'injected')),/ENOENT/);
});
test('reply uses the frozen executable and template even after its configuration is removed',async t=>{
 const {config:original}=await fixture(t);let config=original;
 const jobs=createJobs({root:join(config.state,'jobs'),node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:p=>resolveQueueExecution(config,p),getLimits:()=>config});
 const task={...params,task:'ask',waitSeconds:5},scope='template-reply';
 const waiting=await jobs.run(task,scope);assert.equal(waiting.status,'awaiting_main');assert.equal(waiting.hermesTemplateId,'wrapper');
 config=resolveConfiguration({...config,hermesTemplates:defaultHermesTemplates,taskQueues:undefined,defaultQueueId:'short'});
 await jobs.reply(waiting.jobId,scope,waiting.contextRequest.questionId,'fixture answer');
 const done=await jobs.wait(waiting.jobId,scope,5);assert.equal(done.status,'completed');assert.equal(decode(done.result).sessionId,waiting.resumeSessionId);
 assert.equal(readJson(join(original.state,'jobs',waiting.jobId+'.request.json')).runtime.hermesExecution.template.command,process.execPath);
});
test('pre-Hermes admitted requests execute and resume with the original model parameters',async t=>{
 const {root,config}=await fixture(t),cli=join(root,'legacy-codex');
 await writeFile(cli,'#!'+process.execPath+'\n'+await readFile(join(root,'fixture cli.mjs'),'utf8'));await chmod(cli,0o700);
 const legacy={...config,hermesTemplates:defaultHermesTemplates,taskQueues:undefined,defaultQueueId:'short',harness:'codex',cli,model:'old-model',reasoningEffort:'high',modelSessionScope:'legacy-session',thinkingLevel:6};
 const jobs=createJobs({root:join(config.state,'jobs'),node:process.execPath,worker:fileURLToPath(new URL('./worker.mjs',import.meta.url)),getRuntime:()=>legacy});
 const task={...params,task:'ask',thinkingLevel:6,waitSeconds:5},scope='old-snapshot';
 const waiting=await jobs.run(task,scope);assert.equal(waiting.status,'awaiting_main');
 await jobs.reply(waiting.jobId,scope,waiting.contextRequest.questionId,'continue old task');
 const done=await jobs.wait(waiting.jobId,scope,5);assert.equal(done.status,'completed');
 const result=decode(done.result);assert.equal(result.sessionId,waiting.resumeSessionId);assert.equal(result.model,'old-model');assert.equal(result.reasoningEffort,'high');
 const calls=(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(calls[0].args.includes('model_reasoning_effort="high"'));assert.ok(calls[1].args.includes(waiting.resumeSessionId));
 assert.equal(readJson(join(config.state,'jobs',waiting.jobId+'.request.json')).params.thinkingLevel,6);
 const current=resolveConfiguration({...legacy,harness:undefined});
 assert.equal(decode(await executeQuery({action:'list'},{sessionKey:scope},current)).tasks[0].needsMigration,true);
});

test('template labels and variable key order preserve the actual CLI session',async t=>{
 const {config}=await fixture(t),context={sessionKey:'cosmetic-template'},first=decode(await executeQuery(params,context,config));
 const templates=structuredClone(config.hermesTemplates);
 templates.wrapper.name='新的显示名称';templates.wrapper.description='新的用途说明';
 templates.wrapper.variables.profile='changed default overridden by queue';
 const changed={...config,hermesTemplates:templates,taskQueues:{...config.taskQueues,custom:{...config.taskQueues.custom,hermesVariables:Object.fromEntries(Object.entries(config.taskQueues.custom.hermesVariables).reverse())}}};
 const before=resolveQueueExecution(config),after=resolveQueueExecution(changed);
 assert.deepEqual(hermesCommand(before),hermesCommand(after));assert.equal(before.modelSessionScope,after.modelSessionScope);
 const next=decode(await executeQuery(params,context,changed));assert.equal(next.sessionId,first.sessionId);assert.equal(next.reused,true);
 assert.equal(decode(await executeQuery({action:'list'},context,changed)).tasks[0].needsMigration,false);
 for(const update of [{command:'/different-cli'},{args:[...templates.wrapper.args,'--different']},{resumeArgs:['resume','--different','{{sessionId}}']}]){
  const realChange=resolveQueueExecution({...changed,hermesTemplates:{wrapper:{...templates.wrapper,...update}}});assert.notEqual(realChange.modelSessionScope,before.modelSessionScope);
 }
 const variablesChanged=resolveQueueExecution({...config,taskQueues:{...config.taskQueues,custom:{...config.taskQueues.custom,hermesVariables:{model:'another-model',profile:'another-profile'}}}});
 assert.notEqual(variablesChanged.modelSessionScope,before.modelSessionScope);
});

test('in-flight Hermes v1 snapshots retain their old fingerprint when resuming',async t=>{
 const {createHash}=await import('node:crypto');
 const {config}=await fixture(t),runtime=resolveQueueExecution(config);
 delete runtime.hermesIdentityVersion;
 runtime.hermesRevision=createHash('sha256').update(JSON.stringify(runtime.hermesExecution)).digest('hex');
 runtime.modelSessionScope=createHash('sha256').update(JSON.stringify(['hermes',runtime.hermesTemplateId,runtime.hermesRevision])).digest('hex');
 const context={sessionKey:'v1-snapshot'},task={...params,task:'ask'};
 const waiting=decode(await executeQuery(task,context,runtime));assert.ok(waiting.contextRequest);
 const done=decode(await executeQuery({...task,mainReplies:[{questionId:'fixture',answer:'continue'}]},{...context,expectedSessionId:waiting.sessionId},runtime));
 assert.equal(done.sessionId,waiting.sessionId);assert.equal(done.reused,true);
});

test('history matches explicit model IDs before same-model parameter presets',async t=>{
 const {config}=await fixture(t),context={sessionKey:'model-preset-history'};
 config.modelProfiles={quick:{enabled:true,harness:'codex',model:'same-model',reasoningEffort:'low'},deep:{enabled:true,harness:'codex',model:'same-model',reasoningEffort:'high'}};
 config.defaultModelId='quick';
 const selected={...params,modelId:'deep'};
 const first=decode(await executeQuery(selected,context,config));
 assert.equal(decode(await executeQuery({action:'list'},context,config)).tasks[0].needsMigration,false);
 const next=decode(await executeQuery(selected,context,config));assert.equal(next.reused,true);assert.equal(next.sessionId,first.sessionId);
 const changed={...config,modelProfiles:{...config.modelProfiles,deep:{...config.modelProfiles.deep,reasoningEffort:'max'}}};
 assert.equal(decode(await executeQuery({action:'list'},context,changed)).tasks[0].needsMigration,true);
 // A removed/disabled ID must not silently match a different ID with identical parameters.
 for(const modelProfiles of [{replacement:config.modelProfiles.deep},{replacement:config.modelProfiles.deep,deep:{...config.modelProfiles.deep,enabled:false}}]){
  assert.equal(decode(await executeQuery({action:'list'},context,{...config,modelProfiles})).tasks[0].needsMigration,true);
 }
});
