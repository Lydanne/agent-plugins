import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {repositorySkills,git,installScopeProvider} from './repository-skills.mjs';
import plugin,{projectTool} from './index.mjs';
import {scopeRuntime,readScopedSkillVersion} from '../agent-worker/repository-scope.mjs';
import {requestKeyFor} from '../agent-worker/jobs.mjs';
import {skillRefreshPlan,skillTaskContext} from '../agent-worker/skill-refresh.mjs';
async function commit(root) {
 await git(root,['add','.']);await git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture']);
}
async function skill(root,directory,name,body='description: Test skill') {
 const path=join(root,directory,name,'SKILL.md');await mkdir(join(path,'..'),{recursive:true});await writeFile(path,'---\nname: '+name+'\n'+body+'\n---\nRead this skill.\n');
}
async function fixture(t) {
 const base=resolve('../../.tmp/repository-scope-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const roots=[root,join(root,'projects/demo'),join(root,'projects/demo/repositories/frontend'),join(root,'projects/demo/repositories/backend')];
 for(const path of roots){await mkdir(path,{recursive:true});await git(path,['init','-b','main']);}
 await writeFile(join(root,'.gitignore'),'projects/\n');await writeFile(join(root,'projects/demo/.gitignore'),'repositories/\n');
 await writeFile(join(root,'projects.json'),JSON.stringify({schemaVersion:1,projects:{demo:{name:'Demo',url:'https://example.test/repo.git',branch:'main',repository:'projects/demo',skills:['projects/demo/.agents/skills']}}}));
 await writeFile(join(root,'AGENTS.md'),'Role boundaries');
 await skill(root,'skills','role');await skill(root,'skills','protected');
 await skill(roots[1],'.agents/skills','common');await skill(roots[1],'.agents/skills','override');await skill(roots[1],'.agents/skills','protected');
 await skill(roots[2],'.agents/skills','override');await skill(roots[2],'.agents/skills','frontend');await skill(roots[3],'.agents/skills','backend');
 for(const path of roots)await commit(path);
 return {root,roots,binding:{repo:root,defaultProject:'demo'}};
}
test('selected child inherits root skills, overrides names and excludes siblings; role boundaries remain authoritative',async t=>{
 const f=await fixture(t),catalog=await repositorySkills(f.binding,{repository:'projects/demo/repositories/frontend'});
 assert.deepEqual(catalog.skills.map(s=>s.name),['common','frontend','override','protected','role']);
 assert.equal(catalog.skills.find(s=>s.name==='override').source,'repository');assert.equal(catalog.skills.find(s=>s.name==='protected').source,'agent');
 assert.equal(catalog.cwd,f.roots[1]);assert.equal(catalog.scopeDirectory,f.roots[2]);assert.ok(!catalog.snapshot.catalog.some(path=>path.includes('backend')));
 const root=await repositorySkills({repo:f.root});assert.ok(!root.skills.some(s=>s.name==='frontend'));assert.equal(root.skills.find(s=>s.name==='override').source,'project');
 const disabled=await repositorySkills(f.binding,{repository:'projects/demo/repositories/frontend',hostConfig:{skills:{entries:{override:{enabled:false}}}}});assert.ok(!disabled.skills.some(s=>s.name==='override'));
 const tool=projectTool({agents:{main:f.binding}},{agentId:'main'});
 const output=JSON.parse((await tool.execute('',{action:'skills',repository:'projects/demo/repositories/frontend'})).content[0].text);assert.equal(output.repository,catalog.repository);assert.equal(output.snapshot,undefined);
});
test('invalid, uninitialized, symlinked and dirty skill scopes fail closed without modifying files',async t=>{
 const f=await fixture(t);
 for(const repository of ['/tmp','projects/demo/../outside','projects/demo/repositories/frontend/child','projects/demo/repositories/..','projects/demo/repositories/unknown'])await assert.rejects(repositorySkills(f.binding,{repository}));
 await mkdir(join(f.root,'projects/demo/repositories/uninitialized'));await assert.rejects(repositorySkills(f.binding,{repository:'projects/demo/repositories/uninitialized'}),/Git root/);
 await symlink(f.roots[2],join(f.root,'projects/demo/repositories/alias'));await assert.rejects(repositorySkills(f.binding,{repository:'projects/demo/repositories/alias'}),/symlink/);
 const path=join(f.roots[2],'.agents/skills/frontend/SKILL.md');await writeFile(path,'Changed');await assert.rejects(repositorySkills(f.binding,{repository:'projects/demo/repositories/frontend'}),/committed/);assert.equal(await readFile(path,'utf8'),'Changed');
});
test('public prompt hook uses trusted workspace only; explicit selection never becomes another conversation default',async t=>{
 const f=await fixture(t),hooks={},services=[];
 plugin.register({pluginConfig:{agents:{main:f.binding}},config:{},registerTool:()=>{},on:(name,hook)=>hooks[name]=hook,registerService:service=>services.push(service)});t.after(()=>services.forEach(s=>s.stop()));
 services[0].stop();services[0].start();
 const restarted=await scopeRuntime({cwd:f.roots[1],skillContextRoot:f.root,executorInstructions:'fixture',delegationInstructions:'fixture'},{},{agentId:'main'});assert.equal(restarted.cwd,f.roots[1]);
 const frontend=await hooks.before_prompt_build({prompt:'irrelevant path'},{agentId:'main',workspaceDir:f.roots[2]});assert.ok(frontend.appendSystemContext.includes('"repository":"projects/demo/repositories/frontend"'));
 const base=await hooks.before_prompt_build({prompt:'projects/demo/repositories/backend'},{agentId:'main',workspaceDir:f.root});assert.ok(base.appendSystemContext.includes('"repository":"projects/demo"'));assert.ok(!base.appendSystemContext.includes('"name":"backend"'));
 assert.equal(await hooks.before_prompt_build({},{agentId:'other',workspaceDir:f.root}),undefined);
 assert.equal(await hooks.before_prompt_build({},{agentId:'main',workspaceDir:resolve('../../')}),undefined);
});
test('worker freezes selected cwd/catalog, checks owner and rejects changes before execution; different repositories are different requests',async t=>{
 const f=await fixture(t),dispose=installScopeProvider({agents:{main:f.binding}},()=>({}));t.after(dispose);
 const baseline={cwd:f.roots[1],skillContextRoot:f.root,executorInstructions:'Only '+f.roots[1],delegationInstructions:'Use '+f.roots[1]};
 const runtime=await scopeRuntime(baseline,{repository:'projects/demo/repositories/frontend'},{agentId:'main'});
 assert.equal(runtime.cwd,f.roots[1]);assert.ok(runtime.executorInstructions.includes(f.roots[1]));assert.equal((await readScopedSkillVersion(runtime)).root,f.root);
 await assert.rejects(readScopedSkillVersion({...runtime,cwd:f.roots[2]}),/cwd mismatch/);
 const legacy={...runtime,cwd:f.roots[2],scopedSkillSnapshot:{...runtime.scopedSkillSnapshot,protocol:1}};assert.equal((await readScopedSkillVersion(legacy)).protocol,1);
 assert.equal((await scopeRuntime(baseline,{}, {agentId:'main'})).cwd,f.roots[1]);
 await assert.rejects(scopeRuntime(baseline,{repository:'projects/demo/repositories/frontend'},{agentId:'other'}),/own/);
 await assert.rejects(scopeRuntime({...baseline,skillContextRoot:''},{repository:'projects/demo'},{agentId:'main'}),/migration/);
 assert.notEqual(requestKeyFor({topic:'same',repository:'projects/demo/repositories/frontend'},'session'),requestKeyFor({topic:'same',repository:'projects/demo/repositories/backend'},'session'));
 assert.notEqual(requestKeyFor({topic:'same'},'session'),requestKeyFor({topic:'same',repository:'projects/demo'},'session'));
 await skill(f.roots[2],'.agents/skills','added');await assert.rejects(readScopedSkillVersion(runtime),/changed/);
 await commit(f.roots[2]);await assert.rejects(readScopedSkillVersion(runtime),/changed/);
});

test('project and child instructions are frozen, reread by the worker and migrate sessions when committed rules change',async t=>{
 const f=await fixture(t);
 for(const path of f.roots.slice(1)){await writeFile(join(path,'AGENTS.md'),'Original rules');await commit(path);}
 const selected=()=>repositorySkills(f.binding,{repository:'projects/demo/repositories/frontend'});
 const catalog=await selected();
 const runtime={cwd:catalog.cwd,skillContextRoot:f.root,scopedSkillSnapshot:catalog.snapshot};
 assert.equal(catalog.snapshot.protocol,3);
 assert.deepEqual(skillTaskContext(catalog.snapshot).instructions,['projects/demo/AGENTS.md','projects/demo/repositories/frontend/AGENTS.md']);
 for(const path of f.roots.slice(1,3)) {
  await writeFile(join(path,'AGENTS.md'),'Changed rules');
  await assert.rejects(selected(),/instructions must be committed/);
  await assert.rejects(readScopedSkillVersion(runtime),/instructions changed/);
  await writeFile(join(path,'AGENTS.md'),'Original rules');
 }
 await writeFile(join(f.roots[3],'AGENTS.md'),'Unrelated sibling rules');
 await readScopedSkillVersion(runtime);
 const legacy={...runtime,scopedSkillSnapshot:{...catalog.snapshot,protocol:2}};
 delete legacy.scopedSkillSnapshot.instructionSources;
 await readScopedSkillVersion(legacy);
 const forged={...runtime,scopedSkillSnapshot:{...catalog.snapshot,instructionSources:[]}};
 await assert.rejects(readScopedSkillVersion(forged),/instruction snapshot/);
 await writeFile(join(f.roots[2],'AGENTS.md'),'New committed rules');await commit(f.roots[2]);
 const next=await selected();assert.equal(skillRefreshPlan(catalog.snapshot,next.snapshot).migrate,true);
 await assert.rejects(readScopedSkillVersion(runtime),/Repository changed/);
});

test('new, deleted and symlinked repository instructions cannot bypass task admission or execution guards',async t=>{
 const f=await fixture(t),path=join(f.roots[2],'AGENTS.md');
 const catalog=await repositorySkills(f.binding,{repository:'projects/demo/repositories/frontend'});
 const runtime={cwd:catalog.cwd,skillContextRoot:f.root,scopedSkillSnapshot:catalog.snapshot};
 await writeFile(path,'Untracked instructions');await assert.rejects(readScopedSkillVersion(runtime),/instructions changed/);
 await commit(f.roots[2]);const admitted=await repositorySkills(f.binding,{repository:'projects/demo/repositories/frontend'});
 await rm(path);await assert.rejects(readScopedSkillVersion({...runtime,scopedSkillSnapshot:admitted.snapshot}),/instructions changed/);
 await symlink(join(f.roots[1],'AGENTS.md'),path);await commit(f.roots[2]);
 await assert.rejects(repositorySkills(f.binding,{repository:'projects/demo/repositories/frontend'}),/ordinary file/);
});

test('real executor CLI stays at the project root with child skills and inherited effective catalog before business; another session defaults to root',async t=>{
 const {executeQuery}=await import('../agent-worker/index.mjs'),{chmod}=await import('node:fs/promises');
 const f=await fixture(t),dispose=installScopeProvider({agents:{main:f.binding}},()=>({}));t.after(dispose);
 const cli=join(f.root,'.tmp/fake-cli.mjs');await mkdir(join(f.root,'.tmp'));
 await writeFile(cli,`#!${process.execPath}
let text='';for await(const part of process.stdin)text+=part;
const prompt=JSON.parse(text),args=process.argv.slice(2);
const catalog=prompt.catalog??prompt.skills.catalog;
const expected=(prompt.root??prompt.skills.root)+(catalog.some(path=>path.startsWith('projects/other/'))?'/projects/other':'/projects/demo');
if(args[args.indexOf('--cd')+1]!==expected)process.exit(11);
if(prompt.skills&&prompt.skills.cwd!==expected)process.exit(12);
const id=args.includes('resume')?args[args.indexOf('resume')+1]:'00000000-0000-0000-0000-000000000006';
console.log(JSON.stringify({type:'thread.started',thread_id:id}));
if(prompt.kind==='skill_catalog_refresh')console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'catalog_applied',revision:prompt.revision})}}));
else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'verified child directory and catalog'}}));
`);await chmod(cli,0o700);
 const baseline={state:join(f.root,'.tmp/state'),cwd:f.roots[1],skillContextRoot:f.root,cli,executorInstructions:'Only '+f.roots[1],delegationInstructions:'Use '+f.roots[1]};
 const runtime=await scopeRuntime(baseline,{repository:'projects/demo/repositories/frontend'},{agentId:'main'});
 const params={action:'run',topic:'fixture',task:'read only',context:'fixture evidence',constraints:'read only; no business data'};
 const output=JSON.parse((await executeQuery(params,{sessionKey:'frontend-session'},runtime)).content[0].text);assert.equal(output.cwd,f.roots[1]);assert.equal(output.skillsStatus,'catalog_applied');
 const root=await scopeRuntime(baseline,{}, {agentId:'main'});
 const rootOutput=JSON.parse((await executeQuery(params,{sessionKey:'root-session'},root)).content[0].text);assert.equal(rootOutput.cwd,f.roots[1]);
 const other=join(f.root,'projects/other');await mkdir(other);await git(other,['init','-b','main']);await skill(other,'.agents/skills','other-only');await commit(other);
 const manifest=JSON.parse(await readFile(join(f.root,'projects.json'),'utf8'));manifest.projects.other={name:'Other',url:'https://example.test/other.git',branch:'main',repository:'projects/other',skills:['projects/other/.agents/skills']};await writeFile(join(f.root,'projects.json'),JSON.stringify(manifest));await commit(f.root);
 const selected=await scopeRuntime(baseline,{repository:'projects/other'},{agentId:'main'});
 const otherOutput=JSON.parse((await executeQuery(params,{sessionKey:'frontend-session'},selected)).content[0].text);assert.equal(otherOutput.cwd,other);assert.equal(otherOutput.reused,false);
 const back=await scopeRuntime(baseline,{repository:'projects/demo'},{agentId:'main'});
 const backOutput=JSON.parse((await executeQuery(params,{sessionKey:'frontend-session'},back)).content[0].text);assert.equal(backOutput.cwd,f.roots[1]);assert.equal(backOutput.reused,false);
});

test('initialized Git submodules can supply only their own scoped skills',async t=>{
 const f=await fixture(t);
 await git(f.roots[1],['-c','protocol.file.allow=always','submodule','add','--force',f.roots[2],'repositories/module']);await commit(f.roots[1]);
 const result=await repositorySkills(f.binding,{repository:'projects/demo/repositories/module'});
 assert.equal(result.skills.find(skill=>skill.name==='frontend').source,'repository');assert.ok(!result.skills.some(skill=>skill.name==='backend'));
});

test('two registered projects isolate same-name skills, worker sessions and conversation defaults',async t=>{
 const f=await fixture(t),other=join(f.root,'projects/other');
 await mkdir(other);await git(other,['init','-b','main']);
 await skill(other,'.agents/skills','common','description: Other project');await skill(other,'.agents/skills','other-only');await commit(other);
 const manifest=JSON.parse(await readFile(join(f.root,'projects.json'),'utf8'));
 manifest.projects.other={name:'Other',url:'https://example.test/other.git',branch:'main',repository:'projects/other',skills:['projects/other/.agents/skills']};
 await writeFile(join(f.root,'projects.json'),JSON.stringify(manifest));await commit(f.root);
 const selected=await repositorySkills(f.binding,{repository:'projects/other'});
 assert.deepEqual(selected.skills.map(s=>s.name),['common','other-only','protected','role']);
 assert.equal(selected.projectId,'other');assert.ok(selected.skills.find(s=>s.name==='common').path.startsWith('projects/other/'));
 assert.ok(!selected.snapshot.catalog.some(path=>path.startsWith('projects/demo/')));
 await assert.rejects(repositorySkills(f.binding,{repository:'projects/other',projectId:'demo'}),/disagree/);
 await assert.rejects(repositorySkills(f.binding,{repository:'projects/unregistered'}),/registered/);
 await assert.rejects(repositorySkills(f.binding),/explicit selection/);
 await assert.rejects(projectTool({agents:{main:f.binding}},{agentId:'main'}).execute('',{action:'inspect'}),/explicit selection/);
 assert.equal((await repositorySkills(f.binding,{projectId:'demo'})).repository,'projects/demo');
 const dispose=installScopeProvider({agents:{main:f.binding}},()=>({}));t.after(dispose);
 const baseline={cwd:f.roots[1],skillContextRoot:f.root,executorInstructions:'Only '+f.roots[1],delegationInstructions:'Use '+f.roots[1]};
 const runtime=await scopeRuntime(baseline,{repository:'projects/other'},{agentId:'main'});
 assert.equal(runtime.cwd,other);await readScopedSkillVersion(runtime);
 await assert.rejects(scopeRuntime(baseline,{}, {agentId:'main'}),/explicit selection/);
 const forged={...runtime,scopedSkillSnapshot:{...runtime.scopedSkillSnapshot,catalog:['projects/demo/.agents/skills/common/SKILL.md']}};
 await assert.rejects(readScopedSkillVersion(forged),/snapshot/);
 assert.notEqual(requestKeyFor({topic:'same',repository:'projects/demo'},'session'),requestKeyFor({topic:'same',repository:'projects/other'},'session'));
 const hooks={};plugin.register({pluginConfig:{agents:{main:f.binding}},config:{},registerTool:()=>{},on:(name,hook)=>hooks[name]=hook});
 const otherPrompt=await hooks.before_prompt_build({prompt:'projects/demo'},{agentId:'main',workspaceDir:other});
 assert.ok(otherPrompt.appendSystemContext.includes('"projectId":"other"'));assert.ok(!otherPrompt.appendSystemContext.includes('projects/demo/'));
 const base=await hooks.before_prompt_build({prompt:'projects/other'},{agentId:'main',workspaceDir:f.root});
 assert.ok(base.appendSystemContext.includes('[ProjectRegistry]'));assert.ok(base.appendSystemContext.includes('[AgentRoleSkills]'));assert.ok(!base.appendSystemContext.includes('明确选择项目'));assert.ok(!base.appendSystemContext.includes('other-only'));
 assert.ok(base.appendSystemContext.includes('skills/role/SKILL.md'));assert.ok(!base.appendSystemContext.includes('projects/demo/.agents/skills/'));assert.ok(!base.appendSystemContext.includes('projects/other/.agents/skills/'));
});

test('sync tool uses an explicit separate preparation callback and never falls back to a local index',async t=>{
 const f=await fixture(t),calls=[];
 const config={agents:{main:{...f.binding,sync:{enabled:true}}}};
 const manual=async(binding,options)=>{calls.push(options);return {...await repositorySkills(binding,options),synchronization:{ok:true,rootHead:'fixture-head'}};};
 const tool=projectTool(config,{agentId:'main'},{},undefined,manual);
 assert(tool.parameters.properties.action.enum.includes('sync'));
 const result=JSON.parse((await tool.execute('',{action:'sync',repository:'projects/demo/repositories/frontend'})).content[0].text);
 assert.equal(result.synchronization.ok,true);assert.equal(result.snapshot,undefined);assert.equal(result.repository,'projects/demo/repositories/frontend');assert.equal(calls.length,1);assert.equal(calls[0].agentId,'main');
 await tool.execute('',{action:'skills'});assert.equal(calls.length,1);
 await assert.rejects(projectTool({agents:{main:f.binding}},{agentId:'main'},{},undefined,manual).execute('',{action:'sync'}),/unavailable/);
 await assert.rejects(projectTool(config,{agentId:'main'}).execute('',{action:'sync'}),/unavailable/);
 await assert.rejects(tool.execute('',{action:'sync',force:true}),/Invalid/);
});
