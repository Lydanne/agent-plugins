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
