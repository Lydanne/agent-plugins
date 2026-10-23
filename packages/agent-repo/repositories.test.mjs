import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import plugin,{projectTool} from './index.mjs';
import {resolveConfiguration,bindingFor} from './configuration.mjs';
import {readProjects,inspectProject,containedPath} from './repositories.mjs';
import {buildConfigPlan,main} from './cli.mjs';
const run=promisify(execFile);
const decode=result=>JSON.parse(result.content[0].text);
const existingSyncPlugin=repo=>({load:{paths:[resolve(fileURLToPath(new URL('.',import.meta.url)))]},entries:{'agent-repo':{enabled:true,config:{agents:{main:{repo}}}}}});
async function fixture(t) {
 const base=resolve('../../.tmp/agent-repo-tests');await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'case-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo');await mkdir(repo);
 for(const role of ['SOUL.md','AGENTS.md'])await writeFile(join(repo,role),'private role body');
 const entry={name:'Demo',url:'git@example.test:team/project.git',branch:'main',repository:'project',skills:['project/.agents/skills'],knowledge:'project/wiki'};
 const manifest={schemaVersion:1,projects:{demo:entry}};
 const save=()=>writeFile(join(repo,'projects.json'),JSON.stringify(manifest));await save();
 return {root,repo,manifest,entry,save};
}
async function git(cwd,...args) {
 return (await run('git',args,{cwd,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}})).stdout.trim();
}
test('multi-Agent bindings reject arbitrary ownership and tool registration is scoped by trusted agentId',async t=>{
 const f=await fixture(t);const other=join(f.root,'other');await mkdir(other);await writeFile(join(other,'projects.json'),JSON.stringify({schemaVersion:1,projects:{}}));
 const config=resolveConfiguration({agents:{main:{repo:f.repo,defaultProject:'demo'},other:{repo:other}}});
 assert.equal(bindingFor(config,{agentId:'missing'}),undefined);assert.equal(bindingFor(config,{agentId:'toString'}),undefined);
 assert.equal(projectTool(config,{sessionKey:'agent:main:chat'}),null);
 const factories=[];plugin.register({pluginConfig:config,registerTool:factory=>factories.push(factory)});
 assert.equal(factories[0]({agentId:'missing'}),null);
 const tool=factories[0]({agentId:'main'}),result=decode(await tool.execute('',{action:'list'}));
 assert.equal(result.agentId,'main');assert.equal(result.projects[0].projectId,'demo');assert.ok(!('memory' in result.projects[0]));assert.equal(result.agent.memory.path,join(f.repo,'memory'));assert.equal(JSON.stringify(result).includes('private role body'),false);
 assert.deepEqual(decode(await factories[0]({agentId:'other'}).execute('',{action:'list'})).projects,[]);
 await assert.rejects(tool.execute('',{action:'inspect',agentId:'other'}),/arguments/);
 await assert.rejects(tool.execute('',{action:'inspect',projectId:'missing'}),/registered/);
 assert.equal(decode(await tool.execute('',{action:'inspect'})).project.git.state,'missing');
});
test('configuration rejects overlapping repo roots, relative paths and malformed defaults',()=>{
 for(const config of [{agents:{main:{repo:'relative'}}},{agents:{main:{repo:'/'}}},{agents:{main:{repo:'/repo',defaultProject:5}}},{agents:{main:{repo:'/repo'},other:{repo:'/repo/inside'}}},{agents:{main:{repo:'/repo',shell:'anything'}}},{anything:true}])assert.throws(()=>resolveConfiguration(config));
});
test('manifest uses project as the direct independent repository without partitioning native Agent memory',async t=>{
 const f=await fixture(t),projects=await readProjects(f.repo);
 assert.equal(projects.demo.paths.repository,join(f.repo,'project'));assert.ok(!('memory' in projects.demo.paths));
 f.manifest.projects.demo={...f.entry,repository:'projects/demo',skills:['projects/demo/.agents/skills'],knowledge:'projects/demo/wiki'};await f.save();assert.equal((await readProjects(f.repo)).demo.paths.repository,join(f.repo,'projects/demo'));
 f.manifest.projects.demo.repository='projects/other';await f.save();await assert.rejects(readProjects(f.repo),/layout/);
});
test('manifest rejects traversal, absolute paths, credential URLs, nested repository layouts and removed project memory fields',async t=>{
 const f=await fixture(t);
 for(const change of [{repository:'../outside'},{repository:'/outside'},{repository:'project/../else'},{memory:'memory/project'},{skills:['skills/private']},{knowledge:'project-other/wiki'},{url:'https://user:password@example.test/repo'},{url:'https://example.test/repo?token=secret'}]) {
  f.manifest.projects.demo={...f.entry,...change};await f.save();await assert.rejects(readProjects(f.repo));
 }
 f.manifest.projects.demo=f.entry;f.manifest.projects.other={...f.entry,repository:'project/child',skills:[],knowledge:undefined};await f.save();await assert.rejects(readProjects(f.repo),/layout/);
});
test('symlink ancestors cannot escape Agent Repo even when the registered child does not exist',async t=>{
 const f=await fixture(t),outside=join(f.root,'outside');await mkdir(outside);await symlink(outside,join(f.repo,'project'));
 await assert.rejects(readProjects(f.repo),/escapes/);
 await assert.rejects(containedPath(f.repo,'project/absent/.agents/skills'),/escapes/);
});
test('project resources cannot resolve into another project through an internal symlink',async t=>{
 const f=await fixture(t);await mkdir(join(f.repo,'project'),{recursive:true});await mkdir(join(f.repo,'project-other'));
 await symlink(join(f.repo,'project-other'),join(f.repo,'project/.agents'));
 await assert.rejects(readProjects(f.repo),/resource escapes/);
});
test('schema and bounded file checks fail closed',async t=>{
 const f=await fixture(t);
 for(const body of ['{broken',JSON.stringify({schemaVersion:2,projects:{}}),' '.repeat(256*1024+1)]){await writeFile(join(f.repo,'projects.json'),body);await assert.rejects(readProjects(f.repo));}
});
test('inspection sees an independent Git repository without modifying dirty files or fetching remote refs',async t=>{
 const f=await fixture(t),path=join(f.repo,'project');await mkdir(path,{recursive:true});await git(path,'init','-b','main');await writeFile(join(path,'file.txt'),'one');await git(path,'add','file.txt');await git(path,'commit','-m','fixture');await git(path,'remote','add','origin',f.entry.url);
 const head=await git(path,'rev-parse','HEAD');await git(path,'update-ref','refs/remotes/origin/main',head);await git(path,'branch','--set-upstream-to=origin/main','main');
 await writeFile(join(path,'file.txt'),'two');
 const project=(await readProjects(f.repo)).demo,result=await inspectProject(project);
 assert.equal(result.git.state,'available');assert.equal(result.git.dirty,true);assert.equal(result.git.remoteMatches,true);assert.equal(result.git.ahead,0);assert.equal(result.git.behind,0);assert.equal(result.git.remoteFreshness,'not_fetched');
 assert.equal(await readFile(join(path,'file.txt'),'utf8'),'two');assert.equal(await git(path,'rev-parse','HEAD'),head);
 await git(path,'checkout','--detach');assert.equal((await inspectProject(project)).git.branch,null);
});
test('a child directory of the Agent Git root is not accepted as an independent project repo',async t=>{
 const f=await fixture(t);await git(f.repo,'init','-b','main');await mkdir(join(f.repo,'project'),{recursive:true});
 assert.equal((await inspectProject((await readProjects(f.repo)).demo)).git.state,'not_independent_repository');
});
test('config plans preserve other bindings and allowlists without switching workspace by default',async t=>{
 const f=await fixture(t),config={agents:{list:[{id:'main',workspace:'/old',model:'keep'},{id:'other',workspace:'/other'}]},plugins:{allow:['feishu'],load:{paths:['/plugins/feishu']},entries:{'agent-repo':{config:{agents:{other:{repo:join(f.root,'other')}}}}}},tools:{allow:['agent_worker']},gateway:{auth:{token:'never-output'}}};
 const before=JSON.stringify(config),plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,defaultProject:'demo'});
 assert.equal(plan.patch.agents,undefined);assert.equal(JSON.stringify(plan).includes('never-output'),false);assert.equal(JSON.stringify(config),before);
 assert.deepEqual(plan.patch.plugins.entries['agent-repo'].hooks,{allowConversationAccess:true});assert.equal(plan.patch.plugins.entries.other,undefined);
 assert.deepEqual(plan.patch.plugins.allow,['feishu','agent-repo']);assert.deepEqual(plan.patch.tools.allow,['agent_worker','agent_repo']);assert.equal(plan.patch.plugins.load.paths[0],'/plugins/feishu');
 const activation=await buildConfigPlan({config,agentId:'main',repo:f.repo,activateWorkspace:true});
 assert.equal(activation.patch.agents.list[0].workspace,f.repo);assert.equal(activation.patch.agents.list[0].model,'keep');assert.deepEqual(activation.patch.agents.list[1],config.agents.list[1]);
 await assert.rejects(buildConfigPlan({config,agentId:'main',repo:f.repo,defaultProject:'missing'}),/not registered/);
 await assert.rejects(buildConfigPlan({config:{},agentId:'main',repo:f.repo,activateWorkspace:true}),/agents.list/);
});
test('installed plugin plans never add a duplicate source load path',async t=>{
 const f=await fixture(t);
 for(const options of [{installed:true},{config:{plugins:{installs:{'agent-repo':{installPath:'/state/extensions/agent-repo'}}}}}]) {
  const plan=await buildConfigPlan({agentId:'main',repo:f.repo,...options});
  assert.equal(plan.patch.plugins.load,undefined);
  assert.equal(plan.patch.plugins.entries['agent-repo'].enabled,true);
  assert.ok(!plan.warnings.some(warning=>warning.includes('不支持 projectId')));
 }
 const configPath=join(f.root,'installed.json');await writeFile(configPath,'{}');
 assert.equal((await main(['plan','--agent-id','main','--repo',f.repo,'--config',configPath,'--installed'])).patch.plugins.load,undefined);
});
test('workspace plans support the host canonical Agent entries without losing settings',async t=>{
 const f=await fixture(t),config={agents:{entries:{main:{workspace:'/old',model:'keep',tools:{deny:['exec']}},other:{workspace:'/other'}}}};
 const before=JSON.stringify(config),plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,activateWorkspace:true,installed:true});
 assert.deepEqual(plan.patch.agents,{entries:{main:{workspace:f.repo,model:'keep',tools:{deny:['exec']}}}});
 assert.equal(JSON.stringify(config),before);
 assert.equal(plan.patch.plugins.load,undefined);
});
test('CLI inspect and plan use explicit inputs and do not write configuration',async t=>{
 const f=await fixture(t),configPath=join(f.root,'config.json'),body=JSON.stringify({plugins:{},agents:{list:[{id:'main',workspace:'/old'}]}});await writeFile(configPath,body);
 assert.equal((await main(['inspect','--repo',f.repo])).projects[0].git.state,'missing');
 const plan=await main(['plan','--repo',f.repo,'--agent-id','main','--config',configPath]);assert.ok(plan.patch.plugins.entries['agent-repo']);assert.equal(await readFile(configPath,'utf8'),body);
 await assert.rejects(main(['inspect','--repo',f.repo,'--shell','any']),/arguments/);
});
test('manifest publishes only the read-only project tool and a strict binding schema',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 assert.equal(manifest.id,plugin.id);assert.deepEqual(manifest.contracts.tools,['agent_repo','agent_entity_sync','agent_schedule']);assert.equal(manifest.configSchema.additionalProperties,false);assert.ok(manifest.uiHints.agents.label.includes(' / '));
});


test('a Git submodule is rejected as the independent Project Repo container',async t=>{
 const f=await fixture(t),source=join(f.root,'source');await mkdir(source);
 await git(source,'init','-b','main');await writeFile(join(source,'file'),'fixture');await git(source,'add','file');await git(source,'commit','-m','fixture');
 await git(f.repo,'init','-b','main');await git(f.repo,'-c','protocol.file.allow=always','submodule','add',source,'project');
 assert.equal((await inspectProject((await readProjects(f.repo)).demo)).git.state,'not_independent_repository');
});

test('migration preparation separates Agent workspace and worker cwd while preserving state and exposing readiness blockers',async t=>{
 const f=await fixture(t);await mkdir(join(f.repo,'tools'));const policy={schemaVersion:1,executorInstructions:'Execute only in {projectDir}',businessDataPolicy:'Keep credentials private',asyncInstructions:'Submit and end turn',delegationInstructions:'Use current task authorization'};
 await writeFile(join(f.repo,'tools/agent-worker-policy.json'),JSON.stringify(policy));
 const config={agents:{defaults:{workspace:'/old'}},plugins:{entries:{'agent-worker':{config:{state:'/private/existing-state',model:'keep'}}}},skills:{load:{extraDirs:['/old/.agents/skills','/other/skills']}},channels:{feishu:{workspaceSync:{root:'/old',timeoutMs:10000}}},gateway:{auth:{token:'secret'}}};
 const before=JSON.stringify(config),plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,defaultProject:'demo',prepareMigration:true});
 assert.equal(plan.patch.agents.defaults.workspace,f.repo);assert.equal(plan.patch.plugins.entries['agent-worker'].config.cwd,join(f.repo,'project'));
 assert.equal(plan.patch.plugins.entries['agent-worker'].config.skillContextRoot,f.repo);assert.equal(plan.patch.plugins.entries['agent-worker'].config.state,undefined);
 assert.equal(plan.patch.channels.feishu.workspaceSync.enabled,false);
 assert.equal(plan.patch.channels.feishu.workspaceSync.root,'/old');assert.equal(plan.patch.channels.feishu.workspaceSync.timeoutMs,10000);
 assert.deepEqual(plan.patch.plugins.entries['agent-repo'].config.agents.main.sync,{enabled:true,timeoutMs:30000,branch:'main',remote:'origin',preserveLocalMemory:true,inboundChannels:{feishu:{messageIdPrefix:'om_'}}});assert.deepEqual(plan.patch.skills.load.extraDirs,['/other/skills']);
 assert.ok(plan.patch.plugins.entries['agent-worker'].config.executorInstructions.includes(join(f.repo,'project')));assert.equal(plan.ready,false);assert.ok(plan.blockers.length);assert.equal(JSON.stringify(config),before);assert.ok(!JSON.stringify(plan).includes('secret'));
 await mkdir(join(f.repo,'project'),{recursive:true});await writeFile(join(f.repo,'project/AGENTS.md'),'Use ada_memory and codex_query');
 const legacy=await buildConfigPlan({config,agentId:'main',repo:f.repo,defaultProject:'demo',prepareMigration:true});assert.ok(legacy.blockers.some(reason=>reason.includes('legacy Ada')));
 await assert.rejects(buildConfigPlan({config:{...config,agents:{list:[{id:'main'},{id:'other'}]}},agentId:'main',repo:f.repo,prepareMigration:true}),/single|one configured/);
 await writeFile(join(f.repo,'tools/agent-worker-policy.json'),JSON.stringify({...policy,cli:'unauthorized'}));await assert.rejects(buildConfigPlan({config,agentId:'main',repo:f.repo,prepareMigration:true}),/policy/);
});

test('multi-project migration plans use selected paths and remove global cross-project skill directories',async t=>{
 const f=await fixture(t);
 f.manifest.projects.demo={...f.entry,repository:'projects/demo',skills:['projects/demo/.agents/skills'],knowledge:'projects/demo/wiki'};
 f.manifest.projects.other={...f.entry,name:'Other',repository:'projects/other',skills:['projects/other/.agents/skills'],knowledge:undefined};await f.save();
 await mkdir(join(f.repo,'tools'));await writeFile(join(f.repo,'tools/agent-worker-policy.json'),JSON.stringify({schemaVersion:1,executorInstructions:'Execute in {projectDir}',businessDataPolicy:'Private',asyncInstructions:'End turn',delegationInstructions:'Current scope'}));
 const dirs=[join(f.repo,'projects'),join(f.repo,'projects/demo/.agents/skills'),join(f.repo,'projects/other/.agents/skills'),join(f.repo,'projects/other/repositories/lib/.agents/skills'),'/unrelated/skills'];
 const plan=await buildConfigPlan({config:{channels:{feishu:{}},skills:{load:{extraDirs:dirs}}},agentId:'main',repo:f.repo,defaultProject:'other',prepareMigration:true});
 assert.equal(plan.patch.channels.feishu.workspaceSync.enabled,false);assert.equal(plan.patch.plugins.entries['agent-worker'].config.cwd,join(f.repo,'projects/other'));
 assert.deepEqual(plan.patch.plugins.entries['agent-worker'].config.skillDirectories,['skills','projects/other/.agents/skills']);assert.deepEqual(plan.patch.skills.load.extraDirs,['/unrelated/skills']);
 const undecided=projectTool({agents:{main:{repo:f.repo}}},{agentId:'main'});
 await assert.rejects(undecided.execute('',{action:'skills'}),/registered projectId/);
});

test('migration preparation blocks missing, stale and local-only project upstreams without fetching or changing files',async t=>{
 const f=await fixture(t),path=join(f.repo,'project');
 f.manifest.projects.demo.knowledge=undefined;await f.save();
 await mkdir(join(f.repo,'tools'));await writeFile(join(f.repo,'tools/agent-worker-policy.json'),JSON.stringify({schemaVersion:1,executorInstructions:'Execute in {projectDir}',businessDataPolicy:'Private',asyncInstructions:'End turn',delegationInstructions:'Current scope'}));
 await writeFile(join(f.repo,'.gitignore'),'project/\n');
 for(const directory of [f.repo,path]) {
  await mkdir(directory,{recursive:true});await git(directory,'init','-b','main');
  await writeFile(join(directory,'file'),'one');await git(directory,'add','.');await git(directory,'commit','-m','baseline');
  const head=await git(directory,'rev-parse','HEAD');await git(directory,'update-ref','refs/remotes/origin/main',head);
  await git(directory,'remote','add','origin',f.entry.url);await git(directory,'branch','--set-upstream-to=origin/main','main');
 }
 const plan=()=>buildConfigPlan({config:{channels:{feishu:{}}},agentId:'main',repo:f.repo,prepareMigration:true});
 assert.equal((await plan()).ready,true);
 const baseline=await git(path,'rev-parse','HEAD');
 await writeFile(join(path,'file'),'two');await git(path,'add','file');await git(path,'commit','-m','local');
 assert.ok((await plan()).blockers.some(reason=>reason.includes('fetched registered upstream')));
 const ahead=await git(path,'rev-parse','HEAD');await git(path,'update-ref','refs/remotes/origin/main',ahead);await git(path,'checkout','-B','main',baseline);
 assert.ok((await plan()).blockers.some(reason=>reason.includes('fetched registered upstream')));
 await git(path,'branch','--unset-upstream');assert.ok((await plan()).blockers.some(reason=>reason.includes('fetched registered upstream')));
 assert.equal(await git(path,'rev-parse','refs/remotes/origin/main'),ahead);assert.equal(await readFile(join(path,'file'),'utf8'),'one');
});

test('migration preparation requires Agent origin/main tracking with no ahead or behind commits and stays read-only',async t=>{
 for(const scenario of ['missing','wrong-branch','wrong-remote','ahead','behind'])await t.test(scenario,async t=>{
  const f=await fixture(t),project=join(f.repo,'project');
  f.manifest.projects.demo.knowledge=undefined;await f.save();
  await mkdir(join(f.repo,'tools'));await writeFile(join(f.repo,'tools/agent-worker-policy.json'),JSON.stringify({schemaVersion:1,executorInstructions:'Execute in {projectDir}',businessDataPolicy:'Private',asyncInstructions:'End turn',delegationInstructions:'Current scope'}));
  await writeFile(join(f.repo,'.gitignore'),'project/\n');
  for(const directory of [f.repo,project]) {
   await mkdir(directory,{recursive:true});await git(directory,'init','-b','main');await writeFile(join(directory,'file'),'baseline');
   await git(directory,'add','.');await git(directory,'commit','-m','baseline');await git(directory,'remote','add','origin',f.entry.url);
   await git(directory,'update-ref','refs/remotes/origin/main',await git(directory,'rev-parse','HEAD'));await git(directory,'branch','--set-upstream-to=origin/main','main');
  }
  const config={channels:{feishu:{}}},plan=()=>buildConfigPlan({config,agentId:'main',repo:f.repo,prepareMigration:true});
  assert.equal((await plan()).ready,true);
  const head=await git(f.repo,'rev-parse','HEAD');
  if(scenario==='missing')await git(f.repo,'branch','--unset-upstream');
  if(scenario==='wrong-branch') {
   await git(f.repo,'update-ref','refs/remotes/origin/other',head);await git(f.repo,'branch','--set-upstream-to=origin/other','main');
  }
  if(scenario==='wrong-remote') {
   await git(f.repo,'remote','add','other','git@example.test:team/other.git');await git(f.repo,'update-ref','refs/remotes/other/main',head);await git(f.repo,'branch','--set-upstream-to=other/main','main');
  }
  if(['ahead','behind'].includes(scenario)) {
   const future=await git(f.repo,'commit-tree',await git(f.repo,'rev-parse','HEAD^{tree}'),'-p',head,'-m','future');
   await git(f.repo,'update-ref',scenario==='ahead'?'refs/heads/main':'refs/remotes/origin/main',future);
  }
  const before={refs:await git(f.repo,'show-ref'),status:await git(f.repo,'status','--porcelain=v1'),projectHead:await git(project,'rev-parse','HEAD'),config:JSON.stringify(config)};
  const result=await plan();assert.equal(result.ready,false);
  assert.ok(result.blockers.some(reason=>reason.startsWith('Agent Repo ')&&(scenario==='missing'?reason.includes('upstream cannot be verified'):reason.includes('fetched origin/main upstream'))));
  assert.equal(await git(f.repo,'show-ref'),before.refs);assert.equal(await git(f.repo,'status','--porcelain=v1'),before.status);assert.equal(await git(project,'rev-parse','HEAD'),before.projectHead);
  assert.equal(JSON.stringify(config),before.config);assert.equal(await readFile(join(f.repo,'file'),'utf8'),'baseline');
  await assert.rejects(readFile(join(f.repo,'.git/FETCH_HEAD')),{code:'ENOENT'});
 });
});

async function syncFixture(t) {
 const f=await fixture(t),project=join(f.repo,'project');
 f.entry.knowledge=undefined;await f.save();await writeFile(join(f.repo,'.gitignore'),'project/\nprojects/\n');
 for(const directory of [f.repo,project]) {
  await mkdir(directory,{recursive:true});await git(directory,'init','-b','main');await writeFile(join(directory,'file'),'fixture');
  await git(directory,'add','.');await git(directory,'commit','-m','fixture');await git(directory,'remote','add','origin',f.entry.url);
  await git(directory,'update-ref','refs/remotes/origin/main',await git(directory,'rev-parse','HEAD'));await git(directory,'branch','--set-upstream-to=origin/main','main');
 }
 return f;
}
test('sync-only preparation is explicit, preserves old configuration and does not rewrite worker policy or permissions',async t=>{
 const f=await syncFixture(t);
 const binding={repo:f.repo,defaultProject:'demo',sync:{enabled:false,timeoutMs:12000,branch:'main',remote:'origin',preserveLocalMemory:false}};
 const legacy={enabled:true,root:'/old',timeoutMs:15000,project:{path:'project',expectedUrl:f.entry.url},skillDirectories:['keep'],executorStateDir:'/private/state'};
 const config={agents:{list:[{id:'main',workspace:f.repo,model:'keep'}]},plugins:{load:{paths:[resolve(fileURLToPath(new URL('.',import.meta.url)))]},entries:{'agent-repo':{enabled:true,hooks:{allowConversationAccess:true,keep:'value'},config:{agents:{main:binding}}},'agent-worker':{config:{executorInstructions:'keep',cwd:projectPath(f),state:'/private/state'}}}},channels:{feishu:{workspaceSync:legacy}},skills:{load:{extraDirs:['/keep']}}};
 const before=JSON.stringify(config);
 const defaultPlan=await buildConfigPlan({config,agentId:'main',repo:f.repo});assert.equal(defaultPlan.patch.channels,undefined);assert.equal(defaultPlan.patch.plugins.entries['agent-repo'].config.agents.main.sync.enabled,false);
 const plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,prepareSync:true});
 assert.equal(plan.ready,true);assert.deepEqual(plan.patch.channels.feishu.workspaceSync,{...legacy,enabled:false});
 assert.deepEqual(plan.patch.plugins.entries['agent-repo'].config.agents.main,{...binding,sync:{...binding.sync,enabled:true,inboundChannels:{feishu:{messageIdPrefix:'om_'}}}});
 assert.deepEqual(Object.keys(plan.patch.plugins.entries),['agent-repo']);assert.equal(plan.patch.agents,undefined);assert.equal(plan.patch.skills,undefined);
 assert.deepEqual(plan.patch.plugins.entries['agent-repo'].hooks,{allowConversationAccess:true,keep:'value'});assert.equal(plan.patch.plugins.load,undefined);assert.equal(JSON.stringify(config),before);
 const denied=await buildConfigPlan({config:{...config,plugins:{load:config.plugins.load,entries:{'agent-repo':{enabled:true,hooks:{allowConversationAccess:false},config:{agents:{main:binding}}}}}},agentId:'main',repo:f.repo,prepareSync:true});
 assert.equal(denied.ready,false);assert.equal(denied.patch.plugins.entries['agent-repo'].hooks.allowConversationAccess,false);assert.ok(denied.blockers.some(reason=>reason.includes('explicitly denied')));
 const duplicate=await buildConfigPlan({config:{...config,plugins:{load:config.plugins.load,entries:{'agent-repo':{enabled:true,config:{agents:{main:{...binding,sync:{...binding.sync,enabled:true}}}}}}}},agentId:'main',repo:f.repo,prepareSync:true});assert.ok(duplicate.blockers.some(reason=>reason.includes('both enabled')));
 for(const other of [{activateWorkspace:true},{prepareMigration:true},{defaultProject:'demo'}])await assert.rejects(buildConfigPlan({config,agentId:'main',repo:f.repo,prepareSync:true,...other}),/Synchronization-only/);
});
const projectPath=f=>join(f.repo,'project');
test('sync-only preparation rejects account overrides and missing Feishu configuration and blocks workspace mismatch',async t=>{
 const f=await syncFixture(t),base={plugins:existingSyncPlugin(f.repo),agents:{defaults:{workspace:f.repo}},channels:{feishu:{workspaceSync:{enabled:true}}}};
 await assert.rejects(buildConfigPlan({config:{agents:base.agents},agentId:'main',repo:f.repo,prepareSync:true}),/existing Feishu/);
 for(const workspaceSync of [{enabled:true},{enabled:false},null])await assert.rejects(buildConfigPlan({config:{...base,channels:{feishu:{accounts:{specific:{workspaceSync}}}}},agentId:'main',repo:f.repo,prepareSync:true}),/Account-specific/);
 const plan=await buildConfigPlan({config:{...base,agents:{defaults:{workspace:f.root}}},agentId:'main',repo:f.repo,prepareSync:true});assert.equal(plan.ready,false);assert.ok(plan.blockers.some(reason=>reason.includes('current host workspace')));
});
test('multiple-project synchronization plans do not preselect defaultProject or touch other project repositories',async t=>{
 const f=await syncFixture(t);
 f.manifest.projects.other={...f.entry,name:'Other',repository:'projects/other',skills:[]};await f.save();
 await git(f.repo,'add','projects.json');await git(f.repo,'commit','-m','register other');await git(f.repo,'update-ref','refs/remotes/origin/main',await git(f.repo,'rev-parse','HEAD'));
 const config={agents:{defaults:{workspace:f.repo}},channels:{feishu:{}},plugins:{load:{paths:[resolve(fileURLToPath(new URL('.',import.meta.url)))]},entries:{'agent-repo':{enabled:true,config:{agents:{main:{repo:f.repo,defaultProject:'other'}}}}}}};
 const plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,prepareSync:true});assert.equal(plan.ready,true);assert.deepEqual(plan.projects,['demo','other']);
 assert.equal(plan.patch.channels.feishu.workspaceSync.project,undefined);assert.equal(plan.patch.plugins.entries['agent-repo'].config.agents.main.defaultProject,'other');
 await assert.rejects(readFile(join(f.repo,'.git/FETCH_HEAD')),{code:'ENOENT'});
});
test('CLI --prepare-sync generates a read-only opt-in plan with strict sync schema',async t=>{
 const f=await syncFixture(t),configPath=join(f.root,'config.json');const body=JSON.stringify({plugins:existingSyncPlugin(f.repo),agents:{defaults:{workspace:f.repo}},channels:{feishu:{}}});await writeFile(configPath,body);
 const plan=await main(['plan','--agent-id','main','--repo',f.repo,'--config',configPath,'--prepare-sync']);assert.equal(plan.ready,true);assert.equal(await readFile(configPath,'utf8'),body);
 const manifest=JSON.parse(await readFile(new URL('./openclaw.plugin.json',import.meta.url),'utf8'));
 assert.equal(manifest.configSchema.properties.agents.additionalProperties.properties.sync.additionalProperties,false);
 for(const key of ['sync','sync.enabled','sync.timeoutMs','sync.branch','sync.remote','sync.preserveLocalMemory','sync.inboundChannels'])assert.ok(manifest.uiHints['agents.*.'+key].label.includes(' / '));
});

test('sync-only readiness requires existing plugin loading, binding, enablement and permission',async t=>{
 const f=await syncFixture(t),base={agents:{defaults:{workspace:f.repo}},channels:{feishu:{}},plugins:existingSyncPlugin(f.repo)};
 const plan=plugins=>buildConfigPlan({config:{...base,plugins},agentId:'main',repo:f.repo,prepareSync:true});
 assert.equal((await plan(base.plugins)).ready,true);
 for(const scenario of ['missing-binding','disabled','unloaded','denied','excluded','prompt-denied']) {
  const plugins=structuredClone(base.plugins);
  if(scenario==='missing-binding')delete plugins.entries['agent-repo'].config.agents.main;
  if(scenario==='disabled')plugins.entries['agent-repo'].enabled=false;
  if(scenario==='unloaded')plugins.load.paths=[];
  if(scenario==='denied')plugins.deny=['agent-repo'];
  if(scenario==='excluded')plugins.allow=['feishu'];
  if(scenario==='prompt-denied')plugins.entries['agent-repo'].hooks={allowConversationAccess:true,allowPromptInjection:false};
  const result=await plan(plugins);assert.equal(result.ready,false,scenario);assert.ok(result.blockers.length);
  if(scenario==='prompt-denied')assert.equal(result.patch.plugins.entries['agent-repo'].hooks.allowPromptInjection,false);
  assert.equal(result.patch.plugins.entries['agent-repo'].enabled,undefined);assert.equal(result.patch.plugins.load,undefined);
 }
 const registered=structuredClone(base.plugins);registered.load.paths=[];registered.installs={'agent-repo':{source:'path',installPath:resolve(fileURLToPath(new URL('.',import.meta.url)))}};
 assert.equal((await plan(registered)).ready,true);
});

test('migration preparation allows only unstaged ordinary native memory without reading or modifying its contents',async t=>{
 const f=await syncFixture(t);
 await mkdir(join(f.repo,'tools'));await writeFile(join(f.repo,'tools/agent-worker-policy.json'),JSON.stringify({schemaVersion:1,executorInstructions:'Execute in {projectDir}',businessDataPolicy:'Private',asyncInstructions:'End turn',delegationInstructions:'Current scope'}));
 await writeFile(join(f.repo,'MEMORY.md'),'baseline');await git(f.repo,'add','.');await git(f.repo,'commit','-m','prepare policy and memory');await git(f.repo,'update-ref','refs/remotes/origin/main',await git(f.repo,'rev-parse','HEAD'));
 await mkdir(join(f.repo,'memory'));await writeFile(join(f.repo,'MEMORY.md'),'local ordinary memory');await writeFile(join(f.repo,'memory/2026-10-12.md'),'local daily memory');
 const config={plugins:existingSyncPlugin(f.repo),agents:{defaults:{workspace:f.repo}},channels:{feishu:{}}};
 const before=await git(f.repo,'status','--porcelain=v1','-z','--untracked-files=all');
 for(const mode of ['prepareSync','prepareMigration']) {
  const plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,[mode]:true});assert.equal(plan.ready,true,mode);assert.equal(JSON.stringify(plan).includes('local daily memory'),false);
 }
 assert.equal(await git(f.repo,'status','--porcelain=v1','-z','--untracked-files=all'),before);assert.equal(await readFile(join(f.repo,'MEMORY.md'),'utf8'),'local ordinary memory');assert.equal(await readFile(join(f.repo,'memory/2026-10-12.md'),'utf8'),'local daily memory');
 const strict=structuredClone(config);strict.plugins.entries['agent-repo'].config.agents.main.sync={preserveLocalMemory:false};
 assert.equal((await buildConfigPlan({config:strict,agentId:'main',repo:f.repo,prepareSync:true})).ready,false);
 await git(f.repo,'add','memory/2026-10-12.md');assert.equal((await buildConfigPlan({config,agentId:'main',repo:f.repo,prepareSync:true})).ready,false);
});
test('native-memory preparation allowance rejects deleted, non-date and symlink files',async t=>{
 for(const scenario of ['non-date','deleted','symlink','symlink-parent'])await t.test(scenario,async t=>{
  const f=await syncFixture(t),config={plugins:existingSyncPlugin(f.repo),agents:{defaults:{workspace:f.repo}},channels:{feishu:{}}};
  if(scenario==='deleted') {await writeFile(join(f.repo,'MEMORY.md'),'baseline');await git(f.repo,'add','MEMORY.md');await git(f.repo,'commit','-m','memory');await git(f.repo,'update-ref','refs/remotes/origin/main',await git(f.repo,'rev-parse','HEAD'));await rm(join(f.repo,'MEMORY.md'));}
  if(scenario==='non-date'){await mkdir(join(f.repo,'memory'));await writeFile(join(f.repo,'memory/common.md'),'not a daily file');}
  if(scenario==='symlink')await symlink(join(f.repo,'file'),join(f.repo,'MEMORY.md'));
  if(scenario==='symlink-parent'){await mkdir(join(f.repo,'project/memory'));await writeFile(join(f.repo,'project/memory/2026-10-12.md'),'ignored project file');await symlink(join(f.repo,'project/memory'),join(f.repo,'memory'));}
  const plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,prepareSync:true});assert.equal(plan.ready,false);assert.ok(plan.blockers.some(reason=>reason.includes('local changes')));
 });
});
test('preparation rejects internally symlinked project and noncanonical Agent repo paths',async t=>{
 const f=await syncFixture(t),config={plugins:existingSyncPlugin(f.repo),agents:{defaults:{workspace:f.repo}},channels:{feishu:{}}};
 const alias=join(f.root,'repo-alias');await symlink(f.repo,alias);
 const noncanonical=await buildConfigPlan({config,agentId:'main',repo:alias,prepareSync:true});assert.equal(noncanonical.ready,false);assert.ok(noncanonical.blockers.some(reason=>reason.includes('canonical path')));
 await writeFile(join(f.repo,'.gitignore'),'project/\nprojects/\nactual-project/\n');await git(f.repo,'add','.gitignore');await git(f.repo,'commit','-m','ignore internal clone');await git(f.repo,'update-ref','refs/remotes/origin/main',await git(f.repo,'rev-parse','HEAD'));
 await rename(join(f.repo,'project'),join(f.repo,'actual-project'));await symlink(join(f.repo,'actual-project'),join(f.repo,'project'));
 const plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,prepareSync:true});assert.equal(plan.ready,false);assert.ok(plan.blockers.some(reason=>reason.includes('Project Repo')&&reason.includes('canonical path')));
});


test('synchronization preparation rejects ignored untracked registrations before marking a plan ready',async t=>{
 const f=await syncFixture(t),config={plugins:existingSyncPlugin(f.repo),agents:{defaults:{workspace:f.repo}},channels:{feishu:{}}};
 await git(f.repo,'rm','--cached','projects.json');
 await writeFile(join(f.repo,'.gitignore'),'project/\nprojects/\nprojects.json\n');
 await git(f.repo,'add','.gitignore');await git(f.repo,'commit','-m','untrack registry');
 await git(f.repo,'update-ref','refs/remotes/origin/main',await git(f.repo,'rev-parse','HEAD'));
 assert.equal(await git(f.repo,'status','--porcelain=v1'),'');
 const plan=await buildConfigPlan({config,agentId:'main',repo:f.repo,prepareSync:true});
 assert.equal(plan.ready,false);assert.ok(plan.blockers.some(reason=>reason.includes('registration must be a committed ordinary file')));
});

test('project workspacePool accepts explicit bounds and rejects paths, commands and invalid capacity',async t=>{
 const f=await fixture(t);
 for(const pool of [{enabled:true,maxSize:3},{enabled:false,maxSize:1}]){f.entry.workspacePool=pool;await f.save();assert.deepEqual((await readProjects(f.repo)).demo.workspacePool,pool);}
 for(const pool of [{enabled:true,maxSize:0},{enabled:true,maxSize:21},{enabled:'true',maxSize:2},{enabled:true,maxSize:1,path:'/tmp'},{enabled:true,maxSize:1,install:'shell'},{enabled:true}]){f.entry.workspacePool=pool;await f.save();await assert.rejects(readProjects(f.repo),/workspace pool/);}
});
