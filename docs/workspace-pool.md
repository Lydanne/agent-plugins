# Worker 独立 clone 工作区池

## 释放失败与安全复检

任务结束不等于工作区释放。释放逐仓核对身份、未提交内容、进行中的 Git 操作和实际远端分支覆盖；fetch 不递归子模块，因为每个登记仓库会单独检查。检查失败时保留现场，不 reset、stash、强推或删除文件。

失败记录 `releaseFailure.repository/stage/code/retryable/checkedAt`，不保存可能携带凭据的 Git stderr 或完整命令。只有确认 idle 才写 `workspaceSettled=true`；blocked 仍占容量，但从 30 秒起指数退避、最多每 5 分钟重新检查，通过后释放并继续原排队任务。未提交、未推送和未结束 Git 操作不会因重试而被自动清理。身份核验异常按 5 分钟间隔重试，不绕过 assignment 和进程存活检查。

兼容旧的 `workspaceSettled=true, workspaceRelease=blocked` 记录，仅复检释放状态，不重放业务。旧通用释放错误可复检；初始化失败的 blocked 不因此变成可复用。仍有活动进程、同分配的续接任务或另一释放操作时不释放。

`agent_worker action=run` 可选 `useWorkspace: true`。省略或 false 保持原执行流程；true 必须选择已启用池的项目，不允许回退共享源目录。它选择执行环境，不提供额外业务、Git 发布或合并授权。代码任务仍须在 task/constraints 中明确允许，并遵守项目与 Agent 的角色约束。

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

源项目和 `.gitmodules` 声明的已初始化独立仓库分别 clone，wiki 保持父仓库固定的 gitlink。仅使用已准备范围及本地提交快照，不复制源目录未提交改动、node_modules、凭证文件或临时数据；已有目录不得指向源仓库或软链接。新任务在实际目标仓库创建 `codex/worker-<任务ID>` 分支，其余仓库保持固定提交。复用前必须干净、无进行中 Git 操作且已有提交可在远端确认。源项目及声明仓库需先正常初始化，缺失时明确阻塞，不猜远端或切换账号。

分支准备后，检查项目根及本次目标仓库的 package.json。首次安装；后续仅当内容哈希不同于上次成功安装时再安装。只有锁文件变化不触发安装。成功后记录指纹，失败不更新。各工作区 node_modules 独立，包管理器下载缓存可以共享。支持 pnpm/npm/yarn；初始化安装禁止生命周期脚本，项目确需构建脚本时由原授权下的 Worker 按技能处理。

## 恢复和释放

补充、reply、超时继续沿用原 assignmentId、owner 和工作分支；工作区绑定参与执行会话隔离，不因相同 topic 或不同模型而混用其他任务目录。恢复时验证路径、真实 Git 根、远端和任务分支；原工作区已被重新分配时明确拒绝旧会话恢复，不在别人的目录执行。

Worker 等待 Main 或用户时保留工作区。任务终止后，调度器确认原进程及执行子进程组消失，再检查全部仓库的文件、Git 操作和远端提交；干净且提交已安全推送才释放为 idle，保留远端分支与 PR。未提交、未推送或无法核实均 blocked。会话删除也等待工作区安全释放。占用期间不会自动 reset、stash、clean 或删除目录。

进程心跳过期不代表退出；状态文件损坏、锁归属不明、初始化进程消失时保留现场。准备阶段中断后标记 blocked，不自动重放安装。管理员应核对保存目录、进程和 Git 状态后处理失败槽位，不能直接删 state.json 清空池。初版不提供自动清理 blocked 工作区的工具。

PR 创建和实际远端 CI 仍由 Worker 的项目流程负责；池释放检查证明提交已在远端保存，不等同于 PR 已通过门禁或已合并。报告必须分别列出提交、push、PR、测试和未完成项。迟到补充若遇到工作区已重新分配，保留失败结果；需要继续开发时提交新的授权任务并交接原分支/PR，不假装已恢复旧 CLI 会话。

## WebUI 管理

AgentRepo → 项目与技能 → 选择项目 → 代码工作区池。管理员可启用/停用池、设置 1–20 容量、刷新占用，展开目录查看任务、分支、目标仓库、依赖安装时间及异常原因。无写权限只可查看。保存使用登记版本校验，过期页面不能覆盖新配置。停用和缩容不终止已有分配，不删除目录。

保存写入 projects.json，不自动 commit、push 或部署。界面提示待提交状态；请在维护窗口修改并按仓库流程提交同步，未提交期间新任务准备与自动同步可能暂停。单纯的池配置变化不使原任务快照失效；项目路径、远端、分支等其他登记变化仍阻止旧任务继续。状态读取不会创建或改写 state.json；读取失败显示错误，不假装空池。异常槽位只展示原因，人工核验后处理，不提供强制释放/删除按钮。

并发保护：缩容后仍将超出新编号范围的占用计入容量；释放期间调度器持久记录归属，其他实例与同分配的续执行等待其完成。远端确认使用 fetch --prune，已删除分支的过期跟踪引用不能证明已安全保存。WebUI 保存相同配置不改写登记文件；状态不可读取时在写入前失败，保留原配置。
