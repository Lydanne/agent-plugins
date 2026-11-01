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
