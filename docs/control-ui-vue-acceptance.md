# AgentRepo / AgentWorker Vue 重构验收记录

验证日期：2026-10-30（Asia/Shanghai）。Node v24.22.1，pnpm 10.33.2。实现与验证均在独立 checkout 执行。

全部正式入口及兼容入口已使用 Vue 3 + TypeScript + shadcn-vue；完整功能清单见 [迁移清单](control-ui-vue-migration.md)。公开入口、导航标识、RPC action/payload、分块协议、revision/requestId 语义保持兼容。管理中心跨会话查询与 Worker 当前会话查询各自封装。

## 已通过的检查

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 所有工作区类型检查通过 |
| `pnpm build` | 所有插件构建通过，两个 UI 生成独立内容哈希资源 |
| `pnpm test` | 2,465 项通过：AgentRepo API 41、AllDecision 55、共享 UI 6、Feishu 1,499、AgentRepo Node 316 / Vue 98、AgentWorker Node 424 / Vue 26 |
| Feishu 并发增量复验 | 合并远端独立的文档处理提交后，类型检查和构建重新通过；Feishu 1,507 项通过。其余源码及 UI 构建哈希未变化，复用上列有效结果 |
| `pnpm test:ui:e2e` | Chromium 45 项通过，加载实际构建 JS/CSS 和公开宿主模拟器 |
| 独立安装包 | 两个 `pnpm pack` 归档均核对 manifest 资源存在、仅包含当前 UI 哈希目录、不包含测试文件、包含第三方完整许可 |

Chromium 覆盖 320/400px 侧栏、720px 窄页面、1280px 桌面，宿主明暗主题及独立兼容入口；Agent/会话/项目切换、晚到响应、原地宿主更新、权限降低、隐藏与卸载；精确任务跳转、单删/批删、部分失败及未知结果不自动重放；技能、工作区、人员、定时任务和回收站的确认与版本合同；实时日志默认关闭、显式开启、断连与离页释放、晚到租约原 Agent 清理、1,500 条虚拟滚动和实际查找定位。弹层覆盖裁剪、键盘、焦点返回及宿主原生弹窗共存；两个插件独立加载、重复挂载、导航桥卸载及宿主 Tailwind 变量隔离均有断言。

## 构建与归档

| 插件 | UI 哈希目录 | JS / gzip 字节 | CSS / gzip 字节 |
| --- | --- | --- | --- |
| AgentRepo | `4a4f6a3ee654aab932bf` | 784,256 / 179,150 | 103,093 / 18,161 |
| AgentWorker | `af816516918762c74e9b` | 459,864 / 110,596 | 51,913 / 9,905 |

每个 UI 哈希目录均附带 `THIRD_PARTY_LICENSES.txt`，按实际打包模块收集完整许可证，并补充 Tailwind 生成样式与固定版本 shadcn-vue 源码许可。没有 CDN、裸依赖导入或另一插件的运行时依赖。Tailwind 主题、变量初始化和基础样式限定在插件根节点；内部变量与动画名称使用插件前缀。

本地交付归档位于独立 checkout 的 `.tmp/releases/`（不提交 Git）：

- `agent-repo-0.1.0.tgz`：106 个文件，433,956 字节；SHA-256 `a0e54c0fbfa9a3ad2ef018d3e1c749a3a92e621134686ba3e547cd8c09fbacba`。
- `agent-worker-1.0.1.tgz`：77 个文件，322,141 字节；SHA-256 `6213985f460869e389dc46a5c87d5ff48e3832e4d44202cdc390447b855e7283`。

## 验收边界

本记录证明本地构建、公开合同模拟和 Chromium 界面回归通过。没有修改生产配置、更新生产源码 checkout、执行部署、reload 或服务重启，也没有真实飞书业务端到端验收。生产切换须另行授权。
