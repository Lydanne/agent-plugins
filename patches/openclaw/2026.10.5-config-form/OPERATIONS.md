# Control UI 补丁部署、回滚与升级检查

本流程针对 [README](README.md) 中的精确基线与补丁。插件不会自动应用补丁；安装或升级 OpenClaw 可能替换 `dist/control-ui`。版本号相同也不能证明补丁仍在，必须检查构建产物和正式表单。

## 范围与前置条件

- 只修改匹配宿主的 Control UI 静态产物，不修改插件 schema、认证、Agent 身份或业务配置，不重放任务或通知。
- 部署和服务重启须有当次授权。预留维护窗口；有运行中任务时先协调，不能把健康检查当作任务已完成。
- 本补丁仅适用于 OpenClaw `2026.10.5`、源码提交 `1b58cb9a1b4f4353e1add63c8506db4d890962e8`。版本、提交、安装归属或配置路径不明确时停止部署。
- 从实际服务/管理器确定安装根、配置文件、CLI 和监听地址，不凭 PATH 中另一个 `openclaw` 推断。Ada 管理的实例可使用 `ada exec openclaw …`；普通安装使用其实际 CLI。命令必须始终指向同一实例。
- 使用独立源码 checkout；检查工作树、未推送提交和进行中的 Git 操作，保留其他维护任务的改动。不要在安装目录应用源码补丁。

以下 shell 示例用于 Bash；先在同一个 shell 设置实际绝对路径，不能直接照抄占位值：

```bash
# INSTALL: 当前实例 node_modules/openclaw 根目录
# SOURCE: 精确基线的独立源码 checkout
# PATCH: 本目录 config-form.patch
# CONFIG: 当前实例实际配置文件
# BACKUP: 新建、尚不存在的私有备份目录（不在 Git 跟踪范围内）
: "${INSTALL:?}" "${SOURCE:?}" "${PATCH:?}" "${CONFIG:?}" "${BACKUP:?}"
```

## 1. 核对版本、备份与构建

1. 读取安装根 `package.json`、`dist/build-info.json`，记录版本、源码 commit、宿主 buildId；核对源码 `git rev-parse HEAD`。仅打印这些身份字段，不输出配置或凭证。
2. 用 `shasum -a 256 "$PATCH"` 核对 README 的补丁摘要。按 README 执行 `git apply --check`、应用、安装锁定依赖、类型检查和 8 组回归测试。出现版本差异或测试失败先停止。
3. 在维护窗口内备份完整静态目录和配置，保留权限；配置含凭证，备份不得进入 Git、截图或公开日志。

```bash
umask 077
test ! -e "$BACKUP" && mkdir -p "$BACKUP" || exit 1
chmod 700 "$BACKUP"
cp -p "$CONFIG" "$BACKUP/openclaw.before.json" || exit 1
chmod 600 "$BACKUP/openclaw.before.json"
cp -p "$INSTALL/package.json" "$BACKUP/package.before.json" || exit 1
cp -p "$INSTALL/dist/build-info.json" "$BACKUP/build-info.before.json" || exit 1
cp -Rp "$INSTALL/dist/control-ui" "$BACKUP/control-ui.before" || exit 1
```

4. 为原目录全部文件建立 SHA-256 清单并核对备份副本；至少记录原配置、`index.html` 和完整产物清单。记录源码提交、补丁摘要、构建命令、时间及回滚目录。备份期间若配置或安装发生变化，重新核对并建立一致快照，不能覆盖他人的更新。
5. **使用当前宿主的 buildId 构建匹配前端。** 默认独立构建产生新 buildId，Gateway 会拒绝加载，即使版本号相同。确认精确基线一致后，使用此版本支持的显式构建参数：

```bash
HOST_BUILD_ID=$(node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const info = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
  if (pkg.version !== "2026.10.5" || info.version !== pkg.version ||
      info.commit !== "1b58cb9a1b4f4353e1add63c8506db4d890962e8" ||
      !/^[a-zA-Z0-9._-]{1,96}$/.test(info.buildId || "")) process.exit(1);
  process.stdout.write(info.buildId);
' "$INSTALL") || exit 1
(cd "$SOURCE" && OPENCLAW_CONTROL_UI_BUILD_ID="$HOST_BUILD_ID" pnpm ui:build) || exit 1
```

保留真实构建时间及源码 dirty 状态，另行记录补丁摘要。该参数只用于已验证同一源码基线的局部修复；不能借它把新版本前端冒充旧版本。不要修改宿主 `build-info.json`、关闭校验、使用 `dev` 绕过检查或手改压缩后的 JS。不同版本需重新移植并验证。

## 2. 暂存产物与切换

1. 在 `dist` 同一文件系统创建唯一、尚不存在的 stage 目录；先复制原 `control-ui`，再覆盖本次 `SOURCE/dist/control-ui`。保留旧哈希资源供尚未刷新的页面使用，但新入口及清单必须来自同一次构建。
2. 逐文件校验 stage 中的新增构建产物与源码构建输出一致，检查 HTML 引用、构建标识及资源清单完整。不能只复制 `index.html` 或单个 JS。
3. 再次检查当前安装身份、配置及原目录清单未被并发修改。若发生变化，停止切换并复核。
4. 短暂停止 Gateway，将原 `control-ui` 重命名为唯一的 previous 目录，再将 stage 重命名为 `control-ui`。两次重命名应在同一文件系统；第二次失败时立即恢复 previous。不要覆盖已有 previous 备份，也不要先删除原目录。
5. 使用该实例管理器启动 Gateway，等待健康检查。Ada 命令为 `ada exec openclaw gateway stop`、`ada exec openclaw gateway start`、`ada exec openclaw gateway health --json`。具体选项以当前版本 `--help` 为准。

仅替换文件不保证生效：运行中的 Gateway 可能缓存旧 HTML 入口。本次现场曾在替换后仍返回旧入口，重启后才重新读取文件；停机切换可避免入口缓存及切换空窗的问题。

## 3. 正式控制面板验收

1. 在现有登录态下刷新实际控制面板，进入“设置 → 插件 → Agent Repo → 设置”；此版本路径为 `/settings/plugins/agent-repo?view=settings`。确认没有“不支持的架构节点”或资源准备错误。
2. 检查 `main`（以及部署上其他 Agent）的键、repo、defaultProject、完整 sync 嵌套字段。展开分支、远端、入站渠道、每日同步和 Git 环境控件；不要把凭证或私有环境值截入交付图。
3. 无操作测试：聚焦后离开字段，不改值；核对配置文件未变化。
4. 在授权范围内选择一个已有的无害数值做最小可逆编辑。例如同步超时原为 `30000` 且允许范围是 `1000–60000` 时，改成 `30001`；不要修改仓库路径、Agent ID、认证或权限用于测试。
5. 等待页面显示“已保存”，从磁盘读取完整配置做结构比较，只输出差异路径。预期唯一差异是 `plugins.entries.agent-repo.config.agents.<id>.sync.timeoutMs`。刷新页面确认新值持久化；不能仅凭 toast 判定写盘成功。
6. 通过同一控件恢复原值，再核对整个配置。JSON 可用本地解析后深度比较；JSON5 应使用宿主支持的解析器，不用 JSON 解析失败来判定配置损坏。对象顺序/格式可能不同，应区分语义一致与逐字节一致。
7. 除目标字段外的 Agent、可选字段、隐藏字段及凭证必须完全保留。出现额外差异、缺字段、配置校验失败或保存冲突时停止操作并检查来源；不要盲目覆盖整份配置。
8. 最后检查 Gateway 健康、插件加载、正式飞书连接及错误日志。保存脱敏截图和私有验收记录，不发送测试业务通知、不重跑旧任务。

本版本实际保存没有改动元数据，恢复后应逐字节一致。以后版本若自动更新元数据，须明确列出并解释每一个差异路径，不能宽泛忽略整棵对象；配置变动来自并发维护时应重新选择基线。

## 4. 回滚

### 同版本静态文件回滚

适用于页面空白、旧资源入口、构建标识拒绝或表单回归：

1. 保留当前失败产物、错误日志和配置现状；确认当前安装仍与备份的版本、commit、buildId 一致。若已升级，转到下一节，不能混用旧 UI 和新宿主。
2. 停止目标 Gateway，将当前 `control-ui` 重命名保留。从验证过的 `control-ui.before` 复制到同文件系统的新 stage，校验完整文件清单及权限后重命名到 `control-ui`；失败时恢复刚保留的目录。
3. 启动同一 Gateway，刷新页面并检查健康、插件和飞书。回滚后的旧版可能重新出现原始表单错误，此时只能使用原始模式或等待重新修复，不能称补丁验收通过。
4. **静态回滚不还原配置。** 配置备份只供比较与恢复依据；若测试值仍存在，优先通过正常编辑恢复该字段。整份配置还原必须先排除并发更新、备份当前状态并明确授权，避免覆盖后来新增的字段或凭证。

### 升级后的回滚

不能将本目录旧版 UI 复制到新版 OpenClaw，也不能改 buildId 欺骗兼容检查。使用安装管理器支持的完整版本回退流程，核对升级是否迁移过配置/状态；仅有 UI 和配置备份不足以保证完整宿主降级安全。不具备完整回退条件时保留当前版本并报告受阻。

## 5. 每次升级后的检查与决策

升级前记录当前安装身份、补丁摘要、已部署资源清单和私有备份位置。升级后必须重新读取实际服务安装路径（管理器可能切换目录），不要复用旧路径变量。

| 检查结果 | 动作 |
| --- | --- |
| 同基线、资源清单与已验收补丁一致 | 仍执行正式页面与保存验收，不能只看版本号 |
| 同基线、产物被重装覆盖 | 使用本流程重新备份、构建、部署；不要使用陈旧配置备份 |
| 新版本已原生支持完整 schema | 不重打旧补丁；迁移回归测试并验证无损保存后，记录不再需要补丁 |
| 新版本仍有问题 | 在新版本独立源码上重新定位和移植，建立新版本补丁目录、摘要与许可来源，通过回归后再部署 |
| schema、保存协议或构建身份机制改变 | 更新测试和流程后验证；不能删除校验规则、固定 Agent ID 或强制套用旧补丁 |

升级检查至少包含：动态 Agent 键、多个 Agent 保留、嵌套/隐藏字段保留、无操作与单字段保存、`minProperties`/`maxProperties` 渐进修复、字符串 `not.pattern`、其他不支持结构的原始模式回退。非法值测试在隔离环境执行，正式环境只做可逆合法编辑。

`git apply --check` 成功仅证明文本能应用，不证明新版兼容。新版本必须重新跑 README 中适用的浏览器、保存链路、类型检查与构建；正式页面保存验收仍不可省略。这里没有安装定时任务或自动补丁机制。

## 已执行的部署验收（2026-10-21）

- 基线与补丁：OpenClaw `2026.10.5`，源码 `1b58cb9a1b4f4353e1add63c8506db4d890962e8`，补丁交付提交 `472a113`，补丁 SHA-256 见 README。
- Node `24.22.0`、源码 pnpm `12.9.0`；使用当前宿主 buildId 参数重新构建，保留真实构建时间与 dirty 标记。未修改宿主身份或禁用校验。
- 首次独立构建因新 buildId 被宿主拒绝；使用匹配参数重新构建和重启后恢复。运行中缓存旧 HTML 的现象也已确认，上述流程已纳入预防步骤。
- 2038 个新构建文件逐文件核对一致，保留旧哈希资源、完整原 UI 和配置备份；备份目录权限 `0700`，配置副本 `0600`。
- 正式页面 `sync.timeoutMs` 经 `30000 → 30001 → 30000` 保存和刷新验收；中间唯一差异为目标字段，最终完整配置与部署前备份逐字节一致。
- 最终 Gateway 健康、飞书 running/connected 均为 true，lastError 为空。
- 私有备份及部署收据留在部署机器的 Agent Repo `.runtime/`，未纳入此仓库；不提交真实配置、安装路径、日志或正式页面截图。此记录仅说明当次验收，后续重装、升级或并发维护后需重检。
