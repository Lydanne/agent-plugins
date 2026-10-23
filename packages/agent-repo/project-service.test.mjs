import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm,chmod,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {getAgentRepoService,AgentRepoError} from '../agent-repo-api/index.mjs';
import {createProjectService,installProjectServices} from './project-service.mjs';
import {resolveConfiguration} from './configuration.mjs';
import {createRepositoryRuntime,PreparationError} from './runtime-sync.mjs';
import {git,RepositoryGitCheckError} from './repository-skills.mjs';
import {scopeRuntime,readScopedSkillVersion} from '../agent-worker/repository-scope.mjs';
import {executeQuery,query} from '../agent-worker/index.mjs';
import workerPlugin from '../agent-worker/index.mjs';
import {resolveConfiguration as workerConfiguration} from '../agent-worker/configuration.mjs';
async function commit(root){await git(root,['add','.']);await git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','fixture']);}
async function skill(root,directory,name){await mkdir(join(root,directory,name),{recursive:true});await writeFile(join(root,directory,name,'SKILL.md'),`---\nname: ${name}\ndescription: Fixture\n---\nUse this skill.\n`);}
async function fixture(t,{count=2,sync=false}={}){
 const base=fileURLToPath(new URL('../../.tmp/project-service-tests/',import.meta.url));await mkdir(base,{recursive:true});
 const temp=await mkdtemp(join(base,'case-'));t.after(()=>rm(temp,{recursive:true,force:true}));const root=join(temp,'agent');await mkdir(root);await git(root,['init','-b','main']);
 await writeFile(join(root,'.gitignore'),'projects/\n');await writeFile(join(root,'SOUL.md'),'Role');await writeFile(join(root,'AGENTS.md'),'Role rules');await skill(root,'skills','role');
 const projects={};for(const id of ['a','b'].slice(0,count)){
  const path=join(root,'projects',id);await mkdir(path,{recursive:true});await git(path,['init','-b','main']);await writeFile(join(path,'.gitignore'),'repositories/\n.tmp/\n');await writeFile(join(path,'AGENTS.md'),id+' rules');await skill(path,'.agents/skills',id);await skill(path,'.agents/skills','common');await commit(path);await git(path,['remote','add','origin','https://example.invalid/'+id+'.git']);
  projects[id]={name:id,url:'https://example.invalid/'+id+'.git',branch:'main',repository:'projects/'+id,skills:['projects/'+id+'/.agents/skills']};
 }
 const child=join(root,'projects/a/repositories/frontend');await mkdir(child,{recursive:true});await git(child,['init','-b','main']);await writeFile(join(child,'AGENTS.md'),'Teacher rules');await skill(child,'.agents/skills','common');await skill(child,'.agents/skills','frontend');await commit(child);
 await writeFile(join(root,'projects.json'),JSON.stringify({schemaVersion:1,projects}));await commit(root);
 const config=resolveConfiguration({agents:{main:{repo:root,sync:{enabled:sync}}}}),host={plugins:{entries:{'agent-repo':{enabled:true,hooks:{allowConversationAccess:true},config}}},agents:{list:[{id:'main',workspace:root}]}};
 const calls=[],runtime=createRepositoryRuntime(config,()=>host,{synchronize:async settings=>{calls.push(settings.root);return {ok:true};}});
 const api=createProjectService(config.agents.main,'main',()=>host,runtime.prepareScope),stop=installProjectServices(config,()=>host,runtime.prepareScope,{});t.after(stop);
 const baseline=workerConfiguration({cwd:root,skillContextRoot:'',state:join(temp,'state'),projectRouting:'auto'});
 return {temp,root,projects,api,baseline,host,calls,stop,binding:config.agents.main};
}
test('preparation failures retain controlled blockers and Git diagnostics without leaking raw exceptions',async t=>{
 const f=await fixture(t,{sync:true,count:1});
 for(const [failure,expected] of [
  [new PreparationError('repositories/frontend有未推送提交或分支分叉，不能快进更新'),/repositories\/frontend/],
  [new RepositoryGitCheckError('timeout'),/Git 状态检查超时/],
  [new RepositoryGitCheckError('output_limit'),/超过索引预算/],
  [new Error('password=private-value raw command and stderr'),/check registration, paths and local Git state/]
 ]){
  const api=createProjectService(f.binding,'main',()=>f.host,async()=>{throw failure;});
  await assert.rejects(api.prepareExecutionScope(),error=>{assert.equal(error.code,'SYNC_BLOCKED');assert.match(error.message,expected);assert(!error.message.includes('private-value'));return true;});
 }
 const failure=new AgentRepoError('REGISTRY_CHANGED','Registration changed');
 const api=createProjectService(f.binding,'main',()=>f.host,async()=>{throw failure;});
 await assert.rejects(api.prepareExecutionScope(),error=>error===failure);
});
test('registry inspection failures before scope preparation are safe and disabled sync keeps its readiness code',async t=>{
 const f=await fixture(t,{count:1});
 const api=createProjectService({...f.binding,repo:join(f.temp,'missing-private-value')},'main',()=>f.host,async()=>{assert.fail('must not prepare');});
 await assert.rejects(api.prepareExecutionScope(),error=>{assert.equal(error.code,'PROJECT_NOT_READY');assert(!error.message.includes('private-value'));return true;});
});
test('read-only discovery and explicit selection expose versioned project scope without fixed Worker root',async t=>{
 const f=await fixture(t,{sync:true}),catalog=await f.api.listProjects();assert.equal(catalog.projects.length,2);assert.equal(catalog.singleProjectId,null);assert.deepEqual(f.calls,[]);
 catalog.projects.length=0;assert.equal((await f.api.listProjects()).projects.length,2);
 await assert.rejects(f.api.prepareExecutionScope(),{code:'PROJECT_SELECTION_REQUIRED'});
 await assert.rejects(f.api.prepareExecutionScope({projectId:'a',repository:'projects/b'}),{code:'PROJECT_SELECTOR_CONFLICT'});
 await assert.rejects(f.api.prepareExecutionScope({repository:'../b'}),{code:'PROJECT_SELECTOR_INVALID'});
 await assert.rejects(f.api.prepareExecutionScope({projectId:'missing'}),{code:'PROJECT_NOT_FOUND'});
 await assert.rejects(f.api.prepareExecutionScope({projectId:'a',expectedRegistryRevision:'stale'}),{code:'REGISTRY_CHANGED'});
 const result=await scopeRuntime(f.baseline,{projectId:'a',repository:'projects/a/repositories/frontend'},{agentId:'main',sessionKey:'agent:main:test'},f.host);
 assert.equal(result.cwd,f.root+'/projects/a');assert.equal(result.skillContextRoot,f.root);assert.equal(result.projectContext.projectId,'a');assert.deepEqual(f.calls,[f.root+'/projects/a']);
 assert.ok(result.scopedSkillSnapshot.catalog.includes('projects/a/repositories/frontend/.agents/skills/common/SKILL.md'));assert.ok(!result.scopedSkillSnapshot.catalog.some(path=>path.startsWith('projects/b/')));
 assert.equal(result.projectContext.scopeDirectory,f.root+'/projects/a/repositories/frontend');await readScopedSkillVersion(result);
 await git(f.root+'/projects/a',['remote','set-url','origin','https://example.invalid/changed.git']);await assert.rejects(readScopedSkillVersion(result),/branch or origin changed/);
 f.stop();await assert.rejects(scopeRuntime(f.baseline,{projectId:'a'},{agentId:'main'},f.host),{code:'AGENT_REPO_UNAVAILABLE'});
});
test('single-project default, registration drift and immutable queued snapshot',async t=>{
 const f=await fixture(t,{count:1});assert.equal((await f.api.listProjects()).singleProjectId,'a');
 const runtime=await scopeRuntime(f.baseline,{}, {agentId:'main'});assert.equal(runtime.cwd,f.root+'/projects/a');
 const registry=await readFile(join(f.root,'projects.json'),'utf8');await writeFile(join(f.root,'projects.json'),registry+'\n');
 await assert.rejects(f.api.listProjects(),{code:'REGISTRY_CHANGED'});await assert.rejects(readScopedSkillVersion(runtime),/registration changed/);
 await writeFile(join(f.root,'projects.json'),registry);assert.equal((await readScopedSkillVersion(runtime)).projectId,'a');
 await git(f.root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','new registration version']);await f.api.prepareExecutionScope({expectedRegistryRevision:runtime.projectContext.registryRevision});await readScopedSkillVersion(runtime);
 await writeFile(join(f.root,'README.md'),'unrelated documentation');await commit(f.root);await readScopedSkillVersion(runtime);
 const legacy={...runtime,scopedSkillSnapshot:{...runtime.scopedSkillSnapshot,registryRevision:'a'.repeat(40)+':'+runtime.projectContext.registryRevision.split(':')[1]}};await readScopedSkillVersion(legacy);
 await writeFile(join(f.root,'projects.json'),registry+'\n');await commit(f.root);await assert.rejects(readScopedSkillVersion(runtime),/registration changed/);
});
test('A to B to A preserves CLI sessions and scope-specific skills, history and concurrent execution',async t=>{
 const f=await fixture(t),cli=join(f.temp,'fake-cli.mjs');
 await writeFile(cli,`#!${process.execPath}\nimport {randomUUID} from 'node:crypto';let text='';for await(const data of process.stdin)text+=data;const prompt=JSON.parse(text),args=process.argv.slice(2);const id=args.includes('resume')?args[args.indexOf('resume')+1]:randomUUID();console.log(JSON.stringify({type:'thread.started',thread_id:id}));if(prompt.kind==='business_task'&&args[args.indexOf('--cd')+1]!==prompt.project.cwd)process.exit(9);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:prompt.kind==='skill_catalog_refresh'?JSON.stringify({status:'catalog_applied',revision:prompt.revision}):JSON.stringify({project:prompt.project.projectId,cwd:prompt.project.cwd})}}));\n`);await chmod(cli,0o700);
 const base={...f.baseline,cli},context={agentId:'main',sessionKey:'agent:main:test'},params={action:'run',topic:'same',task:'check',context:'fixture',constraints:'read only'};
 const run=async projectId=>{const runtime=await scopeRuntime(base,{projectId},context);return JSON.parse((await executeQuery(params,context,runtime)).content[0].text);};
 const a=await run('a'),b=await run('b'),back=await run('a');assert.notEqual(a.sessionId,b.sessionId);assert.equal(back.sessionId,a.sessionId);assert.equal(back.reused,true);assert.equal(back.projectId,'a');
 const listing=JSON.parse((await executeQuery({action:'list'},context,base)).content[0].text);assert.equal(listing.tasks.length,2);assert.deepEqual(new Set(listing.tasks.map(row=>row.projectId)),new Set(['a','b']));assert.ok(listing.tasks.every(row=>row.needsMigration===false));
 const concurrent=await Promise.all([run('a'),run('b')]);assert.equal(concurrent[0].sessionId,a.sessionId);assert.equal(concurrent[1].sessionId,b.sessionId);
 const bindingFile=join(base.state,createHash('sha256').update(context.sessionKey).digest('hex')+'.json'),saved=JSON.parse(await readFile(bindingFile,'utf8'));const aKey=Object.keys(saved).find(key=>saved[key].project?.projectId==='a');const legacy={...saved[aKey]};delete legacy.project;delete legacy.executionScope;delete saved[aKey];saved.same=legacy;await writeFile(bindingFile,JSON.stringify(saved));assert.equal((await run('a')).sessionId,a.sessionId);assert.ok(!Object.hasOwn(JSON.parse(await readFile(bindingFile,'utf8')),'same'));
 const child=await scopeRuntime(base,{repository:'projects/a/repositories/frontend'},context);const frontend=JSON.parse((await executeQuery(params,context,child)).content[0].text);assert.notEqual(frontend.sessionId,a.sessionId);
 const file=join(base.state,createHash('sha256').update(context.sessionKey).digest('hex')+'.json');assert.equal(Object.keys(JSON.parse(await readFile(file,'utf8'))).length,3);
 const disabledBase={...base,state:join(f.temp,'disabled-state'),skillsEnabled:false},disabled=await scopeRuntime(disabledBase,{projectId:'a'},context);
 const disabledFirst=JSON.parse((await executeQuery(params,context,disabled)).content[0].text),disabledBack=JSON.parse((await executeQuery(params,context,disabled)).content[0].text);assert.equal(disabledBack.sessionId,disabledFirst.sessionId);assert.equal(disabledBack.skillsStatus,'disabled');
 const disabledListing=JSON.parse((await executeQuery({action:'list'},context,disabledBase)).content[0].text);assert.equal(disabledListing.tasks[0].needsMigration,false);assert.equal(disabledListing.tasks[0].needsSkillsUpdate,false);
});
test('Worker projects action does not bind sources, inspect memory or create jobs',async t=>{
 const f=await fixture(t),factories=[],services=[];workerPlugin.register({pluginConfig:f.baseline,config:f.host,registerTool:factory=>factories.push(factory),registerService:service=>services.push(service),logger:{warn:()=>{}}});t.after(()=>services.forEach(service=>service.stop()));
 const tool=factories[0]({agentId:'main',sessionKey:'agent:main:test'});const result=JSON.parse((await tool.execute('',{action:'projects'})).content[0].text);assert.equal(result.projects.length,2);assert.equal((await f.api.listProjects()).registryRevision,result.registryRevision);
 assert.equal(tool.parameters.properties.projectId.type,'string');await assert.rejects(query({action:'projects',projectId:'a'},{agentId:'main',sessionKey:'agent:main:test'}),/only supported for run/);
});

test('workspace selector is opt-in, exposes pool config and maps skill scope into an isolated clone',async t=>{
 const f=await fixture(t,{count:1});
 await assert.rejects(f.api.prepareExecutionScope({projectId:'a',useWorkspace:true}),/Project preparation failed/);
 await assert.rejects(f.api.prepareExecutionScope({projectId:'a',useWorkspace:'true'}),/boolean/);
 f.projects.a.workspacePool={enabled:true,maxSize:2};await writeFile(join(f.root,'projects.json'),JSON.stringify({schemaVersion:1,projects:f.projects}));await commit(f.root);
 assert.deepEqual((await f.api.listProjects()).projects[0].workspacePool,{enabled:true,maxSize:2});
 const scoped=await scopeRuntime(f.baseline,{projectId:'a',useWorkspace:true},{agentId:'main',sessionKey:'agent:main:test'},f.host);
 assert.equal(scoped.workspacePool.maxSize,2);
 const {prepareJobWorkspace}=await import('../agent-worker/workspace-runtime.mjs');
 const runtime=await prepareJobWorkspace(scoped,'11111111-1111-4111-8111-111111111111');
 assert.equal(runtime.cwd,join(f.root,'workspace/a-0'));assert.equal(runtime.projectContext.repository,'projects/a');
 const snapshot=await readScopedSkillVersion(runtime);assert.equal(snapshot.protocol,4);assert.ok(snapshot.catalog.includes('workspace/a-0/.agents/skills/a/SKILL.md'));assert.ok(snapshot.catalog.includes('skills/role/SKILL.md'));
 await writeFile(join(runtime.cwd,'fix.txt'),'change');await commit(runtime.cwd);await readScopedSkillVersion(runtime);
 const resumed=await prepareJobWorkspace(runtime,runtime.workspace.owner);assert.equal(resumed.workspace.assignmentId,runtime.workspace.assignmentId);assert.equal(resumed.executionScope,runtime.executionScope);
 await git(runtime.cwd,['switch','-c','wrong']);await assert.rejects(readScopedSkillVersion(runtime),/branch/);
});
