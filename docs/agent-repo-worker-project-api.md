# Agent Repo 与 Agent Worker 多项目接口方案

状态：代码已实现，待部署。项目 API、Worker 项目发现/选择和按范围保存会话已实现。本次不切换生产配置、不重启 Gateway；下文保留设计依据，实际接口见两个插件 README。

## 目标与现状

Agent Repo 维护项目登记、同步和技能范围；Main 按用户意图选项目；Agent Worker 在项目根目录运行本地 CLI。不同任务各自绑定项目，不切换共享的全局 cwd。

实现前的版本中，`agent_repo list` 已为 Main 提供项目列表，Worker 的 `run.repository` 已能选择登记项目。`packages/agent-repo/repository-skills.mjs` 通过进程内 `agent-repo.skill-scopes.v1` 注册表提供 `resolve()`；`packages/agent-worker/repository-scope.mjs` 使用配置的 `skillContextRoot` 查找 provider，再检查可信 agentId。

需要补齐三处：

1. 插件间缺少明确的项目列表、项目检查与执行范围准备 API，Worker 依赖固定角色仓库路径。
2. Worker 工具没有独立 projectId 和项目发现操作；现有 `list` 表示任务历史，不能混入项目列表。
3. Worker 的会话绑定、会话锁与调度冲突判断按会话和 topic 标识。同一 topic 在 A、B 项目来回切换时会因 cwd 变化创建新 CLI 会话并替换当前绑定，无法分别恢复 A、B 的上下文。

## 插件间 API

提供版本化的本地进程接口，不增加 HTTP 服务或需要鉴权的 Gateway RPC。它是两个自有插件的合同，不是 OpenClaw 自带的项目 API。

将注册表和类型合同放在独立的 `packages/agent-repo-api/` 共享包中。两个插件依赖共享包，Worker 不直接导入 Agent Repo 源码，不读取 projects.json。为兼容分别打包的插件，共享包内部仍使用版本化的全局 Symbol 注册表，按可信 agentId 索引 provider；取消 Worker 按固定路径查找 provider 的要求。

```ts
interface AgentRepoServiceV1 {
  apiVersion: 1;
  agentId: string;
  root: string;
  listProjects(): Promise<ProjectCatalog>;
  inspectProject(selector: { projectId: string }): Promise<ProjectInspection>;
  prepareExecutionScope(selector: {
    projectId?: string;
    repository?: string;
    expectedRegistryRevision?: string;
  }): Promise<PreparedExecutionScope>;
}
```

共享包暴露 `getAgentRepoService(trustedContext)`，从宿主工具上下文取得 agentId，并核对 sessionKey 的 Agent 归属。模型参数不能传 agentId、root、cwd 或远端 URL。服务方法已经绑定对应 Agent，只接受项目或仓库选择器。

`listProjects()` 只读取登记和版本，不 fetch、不创建 job、不扫描所有项目技能，不保证远端最新。目录可能未安装，因此列表仍可返回登记项目，具体就绪状态由 inspect 或 prepare 检查。示例：

```json
{
  "apiVersion": 1,
  "agentId": "main",
  "root": "/work/agents/ada-agent",
  "registryRevision": "opaque-registry-revision",
  "singleProjectId": null,
  "projects": [
    {"projectId": "demo", "name": "Demo", "repository": "projects/demo"},
    {"projectId": "another", "name": "Another project", "repository": "projects/another"}
  ]
}
```

registryRevision 绑定 Agent 根 HEAD 和已提交 projects.json 的对象版本。输出为数据副本，消费者不能修改 provider 内部状态。目录和登记不承担私聊隐私隔离，也不授予业务权限。

`prepareExecutionScope()` 是执行前唯一准备入口：检查登记与实际路径，串行同步所选项目、登记的 wiki 及项目 `.gitmodules` 声明的 `repositories/<名称>` 直接业务子模块，构建技能与规范快照，复核登记仍未改变，然后返回：

```ts
interface PreparedExecutionScope {
  apiVersion: 1;
  agentId: string;
  root: string;
  registryRevision: string;
  projectId: string;
  repository: string;
  cwd: string;
  scopeDirectory: string;
  skills: Array<{ name: string; description: string; source: string; path: string }>;
  instructions: string[];
  snapshot: RepositorySkillSnapshot; // 复用当前 protocol=3，并携带登记版本
}
```

同步遵循现有启用开关。关闭时只准备本地版本；开启时使用当前安全同步与同 Agent 串行队列。业务子模块按同步后 `.gitmodules` 的分支更新 origin，未配置 branch 时沿用项目分支；不初始化、不切换工作分支、不提交 gitlink。模型轮次中的 prepare 不重新更新角色根，避免改变当前角色。同步全部业务子仓库不会扩大技能范围：技能仍仅为角色、当前项目根和当前子仓库；子仓库同名覆盖项目根，角色技能优先。

选择规则：只有一个项目时可省略选择；多项目必须明确 projectId 或 repository；两者都传时必须指向同一项目。defaultProject 不作为任务回退。expectedRegistryRevision 不匹配、项目未安装、Git 状态不安全或所需 provider 不可用时明确拒绝，不回退配置中的旧 cwd。

API 错误提供稳定 code 与可公开说明，如 `PROJECT_SELECTION_REQUIRED`、`PROJECT_SELECTOR_CONFLICT`、`REGISTRY_CHANGED`、`PROJECT_NOT_READY`、`SYNC_BLOCKED`、`AGENT_REPO_UNAVAILABLE`、`API_VERSION_UNSUPPORTED`。

服务在调用时查找，不把启动时加载顺序固定成依赖；启动/热重载/停止使用现有 registerService 生命周期。重复 agentId 绑定明确拒绝；同 owner 的替换和释放使用代际标识，旧插件的 stop 不得移除新 provider。API 版本不兼容时停止接纳新任务。

## Main 与 Worker 工具

保留 `agent_repo list/inspect/skills`；工具与插件间服务共用实现。Main 一般沿用 agent_repo list，不需要分别获取两次列表。

Worker 增加 `action=projects`，只返回上述项目列表；现有 action=list 继续查询任务。run 兼容现有 repository，新增 projectId 和可选 expectedRegistryRevision：

```json
{"action":"projects"}
```

```json
{
  "action": "run",
  "projectId": "demo",
  "repository": "projects/demo/repositories/frontend",
  "topic": "issue-123",
  "task": "检查指定问题",
  "context": "本轮已核实的必要信息",
  "constraints": "只读分析，限定当前任务范围",
  "memory": {
    "status": "no_match",
    "queries": ["issue-123 Demo frontend"],
    "items": [],
    "reason": "该示例假设实际执行上述原生记忆查询后未匹配"
  }
}
```

此示例假设 Main 已实际完成原生记忆检索。新增项目发现不检索记忆；run 仍遵守现有 memory 交接和来源绑定要求。

Worker 使用 prepare 结果派生 cwd、技能上下文、规范路径及任务提示，不修改全局 configuration。executorInstructions/delegationInstructions 的目录应使用明确模板变量渲染，逐步替代对旧 cwd 的字符串替换。

新任务绑定项目后，status、wait、reply、cancel 都按 jobId 操作原绑定，不能通过补充参数切换到其他项目。结果、完成事件和报告包含 projectId、repository、cwd，Main 可以核对原任务范围。

## 项目切换与任务上下文

不增加全局 switchProject。切换项目意味着新任务选择另一个项目；在途任务继续使用受理时固定的项目与配置。

建议执行会话键包含：

```text
可信 agentId + 原会话范围 + projectId + repository + topic
```

项目和子仓库范围都进入标识，使同一 topic 在 A、B 项目及不同子仓库分别保留 CLI 会话。再次回到 A 时，可在版本与执行策略校验通过后复用 A 的原会话；角色、技能或规范变化仍按现有机制刷新或迁移会话。

绑定存储、会话锁和调度 sameSession 判断同步采用此标识。不同项目可以按已有容量限制并发；相同执行范围和 topic 仍串行。跨项目 resourceKeys 冲突仍保持全局资源锁语义，不以项目划分绕过业务互斥。

requestKey 对规范化后的项目与 repository 计算，使单项目省略参数、显式 projectId 和显式根 repository 的等价重试不重复建任务。先检查已接纳请求的固定绑定，再准备新任务；重试不能因登记更新而被重新路由。相同 requestId 的其他选择器或任务内容不能借此复用或覆盖原请求，明确报告冲突。已有 requestKey 格式保持兼容查找。

准备完成后再持久化 immutable 的项目/登记/技能/执行快照，在后台真正启动前再次校验。Gateway 重启和 provider 热重载不能改变已受理任务的 cwd；后台基于已存快照执行，并在源码或规范改变时按现有规则停止。续答保留原任务快照，不重新选择项目。

## 配置与迁移

agent-repo 的 Agent 绑定和 projects.json 是项目路由的唯一事实源。Agent Repo 模式下 Worker 按可信 agentId 获取服务，不再要求管理员复制固定 skillContextRoot 或为每个项目切换 cwd。

保留不使用 agent-repo 的独立 Worker 固定 cwd 模式；已有 skillContextRoot 配置作为迁移线索保留兼容。宿主登记为 Agent Repo 模式后，服务暂时不可用必须拒绝新任务，不能静默降级到独立模式。具体通过显式路由模式或宿主既有 binding 判断，实施时需让配置 schema、UI 提示和运行时一致。

旧任务文件和 protocol=1/2/3 快照不批量重写，已受理任务保留旧身份与恢复规则。旧 topic 绑定仅在能从已存 cwd 和快照唯一确认项目时，在首次真实 run 迁入新键并保留旧 ID；无法确认时报告需迁移，不猜测项目。新旧调度期间，旧范围的未结束任务继续保守占用相应锁，不能绕过正在运行或失联的任务。

## 实施顺序与验收

1. 增加共享 API 包与 Agent Repo provider；复用现有同步、登记和技能实现，保留 v1 scope bridge。
2. Worker 接入发现和 prepare API，增加 projects/projectId 参数，补齐结果项目标识及模板目录。
3. 迁移会话绑定、锁、调度、幂等键和历史查询；完成兼容逻辑后再规划运行时切换。
4. 同步更新两个插件 README、schema/UI 提示与角色仓库执行规范。通过隔离验证后，单独执行获授权的生产部署。

必要测试：

- 同一 Gateway 两个 Agent 获取各自列表；可信 agentId/session 不匹配、路径逃逸和重复绑定被拒绝。
- 单项目自动选择，多项目缺选择失败，projectId/repository 冲突失败，登记变化不使用旧选择。
- 同一会话相同 topic 执行 A → B → A，恢复各自上下文；不同子仓库不复用错误技能上下文。
- 并发任务 cwd 和技能互不覆盖，同范围串行，跨项目相同 resourceKeys 仍互斥。
- 等价选择器和消息重试只产生一个 job；在途、重启、reply 和完成通知保持原项目绑定。
- 角色技能共享、项目隔离、子仓库继承与同名覆盖；目录、登记、规范或 Git 版本变化在启动前被拒绝。
- 仅发现项目不执行 Git 同步、不检索记忆、不创建任务；API 不可用、版本不兼容、热重载和加载顺序有明确结果。
- 老固定 cwd Worker、旧绑定及已受理旧快照继续按兼容规则运行，不修改既有任务和业务数据。

实现交付不代表生产已部署；不调整已启用的生产同步入口，不重启 Gateway。

每日子仓库同步可由管理员在 Agent Repo 的 `sync` 下配置 `submoduleSchedule: { "time": "08:00", "timeZone": "Asia/Shanghai" }`。启用后，`prepareExecutionScope` 仍同步所选项目根，wiki 和业务子仓库由插件每日服务更新；Worker 使用本地子仓库版本构建有效技能索引，技能继承与范围隔离规则保持一致。定时服务处理该 Agent 的全部登记项目，不能据此为 Main 选择业务项目。当天失败不自动重试，阻塞记录保存在角色仓库 Git 目录内的每日 receipt；详见插件 README。
