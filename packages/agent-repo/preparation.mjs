import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
import {containedPath,readProjects,inspectProject} from './repositories.mjs';
import {resolveSync} from './configuration.mjs';

export async function migrationPreparation({config,agentId,repo,defaultProject}) {
 const projects=await readProjects(repo),ids=Object.keys(projects);
 const projectId=defaultProject??(ids.length===1?ids[0]:undefined);
 if(!projectId||!Object.hasOwn(projects,projectId))throw Error('Migration requires one selected project');
 // Full policy migration still configures a single global worker execution root.
 const agents=config.agents?.list;
 if(agents!==undefined&&(!Array.isArray(agents)||agents.length!==1||agents[0].id!==agentId))throw Error('Migration preparation currently supports one configured Agent');
 if(agents===undefined&&agentId!=='main')throw Error('Implicit Agent must be main');
 const bound=config.plugins?.entries?.['agent-repo']?.config?.agents??{};
 if(Object.keys(bound).some(id=>id!==agentId))throw Error('Shared worker migration requires a single Agent binding');
 const file=await containedPath(repo,'tools/agent-worker-policy.json'),stat=await lstat(file);
 if(!stat.isFile()||stat.size>256*1024)throw Error('Worker policy must be a bounded ordinary file');
 const policy=JSON.parse(await readFile(file,'utf8'));
 const keys=['executorInstructions','businessDataPolicy','asyncInstructions','delegationInstructions'];
 if(!policy||typeof policy!=='object'||Array.isArray(policy)||policy.schemaVersion!==1||Object.keys(policy).some(key=>!['schemaVersion',...keys].includes(key))||keys.some(key=>typeof policy[key]!=='string'||!policy[key].trim()||policy[key].length>40000))throw Error('Invalid Agent-owned worker policy');
 const project=projects[projectId],cwd=project.paths.repository;
 const directories=['skills',...project.skills];
 const oldWorkspace=agents?.[0]?.workspace??config.agents?.defaults?.workspace;
 const extra=config.skills?.load?.extraDirs??[];
 if(!Array.isArray(extra)||extra.some(x=>typeof x!=='string'))throw Error('Invalid existing extra skill directories');
 const preparation=await syncPreparation({config,agentId,repo,requireWorkspaceMatch:false});
 const blockers=preparation.blockers;
 blockers.push(...await projectBlockers(project,repo));
 const execution=Object.fromEntries(keys.map(key=>[key,policy[key].replaceAll('{projectDir}',cwd)]));
 return {patch:{agents:agents?{list:agents.map(agent=>({...agent,workspace:repo}))}:{defaults:{workspace:repo}},
  plugins:{entries:{...preparation.patch.plugins.entries,'agent-worker':{config:{cwd,skillContextRoot:repo,skillDirectories:directories,...execution}}}},
  skills:{load:{extraDirs:[...new Set([...extra.filter(path=>(!oldWorkspace||path!==join(oldWorkspace,'.agents/skills'))&&path!==join(repo,'projects')&&!Object.values(projects).some(entry=>path===entry.paths.repository||path.startsWith(entry.paths.repository+'/')))])]}},
  channels:preparation.patch.channels},blockers:[...new Set(blockers)],
  warnings:['仅输出迁移计划；保留执行状态目录、账号、凭证及旧任务，不应用配置。','角色政策来自 tools/agent-worker-policy.json；更改政策后须重新生成并应用计划，已受理任务保留原快照。','工作区记忆由 OpenClaw 原生机制维护；本计划不搬迁记忆、原始会话或数据库。','启用 agent-repo 原生调度前同步并停用旧 Feishu 同步。单项目入站同步项目，多项目入站仅同步角色根；选定项目后同步当前项目，defaultProject 不参与入站自动选择。' ]};
}

function requireFeishu(config) {
 const channel=config.channels?.feishu;
 if(!channel||typeof channel!=='object'||Array.isArray(channel))throw Error('Synchronization preparation requires existing Feishu configuration');
 if(channel.accounts!==undefined&&(channel.accounts===null||typeof channel.accounts!=='object'||Array.isArray(channel.accounts)))throw Error('Invalid existing Feishu accounts');
 if(Object.values(channel.accounts??{}).some(account=>account&&Object.hasOwn(account,'workspaceSync')))throw Error('Account-specific synchronization must be reviewed separately');
 const legacy=channel.workspaceSync;
 if(legacy!==undefined&&(!legacy||typeof legacy!=='object'||Array.isArray(legacy)))throw Error('Invalid existing Feishu synchronization');
 return legacy;
}
async function rootBlockers(repo,sync) {
 const blockers=[];
 try {
  const gitOutput=async args=>(await exec('git',['-c','core.fsmonitor=false',...args],{cwd:repo,timeout:5000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}})).stdout;
  const git=async args=>(await gitOutput(args)).trim();
  if(!/^100(?:644|755) blob [a-f0-9]+\tprojects\.json$/.test(await git(['ls-tree','HEAD','--','projects.json']))||await realpath(join(repo,'projects.json'))!==resolve(repo,'projects.json'))blockers.push('Agent Repo registration must be a committed ordinary file without symlinks');
  if(await realpath(repo)!==resolve(repo))blockers.push('Agent Repo must use its canonical path without symlinks');
  if(await realpath(await git(['rev-parse','--show-toplevel']))!==await realpath(repo)||await git(['rev-parse','--show-superproject-working-tree']))blockers.push('Agent Repo must be an independent Git root');
  const changes=(await gitOutput(['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all'])).split('\0').filter(Boolean);
  let blockedChanges=false;
  for(const change of changes) {
   const path=change.slice(3),allowed=sync.preserveLocalMemory&&[' M','??'].includes(change.slice(0,2))&&/^(?:MEMORY\.md|memory\/\d{4}-\d{2}-\d{2}\.md)$/.test(path);
   if(!allowed){blockedChanges=true;break;}
   try {
    const file=resolve(repo,path);
    if(!(await lstat(file)).isFile()||await realpath(file)!==file){blockedChanges=true;break;}
   }catch{blockedChanges=true;break;}
  }
  if(blockedChanges)blockers.push('Agent Repo contains local changes outside the unstaged native-memory allowance; review and deliver intended files before activation');
  if(await git(['branch','--show-current'])!==sync.branch)blockers.push('Agent Repo must be on '+sync.branch);
  const upstream=await git(['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}']);
  const [ahead,behind]=(await git(['rev-list','--left-right','--count','HEAD...@{upstream}'])).split(/\s+/).map(Number);
  if(upstream!==sync.remote+'/'+sync.branch||ahead!==0||behind!==0)blockers.push('Agent Repo must match its fetched '+sync.remote+'/'+sync.branch+' upstream; review ahead/behind or incorrect tracking before activation');
 }catch{blockers.push('Agent Repo Git state or fetched upstream cannot be verified');}
 return blockers;
}
async function projectBlockers(project,repo) {
 if(project.paths.repository!==resolve(repo,project.repository))return ['Project Repo must use its registered canonical path without symlinks'];
 const status=await inspectProject(project),blockers=[];
 if(status.git.state!=='available'||!status.git.remoteMatches||!status.git.branchMatches||status.git.dirty)blockers.push('Project Repo must be an independent clean repository on its registered branch and remote');
 if(status.git.state==='available'&&(!status.git.upstream||status.git.upstream!=='origin/'+project.branch||status.git.ahead!==0||status.git.behind!==0))blockers.push('Project Repo must match its fetched registered upstream; review ahead/behind or missing tracking before activation');
 try {
  const instructionsPath=join(project.paths.repository,'AGENTS.md');
  const instructionsStat=await lstat(instructionsPath);
  if(!instructionsStat.isFile()||instructionsStat.size>256*1024)throw Error('Invalid Project instructions');
  const instructions=await readFile(instructionsPath,'utf8');
  if(/ada_memory|codex_query|客服执行工具|Agent Worker 后台任务/.test(instructions))blockers.push('Project Repo still contains legacy Ada tool or role instructions; complete role separation before activation');
 }catch(error){if(error.code!=='ENOENT')throw error;}
 if(project.knowledge&&!status.knowledge?.available)blockers.push('Project knowledge directory is not prepared');
 if(project.knowledge===project.repository+'/wiki') {
  try{const wiki=await lstat(join(project.paths.repository,'wiki','.git'));if(!wiki.isFile()&&!wiki.isDirectory())throw Error();}catch{blockers.push('wiki submodule is not initialized');}
 }
 return blockers;
}
export async function syncPreparation({config,agentId,repo,requireWorkspaceMatch=true,pluginPath}) {
 const legacy=requireFeishu(config),projects=await readProjects(repo),ids=Object.keys(projects);
 const existing=config.plugins?.entries?.['agent-repo']?.config?.agents?.[agentId]??{};
 const sync=resolveSync({...existing.sync,enabled:true});
 const blockers=await rootBlockers(repo,sync);
 const hooks=config.plugins?.entries?.['agent-repo']?.hooks??{};
 if(hooks.allowPromptInjection===false)blockers.push('Agent Repo prompt injection hooks are explicitly denied; review permission before activation');
 if(hooks.allowConversationAccess===false)blockers.push('Agent Repo conversation hooks are explicitly denied; review permission before activation');
 if(existing.sync?.enabled===true&&legacy?.enabled===true)blockers.push('Legacy Feishu and Agent Repo synchronization are both enabled; disable duplicate synchronization before activation');
 if(requireWorkspaceMatch) {
  const plugins=config.plugins??{},entry=plugins.entries?.['agent-repo'];
  if(plugins.enabled===false||entry?.enabled!==true)blockers.push('Agent Repo plugin must already be enabled before synchronization-only preparation');
  if(!Object.hasOwn(entry?.config?.agents??{},agentId))blockers.push('Agent Repo binding must already exist before synchronization-only preparation');
  const paths=plugins.load?.paths??[];
  if(!Array.isArray(paths)||paths.some(path=>typeof path!=='string'))throw Error('Invalid existing plugin load paths');
  const installed=plugins.installs?.['agent-repo'];
  const loadRegistered=Boolean(installed&&typeof installed==='object'&&!Array.isArray(installed))||Boolean(pluginPath&&paths.some(path=>resolve(path)===resolve(pluginPath)));
  if(!loadRegistered)blockers.push('Agent Repo plugin loading must already be registered before synchronization-only preparation');
  for(const key of ['allow','deny'])if(plugins[key]!==undefined&&(!Array.isArray(plugins[key])||plugins[key].some(id=>typeof id!=='string')))throw Error('Invalid existing plugin '+key+' list');
  if(plugins.deny?.includes('agent-repo')||plugins.allow!==undefined&&!plugins.allow.includes('agent-repo'))blockers.push('Agent Repo plugin is denied or excluded by the existing plugin allowlist');
  const list=config.agents?.list;
  if(list!==undefined&&!Array.isArray(list))throw Error('Invalid existing Agent list');
  const matches=list?.filter(agent=>agent.id===agentId)??[];
  if(matches.length>1)throw Error('Ambiguous existing Agent workspace');
  const workspace=matches[0]?.workspace??(matches.length===1||list===undefined&&agentId==='main'?config.agents?.defaults?.workspace:undefined);
  let matchesRoot=false;
  try{matchesRoot=typeof workspace==='string'&&await realpath(resolve(workspace))===await realpath(repo);}catch{}
  if(!matchesRoot)blockers.push('Agent Repo must match the current host workspace before synchronization activation');
 }
 // No defaultProject fallback: only a sole registered project is prepared at inbound dispatch.
 if(ids.length===1)blockers.push(...await projectBlockers(projects[ids[0]],repo));
 return {patch:{plugins:{entries:{'agent-repo':{hooks:{...hooks,allowConversationAccess:hooks.allowConversationAccess!==false},config:{agents:{[agentId]:{...existing,repo,sync}}}}}},channels:{feishu:{workspaceSync:{...legacy,enabled:false}}}},blockers:[...new Set(blockers)],
  warnings:['仅规划原生同步迁移，不修改 workspace、worker 政策或技能全局目录；缺少原生会话钩子授权时规划开启，显式拒绝时保留并阻止激活；不应用配置、不 fetch、不重启。','保留旧 Feishu 同步字段用于回退；两个同步实现不得同时启用。','单项目同步登记项目；多项目只同步 Agent Repo，明确选择后同步当前项目、登记的 wiki 及 repositories 下声明的直接业务子模块。ready 仅证明本地已获取引用的只读预检通过。']};
}
