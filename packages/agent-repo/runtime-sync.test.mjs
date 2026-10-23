import {readSyncHistory} from './sync-history.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepositoryRuntime } from './runtime-sync.mjs';
import { resolveConfiguration } from './configuration.mjs';
import { agentSkills, git, repositorySkills, RepositoryGitCheckError } from './repository-skills.mjs';

async function commit(root) {
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']);
}
async function skill(root, directory, name) {
  const path = join(root, directory, name, 'SKILL.md');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: Fixture skill\n---\nRead this skill.\n`);
}
async function fixture(t, { count = 1, sync = { enabled: true } } = {}) {
  const base = fileURLToPath(new URL('../../.tmp/runtime-sync-tests/', import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, '.gitignore'), '/projects/\n');
  await writeFile(join(root, 'AGENTS.md'), 'Shared role boundaries');
  await writeFile(join(root, 'SOUL.md'), 'Role identity');
  await skill(root, 'skills', 'role');
  const projects = {};
  for (const id of ['demo', 'another'].slice(0, count)) {
    const projectRoot = join(root, 'projects', id);
    await mkdir(projectRoot, { recursive: true });
    await git(projectRoot, ['init', '-b', 'main']);
    await writeFile(join(projectRoot, '.gitignore'), '/repositories/\n');
    await writeFile(join(projectRoot, 'AGENTS.md'), `${id} project rules`);
    await skill(projectRoot, '.agents/skills', `${id}-development`);
    await commit(projectRoot);
    await git(projectRoot,['remote','add','origin',`https://example.test/${id}.git`]);
    projects[id] = { name: id, url: `https://example.test/${id}.git`, branch: 'main',
      repository: `projects/${id}`, skills: [`projects/${id}/.agents/skills`], knowledge: `projects/${id}/wiki` };
  }
  await writeFile(join(root, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects }));
  await commit(root);
  const config = resolveConfiguration({ agents: { main: { repo: root, defaultProject: 'demo', sync } } });
  const binding = config.agents.main;
  const calls = [];
  const plugins={entries:{'agent-repo':{hooks:{allowConversationAccess:true}}}};
  let hostConfig = { plugins, agents: { list: [{ id: 'main', workspace: root }] } };
  const defaults = {
    synchronize: async (settings, expectedUrl) => { calls.push({ settings, expectedUrl }); return { ok: true }; },
    resolveWorkspace: (_host, agentId) => agentId === 'main' ? root : undefined,
    parseSession: key => /^agent:([^:]+):/.exec(key) ? { agentId: /^agent:([^:]+):/.exec(key)[1] } : undefined
  };
  return { root, config, binding, projects, calls, defaults,
    setHostConfig: value => { hostConfig = {plugins,...value}; },
    runtime: overrides => createRepositoryRuntime(config, () => hostConfig, { ...defaults, ...overrides }) };
}
const dispatchContext = { sessionKey: 'agent:main:feishu:group:fixture', channelId: 'feishu', messageId: 'om_fixture' };
const runContext = { agentId: 'main', sessionKey: dispatchContext.sessionKey, runId: 'run-a' };
function assertHandled(result) {
  assert.equal(result?.handled, true); assert.match(result.text, /本轮尚未开始/);
}
function assertBlocked(result) {
  assert.equal(result.outcome, 'block'); assert.equal(result.category, 'repository_sync');
}

// Hooks receive private chat content but only repository settings go into sync.
test('before_dispatch awaits both preparations using the trusted session Agent and canonical root', async t => {
  const f = await fixture(t); let releaseRoot, rootEntered;
  const rootStarted = new Promise(resolve => { rootEntered = resolve; });
  const rootWait = new Promise(resolve => { releaseRoot = resolve; });
  const runtime = f.runtime({ synchronize: async (settings, expectedUrl) => {
    f.calls.push({ settings, expectedUrl });
    if (settings.root === f.root) { rootEntered(); await rootWait; }
    return { ok: true };
  } });
  let finished = false;
  const pending = runtime.beforeDispatch({ content: 'private request body' }, { ...dispatchContext, agentId: 'untrusted-other' })
    .then(result => { finished = true; return result; });
  await rootStarted; assert.equal(finished, false); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].settings, { enabled: true, root: f.root, timeoutMs: 30000,
    branch: 'main', remote: 'origin', preserveLocalMemory: true, includeUpstream: false, submodules: [] });
  releaseRoot(); assert.equal(await pending, undefined); assert.equal(finished, true);
  assert.equal(f.calls[1].settings.root, join(f.root, 'projects/demo'));
  assert.equal(f.calls[1].settings.repositorySubmodules, true);
  assert.deepEqual(f.calls[1].settings.submodules, [{name:'wiki',path:'wiki'}]);
  assert.equal(f.calls[1].expectedUrl, f.projects.demo.url);
  assert(!JSON.stringify(f.calls).includes('private request body'));
});

test('disabled/unbound/other-channel/internal-completion/control messages never synchronize', async t => {
  const f = await fixture(t), runtime = f.runtime();
  const disabled = await fixture(t, { sync: { enabled: false } });
  assert.equal(await disabled.runtime().beforeDispatch({ content: 'normal' }, dispatchContext), undefined);
  assert.deepEqual(disabled.calls, []);
  const contexts = [
    { ...dispatchContext, sessionKey: 'agent:other:feishu:group:fixture' },
    { ...dispatchContext, sessionKey: undefined },
    { ...dispatchContext, channelId: 'slack' },
    { ...dispatchContext, channelId: 'constructor', messageId: 'undefined-forged' },
    { ...dispatchContext, messageId: 'agent_worker.completed:job-1' },
    { ...dispatchContext, messageId: 'codex_query.completed:job-1' },
    { ...dispatchContext, messageId: undefined }
  ];
  for (const context of contexts) assert.equal(await runtime.beforeDispatch({ content: 'normal' }, context), undefined);
  for (const content of ['/stop', ' /abort ', '/status@Ada details', '/subagents list', '/agents', '/help', '/commands', '/whoami', ' /ID ']) {
    assert.equal(await runtime.beforeDispatch({ content }, dispatchContext), undefined);
  }
  assert.deepEqual(f.calls, []);
});

test('skill, compaction and command-like prose still prepare the selected project', async t => {
  for (const content of ['/skill review', '/compact', '/read-wiki 查询资料', '/subagents-extra list', '请执行 /subagents list', '/help unexpected']) {
    const f=await fixture(t),runtime=f.runtime();
    assert.equal(await runtime.beforeDispatch({content},dispatchContext),undefined);
    assert.equal(f.calls.length,2,content);
  }
});

test('configured generic channels use their own trusted message ID prefix', async t => {
  const f = await fixture(t, { sync: { enabled: true, inboundChannels: { slack: { messageIdPrefix: 'slack-real-' } } } });
  const runtime = f.runtime();
  assert.equal(await runtime.beforeDispatch({ content: 'normal' }, dispatchContext), undefined);
  assert.equal(await runtime.beforeDispatch({ content: 'normal' }, { ...dispatchContext, channelId: 'slack', messageId: 'slack-real-123' }), undefined);
  assert.equal(f.calls.length, 2);
});

test('sync failure and exceptions return an explicit handled result instead of throwing or loading stale skills', async t => {
  const f = await fixture(t);
  const timeout=await f.runtime({synchronize:async()=>{throw new RepositoryGitCheckError('timeout');}}).beforeDispatch({content:'normal'},dispatchContext);
  assertHandled(timeout);assert.match(timeout.text,/Git 状态检查超时/);
  for (const synchronize of [async () => ({ ok: false, reason: 'network failed' }), async () => { throw Error('unexpected'); }, async () => undefined]) {
    assertHandled(await f.runtime({ synchronize }).beforeDispatch({ content: 'normal' }, dispatchContext));
  }
  let count = 0;
  const runtime = f.runtime({ synchronize: async () => ({ ok: ++count === 1 }) });
  assertHandled(await runtime.beforeDispatch({ content: 'normal' }, dispatchContext)); assert.equal(count, 2);
});

test('legacy root and account-level Feishu sync block native synchronization without touching repositories', async t => {
  const f = await fixture(t), runtime = f.runtime();
  for (const channels of [
    { feishu: { workspaceSync: { enabled: true } } },
    { feishu: { workspaceSync: { enabled: false }, accounts: { other: { workspaceSync: { enabled: true } } } } }
  ]) {
    f.setHostConfig({ channels }); assertHandled(await runtime.beforeDispatch({ content: 'normal' }, dispatchContext));
    await assert.rejects(runtime.prepareScope(f.binding, { agentId: 'main', projectId: 'demo' }), /新 Agent Repo 同步与旧 Feishu 同步同时启用/);
  }
  assert.deepEqual(f.calls, []);
});

test('a mismatched Agent workspace fails closed before the first synchronization call', async t => {
  const f = await fixture(t);
  const runtime = f.runtime({ resolveWorkspace: () => join(f.root, 'projects/demo') });
  assertHandled(await runtime.beforeDispatch({ content: 'normal' }, dispatchContext));
  await assert.rejects(runtime.prepareScope(f.binding, { agentId: 'main', projectId: 'demo' }), /实际工作区一致/);
  assert.deepEqual(f.calls, []);
});

test('project registration is reread after root synchronization and applies the new URL and branch', async t => {
  const f = await fixture(t), nextUrl = 'https://example.test/new-demo.git';
  const runtime = f.runtime({ synchronize: async (settings, expectedUrl) => {
    f.calls.push({ settings, expectedUrl });
    if (settings.root === f.root) {
      const manifest = JSON.parse(await readFile(join(f.root, 'projects.json'), 'utf8'));
      manifest.projects.demo.url = nextUrl; manifest.projects.demo.branch = 'release';
      await writeFile(join(f.root, 'projects.json'), JSON.stringify(manifest)); await commit(f.root);
    }
    else{await git(settings.root,['remote','set-url','origin',expectedUrl]);await git(settings.root,['branch','-m',settings.branch]);}
    return { ok: true };
  } });
  assert.equal(await runtime.beforeDispatch({ content: 'normal' }, dispatchContext), undefined);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].expectedUrl, nextUrl); assert.equal(f.calls[1].settings.branch, 'release');
});

test('multiple projects prepare only the role even with an operator defaultProject', async t => {
  const f = await fixture(t, { count: 2 }), runtime = f.runtime();
  assert.equal(f.binding.defaultProject, 'demo');
  assert.equal(await runtime.beforeDispatch({ content: 'please work in demo' }, dispatchContext), undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].settings.root, f.root);
  await assert.rejects(runtime.prepareScope(f.binding, { agentId: 'main' }), /explicit selection/);
  assert.equal(f.calls.length, 1);
});

test('explicit scope prepares its project with wiki and business discovery without using another project or role root', async t => {
  const f = await fixture(t, { count: 2 }), runtime = f.runtime();
  const catalog = await runtime.prepareScope(f.binding, { agentId: 'main', projectId: 'another', hostConfig: {} });
  assert.equal(catalog.projectId, 'another'); assert.equal(f.calls.length, 1);
  const { settings, expectedUrl } = f.calls[0];
  assert.equal(settings.root, join(f.root, 'projects/another')); assert.equal(settings.project, undefined);
  assert.deepEqual(settings.submodules, [{ name: 'wiki', path: 'wiki' }]);
  assert.equal(settings.repositorySubmodules, true);
  assert.equal(settings.preserveLocalMemory, false); assert.equal(expectedUrl, f.projects.another.url);
  assert(!catalog.skills.some(item => item.name === 'demo-development'));
  await assert.rejects(runtime.prepareScope(f.binding, { agentId: 'main', projectId: 'another', repository: 'projects/demo' }), /disagree/);
  assert.equal(f.calls.length, 1);
});

test('snapshots authorize only their current Agent/session/run and are removed when the run ends', async t => {
  const f = await fixture(t), runtime = f.runtime();
  const catalog = await repositorySkills(f.binding, { agentId: 'main' });
  await runtime.capturePrompt(runContext, catalog);
  assert.equal((await runtime.beforeAgentRun({}, runContext)).outcome, 'pass');
  for (const context of [{ ...runContext, runId: 'run-b' }, { ...runContext, sessionKey: 'agent:main:feishu:group:other' }]) {
    assertBlocked(await runtime.beforeAgentRun({}, context));
  }
  runtime.endRun(runContext); assertBlocked(await runtime.beforeAgentRun({}, runContext));
  const otherRun = { ...runContext, runId: 'run-b' }; await runtime.capturePrompt(otherRun, catalog);
  assert.equal((await runtime.beforeAgentRun({}, otherRun)).outcome, 'pass');
  assert.deepEqual(f.calls, []);
});

test('missing run identity and failed prompts cannot reuse a recent successful dispatch or snapshot', async t => {
  const f = await fixture(t), runtime = f.runtime(), catalog = await repositorySkills(f.binding);
  assert.equal(await runtime.beforeDispatch({ content: 'normal' }, dispatchContext), undefined);
  assertBlocked(await runtime.beforeAgentRun({}, runContext));
  await assert.rejects(runtime.capturePrompt({ ...runContext, runId: undefined }, catalog), /run identity/);
  assertBlocked(await runtime.beforeAgentRun({}, { ...runContext, runId: undefined }));
  await runtime.capturePrompt(runContext, catalog); runtime.promptFailure({ ...runContext, runId: 'run-b' });
  assert.equal((await runtime.beforeAgentRun({}, runContext)).outcome, 'pass');
  assertBlocked(await runtime.beforeAgentRun({}, { ...runContext, runId: 'run-b' }));
  runtime.promptFailure(runContext); assertBlocked(await runtime.beforeAgentRun({}, runContext));
  await assert.rejects(runtime.capturePrompt(runContext, catalog), /Prompt preparation failed/);
});

test('HEAD changes invalidate a captured version for both model gate and repeated prompt preparation', async t => {
  const f = await fixture(t), runtime = f.runtime(), catalog = await repositorySkills(f.binding);
  await runtime.capturePrompt(runContext, catalog);
  await writeFile(join(f.root, 'new.md'), 'new root commit'); await commit(f.root);
  assertBlocked(await runtime.beforeAgentRun({}, runContext));
  await assert.rejects(runtime.capturePrompt(runContext, await repositorySkills(f.binding)), /version changed/);
  const next = { ...runContext, runId: 'run-b' }; await runtime.capturePrompt(next, await repositorySkills(f.binding));
  assert.equal((await runtime.beforeAgentRun({}, next)).outcome, 'pass');
});

test('dirty skill and AGENTS files at role or project scope block execution; native daily memory remains allowed', async t => {
  const f = await fixture(t), runtime = f.runtime(), catalog = await repositorySkills(f.binding);
  await runtime.capturePrompt(runContext, catalog);
  const files = ['skills/role/SKILL.md', 'AGENTS.md', 'projects/demo/.agents/skills/demo-development/SKILL.md', 'projects/demo/AGENTS.md'];
  for (const file of files) {
    const path = join(f.root, file), old = await readFile(path, 'utf8'); await writeFile(path, old + '\nModified');
    assertBlocked(await runtime.beforeAgentRun({}, runContext)); await writeFile(path, old);
    assert.equal((await runtime.beforeAgentRun({}, runContext)).outcome, 'pass');
  }
  await mkdir(join(f.root, 'memory')); await writeFile(join(f.root, 'memory/2026-10-12.md'), 'shared experience');
  assert.equal((await runtime.beforeAgentRun({}, runContext)).outcome, 'pass');
});

test('role-only snapshots for multiple projects remain valid without selecting or inspecting another project', async t => {
  const f = await fixture(t, { count: 2 }), runtime = f.runtime(), catalog = await agentSkills(f.binding);
  await runtime.capturePrompt(runContext, catalog);
  await writeFile(join(f.root, 'projects/another/AGENTS.md'), 'unrelated project change');
  assert.equal((await runtime.beforeAgentRun({}, runContext)).outcome, 'pass');
  await writeFile(join(f.root, 'skills/role/SKILL.md'), 'changed role skill');
  assertBlocked(await runtime.beforeAgentRun({}, runContext));
});

test('two bound Agents synchronize only their own root and project and cannot reuse each other\'s run', async t => {
  const main = await fixture(t), helper = await fixture(t);
  const config = resolveConfiguration({ agents: { main: main.binding, helper: helper.binding } });
  const calls = [], hostConfig = {plugins:{entries:{'agent-repo':{hooks:{allowConversationAccess:true}}}}};
  const runtime = createRepositoryRuntime(config, () => hostConfig, {
    synchronize: async settings => { calls.push(settings); return { ok: true }; },
    resolveWorkspace: (_host, agentId) => config.agents[agentId]?.repo,
    parseSession: main.defaults.parseSession
  });
  const helperContext = { ...dispatchContext, sessionKey: 'agent:helper:feishu:group:fixture' };
  assert.equal(await runtime.beforeDispatch({ content: 'normal' }, helperContext), undefined);
  assert.deepEqual(calls.map(call => call.root), [helper.root, join(helper.root, 'projects/demo')]);
  const helperRun = { ...runContext, agentId: 'helper', sessionKey: helperContext.sessionKey };
  const catalog = await repositorySkills(helper.binding, { agentId: 'helper' });
  await runtime.capturePrompt(helperRun, catalog);
  assert.equal((await runtime.beforeAgentRun({}, helperRun)).outcome, 'pass');
  assertBlocked(await runtime.beforeAgentRun({}, runContext));
});

test('disabled or unbound Agents retain ordinary model execution without requiring a run snapshot', async t => {
  const f = await fixture(t, { sync: { enabled: false } }), runtime = f.runtime();
  assert.deepEqual(await runtime.beforeAgentRun({}, { ...runContext, runId: undefined }), { outcome: 'pass' });
  assert.equal(await runtime.capturePrompt({ ...runContext, runId: undefined }, undefined), undefined);
  assert.deepEqual(await runtime.beforeAgentRun({}, { agentId: 'unbound' }), { outcome: 'pass' });
  assert.deepEqual(f.calls, []);
});

test('an already expired prompt invocation cannot capture a run version or reach workspace preparation', async t => {
  const f = await fixture(t); let workspaceCalls = 0;
  const runtime = f.runtime({ resolveWorkspace: () => { workspaceCalls++; return f.root; } });
  const catalog = await repositorySkills(f.binding);
  const context = { ...runContext, hookInvocation: { assertActive: () => { throw Error('prompt invocation expired'); } } };
  await assert.rejects(runtime.capturePrompt(context, catalog), /invocation expired/);
  assert.equal(workspaceCalls, 0);
  assertBlocked(await runtime.beforeAgentRun({}, runContext));
});

test('a prompt invocation that expires during awaited workspace checks cannot publish its version', async t => {
  const f = await fixture(t); let active = true, activeChecks = 0;
  const runtime = f.runtime({ resolveWorkspace: () => { active = false; return f.root; } });
  const catalog = await repositorySkills(f.binding);
  const context = { ...runContext, hookInvocation: { assertActive: () => {
    activeChecks++; if (!active) throw Error('prompt invocation expired while awaiting workspace');
  } } };
  await assert.rejects(runtime.capturePrompt(context, catalog), /expired while awaiting workspace/);
  assert.equal(activeChecks, 2);
  assertBlocked(await runtime.beforeAgentRun({}, runContext));
});

test('rebuilding the same run replaces its project scope while preserving the Agent version', async t => {
  const f = await fixture(t, { count: 2 }), runtime = f.runtime();
  const first = await repositorySkills(f.binding, { projectId: 'demo' });
  const latest = await repositorySkills(f.binding, { projectId: 'another' });
  const agentHead = catalog => catalog.snapshot.repositorySources.find(source => source.root === f.root).head;
  assert.equal(agentHead(first), agentHead(latest));
  await runtime.capturePrompt(runContext, first);
  await runtime.capturePrompt(runContext, latest);
  assert.equal((await runtime.beforeAgentRun({}, runContext)).outcome, 'pass');
  // The old scope is no longer part of this run's current model preparation.
  await writeFile(join(f.root, 'projects/demo/AGENTS.md'), 'old project new rules');
  await commit(join(f.root, 'projects/demo'));
  assert.equal((await runtime.beforeAgentRun({}, runContext)).outcome, 'pass');
  // A change to the newly selected project must invalidate the current receipt.
  await writeFile(join(f.root, 'projects/another/AGENTS.md'), 'current project new rules');
  await commit(join(f.root, 'projects/another'));
  assertBlocked(await runtime.beforeAgentRun({}, runContext));
});


test('an internal project symlink is rejected before synchronizing its target', async t => {
  const f = await fixture(t);
  await rename(join(f.root, 'projects/demo'), join(f.root, 'projects/alias-target'));
  await symlink('alias-target', join(f.root, 'projects/demo'));
  const runtime = f.runtime();
  await assert.rejects(runtime.prepareScope(f.binding, { agentId: 'main', projectId: 'demo' }), /软链接/);
  assert.deepEqual(f.calls, []);
  assertHandled(await runtime.beforeDispatch({ content: 'normal' }, dispatchContext));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].settings.root, f.root);
});

test('a registered Git submodule cannot be synchronized as an independent project', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.gitmodules'), '[submodule "demo"]\n\tpath = projects/demo\n\turl = https://example.test/demo.git\n');
  await git(f.root, ['add', '-f', '.gitmodules', 'projects/demo']);
  await git(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'register module']);
  await git(f.root, ['submodule', 'absorbgitdirs', '--', 'projects/demo']);
  assert.equal((await git(join(f.root, 'projects/demo'), ['rev-parse', '--show-superproject-working-tree'])).trim(), f.root);
  await assert.rejects(f.runtime().prepareScope(f.binding, { agentId: 'main', projectId: 'demo' }), /独立 Git 根目录/);
  assert.deepEqual(f.calls, []);
});


test('dispatch and worker preparation across runtime instances share an Agent queue',async t=>{
 const f=await fixture(t);let entered,release;
 const inProject=new Promise(resolve=>{entered=resolve;});const wait=new Promise(resolve=>{release=resolve;});
 let paused=false;
 const synchronize=async settings=>{
  f.calls.push(settings.root);
  if(settings.root===join(f.root,'projects/demo')&&!paused){paused=true;entered();await wait;}
  return {ok:true};
 };
 const first=f.runtime({synchronize}),second=f.runtime({synchronize});
 const turn=first.beforeDispatch({content:'first'},dispatchContext);
 await inProject;
 const next=second.beforeDispatch({content:'second'},{...dispatchContext,messageId:'om_second'});
 const worker=second.prepareScope(f.binding,{agentId:'main',repository:'projects/demo'});
 await new Promise(setImmediate);
 assert.deepEqual(f.calls,[f.root,join(f.root,'projects/demo')]);
 release();assert.equal(await turn,undefined);assert.equal(await next,undefined);
 assert.equal((await worker).projectId,'demo');
 assert.deepEqual(f.calls,[f.root,join(f.root,'projects/demo'),f.root,join(f.root,'projects/demo'),join(f.root,'projects/demo')]);
});

test('external registration updates during project preparation block dispatch and worker acceptance',async t=>{
 for(const mode of ['dispatch','worker']){
  const f=await fixture(t),projectRoot=join(f.root,'projects/demo');
  const runtime=f.runtime({synchronize:async settings=>{
   if(settings.root===projectRoot){
    const manifest=JSON.parse(await readFile(join(f.root,'projects.json'),'utf8'));
    manifest.projects.demo.url='https://example.test/new-demo.git';manifest.projects.demo.branch='release';
    await writeFile(join(f.root,'projects.json'),JSON.stringify(manifest));await commit(f.root);
   }
   return {ok:true};
  }});
  if(mode==='dispatch')assertHandled(await runtime.beforeDispatch({content:'normal'},dispatchContext));
  else await assert.rejects(runtime.prepareScope(f.binding,{agentId:'main',repository:'projects/demo'}),/准备期间改变/);
  const changed=await repositorySkills(f.binding,{agentId:'main'});
  await assert.rejects(runtime.capturePrompt(runContext,changed),/分支或远端/);
  assertBlocked(await runtime.beforeAgentRun({},runContext));
 }
});

test('registration changes without a commit block snapshots while native daily memory remains eligible',async t=>{
 const f=await fixture(t),runtime=f.runtime(),catalog=await repositorySkills(f.binding,{agentId:'main'});
 await runtime.capturePrompt(runContext,catalog);
 const path=join(f.root,'projects.json'),body=await readFile(path,'utf8');
 await writeFile(path,body+'\n');assertBlocked(await runtime.beforeAgentRun({},runContext));
 await assert.rejects(runtime.prepareScope(f.binding,{agentId:'main',projectId:'demo'}),/准备期间改变/);
 assert.equal(f.calls.length,0);
 await writeFile(path,body);assert.equal((await runtime.beforeAgentRun({},runContext)).outcome,'pass');
});

test('project branch and remote changes invalidate a model snapshot without requiring a new commit',async t=>{
 const f=await fixture(t),runtime=f.runtime(),projectRoot=join(f.root,'projects/demo');
 const catalog=await repositorySkills(f.binding,{agentId:'main'});await runtime.capturePrompt(runContext,catalog);
 await git(projectRoot,['branch','-m','release']);assertBlocked(await runtime.beforeAgentRun({},runContext));
 await git(projectRoot,['branch','-m','main']);assert.equal((await runtime.beforeAgentRun({},runContext)).outcome,'pass');
 await git(projectRoot,['remote','set-url','origin','https://example.test/wrong.git']);
 assertBlocked(await runtime.beforeAgentRun({},runContext));
 await assert.rejects(runtime.capturePrompt({...runContext,runId:'another-run'},catalog),/分支或远端/);
});

test('missing or denied host hook permissions block dispatch, prompt and worker before Git synchronization',async t=>{
 const f=await fixture(t),runtime=f.runtime();
 for(const hooks of [undefined,{}, {allowConversationAccess:false},{allowConversationAccess:true,allowPromptInjection:false}]){
  f.setHostConfig({plugins:{entries:{'agent-repo':{hooks}}}});
  const result=await runtime.beforeDispatch({content:'normal'},dispatchContext);
  assertHandled(result);assert.match(result.text,/hooks 权限/);
  await assert.rejects(runtime.prepareScope(f.binding,{agentId:'main',projectId:'demo'}),/hooks 权限/);
  await assert.rejects(runtime.capturePrompt(runContext,await repositorySkills(f.binding)),/hooks 权限/);
  assertBlocked(await runtime.beforeAgentRun({},runContext));
  assert.equal(await runtime.beforeDispatch({content:'/stop'},dispatchContext),undefined);
 }
 assert.deepEqual(f.calls,[]);
 f.setHostConfig({});assert.equal(await runtime.beforeDispatch({content:'normal'},dispatchContext),undefined);
 assert.equal(f.calls.length,2);
});


test('ignored untracked registration cannot be accepted as a committed registry',async t=>{
 const f=await fixture(t),runtime=f.runtime();
 await git(f.root,['rm','--cached','projects.json']);
 await writeFile(join(f.root,'.gitignore'),'/projects/\n/projects.json\n');await commit(f.root);
 await assert.rejects(runtime.prepareScope(f.binding,{agentId:'main',projectId:'demo'}),/已提交的普通文件/);
 assert.deepEqual(f.calls,[]);
 await assert.rejects(runtime.capturePrompt(runContext,await repositorySkills(f.binding)),/已提交的普通文件/);
});

test('daily mode excludes all child sync from inbound and Worker preparation; scheduled job covers every project once',async t=>{
 const f=await fixture(t,{count:2,sync:{enabled:true,submoduleSchedule:{time:'08:00',timeZone:'Asia/Shanghai'}}}),runtime=f.runtime();
 assert.equal(await runtime.beforeDispatch({content:'normal'},dispatchContext),undefined);
 await runtime.prepareScope(f.binding,{agentId:'main',projectId:'demo'});
 assert.equal(f.calls[1].settings.repositorySubmodules,false);assert.deepEqual(f.calls[1].settings.submodules,[]);
 f.calls.length=0;
 const result=await runtime.scheduledSync('main','2026-10-13');assert.equal(result.ok,true);
 assert.equal(f.calls.length,3);
 for(const call of f.calls.slice(1)){assert.equal(call.settings.repositorySubmodules,true);assert.deepEqual(call.settings.submodules,[{name:'wiki',path:'wiki'}]);}
 const repeated=await runtime.scheduledSync('main','2026-10-13');assert.equal(repeated.skipped,true);assert.equal(f.calls.length,3);
});
test('single-project daily inbound updates roots only while child indexes remain usable',async t=>{
 const f=await fixture(t,{sync:{enabled:true,submoduleSchedule:{time:'08:00',timeZone:'Asia/Shanghai'}}}),runtime=f.runtime();
 assert.equal(await runtime.beforeDispatch({content:'normal'},dispatchContext),undefined);
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].settings.repositorySubmodules,false);assert.deepEqual(f.calls[1].settings.submodules,[]);
 const catalog=await runtime.prepareScope(f.binding,{agentId:'main'});assert(catalog.skills.length>0);
 assert.equal(f.calls.at(-1).settings.repositorySubmodules,false);
});
test('daily failures preserve diagnostics, continue independent projects and never replay that date',async t=>{
 const f=await fixture(t,{count:2,sync:{enabled:true,submoduleSchedule:{time:'08:00',timeZone:'Asia/Shanghai'}}});
 const runtime=f.runtime({synchronize:async settings=>{f.calls.push(settings);return settings.root.endsWith('/demo')?{ok:false,reason:'repositories/frontend has local changes'}:{ok:true};}});
 const result=await runtime.scheduledSync('main','2026-10-13');assert.equal(result.ok,false);assert.equal(result.failures.length,1);assert.match(result.failures[0].reason,/frontend has local changes/);assert.equal(f.calls.length,3);
 const stored=await readSyncHistory(f.root,'main','2026-10-13');assert.equal(stored.status,'failed');assert(stored.logs.some(log=>log.projectId==='demo'&&log.status==='failed'&&log.reason.includes('frontend has local changes')));
 assert.equal((await runtime.scheduledSync('main','2026-10-13')).skipped,true);assert.equal(f.calls.length,3);
});

test('explicit synchronization bypasses daily child cadence without consuming or changing the daily receipt',async t=>{
 const f=await fixture(t,{sync:{enabled:true,submoduleSchedule:{time:'08:00',timeZone:'Asia/Shanghai'}}}),runtime=f.runtime();
 await runtime.prepareScope(f.binding,{agentId:'main'});assert.equal(f.calls.at(-1).settings.repositorySubmodules,false);
 const manual=await runtime.prepareScope(f.binding,{agentId:'main',syncSubmodules:true});
 assert.equal(f.calls.at(-1).settings.repositorySubmodules,true);assert.deepEqual(f.calls.at(-1).settings.submodules,[{name:'wiki',path:'wiki'}]);assert.equal(manual.synchronization.ok,true);
 assert.equal((await runtime.scheduledSync('main','2026-10-13')).ok,true);
 const repeated=await runtime.prepareScope(f.binding,{agentId:'main',syncSubmodules:true});assert.equal(repeated.synchronization.ok,true);
 assert.equal((await runtime.scheduledSync('main','2026-10-13')).skipped,true);
 await runtime.prepareScope(f.binding,{agentId:'main'});assert.equal(f.calls.at(-1).settings.repositorySubmodules,false);
});
test('manual synchronization still blocks local state and does not leak private unexpected errors',async t=>{
 const f=await fixture(t,{sync:{enabled:true,submoduleSchedule:{time:'08:00',timeZone:'Asia/Shanghai'}}});
 await assert.rejects(f.runtime({synchronize:async()=>({ok:false,reason:'repositories/frontend has local changes'})}).prepareScope(f.binding,{agentId:'main',syncSubmodules:true}),/frontend has local changes/);
});

test('ordinary local changes skip automatic synchronization but permit dispatch, prompt and Worker preparation',async t=>{
 const f=await fixture(t),project=join(f.root,'projects/demo');
 await writeFile(join(f.root,'local-code.mjs'),'role repository code work');
 await writeFile(join(project,'local-code.mjs'),'project code work');
 const runtime=f.runtime({synchronize:async()=>({ok:false,code:'LOCAL_CHANGES',reason:'存在本地改动，已保留现场'})});
 assert.equal(await runtime.beforeDispatch({content:'private chat never logged'},dispatchContext),undefined);
 const catalog=await runtime.prepareScope(f.binding,{agentId:'main',projectId:'demo'});
 assert.equal(catalog.synchronization.skipped,true);assert.equal(catalog.synchronization.ok,false);
 await runtime.capturePrompt(runContext,catalog);assert.equal((await runtime.beforeAgentRun({},runContext)).outcome,'pass');
 const {readRepositoryLogs}=await import('./repository-log.mjs');const logs=await readRepositoryLogs(f.root,'main');
 assert.equal(logs.records.length,3);assert(logs.records.every(row=>row.status==='skipped'));
 assert(!JSON.stringify(logs).includes('private chat'));assert(logs.records.some(row=>row.repository==='projects/demo'));
 await assert.rejects(runtime.prepareScope(f.binding,{agentId:'main',projectId:'demo',syncSubmodules:true}),/本地改动/);
 await writeFile(join(project,'AGENTS.md'),'unreviewed rules');
 assertHandled(await runtime.beforeDispatch({content:'normal'},dispatchContext));
 assert.equal(await readFile(join(project,'local-code.mjs'),'utf8'),'project code work');
});


test('Agent-owned Git environment reaches inbound, Worker and scheduled sync without leaking across bindings',async t=>{
 const environment={CUSTOM_SYNC_MARKER:'1',EXTRA_HOOK_MODE:'scoped'};
 const f=await fixture(t,{sync:{enabled:true,gitEnvironment:environment,submoduleSchedule:{time:'08:00',timeZone:'UTC'}}});
 const runtime=f.runtime();
 assert.equal(await runtime.beforeDispatch({content:'normal'},dispatchContext),undefined);
 await runtime.prepareScope(f.binding,{agentId:'main',projectId:'demo'});
 assert.equal((await runtime.scheduledSync('main','2026-10-20')).ok,true);
 assert.ok(f.calls.length>=5);
 for(const call of f.calls)assert.deepEqual(call.settings.gitEnvironment,environment);
 f.calls[0].settings.gitEnvironment.CUSTOM_SYNC_MARKER='mutated by caller';
 assert.equal(f.binding.sync.gitEnvironment.CUSTOM_SYNC_MARKER,'1');
 const other=await fixture(t);await other.runtime().beforeDispatch({content:'normal'},dispatchContext);
 assert.ok(other.calls.every(call=>!Object.hasOwn(call.settings,'gitEnvironment')));
});
