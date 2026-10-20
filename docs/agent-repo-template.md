# 创建自己的 Agent Repo

通用 GitHub 模板：[Lydanne/agent-repo-template](https://github.com/Lydanne/agent-repo-template)。使用 **Use this template → Create a new repository** 创建自己的角色仓库；本仓库的 agent-repo 是支持插件，模板是独立的角色工作区，两者分别维护。

## 1. 初始化角色

克隆新建的仓库，明确读取 BOOTSTRAP.md，填写名称、可信 Agent ID 对应部署、SOUL.md 业务职责、AGENTS.md 授权边界和工具约定。模板提供空的原生记忆和项目登记，不复制其他角色与项目的身份、聊天、业务数据或机器路径。

```text
my-agent/
├── AGENTS.md / SOUL.md / IDENTITY.md / USER.md / TOOLS.md
├── BOOTSTRAP.md
├── projects.json
├── skills/                         角色专用技能
├── tools/agent-worker-policy.json  四项角色政策
├── MEMORY.md / memory/             已核验且允许共享的经验
├── docs/                          接入、项目及记忆指南
└── projects/                      Git 忽略，手动克隆独立业务仓库
    └── demo/
        ├── .agents/skills/
        └── repositories/server/   可选，项目自己的子仓库
```

不用 OpenClaw 插件安装命令安装模板，也不要将 templates 或 projects 作为插件扫描目录。

## 2. 登记并克隆项目

将模板 projects.json 的空 projects 改为实际登记，示例须替换 OWNER/PROJECT：

```json
{
  "schemaVersion": 1,
  "projects": {
    "demo": {
      "name": "Demo",
      "url": "https://github.com/OWNER/PROJECT.git",
      "branch": "main",
      "repository": "projects/demo",
      "skills": ["projects/demo/.agents/skills"]
    }
  }
}
```

```sh
mkdir -p projects
git clone --no-recurse-submodules https://github.com/OWNER/PROJECT.git projects/demo
```

URL 不包含凭证。projectId 与 projects/<ID> 必须一致；skills/knowledge 在对应项目内部，不登记 memory。无需项目技能时 skills 可为空。需要 wiki 时按实际路径登记；原生同步对登记为 projects/<ID>/wiki 的 wiki 提供同步，并更新项目 `.gitmodules` 声明的 repositories/<名称> 直接业务子模块。先按业务项目规范初始化这些子模块，配置其目标 branch 并确认 origin URL 与声明一致；未初始化或不满足安全快进条件会阻止对应同步。可在 sync 下配置 `submoduleSchedule: {"time":"08:00","timeZone":"Asia/Shanghai"}`，将 wiki 和业务子仓库更新改为每日一次；根仓库仍按请求更新，Worker 技能使用本地子仓库版本，失败记录与重启去重见插件 README。提交角色规范与登记，确认两仓 origin/tracking 和远端引用。

多个项目分别登记、克隆，逐任务选择。defaultProject 只服务迁移计划，不是模型调用的默认项目。角色 Git 不提交业务项目指针，不用软链接代替独立克隆。

## 3. 接入 OpenClaw

先按 [接入指南](openclaw-setup.md) 安装插件。普通 agent-repo plan 只加载插件和绑定角色根；--activate-workspace 规划目标 Agent workspace；--prepare-migration 规划角色根、Worker 政策、技能范围和同步；--prepare-sync 只规划同步且不能与其他迁移选项混用。

```sh
node packages/agent-repo/cli.mjs inspect --repo /srv/agents/my-agent
node packages/agent-repo/cli.mjs plan --agent-id main \
  --repo /srv/agents/my-agent --config /private/path/openclaw.json \
  --activate-workspace --installed > /private/path/agent-plan.json
```

上述命令从插件仓库执行；配置输入为标准 JSON。普通计划检查 patch/warnings；迁移计划另检查 ready/blockers。只保存 patch 字段作为宿主补丁。计划不自动写配置、克隆项目、fetch 或重启。完整迁移仍按一个实际 Agent 审查；多 Agent binding 不等于单 Worker 配置已扩展为任意多 Agent 路由。

保持实际 Agent workspace 与 binding.repo 一致，新版 Worker projectRouting=auto/agent-repo 通过可信 agentId 获取项目 API，cwd 从登记派生；旧版兼容使用 skillContextRoot 为角色根、cwd 为项目根。机器路径和模型在宿主私有配置中设置；tools/agent-worker-policy.json 仅含 schemaVersion=1 和四个角色政策字符串，{projectDir} 在迁移计划或 Worker 项目路由准备时替换。政策更新后重新生成计划，不自动变更旧 job。

## 4. 验收和日常维护

Main 调用 agent_repo list/inspect/skills；明确范围后用相同 repository 提交 agent_worker run。验证 cwd 为项目根、scopeDirectory 为技能范围，原生记忆访问没有跨会话泄露。飞书测试另外核对卡片、用户补充、报告成员可读和提醒。

角色和技能提交到自己的 Agent Repo；业务代码提交到 Project Repo；插件升级在本插件仓库。不要将项目技能全部复制进角色 skills，或将 projects/ 加进全局 extraDirs。

异机恢复重新克隆角色与项目，按需初始化子模块，再私有恢复已授权的运行状态。Git clone 不恢复登录态、任务记录、SQLite、向量缓存、未提交记忆和生产配置。先交接在途任务再切换，保留原 jobId，不通过重跑业务验证恢复。

模板说明：[初始化入口](https://github.com/Lydanne/agent-repo-template/blob/main/BOOTSTRAP.md)、[接入与恢复](https://github.com/Lydanne/agent-repo-template/blob/main/docs/openclaw.md)、[记忆管理](https://github.com/Lydanne/agent-repo-template/blob/main/docs/memory.md)。

首次安装三个插件请按模板的 [首次接入操作步骤](https://github.com/Lydanne/agent-repo-template/blob/main/docs/openclaw.md) 生成补丁；模板提供 tools/create-openclaw-patch.mjs 将四项政策、机器路径、workspace 和 binding 一次写入补丁。不要对新环境使用 --prepare-migration；它用于已有 Feishu workspaceSync 的迁移。--installed 表示使用宿主已安装产物，不额外登记源码 load.paths。
