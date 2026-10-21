import {readFile,writeFile} from 'node:fs/promises';
import {configurationProperties} from './configuration.mjs';
import {fileURLToPath} from 'node:url';
const path=fileURLToPath(new URL('./openclaw.plugin.json',import.meta.url));
const manifest=JSON.parse(await readFile(path,'utf8'));
const labels={modelProfiles:'模型配置 / Model profiles',defaultModelId:'默认模型 ID / Default model ID',projectRouting:'项目路由模式 / Project routing mode',skillContextRoot:'技能上下文根目录 / Skill context root',thinkingLevel:'默认智慧等级 / Default thinking level',resourceKeyExample:'资源锁示例 / Resource key example',state:'任务状态目录 / Task state directory',cwd:'执行工作目录 / Execution workspace',node:'后台 Node 命令 / Worker Node command',cli:'Codex 命令 / Codex command',codexHome:'Codex 用户目录 / Codex home',pathPrefix:'执行 PATH 前缀 / Execution PATH prefix',approvalMode:'执行沙箱策略 / Execution sandbox policy',timeoutMs:'任务执行上限（毫秒） / Execution timeout (ms)',skillsEnabled:'启用技能版本刷新 / Enable skill version refresh',skillDirectories:'技能目录 / Skill directories',executorInstructions:'执行器职责规则 / Executor instructions',businessDataPolicy:'业务数据展示规则 / Business data policy',asyncInstructions:'异步委派提示 / Async delegation instructions',delegationInstructions:'委派工具提示 / Delegation tool instructions',memoryRequired:'强制记忆交接 / Require memory handoff',reportDirectory:'报告相对目录 / Relative report directory'};
const help={modelProfiles:'使用原生“添加条目”，以唯一模型 ID（例如 quick、deep）添加多个配置。新条目默认停用；确认模型名和参数后启用。新任务只能选择已启用模型；没有启用项时不能提交新任务。已受理任务保留原配置。 / Add a unique model ID, configure the model, then enable it.',defaultModelId:'填写模型配置项的 ID。留空或该模型未启用时，使用第一项已启用模型；没有启用项时不能提交新任务。 / Select an enabled model ID; otherwise use the first enabled entry ; no enabled entry means new tasks are unavailable.',node:'默认从宿主 PATH 查找 node，可显式设置绝对路径。 / Looks up node on the host PATH by default.',cli:'默认从宿主 PATH 查找 codex；支持 ~/ 前缀。 / Looks up codex on the host PATH; ~/ paths are expanded at runtime.',codexHome:'默认 ~/.codex；~/ 在运行时展开，不写入发布清单。 / Defaults to ~/.codex; home paths expand only at runtime.',pathPrefix:'默认为空并继承宿主 PATH；每段 ~/ 前缀会展开。 / Empty by default to inherit host PATH; each ~/ prefix is expanded.',projectRouting:'auto 按可信 Agent 使用 Agent Repo API；agent-repo 强制依赖服务；legacy 使用原有固定目录。已有 Agent Repo 绑定但服务缺失时不回退。 / Auto discovers the Agent-bound API; agent-repo requires it; legacy preserves fixed workspace configuration.',skillContextRoot:'新版 Agent Repo API 自动确定角色根和项目 cwd；此字段仅供旧 provider 兼容及独立部署使用。 / The Agent Repo API resolves root and cwd; this setting remains for legacy providers and standalone deployments.',thinkingLevel:'0 使用所选模型默认推理参数；1–6 映射 minimal、low、medium、high、xhigh、max，具体值可在每个模型中覆盖。等级变化不创建新会话。 / 0 uses model defaults; 1–6 map minimal through max.',state:'默认 ~/.openclaw/codex-query-sessions；修改目录会切换任务存储；旧任务不会自动搬迁。 / Changing this path selects another store; old jobs are not moved.',cwd:'默认 ~/.openclaw/workspace，支持 ~/ 前缀；修改执行策略会在下次真实 run 创建新会话，保留旧 ID。 / Execution-policy changes migrate on the next real run and retain old IDs.',approvalMode:'默认保留原有无沙箱、无审批模式。可改为 read-only 或 workspace-write；技能刷新始终只读。 / Defaults to existing full access; refresh turns always remain read-only.',skillsEnabled:'Agent Repo 模式使用当前项目的技能快照；独立模式使用匹配的版本发布端。 / Agent Repo mode uses scoped snapshots; standalone mode requires a matching version publisher.',executorInstructions:'完整替换执行职责提示，默认是按任务授权执行的规则；已有任务保留受理时的配置。 / Replaces executor duties; admitted jobs retain their configuration.',businessDataPolicy:'完整替换业务数据展示规则，默认保留当前任务所需的原值展示。 / Replaces data policy; defaults preserve task-scoped business fields.',memoryRequired:'关闭后允许不提供 memory；来源验证和取消权限仍有效。 / Disable to permit missing memory; source and cancellation checks still apply.',reportDirectory:'相对 cwd，不允许绝对路径及 ..；每个 job 创建独立子目录。 / Relative to cwd; each job gets an isolated subdirectory.'};
for(const [key,property] of Object.entries(configurationProperties)){
 const schema={...property,description:labels[key]};
 manifest.configSchema.properties[key]=schema;
 manifest.uiHints[key]={label:labels[key],help:help[key]??'未配置时保留当前行为。 / Unset values preserve existing behavior.'};
}
const modelHints={
 enabled:{label:'启用模型 / Enable model',help:'新条目默认停用。确认模型名及账号支持的参数后启用；停用后不供新任务选择。 / New entries start disabled; enable after checking model support.'},
 name:{label:'显示名称 / Display name',placeholder:'例如 常规查询、复杂分析'},
 description:{label:'适用任务 / Intended tasks',help:'帮助 Main 按任务选择模型。 / Describe which tasks fit this model.'},
 harness:{label:'执行器 / Harness',help:'当前支持 Codex。 / Currently supports Codex.'},
 model:{label:'模型标识 / Model name',help:'填写当前 CLI 和账号实际可用的模型名；此项必填。 / Required; must be supported by the CLI.',placeholder:'例如 gpt-6.1-sol'},
 cli:{label:'CLI 命令 / CLI command',help:'留空继承全局 Codex 命令；支持绝对路径或 PATH 中的命令。 / Optional override; otherwise inherit the global CLI.',advanced:true},
 reasoningEffort:{label:'默认推理强度 / Default effort',help:'智慧等级 0 使用此值；默认 low。 / Level 0 uses this value, defaulting to low.'},
 speed:{label:'默认速度 / Default speed',help:'未设置时沿用 CLI 默认速度。 / Optional CLI speed override.'},
 thinkingProfiles:{label:'智慧等级参数覆盖 / Thinking-level overrides',help:'0 使用模型默认参数，1–6 对应 minimal、low、medium、high、xhigh、max。只覆盖参数，不切换模型。 / Override effort and speed per level.',advanced:true},
};
for(const [key,hint]of Object.entries(modelHints))manifest.uiHints['modelProfiles.*.'+key]=hint;
for(const key of Object.keys(manifest.uiHints))if(key.startsWith('models.*.'))delete manifest.uiHints[key];
for(let level=0;level<=6;level++){
 manifest.uiHints['modelProfiles.*.thinkingProfiles.'+level]={label:'等级 '+level+' / Level '+level};
 manifest.uiHints['modelProfiles.*.thinkingProfiles.'+level+'.reasoningEffort']={label:'推理强度 / Reasoning effort'};
 manifest.uiHints['modelProfiles.*.thinkingProfiles.'+level+'.speed']={label:'速度 / Speed'};
}
for(const key of ['models','model','reasoningEffort','historyEnabled','historyLimit','historyTimeoutMs','larkCli','openclawHome','larkPathPrefix']){delete manifest.configSchema.properties[key];delete manifest.uiHints[key];}
manifest.contracts.tools=manifest.contracts.tools.filter(name=>name!=='feishu_group_history');
manifest.contracts.tools=manifest.contracts.tools.map(name=>name==='codex_query'?'agent_worker':name);
manifest.id='agent-worker';
manifest.name='本地智能体执行器 / Local agent worker';
manifest.description='按 harness + 模型配置执行器，为每次任务选择模型和 0–6 智慧等级。 / Agent worker with model selection and per-task thinking levels 0–6.';
await writeFile(path,JSON.stringify(manifest,null,2)+'\n');
