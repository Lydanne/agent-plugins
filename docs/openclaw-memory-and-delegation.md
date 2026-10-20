# OpenClaw 记忆与 Codex 委派

基线版本：OpenClaw 2026.9.5。本文说明 main Agent 与 Feishu 会话的记忆和委派机制。工作区、索引统计与定时任务状态属于各部署方的私有配置，本文不记录具体实例快照。

## 核心结论

OpenClaw 的保存、整理、检索、模型注入和 Codex 委派是五个不同环节。共享工作目录并不意味着独立 Codex CLI 自动继承 OpenClaw 的记忆检索结果。主会话必须筛选相关经验并显式交接。

## 保存与自动整理

1. **模型主动保存**：模型在任务中根据工作区规则和用户要求，调用写文件能力保存值得保留的内容。`USER.md` 用于稳定用户偏好，`MEMORY.md` 用于长期事实/决策，`memory/YYYY-MM-DD.md` 用于日常记录。能保存仍取决于工具、角色与工作区写权限。当前 Ada 的个人偏好另有按发送者隔离的画像存储入口，不能改写成群公共记忆。
2. **压缩前 memory flush**：默认启用，临近上下文压缩时，宿主在会话的私有副本里运行静默整理轮次，要求将需要保留的信息写入当天 `memory/YYYY-MM-DD.md`，内部提示不进入正常后续对话。默认软余量 4000 token，并有约 2 MB 的模型可见历史字节触发条件；具体阈值由上下文窗口和保留预算共同决定。只读/无工作区访问、CLI backend 和 heartbeat 等不适用场景会跳过。它不是“每次回复自动记一条”，触发也不证明必然产生有效记忆。
3. **dreaming 后台整理**：memory-core 默认管理每天一次的 cron。Light 整理短期材料，REM 汇总关联，Deep 在评分、召回次数和不同查询数量等条件都通过后，将合格材料提升到 `MEMORY.md`。来源可信度及可见性规则也会筛选候选；没有合格材料时可以正常完成但不提升任何条目。`DREAMS.md` 是整理日志，不等于长期记忆本体。
4. **session-memory hook**：这是另一个可配置机制，在 `/new`、`/reset` 或会话重置时保存最近的上下文到日期笔记；默认截取条数和是否启用应以实际 hook 配置为准。它不是每条消息回调的永久记忆。

会话记录持久化是保留对话，索引是让资料可被找到；二者都不等于已经总结出可靠经验。Codex 子进程的独立会话也不自动成为 OpenClaw 的记忆：主会话收到并复核结果后，才有机会进入上述保存/整理流程。

## 检索与注入

- `memory-core` 提供 `memory_search` / `memory_get`，使用 SQLite 索引，支持关键词和可选向量检索。
- 启动文件是否进入主会话、以什么预算进入，由宿主 bootstrap 与会话规则决定；日常笔记不是每轮整份注入。
- Active Memory 是额外的主动召回能力，有 Agent、会话类型和可见性条件，不应仅凭 memory-core 已加载就宣称它启用。
- 检索会话记录必须由宿主执行可见性过滤；插件不能因为 main 工作区相同就自行读取所有私聊。
- “有文件”“索引已收录”“本轮搜到”“本轮传给 Codex”“Codex 已复核”必须分别陈述。

## 部署方只读核验

在有权限的私有环境分别核验 Agent 工作区、记忆文件存在性、索引是否追平、已加载的记忆插件、memory flush 设置和 dreaming 定时任务。命令成功或调度状态正常，都不能证明某轮保存了记忆或提升了多少条经验。

不要把包含本机路径、索引数量、具体 cron 时间、其他任务信息或业务正文的运行快照提交到公共仓库。核验只说明当前实例状态，不改变配置、任务或记忆内容。

## codex-query 改动

新委派要求显式提交 `memory` 检索交接；不直接扫描任何私有记忆。主会话先检索，按需读取来源，再提交 matched/no_match/unavailable。缺失或 not_searched 会在新任务启动前拒绝。最多 3 个查询、5 个带来源片段和 12000 字符；当前事实放 context，本轮授权放 constraints，历史经验默认待复核。

该状态是主会话报告值，插件校验字段、状态一致性和预算，不证明模型真正调用了检索工具或所述经验一定正确。unavailable 允许在真实检索不可用时降级，不能伪称已读取。现有 job 不因记忆刷新重复执行；status/wait 不依赖新 memory 参数。旧版已准入 worker 的输入保持可运行并明确标记 not_searched。

## 证据与复核入口

宿主自带文档（随安装版本固定）：

- `openclaw/docs/concepts/memory.md`：文件布局、memory flush、dreaming。
- `openclaw/docs/reference/session-management-compaction/housekeeping.md`：默认阈值、触发条件与跳过场景。
- `openclaw/docs/concepts/dreaming.md`：三阶段、候选筛选、长期提升。
- `openclaw/docs/concepts/active-memory/how-it-works.md`：自动召回和会话类型限制。
- `openclaw/dist/extensions/memory-core/index.js` 的 `buildMemoryFlushPlan`：默认启用与日期文件目标。
- `openclaw/dist/bundled/session-memory/HOOK.md`：会话重置 hook。

复核可运行 `openclaw memory status --agent main --json` 与 `openclaw cron list --all --json`，注意输出含内部路径和其他任务信息，不应整份外发。
