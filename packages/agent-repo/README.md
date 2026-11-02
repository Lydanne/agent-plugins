# Agent Repo 支持插件

专用 CLI：`openclaw agent-repo` 覆盖工具和管理动作；完整命令、参数与来源限制见 [插件 CLI 指南](../../docs/plugin-cli.md)。

OpenClaw 插件 ID 和包名均为 `agent-repo`。代码属于 openclaw-plugins；独立的 **Agent Repo**（例如 ada-agent） 继续维护角色、skills、tools、projects.json 和原生记忆 Markdown。此插件不携带任何 Agent 的角色、私人记忆、业务源码或登录状态。

当前能力：

- 一个 Gateway 可按可信 agentId 绑定多个互不重叠的 Agent Repo；未绑定的 Agent 不注册 agent_repo。
- 每个 Agent Repo 可以登记多个项目，分别使用 projects/<项目ID>/ 下的一个独立 Project Repo，多会话共享该 Agent 的项目登记。工具不接受 agentId、任意路径、shell 命令或配置写入。
- agent_repo 的 list 读取项目登记；inspect 检查指定 projectId；单项目可省略选择，随后检查所选项目的独立 Git 根目录、分支、本地修改、origin 匹配与**已经获取的**上游 ahead/behind；不执行 fetch/pull/clone 或 Git 写操作。missing、无 upstream、分支分叉等不视为最新。
- agent_repo 的 skills 返回根项目或明确子仓库的继承技能索引；启用 sync 后先同步选定项目再构建索引；wiki 和 `.gitmodules` 声明的直接业务子仓库按请求更新，配置 submoduleSchedule 后改为每日更新。agent_worker run 通过插件 provider 使用相同同步与技能准备规则，同名子仓库优先且兄弟仓库技能隔离。
- 管理员本地 CLI 检查仓库或生成配置补丁计划。默认只计划加载插件和绑定仓库；只有显式 `--activate-workspace` 才规划 workspace 修改，仍不自动应用。

本版支持迁移计划及独立的原生钩子仓库同步；不支持自动项目初始化、跨项目同时加载技能、后台经验写回或自动提炼技能。复用原生 memory_search/memory_get/write/edit 的工作区机制，不注册独立记忆工具。登记路径和目录划分不提供跨会话隐私隔离；工具不读取记忆或角色正文。

## 插件资料合同技能

插件声明 `./skills` 并随包交付 `agent-repo-context`：集中说明项目选择、人员查询、Gitea 候选、实体字段和来源边界。绑定 Agent 的每轮系统上下文保留简短合同提示；工具描述只负责路由和关键约束，不再复制完整字段说明。查询器、权限和来源校验仍由实现执行，不依赖模型是否读取技能。

可选新字段保留既有含义，未知字段仅作为资料；实体属性依 `entity_types` 返回的动态字段定义解释，不将业务分类硬编码到查询器。增加字段时同时维护 schema、来源、空值语义、技能参考和回归；破坏性改动另行版本化。技能加载不授权实体写入或跨会话资料转发。

## AgentRepo 管理中心

OpenClaw 左侧统一入口为 **AgentRepo**，打开跨会话管理中心。页面内依次为概览、项目与技能、Worker 任务、实体库、知识库、定时任务、审计和日志。项目模块包含项目登记、本地仓库状态、技能和子代理；定时任务展示仓库同步等系统任务计划与记录；日志模块采用 Console 风格，支持来源、级别、分类筛选、查找高亮、分组折叠和对象详情；实时调试默认关闭，Worker 事件由 Main 汇总。复制、下载和清空视图不修改任务审计，清空仓库历史仍需确认与写入权限。通用插件 log 接口、来源追踪和生命周期见 [日志设计与接入](../../docs/log-console.md)。实体库是其中一个模块，人员资源是其内置分类。

项目与技能使用紧凑列表展示名称、用途摘要、来源和依赖状态，搜索覆盖完整说明；点击技能或 CLI 查看完整详情。宽容器并排展示列表与详情，窄容器切换为单页并提供返回列表。CLI 详情优先展示版本、更新设置和维护操作，关联技能清单按需展开；这些布局规则适用于所有维护提供方。

各管理模块使用宿主已确定的 Agent 上下文，共用稳定的主导航、模块标题、说明和主要操作布局。模块切换只替换内容区，保留主导航焦点；重复点击当前模块不触发重新加载。定时任务和日志与项目、Worker、实体模块使用相同的内容边距，不再套用弹窗或侧栏的外层卡片。

编辑、同步管理、低频筛选和使用说明使用共享弹层组件；界面分层与生命周期约定见 [Control UI 布局约定](../../docs/control-ui-layout.md)。

管理中心跟随宿主当前 Agent 更新全部模块，页面内不重复提供 Agent 选择器，不依赖当前聊天会话；后台操作继续使用可信 Agent 归属与既有读写权限。旧人员库深链接和会话侧边栏入口保留。

统一实体接口、扩展类型、同步身份和兼容策略见 [实体库设计](../../docs/entity-library.md)。`agent_repo` 新增 entity_types/entities/entity 只读查询；可选工具 `agent_entity_sync` 提供 AI 入库，可信程序使用 `@openclaw-plugins/agent-repo-api/entities`。默认类型为人员资源、组织机构、系统服务和资产资源，运行时注册的自定义类型自动进入界面；资料按类型和来源稳定 ID 更新，不按名称自动合并。AI 同步工具需要显式工具权限，安装不会修改 Gateway 配置。

### 实体库与人员资源

从左侧 **AgentRepo → 实体库 → 人员资源 → 飞书人员同步与更正** 打开人员管理页，无需选择或创建会话。每个 Agent Repo 一份统一数据库，管理其全部私聊、群聊与飞书同步采集的联系人；切换 Agent 后读取对应库，不跨 Agent 合并。旧独立库首次打开时只读迁入统一库，原文件保留，生产切换前须备份。

飞书人员管理页提供人员统计、关键词搜索、Gitea 关联状态与缺失资料筛选、分页、人员详情、人工更正、恢复自动资料和确认删除。姓名、邮箱、部门和 Gitea 映射沿用现有更正规则；飞书刷新及后续聊天采集不会覆盖人工更正。统计随当前查询条件更新。

批量同步从“飞书同步来源”选择此 Agent 已有的飞书群聊，然后点击“同步所选群成员”；仅在用户主动操作且具有 operator.write 时发起。没有群聊时仍能查看、查询和管理全部已采集人员。同步沿用飞书群访问、账号选择和通讯录权限校验；不把群 ID 当作授权，不创建会话、不向群发消息。会话侧边栏的人员入口保留，指向同一份存储。

普通真人消息继续由 Feishu 插件在消息被接纳且完成 Agent 路由后采集真实发送者和原生提及人，其他未接入的渠道不会凭显示姓名自动合并身份。人员库是资料管理，不保存聊天正文；账号/应用/OpenID 仍共同标识一个飞书身份。

## 人员资料与 Issue 代录

人员资料窗口在飞书群聊中提供 **同步本群成员** 按钮（需要 `operator.write`）。按钮只接受当前可信会话，不接受任意群 ID；多账号时先选择当前 Agent 可访问的账号。后台任务分页读取成员、每批最多 4 位并发查询资料，显示发现、处理、取得通讯录资料、仅基本身份、新增和更新数量。重复点击复用同一任务，处理中加入的新成员合并处理。切换页面不取消已提交的同步；重新打开窗口可查看当前进度和本次结果。未完成、权限失败及中断不会显示为全部成功。

Ada 被加入群聊时全量同步该群；其他成员入群时仅增量采集事件里的新成员。需要在飞书开发者后台订阅 `im.chat.member.bot.added_v1`、`im.chat.member.user.added_v1`，并确保应用具有群成员读取和所需通讯录字段权限。账号配置 `channels.feishu.peopleSyncOnJoin=false`（多账号也可在对应账号设置）可关闭自动触发，手动按钮仍可用。自动同步遵守群策略及当前 Agent 路由，只写已绑定的 Agent Repo；没有人员服务的 Agent 跳过。

同步复用 `.runtime/agent_repo.sqlite` 的身份键和覆盖规则，不创建重复人员，不覆盖管理员更正。通讯录资料不可见时可保存群成员 API 返回的姓名/OpenID，同时标记资料不完整；不猜邮箱、部门或 Gitea 账号。不删除已离群人员、不发群消息、不触发业务任务。单次最多读取 100 页成员并运行 10 分钟，达到限制或中断会明确显示未完成；最多 4 个群任务同时执行。任务状态保存在当前进程内，服务重启中止在途任务；已入库资料保留，可重新手动同步。


`agent_repo` 提供三个人员查询动作，优先查询当前 Agent 工作区已采集的资料，无需选择项目，不触发 Git 同步。`people/person` 本地无匹配时自动请求配套 Feishu 插件，并将成功取得的真实资料保存到当前 Agent 的人员库：

```json
{"action":"people","query":"研发","limit":20,"offset":0}
{"action":"people","department":"研发组","giteaSource":"admin","sortBy":"name","sortOrder":"asc"}
{"action":"person","openId":"ou_example","accountId":"feishu-main","appId":"cli_example"}
{"action":"people_stats","missing":"email"}
```

- `people`：关键词 `query` 搜索姓名、邮箱、OpenID、Gitea 账号、部门名称和 ID；可组合 `name`、`department` 包含匹配，`email`、`giteaUsername` 不区分大小写精确匹配，以及 `id`、`openId`、`accountId`、`appId` 精确筛选。`giteaSource` 可为 `admin`、`email_prefix`、`unknown`；`missing` 可为 `name`、`email`、`departments`、`giteaUsername`。`limit` 默认 20，范围 1–100；`offset` 默认 0；`sortBy` 支持 `name`、`observedAt`、`updatedAt`，`sortOrder` 支持 `asc`、`desc`，默认按姓名升序，ID 用于稳定消歧。返回 `people/total/offset/limit/nextOffset`。
- `person`：必须且只能提供 `id` 或 `openId`，可加 `accountId/appId`。返回 `found/ambiguous/total/person/people/truncated`；多条匹配时 `person` 为 null，候选最多 100 条，须增加账号或应用条件，不能擅自选第一个。
- `people_stats`：支持与 `people` 相同的筛选，不接受分页排序；返回匹配总数、各字段缺失数、Gitea 映射来源计数、账号与应用列表。

自动补全规则：

- OpenID 直接调用飞书通讯录资料接口；邮箱先解析 OpenID（需要 `contact:user.id:readonly` 权限），再获取资料。`query` 为 `ou_...` 或完整邮箱时自动识别对应路径。
- `name` 或普通 `query` 在可信当前飞书群内搜索成员姓名，再获取匹配人员的通讯录资料。最多读取 5 页、每页 100 位成员，最多补全 10 位候选；不批量保存不匹配的群成员。超过范围时返回 `lookup.truncated=true`，不能声称全量搜索完成。没有群上下文时提示提供 OpenID/邮箱，不借用用户登录态进行全局姓名搜索。
- 使用可信消息的飞书账号；模型指定账号与当前账号不一致时拒绝远程调用。没有消息账号且有多个可用应用时，要求通过 `accountId/appId` 明确选择。
- `people_stats`、无标识浏览、仅资料 ID 查询，以及本地已有匹配（即使所选页为空）不触发远程请求。成功采集保留人工覆盖；原任务提交时的人员快照不随查询改变。
- `lookup` 返回来源和状态：本地 `not_needed`，远程 `saved/not_found/unavailable/unsupported/account_required/error`，以及安全原因标识、错误码、所需权限 `requiredScopes` 和截断标志。权限或网络错误不当作空通讯录，也不保存空用户。
- 需要同时启用当前版本的 `agent-repo` 和 `feishu-conversation`，并授予飞书应用查询资料、邮箱解析及当前群成员的相应权限。资料查询仍受应用可见范围限制。

查询结果使用人工更正后的有效字段，包含原始身份标识、采集时间和修改时间。未找到仅代表本地尚无匹配资料，不代表飞书不存在该用户；`email_prefix` 只代表账号候选，人工映射也不替代 Gitea 账号及指派权限核验。不接受其他 Agent、任意路径、项目选择或修改参数；不提供跨会话转发、通知或业务写入授权。

AgentRepo 中实体库的“人员资源”分类及消息侧边栏的“人员资料”入口均可搜索姓名、部门、邮箱和 Gitea 账号，查看飞书账号、应用及 OpenID。operator.read 可查看，operator.write 可更正姓名、部门、邮箱、Gitea 账号，恢复自动资料或确认删除。切换 Agent/会话、失去权限或关闭面板会关闭资料窗口，避免旧请求写入新页面。

配套 Feishu 插件在已接纳的人类消息中采集真实发送者及最多 20 个本轮原生被提及人的资料；不扫描全群成员或解析普通文字 @。按 Agent Repo、accountId、appId、openId 隔离，存到 `.runtime/agent_repo.sqlite`（目录 0700、数据库 0600），不存聊天正文或凭证。该文件应被仓库 `.gitignore` 忽略；本地访问与备份权限由管理员管理，目录划分不提供会话隐私隔离。已存在资料的缺失字段保留上次值；自动资料刷新不覆盖人工更正。删除资料不影响飞书通讯录和个人回复偏好；再次互动会重新采集。

邮箱同步优先使用飞书 enterprise_email，缺省时使用飞书 user.email；邮箱前缀只显示为 Gitea 账号候选。管理员可确认或更正映射；实际建 Issue 前仍需通过项目 Tea 技能核对人员账号及指派权限。插件不会读取 Gitea 凭据或自行验证账号。飞书字段可见性受应用通讯录范围、邮箱与部门权限影响；缺失时保留未知，不能用姓名猜账号。

模型输入仅按私聊/群聊展示精简后的单份对话人员资料；完整记录留在每个 Agent 的人员库按需查询，并随可信 SourceTask 固定到 agent_worker 后台任务，后续群消息或资料更正不改变已提交任务的人员快照。用户说“将上面排查的 BUG 记录给 @某人”时，提问人映射为 Issue 正文顶部 recorder，明确指定的被提及人映射为原生 Assignees；原生 Gitea 作者仍由实际认证账号决定，不使用 sudo。资料只提供身份映射，不提供业务写入授权；项目 Issue 技能仍负责查重、账号核验、创建和回读。此次开发不创建真实 Issue，不自动部署、重启或应用 Worker 配置。


## Worker 全局协作技能

agent-repo 负责根据当前 Main 的已加载插件和工具目录自动生成 Worker 协作技能。Main 可调用 `agent_repo action=worker_skill` 刷新；Agent Worker 准备委派和 Main 回复原任务时也通过共享 Agent Repo API 刷新。数据来自公开的 `plugins.list`、`tools.catalog` 接口。宿主允许时使用 `runtime.gateway.request`；本地第三方插件被限制时，复用宿主启动时的 Node 与 CLI 入口，执行官方 `openclaw gateway call` 的同样只读查询（不依赖交互式 shell PATH），命令有截止时间和输出上限，不向技能传递凭证。其他宿主错误或 CLI 不可用时明确失败，不修改宿主信任设置，不从私有 registry 或插件配置猜测已加载能力。

全局目录取 Agent Worker 配置的 codexHome，默认 `~/.codex/skills`。按可信 agentId 隔离技能名和版本，`agents/openai.yaml` 设置 `allow_implicit_invocation: false`，仅在 Main 显式委派时加载。正文包括协作职责、已加载插件、候选工具名及用途、Main/Worker request/reply 协议；不导出配置或凭证。候选目录位于会话过滤之前，最终权限与参数仍由 Main 核验。

插件/工具目录或协议内容变化会产生新哈希。生成文件按锁串行、原子替换，保留完整版本文件供已排队或复用会话读取。新委派和原任务恢复收到 load/reuse/reload 通知；运行中的 CLI 不主动插入消息。拒绝覆盖同名非托管技能和链接目录；崩溃遗留发布锁需核验后处理。技能加载通知不是正文读取证明。
## 快速开始：从模板接入 OpenClaw

角色仓库模板：[Lydanne/agent-repo-template](https://github.com/Lydanne/agent-repo-template)。先用 Use this template 创建独立仓库，修改角色文件和 projects.json，克隆项目到 `projects/<项目ID>`，提交角色/技能改动。详细步骤见 [模板建仓指南](https://github.com/Lydanne/agent-plugins/blob/main/docs/agent-repo-template.md)。模板和业务项目都是独立 Git 仓库；项目目录不作为角色仓库的 Submodule 提交。

1. 按 [OpenClaw 接入指南](https://github.com/Lydanne/agent-plugins/blob/main/docs/openclaw-setup.md) 安装 agent-repo 插件。
2. 将可信 Agent（例如 main）绑定到角色仓库绝对路径，先保持 sync 关闭。
3. 管理员用 inspect 核对登记。要变更已有 Agent workspace 时生成 `plan --activate-workspace`；完整旧系统切换使用 `--prepare-migration`。普通 plan 只绑定插件，不修改 workspace。
4. 审查 plan 的 patch、warnings 和 blockers，使用宿主 config patch dry-run 校验，再在授权维护窗口应用和重新加载。
5. 主会话调用 list、inspect、skills 验收；需要 Worker 时采用 projectRouting=auto 或 agent-repo，审查机器参数及角色政策。旧版使用 skillContextRoot。

### 主会话工具示例

以下 JSON 是 OpenClaw 模型调用 `agent_repo` 的参数，不是 shell 命令：

```json
{"action":"list"}
```

```json
{"action":"inspect","projectId":"demo"}
```

```json
{"action":"skills","repository":"projects/demo"}
```

```json
{"action":"skills","repository":"projects/demo/repositories/server"}
```

list/inspect 不联网更新，inspect 的 ahead/behind 基于已获取 refs。skills 在 sync 启用时可执行安全同步，因此不要把所有工具操作都表述为只读。skills 返回索引后，Main 读取适用 SKILL.md 及规范路径，再将相同 repository 交给 agent_worker。

### 项目选择规则

| 输入/布局 | 行为 |
| --- | --- |
| 只有一个登记项目，省略选择 | 自动选择唯一项目 |
| 多个登记项目，省略选择 | 要求明确选择；defaultProject 不作为运行回退 |
| `projects/demo` | 使用角色技能＋当前项目技能；Worker cwd 为 demo 项目根 |
| `projects/demo/repositories/server` | 再继承 server 的技能/规范；Worker cwd 仍为 demo 项目根 |
| 任意绝对目录、其他 Agent、兄弟仓库 | 不能作为路由参数使用 |

可用性排查先看可信 agentId、repo/workspace 是否匹配，再看 origin/tracking、独立 Git 根、已提交技能/规范和 hook 权限。多 Agent binding 可独立登记，但 worker 单实例机器配置及完整迁移计划仍需按实际 Agent 审查，不能据此宣称任意多 Agent 路由已经启用。

## 供 Agent Worker 使用的项目 API

共享包 `@openclaw-plugins/agent-repo-api` 提供版本为 1 的本地接口：`listProjects()`、`inspectProject({projectId})`、`prepareExecutionScope({projectId,repository,expectedRegistryRevision})`。这是自有插件合同，不增加 HTTP 服务或 Gateway RPC，共享包不携带角色、项目、记忆或凭证数据。构建时将唯一 API 实现复制到两个插件的 dist，随 tarball 交付；独立安装不依赖发布私有 workspace 包。

服务按可信 agentId 发现并核对会话归属；模型不能指定其他 Agent、任意 cwd/root 或远端。API 列表只读已提交登记，不 fetch、不扫描技能、不创建任务，返回 registryRevision、singleProjectId 和相对 repository。未安装项目仍可列出，prepare 检查就绪状态。agent_repo list 保留旧字段，已提交登记可核对时返回 registryRevision，未准备的角色仓库返回 null。

prepare 复用项目同步与技能准备队列：单项目自动选择，多项目明确选择；选择器冲突、登记版本变化时拒绝。返回 cwd、scopeDirectory、root、项目/仓库、技能、规范与快照。Worker 固定单任务范围，启动前继续检查登记、项目分支与 origin。模型轮次中不重新更新角色根。

准备失败沿用 SYNC_BLOCKED（同步启用）或 PROJECT_NOT_READY（同步关闭）；明确的仓库安全阻塞、Git 状态检查超时和索引输出超限会保留可公开的具体原因，其他异常不回显原始命令、stderr 或凭证。登记读取也采用相同错误边界。本地 Git 检查使用最长 15 秒的单命令预算；Git 同步调用仍采用配置的 timeoutMs。超时停止准备，不自动重放业务请求或跳过安全检查。

同步超时的失败原因记录仓库、阶段、固定 Git 命令形态、该命令耗时、同步总耗时及预算，沿用仓库日志持久化；同步器结果同时提供结构化 `diagnostic`。日志省略远端 URL、配置值、任意路径、环境变量和子进程输出。Git 的 `merge --ff-only` 会等待仓库的 `post-merge` Hook，因此 HEAD 已快进不代表同步已完成；诊断为 merge 超时时还需检查 Hook 链路。同步器仅设置 `OPENCLAW_WORKSPACE_SYNC_ACTIVE=1`，项目 Hook 是否识别该标志由项目实现决定，不自动禁用 Hook 或放宽超时。

配套 Worker 新增 projects/projectId，兼容 repository，并按项目/仓库范围分别保留 topic 上下文。技能继承与隔离不变；服务支持代际释放和热重载，旧 scope provider 暂留兼容。设计见 docs/agent-repo-worker-project-api.md。

## 项目、技能与子代理侧边栏

启用 OpenClaw **Settings → Labs → Custom plugin UI** 并加载新版插件浏览器资源后，在当前会话右侧面板选择 **项目、技能与子代理**。项目、技能和子代理功能统一通过此面板提供，不注册左侧导航或独立页面。列表按宿主选中的可信 Agent 读取 projects.json；可选择项目及其直接子仓库，搜索技能，展开查看描述、相对来源路径、最近更新及生效条件。

界面沿用 Agent Worker 的紧凑字号、间距、项目页签、状态圆点及折叠详情样式，适配窄侧栏。技能更新时间在折叠行中直接显示，展开状态按来源路径独立保留。

- 角色技能共享于该 Agent；当前项目根技能被当前子仓库继承；子仓库同名优先于项目根，角色技能同名优先级仍最高。其他项目及兄弟仓库技能不进入当前范围。
- 面板区分范围内候选、配置禁用、禁止模型调用、同名覆盖和待提交变化。更新时间是技能目录最近一次 Git 提交时间，包括 references/assets，未提交修改单独提示；扫描展示已提交内容。
- **查看 Worker 项目任务 ↗** 跳转到配套 Agent Worker 页面，保留 Agent、当前会话和项目筛选。无该 Agent 的选中会话或 Worker UI 未加载时按钮禁用；不创建后台任务，不跨会话汇总任务。
- 刷新只读取本地 Git 与登记文件，不 fetch/pull，也不刷新 Main/Worker 的执行快照。候选列表不保证宿主已加载或模型已读取技能正文。项目来源不可读时单独提示。

公开 Control UI 仅注册 panel，数据通过 `plugins.sessionAction` 的 `projects-list/detail/chunk` 读取并要求 `operator.read`。没有匹配的选中会话时，项目浏览使用 `agent:<agentId>:agent-repo-catalog` 只读路由标识，让宿主解析可信 Agent 身份；此标识不创建、选中或读取聊天，不用于 Worker 跳转。服务端保留 Agent/会话归属核对，只接受登记项目及已扫描仓库选择器；不接受任意路径。跨插件跳转使用版本化 UI 桥，由 Worker 通过自身公开导航 API 打开页面，不依赖宿主路由细节。界面入口和打包内容需随部署重新加载；构建不自动重启 Gateway。

### 子代理（subAgent）定义扫描

每个 Tab 同时展示“技能”和“子代理”。第一个 Agent Repo Tab 展示角色仓库定义，项目 Tab 展示当前项目及选中的直接子仓库定义；共享定义数量与 Agent Repo 跳转一并保留。搜索覆盖名称、描述、来源和相对路径；展开可查看模型、推理强度、更新时间、提交、关联文件及适用范围。

| 来源 | 扫描格式 |
| --- | --- |
| `.agents` | `.agents/agents/**/*.md`，YAML frontmatter 的 name/description/model；无 frontmatter 时用文件名及首段描述 |
| `.codex` | `.codex/agents/**/*.toml`，原生 name/description/model/model_reasoning_effort；旧 `.codex/config.toml` 的 `[agents.<name>]` 及同仓库 `.codex/` 内 config_file TOML |
| `.opencode` | `.opencode/agents/**/*.md`，兼容 `.opencode/agent/**/*.md`；`.opencode/opencode.json`、`.jsonc` 的 agent 配置；仅展示 mode 为 subagent/all（默认 all）的定义 |

Markdown/TOML 目录最多扫描六层文件，跳过 README.md；不把 `.agents/skills/*/agents/openai.yaml` 等技能元数据当作子代理。不扫描用户主目录、其他项目、兄弟仓库、根目录 opencode.json 或外部引用。格式依据 [Codex 子代理文档](https://developers.openai.com/codex/subagents) 和 [OpenCode Agents 文档](https://opencode.ai/docs/agents/)，兼容旧登记仅用于只读展示。

面板中的定义索引与 OpenClaw `/subagents list` 的本会话运行记录不同；扫描本身不会启动或注册子代理。宿主已识别的只读管理指令（`/help`、`/commands`、`/status`、`/whoami`、`/agents`、`/subagents`）跳过 `before_dispatch` 仓库同步，授权和回复仍由宿主及渠道处理。技能调用、上下文压缩和普通任务继续按原规则准备仓库。

只读取 Git HEAD 的普通文件，拒绝软链接和跨仓库 config_file；未提交新增/修改只提示，不作为已提交定义展示。单个文件不超过 256 KiB，目录树不超过 2000 项；无效定义单独提示，其他有效定义仍可显示。更新时间来自定义文件最近一次提交；Codex 登记引用的配置文件变化也计入时间。响应只保留展示所需元数据，不返回完整配置、提示词或认证字段。

目录索引按“来源工具＋名称”判断同名：当前子仓库覆盖项目根，角色仓库同名优先；不同工具的同名定义分别展示，同一仓库同一来源重复定义标为需核对。禁用项及 OpenCode hidden 分别提示。**这是查看范围与候选索引规则，不是执行器的运行时继承规则**；扫描不会向 OpenClaw/Codex/OpenCode 注册子代理、改变 Worker 调度或开启调用权限。实际可调用能力必须按对应 CLI 的配置、版本与信任边界另外验收。

## 配置

```json
{
  "plugins": {
    "load": {"paths": ["/absolute/openclaw-plugins/packages/agent-repo"]},
    "entries": {
      "agent-repo": {
        "enabled": true,
        "hooks": {"allowConversationAccess": true},
        "config": {
          "agents": {
            "main": {
              "repo": "/absolute/work/agents/ada-agent",
              "defaultProject": "demo",
              "sync": {
                "enabled": false,
                "timeoutMs": 30000,
                "branch": "main",
                "remote": "origin",
                "preserveLocalMemory": true,
                "inboundChannels": {"feishu": {"messageIdPrefix": "om_"}}
              }
            }
          }
        }
      }
    }
  }
}
```

宿主要求外部插件显式配置 `plugins.entries.agent-repo.hooks.allowConversationAccess=true` 才能注册 `before_prompt_build` 和 `before_agent_run`。这些钩子按可信 Agent 与所选仓库提供开发技能范围索引及本轮模型执行前校验；不开启时只读工具仍可使用；即使直接配置 sync.enabled=true，入站同步及 Worker/provider 也会在 Git 操作前明确拒绝，不能以缺少技能注入和执行检查的状态继续同步。plan 输出包含这一权限差异，管理员应先核对插件来源；不会替其他插件开启权限。

现有 plugins.load.paths、plugins.allow 和 tools.allow 要保留；存在显式工具白名单时加入 agent_repo。不要将这个片段当作替换整个 OpenClaw 配置的文件。使用宿主官方安装/配置接口，由管理员审查后接入；不代表上述能力已在生产启用。配置 labels/help 为同页中英对照。

## 部署私有配置

插件发布默认值不保存开发者机器路径、内部 Git 地址或企业 Hook 标记。部署时显式配置：

- Worker 的 `state`、`cwd`、`node`、`cli`、`codexHome`、`pathPrefix` 和角色政策放在私有 `plugins.entries.agent-worker.config`；既有任务与登录态不会自动搬迁。
- 项目 Git URL 和分支在各角色仓库自己的 `projects.json` 中登记；本文和测试只使用合成项目与域名。
- Feishu 工作卡片默认使用插件自带 GIF；可用 `channels.feishu.workingCard.waitingImage` / `workingImage` 分别指定绝对路径覆盖对应素材。自定义素材建议放在插件安装目录外，避免升级替换安装包时丢失。
- Agent Repo 同步的额外环境变量放在 `plugins.entries.agent-repo.config.agents.<agentId>.sync.gitEnvironment`。它作用于该 Agent 的根仓库、所选项目和定时子仓库 Git 进程；旧 Feishu 同步仍使用 `channels.feishu.workspaceSync.gitEnvironment`。

例如仅为当前 Agent 的 Git Hook 设置部署专用标记：

```json
{"gitEnvironment":{"CUSTOM_SYNC_MARKER":"1"}}
```

省略时沿用通用 `OPENCLAW_WORKSPACE_SYNC_ACTIVE=1`；空对象禁用这个默认额外标记，不清除父进程继承的环境变量。配置按 Agent 隔离，不修改宿主全局环境。既有 Hook 若依赖其他标记，应将真实变量名和值写入私有配置。UI 和运行时均限制最多 100 项、合法环境变量名和字符串值；不接受 NUL。插件升级后再应用新增字段，旧安装包不一定接受新 schema。

## projects.json 合同

```json
{
  "schemaVersion": 1,
  "projects": {
    "demo": {
      "name": "Demo",
      "url": "https://example.invalid/team/demo-project.git",
      "branch": "main",
      "repository": "projects/demo",
      "skills": ["projects/demo/.agents/skills"],
      "knowledge": "projects/demo/wiki"
    }
  }
}
```

项目 ID 最长 64 字符，允许字母数字、连字符和下划线，首字符须字母数字。repository 固定为 projects/<项目ID>（须与登记键一致），直接指向独立业务仓库，skills/knowledge 必须在对应项目内。路径相对 Agent Repo，拒绝绝对路径、..、目录重叠和解析后逃逸仓库的软链接。URL 不允许密码、HTTP 用户信息、签名查询或片段；最多 100 个项目、20 个技能目录、256 KiB 登记文件。

记忆统一采用 OpenClaw 工作区规范：根目录 `MEMORY.md` 保存长期记忆，`memory/YYYY-MM-DD.md` 保存日常记录。项目登记不含 memory 字段，list/inspect 不输出项目记忆路径。旧 projects.json 须删除各项目的 memory 字段；原目录有数据时先复核再整理，不能直接删除经验。

## 管理员 CLI

```bash
node packages/agent-repo/cli.mjs inspect --repo /absolute/work/agents/ada-agent
node packages/agent-repo/cli.mjs plan --agent-id main \
  --repo /absolute/work/agents/ada-agent \
  --config /absolute/user/.openclaw/openclaw.json --default-project demo
```

tarball 安装使用 `--installed`，或提供带 plugins.installs.agent-repo.installPath 的安装配置；计划不会再添加同一插件的源码 load.paths。首次三插件接入使用 [模板操作步骤](https://github.com/Lydanne/agent-repo-template/blob/main/docs/openclaw.md) 的完整配置生成器，旧环境迁移才使用 --prepare-migration。

plan 输出 agent 检查、project IDs、patch 和 warnings；将经过审查的 **patch 字段**保存为补丁文件，使用 OpenClaw `config patch --file <补丁文件> --dry-run` 校验，再按管理员授权应用。支持明确的 --activate-workspace，但需存在唯一匹配的 agents.list 项或 agents.entries.<AgentID> 项，并保留其他 Agent 和字段。默认计划不回显整份配置；显式 workspace 计划需保留输入 Agent 配置格式及其他 Agent，管理员应按私有配置审查和保存。CLI 报错不回显配置内容。当前 CLI 输入为标准 JSON；JSON5 配置须先通过宿主正规接口导出为标准 JSON。

Agent Repo 切换须另外核对 Feishu workspaceSync、agent_worker cwd、角色技能发现、原生记忆来源及旧后台任务交接；只改 workspace 不能完成整套迁移。项目列表成功也不能说明代码、记忆或业务结果已经通过验收。

## 验证

Node 24.19+；pnpm build 和 pnpm test。测试使用根 .tmp/ 内临时仓库与模拟宿主，覆盖多 Agent 隔离、路径校验、只读 Git 检查及配置计划，禁止加载生产配置、原始对话、凭证或向飞书发送消息。

## 从旧插件 ID 迁移

插件目录、包名和 ID 从 `ada-agent` 改为 `agent-repo`。把旧 `plugins.entries.ada-agent` 整体迁到 `plugins.entries.agent-repo`，移除旧 entry；更新 `plugins.load.paths` 中明确指向旧插件目录的路径，以及已有 `plugins.allow` / `plugins.deny` 中的旧 ID。通过官方 `openclaw plugins install --link` 注册新插件，再校验配置并重启 Gateway。

工具从 `ada_project` 更名为 `agent_repo`，同步替换显式 `tools.allow` / `tools.deny` 中的旧名称。插件更名不要求角色仓库更名。Ada 角色仓库及目录名保持 `ada-agent`，例如 `/work/agents/ada-agent`；`config.agents.<agentId>.repo` 必须指向实际角色仓库的绝对路径。角色目录发生变化时重新生成并审查迁移补丁，不依赖旧目录软链接；项目登记使用相对路径，记忆和项目目录随角色仓库一起迁移。

## 迁移准备（不切换运行时）

运行 `node packages/agent-repo/cli.mjs plan --agent-id main --repo /absolute/ada-agent --config /absolute/openclaw.json --default-project demo --prepare-migration`。输出 workspace、worker cwd、skillContextRoot、技能来源和双仓同步差异，以及 ready/blockers；只读生成，不自动应用或搬迁数据。完整迁移仍支持一个实际 Agent，并将角色政策写入既有全局 worker 配置；同步只按当前请求选择项目，defaultProject 仅用于完整迁移规划。账号级独立 Feishu 同步覆盖需另行审查。

规划前由管理员获取两仓远端 refs：Agent Repo 必须在 main，追踪 origin/main，且 ahead/behind 均为 0；Project Repo 必须匹配登记的 origin/<branch>，同样无领先或落后提交。缺少已获取的 tracking、追踪错误或版本未对齐均阻止激活。plan 不执行 fetch，ready 只证明本地预检通过，不表示远端刚刚刷新或渠道验收完成。

角色仓库提供 `tools/agent-worker-policy.json`：schemaVersion=1，四个字符串 executorInstructions、businessDataPolicy、asyncInstructions、delegationInstructions（每项最多40000字符）。`{projectDir}` 替换为登记的项目绝对路径；不得设置 CLI、状态目录或其他机器参数。政策由管理员在应用计划时写入 worker 配置，修改后重新生成计划；已准入任务仍保留原快照。

新计划启用 `plugins.entries.agent-repo.config.agents.<agentId>.sync.enabled`，同时将 `channels.feishu.workspaceSync.enabled` 设为 false，保留旧同步的其他字段以便回退。Agent 根目录来自 binding.repo，项目目录、URL 和分支来自 projects.json；默认读取项目 wiki；显式 knowledge 优先。只有已声明的 wiki Git 子模块参与子模块同步，普通目录随项目同步，独立 Git 工作区仅读取本地内容。角色技能来自 Agent Repo skills/，开发技能来自独立项目的登记目录，组合索引以 Agent Repo 为根；worker 的 skillContextRoot 指向这个根，cwd 仍为 projects/<项目ID>/。业务项目角色文件不覆盖 Ada 角色。原有 Feishu 单仓同步和技能刷新配置暂留兼容，不自动关闭或切换；两种同步入口不可同时启用。

角色仓库与所选项目顺序更新，不提供跨仓原子回滚；任一失败不进入模型。角色仓库与项目同步调用分别遵守 timeoutMs，项目及其子模块共用项目调用的超时预算，每个仓库均检查 Git 安全状态；本地共享记忆按 preserveLocalMemory 规则处理，冲突时阻止自动同步，管理员应复核后交付，不能自动提交、stash或覆盖。

## 按仓库继承技能

迁移后，插件在每轮主会话中提供当前可信 workspace 对应的技能索引；workspace 是 Agent Repo 时仅单项目自动选择，多项目由 Main 明确选择。主会话要处理具体子仓库时，先明确调用：

```json
{"action":"skills","repository":"projects/demo/repositories/frontend"}
```

工具仍为 agent_repo。有效目录是 Agent Repo 的 skills/、projects/demo/.agents/skills/ 和当前 frontend/.agents/skills/；不加载 backend 等兄弟仓库。同名时 frontend 覆盖 Project 根技能，Agent 专用角色技能优先于开发技能。读取本任务适用的 SKILL.md 及引用后，agent_worker run 传相同 repository；省略时每个新任务仍仅单项目自动选择，多项目由 Main 明确选择，不沿用其他任务或会话的目录。repository 仅允许登记的 projects/<项目ID> 或 projects/<项目ID>/repositories/<名称>，不是任意 cwd 或跨 Agent 路由。

Agent Repo、Project 和选中的子仓库必须各自有可验证的 Git 根；业务子模块须先由管理员按需初始化。技能和角色规则必须已提交；未提交修改会拒绝加载，日常 memory/ 改动不属于技能快照检查。索引包含引用文件的版本，后台接纳任务时固定 cwd 和索引；开始业务前再次核对仓库 HEAD、技能与角色工作树，变化则停止该任务，不悄悄改用新版本。同一个 topic 切换目录会建立符合新范围的 CLI 会话，不把旧目录会话直接复用。

插件通过公共 before_prompt_build 和工具结果提供可供模型读取的范围索引，不修改 OpenClaw 私有实现，不注册新的原生 /skill 命令。不要把 projects/ 或所有项目、子仓库放进全局 skills.load.extraDirs；迁移计划会移除所有登记项目的全局目录，保留不相关配置。原生 skills info 主要验收角色技能；开发技能用 agent_repo skills 和 worker 报告中的 cwd/appliedSkillsRevision 验收。宿主 skills.entries 的禁用项和当前 Agent 的技能白名单也会过滤此索引。

迁移计划还检查 Project AGENTS.md 中遗留的 Ada 工具/后台角色约定，避免切换后读取已停用工具规则。角色分离须作为业务根仓库变更交付，通用开发规范保留。

迁移计划启用 agent-repo binding.sync.preserveLocalMemory：只在 Agent Repo 且不合并通用上游的模式下，保留未暂存的 MEMORY.md 和 memory/YYYY-MM-DD.md。远端改动不涉及这些本地路径时可以快进；涉及同一文件或其祖先路径时明确阻止，不自动提交、stash 或覆盖。其他本地改动与所有暂存项仍阻止同步；项目及 wiki 不继承该例外。

## 多项目范围与旧布局兼容

新登记使用 projects/<项目ID>，例如 projects/demo 与 projects/another；projects/ 整体 Git 忽略，各项目为独立仓库。省略 repository 时仅有一个登记项目才自动选择；多个项目必须由 Main 按用户意图明确选择，defaultProject 仅用于管理员迁移规划，不作为任务回退。显式 repository 决定项目；同时传 projectId 时两者必须一致。Agent 角色技能共享，项目与子仓库技能仅扫描当前范围；未初始化的其他项目不影响当前项目的技能目录扫描。旧 project 布局继续兼容，只服务对应登记，不自动转换到另一个项目。

技能源为 Agent skills/、当前项目 .agents/skills/、当前子仓库 .agents/skills/。两个项目同名技能互不混入；禁止把 projects/ 或所有项目技能加进全局 extraDirs。Worker 固定所选项目与仓库快照，旧 CLI 会话不能跨 cwd 复用，其他会话仍独立选择自己的任务范围。多项目不提供共享记忆的私聊权限隔离。

新迁移计划启用 Agent Repo 原生同步：入站单项目自动准备，多项目只准备角色根；agent_repo skills 或 worker provider 在明确选择项目后准备该项目。计划生成不意味着目录搬迁、配置应用或服务重启。

## Main 与 Worker 项目协作

Main 先读取 agent_repo list：只有一个项目可自动选择；多个项目按本轮用户意图明确 projectId 或 repository，存在歧义时询问。随后用 agent_repo skills 核对技能并读取适用正文，agent_worker run 传相同 repository。Worker cwd 始终是所选独立项目根 projects/<项目ID>/；repository 的 repositories/<仓库> 后缀只决定继承技能和仓库规范范围，不改变 CLI --cd。工具返回 cwd 为执行根，scopeDirectory 为技能范围；任务提示携带 projectId、repository 与 cwd。其他项目和兄弟仓库技能不加载。

每个任务独立选择项目；多项目即使配置 defaultProject 也不自动回退。新技能快照使用 protocol=3，将执行根与技能范围分开，固定项目根和当前子仓库 AGENTS.md 的版本并在执行前检查未提交变更。规范变化会建立新的 CLI 会话；任务提示的 instructions 列出必须读取的规范路径。已接纳的 protocol=1/2 历史任务保留原目录与版本校验；新任务不沿用其目录规则。生产未应用迁移配置前不得声称这些路由已启用。

迁移预检要求 Project Repo 与已获取的 origin/<登记分支> 完全一致；ahead、behind、错误 tracking 或缺失 upstream 均阻止激活。计划不联网获取远端，管理员生成计划前须刷新根仓库引用，并另行在隔离克隆验证所需子模块对象可获取；本机已有对象不等于新机器能恢复。

## 独立的原生同步入口

`sync` 默认关闭；新代码不会根据旧 Feishu 配置自动启用同步。启用后由 Agent Repo 订阅宿主 `message_received`，仅观察入站信息，不依靠此观察事件等待 Git 更新。真正的同步屏障在可等待的 `before_dispatch`：仓库同步成功后允许模型调度。普通代码存在未提交或暂存改动时保留现场、跳过该次同步，继续使用当前本地资料；随后角色、技能、项目登记及版本校验仍须通过。其他同步错误和规范校验失败返回 handled 和公开失败说明，阻止本轮进入模型；只抛异常不足以阻止宿主继续调度。

入站自动同步按可信 Agent 与宿主 workspace 绑定，二者必须指向同一实际角色仓库。管理员可通过 `sync.inboundChannels` 登记允许自动触发的渠道及真实消息 ID 前缀：默认 `{ "feishu": { "messageIdPrefix": "om_" } }`。未登记渠道或 ID 不匹配不启动入站自动同步；内部 worker completion 不冒充真人请求，消息正文也不作为身份依据。停止、取消、状态及已匹配当前任务的飞书催问沿用渠道旁路流程。所选项目的工具/provider 同步不依赖入站渠道筛选。

同步根只使用 binding.repo，根分支和远端来自 binding.sync；项目远端使用登记 URL 对应的 origin，项目分支来自 projects.json。未配置 submoduleSchedule 时，仅一个登记项目的入站同步角色根、项目、明确登记的 wiki，以及当前项目 `.gitmodules` 声明的 `repositories/<名称>` 直接子模块；多个项目时入站只同步角色根，不使用 defaultProject 自动选择。明确 `agent_repo skills` 或 worker repository 后，先同步所选项目及其同样的子模块范围（角色根不在已开始的模型轮次中重新更新）；其他项目不更新。不会自动 clone、初始化项目或子模块、切分支、提交 gitlink、stash、reset 或 push。

可将子仓库改为每日定时同步，配置在 `plugins.entries.agent-repo.config.agents.<agentId>.sync`：

```json
{
  "enabled": true,
  "submoduleSchedule": { "time": "08:00", "timeZone": "Asia/Shanghai" }
}
```

配置后，普通消息、`agent_repo skills` 和 Worker 准备仍安全同步角色/选定项目根，但不 fetch 或更新 wiki、业务子仓库；技能索引从这些子仓库现有本地提交生成。插件通过 OpenClaw `getCron()` 注册原生每日计划，使用无工具脚本时钟和 `cron_changed` 接收触发，已移除插件内的分钟轮询定时器，不创建 AI 会话、Worker 任务或飞书消息。每日北京时间 08:00 为每个绑定 Agent 更新其全部登记项目和子仓库，不依赖当天收到消息；多项目不改变 Main 的任务选择规则。Gateway 停机错过执行点时，启动后补当天一次；不会补过去多天。省略 `submoduleSchedule` 保持原有按请求更新子仓库的行为，`sync.enabled=false` 同时关闭两种同步。

调度与入站/Worker 准备共用 Agent 串行队列及原有 Git 安全检查。Git 目录内 `agent-repo-daily-sync-<agentId>-<日期>.json` 保存独占领取记录、完成或失败状态，防止重启、热重载或多进程当天重复同步；失败或执行中崩溃当天不自动重试。独立项目失败后继续检查其他登记项目，详细阻塞原因写入该本地记录，Gateway 日志只记录状态摘要。定时失败不将每条用户消息重新变成子仓库同步；任务读取保留的本地版本，现有技能、登记和版本验证仍执行。已完成更新不会回滚，gitlink 偏移不自动提交。机器/Gateway 必须运行才能在执行点同步；执行过程中收到消息会等待同一准备队列。

项目面板的「定时任务」先展示当前可信 Agent 的任务目录，再进入任务查看执行记录，最后查看某次执行的失败原因和日志。第一阶段仅将每日仓库同步映射为只读系统任务；没有首次运行记录也会展示已配置任务，任务启停状态与最近执行结果分开。未配置每日计划的按请求同步不会被列为定时任务；已取消计划但仍有历史记录的系统任务继续以「未配置」状态保留。新建、编辑、启停和原生自定义任务接入留待后续实现，不注册写操作。

进入任务后使用同一个原生模态弹窗切换「执行记录」「任务设置」；点击某次执行切换到日志详情，返回时恢复原记录焦点，不叠加弹窗。设置只读展示 Agent、范围、计划、时区和任务状态。关闭按钮、Esc、遮罩关闭恢复任务列表焦点；切换 Agent、会话、项目、失去权限、隐藏面板或任务从目录消失时关闭。列表和任务详情不触发 Git 同步，按需读取日志也不会重跑任务。

逻辑任务标识为 `repo-sync:<agentId>`，每日执行标识为 `repo-sync:<agentId>:<YYYY-MM-DD>`。新 receipt 写入 taskId/runId；旧记录只在读取时根据可信 Agent 和日期映射，不重写文件。只读 `projects-taskRecord` 要求 taskId、runId 与当前可信 Agent 的系统任务匹配，不接受任意路径或其他 Agent 参数；原 `projects-syncRecord` 日期入口保留兼容。两者要求 `operator.read`，沿用会话及分块传输隔离。未来其他调度来源可提供独立执行 ID，不再把所有记录混在一个日期列表中。

下次计划按配置时区的本地日历计算：当日尚未到执行点显示当日；当日 receipt 已存在（包括失败或未结束）显示次日；已过执行点而无 receipt 显示计划已到但暂无记录，不能据此确认是否已经尝试执行。它是配置计划，不保证 Gateway 停机期间实际执行，也不改变每日独占领取和失败不重试的规则。角色 Tab 与项目 Tab 展示该 Agent 的全部登记项目同步任务，明确标注范围，不能将全局调度误认成当前子仓库任务。

新记录保存带时间戳的检查、拉取、快进更新及仓库完成/失败事件，包含项目、仓库、分支和最终提交；不保存 Git 原始 stdout/stderr、认证信息或完整命令。阶段日志按执行原子更新，最多 400 条且合计不超过 256 KiB，达到上限会显示提示。旧记录仍能查看原有结果并提示没有详细日志；未结束不等于进程仍在运行，崩溃也可能遗留该状态。刷新扫描重新读取记录，不自动重试或删除历史。


业务子仓库登记在项目根快进后重新读取，远端固定为 `origin` 且 URL 必须匹配 `.gitmodules`；目标分支使用该子模块的 `branch`，缺省时沿用登记项目分支。例如示例项目的 frontend 使用 develop、exporter 使用 master、content-service 使用 main；以实际登记为准。仅快进目标分支或标准 detached HEAD，并保留原状态；未初始化、本地修改、任务分支、未推送提交、分叉、非法登记或远端不匹配均阻止本轮。忽略未登记的目录、repositories 之外的非 wiki 子模块及嵌套子模块；不执行递归更新。当前项目及子模块共用该项目同步调用的 timeoutMs 预算，超时保留已完成更新。更新后的 gitlink 偏移留在未暂存状态，不自动交付。

Git 同步范围与技能加载范围分开：即使更新当前项目的所有业务子仓库，模型仍只使用角色、项目根和明确选定子仓库的技能；兄弟仓库技能不加载。技能索引根据同步后的本地提交重新构建，不复制技能正文，不把同步成功视为正文已读取。

同一角色仓库的入站准备与 Worker/provider 准备共用串行队列，覆盖根同步、登记读取、项目和子模块同步及技能索引构建，跨仓不是原子事务。登记必须是已提交的普通文件，准备期间角色根版本或登记变化会阻止本轮；其他进程不受此内存队列控制，仍通过版本复查发现变化。根更新成功但项目/wiki/业务子仓库失败时保留已完成更新，并阻止继续执行；下一轮重新核对。保持 Git 脏文件、暂存项、未推送提交、分叉、Git 操作中和超时保护。原生 memory Markdown 的未暂存修改仅在 preserveLocalMemory 的安全规则下保留，远端路径重叠仍拒绝；此例外不扩展到项目及其子模块。

`before_prompt_build` 捕获本轮仓库/技能版本，并核对当前登记的项目分支和 origin；`before_agent_run` 对该版本、登记及分支/远端做只读复查，不把同一 session 最近一次成功当成本轮许可。不同 SDK harness 没有公共的 admission token，这次复查不等价于所有执行入口都经过同一条入站屏障；接入新渠道或外部 harness 前须单独验证顺序。角色正文和角色 skills/ 继续由 OpenClaw 原生 bootstrap/技能发现加载，本插件不自行重复注入角色正文；技能索引包含 Agent 角色技能及当前项目、当前子仓库的开发技能继承范围，遵循宿主禁用项及 Agent 技能白名单。

只迁移同步入口使用：

```bash
node packages/agent-repo/cli.mjs plan --agent-id main \
  --repo /absolute/work/agents/ada-agent \
  --config /absolute/user/.openclaw/openclaw.json --prepare-sync
```

`--prepare-sync` 必须有既有 Feishu 配置，角色 repo 必须匹配当前 host workspace；目标 agent-repo 插件须已启用、登记加载来源且拥有已有 Agent binding，不可被插件 allow/deny 排除。缺少这些前提返回 blocker，不自动安装或启用插件。它规划指定 Agent binding.sync.enabled=true、必要的 conversation hook 权限以及旧 Feishu sync.enabled=false，不覆写 worker 政策、cwd、状态目录、workspace 或全局技能目录；保留已有 binding 字段、其他 Agent 和其他 hook 权限。显式 hooks.allowConversationAccess=false 或 hooks.allowPromptInjection=false 时保留拒绝并返回 blocker；账号覆盖中存在 workspaceSync 时拒绝自动计划，避免全局停用后账号继承仍执行。旧新同步同时启用也返回 blocker。此选项不可与 --prepare-migration、--activate-workspace 或 --default-project 合用。

预检只读取本地 Git 与已获取引用：单项目检查当前项目，多项目不选择或检查其他项目；ready 不代表远端刚刷新。完整 --prepare-migration 同样开启新同步并停用旧入口，还额外规划既有 workspace 和 worker 政策迁移。两个计划均不应用配置、不重启、不读写运行时聊天数据；生产切换与真实会话验收需要独立完成。

同步配置的渠道名称须以小写字母开头，仅含小写字母、数字、下划线或连字符，长度最多 64；渠道数量为 1–20。真实消息 ID 前缀长度为 1–100 个 Unicode 字符，禁止空字符及换行。配置 schema 与运行时使用相同边界，包含 Git 名称中的控制字符及连续点号限制。


用户明确要求“同步最新代码”时，Main 使用 `agent_repo` 的 `action=sync`，按项目选择规则传 `projectId` 或 `repository`；仅一个项目时可省略，多项目有歧义必须先询问。入口立即同步选定项目根及 wiki、全部登记的直接业务子仓库，不受 `submoduleSchedule` 的每日次数限制，也不更改定时 receipt；技能仍按所选根/子仓库范围加载。成功返回 `synchronization` 中实际 Git 同步结果及技能索引。角色仓库不在已开始的模型轮次中重新更新，普通入站屏障已负责角色准备。同步关闭时拒绝该动作，不将本地索引冒充同步成功；失败保留现场并返回受控阻塞原因。普通 `skills` 和 Worker 准备不触发这项额外同步。此入口不授予业务修复权限，也不自动提交、推送或强制覆盖。

### 日志

管理中心“日志”提供统一的历史记录与实时调试视图，来源通过通用插件接口注册。来源、级别筛选常驻，搜索默认隐藏；更多操作提供查找、分组、重复合并、当前筛选结果复制/导出与原始数据。点击日志在右侧查看结构化详情，窄屏改为下方展开。来源目录声明历史读取、实时采集和清理能力，实时专用来源不会显示误导性的历史数据。

实时调试默认关闭，进入实时视图仍须显式开启，离开视图、页面隐藏或切换 Agent 即停止；Worker 日志由 Main 适配器汇总。实时采集与清理历史需要 `operator.write`，读取需要 `operator.read`。清空当前视图仅清除本页缓存，删除来源历史须另行明确确认。仓库来源继续保留最近 100 条脱敏异常记录；每日定时同步的阶段日志仍在“定时任务”。详见 [通用日志协议与 UI](../../docs/log-console.md)。

手动 `sync` 和每日定时同步仍严格返回真实失败，不把跳过同步算作已更新；角色、技能或项目登记文件的未提交变化仍需管理员复核提交，仓库身份不符、Git 冲突、进行中的 Git 操作和网络错误不会因为本地改动降级策略而获准执行。

### AgentRepo 管理概览

左侧 AgentRepo 的概览从当前 Agent 的项目清单、实体库与仓库日志读取实际统计，提供待处理事项和模块入口。工作区路径、项目登记提交状态、角色技能数量和启用的同步计划均来自本次读取；角色技能不含项目技能，异常记录为最近保留的最多 100 条历史记录，不代表仍未解决的故障数量。读取失败会显示不可读取和具体错误，不能将失败视为零条。概览只读，刷新不执行 Git 拉取、人员同步或任务调度。切换 Agent、离开概览或失去读取权限后，旧请求不能回填新页面。

后续管理能力的范围和优先级见 [管理中心规划](../../docs/agentrepo-management-roadmap.md)。


### Worker 任务联动

概览显示 agent-worker 提供的任务统计，「Worker 任务」模块跨当前 Agent 的所有会话查询、按项目与状态筛选并搜索任务摘要。任务详情跳转至 Worker 原任务，保留可信 Agent、真实来源会话与 jobId。需要两个插件均安装包含此接口的版本；Worker 不可读取时单独报错，其他管理模块仍可使用。统计读取与详情均为只读，不触发任务或仓库同步；执行状态、请求与任务历史始终由 agent-worker 维护，不在 AgentRepo 建立第二份任务状态库。

Worker 全局技能发布使用带进程归属的跨进程锁；仅在确认持有进程退出后回收，活跃发布等待最多 5 秒，无法确认归属的历史锁保留并报错。首次发布先写入私有暂存目录，完整后才公布技能目录，避免崩溃留下无法重试的半成品。目录查询故障时仅复用归属、版本哈希和内容均有效的上一发布版本，并记录告警；以已提交版本指针及其不可变正文为准，不因可变入口 SKILL.md 已写入但尚未提交的新内容而拒绝回退；首次发布没有有效缓存时仍报错。

## 技能与关联 CLI 维护

“项目与技能”内提供技能和关联 CLI 两个视图，点击任意技能或 CLI 在右侧查看详情，窄屏使用单列详情。仓库技能保持当前 Agent、项目及子仓库范围；提供方托管技能另标来源与实际共享范围。技能与 CLI 可相互跳转，未声明依赖时不按技能名称推断安装、授权或托管状态。

AgentRepo 负责 Main 协作技能的已提交版本与重新生成；其他插件通过版本化维护提供方接口声明 CLI、关联技能和可执行动作。Feishu 是一个可选提供方，AgentRepo 不保存其凭证、OAuth 状态或 CLI 安装逻辑。提供方缺失、超时、版本不兼容不会阻止查看仓库技能。

CLI 详情分概览、更新设置、维护记录和诊断。自动更新默认开启，开关和版本固定策略属于 CLI；完整哈希、技能正文和脱敏导出放在诊断。设置先编辑后确认，更新与回退确认影响范围，检查更新直接发起。所有维护写入仍要求宿主 `operator.write`，以服务端校验为准；页面刷新只查询状态，不执行安装或更新。

维护请求使用当前版本及唯一请求标识，后台受理后先持久记录再执行。连接结果不明确时重试原请求，不重新生成标识；重启后未确认结束的操作显示“结果待核查”，不会自动重放。记录保留最近 100 条，超过此数量且结束已满 30 天的记录可在后续维护时清理，界面显示最近 20 条。概览只聚合需处理提示；Worker 的请求额度、投递重试、等待时间和技能版本通知诊断位于任务详情。

## 群内定时请求（开发能力，需显式开放工具）

`agent_schedule` 是可选工具，由 agent-repo 管理计划；复用 OpenClaw 原生调度器，飞书插件将到期事件送入原群 Ada 的 Main → Worker 流程。不发送一条机器人消息再依赖平台回环，也不把定时触发伪装成新的真人授权。部署后仍需管理员显式开放工具及审核 Ada 角色规则；代码构建不修改生产配置、不自动创建计划。

- `create`：必填 `requestId/name/projectId/task/constraints`，选择带时区的未来 `at`，或五段 `expr`＋`timeZone`（默认 Asia/Shanghai）。必须是用户明确授权的一次性或周期任务；projectId 必须已登记。来源只从当前有效的真人群任务捕获，参数不能指定 Agent、账号、请求人、群或会话。定时轮次不能再创建计划。
- `list/get/history/update/pause/resume/remove/run`：仅当前请求人、账号、群及会话代际内的计划，`pause/remove` 使用返回的适配层 `id`。暂停和删除阻止后续/尚未入场的触发，不宣称取消已提交 Worker；正在执行的任务仍按原 jobId 管理。修改与恢复沿用原计划 ID；使用 update/resume，不为调整计划重建。
- 创建按 `requestId` 幂等。调度器写入结果不明时保存 `needs_review`，重试同一 ID 不会再建任务；管理员检查原生任务及私有记录后处理，不能盲目换 ID。原生 jobId 与适配层 id 均返回。
- 原生任务是固定的无工具脚本 `return {};`，使用 isolated、无结果投递、非自动删除；原生 `finished/ok` 事件仅代表到期触发。适配器核对原生任务定义与可信来源，再进入原群 FIFO。只有 Main 入场/Worker 受理证据才记录 `submitted`；不把它称为业务完成。
- 保存原请求人、账号、群、线程、会话代际、依据消息及任务约束。消息撤回或会话重置后拒绝继续；执行时使用当前 Ada 的角色和工具权限。每次生成独立来源任务，原依据继续参与 Worker 撤回与完成校验。
- `(jobId, runAtMs)` 原子去重，已经领取但结果不明的轮次不重放，后续轮次阻塞待核查。前次 Worker 未终结时不重叠提交。原生 `cron_reconciled` 可补交最近一次未领取且成功的 tick；不回放全部历史。
- 原生任务不会额外发群结果；Main 的受理回复和既有 Worker 完成路径负责原群交付。原生调度历史与业务完成状态分别查看。

私有状态位于宿主 stateDir 下 `agent-repo-scheduled-requests/scheduled-requests.sqlite`（0600）；不存进角色仓库或 Git。需要配套 agent-repo、feishu、agent-worker 版本，以及宿主公开 `getCron()` / `cron_changed` / `cron_reconciled`、script payload 和 channel inbound 能力。缺失时不降级为 shell、伪造来源或同步 Worker。当前适配开发针对本机 OpenClaw 2026.10.5 合同；SDK 编译基线仍为仓库锁定版本，不能仅凭类型检查推断所有旧宿主兼容。

验收分层：隔离测试覆盖来源、会话/用户隔离、重复触发、撤回、重置、暂停、未知结果和真实 Worker 来源函数；真实模型与飞书发送需要部署后另行授权验收。

### 群内管理 API

`agent_schedule` 直接提供下列动作，不通过模型工具开放跨群或任意收件人路由：

| 动作 | 参数与结果 |
| --- | --- |
| `create` | `requestId/name/projectId/task/constraints`、`at` 或 `expr/timeZone`；可选 `deliveryMode`。重复 requestId 不重复创建。 |
| `list` | 可选 `projectId/status/query/limit/offset`；返回 `tasks/total/nextOffset`，limit 默认 50、最大 100。 |
| `get` | `id`；返回名称、业务范围、时间、状态、`revision`、`busy/sourceValid`、`deliveryMode/delivery` 和最近接纳状态。 |
| `history` | `id/limit/offset`；返回分页触发记录及 Main/Worker/消息回执；接纳、完成、送达分别判断。 |
| `update` | `id/requestId/expectedRevision`，以及至少一个 `name/task/at/expr/timeZone/deliveryMode`；只改提供的字段，保留原 ID、原生计划、其他字段及启停状态。已结束的一次性任务修改后保持暂停，须明确恢复。 |
| `pause/remove` | `id`，推荐同时传稳定 `requestId` 和 `expectedRevision`；兼容旧调用。删除保留历史，不能当作取消已运行任务。 |
| `resume` | `id/requestId/expectedRevision`；恢复原有计划，过期一次性时间须先修改。 |
| `run` | `id/requestId/expectedRevision`；仅在用户明确要求立即执行时使用原生队列，不改变下一次周期时间，不将入队当作业务完成。 |

`deliveryMode` 可选 `source`（默认，保持创建时原位置）、`group`（原群主会话，全新群消息，不回复话题内原消息）、`thread`（原请求的已知话题，无原话题则拒绝）。`delivery` 返回实际目标和 `canUseThread/threadId`，不接受任意 `chatId/rootId/accountId/sessionKey`；Main 仍在原授权会话中执行。Main 最终卡片和后续 Worker 结果均携带本次执行的投递快照。旧计划缺字段时保持 `source`，修改仅影响后续触发；有正在执行或结果待核验记录时拒绝修改，不抢改在途任务。

例如“日报发群里，保持每天 07:00”，先 list/get 核对唯一计划及版本，再仅提交投递字段：

```json
{"action":"update","id":"<实际计划ID>","requestId":"<本次稳定请求ID>","expectedRevision":"<get返回的revision>","deliveryMode":"group"}
```

成功返回完整计划及 `operation.status`。`update/resume/run` 必须传版本及稳定请求 ID，旧版本冲突要求重新读取，不自动覆盖；重复相同请求 ID 返回原操作回执。返回 `pending/unknown/needs_review` 或写入异常时先 get/history 核验，不能换 requestId 重建或盲目重放。`task` 支持在原约束内根据当前真人的明确请求更新，非空且最多 4000 字符；保留原 ID、原生任务及启停状态，仅影响后续触发，审计记录正文前后值。`constraints/projectId`、原请求人、账号、群和授权来源不能通过 update 改写，正文变更不扩大业务权限；超出原约束的任务须另行授权。读取与管理均不跨请求人、账号、会话代际，不因同名计划猜测对象。

### 联动定时任务目录

管理中心“定时任务”合并展示当前 Agent 的每日仓库同步和 `agent_schedule` 创建的 OpenClaw 联动群任务。后者读取私有来源记录及原生调度服务，展示原请求人、原群、项目、Cron/一次性计划、下次时间、原生任务 ID 和最近30次交接记录。缺失或不可读取的原生计划明确标记，不隐藏已有历史。

原生时钟成功、Main 接纳、Worker 提交及原群消息回执分开显示；只有真实回执显示“消息已送达”，旧 Worker 记录仅展示任务 ID，不推断业务完成。来源及运行记录按受信 Agent 范围过滤，管理目录不改变普通模型工具的当前请求人/会话隔离，也不导入其他 Agent 的原生任务。任务卡片直接提供开始、停止和删除入口，任务详情也可进入“管理此任务”；操作先读取最新状态并确认，刷新不创建或触发任务。

### 控制面板管理定时任务

在 **AgentRepo → 定时任务 → 管理定时任务** 中，`operator.read` 可查看当前 Agent 的任务内容、来源、状态和最近管理记录；`operator.write` / `operator.admin` 才可提交操作。服务端再次校验 Agent 绑定、项目登记、来源有效性、任务版本及确认字段，面板可编辑并确认任务正文前后值；浏览器不能提交任意群、请求人、会话或权限范围。基于已有群请求新建仍继承其正文。

- **基于群请求新建**：选择已有 `agent_schedule` 保存的可信群请求，继承任务、约束、原请求人、账号、群和线程。可填写名称、五字段 cron 与 IANA 时区，或含时区的一次性未来时间。新计划默认暂停，确认后再启用。不从任意历史聊天推导授权，也不支持管理员凭群 ID 创建新授权。
- **修改与暂停/启用**：修改名称、任务正文、执行时间和投递位置，保留来源及原授权约束；正文修改先展示前后值并确认，运行中或结果待核验时拒绝修改。原生计划与本地记录一起更新。一次性过期任务须先改为未来时间再启用。
- **立即执行**：仅对已启用、来源有效、无正在运行或待核验记录的任务开放。通过服务公开的 `getCron().enqueueRun(id, 'force')` 入队，不能直接调用 Main、Worker 或桥接 `deliver`。旧宿主缺少该接口时禁用此操作，不能用本地计时器或 shell 替代。手动执行不更改下一次计划时间。
- **删除**：移入回收站，暂停原生计划和本地后续接纳；保留期内可恢复为暂停，审计独立保留。暂停/删除不等于已取消在途业务或撤销已送达消息。

所有计时、计划更新、触发和立即执行都复用 OpenClaw 原生 cron。AgentRepo 只管理可信请求映射、幂等、来源和执行回执。操作携带版本及稳定 requestId，服务端序列化同任务变更，操作结果持久化在原有私有 SQLite 的 operations 表中。写入响应丢失、进程中断或交接不确定时保留 pending/unknown/needs_review，不自动重放或恢复业务；先核验原生计划与原群记录。原生调度成功、Main 接纳、Worker 提交、原群消息送达分别展示，均不自动等同于业务问题已解决。

每日仓库同步也由同一面板管理，支持修改每日时间/时区、暂停/启用、立即执行、移入回收站、恢复为暂停及启用。首次从 `sync.submoduleSchedule` 导入并建立原生 cron；之后面板设置持久化在 `stateDir/agent-repo-repository-schedules/schedules.sqlite`，重启不覆盖面板设置，不自动恢复已删除计划。`sync.enabled` 和 `submoduleSchedule` 的部署开关仍是权限上限；关闭配置后不能从面板绕过启用。

仓库同步使用固定同步执行器，不创建 Main/Worker 业务会话，也不发群消息。手动执行与启动补当天都调用 OpenClaw 原生队列，不直接调用同步函数、不使用插件自建计时器。每个 Agent 每个计划时区的日期至多尝试一次；原有 Git 目录每日 receipt 继续参与去重。当天已有成功、失败或中断记录时不能在面板重跑，删除/重建、改时间和重启不清除每日记录；显式项目同步 `agent_repo sync` 仍保留原语义。跨日只执行新一天，不补过去多天。原生任务丢失、被改写或写入响应不确定时保留待核验状态，不盲目创建第二个计划。缺少原生入队接口时不使用旧定时器降级，需管理员核验宿主版本。

## 独立 clone 工作区池

项目登记支持 `workspacePool: {enabled:true,maxSize:3}`，Worker run 支持 `useWorkspace:true`。目录为 Agent Repo 下的 `workspace/<项目ID>-<编号>`，分配状态在 `workspace/state.json`。池满返回原 queued job 和 waiting_workspace，不占执行槽；依赖只在首次或 package.json 相对上次成功安装变化时安装。完整配置、恢复边界和示例见 [工作区池协议](../../docs/workspace-pool.md)。旧部署需先升级插件再启用项目配置。

WebUI 项目页通过标题旁的“工作区配置”小按钮打开弹窗，提供代码工作区池配置、占用与异常详情。保存 projects.json 需要 operator.write，检测过期版本，不执行 Git 提交或服务重启；待提交变化及其对新任务准备/同步的影响在界面明确提示。池配置调整不终止已有分配，异常目录保留。详见 [工作区池](../../docs/workspace-pool.md)。

### 仓库准备拦截诊断

模型前置校验会返回 `AGENT_REPO_*` 错误码和安全原因；仓库诊断日志保存 `code`、`cause`、`runId`。`SNAPSHOT_MISSING` 指本轮未生成快照；`RUN_ID_MISSING` 指宿主缺少运行身份；`PROMPT_EXPIRED` 指准备钩子失效；`REPOSITORY_CHANGED` / `ROLE_FILES_CHANGED` 指准备后版本或文件变化；`ROLE_UNCOMMITTED` / `SKILLS_UNCOMMITTED` 指未提交内容；`GIT_TIMEOUT` / `GIT_OUTPUT_LIMIT` 指本地 Git 检查受阻。未知异常不会回显原始 stderr、URL、凭证或聊天正文。

提示词准备失败保留首个原因，不再被通用“Prompt preparation failed”覆盖。每次提示词准备分配独立序号；被更新步骤替代的迟到失败不覆盖当前快照，迟到成功也不能发布旧快照。当前步骤尚未完成或已过期时仍返回 PROMPT_PENDING / PROMPT_EXPIRED，不回退到之前的快照。缺失、真实失败或版本变化仍阻止执行，不自动重试业务，也不借用其他 run 的快照。

Git 同步失败会保留具体诊断码并传递到入站拦截提示：`AGENT_REPO_GIT_AUTH_FAILED`、`HOST_KEY_FAILED`、`DNS_FAILED`、`CONNECT_TIMEOUT`、`NETWORK_FAILED`、`LOCK_CONFLICT`、`REMOTE_REF_MISSING`、`REMOTE_UNAVAILABLE`、`DISK_FULL`（均使用 `AGENT_REPO_GIT_` 前缀）。未知错误使用 `AGENT_REPO_GIT_COMMAND_FAILED`，保留数字退出码和脱敏命令类别，不输出 stderr、远端 URL 或凭证，不将未知原因猜成网络错误。诊断不新增自动重试，不删除锁、不重置分支，也不重新派发原业务。

### 实体属性图 v2

实体与关系均强制来源；新增部门类型、条件关联和断联、版本化同进程 CRUD、有限遍历、快照水位、事务与审计。飞书插件通过来源能力补全企业、部门父链和人员成员关系。人员扩展表保留采集值、人工更正和 Gitea 映射，统一写入 agent_repo.sqlite，旧 people.sqlite 退役为历史副本。本文旧版本章节中的人员独立库说明仅描述迁移前状态。来源能力只供可信代码，不向模型暴露。限制、权限、完整快照范围和回滚要求见 [实体图协议](../../docs/entity-library.md)。

### 统一审计与对象修改日志

管理中心“审计”支持全局及功能/对象/发起人/动作/结果/时间筛选、分页。每个计划详情可打开“修改日志”，展示本次指派消息、实际发起人、执行入口、请求 ID、修改前后值和结果；实体、工作区、技能维护及日志模块也提供相应入口。`agent_schedule audit` 仅查询当前真人来源拥有的计划。旧记录缺失的修改人和前后值如实标记，面板连接没有实名时不借用原请求人身份。持久化、覆盖范围、接口、权限与历史限制见 [审计协议](../../docs/audit.md)。

### 统一回收站

管理中心右下角“回收站”统一查看和恢复群计划、系统同步计划、人员、来源实体及已清理的仓库日志。删除后普通列表隐藏，计划恢复后默认暂停；默认 30 天后由后台原生调度清理，期限可在回收站配置为 1–3650 天，并适用于已有回收站内容。运行/排队/结果待核验的任务跳过清理，审计独立保留。恢复权限、来源检查、最小墓碑、日志批次及迁移限制见 [回收站协议](../../docs/recycle-bin.md)。

### 统一数据库

实体图、人员扩展、仓库审计、回收站设置/操作/清理记录和日志回收索引统一使用每个仓库的 `.runtime/agent_repo.sqlite`。`database.mjs` 集中处理文件权限、外键、WAL、忙等待、版本迁移和同步事务；嵌套事务使用同一连接的 savepoint，保留天数与审计原子更新。旧的四份仓库内数据库只读导入一次，原文件保留，不重复回灌。宿主跨 Agent 的计划数据库、其他插件状态、项目登记和日志正文保留原有归属。备份、切换及回滚要求见 [数据库管理](../../docs/database.md)。

### 组织目录覆盖状态

实体页可选择绑定的飞书账号，读取持久的完整组织/部门同步状态，并由 operator.write 明确发起全量收集。显示实际观察和保存的部门数量、组织是否取得、错误码和缺少的权限，局部或失败结果不显示完整。部门来源目录快照可以限定 fromTypes，清理部门的组织关系时不会波及人员关系。来源同步回执属于统一数据库 graph_sync_runs，重启后未结束的旧回执需核对，不自动重放。

实体来源持续同步由连接器驱动，AgentRepo 不读取飞书凭证或调用飞书 API。统一库提供来源隔离的持久同步队列、执行租约和检查点，图事务校验租约防止并行或过期写入。实体页显示自动同步、待处理数量、上次成功校准、事件实际接收状态及异常。无内容变化的观察保留版本和审计历史，仅推进采集时间。

## 项目知识库规范

项目知识的目录、条目格式、来源、失效条件、构建、查询及验收统一遵循 [Agent Repo 项目知识库规范 v2](skills/agent-repo-context/references/knowledge.md)。`wiki/` 是默认目录，`knowledge` 可覆盖它；现有插件提供路径检查、目录就绪检查及约定的 Git 同步，不自动建立全文或向量索引。

配套公开模板：[agent-project-temple](https://github.com/Lydanne/agent-project-temple)、[agent-wiki-temple](https://github.com/Lydanne/agent-wiki-temple)。项目元数据 project.json 与角色登记 projects.json 分工不同；完整说明见仓库 docs/agent-templates.md。

项目可以是任意符合现有登记与安全准备合同的独立 Git 仓库，不要求采用模板或 project.json；skills 可为空。模板仅为推荐结构，Git 模式沿用各仓自身政策。模板的 read-only/local/direct/review 工作流见仓库 docs/agent-templates.md，不是插件自动执行的新能力。

## 模板元数据的运行时支持

agent_repo inspect 和 skills 返回可选 projectMetadata；skills 同时把该摘要绑定到当前任务快照，Worker 的任务上下文读取同一摘要。字段 authority=reference_only，不能用元数据声明替代真实身份、工具授权或 Git 门禁。

- project：可选 project.json 的读取状态、schemaVersion、projectId、name；不会覆盖角色登记的项目 ID、仓库路径或选定范围。
- git：优先当前目标仓库 project.json.git，其次根 git-policy.json；返回 source/status、delivery、autoMerge=false 和可用的分支前缀/快进约定。显式策略无效时不回退成其他可写策略。选择 repositories/<name> 时读取该业务仓库的策略，不继承父项目策略。
- validation：package.json 的 Node engines 声明，以及存在的 check/test/build/typecheck/git:check 脚本名称；不返回脚本原文或 verification.commands，不自动运行命令。模板默认命令为 npm run check、npm test、npm run git:check。
- bundle：所选范围内的知识 Bundle 标识、标题和 x_agent 命名空间提示。项目根按角色登记的知识目录读取；子仓库读取其自身 wiki Bundle，不因项目元数据更改路径授权。

各部分 status 为 available/missing/invalid。读取仅限当前范围的普通文件，每个 JSON 最大 64 KiB；拒绝越界及软链接，不返回 tools、任意附加字段、认证配置或脚本内容。没有模板文件的任意仓库仍可使用；坏元数据只返回 invalid，不把项目当作不可接入，也不代表可执行默认策略。

本功能是可选信息发现与 Main/Worker 交接，不是模板全量校验器、自动构建器或 Git 权限执行器。执行前仍读取目标仓库规范、核对实际脚本和当前用户授权；read-only 请求不因项目配置变成写入任务。

## 知识条目接口（只读）

agent_repo 提供 knowledge_list、knowledge_search、knowledge_read、knowledge_validate、knowledge_graph。只查询当前 Agent 登记项目的知识目录；多项目必须传 projectId，不接受任意根目录、其他 Agent、命令或自动 clone。知识目录仍由角色 projects.json 的 knowledge 或默认 wiki/ 决定，project.json 不改变读权限和目录选择。

### 可配置元数据命名空间

在项目根 project.json 中配置：

```json
{
  "schema_version": 1,
  "knowledge": {
    "path": "wiki",
    "metadata_namespace": "x_xgj"
  }
}
```

命名空间优先级：project.json 的 knowledge.metadata_namespace → 知识目录 bundle.json 的 metadata_namespace → 插件全局 knowledge.metadataNamespace → x_agent。允许 x_ 开头的小写字母、数字与下划线命名空间，不猜测文档字段，不把所有项目强制迁移为 x_agent；x_xgj 文档保持原样。命名空间只改变 uid、feature_id、relations、时间等扩展字段的读取位置；type/title/status/sources/verified 等顶层字段仍保持原语义。

全局默认配置位于宿主 `plugins.entries.agent-repo.config.knowledge.metadataNamespace`，例如 `{ "knowledge": { "metadataNamespace": "x_xgj" }, "agents": { ... } }`。它仅在项目与 Bundle 未声明时生效；未配置保持 `x_agent`。模型工具参数不能覆盖命名空间。图谱、搜索、读取、校验与 inspect/skills 的知识摘要共用相同解析规则。

显式配置无效、JSON 损坏、配置越界或超过 64 KiB 时请求明确失败，不能悄悄回退。inspect/skills 的 projectMetadata.knowledge 同时返回有效 metadataNamespace、namespaceSource、normalized；摘要不是认证或业务审核。

### 搜索、读取和校验

```jsonl
{"action":"knowledge_search","projectId":"demo","query":"附件 持久化","limit":20,"offset":0}
{"action":"knowledge_read","projectId":"demo","path":"features/example/overview.md","startLine":1,"maxLines":100}
{"action":"knowledge_read","projectId":"demo","uid":"features.example.overview"}
{"action":"knowledge_validate","projectId":"demo"}
```

CLI 使用同一工具合同，例如：

```sh
openclaw agent-repo knowledge-search --agent alice --params '{"projectId":"demo","query":"附件 持久化"}'
openclaw agent-repo knowledge-read --agent alice --params '{"projectId":"demo","path":"README.md","maxLines":80}'
openclaw agent-repo knowledge-validate --agent alice --params '{"projectId":"demo"}'
```

- 搜索是本地字面关键词匹配，空格分词采用 AND，不解释正则、不建立向量索引。返回相对路径、标题、可用 UID/类型/状态/Feature、行号与有限片段；按路径确定顺序，limit 默认 20、最多 100，nextOffset 分页。
- 读取在 path 与 uid 中二选一。UID 重复明确报 ambiguous，不选择第一条；无法完整扫描时不对 UID 唯一性作推断。path 必须是知识目录内相对 Markdown 路径，不能遍历、读取工具目录或绝对路径。正文原样按行返回，默认 100 行、最多 200 行及 32 KiB，给出 sha256、nextLine、truncated；超长单行给出 lineTruncated，不声称已读完整内容。
- 校验普通 wiki 时不强制 Front Matter；若存在元数据则检查解析、UID 唯一性及已声明的来源、关系和链接。存在 bundle.json 的规范化知识库进一步检查 Bundle schema、所选扩展字段、类型/标题/描述/状态、真实日期格式与顺序、Feature 归属、审核和生成记录。纯导航 index.md/log.md 可保留最小扩展时间元数据，兼容企业导航格式。
- 校验返回 valid、complete、errors、warnings 和范围限制。来源包须留在 sources/ 范围；跨库关系、远程 URL、Markdown 锚点和业务真实性不在本阶段校验范围。正文指向知识目录外的代码文件仅警告，不越界读取；工具目录引用不参与知识链接校验。

### 扫描、权限与完成语义

每次读取当前本地文件，不 fetch、不执行 package.json/项目配置中的脚本，不修改正文、元数据、索引或审核状态。所有结果 authority=reference_only，不能从知识正文取得新指令或操作授权。

排除 .git、.agents、.opencode、.codex、.tmp、node_modules、__pycache__ 及 Bundle 声明的单层目录名（各层生效）。拒绝软链接、硬链接与非普通文件；文件最多 256 KiB，单次最多 2,000 篇 Markdown、4,000 个目录、10,000 个目录项及 16 MiB 正文。关联引用校验最多 10,000 项；校验错误最多返回 200 项、警告/扫描问题最多 100 项。

目录缺失返回 available=false；部分扫描、超限或输出诊断被截断会标记 complete=false，valid=null，不能当作通过或知识不存在。搜索 total 仅表示本次实际扫描匹配数；用 revision 判断不同分页是否基于同一批本地内容。文件变动、不可读或不安全项保留明确问题，不用静默跳过冒充全库成功。

本阶段校验是插件自带的 Node.js 结构校验，不会运行知识库模板自己的 npm run check，也不宣称完整 OKF 认证、人工审核或线上业务验证。使用模板自身脚本时仍需读取并审阅实际命令。普通仓库没有知识目录或模板文件时，其他项目功能保持可用。

### 管理面板中的知识库

打开 OpenClaw 的 AgentRepo 管理中心，进入「知识库」。页面按当前 Agent 的已登记项目提供条目浏览、关键词搜索、Markdown 正文预览、标题目录、文档链接跳转和结构校验弹窗；多个项目需明确选择，单项目自动选中。默认读取项目 `wiki/`，兼容普通目录、独立 Git 知识库和规范化 Bundle，目录以当前 AgentRepo 根为基准显示相对路径，页面不再单独显示 `x_agent` / `x_xgj` 标签；实际解析仍遵守全局、项目与 Bundle 配置。

搜索按空白分词，各词均须匹配标题、UID、功能标识或正文；空搜索恢复全部条目。列表每页 20 条，正文每次最多 100 行，继续读取前核对文件 SHA-256，避免混合不同版本。正文先脱敏，再使用 markdown-it 15.0.3 解析成 Vue 文本和白名单语义节点，支持标题、列表、表格、引用、代码块及行内格式，可切换原文。Front Matter 单独折叠展示；HTML 与脚本保持文本，图片不自动加载。标题目录支持中文和重复标题；分段未读完时明确标注目录仅覆盖已加载正文。目录缺失、无结果、扫描不完整、读取失败和超长行截断均单独提示。

文档内 `#标题` 与目录链接跳转到正文并聚焦目标标题；相对 `.md` 链接在当前 Agent、项目及知识库内读取，支持 `../`（不能超出知识库）、编码路径与目标锚点，并提供「返回上篇」。目标尚未加载时提示继续读取，后续内容加载后重试定位。不存在或越界的目标明确提示；不支持的协议、本地非 Markdown 文件、绝对路径和带用户信息的外链不会跳转。HTTP(S) 与 mailto 链接可由用户另页打开，不自动核验其内容。

「校验结构」打开共享 Dialog 弹窗，展示加载、错误与提醒、扫描完整性和生效命名空间，支持关闭与重新校验。关闭弹窗或切换项目后，旧校验结果不会重新弹出。

管理接口 `projects-knowledgeCatalog`、`projects-knowledgeList`、`projects-knowledgeSearch`、`projects-knowledgeRead`、`projects-knowledgeValidate`、`projects-knowledgeGraph` 均要求 `operator.read`，沿用可信 Agent、登记项目、知识目录边界与分块传输校验；不要求写权限，不拉取仓库或修改文件。项目、Agent、页面或权限变化后丢弃旧请求结果。

CLI 也支持 `openclaw agent-repo knowledge-list --agent alice --params '{"projectId":"demo","limit":20,"offset":0}'`；管理动作通过 `openclaw agent-repo manage knowledge-catalog --agent alice` 等入口调用。

### 知识库图谱 Tab

知识库顶部使用共享 Tabs 切换「文档 / 图谱」，两个视图共享当前项目选择。图谱按需读取本地文档快照，节点为 Markdown 文档，实线表示正文链接，虚线表示生效命名空间的 `relations`（references/part_of/depends_on/constrained_by/implements/supersedes），箭头由来源指向目标。支持标题/路径/UID 查找、缩放、拖动和方向键平移、适应画布；选择节点可查看关联并通过「打开文档」切回正文。文档索引也提供键盘可操作入口。

`knowledge_graph` / `openclaw agent-repo knowledge-graph` 和管理动作 `knowledgeGraph` 只读当前登记项目，`limit` 默认及最多 100 篇，最多 1,000 条边、10,000 项引用；扫描仍受已有知识目录预算约束。图谱明确标注扫描不完整、数量截断、无效元数据与未解析引用。代码块、行内代码、图片、远程或越界链接、跨 Bundle 目标不成边；无法完整扫描时不推断 UID 唯一性，重复 UID 不任选目标。节点点击不会执行文档指令，图谱不代表内容事实已核验。

### 管理界面的路径展示

AgentRepo 与 Worker 的目录、技能路径、工作区路径、运行目录等路径字段统一以当前已绑定 AgentRepo 根为基准展示（例如 `projects/agent-plugins/wiki`），根目录自身显示 `.`。同卷外部路径显示为 `../` 相对路径；跨 Windows 盘符或根目录尚不可用时保留原值。根目录来自已授权读取响应 `result` 数据块中的 `agentRepoRoot` 展示元数据，不额外请求目录、不推断宿主 HOME，也不提供路径访问授权。

仅转换展示值。API 返回、原始正文/命令/诊断记录与操作参数保留原始路径；导航、导出和后端执行继续使用原数据，不能把界面相对路径当作新的工具范围。切换 Agent、隐藏页面或失去读取权限后清除旧根目录，延迟响应不能复用其他 Agent 的路径基准。

### 完整知识浏览与版本回放

知识库管理页使用 G6 5.1.1，默认展开 Feature/知识区行星系统，可全部收起为聚合总览；全部展开不会截断节点或关系。节点大小按去重入链/出链邻居数映射，分类颜色与 Feature 圆形边界分别表达知识区和归属。圈内以权重最大的节点为中心，其他节点由大到小分布于同心轨道，圈外采用确定性黄金角散布，预留有界漂浮空间；画布允许扩展，不将节点位置压缩回固定区域。关系统一使用 Canvas Path2D 批量绘制，保留全部关系和邻接索引。默认仅绘制 Feature 中心节点之间的有向汇总关系（不表示两个中心文档的直接引用），选中节点后显示该节点真实的直接关联；关闭详情恢复汇总。节点及分组继续由 G6 绘制和交互，连线层随同一摄像机坐标、缩放及像素比重绘。点击节点仅更新选中样式和邻接关系，不淡出整图、不重置视角；搜索和关联目录定位仍可居中。

目录树仅在文档视图显示，图谱使用全部可用宽度，选中节点后显示不占布局宽度的悬浮详情面板和关联节点目录，可关闭；节点支持在所属 Feature 内拖动，整段移动路径执行碰撞约束，位置仅在当前图谱保留，不写知识文件；保留分组和搜索按钮供键盘操作。小节点漂浮幅度更大、节奏更轻快，大节点更稳定；暂停漂浮或系统减少动态效果时停止运动，隐藏页面和卸载时清理计时器。仅更新视口内可见且位移达到亚像素阈值的节点，全部节点和关系始终保留；拖动时暂停局部运动，连线端点跟随节点。

新增只读管理动作 `knowledgeIndex/knowledgeNodes/knowledgeEdges/knowledgeChanges/knowledgeSnapshot/knowledgeDiff`。前三者使用固定 `snapshotId` 与绑定 Agent/项目/版本的游标，每页 500 节点或 2000 关系；失效游标重新获取快照，禁止跨版本合并。`knowledgeIndex` 返回 `building/ready/error`、进度与完整性；`refresh:true` 重建当前状态。`knowledgeRead/List/Search` 管理动作可传 `snapshotId`；旧模型工具和 CLI 摘要合同不变。异常文件和未解析关系仍明确报告。

派生 SQLite 位于 Agent `.runtime/knowledge/index.sqlite`，独立于实体库。当前文件按指纹缓存、历史 blob 按 Git OID 缓存，解析结果按正文哈希、路径、命名空间及解析器版本复用，快照发布为原子事务。未完成构建重新进入时可以复用文件缓存；服务重启后旧游标过期，快照可重新读取。缓存不是业务资料或授权来源，不进入 Git。

历史固定到本地 HEAD 的第一父链，合并相对第一父提交计算；只读取对象、不 checkout、不 fetch、不执行外部 diff/textconv。历史文档链接继续读取同一快照。无 Git 时仅提供观察记录；浅克隆明确提示历史边界。当前未提交内容单列为工作区状态。历史选择接口只接受服务端已列出的 revision，拒绝任意路径和命令选择器。

全屏使用局部 OverlayScope，弹窗跟随图谱；不可用时回退页面内最大化。现有单包构建保持不变，仅延迟创建图谱实例。G6 使用固定版本的 preset-free ESM 入口和显式注册，所需适配封装在 `ui/knowledge-g6.ts`；升级时必须验证注册项、CircleCombo 几何接口及浏览器测试。

大图搜索复用文本和邻接索引，节点切换仅更新前后节点及邻接高亮，完整连线路径不重复构造。历史几何完全一致时复用绘图对象，仅刷新变更标记；几何或关系变化仍重新绘制。界面按项目保留最近三个快照摘要（合计最多 400000 个节点/关系条目，不缓存正文），缓存命中仍向服务端核对 snapshotId 的当前范围。预读下一帧共用去重请求，回放等待当前 Canvas 绘制完成再推进；时间轴连续拖动合并为最后一次定位，项目切换、权限失效及卸载时清理缓存和计时器。
