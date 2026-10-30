# Agent Repo 与 Agent Worker CLI

两个插件分别注册 `openclaw agent-repo` 和 `openclaw agent-worker`。命令是已认证 Gateway 操作的客户端，不在 CLI 进程另起 Worker、扫描生产任务状态文件或构造渠道来源。安装后需让 Gateway 加载同版插件；发布代码不等于生产已经部署。已在 OpenClaw 2026.10.9 验证，旧宿主缺少 tools.invoke、插件管理动作或 CLI 元数据模式时会按实际能力失败，不会回退为本地执行。

## 通用调用

```sh
openclaw agent-repo --help
openclaw agent-worker --help
openclaw agent-repo capabilities
openclaw agent-worker capabilities
openclaw agent-repo list --agent main
openclaw agent-repo inspect --agent main --params '{"projectId":"example"}'
openclaw agent-worker projects --agent main
openclaw agent-worker queues --agent main
openclaw agent-worker status --agent main --session agent:main:main --params '{"jobId":"<原任务ID>"}'
```

Ada 实例使用 `ada --instance local exec openclaw ...` 前缀。普通 OpenClaw 的 `--profile`、`--dev` 等全局选项继续由宿主处理。

在线命令显式要求 `--agent`；`--session` 缺省为 `agent:<AgentID>:main`，必须属于所选 Agent。Worker 历史与任务受原会话隔离，查询飞书任务时要指定其实际原会话；指定会话键不会创建真人请求或授予原来源的执行权。

参数使用 `--params '<JSON对象>'` 或 `--params-file /绝对路径/input.json`，二者互斥，上限 1 MiB。文件内容就是原工具参数或管理动作 payload；工具动作由命令固定，不能通过 JSON 换成另一动作。CLI 不自动补 `confirmed`、revision、requestId 或 provenance；写入的版本、确认和幂等要求与原接口相同。

始终输出 JSON：成功为 `{ "ok": true, "result": ... }`，错误为 `{ "ok": false, "error": ... }` 并非零退出。工具的单一 JSON 文本正文自动展开；任务处于 queued/running/unknown/failed 等状态仍是原结果，RPC 成功不表示业务成功。任何超时、断线或结果不确定都不自动重试写入，先核查已有对象和回执。

连接默认使用当前 profile/config 中的 Gateway、凭据及环境变量；支持 `--url`、`--token`、`--password`、`--tls-fingerprint`、`--timeout`（毫秒，默认 30000）。显式 URL 不会携带配置里的本地凭据，需显式凭据或对应环境变量。未解析的 SecretRef 不会作为字符串传输，须提供有效的环境或显式凭据。CLI 不输出连接凭据。Gateway 原有认证、角色权限、工具策略和来源校验仍生效。

## agent-repo 能力

| 命令组 | 能力 |
| --- | --- |
| 根命令 | `list inspect skills sync worker-skill people person people-stats entity-types entities entity relation-types relations graph entity-history`，对应 agent_repo 的所有动作 |
| `entity-sync` | `register-type upsert`，对应可选 agent_entity_sync；仍需工具允许策略 |
| `schedule` | `create list get history audit update pause resume remove run`，对应可选 agent_schedule；保留真人群来源校验 |
| `manage` 项目与技能 | `list detail sync-record task-record maintenance maintenance-run` |
| `manage` 工作区 | `workspace-pool workspace-pool-save` |
| `manage` 资料库 | `people people-sync-info sync-people update-person delete-person directory-sync-info directory-sync entity-types entities entity relations graph entity-history` |
| `manage` 计划、审计与回收站 | `schedule-catalog schedule-manage audit recycle-bin recycle-restore recycle-configure` |
| `manage` 日志 | `repository-logs clear-repository-logs diagnostic-sources diagnostic-history diagnostic-clear-history diagnostic-start diagnostic-read diagnostic-renew diagnostic-stop diagnostic-watch` |
| `local` | `inspect plan`，保留既有离线检查与迁移配置补丁计划；仅输出，不应用 |

CLI 名称将原动作的下划线或驼峰转换成短横线，例如 `worker_skill → worker-skill`、`workspacePoolSave → workspace-pool-save`。管理动作的参数与 Control UI 使用的同一服务一致，不将管理权限转换成业务授权。`skills` 在启用安全同步时可能更新项目；`sync`、资料同步与更正、维护、计划操作及删除等均须按其真实写入范围使用。

```sh
openclaw agent-repo manage detail --agent main --params '{"projectId":"example"}'
openclaw agent-repo manage workspace-pool --agent main --params '{"projectId":"example"}'
openclaw agent-repo manage schedule-catalog --agent main
openclaw agent-repo manage audit --agent main --params '{"limit":20,"offset":0}'
openclaw agent-repo local inspect --repo /absolute/agent-repo
openclaw agent-repo local plan --agent-id main --repo /absolute/agent-repo --config /absolute/openclaw.json
```

大结果自动在同一连接读取全部分块，内部 `chunk` 不另设用户命令。实时诊断 lease 也属于同一连接，不能跨 CLI 进程复用。使用以下命令连续采集，逐行输出 diagnostics JSON，正常结束或 SIGINT/SIGTERM 时停止采集；连接丢失时由服务端原 TTL 清理，不跨连接接管 lease。

```sh
openclaw agent-repo manage diagnostic-watch --agent main --duration 10000 --params '{"sourceIds":["agent-worker"]}'
```

`diagnostic-start/read/renew/stop` 作为原动作映射保留，通常应使用 `diagnostic-watch` 完成一个连接内的完整生命周期。

## agent-worker 能力

根命令提供 agent_worker 全部动作：`queues projects list run status wait cancel tag reply await-user steer`。`manage` 提供 `list detail agent-tasks delete-session`。例如：

```sh
openclaw agent-worker list --agent main --session agent:main:main --params '{"projectId":"example","query":"关键词"}'
openclaw agent-worker manage agent-tasks --agent main
openclaw agent-worker manage detail --agent main --session '<原会话键>' --params '{"jobId":"<原任务ID>"}'
```

`run/reply/await-user/steer/cancel` 等仍校验原任务、会话、来源及原授权。特别是生产开启 asyncCompletion 时，普通 CLI 不能仅凭飞书会话键新建异步任务，也不能传 wait 绕过来源；此时调用会明确失败。`task-result` 映射 agent_task_result，但它只在宿主绑定的自动化核验轮次可用，普通外部 CLI 没有该绑定，不得用 CLI 伪造业务完成。

本机自动化执行使用 `automation submit/get/cancel/rerun`，复用原 `agent-worker.automation.*` RPC。需已配置并启用自动化、调用方、Agent、项目与队列允许范围。`submit/rerun` 还通过公开 sessions.create 准备服务端选择的会话，避免仅提交账本后停在 waiting_session；返回受理状态后由既有 Main → Worker → Main 核验流程执行。不会更改管理员配置来让调用通过。

```sh
openclaw agent-worker automation submit --agent main --params-file /absolute/task.json
openclaw agent-worker automation get --agent main --params '{"taskId":"<返回的taskId>"}'
openclaw agent-worker automation cancel --agent main --params '{"taskId":"<原taskId>"}'
openclaw agent-worker automation rerun --agent main --params '{"taskId":"<已终结并结算的taskId>","operationId":"<稳定操作ID>"}'
```

提交文件示例（将项目、目标及授权范围替换成真实值）：

```json
{
  "version": 1,
  "projectId": "example",
  "workflow": "local-read-only",
  "requestKey": "stable-business-request-key",
  "task": "查询明确授权的目标并返回证据",
  "context": "实际环境与关联标识",
  "constraints": "仅查询指定目标，不修改配置、代码或业务数据",
  "useWorkspace": false
}
```

`--agent` 注入提交的 agentId；JSON 显式提供时必须一致。去重、unknown、重跑、取消及结果验收均沿用原自动化合同。提交成功不是业务完成，cancel 也不表示已发生的外部操作被回滚。

## 隔离验证

在仓库独立 checkout 构建后执行 `node scripts/plugin-cli-host-probe.mjs`，在随机端口、临时配置/状态和测试仓库启动真实 Gateway，核对两个插件的 CLI 发现、工具调用、管理动作、离线检查、文件参数及 Agent 不匹配拒绝。不读取生产凭据、不运行模型、不创建 Worker 任务。该验证不代表生产部署或真实飞书端到端验收。


## Worker task context and direct plugin calls

Worker executions inherit their identity rather than supply --agent/--session. The host allocates a fresh workerId per execution round; jobId remains the original task ID. OPENCLAW_WORKER_ID, OPENCLAW_JOB_ID and compact OPENCLAW_WORKER_CONTEXT are available to every child shell command. OPENCLAW_WORKER_CLI_URL/TOKEN identify a loopback-only, current-execution capability; never print them, put them in shared skills, or substitute operator credentials. They are delivered over the worker stdin boundary, not persisted in job/request JSON. Full task/context/constraints and original requester/project/session come from `context` or the plugin's host-bound workerContext, not from editable CLI parameters. Ending/cancelling the job, invalidating its source, resuming into another workerId, or stopping the broker invalidates the old capability.

```sh
openclaw agent-worker context
openclaw agent-worker plugin list
openclaw agent-worker plugin describe --tool feishu_doc
openclaw agent-worker plugin call --tool feishu_doc --params '{"action":"read","doc_token":"<authorized-document>"}'
openclaw agent-repo person --params '{"openId":"<verified-person>"}'
```

Plugin calls go through the original session's tools.invoke policy and a shared adapter that reconstructs the task context before plugin execution. Plugins opt in through workerContextApi; agent-repo, agent-worker and feishu-conversation are integrated. Generic core tools, arbitrary RPC and management actions are not available through this capability. Descriptions and schemas come from the currently loaded plugin tools; the catalog reports taskBound=false for plugins without the adapter. Administrative changes, orchestration and new authorization remain Main-owned. IDs alone confer no permission. This provides an identity/context foundation, not a new semantic authorization engine for arbitrary natural-language constraints.

Instructions are published under ~/.agents/skills/openclaw-main-<AgentID>/ with immutable revisions and content-addressed CLI references. No per-job identity or credentials are written there. On successful publication, only an owned, verified legacy <codexHome>/skills entrypoint is renamed to SKILL.md.migrated; old immutable revisions remain for queued continuations. Worker receives load/reuse/reload notices for the current version. Unowned or modified legacy skills are preserved. No publication occurs during metadata-only CLI discovery.
