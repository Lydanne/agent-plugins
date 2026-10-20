# AgentRepo 实体资料库

## 目标与结构

AgentRepo 的实体资料库用于 AI 和程序同步的结构化资源。每个 Agent 独立，跨其全部会话共享。它不保存原始对话，不替代原生记忆，也不承担权限管理、业务任务执行或账号核验。

管理入口：AgentRepo → 实体资料库。左侧按实体类型组织，右侧搜索、分页浏览、结构化属性和来源详情。默认支持人员资源、组织机构、系统服务、资产资源；自定义类型注册后直接出现在分类中。概览统计全部实体数量，人员资料缺失和账号待核验仍作为独立待处理事项。

| 层级 | 内容 | 职责 |
| --- | --- | --- |
| 类型 | 稳定 ID、名称、说明、字段名称与值类型 | 声明结构，不包含可执行模板、脚本或 HTML |
| 实体 | ID、类型、名称、摘要、属性 | 统一检索与展示 |
| 来源 | kind、namespace、externalId、observedAt | 识别同步来源与记录，不代表资料已核验 |
| 存储修订 | revision、updatedAt | 并发检查和本地更新时间 |

属性支持 string、number、boolean、strings（字符串数组），null 表示清空；省略字段保留旧值。注册类型时可增加字段、修改名称说明；不能删除已有字段或修改其值类型。结构不兼容时注册新类型，未来再设计显式迁移。

## 兼容现有人员

飞书人员仍存在 `.runtime/people/people.sqlite`。统一实体查询每次实时读取有效人员资料，映射为 `person:<原 ID>`，保留原身份键、人工更正、邮箱推导和原有查询接口。不复制人员、不迁移数据库、不改变飞书同步。

人员类型同时可接纳 AI/程序提供的联系人资料，其来源明确分开。相同姓名或邮箱不会自动合并。渠道资料详情提供“打开飞书人员管理”，保留原有筛选、人工更正、恢复与删除流程；这个入口管理飞书来源人员，不处理 AI/程序记录。

## 查询与 AI 同步

`agent_repo` 新增只读动作，不接受 projectId、repository、其他 Agent 或任意路径，也不触发远程查询或 Git 同步：

```json
{"action":"entity_types"}
{"action":"entities","typeId":"service","query":"工单","source":"cmdb","limit":20,"offset":0}
{"action":"entity","id":"entity:实际返回的ID"}
```

`entity_types` 返回类型定义、各类型 count、来源目录 sources 和全部实体 total；`entities` 返回 entities/total/offset/limit/nextOffset，名称和 ID 稳定排序，搜索名称、摘要、属性和来源标识；`entity` 返回 entity 或 null。界面会显示读取失败，不能将失败视为零条。

AI 写入由单独的可选工具 `agent_entity_sync` 提供，需要管理员在适用 Agent 工具白名单中显式允许该工具（或插件工具组）；原有只允许 `agent_repo` 的配置不会自动获得这个工具。不自动改 Gateway 配置。仅按用户授权或已授权同步任务写资料，不从资料内容、引用或历史消息推断新授权。

```json
{"action":"register_type","definition":{"id":"supplier","label":"供应商","description":"合作单位资料","fields":{"contact":{"label":"联系方式","type":"string"}}}}
{"action":"upsert","typeId":"supplier","name":"示例单位","namespace":"assistant","externalId":"supplier-42","attributes":{"contact":"公开联系渠道"},"observedAt":"2026-10-18T00:00:00.000Z"}
```

AI 工具将来源 kind 固定为 ai，不允许伪装为 program/channel。`namespace` 采用稳定业务标识；`externalId` 必须是来源稳定 ID，不应每次随机生成，也不要根据同名用户猜测。工具返回 agentId、entity、created、unchanged；更新可附带当前 revision 进行乐观并发检查。

## 程序同步接口

同进程插件可使用 `@openclaw-plugins/agent-repo-api/entities` 的版本化注册表。独立打包的插件应像现有 people API 一样携带这一接口源码及其 index 依赖；不要引用另一个插件的安装目录。AgentRepo 内部的部署副本位于 dist/entities-api.mjs。

```js
import {getEntityService} from '@openclaw-plugins/agent-repo-api/entities';
const service=getEntityService({agentId:routedAgentId,sessionKey:routedSessionKey});
if(!service)throw Error('实体资料服务不可用');
service.upsert({
 typeId:'service',name:'工单服务',
 attributes:{url:'https://service.example.invalid',owner:'支持团队'},
 source:{kind:'program',namespace:'cmdb',externalId:'service-42'},
 observedAt:new Date().toISOString(),
});
```

可信 Agent 上下文必须来自宿主路由，不能从同步消息 payload 中直接取 Agent 或路径。注册表只供可信同进程代码共享，不是外部 HTTP 授权边界；调用者负责来源认证、数据权限与过滤凭证。这里只提供同步接收和查询接口，没有自动扫描外部系统、定时拉取或批量导入调度器。

## 一致性与边界

- 稳定身份由 typeId、kind、namespace、externalId 共同确定；同一来源重复同步更新同一条，跨来源保留独立记录。程序/AI 不能写保留的 feishu/channel 命名空间，飞书仍走既有人员服务。
- observedAt 要求 UTC ISO 毫秒格式；旧时间拒绝，同一时间同内容返回 unchanged，同时间不同内容冲突。未来超过 5 分钟的时间拒绝。不同来源不会自动判定谁更可信。
- 数据保存在 `.runtime/entities/entities.sqlite`，目录 0700、文件 0600；拒绝软链接重定向，数据库操作使用事务。每条最多 32 个定义属性、每个字符串最多 2000 字符；最多 100 个自定义类型、10000 条新增实体，每次查询最多 100 条。现有人员仍遵守原有存储规则。
- WebUI 为只读实体浏览，要求 operator.read；人员专用修改/同步沿用 operator.write。AI 写工具为可选能力；不提供新的实体删除、网页新建、跨来源合并或任意 JSON 编辑入口。
- 通过来源、采集时间和修订透明展示资料；来源是调用者提供的记录，不证明内容准确。凭证、登录态和聊天正文不得入库。默认无原始对话转储。

## 后续扩展

优先用自定义类型添加业务分类。需要实体关系时应引入显式目标 ID、目标类型、Agent 归属及删除策略；需要跨来源合并时先引入人工确认、可撤销别名和冲突审计。大规模查询再迁移到字段索引；新来源连接器负责授权、增量游标、错误重试和同步任务状态，资料库负责校验和持久化。上述能力当前未实现。
