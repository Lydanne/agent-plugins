import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAdaWorkspace } from "./workspace-sync.js";
// These integration cases launch many real Git subprocesses while other suites run.
vi.setConfig({testTimeout: 20_000});
const dirs: string[] = [];
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=Sync Test", "-c", "user.email=sync@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {cwd, encoding:"utf8", stdio:["ignore","pipe","pipe"]}).trim();
}
function fixture() {
  mkdirSync(".tmp", {recursive:true});
  const dir=mkdtempSync(join(process.cwd(),".tmp","workspace-sync-"));dirs.push(dir);
  const wikiRemote=join(dir,"wiki.git"),rootRemote=join(dir,"root.git"),wikiSeed=join(dir,"wiki-seed"),rootSeed=join(dir,"root-seed"),root=join(dir,"live");
  git(dir,"init","--bare","--initial-branch=main",wikiRemote);git(dir,"clone",wikiRemote,wikiSeed);
  const commit=(cwd:string,text:string)=>{writeFileSync(join(cwd,"data.md"),text);git(cwd,"add","data.md");git(cwd,"commit","-m",text);git(cwd,"push","origin","main");return git(cwd,"rev-parse","HEAD");};
  commit(wikiSeed,"wiki-initial");
  git(dir,"init","--bare","--initial-branch=main",rootRemote);git(dir,"clone",rootRemote,rootSeed);
  git(rootSeed,"-c","protocol.file.allow=always","submodule","add",wikiRemote,"wiki");git(rootSeed,"add",".gitmodules","wiki");commit(rootSeed,"root-initial");
  git(dir,"clone",rootRemote,root);git(root,"-c","protocol.file.allow=always","submodule","update","--init","--","wiki");
  return {dir,root,wiki:join(root,"wiki"),wikiSeed,rootSeed,commit,config:{enabled:true,root,timeoutMs:20_000,includeUpstream:false}};
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe("deterministic workspace sync",()=>{
  function upstreamFixture() {
    const f = fixture(), upstream = join(f.dir, "upstream");
    git(f.dir, "clone", join(f.dir, "root.git"), upstream);
    git(f.root, "remote", "add", "upstream", upstream);
    git(f.root, "config", "user.name", "Sync Test");
    git(f.root, "config", "user.email", "sync@example.invalid");
    git(f.root, "config", "commit.gpgsign", "false");
    const add = (cwd: string, file: string, text: string) => {
      writeFileSync(join(cwd, file), text); git(cwd, "add", file); git(cwd, "commit", "-m", text);
      return git(cwd, "rev-parse", "HEAD");
    };
    return {...f, upstream, add, config: {...f.config, includeUpstream: true}};
  }
  it("integrates both remotes repeatedly without pushing or accepting user commits", async () => {
    const f = upstreamFixture(), originHead = f.commit(f.rootSeed, "ada fork");
    const upstreamHead = f.add(f.upstream, "upstream.md", "shared skills");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok: true, upstreamHead});
    git(f.root, "merge-base", "--is-ancestor", originHead, "HEAD");
    git(f.root, "merge-base", "--is-ancestor", upstreamHead, "HEAD");
    const first = git(f.root, "rev-parse", "HEAD");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok: true, rootHead: first});
    const nextOrigin = f.commit(f.rootSeed, "ada newer");
    const nextUpstream = f.add(f.upstream, "upstream.md", "shared newer");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok: true, upstreamHead: nextUpstream});
    git(f.root, "merge-base", "--is-ancestor", nextOrigin, "HEAD");
    expect(git(f.rootSeed, "rev-parse", "origin/main")).toBe(nextOrigin);
    f.add(f.root, "local.md", "user commit");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok: false, reason: expect.stringContaining("未推送提交")});
  }, 20_000);
  it("preflights conflicts before changing HEAD/index/worktree", async () => {
    const f = upstreamFixture(), before = git(f.root, "rev-parse", "HEAD");
    f.commit(f.rootSeed, "fork conflict"); f.add(f.upstream, "data.md", "upstream conflict");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok: false, reason: expect.stringContaining("冲突")});
    expect(git(f.root, "rev-parse", "HEAD")).toBe(before);
    expect(git(f.root, "status", "--porcelain")).toBe("");
    expect(existsSync(join(f.root, ".git", "MERGE_HEAD"))).toBe(false);
  });
  it("preserves integration provenance through a partial wiki failure", async () => {
    const f = upstreamFixture(); f.commit(f.rootSeed, "fork new"); f.add(f.upstream, "shared.md", "shared new");
    writeFileSync(join(f.wiki, "data.md"), "local wiki");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok: false});
    writeFileSync(join(f.wiki, "data.md"), "wiki-initial");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok: true});
  });
  it("requires upstream by default instead of silently falling back to origin", async () => {
    const f = fixture(), before = git(f.root, "rev-parse", "HEAD"); f.commit(f.rootSeed, "new");
    expect(await syncAdaWorkspace({...f.config, includeUpstream: undefined})).toMatchObject({ok: false});
    expect(git(f.root, "rev-parse", "HEAD")).toBe(before);
  });
  it("fast-forwards both origin/main refs on each call while preserving detached wiki and unstaged gitlink drift",async()=>{
    const f=fixture();const rootHead=f.commit(f.rootSeed,"root-new"),wikiHead=f.commit(f.wikiSeed,"wiki-new");
    expect(await syncAdaWorkspace(f.config)).toEqual({ok:true,rootHead,wikiHead});
    expect(git(f.wiki,"branch","--show-current")).toBe("");
    expect(git(f.root,"diff","--cached","--name-only")).toBe("");
    expect(git(f.root,"status","--short")).toContain("wiki");
    const latest=f.commit(f.wikiSeed,"wiki-newer");expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:true,wikiHead:latest});
  });
  it("preserves dirty root files and does not start wiki updates",async()=>{
    const f=fixture();const before=git(f.wiki,"rev-parse","HEAD");f.commit(f.wikiSeed,"new");writeFileSync(join(f.root,"data.md"),"local work");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("本地改动")});
    expect(readFileSync(join(f.root,"data.md"),"utf8")).toBe("local work");expect(git(f.wiki,"rev-parse","HEAD")).toBe(before);
  });
  it("preserves wiki changes and refuses staged gitlinks",async()=>{
    const f=fixture();writeFileSync(join(f.wiki,"data.md"),"local knowledge");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("知识库存在本地改动")});
    git(f.wiki,"add","data.md");git(f.wiki,"commit","-m","local");git(f.root,"add","wiki");
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("主仓库存在本地改动")});
    expect(git(f.root,"diff","--cached","--name-only")).toBe("wiki");
  });
  it("refuses local commits even when merge --ff-only alone would report up to date",async()=>{
    const f=fixture();writeFileSync(join(f.root,"data.md"),"local commit");git(f.root,"add","data.md");git(f.root,"commit","-m","local");
    const before=git(f.root,"rev-parse","HEAD");expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("未推送提交")});expect(git(f.root,"rev-parse","HEAD")).toBe(before);
  });
  it("does not switch a wiki task branch or fall back to the parent of an uninitialized wiki",async()=>{
    const f=fixture();git(f.wiki,"switch","-c","work");expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("不在 main")});
    git(f.root,"submodule","deinit","-f","--","wiki");expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("尚未初始化")});
  });
  it("serializes concurrent arrivals but does not cache success across conversations",async()=>{
    const f=fixture();const results=await Promise.all([syncAdaWorkspace(f.config),syncAdaWorkspace(f.config)]);expect(results.every(r=>r.ok)).toBe(true);
    expect(existsSync(join(f.root,".git","ada-workspace-sync.lock"))).toBe(false);
  });
  it("keeps another live process lock and refuses an unfinished Git operation",async()=>{
    const f=fixture(),lock=join(f.root,".git","ada-workspace-sync.lock");writeFileSync(lock,String(process.pid));
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("另一个")});expect(existsSync(lock)).toBe(true);rmSync(lock);
    writeFileSync(join(f.root,".git","MERGE_HEAD"),git(f.root,"rev-parse","HEAD"));expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("未结束")});
  });
  it("does not run the root hook's submodule-maintenance branch", async()=>{
    const f=fixture();git(f.root,"config","core.hooksPath",join(f.root,".git","hooks"));
    writeFileSync(join(f.root,".git","hooks","post-merge"),'#!/bin/sh\n[ "$OPENCLAW_WORKSPACE_SYNC_ACTIVE" = "1" ] && exit 0\ntouch unrelated-hook-ran\n',{mode:0o755});
    f.commit(f.rootSeed,"new root");expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:true});
    expect(existsSync(join(f.root,"unrelated-hook-ran"))).toBe(false);
  });
  it("rejects a changed knowledge remote rather than fetching a different repository",async()=>{
    const f=fixture();git(f.wiki,"remote","set-url","origin",join(f.dir,"root.git"));
    expect(await syncAdaWorkspace(f.config)).toMatchObject({ok:false,reason:expect.stringContaining("origin 与子模块声明不一致")});
  });
  it("fails closed on timeout and is inert when disabled",async()=>{
    const f=fixture();expect(await syncAdaWorkspace({...f.config,timeoutMs:1})).toMatchObject({ok:false,reason:"资料同步超时"});
    expect(await syncAdaWorkspace()).toEqual({ok:true});expect(await syncAdaWorkspace({enabled:false,root:"missing"})).toEqual({ok:true});
  });
});

it('syncs a configured branch and remote without requiring a wiki submodule',async()=>{
 const f=fixture();
 git(f.root,'remote','rename','origin','primary');
 git(f.root,'checkout','-b','release');git(f.root,'push','primary','release');
 const wikiHead=git(f.wiki,'rev-parse','HEAD');
 f.commit(f.wikiSeed,'new wiki ignored');
 expect(await syncAdaWorkspace({...f.config,branch:'release',remote:'primary',submodules:[],gitEnvironment:{}})).toMatchObject({ok:true,repositoryHeads:{}});
 expect(git(f.wiki,'rev-parse','HEAD')).toBe(wikiHead);
 expect(git(f.root,'branch','--show-current')).toBe('release');
});

it('updates explicitly configured submodule paths and remotes',async()=>{
 const f=fixture();
 git(f.root,'mv','wiki','knowledge');git(f.root,'commit','-am','move wiki');git(f.root,'push','origin','main');
 const knowledge=join(f.root,'knowledge');git(knowledge,'remote','rename','origin','mirror');
 const expected=f.commit(f.wikiSeed,'configured path update');
 expect(await syncAdaWorkspace({...f.config,submodules:[{name:'wiki',path:'knowledge',remote:'mirror'}]})).toMatchObject({ok:true,wikiHead:expected});
 expect(git(knowledge,'rev-parse','HEAD')).toBe(expected);
});

it('safely synchronizes an Agent Repo and its independent project with wiki while rejecting wrong remotes and dirty memory',async()=>{
 const f=fixture(),agentRemote=join(f.dir,'agent.git'),seed=join(f.dir,'agent-seed'),agent=join(f.dir,'agent-live');
 git(f.dir,'init','--bare','--initial-branch=main',agentRemote);git(f.dir,'clone',agentRemote,seed);
 writeFileSync(join(seed,'.gitignore'),'/projects/\n');writeFileSync(join(seed,'SOUL.md'),'role');git(seed,'add','.');git(seed,'commit','-m','agent');git(seed,'push','origin','main');git(f.dir,'clone',agentRemote,agent);
 mkdirSync(join(agent,'projects'));git(agent,'clone',join(f.dir,'root.git'),'projects/demo');const project=join(agent,'projects/demo');git(project,'-c','protocol.file.allow=always','submodule','update','--init','--','wiki');
 const config={enabled:true,root:agent,includeUpstream:false,submodules:[],timeoutMs:20000,project:{path:'projects/demo' as const,expectedUrl:join(f.dir,'root.git'),submodules:[{name:'wiki',path:'wiki'}]}};
 const projectHead=f.commit(f.rootSeed,'project update'),wikiHead=f.commit(f.wikiSeed,'wiki update');
 const result=await syncAdaWorkspace(config);expect(result).toMatchObject({ok:true,projectHead,wikiHead});
 const before=git(agent,'rev-parse','HEAD');f.commit(seed,'agent update');
 expect((await syncAdaWorkspace({...config,project:{...config.project,expectedUrl:'wrong'}})).ok).toBe(false);expect(git(agent,'rev-parse','HEAD')).toBe(before);
 mkdirSync(join(agent,'memory'));writeFileSync(join(agent,'memory/2026-10-10.md'),'Local experience');
 expect(await syncAdaWorkspace(config)).toMatchObject({ok:false});expect(readFileSync(join(agent,'memory/2026-10-10.md'),'utf8')).toBe('Local experience');
});

it('preserves only unstaged native memory while fast-forwarding unrelated Agent changes; overlapping remote memory blocks',async()=>{
 const f=fixture(),remote=join(f.dir,'memory-agent.git'),seed=join(f.dir,'memory-seed'),agent=join(f.dir,'memory-agent');
 git(f.dir,'init','--bare','--initial-branch=main',remote);git(f.dir,'clone',remote,seed);
 mkdirSync(join(seed,'memory'));writeFileSync(join(seed,'.gitignore'),'/project/\n');writeFileSync(join(seed,'MEMORY.md'),'baseline');writeFileSync(join(seed,'SOUL.md'),'role');git(seed,'add','.');git(seed,'commit','-m','initial');git(seed,'push','origin','main');git(f.dir,'clone',remote,agent);
 git(agent,'clone',join(f.dir,'root.git'),'project');
 const config={enabled:true,root:agent,includeUpstream:false,preserveLocalMemory:true,submodules:[],timeoutMs:20000,project:{path:'project' as const,expectedUrl:join(f.dir,'root.git'),submodules:[]}};
 mkdirSync(join(agent,'memory'));writeFileSync(join(agent,'MEMORY.md'),'local curated memory');writeFileSync(join(agent,'memory/2026-10-10.md'),'local daily memory');
 const next=f.commit(seed,'unrelated update');
 expect(await syncAdaWorkspace(config)).toMatchObject({ok:true,rootHead:next});
 expect(readFileSync(join(agent,'MEMORY.md'),'utf8')).toBe('local curated memory');expect(readFileSync(join(agent,'memory/2026-10-10.md'),'utf8')).toBe('local daily memory');expect(git(agent,'diff','--cached','--name-only')).toBe('');
 writeFileSync(join(agent,'SOUL.md'),'changed role');expect(await syncAdaWorkspace(config)).toMatchObject({ok:false});writeFileSync(join(agent,'SOUL.md'),'role');
 git(agent,'add','MEMORY.md');expect(await syncAdaWorkspace(config)).toMatchObject({ok:false});git(agent,'restore','--staged','MEMORY.md');
 expect(await syncAdaWorkspace({...config,preserveLocalMemory:false})).toMatchObject({ok:false});
 writeFileSync(join(seed,'MEMORY.md'),'remote memory');git(seed,'add','MEMORY.md');git(seed,'commit','-m','remote memory');git(seed,'push','origin','main');
 expect(await syncAdaWorkspace(config)).toMatchObject({ok:false,reason:expect.stringContaining('MEMORY_CONFLICT')});expect(git(agent,'rev-parse','HEAD')).toBe(next);expect(readFileSync(join(agent,'MEMORY.md'),'utf8')).toBe('local curated memory');
});
