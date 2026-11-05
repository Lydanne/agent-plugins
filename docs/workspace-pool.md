# Worker 独立 clone 工作区池

## 现场保存与释放

只读任务使用 `projects/<项目>` 的登记默认分支，不申请工作区。需要写文件（包括报告、导出、临时产物、依赖安装）或切换分支时必须使用 `useWorkspace:true`；此参数不提供额外业务写入、Git 发布或部署权限。完整流程见 [项目目录策略](project-directory-policy.md)。

Worker 终止后，调度器确认原进程及子进程组退出、没有同分配续接或正在执行的结算，再独占槽位保存现场。每个仓库分别保存原 HEAD、分支、Git 暂存区和工作树；未推送 HEAD 由本地持久引用保护，未跟踪及忽略文件另存并校验。保存不会自动 commit 或 push。

私有记录位于 `workspace/workspace-checkpoints/`，绑定 Agent、项目、原 job/assignment、原槽位及路径、检查点轮次。Git 引用位于原独立克隆的 `refs/agent-workspace-checkpoints/`。文件副本和 Git 引用都不能当成已交付成果，也不能提交到角色仓库。

状态依次为 saving → saved → releasing → parked。释放前复核所有仓库与副本，若发现保存后的新改动则停止；全部清理完成后才允许槽位 idle 并重新分配。未结束 Git 操作、身份变化、保存或恢复中断保留现场，不自动覆盖。文件系统错误不能被解释为没有成果。

## 原工作区恢复

原授权的续接使用原任务及执行快照，只有对应原槽位空闲时才能独占认领。原槽位忙时报告 `waiting_original_workspace`，不能换目录恢复。恢复校验原仓库身份、保存引用、检查点轮次和分支，采用精确对象 `stash apply --index`，然后恢复额外文件。恢复成功才允许 Worker 启动，不重复映射技能范围。

恢复状态为 restoring → restored；发生冲突或中断则为 recovery_required。保存引用与文件副本保留，不使用 pop/drop。当前不提供自动解决冲突或自动删除检查点的入口。管理员必须核对实际记录阶段及现场后处理，不能删除 state.json 或把 blocked 手工改成 idle。存在检查点的会话不能删除唯一恢复索引。

多轮保存使用独立 checkpointId，旧轮次请求不能恢复新轮次。池已完成保存而调度器尚未写回回执时，重试只读取原保存结果，不重新处理已经分配给其他任务的槽位。来源撤回、取消、失败或超时的任务继续遵守既有续接边界，保存记录不创建业务授权。

底层 `releaseWorkspace` 的原发布验证接口仍保留：它仅允许干净且 HEAD 可在远端核实的工作区释放。Worker 正常结算使用上述检查点协议，不再把未发布成果长期占用池容量作为唯一处理方式。

## 配置与目录

在 Agent Repo 的 `projects.json` 对应项目中增加：

```json
"workspacePool": { "enabled": true, "maxSize": 3 }
```

maxSize 为 1–20 的整数。目录由宿主生成，不接受模型传路径或初始化命令：

- `workspace/xgj-0/`、`workspace/xgj-1/`：完整独立 Git clone，不是 Git worktree。
- `workspace/state.json`：分配、任务身份、依赖指纹及状态；`workspace/state.lock`：短时跨进程锁。
- 仅在 Agent Repo `.gitignore` 添加 `/workspace/`，不自动添加 `/worktree/`。state 文件属于本机运行状态，不提交；维护时只显式暂存任务文件。

配置格式应在支持本协议的插件部署后启用，旧版本登记解析器不认识 workspacePool。启用时确认角色和实际配置允许明确授权的 workspace 代码任务；管理员自定义的更严格执行指令不会被插件覆盖。

## 使用

```json
{
  "action": "run",
  "projectId": "xgj",
  "repository": "projects/xgj/repositories/teacher",
  "useWorkspace": true,
  "topic": "teacher-notify-fix",
  "task": "修复重复通知，补齐回归测试，提交并推送任务分支，创建 PR",
  "context": "已核实的问题与必要证据",
  "constraints": "仅修改 teacher 通知链路及相关测试；允许上述 Git 交付，不合并、不部署"
}
```

Worker cwd 为 workspace 项目根，repository 仍为原逻辑选择器；scopeDirectory 映射到独立副本中的目标子仓库。代码、测试、commit、push 和 PR 由 Worker 按所选仓库开发技能执行，Main 继续接收原任务协作及完成报告。

## 初始化与依赖

先在短锁内认领 idle 工作区或新编号，再在锁外初始化。池内 preparing、ready、held、checking、blocked 都占用容量。达到上限时 job 保持 queued，waitingReason=waiting_workspace；不占 Worker 执行槽，不创建重复任务。释放后调度器自动继续。初始化失败返回明确失败并保留目录，绝不从共享源目录执行。

源项目和 `.gitmodules` 声明的已初始化独立仓库分别 clone，wiki 保持父仓库固定的 gitlink。仅使用已准备范围及本地提交快照，不复制源目录未提交改动、node_modules、凭证文件或临时数据；已有目录不得指向源仓库或软链接。新任务在实际目标仓库创建 `codex/worker-<任务ID>` 分支，其余仓库保持固定提交。复用前必须干净、无进行中 Git 操作；已有提交须有完整 parked 检查点及保护引用证明，或可在远端确认。源项目及声明仓库需先正常初始化，缺失时明确阻塞，不猜远端或切换账号。

分支准备后，检查项目根及本次目标仓库的 package.json。首次安装；同一现场后续仅当内容哈希不同于上次成功安装时再安装。检查点保存会将忽略文件（包括 node_modules）随原任务保全并清出，槽位分配新任务时重新安装依赖；恢复原任务时恢复其保存的依赖。只有锁文件变化不触发安装。成功后记录指纹，失败不更新。各工作区 node_modules 独立，包管理器下载缓存可以共享。支持 pnpm/npm/yarn；初始化安装禁止生命周期脚本，项目确需构建脚本时由原授权下的 Worker 按技能处理。

## 恢复和释放

补充、reply、超时继续沿用原 assignmentId、owner 和工作分支；工作区绑定参与执行会话隔离，不因相同 topic 或不同模型而混用其他任务目录。恢复时验证路径、真实 Git 根、远端和任务分支；有完整检查点时等待原工作区空闲再恢复，无检查点的失效绑定拒绝执行，不在别人的目录执行。

Worker 等待 Main 或用户时保留工作区；只有终态结算才保存并释放。活动进程、未知归属、初始化失败仍阻塞，不能靠心跳过期推断进程已退出。工作区与恢复对象不得由模型自行清理。

PR 创建、CI、推送和合并沿用项目规则。检查点只证明本地成果保全，不证明上述业务交付已经完成。

## WebUI 管理

AgentRepo → 项目与技能 → 选择项目 → 点击“工作区配置”小按钮打开弹窗。管理员可启用/停用池、设置 1–20 容量、刷新占用，展开目录查看任务、分支、目标仓库、依赖安装时间及异常原因。无写权限只可查看。保存使用登记版本校验，过期页面不能覆盖新配置。停用和缩容不终止已有分配，不删除目录。

保存写入 projects.json，不自动 commit、push 或部署。界面提示待提交状态；请在维护窗口修改并按仓库流程提交同步，未提交期间新任务准备与自动同步可能暂停。单纯的池配置变化不使原任务快照失效；项目路径、远端、分支等其他登记变化仍阻止旧任务继续。状态读取不会创建或改写 state.json；读取失败显示错误，不假装空池。异常槽位只展示原因，人工核验后处理，不提供强制释放/删除按钮。

并发保护：缩容后仍将超出新编号范围的占用计入容量；释放期间调度器持久记录归属，其他实例与同分配的续执行等待其完成。远端确认使用 fetch --prune，已删除分支的过期跟踪引用不能证明已安全保存。WebUI 保存相同配置不改写登记文件；状态不可读取时在写入前失败，保留原配置。
