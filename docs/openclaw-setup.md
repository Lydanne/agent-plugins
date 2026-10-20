# 在 OpenClaw 中安装和组合使用

本文从一台已安装 OpenClaw、已配置主模型的机器开始。安装位置、Agent ID、项目仓库、Codex 登录目录和飞书账号由管理员提供；示例使用 `/srv/agent-plugins`、`/srv/agents/my-agent` 和 Agent `main`，均须换成实际值。

## 1. 准备运行环境与产物

Node.js 24.19+、pnpm 10.33.2；Git 须能读取角色和项目仓库；需要 Worker 时安装 Codex CLI，并在 Gateway 运行用户下完成登录。Gateway/LaunchAgent 的 PATH 可能与交互终端不同，CLI 和 Node 宜使用绝对路径。不要将登录态复制进插件或 Agent Repo。

```sh
git clone https://github.com/Lydanne/agent-plugins.git /srv/agent-plugins
cd /srv/agent-plugins
node --version
pnpm --version
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
mkdir -p .tmp/packages
npm pack ./packages/feishu --pack-destination .tmp/packages
npm pack ./packages/agent-repo --pack-destination .tmp/packages
npm pack ./packages/agent-worker --pack-destination .tmp/packages
```

使用 `npm pack` 输出的实际文件名，不假设版本永远不变。这些包为 private，本仓库没有承诺公共 npm 发布渠道。新版构建会把内部共享包 @openclaw-plugins/agent-repo-api 的唯一实现复制到两个插件的 dist/agent-repo-api.mjs，随 tarball 交付，无需另行发布或安装私有 workspace 包。共享包本身不是插件，不加入插件加载路径。`openclaw plugins install @openclaw/feishu` 安装官方版本，不包含本仓库扩展。

## 2. 先在隔离状态下验证安装

以下环境变量仅对当前子 shell 生效。Worker 还需显式覆盖 state/cwd/codexHome，因为其保留的默认机器路径不会被 OPENCLAW_STATE_DIR 自动改写。不要加入真实飞书凭证，也不要把生产配置复制到测试目录。插件安装会写所选状态目录；`inspect --runtime` 会加载插件代码，应只加载已核对来源的产物。

```sh
(
  set -e
  task_state_dir=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-plugin-install.XXXXXX") || exit 1
  trap 'rm -rf -- "$task_state_dir"' EXIT
  export OPENCLAW_STATE_DIR="$task_state_dir"
  export OPENCLAW_CONFIG_PATH="$task_state_dir/openclaw.json"
  openclaw plugins install --help
  # 将下面路径替换为 npm pack 刚刚输出的具体 tgz 路径：
  openclaw plugins install /srv/agent-plugins/.tmp/packages/<feishu-package>.tgz --force --accept-capabilities
  openclaw plugins install /srv/agent-plugins/.tmp/packages/<agent-repo-package>.tgz --force --accept-capabilities
  openclaw plugins install /srv/agent-plugins/.tmp/packages/<agent-worker-package>.tgz --force --accept-capabilities
  openclaw config patch --stdin <<JSON
  {"plugins":{"entries":{"feishu-conversation":{"enabled":true,"hooks":{"allowConversationAccess":true}},"agent-repo":{"enabled":true},"agent-worker":{"enabled":true,"config":{"state":"$task_state_dir/worker","cwd":"$task_state_dir","codexHome":"$task_state_dir/codex","cli":"codex","node":"node","pathPrefix":"","skillsEnabled":false,"projectRouting":"legacy","approvalMode":"read-only"}}}}}
JSON
  openclaw plugins inspect feishu-conversation --runtime --json
  openclaw plugins inspect agent-repo --runtime --json
  openclaw plugins inspect agent-worker --runtime --json
  openclaw config validate
)
```

上述 `<...>` 是占位符，替换后才能执行。本机 2026.9.9 要求 --force 确认本地来源、--accept-capabilities 接受声明能力；仅对已审查的这三个产物使用。其他版本以当前 `--help` 和安装提示为准；不要为消除错误伪造官方来源或修改信任账本。Feishu 的 pnpm 外部依赖软链接可能被宿主边界扫描拒绝，推荐 tarball 安装。ESM 插件开发时可使用 openclaw plugins install --link /absolute/package，先构建 API 产物，再核对宿主依赖边界扫描。使用 load.paths 时逐包指定 agent-repo 和 agent-worker，不扫描共享包。链接只适用于该机器，也不代表源文件改动已被运行中的 Gateway 重新加载。

宿主基线为 2026.9.5；2026-10-12 本机 2026.9.9 CLI 的 help 确认支持这里的 install、inspect、config patch 与 validate 参数。命令合同与运行时兼容分别验收。宿主文档见 [Plugins CLI](https://docs.openclaw.ai/cli/plugins) 和 [Config CLI](https://docs.openclaw.ai/cli/config)。

## 3. 根据目标启用插件

| 目标 | 需要的设置 |
| --- | --- |
| 普通飞书助手 | Feishu 插件＋`channels.feishu`，按需配置接话窗口 |
| 只读项目登记 | agent-repo binding＋工具权限，`sync.enabled=false` |
| 固定目录本地执行 | agent-worker 显式机器路径、职责、沙箱与数据规则；没有技能发布端时 `skillsEnabled=false` |
| 角色仓库与多项目执行 | Agent Repo workspace＋binding＋Worker `projectRouting=auto`；用 projectId/repository 选择项目 |
| 飞书后台任务、提问及报告交付 | 上述组合＋Worker `asyncCompletion=true`＋Feishu 适配器；按需启用工作卡片 |

逐一按 [Feishu](../packages/feishu/README.md)、[Agent Repo](../packages/agent-repo/README.md)、[Agent Worker](../packages/agent-worker/README.md) 的示例合入配置。配置对象递归合并，数组整体替换；已有 `plugins.load.paths`、`plugins.allow`、`tools.allow` 和 `agents.list` 必须完整保留。宿主已通过安装管理的包无需再登记同一源码路径，避免重复 ID 覆盖和来源混淆。

首次接入推荐先用 [agent-repo-template](https://github.com/Lydanne/agent-repo-template) 建仓，然后按模板的 [首次接入步骤](https://github.com/Lydanne/agent-repo-template/blob/main/docs/openclaw.md) 运行 tools/create-openclaw-patch.mjs。它把模板四项政策、实际 Codex 路径与模型、Agent workspace、项目 binding、工具权限和飞书应用合为一个补丁，保留输入配置的 Agent 列表和白名单。生成文件可能包含飞书密钥，必须在仓库外的私有目录保存。

模板默认 projects.json 为空；先登记并独立克隆一个真实业务项目。没有项目时角色可以加载，但 Worker 无法执行项目任务。角色、projects.json、政策和技能须先提交，业务项目适用规范也须提交。空 skills 数组可用于没有技能目录的项目，避免登记不存在的目录。

组合的关键关系：

```json
{
  "plugins": {
    "entries": {
      "feishu": { "enabled": false },
      "feishu-conversation": { "enabled": true, "hooks": { "allowConversationAccess": true } },
      "agent-repo": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "agents": {
            "main": {
              "repo": "/srv/agents/my-agent",
              "sync": { "enabled": false }
            }
          }
        }
      },
      "agent-worker": {
        "enabled": true,
        "config": {
          "cwd": "/srv/agents/my-agent/projects/demo",
          "projectRouting": "auto",
          "cli": "/usr/local/bin/codex",
          "node": "/usr/local/bin/node",
          "state": "/srv/openclaw-state/agent-worker",
          "codexHome": "/srv/codex",
          "pathPrefix": "/usr/local/bin",
          "approvalMode": "workspace-write",
          "executorInstructions": "执行 task，遵守 constraints；只在授权范围修改，核验结果并返回完整客观报告。",
          "businessDataPolicy": "仅交付任务所需信息，不输出凭证和无关个人资料。",
          "skillsEnabled": true,
          "asyncCompletion": true
        }
      }
    }
  }
}
```

asyncCompletion=true 仅适用于有活动来源绑定的飞书会话；本地验收须关闭该项，用原 jobId 的 wait/status 获取结果。新版 auto 路由通过可信 agentId 发现 Agent Repo 项目 API，不要求固定 skillContextRoot；cwd 是独立/兼容模式基线，实际项目根由 API 派生。这个片段展示关联关系，仍需配置宿主 Agent 的 `workspace=/srv/agents/my-agent`、真实可用的 Worker 模型、角色委派政策及飞书应用。不配置 Agent Repo 路由时，`skillsEnabled=true` 要求旧 Feishu 技能版本发布端；新版 projectRouting=auto/agent-repo 且服务可用时，使用所选项目范围快照；skillContextRoot/provider 仅为旧版兼容入口。详细迁移用 agent-repo `plan --prepare-migration` 生成，不能只复制本片段完成旧系统迁移。

## 4. 审查配置再加载

保存的是配置补丁对象，不是 plan 的完整报告。先对目标配置做离线备份，将补丁放在私有位置：

```sh
openclaw config patch --file /private/path/plugin.patch.json --dry-run
openclaw config patch --file /private/path/plugin.patch.json
openclaw config validate
```

新环境在完成 OpenClaw 模型登录/配置后运行 `openclaw gateway run` 前台启动并观察日志；后台服务使用 `openclaw gateway install`。已有服务在已授权维护窗口使用 `openclaw gateway restart`，然后 `openclaw gateway health`。首次启动须先通过 `openclaw onboard` 完成宿主 Gateway 模式、认证和主模型配置；插件补丁不替代这一步。上述生产操作需由管理员执行，本仓库验证不会自动重启现有服务。

飞书侧先创建自建应用，开启机器人能力和长连接事件订阅，添加 im.message.receive_v1，授予接收/发送消息权限并发布应用版本，设置可用范围。完整权限、卡片回调及文档权限按 [Feishu README](../packages/feishu/README.md) 配置。默认 DM pairing：首次私聊后管理员执行 `openclaw pairing list feishu` 和 `openclaw pairing approve feishu <code>`；群聊须把 chat_id 加入 groupAllowFrom、将机器人入群并 @。仅写 appId/appSecret 不足以接收消息。

安装、应用补丁和 Gateway 重启都是管理员部署操作。在已授权维护窗口重新加载 Gateway，再检查插件来源、实际配置、日志及健康；只允许一个飞书实现提供 `feishu` 通道。切换前交接排队、运行和等待补充的 job，不删除旧状态。

## 5. 按边界验收

1. **产物与加载**：清单 ID、入口、依赖可用；inspect 无相关 diagnostics。loaded 只证明加载。
2. **角色与项目**：当前 Agent workspace 与 binding.repo 一致；`agent_repo list`、inspect 和 skills 返回登记的范围；原生记忆访问范围正确。
3. **真实执行**：在隔离项目提交一个明确授权的小任务，核对实际 cwd、技能版本、Codex 模型及报告；不要拿语法检查代替 CLI 执行。
4. **真实飞书**：在授权测试群 @ 机器人，核对来源、受理、卡片、补充回复、完成提醒、报告正文及成员可访问性。WebSocket ready 只证明连接。
5. **恢复与回退**：核对重启后原 job 可查询；恢复配置时保留原请求 ID、状态目录和业务记录，不以新 run 代替故障恢复。

## 常见接入问题

| 现象 | 先核对 |
| --- | --- |
| 飞书插件 loaded 却收不到消息 | 应用事件、可用范围、群权限、启用的实际来源和通道启动日志 |
| 同一 ID 出现多个候选 | 安装记录和 load.paths，按管理员计划只保留一个实际加载来源 |
| `agent_repo` 未出现 | 当前可信 agentId 是否有 binding；显式工具白名单是否允许 |
| 同步被拒绝 | workspace 与 repo、hook 权限、分支/tracking、origin、本地修改和同步锁 |
| Worker 新 run 提示技能不可用 | Agent Repo provider 是否匹配，或旧 Feishu 发布目录与 Worker state 是否一致 |
| Codex/Node 找不到或登录失败 | Gateway 用户、绝对程序路径、PATH、codexHome 和该用户的登录状态 |
| 返回 queued/running/unknown | 保存原 jobId；前两者表示已受理，unknown 需核对现场，不能盲目重做 |
| 报告有总结但附件失败 | localRoots、文件存在性、大小、飞书文档权限；不要重新执行业务生成第二份结果 |
