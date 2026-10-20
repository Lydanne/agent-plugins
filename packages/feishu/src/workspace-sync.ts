import type { FeishuConfig } from "./types.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, open, readFile, realpath, unlink, writeFile, rename, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
const exec = promisify(execFile);
export type WorkspaceSyncConfig = NonNullable<FeishuConfig["workspaceSync"]>;
export type WorkspaceSyncResult = { ok: true; rootHead?: string; projectHead?: string; wikiHead?: string; repositoryHeads?: Record<string,string>; upstreamHead?: string } | { ok: false; reason: string };
class SyncBlocked extends Error {}
const queues = new Map<string, Promise<unknown>>();
const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };

/** Operator-configured preflight, never exposed as a model tool or parameter. */
export async function syncAdaWorkspace(config?: WorkspaceSyncConfig, expectedRemoteUrl?: string): Promise<WorkspaceSyncResult> {
  if (!config?.enabled) return {ok: true};
  if (!isAbsolute(config.root)) return {ok: false, reason: "资料目录必须是绝对路径"};
  let root: string;
  try { root = await realpath(config.root); } catch { return {ok: false, reason: "资料目录不存在"}; }
  let projectRoot: string | undefined;
  if (config.project) {
    try {
      if(!/^(?:project|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.test(config.project.path))throw Error();
      projectRoot=await realpath(join(root,config.project.path));
      if(projectRoot!==join(root,config.project.path))throw Error();
      const {stdout: top}=await exec("git",["rev-parse","--show-toplevel"],{cwd:projectRoot,timeout:5000});
      const {stdout: parent}=await exec("git",["rev-parse","--show-superproject-working-tree"],{cwd:projectRoot,timeout:5000});
      const {stdout: url}=await exec("git",["remote","get-url",config.project.remote??"origin"],{cwd:projectRoot,timeout:5000});
      if(await realpath(top.trim())!==projectRoot||parent.trim()||url.trim()!==config.project.expectedUrl)throw Error();
    } catch {return {ok:false,reason:"登记目录不是预期的独立项目仓库，请管理员核对路径、初始化状态和远端"};}
  }
  const previous = queues.get(root) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => syncLocked(root, config, expectedRemoteUrl));
  queues.set(root, pending);
  try {
    const result=await pending;
    if(!result.ok||!config.project||!projectRoot)return result;
    const projectResult=await syncAdaWorkspace({enabled:true,root:projectRoot,includeUpstream:false,
      timeoutMs:config.timeoutMs,branch:config.project.branch,remote:config.project.remote,
      gitEnvironment:config.gitEnvironment,submodules:config.project.submodules??[]},config.project.expectedUrl);
    if(!projectResult.ok)return {ok:false,reason:`Project Repo: ${projectResult.reason}`};
    return {...result,projectHead:projectResult.rootHead,...(projectResult.wikiHead?{wikiHead:projectResult.wikiHead}:{})};
  } finally { if (queues.get(root) === pending) queues.delete(root); }
}

async function syncLocked(root: string, config: WorkspaceSyncConfig, expectedRemoteUrl?: string): Promise<WorkspaceSyncResult> {
  const timeoutMs=config.timeoutMs ?? 30_000, includeUpstream=config.includeUpstream !== false;
  const branch=config.branch ?? "main", remote=config.remote ?? "origin", upstreamRemote=config.upstreamRemote ?? "upstream";
  const gitName=(name:string)=>/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) && !name.includes("..");
  if(![branch,remote,upstreamRemote].every(gitName))return {ok:false,reason:"非法 Git 分支或远端名称"};
  const signal = AbortSignal.timeout(timeoutMs);
  const git = async (cwd: string, args: string[]) => {
    const result = await exec("git", ["-c", "submodule.recurse=false", ...args], {
      cwd, signal, maxBuffer: 1024 * 1024,
      env: {...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10", ...(config.gitEnvironment ?? {OPENCLAW_WORKSPACE_SYNC_ACTIVE: "1"})},
    });
    return args.includes("-z") ? result.stdout : result.stdout.trim();
  };
  let lockPath: string | undefined;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let repo = "主仓库";
  let stage = "检查";
  try {
    if (await realpath(await git(root, ["rev-parse", "--show-toplevel"])) !== root) throw new SyncBlocked("资料目录不是独立 Git 仓库根目录");
    lockPath = resolve(root, await git(root, ["rev-parse", "--git-path", "ada-workspace-sync.lock"]));
    try { lock = await open(lockPath, "wx", 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A crashed prior process may leave our own lock. Never touch Git index.lock.
      let stale = false;
      try {
        const pid = Number((await readFile(lockPath, "utf8")).trim());
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        }
      } catch { /* An unreadable/partial lock is not ours to remove. */ }
      if (!stale) throw new SyncBlocked("另一个资料同步进程正在运行");
      await unlink(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    }
    await lock.writeFile(String(process.pid));
    const check = async (cwd: string, allowDetached: boolean, targetBranch=branch) => {
      if (await realpath(await git(cwd, ["rev-parse", "--show-toplevel"])) !== cwd) throw new SyncBlocked(`${repo}尚未初始化`);
      if(cwd===root&&expectedRemoteUrl&&await git(cwd,["remote","get-url",remote])!==expectedRemoteUrl)throw new SyncBlocked("项目远端在同步期间变更，已保留现场");
      const currentBranch = await git(cwd, ["branch", "--show-current"]);
      if (currentBranch !== targetBranch && !(allowDetached && currentBranch === "")) throw new SyncBlocked(`${repo}不在 ${targetBranch} 分支，已保留现场`);
      for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
        if (await exists(resolve(cwd, await git(cwd, ["rev-parse", "--git-path", operation])))) throw new SyncBlocked(`${repo}存在未结束的 Git 操作`);
      }
      const changes = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"])).split("\0").filter(Boolean);
      if (await git(cwd, ["diff", "--cached", "--name-only"])) throw new SyncBlocked(`${repo}存在本地改动（暂存项），已保留现场`);
      const memoryPaths: string[] = [];
      for (const change of changes) {
        const path = change.slice(3);
        const permitted = cwd === root && config.preserveLocalMemory === true && !!config.project && !includeUpstream &&
          [" M", "??"].includes(change.slice(0,2)) && /^(?:MEMORY\.md|memory\/\d{4}-\d{2}-\d{2}\.md)$/.test(path);
        if (!permitted) throw new SyncBlocked(`${repo}存在本地改动，已保留现场`);
        const file = join(cwd,path);
        if (!(await lstat(file)).isFile() || await realpath(file) !== file) throw new SyncBlocked("记忆路径不是普通文件，已保留现场");
        memoryPaths.push(path);
      }
      return memoryPaths;
    };
    const update = async (cwd: string, allowDetached: boolean, targetBranch=branch, targetRemote=remote) => {
      stage = "检查"; await check(cwd, allowDetached, targetBranch);
      stage = "拉取";
      await git(cwd, ["fetch", "--no-tags", "--no-recurse-submodules", targetRemote, `refs/heads/${targetBranch}:refs/remotes/${targetRemote}/${targetBranch}`]);
      stage = "检查"; await check(cwd, allowDetached, targetBranch);
      // No local-only commits, merges, rebase, reset, branch switching, or pushes.
      try { await git(cwd, ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/${targetRemote}/${targetBranch}`]); }
      catch { throw new SyncBlocked(`${repo}有未推送提交或分支分叉，不能快进更新`); }
      stage = "快进更新";
      const expected = await git(cwd, ["rev-parse", `refs/remotes/${targetRemote}/${targetBranch}`]);
      const memoryPaths = await check(cwd, allowDetached, targetBranch);
      const incomingPaths = (await git(cwd, ["diff", "--name-only", "-z", "HEAD", expected])).split("\0").filter(Boolean);
      if (memoryPaths.some(local => incomingPaths.some(incoming => incoming === local || incoming.startsWith(local+"/") || local.startsWith(incoming+"/")))) {
        throw new SyncBlocked("MEMORY_CONFLICT: local memory overlaps incoming changes; administrator review required");
      }
      await git(cwd, ["merge", "--ff-only", "--no-edit", expected]);
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      if (head !== expected) throw new SyncBlocked(`${repo}在同步期间被其他进程更改，请重试`);
      return head;
    };
    let upstreamHead: string | undefined;
    let rootHead: string;
    if (!includeUpstream) {
      rootHead = await update(root, false);
    } else {
      // Only our exact last successful integration may be ahead of origin.
      // Never infer ownership from a commit message or silently push local merges.
      await check(root, false);
      const statePath = resolve(root, await git(root, ["rev-parse", "--git-path", "ada-workspace-integration.json"]));
      const originIdentity = createHash("sha256").update(await git(root, ["remote", "get-url", remote])).digest("hex");
      const upstreamIdentity = createHash("sha256").update(await git(root, ["remote", "get-url", upstreamRemote])).digest("hex");
      let ownedHead: string | undefined;
      try {
        const saved = JSON.parse(await readFile(statePath, "utf8"));
        if (saved.originIdentity === originIdentity && saved.upstreamIdentity === upstreamIdentity) ownedHead = saved.head;
      } catch { /* Missing/invalid provenance never authorizes local commits. */ }
      stage = `拉取 ${remote}/${branch}`;
      await git(root, ["fetch", "--no-tags", "--no-recurse-submodules", remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
      stage = `拉取 ${upstreamRemote}/${branch}`;
      await git(root, ["fetch", "--no-tags", "--no-recurse-submodules", upstreamRemote, `refs/heads/${branch}:refs/remotes/${upstreamRemote}/${branch}`]);
      await check(root, false);
      const startHead = await git(root, ["rev-parse", "HEAD"]);
      if (startHead !== ownedHead) {
        try { await git(root, ["merge-base", "--is-ancestor", startHead, `refs/remotes/${remote}/${branch}`]); }
        catch { throw new SyncBlocked("主仓库有未推送提交或分支分叉，已保留现场"); }
      }
      const originHead = await git(root, ["rev-parse", `refs/remotes/${remote}/${branch}`]);
      upstreamHead = await git(root, ["rev-parse", `refs/remotes/${upstreamRemote}/${branch}`]);
      // Precompute both integrations without touching the index/worktree. Conflict
      // detection and missing commit identity fail before any checkout mutation.
      let planned = startHead;
      for (const [label, target] of [[remote, originHead], [upstreamRemote, upstreamHead]]) {
        try { await git(root, ["merge-base", "--is-ancestor", target, planned]); continue; } catch { /* not already included */ }
        try { await git(root, ["merge-base", "--is-ancestor", planned, target]); planned = target; continue; } catch { /* needs merge */ }
        stage = `预检 ${label}/${branch} 合并`;
        let tree: string;
        try { tree = (await git(root, ["merge-tree", "--write-tree", planned, target])).split("\n")[0]; }
        catch { throw new SyncBlocked(`主仓库 ${label}/${branch} 合并冲突或预检失败，已保留现场`); }
        // Deterministic metadata is not used as authority; only the private receipt is.
        planned = await git(root, ["commit-tree", tree, "-p", planned, "-p", target,
          "-m", (config.mergeMessage ?? "chore: 同步 {remote}/{branch} 到 Ada 工作区").replaceAll("{remote}",label).replaceAll("{branch}",branch)]);
      }
      await check(root, false);
      if (await git(root, ["rev-parse", "HEAD"]) !== startHead) throw new SyncBlocked("主仓库在同步期间被其他进程更改，请重试");
      stage = "应用预检后的合并";
      await git(root, ["merge", "--ff-only", "--no-edit", planned]);
      rootHead = await git(root, ["rev-parse", "HEAD"]);
      if (rootHead !== planned) throw new SyncBlocked("主仓库在同步期间被其他进程更改，请重试");
      const pendingState = `${statePath}.pending`;
      await writeFile(pendingState, JSON.stringify({head: rootHead, originIdentity, upstreamIdentity}), {mode: 0o600});
      await rename(pendingState, statePath);
    }
    const repositoryHeads: Record<string,string> = {};
    for(const entry of config.submodules ?? [{name:"wiki",path:"wiki"}]) {
      repo=entry.name==="wiki"?"知识库":entry.name;stage="检查";
      const targetBranch=entry.branch ?? branch, targetRemote=entry.remote ?? remote;
      if(!gitName(targetBranch)||!gitName(targetRemote)||!/^[A-Za-z0-9_-]+$/.test(entry.name))throw new SyncBlocked("非法子模块配置");
      if(isAbsolute(entry.path)||entry.path.split(/[\\/]/).some(part=>!part||part===".."||part==="."))throw new SyncBlocked("非法子模块相对路径");
      const directory=join(root,entry.path);
      if(await git(root,["config","--file",".gitmodules","--get",`submodule.${entry.name}.path`])!==entry.path ||
        !(await git(root,["ls-tree","HEAD","--",entry.path])).startsWith("160000 commit "))throw new SyncBlocked(`${repo}不是声明的子模块`);
      if(!await exists(join(directory,".git")))throw new SyncBlocked(`${repo}尚未初始化，请管理员准备子模块`);
      if(await realpath(directory)!==directory)throw new SyncBlocked(`${repo}目录不能是外部软链接`);
      if(await git(root,["config","--file",".gitmodules","--get",`submodule.${entry.name}.url`])!==await git(directory,["remote","get-url",targetRemote]))throw new SyncBlocked(`${repo} ${targetRemote} 与子模块声明不一致，请管理员核对`);
      repositoryHeads[entry.name]=await update(directory,true,targetBranch,targetRemote);
    }
    return {ok:true,rootHead,...(repositoryHeads.wiki?{wikiHead:repositoryHeads.wiki}:{}),
      ...(config.submodules?{repositoryHeads}:{}),...(upstreamHead?{upstreamHead}:{})};
  } catch (error) {
    return {ok: false, reason: signal.aborted ? "资料同步超时" : error instanceof SyncBlocked ? error.message : `${repo}${stage}失败，请管理员检查仓库权限、网络或 Git 状态`};
  } finally {
    if (lock) { await lock.close().catch(() => {}); await unlink(lockPath!).catch(() => {}); }
  }
}
