# Vue UI 整体 Review 与修复记录

日期：2026-10-30（Asia/Shanghai）。基线：`b3265db`。使用三个子 Agent 分别审查 AgentRepo 功能对等、Worker 交互与请求范围、共享宿主适配及生命周期；主 Agent 核验、统一修复并验证。只修复已有功能，没有新增功能或改变后端业务合同。

## 已修复的问题

| 级别 | 问题与修复 | 回归证据 |
| --- | --- | --- |
| P1 | 定时任务草稿刷新后错误使用新 revision，可能静默覆盖他人修改。草稿现在保留创建时 revision；刷新后的保存仍由服务器进行原修订冲突校验，保留编辑内容 | `schedule-manager.test.mjs`：刷新 catalog 后断言旧草稿仍提交旧 revision，收到冲突而非覆盖 |
| P2 | `update()` 更换 host 或取消信号后仍订阅旧宿主、日志继续使用旧 request。现在先卸载旧生命周期，再挂载新实例；清理旧请求、弹层、订阅和租约，同 host/signal 的更新仍保留组件状态 | 共享 host 测试；Chromium 更换宿主后旧日志租约释放、新读取只走新 host |
| P2 | 已取消的初始信号仍可能先挂载、发起读取；未监听公开 host.signal。现在挂载前检查取消，同时监听并清理 view/host 信号 | 共享 host 测试：已取消时 setup 不运行；host abort 后根节点与订阅移除 |
| P2 | 独立 Worker 管理入口在 pending 读取期间降低写权限会卡在加载状态。补齐 canWrite 生命周期 watcher，重新读取且丢弃旧响应 | `worker-page.test.mjs`：权限变更后新读取结束、旧响应不能覆盖、刷新按钮恢复 |
| P2 | Worker 五秒轮询会持续废弃耗时超过五秒的请求。加载期间跳过后台轮询，仍允许用户切换目标 | `panel.test.mjs`：推进十秒时仅一次 pending 请求，返回后正常展示 |
| P2 | 列表、任务记录、历史任务的“加载更多”失败或连点会递增偏移、跳页。现在只在成功响应后提交偏移，并阻止并发分页 | `panel.test.mjs`：三种分页均验证失败重试同一页、连点不重复读取 |
| P2 | jobId 精确跳转后分页丢失模型与执行范围。同一次有效 detail 响应会固定服务器确认的 scope，再允许移除 jobId 分页 | `panel.test.mjs`：job-only 入口分页仍发送原 execution/model scope |
| P2 | 时间线前插早到事件会重建已展开工具；对话前插早到消息也会重建代码阅读器。两处均改用稳定消息、工具和问题阶段身份 | `components.test.ts`：节点 identity、展开、代码行和时间线焦点保持 |
| P2 | 定时任务记录请求尚未结束时返回、再进入，会被旧 loading 缓存挡住。缓存现在区分请求 epoch，旧响应不能覆盖重新读取 | `control-ui.test.mjs`：返回后重开触发新读取并拒绝晚到旧日志 |
| P2 | 组织同步期间刷新资料后，syncBusy 无法释放。同步与读取使用独立生命周期计数；已确认的请求 ID 正常结算 | `entities-page.test.mjs`：pending 同步期间刷新，完成后不永久禁用同步按钮 |
| P2 | ShadowRoot 内挂载时，body Portal 主题停留在旧颜色。主题观察沿 composed ancestry 跨越 ShadowRoot.host | Chromium：实际构建产物挂入 ShadowRoot，改变宿主颜色后 Portal 同步，卸载清理 |
| P3 | 技能维护 failed/unknown 回执被统一描述为“已受理”。现在分别显示失败或待核验，避免误解结果 | `skill-maintenance-page.test.mjs`：两种回执均不显示完成或已受理 |

还检查了七个管理模块、项目与人员/实体兼容入口、工作区、技能、回收站、审计、日志的功能路径，以及公开 page/panel/navigation ID、RPC payload、分块读取、权限边界、revision/requestId 和导航桥。没有确认需要新增模块或新功能的遗漏。本次修复不涉及后端调度、存储或 Worker 执行机制。

## 验证结果

- `pnpm typecheck`、`pnpm build`：通过，公开 SDK 类型检查通过。
- 在全命令独立 `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` 中执行 `pnpm test`：2,487 项通过。末次对话阅读器修复后，重新执行 Worker 包测试：Node 424、Vue 33 通过；其余未变源码复用有效结果。当前有效断言合计 2,488 项（API 41、AllDecision 55、共享 UI 8、Feishu 1,507、AgentRepo Node 316 / Vue 104、Worker Node 424 / Vue 33）。
- `pnpm test:ui:e2e`：实际构建产物 Chromium **47/47** 通过，含原四档宽度、明暗主题、删除、确认、日志，以及新增宿主切换和 ShadowRoot 用例。
- 两个 `pnpm pack` 归档核对通过：资源与当前 manifest 一致、只有当前哈希目录、不包含测试文件，完整第三方许可随包附带。

当前独立 checkout 的 `.tmp/releases/` 归档已替换为 review 后版本：

| 归档 | UI 哈希目录 | SHA-256 |
| --- | --- | --- |
| `agent-repo-0.1.0.tgz` | `a33a24080f0e3800b05c` | `fbe8dda965cbda076f4b559ca34d0154bc5cfd944b333ce668048da07a81e82d` |
| `agent-worker-1.0.1.tgz` | `de1a16e4341be48806fb` | `e28158bd95085e5c38743775b9ff6b43a33e1d504da4ca01fc9f3a0e1006e2bf` |

## 边界

所有修改、构建及模拟宿主验证均在独立 checkout。没有向生产 checkout 写入，没有部署、reload 或服务重启，也未执行真实飞书业务端到端验收。
