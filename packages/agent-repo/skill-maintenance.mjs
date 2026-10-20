import {readFile,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {workerSkillName} from './worker-skill.mjs';
import {getAgentRepoService} from './dist/agent-repo-api.mjs';
import {maintenanceContext,maintenanceRevision,MaintenanceError,createMaintenanceOperations} from './dist/maintenance-api.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function createSkillMaintenance(getConfig){
 const operations=new Map();
 function location(agentId){const raw=getConfig().plugins?.entries?.['agent-worker']?.config?.codexHome??'~/.codex';if(typeof raw!=='string'||!raw.startsWith('/')&&!raw.startsWith('~/'))throw Error('Invalid Codex home');const home=raw.startsWith('~/')?join(homedir(),raw.slice(2)):raw;return join(home,'skills',workerSkillName(agentId));}
 function journal(agentId){const directory=location(agentId);if(!operations.has(directory))operations.set(directory,createMaintenanceOperations(join(directory,'..','.'+workerSkillName(agentId)+'.maintenance')));return operations.get(directory);}
 async function snapshot(ctx){
  maintenanceContext(ctx);const harness=getConfig().plugins?.entries?.['agent-worker']?.config?.harness??'codex';if(harness!=='codex')return {apiVersion:1,id:'agent-repo.main-skill',label:'Main 协作技能',kind:'generated-skill',ownerLabel:'AgentRepo · 自动生成',scope:'当前 Agent · '+ctx.agentId,state:'unsupported',observedAt:new Date().toISOString(),fields:[{label:'执行器',value:String(harness)}],skills:[],actions:[]};const directory=location(ctx.agentId);let state='not_installed',revision=null,body='',publishedAt=null,entrypoint='未安装',refresh=null;
  try{
   if(!(await lstat(directory)).isDirectory()||await realpath(directory)!==join(await realpath(join(directory,'..')),workerSkillName(ctx.agentId)))throw Error('Invalid skill location');
   state='unavailable';
   const marker=JSON.parse(await readFile(join(directory,'.agent-repo.json'),'utf8'));
   if(marker.owner!=='agent-repo'||marker.agentId!==ctx.agentId||!/^[a-f0-9]{64}$/.test(marker.revision))throw Error('Invalid skill owner');
   if(await realpath(join(directory,'revisions'))!==join(await realpath(directory),'revisions'))throw Error('Invalid revision location');
   body=await readFile(join(directory,'revisions',marker.revision+'.md'),'utf8');if(hash(body)!==marker.revision)throw Error('Invalid revision hash');
   revision=marker.revision;publishedAt=(await lstat(join(directory,'.agent-repo.json'))).mtime.toISOString();state='available';
   try{entrypoint=hash(await readFile(join(directory,'SKILL.md'),'utf8'))===revision?'与已提交版本一致':'存在未提交入口；Worker 使用已提交版本';}catch{entrypoint='入口不可读；已提交正文可用';}
   try{refresh=JSON.parse(await readFile(join(directory,'.publication-status.json'),'utf8'));if(refresh.state==='fallback'&&refresh.revision===revision)state='fallback';}catch{}
  }catch(error){if(error.code!=='ENOENT')state='unavailable';body='';}
  let counts=null;try{const catalog=JSON.parse(/^```json\n([\s\S]*?)\n```/m.exec(body)?.[1]??'null');if(catalog?.agentId===ctx.agentId&&Array.isArray(catalog.plugins)&&Array.isArray(catalog.tools))counts={plugins:catalog.plugins.length,tools:catalog.tools.length};}catch{}
  const version=maintenanceRevision([ctx.agentId,revision,state]);
  return {apiVersion:1,id:'agent-repo.main-skill',label:'Main 协作技能',kind:'generated-skill',ownerLabel:'AgentRepo · 自动生成',scope:'当前 Agent · '+ctx.agentId,state,revision:version,observedAt:new Date().toISOString(),fields:[{label:'执行器',value:'Codex'},{label:'已提交版本',value:revision??'未知'},{label:'最近提交时间',value:publishedAt??'未知'},{label:'入口状态',value:entrypoint},{label:'最近刷新',value:refresh?.observedAt??'未记录'},{label:'刷新结果',value:refresh?.state??'未知'},{label:'目录数量',value:counts?counts.plugins+' 个已加载插件 · '+counts.tools+' 个候选工具':'旧版本未记录目录数量'},{label:'用途',value:'已加载插件与会话过滤前候选工具；不代表当前任务授权'}],skills:[{name:workerSkillName(ctx.agentId),description:'供 Worker 按任务读取 Main 插件能力与协作协议'}],actions:getAgentRepoService(ctx,{required:false})?.prepareWorkerSkill?[{id:'regenerate',label:'重新生成协作技能'}]:[],body:body.slice(0,200000),bodyTruncated:body.length>200000,history:await journal(ctx.agentId).history()};
 }
 return {snapshot,async run(ctx,input){
  maintenanceContext(ctx,true);if(input.providerId!=='agent-repo.main-skill'||input.action!=='regenerate'||input.settings!==undefined)throw new MaintenanceError('UNSUPPORTED','不支持的技能维护操作');
  const previous=await journal(ctx.agentId).find(ctx,input);if(previous)return previous;
  const current=await snapshot(ctx);if(!current.actions?.length)throw new MaintenanceError('UNSUPPORTED','此执行器或版本不支持技能发布');if(current.revision!==input.expectedRevision)throw new MaintenanceError('REVISION_CHANGED','技能状态已变化，请刷新后重试');
  const service=getAgentRepoService(ctx);if(!service.prepareWorkerSkill)throw new MaintenanceError('UNSUPPORTED','此版本不支持重新生成协作技能');
  return journal(ctx.agentId).start(ctx,input,async()=>{if((await snapshot(ctx)).revision!==input.expectedRevision)throw new MaintenanceError('REVISION_CHANGED','技能状态已变化');await service.prepareWorkerSkill();});
 }};
}
