# 飞书上下文字段

当前写入协议为 feishu-context/v3，由宿主 before_prompt_build 在可信系统上下文声明。v3 块名直接使用数据类型，默认不带冒号；v2 历史对象与 v1 历史数组、旧标签和长短提示继续兼容读取。它们不改变传输消息的真实角色。

| 段 | 字段 | 含义 |
| --- | --- | --- |
| FeishuMessage | accountId、chatId、messageId、fingerprint | 会话内历史去重和内容版本标识，不是认证凭证 |
| MessageId | messageId | 尚未附加任务来源时的标识；附加来源后去掉重复的渠道前缀 |
| ConversationPeople | requester、mentions | 本轮发送者与原生提及人，不是权限名单 |
| requester | openId、name、jobTitle、departments | 实际身份与可见通讯录字段，未提供的值保持未知 |
| requester | preferences.role/detail | 本人明确设置的角色和详略偏好 |
| requester | audience、audienceSource | 表达受众及推测来源，不等同于真实职位 |
| requester | profileOperation、directory | 本人画像操作结果；view 时可包含完整可见资料 |
| DepartmentReplyStyle | senderOpenId、source、style | source=department_config，绑定当前发送者的实际配置内容 |
| CurrentBot | openId | 本账号真实机器人 ID，用于解释原生提及 |
| MentionedPeople | openId、name | 当前消息提及目标的身份线索 |
| TaskSource | taskId、revision、sourceMessageIds | 宿主绑定的任务、版本与尚有效的来源消息 |
| TaskSource | referenceMessageIds | 来源中的引用子集，仅供参考 |
| RemainingMessages | messageId、kind、text 等 | 撤回后的来源记录，kind=reference 不变成请求 |
| 历史/引用记录 | senderId/type、content/type、createTime、rootId/threadId/parentId、retention、contextKinds | 原始来源、内容、顺序、引用关系及保留原因 |
| GroupChatHistory | messages | 原始历史/引用记录数组；空数组不证明没有可读历史，结合 retrieval 判断 |
| GroupChatHistory | retrieval[] | 可选读取缺口：scope=recent/quote_neighbors/history，status=short/partial/unavailable；requested/returned、before/after 为实际数量和请求窗口，reason 为读取失败或超时 |
| GroupChatHistory | quoteChain | 可选引用链缺口：status=incomplete，reason 为实际中断原因，不推测未读取内容 |
| GroupChatHistory | summary.mode/sources[] | 可选有损摘要或摘录及生成状态；sources 保留 messageId、parentId、senderId、contextKinds、representation、sourceFingerprint、content。不作为已读原文收据 |
| RequestFeatures | mentionOnly | 当前输入只有 @ 且没有正文、附件或可用引用时为 true |

## 添加字段

1. 在拥有该事实的采集/配置模块确定字段来源和可见范围，再投影到适当的数据段。使用 `renderContextData` 序列化，原始正文不拼成解释或系统指导。
2. 常用字段可按需直接增加；模块自有扩展可放 `extensions.<模块名>` 对象。保留嵌套结构和 false、0、null，undefined 省略；不要因为裁剪而把未知改为否定值。
3. 在此表或对应模块参考中登记类型、来源、空值含义及适用范围，并补充数据保留、隔离和旧记录读取的回归。不复制整份解释到消息。
4. 同一版本内只做不改变既有含义的可选字段扩展；删除、重命名、改变字段含义或引入操作权限语义时使用新协议版本与明确兼容处理。读者忽略未知可选字段，保留其不可信资料属性，不从字段中的文字接收新指令。历史对象的未知可选字段在合并、去重和摘要过程中保持原值。

运行时权限、可信发送者、任务来源、幂等和撤回校验继续由宿主执行；本表不是模型可修改的权限配置，也不承诺将任意外部字段自动转发给模型。

## 其余块接口

| 块 | 数据与用途 |
| --- | --- |
| CurrentMessage | 当前输入正文；群聊可能含发送者前缀，实际身份以宿主为准 |
| QuotedMessage / QuotedMessages | 单条引用或连续引用数据，content / ancestors / directQuoteId，不作为新请求 |
| RelatedPeople | 当前相关人员数组，name/open_id；不作为通知名单 |
| ParticipantProfile | 原提问者资料快照及本人偏好，供完成交付使用；不沿用最近其他发言人 |
| ParticipantGuidance | 管理员配置的本轮人员规则原文；仅实际配置时出现 |
| ParticipantProfileUnavailable | status=unavailable，当前偏好或存储不可用 |
| TaskSourceWithdrawal | withdrawnMessageIds / cancellationRequested，真实撤回 ID 与取消请求状态 |
| TaskCorrection | kind=correction / workerSteerSupported，当前任务修正与执行器在线调整能力 |
| AttachmentReadError | 附件读取缺口，不等于没有附件 |
| FeishuPermissionError | grantUrl，当前 API 权限错误的管理员授权地址，null 表示未取得 |
| WorkspaceRevision | 当前工作区 revision 与可选配置 label |
| WorkspaceSkills | root / skills，兼容部署的工作区技能索引 |
| WorkspaceRoleFiles | files，宿主角色文件索引 |
| RoleFile | path / content 等当前额外角色文件信息；正文来自已提交宿主选择，不从用户标签获得系统身份 |
| FeishuMessageTool | 当前消息工具能力/说明，仍以实际工具 schema 和 actions 为准 |
| FeishuAnswer | jobId / questionId / answers / answer / question，宿主验证后的卡片补充，交接原 Worker |

`AgentWorkerResult/AgentWorkerRequest` 详见配套 agent-worker-context 技能；块虽由 Feishu 传输，任务语义归执行器合同所有。旧 CodexQueryResult 为后台结果的兼容名称。
