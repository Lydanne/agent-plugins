# AgentRepo 实体属性图（服务版本 2）

AgentRepo 是实体、来源和关系的唯一存储拥有者。每个 Agent 独立，同一 Agent 的会话共用服务，但共享存储不授予跨会话读取或转发权限。飞书和其他可信插件使用版本化同进程接口，不直接访问数据库，不向模型交付服务对象或凭证。

## 模型与存储

所有新写入进入 `<Agent Repo>/.runtime/agent_repo.sqlite`，目录 0700、数据库 0600，拒绝符号链接。SQLite 事务串行检查和写入，图模型无需依赖外部图数据库。

- `graph_sources`：来源类别 kind（channel/program/ai/manual）、namespace、scope（租户/应用/账号隔离范围）。
- `graph_nodes`：稳定 ID、实体类型、来源 ID、来源外部 ID、状态和 JSON 属性。内置人员、组织、部门、系统服务、资产；字段类型 string/number/boolean/strings，null 清空，省略保留。
- `graph_edges`：独立 ID、关系类型、来源、外部 ID、起终点、状态、属性与有效时间。端点是当前 Agent 数据库中的外键。
- `entity_types` / `graph_relation_types`：实体与关系结构定义。已有字段不可删除或改类型；关系规则改变须新建版本化类型。
- `graph_people`：飞书人员专用采集值和人工覆盖值，与规范实体关联。它是统一库中的兼容扩展表，不是第二份人员数据库。
- `graph_operations` / `graph_snapshots` / `graph_sync_runs` / `graph_audit`：请求幂等、完整快照水位和变更前后审计。

实体和关系必须有来源、外部稳定 ID、observedAt、updatedAt 和 revision。身份由实体/关系类型、来源及外部 ID 决定，不按名称或邮箱合并。旧 ID 原样保留；新 ID 是上述键的确定性哈希。observedAt 是真实采集时间，不得用未来时间伪装，旧数据不能覆盖新记录。validFrom/validTo 是业务有效时间；当前 active/ended 状态以实际变更为准，不提供按有效时间自动切换的调度器。

## 来源与接口

```js
import {getGraphService} from '@openclaw-plugins/agent-repo-api/entities';
const graph = getGraphService({agentId: routedAgentId, sessionKey: routedSessionKey});
if (!graph) throw Error('AgentRepo 图服务不可用或版本不足');
const producer = graph.forSource({
  kind:'program', namespace:'cmdb', scope:'tenant-42', actor:'cmdb-plugin',
  types:['service','asset'], relations:['depends_on'],
});
const result = producer.upsert({
  typeId:'service', externalId:'service-42', name:'工单服务',
  attributes:{url:'https://service.example.invalid'}, observedAt:new Date().toISOString(),
});
```

`forSource` 只能由受信任同进程代码调用；调用者绑定来源、类型白名单和人工权限，业务 payload 不得控制这些授权。注册表不是网络认证边界，不向浏览器或模型暴露来源能力工厂。channel/feishu 保留给渠道插件。来源仅表示采集归属，不证明资料正确或业务账号已核验。

- `graph.types/list/get/registerType`：实体类型和查询，兼容 v1。
- `graph.sources/relationTypes/registerRelationType`：来源和关系类型目录；类型注册为可信插件管理能力。
- `producer.upsert/connect/end/remove`：实体幂等写入、关联、断联和实体逻辑删除。
- `producer.applyRelationChanges({requestId,changes})`：实体和关系的原子批量变更；同 requestId 同内容复用结果，不同内容拒绝。
- `producer.validateRelationChange`：事务内预校验并回滚，不保存变更；执行时仍重新校验。
- `producer.syncSnapshot`：完整、成功、明确覆盖当前来源全部指定关系类型的快照。不是按部门或个人的局部快照；局部更新使用带证据的批量变更。
- `graph.relations/traverse/history`：分页关系、有限遍历、历史审计。分页最多 100 条，遍历最多 5 层和 500 条边，截断明确返回。

独立插件应携带 API 源码及依赖，不引用其他插件安装目录。getEntityService 的旧接口继续兼容；新调用者必须检查 getGraphService 返回值。普通 AI 同步工具仍只有原有实体写入能力，不能自行取得图关系、渠道来源或删除权限。

## 关系规则

内置 `member_of`（人员→部门）、`primary_department`（人员→部门，最多一个）、`belongs_to`（人员/部门→组织，最多一个）、`parent_department`（部门→部门，最多一个、禁止成环）、`manages`、`maintains`。

关系类型声明 fromTypes/toTypes、属性定义和 rules：

- sameSource：端点与边必须来自相同来源及隔离范围。
- noSelf、acyclic：禁止自关联、禁止有向环。
- maxOutgoing/maxIncoming：当前 Agent 下该类型有效边的数量限制。
- conditions.connect/end：对 from/to 的属性、状态或类型、关系属性及来源 kind/namespace/scope 声明业务前置条件。
- connectEvidence/endEvidence：可接受的证据种类，可按关系收紧；普通 observation 永远不能断联。

每次建立或断联须提供 `{kind,id,reason?}` 证据，种类为 observation/event/snapshot/manual。manual 要求来源能力显式 manual 权限及原因；snapshot 仅由完整快照接口生成，普通变更不能冒充。可信连接器负责核实 event/observation 确实来自对应系统，不能把模型猜测当作事件。

事务先形成拟议最终状态，再检查全部有效边的端点、类型、范围、数量和环，允许“建立新主部门＋结束旧主部门”的原子调整。关系端点不能改写，需结束旧关系并建立新关系。结束操作要求当前 revision 和更晚的采集时间。

实体默认逻辑删除；有有效关联时阻止删除，先显式按各关系规则断联。断联保留 ended 记录、有效结束时间和审计。没有自动级联删除、物理清理或跨来源合并。conditions.connect/end 可声明对端点属性、关系属性或来源字段的 present/equals/in 条件，例如合同已审批才允许关联、已关闭才允许断联；事务在拟议最终状态检查条件。任意自定义脚本和外部回调不在当前接口范围内。

## 飞书组织与完整部门目录

组织目录同步是独立能力，不依赖哪些人员或部门曾在聊天中出现。飞书插件提供 `feishu-organization-sync` 服务，AgentRepo 实体页提供“同步飞书组织与全部部门”及账号选择、覆盖状态和错误提示。服务首次启动且没有持久回执时进行一次初始化收集；已有失败或未知回执不自动重放，管理员可明确发起新的同步。刷新页面只读取状态。

1. 通过实际 tenant API 取得企业名称、tenant_key、企业编号和域名；租户身份缺失或变化时不猜测组织。
2. 从根部门 ID `0` 开始，逐个父部门调用 children，使用 `fetch_child=false`，独立读取所有分页并遍历全部子部门，避免递归接口的数量限制。查询根部门成功才具备全员目录范围的证据。
3. 保存每个部门的稳定 open_department_id、名称、父部门、可取得的编码、负责人 ID、成员数、排序、部门群及来源。字段未取得保持未知，不因字段定义存在而声称已采集。
4. children 响应可能省略 parent_department_id。直接子部门查询的目标父部门本身提供明确关联依据，记录 parentIdSource=children_query；若响应显式父部门与查询目标矛盾，则整批拒绝，不任选父部门。
5. 只有完整遍历并校验成功，才在同一事务中保存部门及 parent_department、belongs_to 关系，仅替换已核实部门的旧组织关系，未发现的部门按下述候选复查规则处理。fromTypes=['department'] 防止清理同类型的人员组织关系，member_of 不受此目录快照影响。
6. 不再出现在目录中的旧部门进入候选复查；明确不存在时标记 inDirectory=false 并保留历史资料；不凭部门目录缺失删除人员关系。权限失败、分页不完整、重复节点、父子矛盾、超限或版本冲突时，不清理已有关系。

组织 API 权限不足时，仍可保存成功完整取得的部门树和父子关系，但总体状态为 partial，明确显示缺少 `tenant:tenant:readonly`，不能称为完整组织目录。根目录权限不足不能把可见子集称为“全部部门”。请求使用应用身份及当前 Agent 的账号绑定，不借用用户登录态，不改应用权限。

每次完整同步的 requestId、状态、时间、观察与入库数量、覆盖程度和安全诊断保存在统一库 graph_sync_runs。已结束回执不可覆盖。graph_sync_jobs 持久化来源范围内的任务、对象 ID、去重键、到期时间和尝试次数；graph_sync_state 保存执行租约及成功时间、下次校准时间、错误、未发现部门候选。队列不保存事件原文、凭证或聊天正文。

持续同步由飞书插件负责：部门 created_v3 / updated_v3 / deleted_v3 经现有 SDK 可信事件入口接收，记录事件 ID 的稳定摘要并入队；不直接把事件字段覆盖到图中。事件默认合并 10 秒，同一批同部门只读取一次最新资料。普通变化局部读取，缺少父节点时补齐父链；父字段不可见时核验已知父节点的直接子部门列表，无法核实时合并为全量校准。明确的层级变化事件直接触发一次全量，避免猜测旧、新父链。大量局部事件在预计局部读取成本超过全量成本时合并为全量。

默认每 60 分钟读取组织信息，每 360 分钟校准完整部门树（全量时间加稳定随机偏移）；启动检查成功时间和待处理任务，WebSocket 重连入队校准。飞书配置 `directorySync` 支持 enabled（默认 true）、organizationIntervalMinutes（默认 60，15–1440）、fullIntervalMinutes（默认 360，60–10080）、eventDebounceSeconds（默认 10，1–30）。这是飞书插件后台维护，不唤醒模型、不新增群计划。事件订阅必须在开放平台配置并发布；只有实际收到部门事件才显示“已收到”，不能因注册了处理器声称订阅已验证。

同一 Agent/账号/应用来源只持有一个执行租约，所有图写入在事务内核验令牌，过期持有者和未持有租约的并行写入被拒绝。全量、局部及人员关系补全共用队列；同步期间到达的新事件留在队列。最多同时执行 4 个来源任务，同账号/应用的目录 API 同时最多 2 个请求。请求 20 秒超时，全量 10 分钟、局部及人员补全各 2 分钟时限，租约 15 分钟。网络失败指数退避至最多 1 小时，权限错误至少退避 6 小时。进程重启后仅恢复持久化、租约已过期的采集任务，重新读取当前状态并使用新尝试 ID；不覆盖旧回执、不重放其他业务操作。

持续同步的全量校准即使成功，也不凭目录缺失直接断联：保留未发现部门的旧关系，持久化候选并定向复查；出现未经删除证据确认的缺失时标记 partial 和可见范围变化，不能称为完整成功。权限缩小、读取失败、分页不完整不会解除关系。单部门明确已删除，或已核验删除事件且当前接口确认不存在时，才结束该部门的组织、父部门关系，保留历史节点；迟到删除事件若读取到有效部门，则按当前资料更新。人员 member_of 不因部门缺失或删除而自动结束。周期重复读到相同内容仅推进观察时间，不改变实体/关系版本、不生成重复变更审计。每次实际改变仍经过类型、来源、租户、数量、成环及证据校验。

人员资料继续按原有消息、查询和群同步采集，已有人工更正与 Gitea 映射保持。局部人员补全只在父部门字段实际取得时更新层级，字段缺失不能解除全量目录建立的父子关系；人员引起的局部目录补全入同一持久队列，避免相互覆盖或因暂缓而丢失。

实现参考：[飞书获取子部门列表](https://open.feishu.cn/document/server-docs/contact-v3/department/children)。SDK 基线为仓库锁定的 @larksuiteoapi/node-sdk。内部有限批量更新上限仍为 1000；经完整性校验的来源快照允许最多 60000 个操作，仍受 10000 实体及 50000 关系的存储限制。遍历设请求超时、总时限和页数上限，达到限制会报告未完成，不静默截断后清理。

## 迁移与回滚

首次打开 v2 数据库时以事务执行 migration-v2：迁移旧 entities JSON 记录，保留 ID 和修订；将旧 people.sqlite 的采集值和人工更正迁入 graph_people，建立人员实体，并将原始采集的部门引用迁为部门及成员关系（人工显示更正不冒充渠道事实）；提交后旧 entities 表删除。旧 people.sqlite 保留为只读历史，不再写入或重复导入。

生产切换前必须使用 SQLite backup API 保存所有绑定 Agent 的全部旧库，并在副本演练迁移、完整性及字段一致性。迁移失败回滚本事务。部署需停止旧插件写入后切换服务；热重载必须等已接纳工作完成，不能中断活动任务。

回滚旧代码必须核对并恢复匹配的迁移前独立库，先一致性备份统一库的新增写入供后续处理。不能将迁移前备份直接覆盖仍在运行的新服务，也不能仅回滚代码后继续使用过期旧库而丢失切换后的数据。

## 管理入口和验收

AgentRepo 实体页统一显示五类实体；详情可展开关联及方向，保留飞书人员同步和更正入口。operator.read 才可浏览关系和审计。agent_repo 增加 relation_types/relations/graph/entity_history 只读动作，均绑定当前可信 Agent，不接受项目或任意路径。

专项测试覆盖来源隔离、端点类型、环、数量约束、事务回滚、预校验、证据断联、快照完整性及水位、幂等冲突、迁移与人工更正、飞书组织及父链同步、失败保留关系。隔离测试和只读生产回归不能称为真实飞书入站业务验收。

统一数据库首次初始化时，先按 [数据库管理](database.md) 只读导入原 entities.sqlite、audit.sqlite、settings.sqlite 和 logs.sqlite，保留所有图及回收站记录。上文的 migration-v2 在统一库内检查旧实体/人员的转换标记，已有标记时跳过，不重新引入旧人员。原数据库文件保持原样；临时兼容 entities 表仅在统一库内转换后删除。生产切换须备份全部旧库；统一库使用 WAL，运行中的备份不能只复制主文件。连接和版本由 database.mjs 管理，graph-storage.mjs 保留图领域投影及人员兼容逻辑。
