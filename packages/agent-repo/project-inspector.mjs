import {entityAuditQuery,rootAudit,auditBegin,auditFinish,auditQuery,panelAuditActor} from './audit.mjs';
import {workspaceCatalog,saveWorkspaceConfig,WorkspaceManagementError} from './workspace-management.mjs';
import {scheduledRequestBridge} from './scheduled-requests.mjs';
import {createSkillMaintenance} from './skill-maintenance.mjs';
import {maintenanceCatalog,runMaintenance,maintenanceContext,MaintenanceError} from './dist/maintenance-api.mjs';
import {createEntityStore} from './entities.mjs';
import {getPeopleGroupSync} from './dist/people-api.mjs';
import {createPeopleStore} from './people.mjs';
import {queryPeople} from './people-query.mjs';
import {readdir,readFile,realpath,lstat} from 'node:fs/promises';
import {dirname,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {bindingFor} from './configuration.mjs';
import {containedPath,readProjects,inspectProject} from './repositories.mjs';
import {readSkillSource,git} from './repository-skills.mjs';
import {subagentInventory,resolveSubagentCatalog} from './subagents.mjs';
import {repositoryScheduleBridge,repositorySyncTaskId,repositorySyncTasks} from './scheduled-tasks.mjs';
import {readRepositoryLogs,clearRepositoryLogs} from './repository-log.mjs';
import {readSyncHistory} from './sync-history.mjs';
import {registryRevision} from './project-service.mjs';
import {trustedAgentId} from './dist/agent-repo-api.mjs';
import {inspectionChunkSize,inspectionMaxChunks} from './dist/inspection-transport.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const rules={agent:'当前 Agent 的所有项目共享；同名时优先于项目及子仓库技能。',project:'仅在选择当前项目时生效；进入该项目子仓库时继承，同名可被子仓库覆盖。',repository:'仅选择此子仓库范围时生效；覆盖同名项目根技能，不适用于兄弟仓库或其他项目。'};
async function registration(binding){
 const root=await realpath(binding.repo),file=await containedPath(root,'projects.json'),metadata=await lstat(file);
 if(!metadata.isFile()||metadata.size>256*1024||file!==root+'/projects.json')throw Error('Invalid project registration');
 const text=await readFile(file,'utf8');
 return {root,digest:hash(text),head:(await git(root,['rev-parse','HEAD'])).trim(),registryRevision:await registryRevision(binding).catch(()=>null)};
}
async function checkRegistration(binding,before){const after=await registration(binding);if(before.digest!==after.digest||before.head!==after.head)throw Error('项目登记在扫描中改变，请刷新后重试');}
async function inventory(root,directory,agentRoot,kind,hostConfig,agentId){
 try{
  const source=await readSkillSource(root,directory,agentRoot,kind,{inspection:true}),allowed=hostConfig.agents?.list?.find(agent=>agent.id===agentId)?.skills;
  const skills=[];
  // Bound Git process concurrency independently of the catalog size.
  for(let offset=0;offset<source.entries.length;offset+=4){
   skills.push(...await Promise.all(source.entries.slice(offset,offset+4).map(async entry=>{
    const local=relative(source.root,agentRoot+'/'+entry.path),folder=dirname(local);
    const [updatedAt,updatedCommit]=(await git(source.root,['log',source.head,'-1','--format=%cI%x00%H','--',':(literal)'+folder])).trim().split('\0');
    const disabledReason=entry.modelInvocationDisabled?'技能声明禁止模型调用':hostConfig.skills?.entries?.[entry.name]?.enabled===false?'宿主配置已禁用':Array.isArray(allowed)&&!allowed.includes(entry.name)?'不在当前 Agent 技能允许列表':null;
    return {...entry,updatedAt:updatedAt||null,updatedCommit:updatedCommit||null,disabledReason,appliesWhen:rules[kind]};
   })));
  }
  if((await git(source.root,['rev-parse','HEAD'])).trim()!==source.head)throw Error('Repository changed during scan');
  return {source:kind,repository:relative(agentRoot,source.root)||null,directory,head:source.head,state:source.dirty?'dirty':'available',skills};
 }catch{return {source:kind,repository:relative(agentRoot,root)||null,directory,state:'unavailable',skills:[],warning:'无法读取此范围的已提交技能；检查 Git 根、路径、技能格式和目录权限。'};}
}
async function checkSourceVersions(root,sources){
 const versions=new Map();
 for(const source of sources){
  if(!source.head)continue;
  const path=source.repository?await containedPath(root,source.repository):root;
  if(versions.has(path)&&versions.get(path)!==source.head)throw Error('仓库版本在扫描中改变，请刷新重试');
  versions.set(path,source.head);
 }
 for(const [path,head] of versions)if((await git(path,['rev-parse','HEAD'])).trim()!==head)throw Error('仓库版本在扫描中改变，请刷新重试');
}
async function scopes(root,project){
 const result=[{repository:project.repository,label:'项目根',source:'project'}],directory=await containedPath(root,project.repository+'/repositories');
 if(directory!==root+'/'+project.repository+'/repositories')return result;
 let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return result;throw error;}
 if(entries.length>200)throw Error('子仓库数量超过扫描上限');
 for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isDirectory()||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name))continue;
  const path=directory+'/'+entry.name;
  try{if(await realpath(path)!==path||await realpath((await git(path,['rev-parse','--show-toplevel'])).trim())!==path)continue;}catch{continue;}
  result.push({repository:project.repository+'/repositories/'+entry.name,label:entry.name,source:'repository'});
 }
 return result;
}
export function createProjectInspector(config,getHostConfig,now=()=>Date.now(),diagnostics={}){
 const maintenance=createSkillMaintenance(getHostConfig);
 async function context(ctx){const agentId=trustedAgentId(ctx),binding=bindingFor(config,{agentId});if(!binding)throw Error('当前 Agent 未绑定 Agent Repo');return {agentId,binding};}
 const inspector={
  ...diagnostics,
  async audit(ctx){
   const {agentId,binding}=await context(ctx),p=ctx.payload??{};
   // Validate even when all providers are unavailable. Each provider is independently Agent-scoped.
   const {limit=50,offset=0}=p;if(offset>10000)throw Error('请缩小审计筛选范围');
   rootAudit(binding.repo,db=>auditQuery(db,agentId,p));
   const providers=[params=>rootAudit(binding.repo,db=>auditQuery(db,agentId,params)),params=>entityAuditQuery(binding.repo,agentId,params)];
   const unavailable=[];
   for(const [name,bridge] of (!p.feature||p.feature==='schedules'?[['群计划',scheduledRequestBridge],['系统计划',repositoryScheduleBridge]]:[]))if(bridge.audit)providers.push(params=>bridge.audit(agentId,params));else unavailable.push(name);
   const records=[];let total=0;
   for(const read of providers){let cursor=0;do{const page=await read({...p,limit:100,offset:cursor});if(!cursor)total+=page.total;records.push(...page.records);cursor=page.nextOffset;}while(cursor!==null&&cursor<offset+limit);}
   records.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
   return {agentId,records:records.slice(offset,offset+limit),total,nextOffset:offset+limit<total?offset+limit:null,unavailable,notice:'审计自启用后记录；旧操作未保存的修改人和前后值无法追溯。成功仅表示管理操作完成，非业务执行完成。'};
  },
  async workspacePool(ctx){const {binding}=await context(ctx);const p=ctx.payload??{};if(Object.keys(p).some(k=>k!=='projectId')||typeof p.projectId!=='string')throw Error('Invalid project');return workspaceCatalog(binding.repo,p.projectId);},
  async workspacePoolSave(ctx){const {binding}=await context(ctx);if(!ctx.client?.scopes?.some(s=>['operator.write','operator.admin'].includes(s)))throw new WorkspaceManagementError('工作区管理需要写入权限');return saveWorkspaceConfig(binding.repo,ctx.payload??{});},
  async maintenance(ctx){await context(ctx);if(Object.keys(ctx.payload??{}).length)throw Error('Invalid maintenance parameters');const catalog=await maintenanceCatalog(ctx);let main;try{main=await maintenance.snapshot(ctx);}catch{main={apiVersion:1,id:'agent-repo.main-skill',label:'Main 协作技能',scope:'当前 Agent',state:'unavailable',skills:[],actions:[],observedAt:new Date().toISOString()};}return {...catalog,providers:[main,...catalog.providers]};},
  async maintenanceRun(ctx){await context(ctx);maintenanceContext(ctx,true);const input=ctx.payload??{};if(input.providerId==='agent-repo.main-skill'){if(Object.keys(input).some(key=>!['providerId','action','expectedRevision','requestId','confirmed','settings'].includes(key))||input.confirmed!==true||!/^[a-f0-9]{64}$/.test(input.expectedRevision??'')||!/^[a-f0-9-]{36}$/i.test(input.requestId??''))throw new MaintenanceError('INVALID_OPERATION','请确认维护目标和当前版本');return maintenance.run(ctx,input);}return runMaintenance(ctx,input);},
  async entityTypes(ctx){const {binding}=await context(ctx);if(Object.keys(ctx.payload??{}).length)throw Error('实体类型查询不接受范围参数');return createEntityStore(binding.repo).types();},
  async entities(ctx){const {binding}=await context(ctx);return createEntityStore(binding.repo).list(ctx.payload??{});},
  async entity(ctx){const {binding}=await context(ctx),params=ctx.payload??{};if(Object.keys(params).some(key=>key!=='id'))throw Error('实体查询参数无效');return createEntityStore(binding.repo).get(params.id);},
  async relations(ctx){const {binding}=await context(ctx);return createEntityStore(binding.repo).relations(ctx.payload??{});},
  async graph(ctx){const {binding}=await context(ctx);return createEntityStore(binding.repo).traverse(ctx.payload??{});},
  async entityHistory(ctx){const {binding}=await context(ctx);return createEntityStore(binding.repo).history(ctx.payload??{});},
  async peopleSyncInfo(ctx){
   const {agentId}=await context(ctx),params=ctx.payload??{};
   if(Object.keys(params).some(key=>key!=='accountId')||params.accountId!==undefined&&typeof params.accountId!=='string')throw Error('人员同步参数无效');
   const service=getPeopleGroupSync();if(!service)return {available:false,accounts:[],reason:'飞书人员同步服务尚未加载'};
   const input={agentId,sessionKey:ctx.sessionKey??'',...params};const info=service.info(input);return {...info,run:info.available?service.status(input):null};
  },
  async syncPeople(ctx){
   const {agentId}=await context(ctx),params=ctx.payload??{};
   if(!ctx.client?.scopes?.some(scope=>['operator.write','operator.admin'].includes(scope)))throw Error('人员同步需要写入权限');
   if(Object.keys(params).some(key=>key!=='accountId')||params.accountId!==undefined&&typeof params.accountId!=='string')throw Error('人员同步参数无效');
   const service=getPeopleGroupSync();if(!service)throw Error('飞书人员同步服务尚未加载');
   return service.start({agentId,sessionKey:ctx.sessionKey??'',...params});
  },
  async people(ctx){
   const {binding}=await context(ctx),params=ctx.payload??{};
   if(Object.keys(params).some(key=>!['query','offset','accountId','giteaSource','missing'].includes(key)))throw Error('人员查询参数无效');
   const {offset=0,query,...filters}=params;
   if(query!==undefined&&typeof query!=='string')throw Error('人员查询参数无效');
   if(query?.trim())filters.query=query;
   return {...queryPeople(binding.repo,{...filters,action:'people',offset,limit:50}),stats:queryPeople(binding.repo,{...filters,action:'people_stats'})};
  },
  async updatePerson(ctx){
   const {binding}=await context(ctx),params=ctx.payload??{};
   if(!ctx.client?.scopes?.some(scope=>['operator.write','operator.admin'].includes(scope)))throw Error('人员管理需要写入权限');
   if(Object.keys(params).some(key=>!['id','revision','patch'].includes(key)))throw Error('人员修改参数无效');
   return createPeopleStore(binding.repo).update(params);
  },
  async deletePerson(ctx){
   const {binding}=await context(ctx),params=ctx.payload??{};
   if(!ctx.client?.scopes?.some(scope=>['operator.write','operator.admin'].includes(scope)))throw Error('人员管理需要写入权限');
   if(Object.keys(params).some(key=>!['id','revision','confirmed'].includes(key))||params.confirmed!==true)throw Error('请确认删除人员资料');
   return createPeopleStore(binding.repo).remove(params);
  },
  async list(ctx){
   const {agentId,binding}=await context(ctx);if(ctx.payload&&Object.keys(ctx.payload).length)throw Error('项目列表不接受路径或 Agent 参数');
   const before=await registration(binding),projects=await readProjects(before.root),agentSkills=await inventory(before.root,'skills',before.root,'agent',getHostConfig(),agentId);
   const agentSubagents=await subagentInventory(before.root,before.root,'agent');resolveSubagentCatalog([agentSubagents]);
   const history=await readSyncHistory(before.root,agentId),scannedAt=now();
   await checkRegistration(binding,before);
   const systemTasks=repositorySyncTasks(binding,agentId,history,projects,scannedAt),nativeSync=await repositoryScheduleBridge.inspect?.(agentId);
   if(nativeSync)for(const task of systemTasks)Object.assign(task,nativeSync);
   return {scheduledRequestsAvailable:typeof scheduledRequestBridge.inspect==='function',scheduledTasks:[...systemTasks,...(await scheduledRequestBridge.inspect?.(agentId)??[])],syncHistory:{...history,enabled:binding.sync?.enabled===true,schedule:binding.sync?.submoduleSchedule??null},agentId,root:before.root,registryRevision:before.registryRevision,scannedAt,registrationCommitted:!!before.registryRevision,agentSkills,agentSubagents,projects:Object.values(projects).map(project=>({projectId:project.projectId,name:project.name,repository:project.repository}))};
  },
  async repositoryLogs(ctx){
   const {agentId,binding}=await context(ctx);if(Object.keys(ctx.payload??{}).length)throw Error('日志不接受其他范围参数');
   return readRepositoryLogs(binding.repo,agentId);
  },
  async clearRepositoryLogs(ctx){
   const {agentId,binding}=await context(ctx),params=ctx.payload??{};
   if(!ctx.client?.scopes?.some(scope=>['operator.write','operator.admin'].includes(scope)))throw Error('清空日志需要写入权限');
   if(Object.keys(params).some(key=>key!=='confirmed')||params.confirmed!==true)throw Error('请确认清空当前 Agent 的仓库日志');
   return clearRepositoryLogs(binding.repo,agentId);
  },
  async scheduleCatalog(ctx){
   const {agentId}=await context(ctx);if(Object.keys(ctx.payload??{}).length)throw Error('定时任务列表不接受其他范围参数');
   const group=await scheduledRequestBridge.catalog?.(agentId)??{agentId,available:false,tasks:[],operations:[]};
   const system=await repositoryScheduleBridge.catalog?.(agentId)??[];
   return {...group,available:group.available||system.length>0,tasks:[...system,...group.tasks],operations:[...system.flatMap(t=>t.operations??[]),...group.operations].sort((a,b)=>b.createdAt-a.createdAt).slice(0,30)};
  },
  async scheduleManage(ctx){
   const {agentId,binding}=await context(ctx);
   if(!ctx.client?.scopes?.some(scope=>['operator.write','operator.admin'].includes(scope)))throw Error('定时任务管理需要写入权限');
   const params=ctx.payload??{};
   if(params.id===repositorySyncTaskId(agentId)){if(!repositoryScheduleBridge.administer)throw Error('仓库同步调度服务不可用');return repositoryScheduleBridge.administer(agentId,params,{actor:panelAuditActor(ctx),executor:'control-ui'});}
   if(!scheduledRequestBridge.administer)throw Error('定时任务服务不可用');
   if(['create','update','resume','run'].includes(params.action)){
    const catalog=await scheduledRequestBridge.catalog(agentId),task=catalog.tasks.find(t=>t.id===(params.action==='create'?params.sourceId:params.id));
    const projects=await readProjects(binding.repo);if(!task||!Object.hasOwn(projects,task.projectId))throw Error('请选择当前 Agent 已登记项目的群请求');
   }
   return scheduledRequestBridge.administer(agentId,params,{actor:panelAuditActor(ctx),executor:'control-ui'});
  },
  async taskRecord(ctx){
   const {agentId,binding}=await context(ctx),params=ctx.payload??{},taskId=repositorySyncTaskId(agentId);
   if(typeof params.taskId==='string'&&params.taskId.startsWith('scheduled-request:')){
    if(Object.keys(params).some(key=>!['taskId','runId'].includes(key)))throw Error('定时记录范围无效');
    const task=(await scheduledRequestBridge.inspect?.(agentId)??[]).find(task=>task.taskId===params.taskId);
    const record=task?.records.find(record=>record.runId===params.runId);if(!record)throw Error('定时记录范围无效');return record;
   }
   if(Object.keys(params).some(key=>!['taskId','runId'].includes(key))||params.taskId!==taskId||typeof params.runId!=='string'||!params.runId.startsWith(taskId+':'))throw Error('同步记录范围无效');
   const record=await readSyncHistory(binding.repo,agentId,params.runId.slice(taskId.length+1));
   if(record.runId!==params.runId)throw Error('同步记录来源无效');
   return record;
  },
  async syncRecord(ctx){
   const {agentId,binding}=await context(ctx),params=ctx.payload??{};
   if(Object.keys(params).some(key=>key!=='date')||typeof params.date!=='string')throw Error('同步记录参数无效');
   return readSyncHistory(binding.repo,agentId,params.date);
  },
  async detail(ctx){
   const {agentId,binding}=await context(ctx),params=ctx.payload??{};
   if(Object.keys(params).some(key=>!['projectId','repository'].includes(key)))throw Error('项目详情参数无效');
   const before=await registration(binding),projects=await readProjects(before.root);
   if(typeof params.projectId!=='string'||!Object.hasOwn(projects,params.projectId))throw Error('选择已登记项目');
   const project=projects[params.projectId],availableScopes=await scopes(before.root,project),repository=params.repository??project.repository;
   if(!availableScopes.some(scope=>scope.repository===repository))throw Error('选择此项目下的仓库范围');
   const projectRoot=await containedPath(before.root,project.repository);if(projectRoot!==before.root+'/'+project.repository)throw Error('项目路径不能经过软链接');
   const host=getHostConfig(),sources=[await inventory(projectRoot,'.agents/skills',before.root,'project',host,agentId)];
   if(repository!==project.repository)sources.push(await inventory(await containedPath(before.root,repository),'.agents/skills',before.root,'repository',host,agentId));
   sources.push(await inventory(before.root,'skills',before.root,'agent',host,agentId));
   const effective=new Map();for(const source of sources)for(const skill of source.skills)if(!skill.disabledReason)effective.set(skill.name,skill);
   for(const source of sources)for(const skill of source.skills){skill.status=skill.disabledReason?'disabled':effective.get(skill.name)!==skill?'shadowed':source.state==='dirty'?'pending_commit':'candidate';if(skill.status==='shadowed')skill.overriddenBy=effective.get(skill.name).path;}
   const subagentSources=[await subagentInventory(projectRoot,before.root,'project')];
   if(repository!==project.repository)subagentSources.push(await subagentInventory(await containedPath(before.root,repository),before.root,'repository'));
   subagentSources.push(await subagentInventory(before.root,before.root,'agent'));
   const candidateSubagentCount=resolveSubagentCatalog(subagentSources);
   const inspection=await inspectProject(project);await checkSourceVersions(before.root,[...sources,...subagentSources]);await checkRegistration(binding,before);
   return {agentId,projectId:project.projectId,name:project.name,root:before.root,repository,cwd:projectRoot,scopeDirectory:before.root+'/'+repository,registryRevision:before.registryRevision,registrationCommitted:!!before.registryRevision,scannedAt:now(),inspection,scopes:availableScopes,sources,subagentSources,candidateSubagentCount,effectiveSkillCount:effective.size,rules:Object.values(rules)};
  },
 };
 // Persist intent before invoking a mutation. An interrupted pending record is never silently declared successful.
 const mutations={workspacePoolSave:'workspace',maintenanceRun:'skills',syncPeople:'entities',updatePerson:'entities',deletePerson:'entities',clearRepositoryLogs:'logs',diagnosticClearHistory:'logs'};
 for(const [action,feature] of Object.entries(mutations))if(inspector[action]){
  const run=inspector[action];inspector[action]=async ctx=>{
   const {agentId,binding}=await context(ctx),p=ctx.payload??{};
   if(!ctx.client?.scopes?.some(s=>['operator.write','operator.admin'].includes(s)))return run(ctx);
   const targetId=String(['updatePerson','deletePerson'].includes(action)?'person:'+p.id:p.id??p.projectId??p.providerId??p.sourceId??feature);
   const snapshot=async()=>{
    if(action==='maintenanceRun'){const catalog=p.providerId==='agent-repo.main-skill'?{providers:[await maintenance.snapshot(ctx)]}:await maintenanceCatalog(ctx);const provider=catalog.providers.find(r=>r.id===p.providerId);return provider?.policy?Object.fromEntries(['autoUpdate','version','updateCheckIntervalHours'].filter(k=>provider.policy[k]!==undefined).map(k=>[k,provider.policy[k]])):null;}
    if(action==='workspacePoolSave')return (await workspaceCatalog(binding.repo,p.projectId)).config;
    if(['updatePerson','deletePerson'].includes(action)){const person=createPeopleStore(binding.repo).all().find(r=>r.id===p.id);return person?Object.fromEntries(['name','email','departments','giteaUsername','revision'].map(k=>[k,person[k]])):null;}
    return null;
   };
   const requested=action==='workspacePoolSave'?{enabled:p.enabled,maxSize:p.maxSize}:action==='updatePerson'?Object.fromEntries(['name','email','departments','giteaUsername'].filter(k=>p.patch?.[k]!==undefined).map(k=>[k,p.patch[k]])):null;
   const before=await snapshot(),id=rootAudit(binding.repo,db=>auditBegin(db,{agentId,feature,targetId,action,actor:panelAuditActor(ctx),executor:'control-ui',requestId:typeof p.requestId==='string'?p.requestId:undefined,before,requested:action==='maintenanceRun'?{action:p.action,...Object.fromEntries(['autoUpdate','version','updateCheckIntervalHours'].filter(k=>p.settings?.[k]!==undefined).map(k=>[k,p.settings[k]]))}:action==='syncPeople'?{accountId:p.accountId??null}:requested}));
   try{const result=await run(ctx);
    // Capture the mutation's returned revision, never a later concurrent writer's state.
    const after=action==='workspacePoolSave'?result.config:action==='updatePerson'?Object.fromEntries(['name','email','departments','giteaUsername','revision'].map(k=>[k,result[k]])):action==='deletePerson'?null:before;
    const status=['maintenanceRun','syncPeople'].includes(action)?(['unknown','failed'].includes(result?.status)?result.status:result?.status==='succeeded'?'succeeded':'accepted'):'succeeded';
    rootAudit(binding.repo,db=>auditFinish(db,id,status,after));return result;
   }catch(error){rootAudit(binding.repo,db=>auditFinish(db,id,'unknown',before));throw error;}
  };
 }
 return inspector;
}
export function registerProjectInspector(api,inspector,{now=()=>Date.now(),isDiagnosticTransferActive=()=>false}={}){
 const register=api.session?.controls?.registerSessionAction?.bind(api.session.controls)??api.registerSessionAction?.bind(api);if(!register){api.logger?.warn?.('Agent Repo panel unavailable: host lacks public session actions');return;}
 const transfers=new Map(),owner=ctx=>JSON.stringify([trustedAgentId(ctx),ctx.sessionKey??null,ctx.client?.connId??null]);
 const part=(id,value,index)=>({encoding:'json-chunks',transferId:id,totalChunks:Math.ceil(value.text.length/inspectionChunkSize),index,chunk:value.text.slice(index*inspectionChunkSize,(index+1)*inspectionChunkSize)});
 for(const action of ['list','detail','chunk','workspacePool','workspacePoolSave','syncRecord','taskRecord','repositoryLogs','clearRepositoryLogs','people','peopleSyncInfo','syncPeople','updatePerson','deletePerson','entityTypes','entities','entity','relations','graph','entityHistory','maintenance','maintenanceRun','scheduleCatalog','scheduleManage','audit',...Object.keys(inspector).filter(key=>key.startsWith('diagnostic'))])register({id:'projects-'+action,description:'Current Agent repository catalog and diagnostic logs',requiredScopes:[['workspacePoolSave','scheduleManage','clearRepositoryLogs','syncPeople','updatePerson','deletePerson','maintenanceRun','diagnosticStart','diagnosticRenew','diagnosticClearHistory'].includes(action)?'operator.write':'operator.read'],handler:async ctx=>{
  try{
   const scope=owner(ctx);for(const [id,value] of transfers)if(value.expiresAt<=now())transfers.delete(id);
   if(action==='chunk'){const {transferId,index}=ctx.payload??{},value=transfers.get(transferId);if(!value||value.owner!==scope||!Number.isInteger(index)||index<0||index>=Math.ceil(value.text.length/inspectionChunkSize))throw Error('Invalid transfer');if(value.diagnosticLeaseId&&!isDiagnosticTransferActive(ctx,value.diagnosticLeaseId)){transfers.delete(transferId);throw Error('Diagnostic capture stopped');}return {ok:true,result:part(transferId,value,index)};}
   const result=await inspector[action](ctx);if(action==='diagnosticRead'&&!isDiagnosticTransferActive(ctx,result.leaseId))throw Error('Diagnostic capture stopped');
   if(action==='diagnosticStop')for(const [id,value] of transfers)if(value.diagnosticLeaseId===ctx.payload?.leaseId)transfers.delete(id);
   const text=JSON.stringify(result);if(text.length>inspectionChunkSize*inspectionMaxChunks)throw Error('Catalog exceeds transfer budget');
   const id=randomUUID(),value={owner:scope,text,expiresAt:now()+120000,...(action==='diagnosticRead'?{diagnosticLeaseId:result.leaseId}:{})};
   if(text.length>inspectionChunkSize){while(transfers.size>=4||[...transfers.values()].reduce((sum,item)=>sum+item.text.length,0)+text.length>inspectionChunkSize*inspectionMaxChunks)transfers.delete(transfers.keys().next().value);transfers.set(id,value);}
   return {ok:true,result:part(id,value,0)};
  }catch(error){if(action==='audit')return {ok:false,code:'AUDIT_UNAVAILABLE',error:'审计读取失败，请核对筛选条件、权限和审计来源状态。'};if(action.startsWith('workspacePool'))return {ok:false,error:error instanceof WorkspaceManagementError?error.message:'工作区管理失败，请核对项目、权限与本地状态',code:'WORKSPACE_MANAGEMENT_FAILED'};if(action.startsWith('diagnostic'))return {ok:false,code:'DIAGNOSTICS_UNAVAILABLE',error:'日志调试请求失败，请核对权限、来源和连接状态；实时调试需重新手动开启。'};if(['maintenance','maintenanceRun'].includes(action))return {ok:false,code:error instanceof MaintenanceError?error.code:'MAINTENANCE_UNAVAILABLE',error:error instanceof MaintenanceError?error.message:'技能维护暂不可用，请核对提供方版本、权限和配置'};return ['entityTypes','entities','entity','relations','graph','entityHistory'].includes(action)?{ok:false,error:'无法读取当前 Agent 的实体资料，请核对类型、查询参数和读取权限。',code:'ENTITIES_UNAVAILABLE'}:['people','peopleSyncInfo','syncPeople','updatePerson','deletePerson','maintenanceRun'].includes(action)?{ok:false,error:'无法读取或保存人员资料，请核对权限；资料变化时刷新后重试。',code:'PEOPLE_UNAVAILABLE'}:action==='clearRepositoryLogs'?{ok:false,error:'无法清空当前 Agent 的仓库日志，请核对写入权限及本地目录权限。',code:'REPOSITORY_LOG_CLEAR_FAILED'}:{ok:false,error:'无法读取当前 Agent 的项目、技能或子代理，请核对绑定、项目范围及本地 Git 状态。',code:'PROJECT_INSPECTION_UNAVAILABLE'};}
 }});
}
