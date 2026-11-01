# 飞书报告交付故障定位

- 状态：已核验
- 适用范围：Feishu 文档交付与后台上传队列
- 来源：[交付实现](../../packages/feishu/src/document-delivery.ts)、[后台队列](../../packages/feishu/src/document-background.ts)、[回归测试](../../packages/feishu/src/document-background.test.ts)、[使用说明](../../packages/feishu/README.md)
- 最后核验：2026-11-01；对照报告读取预检、失败诊断和上传状态实现及其回归测试。
- 失效条件：宿主 media 权限接口、localRoots 语义、队列状态或上传协议改变。

## 已核验事实

报告在本地存在不代表可上传。显式 documentDelivery.localRoots 漏掉所选项目的报告产物目录，会触发 read_files/path-not-allowed；不得按模型给出的任意路径扩权。

后台 status=done 表示队列和卡片处理结束。报告是否成功需检查独立 uploadState；失败提示交付成功也可能得到 done。上传 succeeded 后还应回读云文档核验正文，不能只看任务终态或服务健康。

## 使用方法

先确认报告实际存在及可读，再核对管理员配置的报告目录范围。目录拒绝应由管理员按实际项目补齐精确产物目录。创建占位文档前经宿主 media 预检；含临时读取函数或显式交付权限时保持同步处理。后台保留 Worker 标题，失败时保留总结并显示原因。

## 验证与限制

本条不记录私人聊天、原始业务报告或宿主绝对路径。隔离测试验证代码分支；本地包安装、真实上传、用户可打开和正文完整须分别验证，不从其中一项推导其他项。
