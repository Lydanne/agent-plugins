# AllDecision

OpenClaw 云决策模型插件。首版通过 OpenAI Decisions API 提供分类、布尔概率和评分；厂商适配器与宿主生命周期分离，后续可新增云厂商，无需改变使用方的 `decision_evaluate` 调用。

插件 ID 为 `all-decision`，展示名称为 **AllDecision**。它注册 `DecisionProviderV1`，不会注册聊天模型或替代 Main/Worker。当前模型选择值：

```text
all-decision/openai/gpt-6-luna
```

## 兼容与安装

需要 Node.js 24.19+。首版最低声明 OpenClaw/plugin API `2026.10.8`，以该版本的公共决策、prepared-secret 和 guarded HTTP 接口为验证基线；不将仓库其他插件的 `2026.9.5` 基线当作本插件兼容保证。

在管理员授权的目标环境安装本目录，或将本目录加入现有 `plugins.load.paths`。本仓库开发和测试不会修改生产配置、安装插件、重启 Gateway 或选择模型。当前包为仓库交付，尚未发布 npm。

将以下片段合并进已有配置，保留其他插件路径、allow 项和 Agent 字段。路径替换为实际 clone 目录。先在宿主 Settings → Secrets 保存自己的 OpenAI API key，再配置 SecretRef；ChatGPT/Codex 订阅登录态不能充当此 API key。

```json5
{
  plugins: {
    load: { paths: ["/absolute/path/agent-plugins/packages/all-decision"] },
    allow: ["all-decision"],
    entries: {
      "all-decision": {
        enabled: true,
        config: {
          providers: {
            openai: {
              enabled: true,
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "store", provider: "default", id: "OPENAI_API_KEY" },
            },
          },
        },
      },
    },
  },
  agents: {
    defaults: { decisionModel: "all-decision/openai/gpt-6-luna" },
    entries: {
      main: { decisionModel: "all-decision/openai/gpt-6-luna" },
    },
  },
}
```

**Agent 自身的 `decisionModel` 优先于全局默认值。** 例如 Ada 的 `agents.entries.main.decisionModel` 已显式配置时，单改 defaults 不会替换它。模型也会显示在宿主独立的 Decision 选择器中；安装/启用插件本身不会自动选择模型或启用实验性消费者。

## 配置与数据流

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `providers.openai.enabled` | `true` | 是否允许 OpenAI 适配器执行 |
| `providers.openai.baseUrl` | `https://api.openai.com/v1` | API 根地址，插件追加 `/decisions`；必须 HTTPS，禁止 URL 凭证、query、fragment |
| `providers.openai.apiKey` | 无 | 宿主 SecretRef；不接受明文 key |

插件仅在当前调用中读取 `getPreparedPluginSecretInput` 的已准备凭证，不自己读取环境变量、认证文件、旧快照或冷解析引用。引用缺失或刷新后不可用时返回 `credentials-unavailable`。凭证轮换使用宿主 `secrets.reload`，不跨调用缓存 key。`isReady` 只检查本地准备状态，不进行网络探测。

选中此模型后，使用方提交的 state、instructions 和 criteria 会发送到配置的云端，可能产生 API 费用。自定义 baseUrl 由管理员配置，是这些资料和凭证的接收地址；插件通过宿主 guarded HTTPS 传输，使用宿主受信环境代理，禁用重定向及请求捕获。在异步传输准备之后、真正发送之前再次检查宿主 authority，并传递取消信号及单调时钟 deadline。结束前清理响应和 transport。

## 映射与失败行为

- `choice` → OpenAI `choice`：保留原始标签、供应商选择结果、概率和可选 confidence，不重算或归一化。
- `boolean` → OpenAI `predicate`：instructions 保留 true/false 两个条件，返回的 probability 原样映射为 `probabilityTrue`。
- `score` → OpenAI `score`：按原顺序提供 0 开始的 levels，保留小数评分，按返回 value/label 验证并恢复概率顺序。
- state 和 JSON rubric 内容序列化为文本证据；URL 不自动作为图片读取。此版本遵守 OpenClaw 的文本/JSON DecisionEntry 合同，不额外接受图片、工具调用或任意消息数组协议。
- 模型结果与实际 input/output token 用量原样映射；未返回的用量或 confidence 不伪造。

一次最多 256 个问题（宿主上限），每题 2–255 个分类选项或 2–10 个评分档位。序列化请求最多 1 MiB，响应最多 2 MiB。超出范围直接返回 `unsupported-input`，不截断或拆分。

认证错误、限流、网络失败和异常响应分别返回宿主支持的 unavailable 原因。Retry-After 最多一分钟，不自动重试，也不切换其他云厂商。拒答使整批返回 `unsupported-input`；缺失/重复答案、错误标签或非法概率使整批返回 `invalid-response`，不会交付半批成功。取消和 authority 关闭保持终止异常，不转成负面判断或备用执行。错误结果不携带供应商正文、证据或密钥。

## 开发与扩展

```sh
pnpm --filter all-decision build
pnpm --filter all-decision test
```

模块职责：

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | 连接公开 SDK、注册 provider |
| `provider.mjs` | 模型路由、prepared-secret 读取、生命周期与错误结果 |
| `transport.mjs` | guarded HTTP、响应上限、清理和安全错误 |
| `providers/openai.mjs` | OpenAI 协议与宿主 DecisionBatch/Result 双向映射 |
| `configuration.mjs` | 管理员配置和 endpoint 校验 |

新增云厂商时，在 `providers/` 新增 adapter（vendor、models、encode、decode），登记到 `provider.mjs` 的 adapters，扩展 `configuration.mjs`、manifest 的配置 schema、secretInputs 和 decisionModels，并加入协议与取消测试。选择值统一采用 `all-decision/<厂商>/<模型>`。第一版只有 OpenAI adapter，未声称其他厂商已接入；不能仅改 baseUrl 就将不同厂商协议视为兼容。

测试使用合成数据、注入 transport 和临时宿主状态，不读取真实密钥或发送业务数据。通过本地测试及宿主加载不代表 OpenAI 账号可用、API 真实调用或 Ada 飞书业务已验收。

接口依据：[OpenAI Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)、[Create a decision](https://developers.openai.com/api/reference/resources/decisions/methods/create)，核对日期 2026-10-29；宿主依据为 OpenClaw 2026.10.8 的公开 `plugin-sdk/decisions`、`secret-input-runtime`、`ssrf-runtime` 和 `provider-http`。
