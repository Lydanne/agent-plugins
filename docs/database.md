# AgentRepo 统一数据库

每个 Agent Repo 的结构化私有资料集中保存在 `.runtime/agent_repo.sqlite`。继续使用 Node.js 内置 `node:sqlite` 的同步 DatabaseSync，不引入 ORM 或额外数据库服务。不同仓库各自独立，不因同一宿主而共享文件或改变访问授权。

## 数据归属

| 模块 | 表 |
| --- | --- |
| 版本管理 | repo_schema_migrations，SQLite user_version |
| 实体、关系、来源、人员扩展 | graph_*、entity_types |
| 实体回收索引 | recycle_items |
| 仓库审计 | audit_events |
| 回收站保留设置、操作幂等和清理结果 | recycle_settings、recycle_operations、recycle_cleanup |
| 仓库日志回收索引 | hidden_logs |

日志正文仍为仓库 Git 目录中的受控 JSON 文件，数据库只记录隐藏和回收索引。角色、技能、projects.json 继续使用文件。Worker、飞书登录态及其他插件状态由各自插件拥有。宿主 stateDir 的群计划和仓库同步计划库包含多个 Agent 的调度和审计，继续独立维护，不复制进单个 Agent Repo。面板仍按已有来源聚合查询。

## 共用连接与事务

`packages/agent-repo/database.mjs` 提供：

- openRepositoryDatabase(root)：核对存储路径和版本，初始化或迁移后返回连接，调用者 finally close。
- withRepositoryDatabase(root, callback)：短同步操作，自动关闭连接。
- repositoryTransaction(root, callback, options)：打开连接，在事务中运行同步回调，自动提交、回滚和关闭。
- databaseTransaction(db, callback, options)：复用现有连接；嵌套事务用 SAVEPOINT，dryRun 回滚自己的范围。
- migrateDatabase(db, name, callback)：检查并在事务中登记一次性领域迁移；失败不留下成功标记。

回调不得返回 Promise。事务内需要审计时传同一个 db，不能另开连接等待自己持有的写锁。回收站保留时间和成功审计在同一事务中提交。跨网络或跨宿主服务操作仍使用原幂等记录及 pending/unknown 协议，不把 SQLite 事务当作外部操作回滚。

所有连接设置 foreign_keys=ON、busy_timeout=5000、trusted_schema=OFF，并使用 WAL。WAL 允许读者读取已提交状态时另一个连接继续写入；SQLite 仍只有一个写事务。目录 0700，数据库 0600，拒绝主文件、sidecar 和路径组件的符号链接。新增图审计目标与快照来源索引，原图关系端点索引及唯一约束保持。

## 迁移

当前统一库 user_version 为 1，版本记录保存在 repo_schema_migrations。发现更高版本时拒绝降级写入；目标已有表却缺少版本信息时拒绝猜测接管。

首次初始化，在同一事务中创建结构并只读导入：

| 旧文件（相对 Agent Repo） | 导入范围 |
| --- | --- |
| .runtime/entities/entities.sqlite | 图、人员扩展、类型、幂等、快照、图审计和实体回收索引 |
| .runtime/audit/audit.sqlite | 仓库审计 |
| .runtime/recycle-bin/settings.sqlite | 设置、操作回执和清理记录，目标表增加 recycle_ 前缀 |
| .runtime/recycled-logs/logs.sqlite | 日志回收索引 |

导入固定的受支持表和字段，不执行来源数据库的建表脚本，不自动导入未知表。字段不兼容、ID 冲突、损坏或关系外键校验失败，整个初始事务回滚。保留全部原 ID、JSON、修订、采集时间、人工覆盖、审计和 pending/unknown 操作状态。复制过程不重放操作、不恢复回收站对象、不启动计划。

成功切换后只写统一库，不更新、不删除、不重复读取旧库。旧库晚到的修改不会回灌。两个进程同时初始化时由 SQLite 写锁和锁内版本复查保证只导入一次。后续实体投影迁移仍识别已有 migration-v2/recycle-v1 标记；只有更早的人员库尚未迁移时，才按原流程读取 .runtime/people/people.sqlite，避免重新导入历史人员或复活已清理资料。

## 部署、备份和回滚

1. 停止旧版本写入前，核对已接纳任务及插件后台工作；不得让新旧版本同时写不同事实库。生产迁移与部署需要另行授权。
2. 使用 SQLite backup API 为所有旧库做一致性备份，在副本中演练完整性、数量、稳定 ID、人工更正、回收站和操作回执。
3. 统一库首次初始化成功后核对 integrity_check 和 foreign_key_check，再通过原服务接口回归读取和受控写入。
4. WAL 模式下，运行中不能只复制主 sqlite 文件作备份，必须使用 SQLite backup API；不要单独丢弃 -wal/-shm 文件。
5. 回滚前先停止新版本写入，并一致性备份统一库中的新增记录。旧版只认识原独立库，不能直接回滚代码后继续使用过期旧库；必须核对切换后的新增数据并在受控流程中恢复匹配的旧库。

仓库测试使用临时目录和合成数据，不读取真实运行库。代码提交、推送和测试通过均不表示已迁移生产数据库。
