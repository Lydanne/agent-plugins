import {migrationPreparation,syncPreparation} from './preparation.mjs';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveConfiguration,idPattern} from './configuration.mjs';
import {readProjects,agentSummary,inspectProject} from './repositories.mjs';
export async function buildConfigPlan({config={},agentId,repo,defaultProject,activateWorkspace=false,prepareMigration=false,prepareSync=false,installed=false,pluginPath=dirname(fileURLToPath(import.meta.url))}) {
 if(typeof agentId!=='string'||!idPattern.test(agentId))throw Error('Explicit agentId is required');
 if(prepareSync&&(prepareMigration||activateWorkspace||defaultProject!==undefined))throw Error('Synchronization-only plan cannot also change workspace, migration policy or default project');
 const existingBinding=config.plugins?.entries?.['agent-repo']?.config?.agents?.[agentId]??{};
 const binding=resolveConfiguration({agents:{[agentId]:{...existingBinding,repo,...(defaultProject?{defaultProject}:{})}}}).agents[agentId];
 const agent=await agentSummary(binding.repo),projects=await readProjects(binding.repo);
 if(!agent.roles['SOUL.md']||!agent.roles['AGENTS.md'])throw Error('Agent Repo requires SOUL.md and AGENTS.md');
 if(defaultProject&&!Object.hasOwn(projects,defaultProject))throw Error('Default project is not registered');
 resolveConfiguration({agents:{...config.plugins?.entries?.['agent-repo']?.config?.agents,[agentId]:binding}});
 if(prepareSync) {
  const preparation=await syncPreparation({config,agentId,repo:binding.repo,pluginPath:resolve(pluginPath)});
  return {agentId,agent,projects:Object.keys(projects),...preparation,ready:preparation.blockers.length===0};
 }
 const paths=config.plugins?.load?.paths??[];
 if(!Array.isArray(paths)||paths.some(path=>typeof path!=='string'))throw Error('Invalid existing plugin load paths');
 const useInstalled=installed||Boolean(config.plugins?.installs?.['agent-repo']?.installPath);
 const patch={plugins:{...(!useInstalled?{load:{paths:[...new Set([...paths,resolve(pluginPath)])]}}:{}),entries:{'agent-repo':{enabled:true,hooks:{...config.plugins?.entries?.['agent-repo']?.hooks,allowConversationAccess:true},config:{agents:{[agentId]:binding}}}}}};
 if(config.plugins?.allow!==undefined) {
  if(!Array.isArray(config.plugins.allow))throw Error('Invalid existing plugin allowlist');
  patch.plugins.allow=[...new Set([...config.plugins.allow,'agent-repo'])];
 }
 const warnings=['这是配置差异计划，不会写配置、克隆项目、切换 workspace 或重启 Gateway。','项目检查不刷新远端；工作区记忆不是聊天隔离边界。','计划为 agent-repo 开启宿主提示词钩子权限，用于向绑定 Agent 注入所选项目的技能索引；请核对插件来源。','Worker auto/agent-repo 路由通过绑定项目 API 选择执行目录；legacy 模式仍使用固定 cwd。'];
 if(config.tools?.allow!==undefined) {
  if(!Array.isArray(config.tools.allow))throw Error('Invalid existing tool allowlist');
  patch.tools={allow:[...new Set([...config.tools.allow,'agent_repo'])]};
 }else warnings.push('未创建全局 tools.allow；请管理员结合现有工具权限核对 agent_repo 可用性。');
 if(activateWorkspace&&!prepareMigration) {
  if(Array.isArray(config.agents?.list)) {
   const list=structuredClone(config.agents.list);
   const matches=list.filter(entry=>entry.id===agentId);
   if(matches.length!==1)throw Error('Workspace plan requires exactly one existing matching Agent');
   matches[0].workspace=agent.repo;
   patch.agents={list};
  } else if(config.agents?.entries&&typeof config.agents.entries==='object'&&!Array.isArray(config.agents.entries)&&Object.hasOwn(config.agents.entries,agentId)) {
   patch.agents={entries:{[agentId]:{...structuredClone(config.agents.entries[agentId]),workspace:agent.repo}}};
  } else throw Error('Workspace plan requires an existing explicit agents.list or agents.entries binding');
  warnings.push('应用此计划将改变该 Agent 的 workspace；需另行验收角色、技能、原生记忆、后台执行目录及 Feishu 同步配置。');
 }
 let blockers=[];
 if(prepareMigration) {
  const preparation=await migrationPreparation({config,agentId,repo:binding.repo,defaultProject});
  patch.agents=preparation.patch.agents;patch.skills=preparation.patch.skills;patch.channels=preparation.patch.channels;
  Object.assign(patch.plugins.entries,preparation.patch.plugins.entries);
  patch.plugins.entries['agent-repo']={...patch.plugins.entries['agent-repo'],enabled:true,hooks:preparation.patch.plugins.entries['agent-repo'].hooks,config:{agents:{[agentId]:{...binding,...preparation.patch.plugins.entries['agent-repo'].config.agents[agentId],...(defaultProject?{defaultProject}:{})}}}};
  warnings.push(...preparation.warnings);blockers=preparation.blockers;
 }
 return {agentId,agent,projects:Object.keys(projects),patch,warnings,...(prepareMigration?{blockers,ready:blockers.length===0}:{})};
}
export async function main(args=process.argv.slice(2)) {
 if(!args.length||args.includes('--help'))return {usage:'node cli.mjs inspect --repo /absolute/ada-agent | plan --agent-id main --repo /absolute/ada-agent --config /absolute/openclaw.json [--default-project demo] [--activate-workspace] [--installed] [--prepare-migration | --prepare-sync]',behavior:'只读检查或输出 OpenClaw config patch 计划；不应用配置、不重启、不拉取。'};
 const [action,...rest]=args,options={};
 for(let i=0;i<rest.length;i++) {
  const key=rest[i];
  if(key==='--installed'){options.installed=true;continue;}
  if(key==='--prepare-sync'){options.prepareSync=true;continue;}
  if(key==='--prepare-migration'){options.prepareMigration=true;continue;}
  if(key==='--activate-workspace'){options.activateWorkspace=true;continue;}
  if(!['--agent-id','--repo','--config','--default-project'].includes(key)||!rest[i+1]||rest[i+1].startsWith('--')||Object.hasOwn(options,key))throw Error('Invalid CLI arguments');
  options[key]=rest[++i];
 }
 if(!options['--repo'])throw Error('Explicit --repo is required');
 if(action==='inspect')return {agent:await agentSummary(options['--repo']),projects:await Promise.all(Object.values(await readProjects(options['--repo'])).map(inspectProject))};
 if(action!=='plan'||!options['--config'])throw Error('plan requires explicit --config');
 const config=JSON.parse(await readFile(options['--config'],'utf8'));
 const plan=await buildConfigPlan({config,agentId:options['--agent-id'],repo:options['--repo'],defaultProject:options['--default-project'],activateWorkspace:options.activateWorkspace,prepareMigration:options.prepareMigration,prepareSync:options.prepareSync,installed:options.installed});
 // Output only the patch as an object suitable for OpenClaw's official config patch --file.
 return plan;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 main().then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(()=>{process.stderr.write('Agent Repo command failed: check arguments, repo registration and readable JSON config.\n');process.exitCode=1;});
}
