import type {FeishuConfig} from "./types.js";
import { renderSection } from "./context-sections.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi, ClawdbotConfig } from "../runtime-api.js";

const exec = promisify(execFile);
const ROLE_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md"];
const NATIVE_ROLE_FILES = new Set([...ROLE_FILES,"HEARTBEAT.md","BOOTSTRAP.md","MEMORY.md"]);
type ContextConfig = NonNullable<FeishuConfig["workspaceSync"]>;
type Snapshot = { root: string; skills: string; roles: string; catalog: string[]; skillEntries: string[]; roleFiles: string[] };
type ExtraRole = {path: string; content: string};
const ready = new Map<string, Snapshot & {accountId: string; contextLabel?: string; extraRoles: ExtraRole[]}>();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const scope = (account: string, root: string) => JSON.stringify([account, root]);

/** Capture only committed repository metadata, never private profile/memory files. */
export async function readWorkspaceContext(root: string, config: Partial<ContextConfig> = {}): Promise<Snapshot> {
  const skillDirectories=config.skillDirectories ?? ["skills",".agents/skills"], roleFiles=config.roleFiles ?? ROLE_FILES;
  root = await realpath(root);
  const { stdout } = await exec("git", ["ls-tree", "-r", "-z", "HEAD", "--", ...skillDirectories, ...roleFiles],
    {cwd: root, timeout: 10_000, maxBuffer: 4 * 1024 * 1024});
  const rows = stdout.split("\0").filter(Boolean).sort();
  const pathOf = (row: string) => row.slice(row.indexOf("\t") + 1);
  let skills = rows.filter(row => skillDirectories.some(directory=>pathOf(row).startsWith(directory+"/")));
  const roles = rows.filter(row => /^(100644|100755) blob /.test(row) && roleFiles.includes(pathOf(row)));
  if(config.project) {
    const projectPath=config.project.path;
    if(!/^(?:project|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.test(projectPath))throw new Error("非法项目目录");
    const projectPrefix=projectPath+"/";
    const projectRoot=await realpath(join(root,projectPath));
    if(projectRoot!==join(root,projectPath))throw new Error("项目目录不能是外部软链接");
    const {stdout:top}=await exec("git",["rev-parse","--show-toplevel"],{cwd:projectRoot,timeout:10_000});
    if(await realpath(top.trim())!==projectRoot)throw new Error("项目不是独立仓库");
    const projectDirectories=skillDirectories.filter(path=>path.startsWith(projectPrefix)).map(path=>path.slice(projectPrefix.length));
    if(projectDirectories.length) {
      const {stdout}=await exec("git",["ls-tree","-r","-z","HEAD","--",...projectDirectories],{cwd:projectRoot,timeout:10_000,maxBuffer:4*1024*1024});
      skills=[...skills,...stdout.split("\0").filter(Boolean).map(row=>{
        const tab=row.indexOf("\t");return row.slice(0,tab+1)+projectPrefix+row.slice(tab+1);
      })].sort();
    }
  }
  const catalog = skills.filter(row => row.startsWith("100644 blob ") || row.startsWith("100755 blob "))
    .map(pathOf).filter(path => path.endsWith("/SKILL.md"));
  // Do not silently drop a large catalog and claim refresh succeeded.
  if (catalog.length > 500 || JSON.stringify(catalog).length > 60_000) throw new Error("技能索引超出刷新上限");
  return {root, skills: hash(skills.join("\n")), roles: hash(roles.join("\n")), catalog, skillEntries: skills,
    roleFiles: roles.map(pathOf)};
}

export async function prepareWorkspaceContext(params: {
  root: string; accountId: string; agentIds: string[]; cfg: ClawdbotConfig; config?: ContextConfig;
}): Promise<void> {
  const root = await realpath(params.root);
  // Refreshing a different checkout would falsely claim that the active role changed.
  for (const agentId of params.agentIds) {
    if (await realpath(resolveAgentWorkspaceDir(params.cfg, agentId)) !== root) {
      throw new Error("同步目录与本轮 Agent 工作区不一致");
    }
  }
  const snapshot = await readWorkspaceContext(root,params.config);
  // Native bootstrap owns the standard filenames. Additional roles are loaded
  // from committed ordinary blobs, never symlinks or untracked private files.
  const extraRoles: ExtraRole[] = [];
  let roleBytes = 0;
  for (const path of snapshot.roleFiles.filter(path => !NATIVE_ROLE_FILES.has(path))) {
    const {stdout: content} = await exec("git", ["show", `HEAD:${path}`], {cwd:root,timeout:10_000,maxBuffer:60_000});
    roleBytes += Buffer.byteLength(content,"utf8");
    if (roleBytes > 60_000) throw new Error("额外角色文件内容超出刷新上限");
    extraRoles.push({path,content});
  }
  // One atomic workspace version marks every older execution session stale by comparison.
  const directory = join(params.config?.executorStateDir ?? join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "codex-query-sessions"), "skill-versions");
  if(params.config?.publishSkills !== false) {
  await mkdir(directory, {recursive:true, mode:0o700});
  const target = join(directory, hash(root) + ".json");
  const temporary = target + "." + randomUUID();
  await writeFile(temporary, JSON.stringify({protocol:1,...snapshot}), {mode:0o600});
  await rename(temporary, target);
  }
  ready.set(scope(params.accountId, root), {...snapshot, accountId: params.accountId, contextLabel:params.config?.contextLabel, extraRoles});
}

export function clearWorkspaceContext(accountId: string): void {
  for (const [key, snapshot] of ready) if (snapshot.accountId === accountId) ready.delete(key);
}

export function registerWorkspaceContextHooks(api: OpenClawPluginApi): void {
  api.on("before_prompt_build", async (_event, ctx) => {
    if ((ctx.channel ?? ctx.messageProvider) !== "feishu" || !ctx.workspaceDir) return;
    const root = await realpath(ctx.workspaceDir);
    const snapshot = ready.get(scope(ctx.accountId ?? "default", root));
    if (!snapshot) return;
    const revision = `${snapshot.skills}:${snapshot.roles}`;
    // Native bootstrap reloads role files every turn. Supply a small, fresh repository
    // index independently of the host skill watcher's debounce/snapshot cache.
    // Keep stable system context on every request: hook output is not persisted
    // in history, and compaction must not lose the index.
    // This index is not a grant of tool access or skill eligibility.
    const marker = renderSection('WorkspaceRevision', JSON.stringify({revision,...(snapshot.contextLabel?{label:snapshot.contextLabel}:{})}));
    return {appendSystemContext: [marker,
      renderSection('WorkspaceSkills', JSON.stringify({root, skills:snapshot.catalog})),
      renderSection('WorkspaceRoleFiles', JSON.stringify({files:snapshot.roleFiles})),
      ...snapshot.extraRoles.map(role => renderSection('RoleFile', JSON.stringify(role))),
    ].join("\n")};
  });
}
