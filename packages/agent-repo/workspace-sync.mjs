import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, open, readFile, realpath, unlink, writeFile, rename, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
const exec = promisify(execFile);
class SyncBlocked extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const queues = new Map();
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
/** Administrator-bound Git synchronization; never accepts model-provided paths. */
async function syncWorkspace(config, expectedRemoteUrl) {
  if (!config?.enabled) return { ok: true };
  if (typeof config.root !== "string" || !isAbsolute(config.root)) return { ok: false, reason: "资料目录必须是绝对路径" };
  let root;
  try {
    root = await realpath(config.root);
    if (root !== resolve(config.root)) return { ok: false, reason: "资料目录不能经过软链接" };
  } catch {
    return { ok: false, reason: "资料目录不存在" };
  }
  let projectRoot;
  if (config.project) {
    try {
      if (!/^(?:project|projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.test(config.project.path)) throw Error();
      projectRoot = await realpath(join(root, config.project.path));
      if (projectRoot !== join(root, config.project.path)) throw Error();
      const { stdout: top } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot, timeout: 5e3 });
      const { stdout: parent } = await exec("git", ["rev-parse", "--show-superproject-working-tree"], { cwd: projectRoot, timeout: 5e3 });
      const { stdout: url } = await exec("git", ["remote", "get-url", config.project.remote ?? "origin"], { cwd: projectRoot, timeout: 5e3 });
      if (await realpath(top.trim()) !== projectRoot || parent.trim() || url.trim() !== config.project.expectedUrl) throw Error();
    } catch {
      return { ok: false, reason: "登记目录不是预期的独立项目仓库，请管理员核对路径、初始化状态和远端" };
    }
  }
  // Keep both repositories in one queue and retain the Agent lock through project
  // synchronization. Legacy Feishu synchronization uses the same lock filename.
  const previous = queues.get(root) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => syncLocked(root, config, expectedRemoteUrl, async (result) => {
    if (!config.project || !projectRoot) return result;
    const projectResult = await syncWorkspace({
      enabled: true,
      root: projectRoot,
      includeUpstream: false,
      timeoutMs: config.timeoutMs,
      branch: config.project.branch,
      remote: config.project.remote,
      gitEnvironment: config.gitEnvironment,
      onProgress: config.onProgress,
      repositorySubmodules: config.project.repositorySubmodules,
      submodules: config.project.submodules ?? []
    }, config.project.expectedUrl);
    if (!projectResult.ok) return { ...projectResult, reason: `Project Repo: ${projectResult.reason}` };
    return { ...result, projectHead: projectResult.rootHead,
      ...(projectResult.wikiHead ? { wikiHead: projectResult.wikiHead } : {}),
      ...(projectResult.repositoryHeads ? { projectRepositoryHeads: projectResult.repositoryHeads } : {}) };
  }));
  queues.set(root, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(root) === pending) queues.delete(root);
  }
}
async function syncLocked(root, config, expectedRemoteUrl, afterSync) {
  const timeoutMs = config.timeoutMs ?? 3e4, includeUpstream = config.includeUpstream !== false;
  const branch = config.branch ?? "main", remote = config.remote ?? "origin", upstreamRemote = config.upstreamRemote ?? "upstream";
  const gitName = (name) => /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) && !name.includes("..");
  if (![branch, remote, upstreamRemote].every(gitName)) return { ok: false, reason: "非法 Git 分支或远端名称" };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) return { ok: false, reason: "非法资料同步超时配置" };
  const signal = AbortSignal.timeout(timeoutMs);
  const progress = async (stage, status, extra = {}) => { if (config.onProgress) await config.onProgress({repository: repo, stage, status, ...extra}); };
  const git = async (cwd, args) => {
    const result = await exec("git", ["-c", "submodule.recurse=false", ...args], {
      cwd,
      signal,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10", ...config.gitEnvironment ?? { OPENCLAW_WORKSPACE_SYNC_ACTIVE: "1" } }
    });
    return args.includes("-z") ? result.stdout : result.stdout.trim();
  };
  let lockPath;
  let lock;
  let repo = "主仓库";
  let stage = "检查";
  try {
    if (await realpath(await git(root, ["rev-parse", "--show-toplevel"])) !== root) throw new SyncBlocked("资料目录不是独立 Git 仓库根目录");
    lockPath = resolve(root, await git(root, ["rev-parse", "--git-path", "ada-workspace-sync.lock"]));
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Recover only our own dead-process lock; never remove Git index.lock.
      let stale = false;
      try {
        const pid = Number((await readFile(lockPath, "utf8")).trim());
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (error2) {
            stale = error2.code === "ESRCH";
          }
        }
      } catch {
      }
      if (!stale) throw new SyncBlocked("另一个资料同步进程正在运行");
      await unlink(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    }
    await lock.writeFile(String(process.pid));
    const check = async (cwd, allowDetached, targetBranch = branch) => {
      if (await realpath(await git(cwd, ["rev-parse", "--show-toplevel"])) !== cwd) throw new SyncBlocked(`${repo}尚未初始化`);
      if (cwd === root && expectedRemoteUrl && await git(cwd, ["remote", "get-url", remote]) !== expectedRemoteUrl) throw new SyncBlocked("项目远端在同步期间变更，已保留现场");
      const currentBranch = await git(cwd, ["branch", "--show-current"]);
      if (currentBranch !== targetBranch && !(allowDetached && currentBranch === "")) throw new SyncBlocked(`${repo}不在 ${targetBranch} 分支，已保留现场`);
      for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
        if (await exists(resolve(cwd, await git(cwd, ["rev-parse", "--git-path", operation])))) throw new SyncBlocked(`${repo}存在未结束的 Git 操作`);
      }
      const changes = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"])).split("\0").filter(Boolean);
      if (await git(cwd, ["diff", "--cached", "--name-only"])) throw new SyncBlocked(`${repo}存在本地改动（暂存项），已保留现场`, "LOCAL_CHANGES");
      // The caller binds this allowance to an Agent Repo. Project recursion never
      // inherits it; no staged, renamed, deleted or non-native memory is exempt.
      const memoryPaths = [];
      for (const change of changes) {
        const path = change.slice(3);
        const permitted = cwd === root && config.preserveLocalMemory === true && !includeUpstream && [" M", "??"].includes(change.slice(0, 2)) && /^(?:MEMORY\.md|memory\/\d{4}-\d{2}-\d{2}\.md)$/.test(path);
        if (!permitted) throw new SyncBlocked(`${repo}存在本地改动，已保留现场`, "LOCAL_CHANGES");
        const file = join(cwd, path);
        if (!(await lstat(file)).isFile() || await realpath(file) !== file) throw new SyncBlocked("记忆路径不是普通文件，已保留现场");
        memoryPaths.push(path);
      }
      return memoryPaths;
    };
    const update = async (cwd, allowDetached, targetBranch = branch, targetRemote = remote) => {
      stage = "检查";
      await progress(stage, "started", {branch: targetBranch});
      await check(cwd, allowDetached, targetBranch);
      stage = "拉取";
      await progress(stage, "started", {branch: targetBranch});
      await git(cwd, ["fetch", "--no-tags", "--no-recurse-submodules", targetRemote, `refs/heads/${targetBranch}:refs/remotes/${targetRemote}/${targetBranch}`]);
      stage = "检查";
      await check(cwd, allowDetached, targetBranch);
      // An up-to-date merge alone could accept local-only commits. Verify ancestry.
      try {
        await git(cwd, ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/${targetRemote}/${targetBranch}`]);
      } catch {
        throw new SyncBlocked(`${repo}有未推送提交或分支分叉，不能快进更新`);
      }
      stage = "快进更新";
      await progress(stage, "started", {branch: targetBranch});
      const expected = await git(cwd, ["rev-parse", `refs/remotes/${targetRemote}/${targetBranch}`]);
      const memoryPaths = await check(cwd, allowDetached, targetBranch);
      const incomingPaths = (await git(cwd, ["diff", "--name-only", "-z", "HEAD", expected])).split("\0").filter(Boolean);
      if (memoryPaths.some((local) => incomingPaths.some((incoming) => incoming === local || incoming.startsWith(local + "/") || local.startsWith(incoming + "/")))) {
        throw new SyncBlocked("MEMORY_CONFLICT: local memory overlaps incoming changes; administrator review required");
      }
      await git(cwd, ["merge", "--ff-only", "--no-edit", expected]);
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      if (head !== expected) throw new SyncBlocked(`${repo}在同步期间被其他进程更改，请重试`);
      await progress("仓库同步", "completed", {branch: targetBranch, head});
      return head;
    };
    let upstreamHead;
    let rootHead;
    if (!includeUpstream) {
      rootHead = await update(root, false);
    } else {
      // Upstream integration keeps the legacy private provenance receipt. No push,
      // reset, stash or branch switching is permitted by this engine.
      await check(root, false);
      const statePath = resolve(root, await git(root, ["rev-parse", "--git-path", "ada-workspace-integration.json"]));
      const originIdentity = createHash("sha256").update(await git(root, ["remote", "get-url", remote])).digest("hex");
      const upstreamIdentity = createHash("sha256").update(await git(root, ["remote", "get-url", upstreamRemote])).digest("hex");
      let ownedHead;
      try {
        const saved = JSON.parse(await readFile(statePath, "utf8"));
        if (saved.originIdentity === originIdentity && saved.upstreamIdentity === upstreamIdentity) ownedHead = saved.head;
      } catch {
      }
      stage = `拉取 ${remote}/${branch}`;
      await git(root, ["fetch", "--no-tags", "--no-recurse-submodules", remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
      stage = `拉取 ${upstreamRemote}/${branch}`;
      await git(root, ["fetch", "--no-tags", "--no-recurse-submodules", upstreamRemote, `refs/heads/${branch}:refs/remotes/${upstreamRemote}/${branch}`]);
      await check(root, false);
      const startHead = await git(root, ["rev-parse", "HEAD"]);
      if (startHead !== ownedHead) {
        try {
          await git(root, ["merge-base", "--is-ancestor", startHead, `refs/remotes/${remote}/${branch}`]);
        } catch {
          throw new SyncBlocked("主仓库有未推送提交或分支分叉，已保留现场");
        }
      }
      const originHead = await git(root, ["rev-parse", `refs/remotes/${remote}/${branch}`]);
      upstreamHead = await git(root, ["rev-parse", `refs/remotes/${upstreamRemote}/${branch}`]);
      // Precompute conflict-free merges before mutating the index or worktree.
      let planned = startHead;
      for (const [label, target] of [[remote, originHead], [upstreamRemote, upstreamHead]]) {
        try {
          await git(root, ["merge-base", "--is-ancestor", target, planned]);
          continue;
        } catch {
        }
        try {
          await git(root, ["merge-base", "--is-ancestor", planned, target]);
          planned = target;
          continue;
        } catch {
        }
        stage = `预检 ${label}/${branch} 合并`;
        let tree;
        try {
          tree = (await git(root, ["merge-tree", "--write-tree", planned, target])).split("\n")[0];
        } catch {
          throw new SyncBlocked(`主仓库 ${label}/${branch} 合并冲突或预检失败，已保留现场`);
        }
        planned = await git(root, [
          "commit-tree",
          tree,
          "-p",
          planned,
          "-p",
          target,
          "-m",
          (config.mergeMessage ?? "chore: 同步 {remote}/{branch} 到 Ada 工作区").replaceAll("{remote}", label).replaceAll("{branch}", branch)
        ]);
      }
      await check(root, false);
      if (await git(root, ["rev-parse", "HEAD"]) !== startHead) throw new SyncBlocked("主仓库在同步期间被其他进程更改，请重试");
      stage = "应用预检后的合并";
      await git(root, ["merge", "--ff-only", "--no-edit", planned]);
      rootHead = await git(root, ["rev-parse", "HEAD"]);
      if (rootHead !== planned) throw new SyncBlocked("主仓库在同步期间被其他进程更改，请重试");
      const pendingState = `${statePath}.pending`;
      await writeFile(pendingState, JSON.stringify({ head: rootHead, originIdentity, upstreamIdentity }), { mode: 0o600 });
      await rename(pendingState, statePath);
    }
    // Discover only registered direct business submodules from the newly synced
    // project version. Never infer repositories by walking arbitrary directories.
    const entries = [...config.submodules ?? []];
    if (config.repositorySubmodules && await exists(join(root, ".gitmodules"))) {
      const modules = join(root, ".gitmodules");
      if (!(await lstat(modules)).isFile() || await realpath(modules) !== modules) throw new SyncBlocked("子模块登记必须是普通文件");
      let registrations;
      try {
        registrations = await git(root, ["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
      } catch (error) {
        if (error.code !== 1) throw error;
        registrations = "";
      }
      for (const registration of registrations.split("\0").filter(Boolean)) {
        const separator = registration.indexOf("\n"), key = registration.slice(0, separator), path = registration.slice(separator + 1);
        if (!path.startsWith("repositories/")) continue;
        if (!/^repositories\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)) throw new SyncBlocked("业务子模块必须是 repositories 下的直接仓库目录");
        const name = key.slice("submodule.".length, -".path".length);
        let targetBranch;
        try { targetBranch = await git(root, ["config", "--file", ".gitmodules", "--get", `submodule.${name}.branch`]); }
        catch (error) { if (error.code !== 1) throw error; }
        if (entries.some(entry => entry.path === path || entry.name === name)) throw new SyncBlocked("子模块同步范围重复");
        entries.push({name,path,branch:targetBranch ?? branch,remote:"origin"});
      }
    }
    const repositoryHeads = {};
    for (const entry of entries) {
      repo = entry.name === "wiki" ? "知识库" : entry.name;
      stage = "检查";
      const targetBranch = entry.branch ?? branch, targetRemote = entry.remote ?? remote;
      if (!gitName(targetBranch) || !gitName(targetRemote) || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)*$/.test(entry.name) || entry.name.split("/").some(part => part === "." || part === "..")) throw new SyncBlocked("非法子模块配置");
      if (isAbsolute(entry.path) || entry.path.split(/[\\/]/).some((part) => !part || part === ".." || part === ".")) throw new SyncBlocked("非法子模块相对路径");
      const directory = join(root, entry.path);
      if (await git(root, ["config", "--file", ".gitmodules", "--get", `submodule.${entry.name}.path`]) !== entry.path || !(await git(root, ["ls-tree", "HEAD", "--", entry.path])).startsWith("160000 commit ")) throw new SyncBlocked(`${repo}不是声明的子模块`);
      if (!await exists(join(directory, ".git"))) throw new SyncBlocked(`${repo}尚未初始化，请管理员准备子模块`);
      if (await realpath(directory) !== directory) throw new SyncBlocked(`${repo}目录不能是外部软链接`);
      if (await git(root, ["config", "--file", ".gitmodules", "--get", `submodule.${entry.name}.url`]) !== await git(directory, ["remote", "get-url", targetRemote])) throw new SyncBlocked(`${repo} ${targetRemote} 与子模块声明不一致，请管理员核对`);
      repositoryHeads[entry.name] = await update(directory, true, targetBranch, targetRemote);
    }
    return await afterSync({
      ok: true,
      rootHead,
      ...repositoryHeads.wiki ? { wikiHead: repositoryHeads.wiki } : {},
      ...config.submodules ? { repositoryHeads } : {},
      ...upstreamHead ? { upstreamHead } : {}
    });
  } catch (error) {
    const reason = signal.aborted ? "资料同步超时" : error instanceof SyncBlocked ? error.message : `${repo}${stage}失败，请管理员检查仓库权限、网络或 Git 状态`;
    await progress(stage, "failed", {reason});
    return { ok: false, reason, ...(!signal.aborted && error instanceof SyncBlocked && error.code ? {code: error.code} : {}) };
  } finally {
    if (lock) {
      await lock.close().catch(() => {
      });
      await unlink(lockPath).catch(() => {
      });
    }
  }
}
export {
  syncWorkspace
};
