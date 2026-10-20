import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { syncWorkspace } from './workspace-sync.mjs';

const directories = [];
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture({ wiki = false } = {}) {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.tmp', 'agent-repo-sync-'));
  directories.push(directory);
  const remote = join(directory, 'agent.git'), seed = join(directory, 'seed'), root = join(directory, 'live');
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'clone', remote, seed);
  const commit = (cwd, file, text, push = true) => {
    mkdirSync(join(cwd, file, '..'), { recursive: true });
    writeFileSync(join(cwd, file), text);
    git(cwd, 'add', file); git(cwd, 'commit', '-m', text);
    if (push) git(cwd, 'push', 'origin', 'main');
    return git(cwd, 'rev-parse', 'HEAD');
  };
  writeFileSync(join(seed, '.gitignore'), '/projects/\n');
  git(seed, 'add', '.gitignore');
  commit(seed, 'SOUL.md', 'role');
  commit(seed, 'MEMORY.md', 'shared baseline');
  let wikiSeed;
  if (wiki) {
    const wikiRemote = join(directory, 'wiki.git'); wikiSeed = join(directory, 'wiki-seed');
    git(directory, 'init', '--bare', '--initial-branch=main', wikiRemote);
    git(directory, 'clone', wikiRemote, wikiSeed);
    commit(wikiSeed, 'knowledge.md', 'initial knowledge');
    git(seed, '-c', 'protocol.file.allow=always', 'submodule', 'add', wikiRemote, 'wiki');
    git(seed, 'commit', '-am', 'wiki'); git(seed, 'push', 'origin', 'main');
  }
  git(directory, 'clone', remote, root);
  if (wiki) git(root, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--', 'wiki');
  return { directory, remote, root, seed, wikiSeed, commit,
    config: { enabled: true, root, timeoutMs: 20000, includeUpstream: false, submodules: wiki ? [{ name: 'wiki', path: 'wiki' }] : [] } };
}
function addProject(f) {
  const remote = join(f.directory, 'project.git'), seed = join(f.directory, 'project-seed');
  git(f.directory, 'init', '--bare', '--initial-branch=main', remote);
  git(f.directory, 'clone', remote, seed); f.commit(seed, 'AGENTS.md', 'development');
  mkdirSync(join(f.root, 'projects'), { recursive: true });
  git(f.root, 'clone', remote, 'projects/demo');
  return { remote, seed, root: join(f.root, 'projects/demo'), config: {
    ...f.config, project: { path: 'projects/demo', expectedUrl: remote, submodules: [] }
  } };
}
function addBusiness(f, p, name, branch = 'develop', initialized = true) {
  const remote = join(f.directory, `${name}.git`), seed = join(f.directory, `${name}-seed`), path = `repositories/${name}`;
  git(f.directory, 'init', '--bare', `--initial-branch=${branch}`, remote);
  git(f.directory, 'clone', remote, seed);
  f.commit(seed, '.agents/skills/review/SKILL.md', `---\nname: review\ndescription: ${name} initial\n---\n`, false);
  git(seed, 'push', 'origin', branch);
  git(p.seed, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-b', branch, remote, path);
  git(p.seed, 'commit', '-am', `register ${name}`); git(p.seed, 'push', 'origin', 'main');
  git(p.root, 'pull', '--ff-only', 'origin', 'main');
  if (initialized) git(p.root, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--', path);
  const advance = text => {
    const head = f.commit(seed, '.agents/skills/review/SKILL.md', `---\nname: review\ndescription: ${text}\n---\n`, false);
    git(seed, 'push', 'origin', branch); return head;
  };
  return {seed,remote,path,root:join(p.root,path),advance};
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function blocked(result, pattern) { assert.equal(result.ok, false); assert.match(result.reason, pattern); }

test('selected project sync advances declared business branches and their skills without staging gitlinks or changing detached HEAD', async () => {
  const f = fixture(), p = addProject(f);
  const frontend = addBusiness(f,p,'frontend','develop'), exporter = addBusiness(f,p,'demo-export','master'), hub = addBusiness(f,p,'content-service','main');
  const expected = Object.fromEntries([frontend,exporter,hub].map(item => [item.path,item.advance(`${item.path} refreshed`)]));
  const result = await syncWorkspace({...p.config,project:{...p.config.project,repositorySubmodules:true}});
  assert.equal(result.ok,true); assert.deepEqual(result.projectRepositoryHeads,expected);
  for (const item of [frontend,exporter,hub]) {
    assert.equal(git(item.root,'rev-parse','HEAD'),expected[item.path]);
    assert.equal(git(item.root,'branch','--show-current'),'');
    assert.match(readFileSync(join(item.root,'.agents/skills/review/SKILL.md'),'utf8'),/refreshed/);
  }
  assert.equal(git(p.root,'diff','--cached','--name-only'),'');
  assert.match(git(p.root,'status','--short'),/repositories\/frontend/);
});

test('discovery follows the fetched project registration and excludes undeclared and other-location repositories', async () => {
  const f = fixture(), p = addProject(f), frontend = addBusiness(f,p,'frontend','develop');
  git(frontend.seed,'branch','release'); git(frontend.seed,'push','origin','release');
  git(p.seed,'config','--file','.gitmodules',`submodule.${frontend.path}.branch`,'release');
  git(p.seed,'-c','protocol.file.allow=always','submodule','add',frontend.remote,'vendor/frontend');
  git(p.seed,'add','.gitmodules','vendor/frontend');
  f.commit(p.seed,'AGENTS.md','project new registration');
  git(p.root,'clone',frontend.remote,'repositories/unregistered');
  const unregistered=join(p.root,'repositories/unregistered'), before=git(unregistered,'rev-parse','HEAD');
  // Keep the unrelated local checkout ignored by the project safety check.
  writeFileSync(join(p.root,'.git/info/exclude'),'/repositories/unregistered/\n');
  const release = f.commit(frontend.seed,'.agents/skills/review/SKILL.md','new release skill',false);
  git(frontend.seed,'push','origin','HEAD:release');
  const result=await syncWorkspace({...p.config,project:{...p.config.project,repositorySubmodules:true}});
  assert.equal(result.ok,true); assert.deepEqual(result.projectRepositoryHeads,{[frontend.path]:release});
  assert.equal(git(unregistered,'rev-parse','HEAD'),before);
  assert.equal(existsSync(join(p.root,'vendor/frontend/.git')),false);
});

test('business sync rejects dirty/task/unpublished/uninitialized/unexpected-remote repositories without overwriting them', async t => {
  for (const scenario of ['dirty','task','unpublished','uninitialized','remote']) await t.test(scenario,async () => {
    const f=fixture(),p=addProject(f),frontend=addBusiness(f,p,'frontend','develop',scenario!=='uninitialized');
    frontend.advance('remote latest');
    let before;
    if(scenario!=='uninitialized')before=git(frontend.root,'rev-parse','HEAD');
    if(scenario==='dirty')writeFileSync(join(frontend.root,'.agents/skills/review/SKILL.md'),'local work');
    if(scenario==='task')git(frontend.root,'checkout','-b','codex/task');
    if(scenario==='unpublished')before=f.commit(frontend.root,'local.md','local unpublished',false);
    if(scenario==='remote')git(frontend.root,'remote','set-url','origin',p.remote);
    const result=await syncWorkspace({...p.config,project:{...p.config.project,repositorySubmodules:true}});
    blocked(result,/repositories\/frontend/);if(scenario==='dirty')assert.equal(result.code,'LOCAL_CHANGES');
    if(before)assert.equal(git(frontend.root,'rev-parse','HEAD'),before);
    if(scenario==='dirty')assert.equal(readFileSync(join(frontend.root,'.agents/skills/review/SKILL.md'),'utf8'),'local work');
    if(scenario==='task')assert.equal(git(frontend.root,'branch','--show-current'),'codex/task');
    if(scenario==='uninitialized')assert.equal(existsSync(join(frontend.root,'.git')),false);
    assert.equal(git(p.root,'diff','--cached','--name-only'),'');
  });
});

test('fast-forwards the root without an implicit wiki and preserves unstaged native memory without a selected project', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'MEMORY.md'), 'local reviewed memory');
  mkdirSync(join(f.root, 'memory')); writeFileSync(join(f.root, 'memory/2026-10-12.md'), 'daily experience');
  const head = f.commit(f.seed, 'SOUL.md', 'updated role');
  const result = await syncWorkspace({ ...f.config, submodules: undefined, preserveLocalMemory: true });
  assert.equal(result.ok, true); assert.equal(result.rootHead, head);
  assert.equal(readFileSync(join(f.root, 'MEMORY.md'), 'utf8'), 'local reviewed memory');
  assert.equal(readFileSync(join(f.root, 'memory/2026-10-12.md'), 'utf8'), 'daily experience');
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), '');
});

test('remote MEMORY changes fail before touching the root or project', async () => {
  const f = fixture(), p = addProject(f), before = git(f.root, 'rev-parse', 'HEAD'), projectBefore = git(p.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'MEMORY.md'), 'local memory');
  f.commit(f.seed, 'MEMORY.md', 'remote memory'); f.commit(p.seed, 'AGENTS.md', 'new development');
  blocked(await syncWorkspace({ ...p.config, preserveLocalMemory: true }), /MEMORY_CONFLICT/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(git(p.root, 'rev-parse', 'HEAD'), projectBefore);
  assert.equal(readFileSync(join(f.root, 'MEMORY.md'), 'utf8'), 'local memory');
});

test('an incoming file at a local diary ancestor fails closed', async () => {
  const f = fixture(); mkdirSync(join(f.root, 'memory')); writeFileSync(join(f.root, 'memory/2026-10-12.md'), 'local');
  f.commit(f.seed, 'memory', 'remote ancestor');
  blocked(await syncWorkspace({ ...f.config, preserveLocalMemory: true }), /MEMORY_CONFLICT/);
  assert.equal(readFileSync(join(f.root, 'memory/2026-10-12.md'), 'utf8'), 'local');
});

test('only ordinary unstaged native memory files qualify for preservation', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'MEMORY.md'), 'staged'); git(f.root, 'add', 'MEMORY.md');
  blocked(await syncWorkspace({ ...f.config, preserveLocalMemory: true }), /暂存/);
  git(f.root, 'restore', '--staged', 'MEMORY.md');
  blocked(await syncWorkspace({ ...f.config, preserveLocalMemory: false }), /本地改动/);
  git(f.root, 'restore', 'MEMORY.md');
  mkdirSync(join(f.root, 'memory')); writeFileSync(join(f.root, 'memory/note.md'), 'not a native daily file');
  blocked(await syncWorkspace({ ...f.config, preserveLocalMemory: true }), /本地改动/);
  rmSync(join(f.root, 'memory/note.md')); writeFileSync(join(f.directory, 'external.md'), 'external');
  symlinkSync(join(f.directory, 'external.md'), join(f.root, 'memory/2026-10-12.md'));
  blocked(await syncWorkspace({ ...f.config, preserveLocalMemory: true }), /普通文件/);
});

test('rejects a memory ancestor symlink and root symlink', async () => {
  const f = fixture(); const memory = join(f.directory, 'external-memory'); mkdirSync(memory);
  writeFileSync(join(memory, '2026-10-12.md'), 'external'); symlinkSync(memory, join(f.root, 'memory'));
  blocked(await syncWorkspace({ ...f.config, preserveLocalMemory: true }), /本地改动|普通文件/);
  const alias = join(f.directory, 'alias'); symlinkSync(f.root, alias);
  blocked(await syncWorkspace({ ...f.config, root: alias }), /软链接/);
});

test('synchronizes role and independent project sequentially and validates the project remote before role mutation', async () => {
  const f = fixture(), p = addProject(f), initial = git(f.root, 'rev-parse', 'HEAD');
  const rootHead = f.commit(f.seed, 'SOUL.md', 'new role'), projectHead = f.commit(p.seed, 'AGENTS.md', 'new instructions');
  blocked(await syncWorkspace({ ...p.config, project: { ...p.config.project, expectedUrl: 'unexpected' } }), /远端/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), initial);
  assert.deepEqual(await syncWorkspace(p.config), { ok: true, rootHead, repositoryHeads: {}, projectHead, projectRepositoryHeads: {} });
});

test('rejects project and projects-directory symlinks before role mutation', async () => {
  const f = fixture(), p = addProject(f), before = git(f.root, 'rev-parse', 'HEAD');
  const external = join(f.directory, 'external-project'); git(f.directory, 'clone', p.remote, external);
  rmSync(p.root, { recursive: true }); symlinkSync(external, p.root); f.commit(f.seed, 'SOUL.md', 'new role');
  blocked(await syncWorkspace(p.config), /登记目录/); assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  rmSync(join(f.root, 'projects'), { recursive: true }); const externalProjects = join(f.directory, 'external-projects');
  mkdirSync(externalProjects); git(f.directory, 'clone', p.remote, join(externalProjects, 'demo'));
  symlinkSync(externalProjects, join(f.root, 'projects'));
  blocked(await syncWorkspace(p.config), /登记目录/);
});

test('synchronizes only explicit submodules preserving detached HEAD and unstaged gitlinks', async () => {
  const f = fixture({ wiki: true }), wiki = join(f.root, 'wiki');
  const rootHead = f.commit(f.seed, 'SOUL.md', 'role new'), wikiHead = f.commit(f.wikiSeed, 'knowledge.md', 'knowledge new');
  assert.deepEqual(await syncWorkspace(f.config), { ok: true, rootHead, wikiHead, repositoryHeads: { wiki: wikiHead } });
  assert.equal(git(wiki, 'branch', '--show-current'), '');
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), '');
  assert.match(git(f.root, 'status', '--short'), /wiki/);
  const next = f.commit(f.wikiSeed, 'knowledge.md', 'knowledge newer');
  assert.equal((await syncWorkspace(f.config)).wikiHead, next);
});

test('refuses dirty, uninitialized or unexpected-remote knowledge and staged gitlinks', async () => {
  const f = fixture({ wiki: true }), wiki = join(f.root, 'wiki');
  writeFileSync(join(wiki, 'knowledge.md'), 'local knowledge');
  blocked(await syncWorkspace(f.config), /知识库存在本地改动/);
  git(wiki, 'restore', 'knowledge.md'); git(wiki, 'remote', 'set-url', 'origin', f.remote);
  blocked(await syncWorkspace(f.config), /与子模块声明不一致/);
  git(wiki, 'remote', 'set-url', 'origin', join(f.directory, 'wiki.git'));
  const head = f.commit(f.wikiSeed, 'knowledge.md', 'new knowledge');
  assert.equal((await syncWorkspace(f.config)).wikiHead, head); git(f.root, 'add', 'wiki');
  blocked(await syncWorkspace(f.config), /暂存/); git(f.root, 'restore', '--staged', 'wiki');
  git(f.root, 'submodule', 'deinit', '-f', '--', 'wiki');
  blocked(await syncWorkspace(f.config), /尚未初始化/);
});

test('refuses dirty root, Git operation and unpublished/diverged commits without altering them', async () => {
  const f = fixture(); writeFileSync(join(f.root, 'SOUL.md'), 'local role');
  blocked(await syncWorkspace(f.config), /本地改动/); assert.equal(readFileSync(join(f.root, 'SOUL.md'), 'utf8'), 'local role');
  git(f.root, 'restore', 'SOUL.md'); const before = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.root, '.git/MERGE_HEAD'), before); blocked(await syncWorkspace(f.config), /未结束/); rmSync(join(f.root, '.git/MERGE_HEAD'));
  const local = f.commit(f.root, 'SOUL.md', 'unpublished', false);
  blocked(await syncWorkspace(f.config), /未推送提交|分叉/); f.commit(f.seed, 'SOUL.md', 'remote divergence');
  blocked(await syncWorkspace(f.config), /未推送提交|分叉/); assert.equal(git(f.root, 'rev-parse', 'HEAD'), local);
});

test('does not grant memory exceptions to project repositories', async () => {
  const f = fixture(), p = addProject(f); writeFileSync(join(p.root, 'MEMORY.md'), 'project memory');
  blocked(await syncWorkspace({ ...p.config, preserveLocalMemory: true }), /Project Repo: .*本地改动/);
});

test('serializes whole role/project requests and retains legacy cross-process lock semantics', async () => {
  const f = fixture(), p = addProject(f), lock = join(f.root, '.git/ada-workspace-sync.lock');
  const results = await Promise.all([syncWorkspace(p.config), syncWorkspace(p.config), syncWorkspace(p.config)]);
  assert(results.every(result => result.ok)); assert(!existsSync(lock));
  writeFileSync(lock, String(process.pid)); blocked(await syncWorkspace(p.config), /另一个资料同步进程/);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid)); rmSync(lock);
});

test('the Agent lock remains held while a project Git hook runs', async () => {
  const f = fixture(), p = addProject(f), lock = join(f.root, '.git/ada-workspace-sync.lock');
  const hooks = join(p.root, '.git/hooks'); git(p.root, 'config', 'core.hooksPath', hooks);
  writeFileSync(join(hooks, 'post-merge'), `#!/bin/sh\n[ -f '${lock}' ] || touch lock-was-released\n`, { mode: 0o755 });
  f.commit(p.seed, 'AGENTS.md', 'project update'); assert.equal((await syncWorkspace(p.config)).ok, true);
  assert(!existsSync(join(p.root, 'lock-was-released'))); assert(!existsSync(lock));
});

test('fails closed on timeout, removes its lock, and remains inert when disabled', async () => {
  const f = fixture();
  blocked(await syncWorkspace({ ...f.config, timeoutMs: 1 }), /^资料同步超时$/);
  assert(!existsSync(join(f.root, '.git/ada-workspace-sync.lock')));
  assert.deepEqual(await syncWorkspace(), { ok: true });
  assert.deepEqual(await syncWorkspace({ enabled: false, root: 'missing' }), { ok: true });
});

test('upstream integration retains private provenance, never pushes, and refuses ordinary local commits', async () => {
  const f = fixture(), upstream = join(f.directory, 'upstream');
  git(f.directory, 'clone', f.remote, upstream); git(f.root, 'remote', 'add', 'upstream', upstream);
  git(f.root, 'config', 'user.name', 'Sync Test'); git(f.root, 'config', 'user.email', 'sync@example.invalid');
  git(f.root, 'config', 'commit.gpgsign', 'false');
  const originHead = f.commit(f.seed, 'SOUL.md', 'origin role');
  const upstreamHead = f.commit(upstream, 'shared.md', 'shared skills', false);
  const config = { ...f.config, includeUpstream: true };
  assert.equal((await syncWorkspace(config)).upstreamHead, upstreamHead);
  git(f.root, 'merge-base', '--is-ancestor', originHead, 'HEAD'); git(f.root, 'merge-base', '--is-ancestor', upstreamHead, 'HEAD');
  const head = git(f.root, 'rev-parse', 'HEAD'); assert.equal((await syncWorkspace(config)).rootHead, head);
  assert.equal(git(f.seed, 'rev-parse', 'origin/main'), originHead);
  f.commit(f.root, 'local.md', 'user commit', false); blocked(await syncWorkspace(config), /未推送提交/);
});

test('upstream conflicts are detected without creating a merge operation or touching HEAD', async () => {
  const f = fixture(), upstream = join(f.directory, 'upstream'), before = git(f.root, 'rev-parse', 'HEAD');
  git(f.directory, 'clone', f.remote, upstream); git(f.root, 'remote', 'add', 'upstream', upstream);
  f.commit(f.seed, 'SOUL.md', 'origin conflict'); f.commit(upstream, 'SOUL.md', 'upstream conflict', false);
  blocked(await syncWorkspace({ ...f.config, includeUpstream: true }), /冲突/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(git(f.root, 'status', '--porcelain'), '');
  assert(!existsSync(join(f.root, '.git/MERGE_HEAD')));
});


test('structured progress captures repository stages and safe failure diagnostics without raw stderr',async()=>{
 const f=fixture(),events=[];
 assert.equal((await syncWorkspace({...f.config,onProgress:event=>events.push(event)})).ok,true);
 assert.deepEqual(events.map(e=>e.stage),['检查','拉取','快进更新','仓库同步']);
 assert.equal(events.at(-1).status,'completed');assert.match(events.at(-1).head,/^[a-f0-9]{40}$/);
 writeFileSync(join(f.root,'untracked.txt'),'local');events.length=0;
 const failed=await syncWorkspace({...f.config,onProgress:event=>events.push(event)});
 assert.equal(failed.ok,false);assert.equal(events.at(-1).status,'failed');assert.equal(events.at(-1).reason,failed.reason);
 assert.ok(events.every(event=>!Object.hasOwn(event,'stdout')&&!Object.hasOwn(event,'stderr')));
});
