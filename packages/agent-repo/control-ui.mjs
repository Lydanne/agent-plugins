import {mountWorkspacePool} from './workspace-pool-page.mjs';
import {mountScheduleManager} from './schedule-manager.mjs';
import {mountLogConsole} from './log-console.mjs';
import {mountSkillMaintenance} from './skill-maintenance-page.mjs';
import {mountWorkerPage,renderWorkerSummary} from './worker-page.mjs';
import {mountPeopleDialog} from './people-ui.mjs';
import {mountPeoplePage} from './people-page.mjs';
import {mountEntitiesPage} from './entities-page.mjs';
import './control-ui.css';
import {readInspectionResponse} from './dist/inspection-transport.mjs';
import {currentUiTarget,projectInspectionTarget,canOpenWorkerProject,openWorkerProject,subscribeWorkerNavigation} from './dist/ui-navigation.mjs';
let panelSequence=0;
const statusLabels={candidate:'范围内候选',disabled:'已禁用',shadowed:'同名覆盖',pending_commit:'待提交变化'};
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function button(text,action){const node=element('button',text);node.type='button';node.onclick=action;return node;}
function date(value){return value?new Date(value).toLocaleString():'未记录';}
export function mountProjects(container,initial){
 let context=initial,disposed=false,generation=0,list=null,detail=null,projectId='',repository='',query='',error='',loading=false;
 const root=element('section',undefined,'ar-panel');root.setAttribute('aria-label','Agent Repo 项目、技能与子代理');container.append(root);
 const safe=value=>context.host.redact(String(value??'')),target=()=>currentUiTarget(context);
 const panelId='ar-skills-'+(++panelSequence);
 let logDialog=null,logConsole=null,peopleDialog=null,scheduleManager=null;
 function groupName(task){const key='agent:'+target().agentId+':feishu:group:'+task.chatId;const row=(context.host.sessions.rows??[]).find(row=>row.key===key);return [row?.label,row?.displayName].find(name=>typeof name==='string'&&name.trim()&&!name.includes(task.chatId))?.trim()??'群名称未获取';}
 function closeScheduleManager(){scheduleManager?.dispose();scheduleManager=null;}
 function openScheduleManager(initialTaskId){closeScheduleManager();scheduleManager=mountScheduleManager(container,{initialTaskId,groupName,invoke,canWrite:()=>context.host.connection.canWrite===true,safe,onClose:()=>{scheduleManager=null;},onChanged:()=>refresh()});}
 let workspaceView=null;
 let maintenanceView=null;
 function closeMaintenance(){maintenanceView?.dispose();maintenanceView=null;}
 function closePeople(){peopleDialog?.dispose();peopleDialog=null;}
 function openPeople(){closePeople();peopleDialog=mountPeopleDialog(container,{invoke,isGroup:()=>/^agent:[^:]+:feishu:group:oc_/.test(target().sessionKey??''),canWrite:()=>context.host.connection.canWrite===true,safe,onClose:()=>{peopleDialog=null;}});}
 let historyGeneration=0,syncDialog=null,syncTaskId=null,syncRunId=null,syncTab='records',syncRenderedView=null;const syncRecords=new Map(),syncViewScroll=new Map();
 const syncLabels={completed:'成功',failed:'失败',running:'未结束',unavailable:'不可读取',started:'开始',worker_submitted:'已提交 Worker',submitted:'Main 已接纳',dispatching:'交接中',unknown:'结果待核验',blocked:'已阻止',verified_not_executed:'已核对未执行',delivered:'消息已送达'};
 const shortTime=value=>value?new Date(value).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'未记录';
 const duration=record=>{const ms=Date.parse(record.finishedAt)-Date.parse(record.startedAt),seconds=Math.round(ms/1000);return Number.isFinite(ms)&&ms>=0?(ms<1000?'不足 1 秒':seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒'):'—';};
 let observedTarget=target(),observedRead=context.host.connection.canRead,observedWrite=context.host.connection.canWrite,skillArea=null,subagentArea=null;
 function renderSkills(){
  if(!skillArea||!list)return;
  const sources=projectId?(detail?.sources??[]).filter(source=>source.source!=='agent'):[list.agentSkills];
  if(!maintenanceView)maintenanceView=mountSkillMaintenance(skillArea,context,target().agentId,{sources,scopeKey:projectId+':'+repository,onViewChange:view=>{if(subagentArea)subagentArea.hidden=view==='cli';},onQuery:value=>{query=value;if(subagentArea){const open=new Set([...subagentArea.querySelectorAll('details[open]')].map(node=>node.dataset.skillPath));subagentArea.replaceChildren(subagents(projectId?(detail?.subagentSources??[]).filter(source=>source.source!=='agent'):[list.agentSubagents].filter(Boolean)));for(const row of subagentArea.querySelectorAll('details'))if(open.has(row.dataset.skillPath))row.open=true;}}});
  else {skillArea.append(maintenanceView.element);maintenanceView.setSources(sources,projectId+':'+repository);}
  subagentArea=element('div');subagentArea.append(subagents(projectId?(detail?.subagentSources??[]).filter(source=>source.source!=='agent'):[list.agentSubagents].filter(Boolean)));subagentArea.hidden=maintenanceView.view==='cli';skillArea.append(subagentArea);
 }
 function reset(){workspaceView?.dispose();workspaceView=null;closeScheduleManager();closeMaintenance();closePeople();closeLogDialog(false);closeSyncDialog(false);generation++;historyGeneration++;syncRecords.clear();list=null;detail=null;projectId='';repository='';query='';error='';loading=false;}
 async function invoke(action,payload){const current=context,selected=projectInspectionTarget(context);return readInspectionResponse(async(name,data)=>{current.signal.throwIfAborted();if(current!==context)throw Error('Agent 已切换');return current.host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+name,...selected,payload:data});},action,payload);}
 async function refresh({scanList=true}={}){
  if(disposed||!context.presented||context.signal.aborted||!context.host.connection.canRead||!target().agentId)return;
  if(context.props.managementSection==='logs'){await openLogDialog();return;}
  if(scanList){historyGeneration++;syncRecords.clear();maintenanceView?.refresh();}
  const request=++generation;loading=true;error='';render();
  try{
   if(scanList||!list){const next=await invoke('list',{});if(disposed||request!==generation)return;list=next;}
   if(projectId&&!list.projects.some(project=>project.projectId===projectId)){projectId='';repository='';detail=null;}
   const nextDetail=projectId?await invoke('detail',{projectId,...(repository?{repository}:{})}):null;
   if(disposed||request!==generation)return;
   detail=nextDetail;
   if(detail)repository=detail.repository;loading=false;render();if(syncRunId&&!syncRecords.has(syncRunId))loadSyncRecord(selectedRun());
  }catch(failure){if(disposed||request!==generation)return;loading=false;error=safe(failure.message);detail=null;render();}
 }
 function subagents(sources){
  const section=element('section',undefined,'ar-skill-group ar-subagents'),heading=element('h3','子代理');heading.append(element('span',String(sources.reduce((count,source)=>count+source.subagents.length,0)),'ar-group-count'));section.append(heading);
  let count=0;
  for(const source of sources){
   for(const warning of source.warnings??[])section.append(element('p',safe(warning),'ar-warning'));
   if(source.state==='dirty')section.append(element('p','存在未提交子代理变化，当前展示已提交版本。','ar-warning'));
   for(const agent of source.subagents.filter(agent=>[agent.name,agent.description,agent.provider,agent.path,agent.definitionPath].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()))){
    count++;const row=element('details',undefined,'ar-skill ar-subagent'),summary=element('summary'),top=element('span',undefined,'ar-skill-heading'),body=element('div',undefined,'ar-skill-body');row.dataset.skillPath='subagent:'+agent.provider+':'+agent.name+':'+agent.path;
    const status=agent.status??'candidate';top.append(element('strong',safe(agent.name)),element('span',status==='candidate'?'范围内定义':statusLabels[status],'ar-status '+status));summary.append(top,element('span',safe(agent.provider+' · 更新于 '+date(agent.updatedAt)),'ar-skill-time'));row.append(summary,body);
    body.append(element('p',safe(agent.description||'没有子代理描述')),element('code',safe(agent.path),'ar-path'));
    if(agent.definitionPath)body.append(element('code',safe(agent.definitionPath),'ar-path'));
    body.append(element('p',safe([agent.provider,agent.model?'模型 '+agent.model:null,agent.reasoningEffort?'思考 '+agent.reasoningEffort:null,agent.mode==='all'?'可作主代理或子代理':null,agent.hidden?'执行器菜单隐藏':null].filter(Boolean).join(' · ')),'ar-meta'),element('p',safe(agent.appliesWhen),'ar-condition'));
    if(agent.disabledReason)body.append(element('p',safe(agent.disabledReason),'ar-warning'));
    if(agent.overriddenBy)body.append(element('p',safe('当前目录索引被 '+agent.overriddenBy+' 覆盖'),'ar-warning'));
    body.append(element('p',safe('提交 '+(agent.updatedCommit?.slice(0,12)||'未记录')),'ar-meta'));section.append(row);
   }
  }
  if(!count)section.append(element('p',sources.length&&sources.every(source=>source.state==='unavailable')?'此范围子代理暂不可扫描':query?'没有匹配子代理':'没有已提交的子代理','ar-muted'));
  section.append(element('p','定义扫描仅供查看；实际注册、继承与调用以对应执行器的配置及权限为准。','ar-muted'));return section;
 }
 function syncBadge(status){return element('span',syncLabels[status]??'未知','ar-sync-badge '+status);}
 function scheduledTasks(){return list?.scheduledTasks??[];}
 function selectedTask(){return scheduledTasks().find(task=>task.taskId===syncTaskId);}
 function selectedRun(){return selectedTask()?.records.find(record=>record.runId===syncRunId);}
 function taskState(task){if(task.type==='repository-sync'&&task.status){if(!task.nativeAvailable)return '调度状态不可读取';return ({enabled:task.enabled?'已启用':'原生计划已暂停',paused:'已暂停',removed:'已删除',creating:'创建中',needs_review:'待核验'})[task.status]??'待核验';}if(task.type==='scheduled-request'){if(!task.nativeAvailable)return '调度状态不可读取';if(task.nativeMissing&&task.status!=='removed')return '原生计划缺失';if(task.status==='enabled'&&!task.enabled)return '原生计划已暂停';return ({enabled:'已启用',paused:'已暂停',removed:'已移除',completed:'已结束',blocked:'来源失效',needs_review:'待检查',creating:'创建中'})[task.status]??'待检查';}return task.enabled?'已启用':task.schedule?'已暂停':'未配置';}
 function scheduleText(task){const s=task.schedule;if(!s)return '未配置执行计划';if(task.type!=='scheduled-request')return '每天 '+s.time+' · '+s.timeZone;if(s.kind==='at')return date(s.at);const daily=/^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(s.expr??'');return (daily&&+daily[1]<60&&+daily[2]<24?'每天 '+daily[2].padStart(2,'0')+':'+daily[1].padStart(2,'0'):'Cron '+s.expr)+' · '+(s.tz??'Asia/Shanghai');}
 function planText(task){
  const next=task.nextPlanned;
  if(next?.state==='due')return '已到计划时间，暂无记录';
  if(next?.state==='scheduled')return next.at?new Date(next.at).toLocaleString('zh-CN',{timeZone:next.timeZone??'Asia/Shanghai',hour12:false})+' · '+(next.timeZone??'Asia/Shanghai'):next.date+' '+next.time;
  return next?.state==='disabled'?'已暂停':next?.state==='unconfigured'?'未配置计划':'暂不可确定';
 }
 function taskBadge(task){return element('span',taskState(task),'ar-sync-badge '+(task.enabled?'enabled':'paused'));}
 function syncHistory(){
  if(!Array.isArray(list.scheduledTasks))return null;
  const tasks=scheduledTasks(),section=element('section',undefined,'ar-sync-history'),heading=element('div',undefined,'ar-sync-heading');
  const full=context.props.managementSection==='tasks';if(!full)heading.append(element('h3','定时任务'));heading.append(element('span',tasks.length+' 个任务','ar-meta'));section.append(heading);const grid=element('div',undefined,full?'ar-task-grid':'');
  heading.append(button('管理定时任务',()=>openScheduleManager()));
  if(list.scheduledRequestsAvailable===false)section.append(element('p','OpenClaw 联动任务服务暂不可读取，以下列表可能不完整。','ar-warning'));
  if(!tasks.length)section.append(element('p','暂无定时任务','ar-muted'));
  for(const task of tasks){
   const row=button('',()=>openSyncDialog(task.taskId));row.className='ar-scheduled-task';row.dataset.taskId=task.taskId;row.setAttribute('aria-label','查看'+task.name);row.setAttribute('aria-haspopup','dialog');
   const top=element('span',undefined,'ar-task-row-top');top.append(element('strong',safe(task.name)),taskBadge(task));row.append(top);
   row.append(element('span',safe((task.type==='scheduled-request'?'OpenClaw 联动 · ':'系统任务 · ')+scheduleText(task)),'ar-task-row-meta'));
   if(task.type==='scheduled-request'){row.append(element('span',safe('来源群：'+groupName(task)),'ar-task-row-meta'),element('span',safe('原请求人：'+(task.requester??'未记录')),'ar-task-row-meta'));}else row.append(element('span',safe(task.scope.label),'ar-task-row-meta'));
   const bottom=element('span',undefined,'ar-task-row-bottom');bottom.append(element('span',safe('下次计划：'+planText(task))));
   const last=element('span','上次：');last.append(task.lastRun?syncBadge(task.lastRun.status):element('span','尚未执行','ar-muted'));bottom.append(last);row.append(bottom);if(full){const card=element('article',undefined,'ar-task-card'),actions=element('div',undefined,'ar-task-card-actions'),edit=button('编辑计划',()=>openScheduleManager(task.taskId.replace(/^scheduled-request:/,'')));edit.setAttribute('aria-label','编辑'+task.name);edit.setAttribute('aria-haspopup','dialog');actions.append(element('span','点击任务查看执行记录','ar-muted'),edit);card.append(row,actions);grid.append(card);}else grid.append(row);
  }
  section.append(grid);return section;
 }
 function closeLogDialog(restore=true){
  const dialog=logDialog;logDialog=null;logConsole?.dispose();logConsole=null;if(dialog){if(dialog.open)dialog.close();dialog.remove();}
  if(restore)root.querySelector('[data-repository-logs]')?.focus({preventScroll:true});
 }
 async function openLogDialog(){
  closeSyncDialog(false);closeLogDialog(false);
  const inline=context.props.managementSection==='logs',current=context,selected=projectInspectionTarget(context);
  const dialog=element(inline?'section':'dialog',undefined,'ar-sync-dialog ar-log-dialog'+(inline?' ar-log-inline':'')),header=element('header',undefined,'ar-sync-dialog-header'+(inline?' ar-section-heading':'')),heading=element('div'),title=element('h2','日志');title.id=panelId+'-log-title';dialog.setAttribute('aria-labelledby',title.id);heading.append(title,element('p','统一查看插件与 Worker 日志；实时调试默认关闭。','ar-log-subtitle'));
  const close=button('关闭',()=>closeLogDialog());header.append(heading);if(!inline)header.append(close);dialog.append(header);logDialog=dialog;
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeLogDialog();});dialog.addEventListener('close',()=>{if(logDialog===dialog)closeLogDialog();});
  const body=element('div',undefined,'ar-sync-dialog-body');dialog.append(body);container.append(dialog);
  // Capture the original target: cleanup must stop the old Agent's lease after switching.
  const logInvoke=(action,payload)=>readInspectionResponse(async(name,data)=>current.host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+name,...selected,payload:data}),action,payload).then(result=>{if(['repositoryLogs','clearRepositoryLogs','diagnosticHistory','diagnosticClearHistory'].includes(action)&&result.agentId!==selected.agentId)throw Error('日志来源与当前 Agent 不一致');return result;});
  logConsole=mountLogConsole(body,{invoke:logInvoke,safe,agentId:selected.agentId,signal:current.signal,actionsContainer:inline?header:undefined,canWrite:()=>context.host.connection.canWrite===true});if(!inline){dialog.showModal();close.focus();}
 }
 function closeSyncDialog(restore=true){
  const taskId=syncTaskId,dialog=syncDialog;syncDialog=null;syncTaskId=null;syncRunId=null;syncTab='records';syncRenderedView=null;syncViewScroll.clear();
  if(dialog){if(dialog.open)dialog.close();dialog.remove();}
  if(restore&&taskId)[...root.querySelectorAll('[data-task-id]')].find(row=>row.dataset.taskId===taskId)?.focus({preventScroll:true});
 }
 function openSyncDialog(taskId){
  closeLogDialog(false);closeSyncDialog(false);syncTaskId=taskId;
  const dialog=element('dialog',undefined,'ar-sync-dialog');syncDialog=dialog;dialog.setAttribute('aria-labelledby',panelId+'-sync-title');
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeSyncDialog();});
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeSyncDialog();});
  dialog.addEventListener('close',()=>{if(syncDialog===dialog)closeSyncDialog();});
  container.append(dialog);renderSyncDialog();dialog.showModal();dialog.querySelector('.ar-sync-close')?.focus();
 }
 function showTaskRecords(){
  const previous=syncRunId;syncRunId=null;syncTab='records';renderSyncDialog();
  [...(syncDialog?.querySelectorAll('[data-run-id]')??[])].find(row=>row.dataset.runId===previous)?.focus({preventScroll:true});
 }
 function runRows(task){
  const section=element('section',undefined,'ar-task-records');section.append(element('p','最近 '+task.records.length+' 次执行','ar-meta'));
  if(!task.records.length)section.append(element('p','暂无执行记录。任务首次运行后会显示在这里。','ar-muted'));
  else{
   const rows=element('div',undefined,'ar-sync-list'),columns=element('div',undefined,'ar-sync-columns');columns.setAttribute('aria-hidden','true');columns.append(element('span','执行时间'),element('span','结果'),element('span','耗时'),element('span'));rows.append(columns);section.append(rows);
   for(const record of task.records){
    const row=button('',()=>{syncRunId=record.runId;renderSyncDialog();syncDialog?.querySelector('.ar-sync-close')?.focus();loadSyncRecord(record);});row.className='ar-sync-record';row.dataset.runId=record.runId;row.setAttribute('aria-label','查看 '+record.date+' 执行详情');
    const info=element('span',undefined,'ar-sync-record-info');info.append(element('strong',safe(record.date)),element('span',safe(shortTime(record.startedAt)),'ar-sync-record-time'));row.title=safe(record.reason??record.failures?.[0]?.reason??'查看执行详情与日志');
    row.append(info,syncBadge(record.status),element('span',safe(duration(record)),'ar-sync-elapsed'),element('span','›','ar-sync-arrow'));rows.append(row);
   }
  }
  if(task.hasMore)section.append(element('p','仅展示最近 30 次记录，更早记录保留在对应任务的私有状态中。','ar-muted'));
  return section;
 }
 function taskSettings(task){
  const section=element('section',undefined,'ar-task-settings'),data=element('dl',undefined,'ar-task-config');
  for(const [key,value] of [['任务类型',task.type==='scheduled-request'?'群内定时请求':'仓库同步'],['任务来源',task.type==='scheduled-request'?'OpenClaw 原生调度 → Main':'系统任务'],['所属 Agent',target().agentId],['执行范围',task.scope.label],['执行计划',scheduleText(task)],['时区',task.schedule?.timeZone??task.schedule?.tz??'Asia/Shanghai'],['任务状态',taskState(task)]]){data.append(element('dt',key),element('dd',safe(value)));}if(task.type==='scheduled-request')for(const [key,value] of [['原请求人',task.requester],['来源群',groupName(task)],['群 ID',task.chatId],['OpenClaw 任务 ID',task.jobId],['最近原生调度',task.nativeLastStatus??'尚无记录']])data.append(element('dt',key),element('dd',safe(value)));if(task.type==='repository-sync'&&task.jobId)data.append(element('dt','OpenClaw 任务 ID'),element('dd',safe(task.jobId)));section.append(data,element('p',task.type==='scheduled-request'?'在任务列表点击“管理定时任务”可修改计划；原生调度成功或 Main 接纳不代表业务完成。':task.readOnly?'此处只读展示；系统同步计划由部署配置管理。':'在任务列表点击“管理定时任务”管理原生同步计划；当天已尝试的同步不会重跑。','ar-muted'));return section;
 }
 function renderSyncDialog(){
  if(!syncDialog||!syncTaskId)return;
  const task=selectedTask();if(!task){closeSyncDialog(false);return;}
  const record=selectedRun();if(syncRunId&&!record)syncRunId=null;
  const dialog=syncDialog,focusedClose=document.activeElement===dialog.querySelector('.ar-sync-close');
  if(syncRenderedView)syncViewScroll.set(syncRenderedView,dialog.querySelector('.ar-sync-dialog-body')?.scrollTop??0);
  syncRenderedView=record?'run:'+record.runId:'task:'+task.taskId+':'+syncTab;const scroll=syncViewScroll.get(syncRenderedView)??0;dialog.replaceChildren();
  const header=element('header',undefined,'ar-sync-dialog-header'),title=element('div'),breadcrumb=element('nav',undefined,'ar-task-breadcrumb');breadcrumb.setAttribute('aria-label','定时任务路径');
  const home=button('定时任务',()=>closeSyncDialog());breadcrumb.append(home,element('span','/'));
  if(record)breadcrumb.append(button(safe(task.name),showTaskRecords),element('span','/'),element('span',safe(record.date)));else breadcrumb.append(element('span',safe(task.name)));
  title.append(breadcrumb);const heading=element('h2',record?'执行详情':safe(task.name));heading.id=panelId+'-sync-title';title.append(heading);
  const close=button('关闭',()=>closeSyncDialog());close.className='ar-sync-close';header.append(title,close);dialog.append(header);
  const body=element('div',undefined,'ar-sync-dialog-body');dialog.append(body);
  if(!record){
   const overview=element('div',undefined,'ar-sync-overview');overview.append(taskBadge(task),element('span',safe((task.type==='scheduled-request'?'OpenClaw 联动':'系统任务')+' · Agent '+target().agentId),'ar-meta'));body.append(overview);
   const meta=element('dl',undefined,'ar-sync-metadata');for(const [key,value] of [['执行计划',scheduleText(task)],['执行范围',task.scope.label],['下次计划',planText(task)]]){const cell=element('div');cell.append(element('dt',key),element('dd',safe(value)));meta.append(cell);}body.append(meta);
   const tabs=element('div',undefined,'ar-task-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','定时任务详情');
   for(const [id,label] of [['records','执行记录'],['settings','任务设置']]){const tab=button(label,()=>{syncTab=id;renderSyncDialog();syncDialog?.querySelector('#'+panelId+'-'+id)?.focus({preventScroll:true});});tab.id=panelId+'-'+id;tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(syncTab===id));tab.setAttribute('aria-controls',panelId+'-task-content');tab.tabIndex=syncTab===id?0:-1;tab.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();syncTab=event.key==='Home'?'records':event.key==='End'?'settings':syncTab==='records'?'settings':'records';renderSyncDialog();syncDialog?.querySelector('#'+panelId+'-'+syncTab)?.focus();};tabs.append(tab);}body.append(tabs);
   const content=syncTab==='records'?runRows(task):taskSettings(task);content.id=panelId+'-task-content';content.setAttribute('role','tabpanel');content.setAttribute('aria-labelledby',panelId+'-'+syncTab);body.append(content);
  }else{
   renderRunDetails(body,record);
   const back=button('返回执行记录',showTaskRecords);back.className='ar-task-back';body.append(back);
  }
  body.scrollTop=scroll;if(focusedClose)close.focus({preventScroll:true});
 }
 function renderRunDetails(body,record){
  const overview=element('div',undefined,'ar-sync-overview');overview.append(syncBadge(record.status),element('span',safe('定时触发 · Agent '+target().agentId),'ar-meta'));body.append(overview);
  const meta=element('dl',undefined,'ar-sync-metadata');for(const [label,value] of [['开始时间',date(record.startedAt)],['结束时间',date(record.finishedAt)],['执行耗时',duration(record)]]){const cell=element('div');cell.append(element('dt',label),element('dd',safe(value)));meta.append(cell);}body.append(meta);
  const reasons=[record.reason,...(record.failures??[]).map(failure=>(failure.projectId??'项目')+'：'+failure.reason)].filter(Boolean);
  if(reasons.length){const alert=element('section',undefined,'ar-sync-failure');alert.append(element('h3','失败原因'));for(const reason of reasons)alert.append(element('p',safe(reason)));body.append(alert);}
  if(record.status==='running')body.append(element('p','记录尚未结束；进程中断也可能留下此状态。刷新可查看最新记录。','ar-muted'));
  const loaded=syncRecords.get(record.runId),section=element('section',undefined,'ar-sync-events'),logHeader=element('div',undefined,'ar-sync-heading');logHeader.append(element('h3','执行日志'));section.append(logHeader);body.append(section);
  if(loaded?.error)section.append(element('p',loaded.error,'ar-error'),button('重试读取日志',()=>loadSyncRecord(record,true)));
  else if(loaded?.record){
   const logs=loaded.record.logs??[];logHeader.append(element('span',logs.length+' 条','ar-meta'));
   if(!logs.length)section.append(element('p','此记录没有详细阶段日志；旧版记录仅保存最终结果。','ar-muted'));
   const events=element('ol',undefined,'ar-sync-log');events.setAttribute('aria-label','同步执行日志');section.append(events);
   for(const event of logs){const item=element('li',undefined,'ar-sync-event '+event.status),top=element('div',undefined,'ar-sync-event-top');top.append(element('time',safe(shortTime(event.time))),element('strong',safe(event.stage??'同步')),syncBadge(event.status));item.append(top,element('p',safe([event.projectId?'项目 '+event.projectId:'Agent',event.repository,event.branch?'分支 '+event.branch:null,event.head?'提交 '+event.head.slice(0,12):null].filter(Boolean).join(' / ')),'ar-sync-event-meta'));if(event.reason)item.append(element('p',safe(event.reason),'ar-sync-event-reason'));events.append(item);}
   if(loaded.record.logsTruncated)section.append(element('p','阶段日志达到条数或大小上限，后续日志未保存。','ar-warning'));
  }else section.append(element('p','正在读取执行日志…','ar-muted'));
 }
 async function loadSyncRecord(record,retry=false){
  if(!record||disposed||!context.presented||context.signal.aborted||!context.host.connection.canRead||!target().agentId||syncRecords.has(record.runId)&&!retry)return;
  const epoch=historyGeneration;syncRecords.set(record.runId,{loading:true});render();
  try{
   const result=await invoke('taskRecord',{taskId:record.taskId,runId:record.runId});
   if(disposed||epoch!==historyGeneration)return;
   if(result.taskId!==record.taskId||result.runId!==record.runId)throw Error('执行记录来源与当前任务不一致');
   syncRecords.set(record.runId,{record:result});
  }catch(failure){if(disposed||epoch!==historyGeneration)return;syncRecords.set(record.runId,{error:safe(failure.message)});}
  render();
 }
 function chooseTab(id){
  if(id===projectId)return;
  closeSyncDialog(false);generation++;projectId=id;repository='';detail=null;query='';error='';const body=root.querySelector('.ar-scroll');if(body)body.scrollTop=0;render();refresh({scanList:false});
 }
 function tabs(){
  const nav=element('div',undefined,'ar-tabs'),projectTabs=element('div',undefined,'ar-project-tabs');projectTabs.setAttribute('role','tablist');projectTabs.setAttribute('aria-label','仓库与项目');
  const add=(id,label,title,container)=>{const tab=button(label,()=>chooseTab(id));tab.id=panelId+'-tab-'+(id?'project-'+id:'root');tab.dataset.tabKey=id;tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(projectId===id));tab.setAttribute('aria-controls',panelId);tab.tabIndex=projectId===id?0:-1;tab.title=title;
   tab.onkeydown=event=>{const items=[...nav.querySelectorAll('[role=tab]')],index=items.indexOf(tab),next=event.key==='ArrowRight'?(index+1)%items.length:event.key==='ArrowLeft'?(index+items.length-1)%items.length:event.key==='Home'?0:event.key==='End'?items.length-1:null;if(next===null)return;event.preventDefault();for(const item of items)item.tabIndex=-1;items[next].tabIndex=0;items[next].focus();};container.append(tab);};
  add('','Agent Repo','技能与子代理 · 所有项目共享',projectTabs);nav.append(projectTabs);
  for(const project of list.projects)add(project.projectId,safe(project.name),safe(project.name+' · '+project.repository),projectTabs);
  return nav;
 }
 function jump(){try{openWorkerProject({...target(),projectId});}catch(failure){error=safe(failure.message);render();}}
 function render(){
  workspaceView?.dispose();workspaceView=null;
  root.dataset.managementSection=context.props.managementSection??'';
  renderSyncDialog();
  const tabScroll=root.querySelector('.ar-project-tabs')?.scrollLeft??0;
  const scroll=root.querySelector('.ar-scroll')?.scrollTop??0,expanded=new Set([...root.querySelectorAll('details[open]')].map(node=>node.dataset.skillPath));
  const focusedTab=root.contains(document.activeElement)?document.activeElement?.dataset.tabKey:undefined;
  maintenanceView?.rememberFocus();skillArea=null;root.replaceChildren();if(context.props.managementSection==='logs')return;const selected=target(),header=element('header',undefined,'ar-panel-header'),actions=element('div',undefined,'ar-panel-actions'),scan=button(loading?'扫描中…':context.props.managementSection==='logs'?'刷新日志':context.props.managementSection==='tasks'?'刷新任务':'刷新扫描',refresh);scan.disabled=loading;actions.append(scan);if(context.props.managementSection){header.classList.add('ar-section-heading');const copy=element('div');copy.append(element('h2',context.props.managementSection==='tasks'?'定时任务':context.props.managementSection==='logs'?'日志':'项目与技能'),element('p',context.props.managementSection==='tasks'?'查看仓库同步和 OpenClaw 联动群任务的计划、状态与运行记录。':'查看共享及项目技能，管理关联 CLI 与子代理。','ar-description'));header.append(copy,actions);}else header.append(element('strong','项目、技能与子代理'),actions);if(!context.props.managementSection&&context.host.connection.canRead&&selected.agentId){const logs=button('日志',openLogDialog);logs.dataset.repositoryLogs='';logs.setAttribute('aria-haspopup','dialog');actions.append(logs);const people=button('人员资料',openPeople);people.setAttribute('aria-haspopup','dialog');actions.append(people);}root.append(header);
  if(!context.host.connection.canRead){root.append(element('p','需要 operator.read 权限才能查看。'));return;}
  if(!selected.agentId){root.append(element('p','请先选择一个 Agent。'));return;}
  if(!context.props.managementSection)root.append(element('p',safe('当前 Agent · '+selected.agentId),'ar-meta'));
  if(error)root.append(element('p',error,'ar-error'));
  if(context.props.managementSection==='logs')return;
  if(!list){root.append(element('p',loading?context.props.managementSection==='tasks'?'正在读取定时任务…':'正在读取项目、技能与子代理…':'尚未取得项目登记','ar-muted'));return;}
  if(context.props.managementSection==='tasks'){const history=syncHistory();root.append(history??element('p','暂无定时任务','ar-muted'));return;}
  if(!list.registrationCommitted)root.append(element('p','项目登记存在未提交变化；当前展示仅供检查，执行前须提交并复核。','ar-warning'));
  const scopeTabs=tabs();root.append(scopeTabs);root.querySelector('.ar-project-tabs').scrollLeft=tabScroll;
  const body=element('div',undefined,'ar-scroll');body.id=panelId;body.setAttribute('role','tabpanel');body.setAttribute('aria-labelledby',panelId+'-tab-'+(projectId?'project-'+projectId:'root'));body.tabIndex=0;root.append(body);
  if(!projectId){
   if(context.props.managementSection!=='projects'){body.append(element('h2',safe(list.root?.split('/').filter(Boolean).at(-1)??'Agent Repo')),element('code',safe(list.root??'skills/'),'ar-path'));
    body.append(element('p','此 Agent 的所有项目共享','ar-meta'));
    if(!list.projects.length)body.append(element('p','尚未登记项目。当前仍可查看技能和子代理。','ar-muted'));}
  }else if(!detail)body.append(element('p',loading?'正在读取当前项目内容…':'当前项目内容尚未读取，请重试或选择其他 Tab。','ar-muted'));
  if(detail){
   const heading=element('div',undefined,'ar-project-heading');heading.append(element('h2',safe(detail.name)));
   const worker=button('查看 Worker 项目任务 ↗',jump);worker.disabled=!selected.sessionKey||!canOpenWorkerProject();worker.title=!selected.sessionKey?'先选择该 Agent 的会话':!canOpenWorkerProject()?'需要加载配套 Agent Worker UI':'打开当前会话中此项目的 Worker 任务';heading.append(worker);body.append(heading);
   body.append(element('code',safe(detail.cwd),'ar-path'));
   if(context.presented&&!context.signal.aborted)workspaceView=mountWorkspacePool(body,{projectId,invoke,canWrite:()=>context.host.connection.canWrite===true,safe});
   const scope=element('select');scope.setAttribute('aria-label','当前仓库范围');for(const row of detail.scopes){const option=element('option',safe(row.label));option.value=row.repository;scope.append(option);}scope.value=repository;scope.onchange=()=>{repository=scope.value;refresh({scanList:false});};body.append(scope);
   body.append(element('p',safe('当前范围 · '+detail.repository+' · 共 '+detail.effectiveSkillCount+' 个候选技能'),'ar-meta'));
   const inherited=element('p',undefined,'ar-meta'),role=detail.sources.find(source=>source.source==='agent');inherited.append(element('span',!role||role.state==='unavailable'?'继承的技能暂不可读取 · ':'继承 '+role.skills.length+' 个技能 · '));const viewRole=button('查看 Agent Repo',()=>chooseTab(''));viewRole.className='ar-text-action';inherited.append(viewRole);body.append(inherited);if(role?.warning)body.append(element('p',safe(role.warning),'ar-warning'));if(role?.state==='dirty')body.append(element('p','继承的技能有未提交变化，当前使用已提交版本。','ar-warning'));
   const inheritedSubagents=detail.subagentSources?.find(source=>source.source==='agent');if(inheritedSubagents)body.append(element('p',inheritedSubagents.state==='unavailable'?'共享子代理暂不可读取':safe('目录索引 · '+detail.candidateSubagentCount+' 个子代理定义 · 共享 '+inheritedSubagents.subagents.length+' 个，见 Agent Repo'),'ar-meta'));
   const git=detail.inspection.git;body.append(element('p',safe('本地仓库状态 · '+git.state+(git.branch?' · '+git.branch:'')+(git.dirty?' · 有本地修改':'')+(git.branchMatches===false?' · 分支不匹配':'')+(git.remoteMatches===false?' · origin 不匹配':'')),'ar-meta'));
   body.append(element('p','候选索引不代表会话已加载技能正文；Main 和 Worker 仍需选定范围、准备版本并按任务读取。','ar-muted'));
  }
  if(!projectId||detail){skillArea=element('div');body.append(skillArea);renderSkills();}
  const history=syncHistory();if(history)body.append(history);
  body.append(element('p','更新时间来自技能目录最后一次 Git 提交，包含正文、引用及资源变化；子代理更新时间来自定义文件及关联配置最近一次提交；刷新扫描不执行 fetch、pull 或加载。','ar-muted'));
  body.append(element('p',safe('扫描于 '+date(detail?.scannedAt??list.scannedAt)),'ar-meta'));
  for(const node of body.querySelectorAll('details'))if(expanded.has(node.dataset.skillPath))node.open=true;body.scrollTop=scroll;
  if(focusedTab!==undefined)root.querySelectorAll('[role=tab]').forEach(tab=>{if(tab.dataset.tabKey===focusedTab)tab.focus({preventScroll:true});});
 }
 const stopNavigation=subscribeWorkerNavigation(()=>{if(!disposed)render();}),stopHost=context.host.subscribe(()=>{if(disposed)return;const next=target(),read=context.host.connection.canRead,write=context.host.connection.canWrite,changed=next.agentId!==observedTarget.agentId||next.sessionKey!==observedTarget.sessionKey||read!==observedRead||write!==observedWrite;observedTarget=next;observedRead=read;observedWrite=write;if(changed){reset();render();refresh();}});
 render();refresh();
 return {update(next){const before=observedTarget;context=next;const after=target();observedTarget=after;const read=context.host.connection.canRead,write=context.host.connection.canWrite,readChanged=read!==observedRead||write!==observedWrite;observedRead=read;observedWrite=write;if(readChanged||before.agentId!==after.agentId||before.sessionKey!==after.sessionKey)reset();render();if(next.presented)refresh();else {closeScheduleManager();closeMaintenance();closePeople();closeLogDialog(false);closeSyncDialog(false);generation++;}},dispose(){workspaceView?.dispose();workspaceView=null;closeScheduleManager();closeMaintenance();closePeople();closeLogDialog(false);closeSyncDialog(false);disposed=true;generation++;stopNavigation();stopHost();root.remove();}};
}
const managementModules=[
 {id:'overview',label:'概览'},
 {id:'projects',label:'项目与技能',description:'查看项目登记、仓库状态、技能和子代理定义。'},
 {id:'worker',label:'Worker 任务',description:'跨会话查看此 Agent 的任务状态、来源和执行详情。'},
 {id:'entities',label:'实体资料库',description:'统一检索人员、组织、服务与资产，查看 AI 和程序同步的来源。'},
 {id:'tasks',label:'定时任务',description:'管理 OpenClaw 联动群任务，查看仓库同步计划和运行记录。'},
 {id:'logs',label:'日志',description:'统一查看插件与 Worker 日志，按需开启实时调试。'},
];
function mountOverview(container,context,agentId,choose){
 let disposed=false,generation=0,loading=false,results={},loadedAt=null;
 const root=element('section',undefined,'ar-overview');root.setAttribute('aria-label','AgentRepo 运行概览');container.append(root);
 const safe=value=>context.host.redact(String(value??''));
 const sources=[['catalog','list','agent-repo','projects-'],['people','people','agent-repo','projects-'],['entities','entityTypes','agent-repo','projects-'],['logs','repositoryLogs','agent-repo','projects-'],['worker','agentTasks','agent-worker','inspect-'],['maintenance','maintenance','agent-repo','projects-']];
 async function refresh(){
  const epoch=++generation;loading=true;results={};render();
  await Promise.allSettled(sources.map(async([key,action,pluginId,prefix])=>{
   try{
    const value=await readInspectionResponse(async(name,payload)=>{
     context.signal.throwIfAborted();if(disposed||epoch!==generation)throw Error('概览已切换');
     return context.host.request('plugins.sessionAction',{pluginId,actionId:prefix+name,agentId,sessionKey:'agent:'+agentId+':agent-repo-management',payload});
    },action,{});
    if(!disposed&&epoch===generation)results[key]={value};
   }catch(error){if(!disposed&&epoch===generation)results[key]={error:safe(error.message)};}
  }));
  if(disposed||epoch!==generation)return;loading=false;loadedAt=new Date().toISOString();render();
 }
 function render(){
  root.replaceChildren();root.setAttribute('aria-busy',String(loading));
  const catalog=results.catalog?.value,people=results.people?.value,logs=results.logs?.value;
  const heading=element('header',undefined,'ar-overview-heading ar-section-heading'),copy=element('div');copy.append(element('h2','管理概览'),element('p','当前 Agent 的资源、计划与待处理事项。','ar-description'));
  const tools=element('div',undefined,'ar-overview-tools'),refreshButton=button('刷新概览',refresh);refreshButton.disabled=loading;
  const status=element('span',loading?'正在读取…':Object.values(results).some(result=>result.error)?'部分数据不可用':'更新于 '+date(loadedAt),'ar-meta');status.setAttribute('role','status');tools.append(status,refreshButton);heading.append(copy,tools);root.append(heading);
  const metrics=element('div',undefined,'ar-management-metrics');metrics.setAttribute('aria-label','AgentRepo 资源统计');
  const value=(source,count)=>source?.error?'不可读取':source?.value?String(count):'—';
  for(const [label,count,note,module] of [
   ['登记项目',value(results.catalog,catalog?.projects?.length),'已登记在项目清单中的仓库','projects'],
   ['实体资料',value(results.entities,results.entities?.value?.total),'人员、组织、服务与资产统一管理','entities'],
   ['定时任务',value(results.catalog,catalog?.scheduledTasks?.length),'同步与 OpenClaw 联动任务','tasks'],
   ['异常记录',value(results.logs,logs?.records?.length),'最近保留的仓库异常，最多 100 条','logs'],
  ]){
   const card=button('',()=>choose(module));card.className='ar-metric';card.setAttribute('aria-label','打开'+managementModules.find(item=>item.id===module).label);
   card.append(element('span',label,'ar-metric-label'),element('strong',count),element('span',note,'ar-metric-note'));metrics.append(card);
  }root.append(metrics);
  renderWorkerSummary(root,results.worker??{},loading,()=>choose('worker'),safe);
  const columns=element('div',undefined,'ar-overview-columns'),attention=element('section',undefined,'ar-overview-card');attention.append(element('h3','待处理事项'),element('p','基于本次读取结果，不代替完整健康检查。','ar-description'));
  let issues=0;
  const issue=(title,detail,module)=>{issues++;const row=element('div',undefined,'ar-attention-row'),text=element('div');text.append(element('strong',title),element('p',detail));row.append(text,button('查看'+managementModules.find(item=>item.id===module).label,()=>choose(module)));attention.append(row);};
  for(const [key,module,label] of [['catalog','projects','项目清单'],['people','entities','人员资料'],['entities','entities','实体资料'],['logs','logs','日志']])if(results[key]?.error)issue(label+'读取失败',results[key].error,module);
  if(results.maintenance?.error)issue('技能维护状态不可读取',results.maintenance.error,'projects');
  for(const provider of results.maintenance?.value?.providers??[])if(['unavailable','fallback','degraded'].includes(provider.state))issue(safe(provider.label)+'需处理',safe(provider.scope)+' · '+({unavailable:'不可读取',fallback:'正在使用已验证旧版',degraded:'检查或更新失败'})[provider.state],'projects');
  const workerDiagnostics=results.worker?.value?.diagnostics;if(workerDiagnostics?.deliveryUncertain)issue(workerDiagnostics.deliveryUncertain+' 个投递结果待核查','Main 可能已经执行，先查看原任务及事件回执。','worker');if(workerDiagnostics?.awaitingMainOverdue)issue(workerDiagnostics.awaitingMainOverdue+' 个任务等待 Main 超过 30 分钟','等待时间仅用于提醒，不代表任务失败。','worker');
  if(catalog&&!catalog.registrationCommitted)issue('项目登记尚未提交','登记需提交后才能用于正式的项目准备与技能检查。','projects');
  if(people?.stats?.missing?.email)issue(people.stats.missing.email+' 位人员缺少邮箱','可从实体资料库的人员资源查看来源和账号关联。','entities');
  if(people?.stats?.giteaSources?.email_prefix)issue(people.stats.giteaSources.email_prefix+' 个账号关联待核验','邮箱推导的候选账号需要核验后再用于人员归属。','entities');
  if(logs?.records?.length)issue('有 '+logs.records.length+' 条保留的异常记录','历史记录可能已处理，请结合时间与原因判断。','logs');
  if(!issues)attention.append(element('p',loading?'正在检查待处理事项…':'本次读取未发现上述待处理事项。','ar-empty-note'));
  const resources=element('section',undefined,'ar-overview-card');resources.append(element('h3','工作区与计划'));
  const info=(label,value)=>{const row=element('div',undefined,'ar-overview-info');row.append(element('span',label),element('span',safe(value)));resources.append(row);};
  info('Agent 工作区',catalog?.root??(results.catalog?.error?'不可读取':'读取中…'));
  info('项目登记',catalog?(catalog.registrationCommitted?'已提交':'待提交'):'—');
  const source=catalog?.agentSkills;
  info('角色技能',source?.state==='unavailable'?'不可扫描':source?source.skills.length+' 项 · 不含项目技能':'—');
  const tasks=catalog?.scheduledTasks;
  info('定时任务',tasks?(tasks.length?tasks.filter(task=>task.enabled).length+' 项启用 / '+tasks.length+' 项总计':'尚未配置定时计划'):'—');
  resources.append(element('p','这里只读取状态；刷新不会拉取仓库、执行任务或同步飞书人员。','ar-description'));columns.append(attention,resources);root.append(columns);
  const shortcuts=element('section',undefined,'ar-overview-shortcuts');shortcuts.append(element('h3','管理模块'));
  const rows=element('div',undefined,'ar-management-cards');
  for(const item of managementModules.slice(1)){const card=element('section'),copy=element('div');copy.append(element('h4',item.label),element('p',item.description));card.append(copy,button('打开'+item.label,()=>choose(item.id)));rows.append(card);}shortcuts.append(rows);root.append(shortcuts);
 }
 refresh();return {dispose(){disposed=true;generation++;root.remove();}};
}
export function mountAgentRepo(container,initial){
 let context=initial,disposed=false,child=null,agentId='',section='overview',read,write,presented,routeSection=initial.props.section;
 const root=element('section',undefined,'ar-management');root.setAttribute('aria-label','AgentRepo 管理中心');container.append(root);
 const selected=()=>currentUiTarget({...context,props:{agentId:context.props.agentId}}).agentId;
 const safe=value=>context.host.redact(String(value??''));
 const childContext=()=>({...context,props:{agentId,sessionKey:'agent:'+agentId+':agent-repo-management',managementSection:section,embeddedManagement:true}});
 const regionId='ar-management-content-'+(++panelSequence);
 function renderBody(){
  child?.dispose();child=null;const body=root.querySelector('.ar-management-body');if(!body)return;
  body.replaceChildren();root.dataset.section=section;body.setAttribute('aria-label',managementModules.find(item=>item.id===section).label+'内容');
  for(const tab of root.querySelectorAll('.ar-management-nav button'))tab.setAttribute('aria-current',tab.dataset.section===section?'page':'false');
  if(section==='overview')child=mountOverview(body,context,agentId,choose);
  else child=section==='worker'?mountWorkerPage(body,context,agentId):section==='entities'?mountEntitiesPage(body,childContext()):mountProjects(body,childContext());
 }
 function choose(id){if(section===id)return;section=id;renderBody();}
 function render(){
  child?.dispose();child=null;root.replaceChildren();root.dataset.section=section;
  const header=element('header',undefined,'ar-management-header'),heading=element('div');heading.append(element('h1','AgentRepo'));
  const picker=element('select');picker.setAttribute('aria-label','AgentRepo 所属 Agent');const agents=context.host.agents.rows??[];
  for(const agent of agents){const option=element('option',safe(agent.name??agent.id));option.value=agent.id;picker.append(option);}
  if(agentId&&!agents.some(agent=>agent.id===agentId)){const option=element('option',safe(agentId));option.value=agentId;picker.append(option);}
  picker.value=agentId;picker.onchange=()=>{const id=picker.value;context.host.agents.select(id);if(context.props.agentId)context.host.navigation.openPage({id:'management',params:{agentId:id,section}});};const agentControl=element('label',undefined,'ar-management-agent');agentControl.append(element('span','当前 Agent'),picker);header.append(heading,agentControl);root.append(header);
  if(!context.presented)return;
  if(!read){root.append(element('p','需要 operator.read 权限才能查看 AgentRepo。','ar-error'));return;}
  if(!agentId){root.append(element('p','请先选择一个 Agent。'));return;}
  const nav=element('nav',undefined,'ar-management-nav');nav.setAttribute('aria-label','AgentRepo 功能模块');
  for(const item of managementModules){const tab=button(item.label,()=>choose(item.id));tab.dataset.section=item.id;tab.setAttribute('aria-controls',regionId);tab.setAttribute('aria-current',section===item.id?'page':'false');nav.append(tab);}root.append(nav);
  const body=element('div',undefined,'ar-management-body');body.id=regionId;body.setAttribute('role','region');root.append(body);renderBody();
 }
 function update(next){
  if(disposed)return;context=next;const id=selected(),newRead=context.host.connection.canRead,newWrite=context.host.connection.canWrite,newPresented=context.presented;
  const routeChanged=context.props.section!==routeSection;routeSection=context.props.section;if(routeChanged&&routeSection==='people')section='entities';if(routeChanged&&managementModules.some(item=>item.id===routeSection))section=routeSection;
  if(routeChanged||id!==agentId||read!==newRead||write!==newWrite||presented!==newPresented){agentId=id;read=newRead;write=newWrite;presented=newPresented;render();}
 }
 if(context.props.section==='people')section='entities';
 if(managementModules.some(item=>item.id===context.props.section))section=context.props.section;
 const stop=context.host.subscribe(()=>update(context));update(initial);
 return {update,dispose(){disposed=true;child?.dispose();stop();root.remove();}};
}
export {mountPeoplePage};
export default {id:'agent-repo',activate(host){
 const panel=host.ui.registerPanel({id:'projects',label:'项目、技能与子代理',mount:mountProjects});
 const page=host.ui.registerPage({id:'people',label:'飞书人员管理',mount:mountPeoplePage});
 const entities=host.ui.registerPage({id:'entities',label:'实体资料库',mount:mountEntitiesPage});
 const management=host.ui.registerPage({id:'management',label:'AgentRepo',mount:mountAgentRepo});
 const navigation=host.ui.registerNavigation({id:'agent-repo',label:'AgentRepo',page:{id:'management'},icon:'folder',order:60,defaultVisible:true});
 return ()=>{navigation();management();entities();page();panel();};
}};
