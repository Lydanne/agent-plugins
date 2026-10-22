# Upstream

Source: https://github.com/openclaw/openclaw
Tag: v2026.9.5
Commit: ec9c1a13db8938e5a3eaa51fca2e981cde2395a9
Directory: extensions/feishu
License: MIT; original license retained at repository root.

Independent derivative; not an official OpenClaw package.

Context protocol v1: ship Feishu message semantics and AgentRepo data contracts
as plugin-owned skills. Keep a short per-turn authorization boundary, dynamic
fields and source-withdrawal notices; retain legacy history parsing. Additive
fields use JSON data sections without repeating the field manual in each turn.

OpenClaw 2026.10.2 compatibility: command authorization and alias resolution use
the public `command-auth-native` SDK entrypoint, and text-command policy uses
`command-surface`. Both entrypoints exist in the pinned 2026.9.5 baseline;
the removed `command-auth` entrypoint is no longer required.

OpenClaw 2026.10.5 compatibility: remove the unused `readJsonFileWithFallback`
re-export from the runtime barrel. The current public `json-store` SDK no longer
exports it; retaining the unused re-export prevents Feishu runtime registration.

Standalone test fixture helpers adapted from upstream commit 70446423d62683d6253b673b8eb4c04622e58d89 (MIT).

Local deviation: explicit same-sender correction prefixes can steer the active single-agent turn. Accepted corrections retire the original preview and bind subsequent delivery to the correction message; normal followups, host authority, and session overrides remain unchanged.

- 群内真实 @ 默认读取触发时间之前最多 20 条飞书消息；历史片段默认 12000 字符，超限淘汰最早整条消息，复用上下文可见性检查，超时降级并避免重复注入本地缓存。空 @ 进入主会话接话。

- 可选 `workingCard.enabled`：使用 Ada GIF 作为单 Agent 真人轮次的工作中卡片，结果原地替换，群内另回复结果并 @ 原提问者、引用最终结论。使用 IM 卡片更新，不使用 CardKit 流式 API；默认关闭，不修改宿主配置。

- 同发送者显式催问绕过普通 FIFO，基于阶段快照/公开事件迁移工作 GIF 卡片；新增仅记录当前轮进度的 `ada_task_progress` 工具，先新发再撤回旧占位卡，不重新执行业务。

- 可选 `workspaceSync` 在普通真人对话进入模型前固定同步 Ada 根仓库与 wiki 的 origin/main；仅安全快进、串行并有超时，失败阻止新轮执行，不暴露为模型工具。

- 配置页通过公开 `uiHints` 提供同页中英对照，覆盖全局、账号、群聊和私聊；构建将文案保留到插件清单，不改配置键、枚举或校验规则。

- 上下文片段统一使用 Context/Guidance/Metadata/Notice/Request 类型前缀，拆分画像数据与指导、引用与当前请求；去重读取器兼容新旧会话文本，保持宿主权限和消息角色不变。

- codex-query 新 run 要求主会话提交有状态、来源和长度预算的记忆检索交接；不直接读写宿主私有记忆，旧 worker 兼容未检索标记，记忆刷新不改变业务任务幂等键。

- codex-query 增加有预算的候选经验返回协议，分离业务结果与待复核经验，提供主会话复核、去重及受控保存指导；不自动写记忆，格式失败不重跑业务。

- codex-query 的业务执行与技能索引刷新统一使用 gpt-6-sol，保留 low 推理强度；复用会话也显式传入该模型。

- 新增 ada_memory 当前会话隔离的经验保存/检索工具：可信来源绑定、预算校验、原子落盘、读回收据与精确去重；不加入共享工作区索引，不赋予主会话通用文件写权限。

- ada_memory search 接受可选 limit（整数 1–5，默认 5），同时在工具 schema 和执行入口校验，兼容模型显式传入 limit: 5。

## 2026-10-09 通用化配置

- Feishu 的本地业务扩展开放画像角色/规则/指令、催问与修正词汇、业务文案、卡片素材/模板/工具名称、Git 分支/远端/子模块/环境及技能发布位置配置；角色文案保留为可配置默认值。
- codex-query 开放运行路径、模型/推理/沙箱/超时、执行职责/数据策略/委派提示、记忆及飞书历史集成配置；后台请求持久保存配置，执行策略变化迁移会话并保留旧 ID。
- 任务来源、取消权限、幂等、并发和版本化桥接协议继续由实现保证。未修改上游许可证，未自动部署生产。

- ada_memory 增加中文分词、字段权重和本地 Ollama 混合检索；会话隔离的按需向量缓存、整体超时降级、损坏记录跳过，复用宿主模型且禁止远端与重定向。

- Agent Repo 原生同步：`agent-repo` 可通过 `before_dispatch` 等公开宿主钩子执行按 Agent 绑定的安全同步、按当前项目准备继承技能，并在模型启动前核对本轮版本；原有 Feishu `workspaceSync` 仅保留兼容。迁移计划明确停旧开新，不自动切换生产。

- Agent Repo 同步审查修复：入站与 Worker 准备共用 Agent 队列，核验已提交登记版本及项目分支/远端；缺少会话或提示词钩子权限时在同步前阻止；统一公开配置 schema 与运行时边界并增加回归。生产配置仍不自动切换。

- Agent Repo / Worker project API: agent-scoped discovery and execution preparation through a shared versioned in-process service; projectId selection, independent project/repository topic bindings, immutable admitted job scopes and legacy compatibility.

The Agent Repo API implementation is embedded into each plugin build from its single workspace source. Its versioned process registry and error constructor are shared through global symbols, so separately installed tarballs interoperate without an unpublished package dependency.

- Agent Repo personnel directory: Feishu collects admitted senders and native mention identities with contact name, department and email; per-Agent runtime SQLite stores administrative corrections and Gitea email-prefix candidates. The conversation side panel provides scoped read/write management. SourceTask and Worker preserve the original requester/mention snapshot for Issue recorder/assignee mapping; no user impersonation, credential collection or automatic Issue creation is added.

## 2026-10-17 飞书扫码向导

- 通过公开 WizardPrompter 的 note 检查点展示无 ANSI 二维码和授权 URL，并用组合横线消除宿主行距产生的条纹，扫码后继续验证；取消/关闭不再遗留后台轮询。写入授权检查移至采用成功凭据之前，保留宿主最终保存保护。
- 二维码过期时间包含用户停留页面的时间；请求传递 abort signal 并限制截止时间。网络异常、拒绝和过期在提示页可见，不回显提供商原始错误描述或私有凭据。
- 增加隔离扫码回归，并把已有注册 HTTP 测试迁移到本仓库可运行的测试入口；不替换生产插件，不声称真实飞书账号授权验证。

## 2026-10-17 对话人员上下文与用户查询

- 合并人员库快照与发言者画像为单份对话人员输入，私聊精简空值和无关建单规则，群聊按需展示角色和原生提及。保持开头历史结构及异步任务原始人员快照。
- 继续按可信 Agent 路由独立持久化联系人、保留人工更正及 agent_repo 的人员查询；新增 feishu_user 工具复用应用身份查询和账号/群策略，区分权限错误与未找到，不写库或通知用户。

## 2026-10-17 Agent 人员库独立管理页

- agent-repo 通过公开 Control UI registerPage/registerNavigation 增加左侧人员库入口，按 Agent 统一查看其全部会话与飞书同步采集的数据，保留原侧边栏入口及既有数据库。
- 管理页增加统计、关联状态和缺失字段筛选、跨会话群成员同步选择；通过可信 Agent 会话锚点调用现有权限校验接口，切换 Agent、失去权限或隐藏页面时废弃在途响应。

## 2026-10-17 AgentRepo 统一管理入口

- 将左侧导航统一为 AgentRepo，人员库成为其内部模块，同时提供概览、项目与技能、定时任务和仓库日志；保留旧人员库深链接及原会话侧边栏。
- 跨会话管理使用可信 Agent 归属，切换模块或 Agent 废弃旧视图；日志直接在管理页内展示，沿用原有读取、导出和清空确认权限。

## 2026-10-20 当前快照隐私清理

- 使用合成的飞书资源 token、OpenID、事件标识和测试域名替代来源未确认的测试值，保留解析长度、去重和事件顺序覆盖；评论测试改用已有 standalone runtime 并纳入选定套件。项目与子仓库示例改为通用命名，移除内部 Git 地址、素材私有仓库引用和本机部署快照。
- Worker 发布默认值使用 ~/ 用户路径与 PATH 命令，运行时才展开；旧存储与工作目录需由部署方私有配置显式保留，不自动搬迁。执行策略版本递增以迁移新任务的旧会话。
- 工作区同步默认使用 OPENCLAW_WORKSPACE_SYNC_ACTIVE 环境标记；依赖旧标记的 Hook 需通过私有 gitEnvironment 配置保留。补充运行状态与凭证的忽略规则，不排除跟踪的测试 trace。
- 上游许可证、公开插件及工具标识保持不变；本次不重写 Git 历史，也不改变仓库可见性或生产部署。

## 2026-10-20 部署配置补齐

- Agent Repo 增加按 Agent 的 sync.gitEnvironment 配置及中英 UI 帮助，将部署专用 Git Hook 标记传给入站、Worker 与定时同步；省略时保留通用默认，显式空对象关闭默认额外标记。
- schema 与运行时校验保持一致，配置防御性复制；文档明确 Worker 路径/政策、项目 Git URL、同步环境分别由部署方私有配置提供。仓库不包含真实机器补丁或凭证。

## Feishu CLI integration

The Feishu plugin installs the official MIT-licensed @larksuite/cli at runtime and generates skill indexes from its embedded catalog. Integration baseline: 1.0.96; compatible stable 1.x releases are eligible for default-on updates. Upstream: https://github.com/larksuite/cli. No upstream CLI or skill bodies are vendored. The upstream binary installer and its checksum validation are retained.

Local integration owns release selection, atomic CLI/catalog activation, rollback, Main-only plugin tool execution, environment credential binding, and requester-scoped Bearer OAuth device authorization using the public accounts endpoints. Agent Repo generates an Agent-scoped explicit-only global Codex skill from public loaded-plugin and tool catalogs (using the official read-only CLI when the native Gateway facade is restricted to bundled/official plugins), including the Worker communication protocol. Main delegation carries responsibility, task and versioned load/reload notices; Worker no longer publishes skills or injects capability pointers into developer instructions, and uses the existing Main request/reply protocol for OpenClaw plugin calls; independently authorized Feishu CLI use and its CLI environment configuration remain available to Worker. Host plugin credentials and Gateway tokens are not forwarded. Scripts/assets, raw API calls, app deployment, long-running event consumers and arbitrary file IO are not exposed through this adapter.

- Agent Worker 本地扩展：以可添加的 harness + 模型配置替代按智慧档位选择模型；Main 逐任务选择 modelId 和 0–6 级智慧参数，会话及调度按模型隔离。当前仅支持 Codex，等级及速度变化复用会话，已受理任务保留配置快照；兼容旧配置与任务，不改变宿主 SDK 或上游许可证。

AgentRepo adds a generic optional skill-maintenance provider API and a shared list/detail UI for skills and their CLI dependencies. Feishu retains CLI lifecycle, configuration and identity ownership; Agent Worker retains task diagnostics. No upstream CLI, skill bodies, OAuth secrets or business data are vendored into the management interface.

## 2026-10-20 通用日志 Console

AgentRepo bundles unmodified MIT-licensed `@tanstack/virtual-core@3.19.6` for bounded log-row virtualization; its copyright and license are shipped in `packages/agent-repo/THIRD_PARTY_NOTICES.md`. Console interactions, Main diagnostic leases, the generic source/log API and the read-only Worker audit adapter are local implementations. No Luna or Eruda code is bundled. Real-time capture defaults off and does not alter existing Worker auditing or Main-only plugin execution.

## Host source patch: Control UI binding forms (2026.10.5)

`patches/openclaw/2026.10.5-config-form/` carries an opt-in source patch for
OpenClaw tag `v2026.10.5`, commit `1b58cb9a1b4f4353e1add63c8506db4d890962e8`.
It admits existing object-count and negative-string-pattern validation in the
form analyzer and protects incremental repair from worsening count violations.
The plugin manifest schema and runtime are unchanged. The patch includes
browser/save regressions, synthetic schema fixtures, visual evidence, and the
upstream MIT license; it is not an installed-runtime patch or automatic deploy.

- 接话窗口新增 conversationWindow.decisionMode（auto/off，默认 auto）：通过宿主公开 Decision API 使用当前路由 Agent 配置的 Kev，采用有预算的三分类；不确定、超限或不可用时保留原 LLM 分类托底，取消与权限失效不触发托底。旧宿主不要求新增 SDK 运行时导入。
