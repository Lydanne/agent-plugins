---
name: feishu-cli
description: 飞书 CLI 动态技能与认证入口。需要通过 CLI 使用文档、表格、日历等业务能力，或查看 CLI 技能、处理用户授权时读取。Main 调用插件，Worker 通过原任务请求 Main。
---

# Feishu CLI 接入

插件管理 CLI 和技能版本。先使用 `feishu_cli action=skills` 查当前技能，再以 `action=read_skill` 读取 `lark-shared` 和目标技能。参考文档用同一工具的 `skill`、`path` 读取；不要把上游正文复制进角色仓库。CLI 内置内容不包含脚本与素材，遇到此类依赖明确报告不可用。

上游技能中的 `lark-cli ...` 命令由 Main 通过 `feishu_cli action=execute` 执行；`args` 是去掉 `lark-cli` 的参数数组。只支持类型化业务命令与内联数据，不支持原始 `api`、本地文件输入输出、应用部署或事件常驻订阅；这些操作沿用已有插件能力或向管理员说明限制。禁止用 shell 直接运行、安装或更新 CLI。

默认 `identity=bot`，使用可信消息账号对应的应用。调用范围以原用户请求及宿主工具策略为准；安装技能、拥有应用权限、Worker 提问均不构成新的写入授权。已有消息、群历史、卡片及后台交付继续用现有插件能力。

个人资源需要 `identity=user`。管理员须先启用 `channels.feishu.cli.userAuth`；没有授权时 Main 使用 `feishu_cli_auth action=login`，明确指定所需 `scope`。向请求人展示返回的原始 `verificationUrl` 和 `qrPath` 对应图片，说明完成后回来告知；结束当前轮，不立即轮询。收到完成反馈后执行 `action=complete`；如果仍 pending，按 retryAfterMs 等待后再查，不能当作成功。此流程只接受当前可信飞书请求人的身份，其他人扫码会被拒绝。

不执行上游 `config init/bind`、`profile`、`auth login` 等本地账号管理命令。插件复用应用凭证，用户 token/device code 仅在插件内部保存。`feishu_cli_auth action=status` 查看本人状态；`action=logout` 只清本地授权，服务端撤销需用户到飞书授权管理处理。

检查 `exitCode` 和内部 `result.ok`；进程结束不代表业务完成。`exitCode=10` 代表需要确认：向用户展示原操作和关键参数，取得明确确认后才以完全相同参数、`confirmed=true` 重试。不自动确认、不因报错另发一次写操作。缺权限时区分 bot 应用权限与 user OAuth scope；按需补齐，不默认申请全部权限。

Worker 调用任何宿主插件能力必须暂停该阶段，使用既有 `type=request` JSON 请求 Main，在 question/reason/progress 中说明目标、操作、用途和已完成工作。Main 按原任务授权调用后，用原 job 的 `agent_worker action=reply` 返回所需结果；Worker 恢复原任务。不要把 App Secret、token、device code 或管理员登录态传给 Worker。

管理员管理命令：`openclaw feishu-cli status|check|update|rollback`。自动更新默认开启；插件启用且已有飞书应用配置后，后台初始化 CLI，之后默认每 24 小时检查。自动更新开关不影响首次安装和手动更新。不可把本地安装、技能读取或认证测试通过描述为真实飞书业务已验收。
