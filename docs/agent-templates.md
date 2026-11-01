# 通用 Agent 模板与 agent-repo

## 任意项目仓库均可接入

agent-repo 的 project 是角色仓库 projects.json 中登记的实际项目仓库，不要求从模板生成，也不要求存在 project.json、特定语言、目录骨架或模板标记。既有代码仓库、文档仓库与知识仓库均可接入；仍须满足现有路径/远端/分支、独立 Git 根和安全准备合同。skills 可为空数组，知识目录默认 wiki/，显式 knowledge 可覆盖，缺省知识目录缺失不阻止普通任务。

模板只是推荐起点。project.json 是模板自身元数据，不是 agent-repo 运行时准入条件；其 Git 模式也不是插件会自动执行或强制实施的宿主设置。不能为了接入而强制改造任意仓库成模板布局。

## 两个模板仓库

| 模板 | 用途 | 主要内容 |
| --- | --- | --- |
| [agent-wiki-temple](https://github.com/Lydanne/agent-wiki-temple) | 一个项目的知识库 | Bundle、通用 x_agent 元数据、Feature 多视图、来源包、治理、模板、材料录入与知识构建技能 |
| [agent-project-temple](https://github.com/Lydanne/agent-project-temple) | 一个项目的 Agent 协作工作区 | project.json、AGENTS.md、.agents/skills、默认 wiki/、docs 与 repositories 边界、初始化和验证技能 |

两者均为公开 GitHub Template Repository，可用 Use this template 创建自己的仓库。名称按用户约定保留 temple。模板不替代角色仓库；agent-repo 仍按角色仓库 projects.json 选择项目。

## 企业结构来源与通用化

知识库结构参考 [xgj-wiki](https://git.bjxgj.com/xgj/xgj-wiki)，项目结构参考 [xgj-project](https://git.bjxgj.com/xgj/xgj-project)；原仓库访问仍需企业权限。公开模板为重新编写的通用实现，不复制企业 Git 历史、业务 Feature、原始来源、日志、内部工具实现或第三方技能包。模板 ORIGIN.md 记录参考快照。

| 企业约定 | 通用模板处理 |
| --- | --- |
| 固定企业 Bundle / 项目标识 | bundle.json、project.json 的可配置项目标识 |
| x_xgj 元数据 | x_agent；保留 UID、owner、feature_id、relations、真实时间等语义 |
| Feature 知识结构 | 保留 overview/process/domain/scenarios/sequence/schema/tracking 等多视图及按证据渐进构建 |
| 来源、生成与审核 | sources 来源包、generated、verified、draft/stable/deprecated；自动生成与 CI 不代替真实审核 |
| 企业 CLI、服务和固定账号 | 可选 tools 配置与宿主实际工具；无配置就说明未配置，不猜测身份或安装企业工具 |
| 企业知识自动合并例外 | 不继承；模板默认 auto_merge=false，交付受当前用户与仓库授权约束 |
| 企业同步、发布和业务专用技能 | 不复制；核心流程重写为通用技能，外部平台适配按项目接入 |

元数据保留 Front Matter 形式，模板使用 JSON 兼容 YAML，避免引入解析依赖。Bundle 清单为本模板扩展，不宣称完整 OKF 认证。既有知识迁移须保留真实 UID、时间与证据，仅按映射修改命名空间；不能把迁移时间当作历史创建时间。

## 结构与职责

知识库以 index.md 导航，包含 concepts、architecture、features、rules、processes、decisions、sources、assets、governance、templates、log。来源包保存原始材料及取得范围，正文表达由证据支持的结论；归档成功不等于 Feature 构建完成。默认不带业务示例事实。

项目工作区把当前实现知识放 wiki/，方案放 docs/，业务仓库放 repositories/，技能只放 .agents/skills。project.json 是模板的项目元数据，不是 agent-repo 已实现的新登记格式，也不自动执行其中命令或下载仓库。

## 在 agent-repo 中接入

在角色仓库 projects.json 登记生成的项目仓库，例如：

```json
{
  "schemaVersion": 1,
  "projects": {
    "demo": {
      "name": "示例项目",
      "url": "https://example.invalid/team/demo.git",
      "branch": "main",
      "repository": "projects/demo",
      "skills": ["projects/demo/.agents/skills"]
    }
  }
}
```

省略 knowledge 即默认读取 projects/demo/wiki；显式 knowledge 继续优先。使用 list/inspect/skills 核对真实目录与入口，而非把仓库创建视为接入成功。

- 普通 wiki 目录随项目版本管理；完整知识库可直接基于 agent-wiki-temple 构建。
- 独立 Git 知识库由管理员在 wiki 路径准备并维护忽略规则；插件读取本地版本，不自动 clone/pull。项目模板自带 wiki 种子，接入独立仓库前先妥善保留已有内容，不覆盖目录。
- 已声明的 wiki 子模块遵循既有同步与未初始化保护；业务 repositories 的自动同步范围也以 .gitmodules 声明为准，不能从 project.json 推断。

## 技能路由与验证

wiki 模板提供 knowledge-ingest、knowledge-build、skill-maintenance；项目模板提供 project-setup、project-knowledge-build、project-test-loop、skill-maintenance。项目知识技能优先读取 wiki 自身治理与技能，再衔接归档、逐结论比较、权威正文更新和导航维护。

两个模板均可运行 `npm run check` 和 `npm test`；项目模板还校验 wiki 种子。检查覆盖模板元数据、UID、关系目标、本地链接及关键策略反例，不检查远端链接可访问性、事实真实性或生产行为。GitHub Actions 执行同一组检查。

agent-repo 不因模板接入而增加向量检索、自动材料采集、飞书发布或自动合并能力。新增或语义变化内容保持 draft，真实审核和外部发布分别记录。

## Git 工作模式与各仓交付

两个模板均提供 `.agents/skills/git-workflow/SKILL.md`、场景引用和只读 `scripts/git-check.mjs`。项目模板在 project.json.git 配置，独立 wiki 在 git-policy.json 配置；同一仓库只维护一份模式来源。

| delivery | 工作模式 | 交付范围 |
| --- | --- | --- |
| read-only | 只读检查 | 无修改、提交、fetch、push 或 PR |
| local | 本地完成 | 修改、验证、精确提交，停止于本地 SHA |
| direct | 直接交付 | 在已获授权且允许直推的目标分支普通 push，并核对远端 SHA |
| review | 分支评审 | 任务分支、提交、push、创建或复用 PR、核对当前 head 的 CI/Review/冲突，保留 PR open |

默认 review；auto_merge=false。当前用户指令、目标仓库规范、宿主权限和平台保护优先，模式不能充当新授权。模板约定不是 agent-repo schema 的新增字段；任意仓库沿用自己的 AGENTS.md、技能及 Git 政策，不必创建这些配置文件。

工作流覆盖：现场/未推送提交/worktree 检查、安全快进、任务分支、适用验证、精确暂存、提交、推送回执核对、PR 去重与 head 门禁、失败/冲突保留以及逐仓交付结果。根项目、独立业务仓库和独立 wiki 分别判定模式；普通 wiki 归父仓，子模块先交付子仓再按授权更新 gitlink。不让单仓授权扩展为递归更新或跨仓推送，也不把 PR、合并和部署混为完成。

只读检查脚本不访问远端、不判断授权、不修改 Git；其本地 ahead/behind 仅针对现有远端跟踪引用。远端新鲜度、CI 和平台审批需按实际工具另外核验。

## 脚本运行时

通用模板脚本优先 Node.js ESM，要求 Node.js 22+；默认命令为 npm run check、npm test、npm run git:check，对应 scripts/check.mjs、node:test 与 scripts/git-check.mjs。使用 Node 内置模块，无需安装依赖，GitHub Actions 使用 Node.js 22。Python 允许用于专项能力或已有实现，但应注明依赖和运行方式，不作为通用模板默认依赖。

## 模板元数据的运行时支持

agent_repo inspect 和 skills 返回可选 projectMetadata；skills 同时把该摘要绑定到当前任务快照，Worker 的任务上下文读取同一摘要。字段 authority=reference_only，不能用元数据声明替代真实身份、工具授权或 Git 门禁。

- project：可选 project.json 的读取状态、schemaVersion、projectId、name；不会覆盖角色登记的项目 ID、仓库路径或选定范围。
- git：优先当前目标仓库 project.json.git，其次根 git-policy.json；返回 source/status、delivery、autoMerge=false 和可用的分支前缀/快进约定。显式策略无效时不回退成其他可写策略。选择 repositories/<name> 时读取该业务仓库的策略，不继承父项目策略。
- validation：package.json 的 Node engines 声明，以及存在的 check/test/build/typecheck/git:check 脚本名称；不返回脚本原文或 verification.commands，不自动运行命令。模板默认命令为 npm run check、npm test、npm run git:check。
- bundle：所选范围内的知识 Bundle 标识、标题和 x_agent 命名空间提示。项目根按角色登记的知识目录读取；子仓库读取其自身 wiki Bundle，不因项目元数据更改路径授权。

各部分 status 为 available/missing/invalid。读取仅限当前范围的普通文件，每个 JSON 最大 64 KiB；拒绝越界及软链接，不返回 tools、任意附加字段、认证配置或脚本内容。没有模板文件的任意仓库仍可使用；坏元数据只返回 invalid，不把项目当作不可接入，也不代表可执行默认策略。

本功能是可选信息发现与 Main/Worker 交接，不是模板全量校验器、自动构建器或 Git 权限执行器。执行前仍读取目标仓库规范、核对实际脚本和当前用户授权；read-only 请求不因项目配置变成写入任务。

## 知识条目接口（只读）

agent_repo 提供 knowledge_search、knowledge_read、knowledge_validate。只查询当前 Agent 登记项目的知识目录；多项目必须传 projectId，不接受任意根目录、其他 Agent、命令或自动 clone。知识目录仍由角色 projects.json 的 knowledge 或默认 wiki/ 决定，project.json 不改变读权限和目录选择。

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

命名空间优先级：project.json 的 knowledge.metadata_namespace → 知识目录 bundle.json 的 metadata_namespace → x_agent。允许 x_ 开头的小写字母、数字与下划线命名空间，不猜测文档字段，不把所有项目强制迁移为 x_agent；x_xgj 文档保持原样。命名空间只改变 uid、feature_id、relations、时间等扩展字段的读取位置；type/title/status/sources/verified 等顶层字段仍保持原语义。

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
