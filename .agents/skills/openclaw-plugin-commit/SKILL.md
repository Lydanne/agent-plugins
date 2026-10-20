---
name: openclaw-plugin-commit
description: 在 agent-plugins 中直接同步 main，整理改动并自动 commit、push 时使用。
---

# main 提交与推送

遵守根 AGENTS.md。本仓库不使用 PR 工作流；用户已长期授权每次完成代码、文档、配置或技能改动后，在 main 上 pull、验证、commit、push，无需重复确认。不创建常规任务分支，不创建 PR。用户当次要求不提交、不推送或仅提供建议时优先遵守；无改动时不创建空提交。生产部署仍需明确授权。

## 开始前同步

1. 检查 `git status --short`、`git diff`、`git diff --cached`、分支、远端和 `git worktree list`，区分既有改动和本次任务。目标为本仓库 origin/main。
2. 工作区干净时在 main 上执行 `git pull --ff-only origin main`；当前不是 main 时安全切换，若 main 已被其他 worktree 占用则使用对应工作区并先检查其状态，不强制抢占。不擅自合入旧主题分支。
3. 有既有未提交改动时不自动 stash、reset 或丢弃；先 fetch 并判断能否安全同步。无法保留改动完成同步时说明具体阻塞。pull 失败不能声称已同步，也不要盲目覆盖远端。

## 验证、提交与推送

1. 按 [开发技能](../openclaw-plugin-develop/SKILL.md) 完成构建与隔离测试；可复用针对当前内容的有效结果。修复本次变更引入的失败，无法完成时报告阻塞；不隐藏失败或绕过检查。
2. 只用明确路径或 hunks 暂存本次任务内容。排除凭证、群消息、业务数据、运行状态、node_modules、dist 和临时文件。不要把原有暂存内容混进提交或擅自取消其暂存。
3. 检查 `git diff --cached --stat`、`git diff --cached`、`git diff --cached --check`。使用 Conventional Commits，例如 `fix(feishu): 修复接话窗口续期`。按完整任务或可交付阶段提交，不为每次保存单独提交。
4. 执行 commit 后检查全部待推送提交（`git log origin/main..main`），确认没有范围不明的其他工作，然后执行 `git push origin main`；无 upstream 时用 `git push -u origin main`。普通 push 的非快进保护必须保留。
5. 推送被拒绝时 fetch 并检查双方差异。仅需快进时使用 `git pull --ff-only origin main`；真正分叉时保留双方历史，解决冲突后重新验证再推送。不能安全判断时报告阻塞，不自动 rebase、amend 或强推。
6. 读取远端 main SHA 并核对本地提交，报告 hash、验证结果、push 状态和保留的本地改动。网络故障保留本地提交；结果不明时先查询远端再重试，不创建重复提交。
