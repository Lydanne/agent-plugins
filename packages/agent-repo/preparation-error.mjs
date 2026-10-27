// Diagnostics are deliberately allowlisted: never expose arbitrary Git stderr,
// URLs, credentials, prompt text, or an exception stack in channel replies.
const reasons=[
 ['Prompt preparation is still pending','PROMPT_PENDING','本轮提示词准备尚未完成，不能沿用之前的快照。'],
 ['Prompt preparation superseded','PROMPT_SUPERSEDED','该准备步骤已被更新的提示词准备替代。'],
 ['No version captured by this run prompt hook','SNAPSHOT_MISSING','本轮未生成仓库技能快照，请检查提示词准备钩子是否执行。'],
 ['This runner does not expose a model run identity','RUN_ID_MISSING','宿主未提供本轮 runId，无法绑定仓库技能快照。'],
 ['prompt hook invocation is no longer active','PROMPT_EXPIRED','提示词准备已超时或失效，本轮快照未发布。'],
 ['Repository version changed after prompt preparation','REPOSITORY_CHANGED','提示词准备后仓库提交发生变化，请在维护完成后重新发起请求。'],
 ['Role or skill files changed after prompt preparation','ROLE_FILES_CHANGED','提示词准备后角色或技能文件发生修改，不能使用过期快照。'],
 ['Agent role changed during this run','ROLE_VERSION_CHANGED','同一轮准备期间角色仓库版本发生变化。'],
 ['Agent role files must be committed before loading','ROLE_UNCOMMITTED','角色文件尚未提交，请保留现场并完成维护后再请求。'],
 ['Repository instructions must be committed before loading','INSTRUCTIONS_UNCOMMITTED','仓库规则文件尚未提交。'],
 ['Skill files must be committed before loading:','SKILLS_UNCOMMITTED','技能文件尚未提交。'],
 ['Prompt preparation failed','PROMPT_FAILED','提示词准备失败，未取得有效仓库快照。'],
 ['Prompt workspace is missing','WORKSPACE_MISSING','宿主未提供提示词工作区。'],
 ['Prompt workspace is outside registered scope','WORKSPACE_OUTSIDE_SCOPE','提示词工作区不在当前 Agent 已登记范围内。'],
 ['Invalid skill frontmatter:','SKILL_METADATA_INVALID','技能文件的元数据格式不合法。'],
 ['Duplicate skill name','SKILL_NAME_DUPLICATE','同一技能范围存在重复名称。'],
 ['Selected repository is not initialized at its own Git root','REPOSITORY_NOT_INITIALIZED','所选仓库尚未初始化为独立 Git 根目录。'],
];
export function preparationDiagnostic(error){
 if(error?.preparationDiagnostic)return error.preparationDiagnostic;
 const text=typeof error?.message==='string'?error.message:'';
 const matched=reasons.find(([message])=>text.startsWith(message));
 if(matched)return {code:'AGENT_REPO_'+matched[1],cause:matched[2]};
 if(error?.name==='RepositoryGitCheckError')return {code:'AGENT_REPO_GIT_'+(error.kind==='timeout'?'TIMEOUT':'OUTPUT_LIMIT'),cause:error.kind==='timeout'?'本地 Git 状态检查超时，本轮未提交，请核对机器负载后重试。':'本地 Git 检查输出超过索引预算，本轮未提交，请管理员核对目录规模。'};
 if(error?.code==='ENOENT')return {code:'AGENT_REPO_PATH_MISSING',cause:'仓库或技能所需路径不存在。'};
 if(error?.code==='EACCES'||error?.code==='EPERM')return {code:'AGENT_REPO_ACCESS_DENIED',cause:'仓库或技能文件访问被拒绝。'};
 if(error?.constructor?.name==='PreparationError')return {code:'AGENT_REPO_PREPARATION_REJECTED',cause:text.replace(/https?:\/\/\S+/g,'[URL omitted]').slice(0,500)};
 return {code:'AGENT_REPO_PREPARATION_UNKNOWN',cause:'仓库准备发生未分类异常，需管理员核对本轮诊断记录。',errorType:/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.name??'')?error.name:'Error'};
}
export function diagnosticError(diagnostic){const error=new Error('Prompt preparation failed');error.preparationDiagnostic=diagnostic;return error;}

// Interpret Git stderr locally; only return fixed descriptions, never raw output.
export function gitSyncDiagnostic(error) {
 const stderr=typeof error?.stderr==='string'?error.stderr:'';
 const cases=[
  [/permission denied|authentication failed|could not read username|has no .*permission/i,'AUTH_FAILED','Git 认证或仓库权限检查失败。'],
  [/host key verification failed|remote host identification has changed/i,'HOST_KEY_FAILED','SSH 主机身份校验失败，需管理员核对主机密钥。'],
  [/could not resolve host|could not resolve hostname|name or service not known/i,'DNS_FAILED','Git 远端域名解析失败。'],
  [/connection timed out|operation timed out|connection timeout/i,'CONNECT_TIMEOUT','连接 Git 远端超时。'],
  [/connection reset|connection refused|connection closed|network is unreachable|early EOF|remote end hung up|SSL_connect/i,'NETWORK_FAILED','Git 连接中断或远端不可达。'],
  [/cannot lock ref|unable to create .*lock|another git process|is at .* but expected/i,'LOCK_CONFLICT','Git 引用或锁发生冲突，可能有另一同步进程；现场已保留。'],
  [/couldn.t find remote ref/i,'REMOTE_REF_MISSING','远端目标分支不存在。'],
  [/repository .*not found|does not appear to be a git repository/i,'REMOTE_UNAVAILABLE','远端仓库不存在或不可访问。'],
  [/no space left on device/i,'DISK_FULL','Git 写入失败：磁盘空间不足。'],
 ];
 const match=cases.find(([pattern])=>pattern.test(stderr));
 const exitCode=Number.isInteger(error?.code)?error.code:undefined;
 return {code:'AGENT_REPO_GIT_'+(match?.[1]??'COMMAND_FAILED'),cause:match?.[2]??`Git 命令失败${exitCode!==undefined?`（退出码 ${exitCode}）`:''}，未匹配已知错误类型。`};
}
