# Agent Repo 知识库机制

- 状态：已核验
- 适用范围：agent-repo 当前的项目登记与同步实现
- 来源：[登记实现](../packages/agent-repo/repositories.mjs)、[工具入口](../packages/agent-repo/index.mjs)、[准备检查](../packages/agent-repo/preparation.mjs)、[同步实现](../packages/agent-repo/runtime-sync.mjs)
- 最后核验：2026-11-01；对照字段解析、list/inspect 返回值和 wiki 同步条件。
- 失效条件：项目 schema、知识目录返回值或同步规则改变。

## 已核验事实

knowledge 可选，未配置时默认为项目根 wiki/；显式配置优先。list 返回绝对目录位置，inspect/skills 返回可用性、入口及目录类型。知识文件不会因登记而进入 memory_search 或自动载入模型。

## 使用方法

按[统一规范](../packages/agent-repo/skills/agent-repo-context/references/knowledge.md)登记并维护入口。普通 wiki/ 目录随项目 Git 更新；独立 Git 工作区读本地，已声明的 wiki 子模块同步要求见[项目说明](../packages/agent-repo/README.md)。

## 验证与限制

本条核验了本地实现，不证明宿主自动同步已启用，也不证明外部知识来源已导入或可被语义搜索命中。
