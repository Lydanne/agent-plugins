# 早期飞书开发与本机验证记录

以下为原根 README 的历史记录，保留排查背景。测试数量、机器路径、部署状态和当时的限制不代表当前安装合同或生产状态；当前入口见 [仓库首页](../../README.md) 和 [OpenClaw 接入指南](../openclaw-setup.md)。

## 飞书接话窗口

在 `channels.feishu` 或具体 `groups.<chatId>` 配置下添加：

```json
{
  "requireMention": true,
  "conversationWindow": { "enabled": true, "durationSeconds": 600 }
}
```

默认关闭。仅处理通过群/发送者权限检查的真人群消息。@ 开启“账号＋群＋用户”的窗口；窗口内非 @ 消息交给宿主默认模型进行无工具分类，只有严格返回 `directed` 才接话并续期。明确 @ 别人、不确定、失败、8 秒超时均保持安静。有效期从用户消息时间计时，不从回复完成时间计时；重复、过期及乱序消息不续期。群会话仍共享。

状态保存在宿主 stateDir 下 `feishu-conversation-window/windows.sqlite`，重启后保留；只保存最近 8 条、每条最多 2000 字符的有效互动作为判断上下文。过期记录在后续状态操作时删除。数据库仅本机用户可读写，不应提交 Git。分类使用宿主已配置模型和凭证，不经过 Codex，也不执行消息中的指令或工具。额外模型调用会产生延迟和费用。

当前不为 broadcast 多 Agent 群启用窗口（仍按原有 @ 规则处理），避免一个人的窗口触发多个助手。附件本身不传给分类器；没有可识别文本时需 @。延迟回复只在对应最新用户消息仍有效时写入分类上下文。

## 安装验证与切换

pnpm 工作区依赖使用外部软链，OpenClaw 2026.9.5 的依赖边界扫描会拒绝直接 `--link`，应构建后使用上面的 `.tgz` 包安装。

先在独立的 `OPENCLAW_STATE_DIR` 和 `OPENCLAW_CONFIG_PATH` 下验证安装与 `plugins inspect feishu-conversation --runtime --json`。验证环境不配置飞书凭证，不连接真实群。

生产切换前备份配置，使用打包产物替换当前 `feishu` 插件。插件 ID 为 `feishu-conversation`，channel ID 保持 `feishu`，沿用 channels.feishu 配置。独立 ID 避免宿主把本地衍生版当成官方插件进行自动 npm 迁移。同一 Gateway 只能选择一个飞书实现：切换时关闭 plugins.entries.feishu，启用 plugins.entries.feishu-conversation，不同时运行两份。确认飞书应用能接收非 @ 群消息，再配置目标群的窗口开关。回退时恢复官方 `@openclaw/feishu@2026.9.5` 并删除新增 `conversationWindow` 字段。

本项目尚未自动替换生产插件或发送群消息。

## 验证范围

`pnpm test` 运行窗口持久化/续期/隔离测试、消息入口测试和配置测试，并为每次运行创建独立临时 OpenClaw stateDir，防止去重状态跨运行污染。

`pnpm typecheck` 在 strict 模式下检查飞书插件全部生产 TypeScript（包括未被选定测试执行的模块），并编译 SDK 类型正反例。`src/openclaw-sdk-compat.d.ts` 为已发布 SDK 缺少声明的公开入口补充本插件使用的精确接口；优先复用已有公开类型，不使用无类型模块声明。检查脚本核对声明中的运行时导出确实存在，并在 SDK 自带声明时要求移除对应兼容声明。此流程不升级 SDK 或替换运行时代码。

保留的其他上游测试尚未全部适配独立仓库；其中部分依赖未发布的上游测试 SDK。测试文件和测试辅助代码不属于生产类型检查范围，`pnpm test` 仍只运行已配置集合。构建、类型检查、选定测试与打包验证不能替代真实飞书群联调。

已完成：独立构建、230 项选定测试、隔离环境 tarball 安装与运行时检查（插件 loaded，channelIds 为 feishu，无 diagnostics）。尚未执行真实模型分类/飞书群联调，也未切换生产配置。GitHub 仓库已创建，本地文件未提交或推送。

## 2026-09-22 真实切换验证：暂不可上线

真实 Gateway 切换发现 `openChannelIngressQueue is only available for trusted plugins`，trust reason 为 `origin-path`。OpenClaw 2026.9.5 仅向 bundled / trusted-official 来源开放该持久队列，独立本地包即使 inspect 显示 loaded，也会在飞书启动时失败。此前隔离加载检查不包含真实通道启动，不能证明可接收消息。

已回退官方 feishu 插件，禁用 feishu-conversation，并移除两个群的 conversationWindow 配置。备份保存在本机 OpenClaw backups 目录。不得通过伪造官方来源或修改信任账本解决；独立插件需要适配第三方允许使用的消息队列/状态接口后重新验证。

## local.2 storage repair and live validation

The standalone plugin now owns `stateDir/feishu-conversation/state.sqlite` for ingress events, bot identity cache and logical message dedupe. It does not use host trust-restricted state APIs or alter the host trust ledger. Public SDK ingress monitor and queue contracts are retained.

The queue preserves event-ID tombstones, lane serialization, token-fenced settlement, heartbeat refresh, stale-claim recovery, retry counts and retention. Completed payloads are scrubbed. The identity cache verifies account and app identity. Logical dedupe retains 24 hours, bounded at 10000 entries per namespace. SQLite files have mode 0600. Existing host queue records are not imported, so switching should avoid active tasks.

Validation: 237 selected tests pass, including a real Feishu ingress start/drain test with host state APIs configured to throw trust refusals. Full TypeScript checking remains limited by missing upstream SDK declarations; no new storage-module type errors remain.

Live switch on 2026-09-22: local.2 enabled, official feishu disabled, conversation windows enabled for the two existing configured groups. WebSocket reported `ws client ready`. No test messages were sent to real groups. This supersedes the local.1 startup failure recorded above.

## local.3: bare-mention greeting

A human group message containing only a bot mention now receives an immediate configurable greeting instead of being dropped by the empty-message guard. Set `channels.feishu.mentionGreeting` or the group's `mentionGreeting` to describe the deployed assistant's actual capabilities. The generic fallback only asks what help is needed. Normal messages, attachments and meaningful quoted messages retain the original task flow. The direct reply uses the source message as reply target, settles ingress adoption and retains greeting context for the conversation window. No model completion is needed for this greeting.

Validation: 238 selected tests pass, including mention-only greeting, duplicate suppression and existing quoted-message behavior. The installed SDK's missing declaration limitations remain unchanged.

## 源码加载目录示例

脱敏示例：`plugins.load.paths` 可配置为 `/srv/agent-plugins/packages`，宿主扫描其直接子目录发现插件。codex-query 从 index.mjs 加载，feishu-conversation 从 dist/index.js 加载（修改 TS 后先 pnpm build 再重新加载）。新包仍须满足插件清单、依赖及启用策略，不等于任意目录自动可运行。若保留同 ID 的已安装包，可能出现配置目录覆盖警告；须检查实际加载版本。

## 活跃期静默上下文

群内存在有效接话窗口时，通过群与发送者权限校验的真人消息会保存到窗口数据库的 group_context 表，按账号和群隔离、消息 ID 去重，保留最近 50 条、每条最多 4000 字符，24 小时后在下一次读写时清理。静默消息不创建用户窗口、不续期、不触发任务。后续分类和回复使用该群上下文；发送者自身仍须有窗口，或者显式 @，才能进入接话判断。附件只保留入口解析出的文本，不自动下载。持久记录在下一次实际回复时作为不可信参考注入模型上下文，不为每条静默消息单独创建模型回合。构建及 240 项测试通过；真实群聊尚待验证。
