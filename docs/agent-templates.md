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
