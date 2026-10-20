import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { clearWorkspaceContext, readWorkspaceContext, prepareWorkspaceContext, registerWorkspaceContextHooks } from "./workspace-context.js";
import { syncAdaWorkspace } from "./workspace-sync.js";
const dirs: string[] = [];
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({resolveAgentWorkspaceDir: (cfg: {root: string}) => cfg.root}));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Context Test", "-c", "user.email=context@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {cwd, stdio: "pipe"});
function fixture() {
  mkdirSync(".tmp", {recursive: true}); const root = mkdtempSync(join(process.cwd(), ".tmp", "workspace-context-")); dirs.push(root);
  const state = mkdtempSync(join(process.cwd(), ".tmp", "workspace-state-")); dirs.push(state); vi.stubEnv("OPENCLAW_STATE_DIR",state);
  git(root, "init", "--initial-branch=main");
  const set = (file: string, text: string) => {mkdirSync(join(root, file, ".."), {recursive: true}); writeFileSync(join(root, file), text);};
  const commit = () => {git(root, "add", "."); git(root, "commit", "-m", "fixture");};
  set("skills/first/SKILL.md", "---\nname: first\ndescription: first\n---\nprivate full instructions");
  set("SOUL.md", "role v1"); commit();
  return {root, state, set, commit};
}
afterEach(() => {vi.unstubAllEnvs();for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});});
describe("workspace context refresh", () => {
  it("fingerprints skill bodies/support files, deletions and roles independently", async () => {
    const f = fixture(), first = await readWorkspaceContext(f.root);
    expect(first.catalog).toEqual(["skills/first/SKILL.md"]);
    f.set("skills/first/references/guide.md", "changed guide"); f.commit();
    const second = await readWorkspaceContext(f.root);
    expect(second.skills).not.toBe(first.skills); expect(second.roles).toBe(first.roles);
    f.set("SOUL.md", "role v2"); f.commit();
    const third = await readWorkspaceContext(f.root);
    expect(third.skills).toBe(second.skills); expect(third.roles).not.toBe(second.roles);
    rmSync(join(f.root, "skills"), {recursive: true}); f.commit();
    expect((await readWorkspaceContext(f.root)).catalog).toEqual([]);
  });
  it("supplies a stable current system index without skill bodies, including across session resets", async () => {
    const f = fixture();
    let hook: (event: unknown, ctx: Record<string, string>) => Promise<{appendSystemContext: string} | undefined>;
    registerWorkspaceContextHooks({on: (_name: string, fn: typeof hook) => {hook = fn;}} as unknown as OpenClawPluginApi);
    const ctx = {channel: "feishu", accountId: "test", agentId: "main", sessionKey: "test-session", sessionId: "one", workspaceDir: f.root};
    const prepare = () => prepareWorkspaceContext({root: f.root, accountId: "test", agentIds: ["main"], cfg: {root: f.root} as never});
    expect(await hook!({}, ctx)).toBeUndefined(); await prepare();
    const published=JSON.parse(readFileSync(join(f.state,"codex-query-sessions","skill-versions",createHash("sha256").update(f.root).digest("hex")+".json"),"utf8"));
    expect(published.protocol).toBe(1);expect(published.catalog).toEqual(["skills/first/SKILL.md"]);
    const first = await hook!({}, ctx);
    expect(first?.appendSystemContext).toContain("skills/first/SKILL.md");
    expect(first?.appendSystemContext).toContain("[WorkspaceSkills]");
    expect(first?.appendSystemContext).not.toContain("[SkillUsage]");
    expect(first?.appendSystemContext).not.toContain("private full instructions");
    expect(await hook!({}, ctx)).toEqual(first);
    expect(await hook!({}, {...ctx, sessionId: "two"})).toEqual(first);
    expect(await hook!({}, {...ctx, channel: "telegram"})).toBeUndefined();
    expect(await hook!({}, {...ctx, accountId: "another"})).toBeUndefined();
    rmSync(join(f.root, "skills"), {recursive: true}); f.set("skills/new/SKILL.md", "new skill"); f.commit(); await prepare();
    const changed = await hook!({}, ctx);
    expect(changed?.appendSystemContext).toContain("skills/new/SKILL.md");
    expect(changed?.appendSystemContext).not.toContain("skills/first/SKILL.md");
    clearWorkspaceContext("test");
    expect(await hook!({}, ctx)).toBeUndefined();
  });
  it("rejects a sync checkout different from the actual agent workspace", async () => {
    const f = fixture(), other = fixture();
    await expect(prepareWorkspaceContext({root: f.root, accountId: "x", agentIds: ["main"], cfg: {root: other.root} as never})).rejects.toThrow("工作区不一致");
  });
});

it('publishes configurable skill roots and roles into the configured executor store',async()=>{
 const f=fixture();f.set('custom-skills/second/SKILL.md','custom skill');f.set('ROLE.md','custom role');f.commit();
 const config={root:f.root,skillDirectories:['custom-skills'],roleFiles:['ROLE.md'],executorStateDir:join(f.state,'executor'),contextLabel:'Workspace refreshed'};
 const snapshot=await readWorkspaceContext(f.root,config);
 expect(snapshot.catalog).toEqual(['custom-skills/second/SKILL.md']);expect(snapshot.roleFiles).toEqual(['ROLE.md']);
 await prepareWorkspaceContext({root:f.root,accountId:'configured',agentIds:['test'],cfg:{root:f.root} as never,config});
 const file=join(config.executorStateDir,'skill-versions',createHash('sha256').update(f.root).digest('hex')+'.json');
 expect(JSON.parse(readFileSync(file,'utf8')).catalog).toEqual(snapshot.catalog);
 await prepareWorkspaceContext({root:f.root,accountId:'no-publish',agentIds:['test'],cfg:{root:f.root} as never,config:{...config,publishSkills:false,executorStateDir:join(f.state,'disabled')}});
 clearWorkspaceContext('configured');clearWorkspaceContext('no-publish');
});

it("injects committed extra role content into the account context without duplicating native roles or publishing content",async()=>{
 const f=fixture();f.set("ROLE.md","Custom role v1");f.commit();
 let hook: (event: unknown, ctx: Record<string,string>) => Promise<{appendSystemContext:string}|undefined>;
 registerWorkspaceContextHooks({on:(_name:string,fn:typeof hook)=>{hook=fn;}} as unknown as OpenClawPluginApi);
 const config={root:f.root,roleFiles:["ROLE.md","SOUL.md"],executorStateDir:join(f.state,"executor")};
 const prepare=()=>prepareWorkspaceContext({root:f.root,accountId:"roles",agentIds:["main"],cfg:{root:f.root} as never,config});
 const ctx={channel:"feishu",accountId:"roles",workspaceDir:f.root};
 try {
  await prepare();
  expect((await hook!({},ctx))?.appendSystemContext).toContain('"content":"Custom role v1"');
  expect((await hook!({},ctx))?.appendSystemContext).not.toContain('"path":"SOUL.md"');
  const file=join(config.executorStateDir,"skill-versions",createHash("sha256").update(f.root).digest("hex")+".json");
  expect(readFileSync(file,"utf8")).not.toContain("Custom role v1");
  f.set("ROLE.md","Uncommitted role");await prepare();
  expect((await hook!({},ctx))?.appendSystemContext).toContain("Custom role v1");
  expect((await hook!({},ctx))?.appendSystemContext).not.toContain("Uncommitted role");
  f.commit();await prepare();expect((await hook!({},ctx))?.appendSystemContext).toContain("Uncommitted role");
 } finally {clearWorkspaceContext("roles");}
});
it("does not follow role symlinks and rejects oversized custom context",async()=>{
 const f=fixture();f.set("private.txt","Never inject");symlinkSync("private.txt",join(f.root,"ROLE.md"));f.commit();
 expect((await readWorkspaceContext(f.root,{roleFiles:["ROLE.md"]})).roleFiles).toEqual([]);
 rmSync(join(f.root,"ROLE.md"));f.set("ROLE.md","x".repeat(60_001));f.commit();
 await expect(prepareWorkspaceContext({root:f.root,accountId:"large",agentIds:["main"],cfg:{root:f.root} as never,config:{root:f.root,roleFiles:["ROLE.md"]}})).rejects.toThrow();
});

it.each(['project','projects/demo'])('combines Agent roles and skills with an independent %s skill catalog under the Agent root',async projectPath=>{
 const f=fixture(),project=join(f.root,projectPath);
 f.set('.gitignore','/project/\n/projects/\n');f.commit();mkdirSync(project,{recursive:true});git(project,'init','--initial-branch=main');
 mkdirSync(join(project,'.agents/skills/business'),{recursive:true});writeFileSync(join(project,'.agents/skills/business/SKILL.md'),'business skill');
 writeFileSync(join(project,'SOUL.md'),'Project role must not replace Agent role');git(project,'add','.');git(project,'commit','-m','project');
 // Another configured prefix must not become part of the selected project index.
 const other=join(f.root,'projects/other');mkdirSync(join(other,'.agents/skills/unrelated'),{recursive:true});git(other,'init','--initial-branch=main');
 writeFileSync(join(other,'.agents/skills/unrelated/SKILL.md'),'Other project skill');git(other,'add','.');git(other,'commit','-m','other');
 const config={root:f.root,skillDirectories:['skills',projectPath+'/.agents/skills','projects/other/.agents/skills'],submodules:[],project:{path:projectPath,expectedUrl:'fixture',submodules:[]}};
 const first=await readWorkspaceContext(f.root,config);
 expect(first.catalog).toEqual([projectPath+'/.agents/skills/business/SKILL.md','skills/first/SKILL.md']);expect(first.roleFiles).toEqual(['SOUL.md']);
 writeFileSync(join(project,'.agents/skills/business/SKILL.md'),'changed business skill');git(project,'add','.');git(project,'commit','-m','changed');
 const changed=await readWorkspaceContext(f.root,config);expect(changed.skills).not.toBe(first.skills);expect(changed.roles).toBe(first.roles);
 await prepareWorkspaceContext({root:f.root,accountId:'combined',agentIds:['main'],cfg:{root:f.root} as never,config});
 const snapshot=JSON.parse(readFileSync(join(f.state,'codex-query-sessions/skill-versions',createHash('sha256').update(f.root).digest('hex')+'.json'),'utf8'));
 expect(snapshot.root).toBe(f.root);expect(snapshot.catalog).toEqual(changed.catalog);expect(JSON.stringify(snapshot)).not.toContain('Project role must');clearWorkspaceContext('combined');
});

it('rejects invalid projects paths, project symlinks and directories that are not independent Git roots',async()=>{
 const f=fixture(),other=fixture();
 for(const path of ['../outside','/absolute','projects/demo/../other','projects/demo/repositories/frontend']) {
  await expect(readWorkspaceContext(f.root,{project:{path,expectedUrl:'fixture'}})).rejects.toThrow('非法项目目录');
 }
 mkdirSync(join(f.root,'projects'));symlinkSync(other.root,join(f.root,'projects/demo'));
 await expect(readWorkspaceContext(f.root,{project:{path:'projects/demo',expectedUrl:'fixture'}})).rejects.toThrow('软链接');
 rmSync(join(f.root,'projects/demo'));mkdirSync(join(f.root,'projects/demo'));
 await expect(readWorkspaceContext(f.root,{project:{path:'projects/demo',expectedUrl:'fixture'}})).rejects.toThrow('独立仓库');
});

it('prepares the actual projects/demo prompt context after safely synchronizing both independent repositories',async()=>{
 const f=fixture(),project=join(f.root,'projects/demo'),agentRemote=join(f.state,'agent.git'),projectRemote=join(f.state,'project.git');
 f.set('.gitignore','/projects/\n');f.commit();git(f.state,'init','--bare',agentRemote);git(f.root,'remote','add','origin',agentRemote);git(f.root,'push','-u','origin','main');
 mkdirSync(join(project,'.agents/skills/business'),{recursive:true});git(project,'init','--initial-branch=main');
 writeFileSync(join(project,'.agents/skills/business/SKILL.md'),'business v1');writeFileSync(join(project,'SOUL.md'),'Project role must not replace Agent role');git(project,'add','.');git(project,'commit','-m','project');
 git(f.state,'init','--bare',projectRemote);git(project,'remote','add','origin',projectRemote);git(project,'push','-u','origin','main');
 const agent=join(f.state,'agent');git(f.state,'clone','--branch','main',agentRemote,agent);mkdirSync(join(agent,'projects'));git(agent,'clone','--branch','main',projectRemote,join(agent,'projects/demo'));
 f.set('SOUL.md','role v2');f.commit();git(f.root,'push','origin','main');
 mkdirSync(join(project,'.agents/skills/new'),{recursive:true});writeFileSync(join(project,'.agents/skills/new/SKILL.md'),'new business skill');git(project,'add','.');git(project,'commit','-m','new skill');git(project,'push','origin','main');
 const config={enabled:true,root:agent,includeUpstream:false,submodules:[],timeoutMs:20000,executorStateDir:join(f.state,'executor'),skillDirectories:['skills','projects/demo/.agents/skills'],project:{path:'projects/demo',expectedUrl:projectRemote,submodules:[]}};
 expect(await syncAdaWorkspace(config)).toMatchObject({ok:true,rootHead:git(f.root,'rev-parse','HEAD').toString().trim(),projectHead:git(project,'rev-parse','HEAD').toString().trim()});
 let hook: (event: unknown, ctx: Record<string,string>) => Promise<{appendSystemContext:string}|undefined>;
 registerWorkspaceContextHooks({on:(_name:string,fn:typeof hook)=>{hook=fn;}} as unknown as OpenClawPluginApi);
 try {
  await prepareWorkspaceContext({root:agent,accountId:'projects-sync',agentIds:['main'],cfg:{root:agent} as never,config});
  const published=JSON.parse(readFileSync(join(config.executorStateDir,'skill-versions',createHash('sha256').update(agent).digest('hex')+'.json'),'utf8'));
  expect(published.catalog).toEqual(['projects/demo/.agents/skills/business/SKILL.md','projects/demo/.agents/skills/new/SKILL.md','skills/first/SKILL.md']);
  expect(published.roleFiles).toEqual(['SOUL.md']);
  const context=await hook!({},{channel:'feishu',accountId:'projects-sync',workspaceDir:agent});
  expect(context?.appendSystemContext).toContain('projects/demo/.agents/skills/new/SKILL.md');expect(context?.appendSystemContext).not.toContain('Project role must');
 }finally{clearWorkspaceContext('projects-sync');}
});
