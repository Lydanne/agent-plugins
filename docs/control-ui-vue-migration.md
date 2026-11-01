# Vue Control UI migration and acceptance

All formal AgentRepo and AgentWorker browser entries use Vue 3 Composition API and TypeScript SFCs. The temporary CompatSection and imperative project/log renderers have been removed. Small `.mjs` adapters retain the existing public mount/update/dispose and registration contracts. No production deployment or restart is part of this delivery.

## Feature migration checklist

| Surface | Vue implementation and retained behavior |
| --- | --- |
| Management shell / overview | Eight modules including project knowledge; independent source errors, resource counts, maintenance warnings and Worker summary |
| Projects and compatibility sidebar | Agent/project tabs, repository scopes, metadata, subagents, warnings, project skills, CLI policy maintenance and Worker navigation |
| Workspace / skill maintenance | Lazy reads, draft preservation, revision and request IDs, confirmations, update policies, capacity/occupancy, audit and stale-response isolation |
| Agent-wide Worker tasks | Cross-session summaries, filters, paging, timing, delivery warnings and exact job links; separate data adapter from current-session Worker queries |
| Entities / personnel / standalone entries | Directory/group synchronization, account selection, revision-protected editing, drafts, technical identities and lazy graph relationships |
| Native schedules | Source-bound manager/editor, original permission checks, daily/custom/one-time schedules and delivery confirmation; task history/settings, nested run logs, exact identity checks and truncation notices |
| Audit / recycle | Filters, paging, actor provenance, change comparison, unknown outcomes, retention, revision checks, stable retry IDs and last-page correction |
| Historical/live diagnostics | Live default off; explicit lease acquisition/renewal/release, late-start cleanup, source-specific failures, virtual scrolling, find, grouping, repeats, lazy JSON, exact copy/export and confirmed source-wide clearing |
| Worker sidebar and full task page | Search/filter/paging, four detail views, raw record reader, task timeline, exact task location, single/batch deletion, revision scope and partial/unknown results |

## Shared kit and distribution

`@openclaw-plugins/control-ui-kit` owns host snapshots, per-view theme/portal roots, shadcn-vue source components and reusable interactions. It contains Button, Input, NativeSelect, Select, Checkbox, Switch, Tabs, Badge, Tooltip, Table, Pagination, Card, Skeleton, Empty, Alert, Collapsible, Dialog, AlertDialog, Sheet, Popover and DropdownMenu. PageHeader, SearchField, EmptyState and StatusNotice compose these primitives for consistent feature pages. Business views own authorization, scope invalidation and server outcome interpretation. No router, Pinia or caching framework was introduced.

Theme variables inherit the host palette; management green and sidebar blue-gray are retained. Tailwind utilities use `ocp:` with no global Preflight. Base rules stay inside plugin roots. The sole native-dialog compatibility exception restores pointer interaction to a host top-layer dialog while a plugin modal owns the body lock. Chromium verifies that dismissing the host dialog leaves the plugin dialog open.

Each plugin independently bundles Vue, components and styles with Vite library mode. `controlUi.entry/styles` refer to a content-hashed directory. `THIRD_PARTY_LICENSES.txt` is generated from the actual Rollup dependency graph alongside each browser entry, including the pinned shadcn-vue source notice. There are no browser CDN imports or runtime dependencies on the other plugin or private kit package.

## Verification and practical limits

Final gates are `pnpm typecheck`, `pnpm build`, isolated `pnpm test` and `pnpm test:ui:e2e`. Existing UI assertions run under Vitest/Vue Test Utils/happy-dom; actual SDK/action ownership and backend tests remain Node tests. UI assertions use behavior, roles and accessible names rather than old renderer identity.

Chromium loads actual built assets and manifests with a synthetic public host. Unsupported actions fail explicitly. Coverage includes 320/400px sidebars, 720px narrow and 1280px desktop, light/dark tokens, scope changes and late responses, in-place host updates, hide/revoke/dispose, independent plugin installs, duplicate mounts and navigation bridge unload. It exercises exact Worker deletion scope, partial failures, stable unknown-result retries, schedule/maintenance/workspace writes, raw records, virtualized 1,500-row logs, real find scrolling, explicit capture and original-Agent late-lease cleanup. Portal bounds, keyboard activation, focus return and native host modal coexistence are browser assertions.

All builds and test artifacts are produced in an isolated checkout. The registered production-loaded checkout is deliberately untouched. These checks are local contract and browser acceptance, not production deployment or real Feishu business end-to-end acceptance.

## 2026-11-01 管理页面组件统一

| 范围 | 接入内容 |
| --- | --- |
| 概览与管理壳 | PageHeader、Card、Button、Worker 状态提示；保留模块导航和资源统计 |
| 项目、技能、CLI、子代理、工作区 | PageHeader、复合 Table、Badge、Switch、Input、EmptyState、StatusNotice；保留详情焦点、设置草稿、确认和原请求重试 |
| 实体与人员管理 | PageHeader、SearchField、Button、Badge、EmptyState、StatusNotice；保留来源筛选、同步范围、编辑确认和版本检查 |
| 定时任务与执行记录 | PageHeader、Card、Badge、Textarea、StatusNotice、EmptyState；保留原群授权范围、草稿与保存确认 |
| Worker 跨会话任务页 | PageHeader、共享项目/状态筛选、SearchField、复合 Table 与提示；保留自动刷新和精确任务导航 |
| 审计、日志、回收站 | PageHeader、复合 Table、SearchField、Textarea、Card、状态与空结果；保留调试租约、原文读取、恢复和清理确认 |
| Worker 侧栏与完整任务页 | PageHeader、SearchField、Checkbox（含半选）、Badge、Card、EmptyState、StatusNotice；保留会话筛选、多选删除、部分失败、权限失效与四种详情视图 |

正式 Vue 页面中不再直接声明 input/select/textarea/button/table 及表格内部标签；由共享组件输出原生语义。原文、代码、字段列表、时间线和原生 details 保留语义 HTML，不为统一外观改变读取、安全和确认行为。浏览器验收使用实际构建资源与隔离模拟宿主；部署后再读取真实本机管理页面，分别记录模拟与真实结果。
