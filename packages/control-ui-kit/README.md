# Shared Vue Control UI kit

Vue 3 + TypeScript + locally maintained shadcn-vue sources, used by every formal AgentRepo and AgentWorker UI entry. Source provenance and adaptations are in THIRD_PARTY_NOTICES.md and LICENSE.shadcn-vue.

Load each entry in the same document window as its mounting container. Reka focus guards and scroll locks are realm-local; foreign-document containers are rejected before allocating roots, subscribing, or issuing RPCs. ShadowRoot containers in the same document are supported.

`mountVueView(Component)` adapts the public mount/update/dispose contract. Inject reactive host snapshots with `useHostContext()` and the per-view portal root with `useOverlayTarget()`. Feature components invalidate requests on target/permission changes and release timers and diagnostic leases when hidden. Raw Reka/shadcn primitives require controlled business state; the shared Dialog, Popover and ActionMenu additionally handle host visibility and scope changes.

Import `theme.css` once from each browser entry. Utilities use `ocp:` without global Preflight. Independent Vue bundles use a shared per-view ID sequence to avoid accessibility ID collisions. Every portal explicitly targets its view's themed overlay root.

`buildControlUi({root,entry})` builds a self-contained content-hashed ESM/CSS directory, emits complete THIRD_PARTY_LICENSES.txt from the actual bundled dependency graph, and updates the public manifest entry/styles. No CDN or cross-plugin runtime dependency is required. Build in an isolated checkout when production loads source directly. See ../../docs/control-ui-vue-migration.md for the feature checklist and acceptance boundary.

## shadcn-vue 与宿主适配的组合方式

这是基于 **shadcn-vue 源码组件** 的本地组件库：Vue 页面统一从本包导入，基础组件与宿主适配共用一套主题。上游采用源码分发方式，参考 [shadcn-vue 介绍](https://shadcn-vue.com/docs/introduction) 和 [主题说明](https://shadcn-vue.com/docs/theming)。当前固定源码版本见 THIRD_PARTY_NOTICES.md；新增组件按固定来源审阅、复制和适配，不直接覆盖已有宿主适配文件。

| 层次 | 内容 | 使用约定 |
| --- | --- | --- |
| shadcn-vue 基础组件 | Button、Input、NativeSelect、Card、Badge、Alert、Empty、Dialog/Select 等 Reka primitives | 统一 `ocp:` 样式前缀，无全局 Preflight；按需构建进插件 |
| 本地通用组合 | PageHeader、SearchField、EmptyState、StatusNotice | 组合基础组件，统一标题、查询、空结果、错误与提醒；不内置业务请求 |
| OpenClaw 适配 | mountVueView、useHostContext、useOverlayTarget；Dialog/Popover/ActionMenu 包装 | 处理宿主生命周期、主题同步及实例弹层；业务页面保留权限和过期请求检查 |

```vue
<script setup lang="ts">
import {ref} from 'vue';
import {PageHeader,SearchField,Card,EmptyState,StatusNotice} from '@openclaw-plugins/control-ui-kit';
const query=ref('');
function search(value:string){ /* 使用页面的权限与请求封装查询 */ }
</script>
<template>
 <PageHeader title="知识库" description="浏览和搜索项目文档。" />
 <SearchField v-model="query" aria-label="搜索知识库" :busy="false" @search="search" />
 <Card><EmptyState title="请选择项目" description="先选择知识目录所属的项目。" /></Card>
 <StatusNotice tone="warning" title="扫描未完成">以下结果可能不完整。</StatusNotice>
</template>
```

SearchField 显式提交才发出 `search`，值会 trim；清空按钮或 Escape 发出空查询并恢复输入焦点。`disabled` 阻止输入与提交，`busy` 阻止重复提交和清空；中文输入法组合期间不提交。可以把 maxlength、aria-label 等原生输入属性传给它。它不持有缓存、不自动查询、不绑定任何 Agent。

PageHeader 默认使用 h2，操作放在默认插槽；EmptyState 的默认插槽可放重试操作。StatusNotice 支持 info/warning/error，error 使用 role=alert，其余使用 role=status；actions 插槽放显式恢复按钮。外部文本始终通过 Vue 文本插值，原始 Markdown/HTML 不能传给 v-html。

### 主题和样式边界

统一使用 `--ocp-background` / `--ocp-foreground`、`--ocp-muted`（辅助文字）和 `--ocp-muted-background`（浅底色）、`--ocp-primary` / `--ocp-primary-foreground`、`--ocp-border`、`--ocp-ring`。提醒使用 `--ocp-warning` / `--ocp-warning-background`。不要把宿主 `--muted` 当背景色，也不要在业务页面重复设置按钮前景色。背景和文字分别继承宿主 `--bg` / `--text`，主按钮使用固定可读的前景色；可在插件根覆盖成对的主题变量。

`themeVariables` 导出宿主和弹层共享的完整变量清单，mountVueView 会同步到当前实例的 overlay。浅色/深色主题由宿主控制，不另加按系统主题切换的 shadcn dark 变体。所有新增选择器都限于 `[data-ocp-ui]`，仅针对明确的 data-slot/data-variant 修复宿主旧按钮 reset，不修改宿主普通按钮。`cn` 作为公共工具合并带 `ocp:` 前缀的 Tailwind 类。

知识库页面是基础组件、通用组合和宿主请求适配搭配使用的完整示例，见 `../agent-repo/ui/KnowledgeView.vue`。其他页面可按功能逐步采用，不需要一次性重写业务逻辑。

### 管理页面统一接入

AgentRepo 与 Worker 的正式页面统一从本包导入表单、表格、标题、状态、空结果、卡片和徽标组件；业务代码保留 Agent/会话/项目范围、请求代次、确认与幂等控制。只读原文、日志树、时间线、字段列表继续使用语义 HTML，不能把组件替换当成权限或业务流程调整。

- PageHeader 支持 `heading="h1|h2|h3"`、`compact` 和 `leading` 插槽；`focus(options?)` 将焦点移到真实标题，用于详情切换，标题不增加 Tab 停靠点。
- SearchField 的 `hide-label` 只隐藏视觉标签，保留关联 label；可组合项目/状态筛选器。即时过滤的技能列表继续使用 Input。提交及清空时由页面同步 query 后执行原请求。
- Card 的 `as="div|section|article|aside"` 保留列表和区域语义。密集列表可通过 class 调整间距，不复制 Card 皮肤。
- StatusNotice、EmptyState 支持 `compact`，供侧栏、表格提示和内嵌区域使用。
- Textarea 支持受控 `v-model`、`defaultValue` 和原生 rows/maxlength/required/readonly 属性。输入事件同步更新模型，保证同一轮事件内提交取得最新草稿；默认不按内容无限增高。展示只读 JSON 时传 `:model-value` 和 readonly，保留原文字节。
- Checkbox 的半选状态用 `model-value="indeterminate"`，业务事件以 `$event === true` 判断选中；Switch 用于设置开关。主题层保护两个控件的轨道、边框和选中前景，避免宿主旧 button 样式覆盖状态。

`OverlayScope` 为全屏或局部工作区提供内部 portal 目标；放在其子树中的 Dialog、Popover 等弹层会挂载到该区域。作用域根保留主题变量继承，不移动其他视图的 body portal；卸载时自动清理。

G6 的传递依赖有四个精确版本未在 npm 包内携带许可证文件。`licenses/` 保存其发布包的许可证声明、来源及相应标准文本，不推测版权主体/年份；构建仍拒绝其他缺失许可证的包。升级相关版本时须重新核对，不能泛化白名单。

### 虚拟目录导航

`VirtualNavigationTree` 通过 `@openclaw-plugins/control-ui-kit/virtual-navigation-tree` 按需导入，是本地组合组件，使用共享的 shadcn-vue `Button` 和宿主主题；它不声称是上游 Sidebar 的源码副本。调用方提供已展开的扁平节点、脱敏后的展示文字和当前选中状态，组件只负责虚拟窗口、展开/选择事件与树形键盘导航。上下键、Home/End 和左右键可在可见层级中移动、展开或返回父项；Enter/空格激活当前条目。目录归属、索引文件、搜索和数据权限继续由业务层负责。组件不缓存正文或路径之外的业务数据。知识图谱的分组面板使用已有的 shadcn-vue Collapsible；关闭时不挂载分组按钮。
