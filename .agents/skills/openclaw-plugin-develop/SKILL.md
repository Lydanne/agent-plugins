---
name: openclaw-plugin-develop
description: 在 agent-plugins 项目开发或修复插件、升级上游、执行隔离构建测试时使用。
---

# 插件开发与验证

先读根目录 AGENTS.md、目标包 README.md、package.json，涉及上游迁移时读 UPSTREAM.md。每个 packages 子目录是独立插件；根目录 .agents/skills 是仓库开发技能，packages/feishu/skills 是随插件交付的业务技能。

## 开始工作

- 检查 `git status --short`、暂存区和未暂存差异；未跟踪文件也可能是既有成果，不能当成此次新增内容。记录任务前状态，保留无关改动。
- 通过 `git rev-parse --verify HEAD` 判断是否有首个提交。已有历史且需要隔离时用 worktree；没有 HEAD 时不能假定可创建 worktree 或计算提交差异。
- 直接在 main 开发，不创建常规主题分支或 PR。开始前按 [提交技能](../openclaw-plugin-commit/SKILL.md) 检查工作区并执行 `git pull --ff-only origin main`；不得为同步而丢弃、自动 stash 或覆盖他人改动。
- 从根 package.json、包 engines 和 README 核对运行环境。缺依赖时用 `pnpm install --frozen-lockfile --ignore-scripts`，不要顺带升级锁文件。
- 查看当前宿主是否直接加载仓库路径；若是，源码或 dist 改动可能在下次加载时生效。需要运行代码变更时优先独立 checkout；不擅自重启宿主、切换配置或替换生产插件。

## 实现边界

- 仅使用公开 `openclaw/plugin-sdk` 子路径；不引入相邻 OpenClaw 源码或内部模块。公开入口也可能有宿主信任限制，加载成功不能证明通道可启动。
- 保留 LICENSE 和 UPSTREAM.md；升级上游时记录确切版本、保留的本地差异及迁移范围。
- 测试使用 mock 和临时状态，不读取真实凭证、群消息、SQLite 或环境配置，不向飞书发消息。

## 验证与交付

变更后从仓库根执行 `pnpm typecheck`、`pnpm build` 和 `pnpm test`。为整个测试命令设置独立目录，覆盖所有包；现有飞书测试脚本还会创建自己的临时目录：

```sh
(
  task_state_dir=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-plugins-test.XXXXXX") || exit 1
  trap 'rm -rf -- "$task_state_dir"' EXIT
  export OPENCLAW_STATE_DIR="$task_state_dir"
  export OPENCLAW_CONFIG_PATH="$task_state_dir/openclaw.json"
  pnpm test
)
```

构建会生成 dist 并重写飞书 openclaw.plugin.json 的配置 schema；检查生成差异是否属于任务。执行 `git diff --check`，另行检查新增未跟踪文件（该命令不覆盖它们）。

交付说明行为变化、实际通过/失败的命令及验证边界。`pnpm typecheck` 严格检查全部生产 TypeScript 及 SDK 类型正反例，现有运行测试仍是选定集合；缺失的公开 SDK 声明仅在 `src/openclaw-sdk-compat.d.ts` 补充精确接口并核对当前发布实现，优先复用已有公开类型。SDK 新增自带声明时移除对应兼容模块，不升级依赖以绕过错误、不导入宿主私有模块、不用宽泛 any 掩盖问题；也不要把构建通过表述为全量测试、真实飞书验证或上线成功。

每次完成改动与验证后，按 [提交技能](../openclaw-plugin-commit/SKILL.md) 在 main 自动提交本次任务文件并执行 `git push origin main`；这是项目长期授权，无需再次询问。用户当次要求不提交或不推送时遵守。不创建 PR，不自动部署。
