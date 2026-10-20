# 模板首次接入复测记录

2026-10-13 使用 OpenClaw 2026.9.9、Node.js 24.19.0、pnpm 10.33.2，在临时角色仓库、独立 demo 项目和独立 OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH 中复测。没有读取生产配置、Codex 登录态或飞书消息，没有重启生产 Gateway。

## 已修复的接入问题

| 问题 | 修复 |
| --- | --- |
| 首次接入示例进入旧 Feishu 同步迁移预检 | 模板改为独立首次接入步骤；迁移选项仅用于旧环境 |
| 已安装 tarball 后 plan 再登记源码路径 | CLI 新增 --installed；有安装记录时自动使用已安装来源 |
| 模板政策文件没有自动进入 Worker，可能继承机器及业务默认值 | 模板新增 tools/create-openclaw-patch.mjs，显式写入四项政策、路径、Codex 模型、workspace、binding 和工具权限 |
| 当前宿主将 agents.list 规范化为 agents.entries，workspace plan 无法读取 | CLI 与模板生成器兼容两种格式，并保留 Agent 模型、工具和其他项目 |
| 当前宿主安装需要来源及能力确认 | 安装命令补 --force / --accept-capabilities，并说明覆盖语义 |
| Feishu before_prompt_build 被宿主阻止 | 配置补 hooks.allowConversationAccess=true |
| 本地会话设置 asyncCompletion=true，缺少飞书来源绑定 | 无飞书设置时生成器关闭异步，使用原 jobId 的 wait/status；飞书配置时启用异步 |
| 新用户缺少通道后台、配对、启动与任务参数步骤 | 模板补长连接事件、发布、权限、群白名单、私聊配对、Gateway 和完整 run 示例 |

## 实际通过的边界

- 三个独立 tarball 安装成功；各自 inspect --runtime 的状态为 loaded；补齐 Feishu 钩子后相关 diagnostics 为空。
- 模板生成补丁通过 config patch --dry-run、实际应用及 config validate；包含占位飞书凭证的补丁也通过离线 schema 校验，没有用占位凭证启动连接。
- 已提交模板角色与项目登记，加独立已提交 demo 项目，agent_repo list/skills 和 agent_worker projects 返回一致范围。
- 从安装包注册真实插件工具并提交任务，使用模拟 Codex CLI 验证技能确认→业务执行两轮协议，job 到达 completed；两轮 cwd 均为 projects/demo，参数均含 read-only。此项证明进程调用与目录传递，不证明真实 Codex 模型调用或操作系统沙箱隔离。
- 临时 Gateway 在随机 loopback 端口启动，health.ok=true，已加载 agent-repo/agent-worker，插件 errors/unavailable 为空；未启用飞书连接，因此健康列表未声明飞书通道已运行。Gateway 随后正常退出。
- 模板配置生成器回归覆盖既有 Agent/工具白名单保留、路径与政策、飞书/本地异步差异及不修改输入配置；插件仓库 typecheck/build 通过，当前 1265 项测试通过。第二轮 pnpm test 中一个既有 Git 同步集成测试遇到 5 秒超时；随后以 --maxWorkers=2 重跑同一完整 Feishu 40 文件套件，1036 项全部通过，未修改断言或超时时限。

## 使用者仍需完成的真实环境验收

按照 [模板首次接入步骤](https://github.com/Lydanne/agent-repo-template/blob/main/docs/openclaw.md) 完成真实模型登录与飞书应用配置。真实 Codex 模型执行、飞书 WebSocket 连接、@受理、卡片回复、异步提醒和报告权限需要管理员提供实际账号与授权测试群。本次没有这些平台端到端结果，不能据此宣称已上线。

宿主与飞书侧流程参考 [官方 Config CLI](https://docs.openclaw.ai/cli/config) 和 [官方 Feishu 设置](https://docs.openclaw.ai/channels/feishu)；本仓库衍生插件仍使用本仓库 tarball，不能用官方插件包代替。
