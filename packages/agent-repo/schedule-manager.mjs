const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const labels={create:'新建任务',update:'保存设置',pause:'暂停',resume:'启用',remove:'删除',run:'立即执行'};
const status={enabled:'已启用',paused:'已暂停',removed:'已删除',completed:'已结束',blocked:'来源失效',needs_review:'待核验',creating:'创建中'};
export function mountScheduleManager(container,{invoke,canWrite,safe,onClose,onChanged}){
 let disposed=false,epoch=0,data=null,selected=null,creating=false,loading=false,busy=false,error='',notice='',confirmation=null;
 const dialog=el('dialog',undefined,'ar-sync-dialog ar-schedule-manager');dialog.setAttribute('aria-label','管理定时任务');container.append(dialog);
 const button=(text,fn)=>{const n=el('button',text);n.type='button';n.onclick=fn;return n;};
 const close=()=>{dispose();onClose?.();};dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 function dispose(){disposed=true;epoch++;if(dialog.open)dialog.close();dialog.remove();}
 async function refresh(){const token=++epoch;loading=true;render();try{const next=await invoke('scheduleCatalog',{});if(disposed||token!==epoch)return;data=next;}catch(e){if(disposed||token!==epoch)return;error=safe(e.message);}loading=false;render();}
 function confirm(action,task,fields={}){confirmation={action,...(action==='create'?{sourceId:task.id}:{id:task.id}),expectedRevision:task.revision,requestId:crypto.randomUUID(),confirmed:true,...fields};error='';render();}
 async function execute(){if(busy||!canWrite()||!confirmation)return;const input=confirmation,token=epoch;busy=true;render();try{const r=await invoke('scheduleManage',input);if(disposed||token!==epoch)return;confirmation=null;notice=r.status==='succeeded'?(input.action==='run'?(r.skipped?'今日同步已由其他触发接纳，未重复入队。':'已提交 OpenClaw 原生队列；请在执行记录核验实际结果。'):input.action==='create'?'已创建，默认暂停。确认计划后启用。':'操作已完成。'):'操作结果待核验，请查看操作记录，不要重复提交。';selected=r.id??selected;creating=false;await onChanged?.();}catch(e){if(disposed||token!==epoch)return;error=safe(e.message);confirmation=null;}finally{if(!disposed&&token===epoch){busy=false;await refresh();}}}
 function field(form,label,value,type='text'){const wrap=el('label',label),n=el('input');n.type=type;n.value=value??'';n.setAttribute('aria-label',label);n.disabled=busy||!canWrite();wrap.append(n);form.append(wrap);return n;}
 function editor(body,task){
  const form=el('form',undefined,'ar-schedule-form');if(task?.kind==='repository-sync'&&!creating){systemEditor(body,form,task);return;}form.append(el('p','原请求人、群、项目、任务内容和授权范围继承自已保存的有效群请求，不能在面板改写。','ar-muted'));
  let source=task;
  if(creating){const label=el('label','来源群请求'),select=el('select');select.setAttribute('aria-label','来源群请求');for(const t of data.tasks.filter(t=>t.kind!=='repository-sync'&&t.sourceValid&&!t.busy&&['enabled','paused','completed','removed'].includes(t.status))){const option=el('option',safe(t.name+' · '+t.requester+' · '+t.chatId));option.value=t.id;select.append(option);}select.value=selected??select.options[0]?.value??'';source=data.tasks.find(t=>t.id===select.value);select.onchange=()=>{selected=select.value;render();};label.append(select);form.append(label);}
  if(!source){form.append(el('p','暂无有效的已保存群请求。请先由真人在群里向 Main 创建计划。'));body.append(form);return;}
  form.append(el('p',safe('原群：'+source.chatId+' · 原请求人：'+source.requester+' · 项目：'+source.projectId)));
  const details=el('details');details.append(el('summary','查看任务内容与授权范围'),el('pre',safe(source.task),'ar-schedule-task'),el('pre',safe(source.constraints),'ar-schedule-task'));form.append(details);
  const name=field(form,'任务名称',creating?source.name+'（新计划）':source.name);
  const kindLabel=el('label','计划类型'),kind=el('select');kind.setAttribute('aria-label','计划类型');for(const [v,l] of [['cron','周期计划'],['at','一次性计划']]){const o=el('option',l);o.value=v;kind.append(o);}kind.value=source.schedule.kind;kindLabel.append(kind);form.append(kindLabel);
  const expr=field(form,'Cron（五字段）',source.schedule.expr??'0 9 * * *'),tz=field(form,'时区',source.schedule.tz??'Asia/Shanghai'),at=field(form,'执行时间（含时区）',source.schedule.at??'');at.placeholder='2026-10-23T09:00:00+08:00';
  const show=()=>{expr.parentElement.hidden=tz.parentElement.hidden=kind.value!=='cron';at.parentElement.hidden=kind.value!=='at';};kind.onchange=show;show();
  const save=el('button',creating?'创建暂停的任务':'保存设置');save.type='submit';save.disabled=busy||!canWrite()||!source.sourceValid||source.busy||(!creating&&!['enabled','paused'].includes(source.status));form.append(save);
  form.onsubmit=e=>{e.preventDefault();confirm(creating?'create':'update',source,{name:name.value.trim(),...(kind.value==='at'?{at:at.value.trim()}:{expr:expr.value.trim(),timeZone:tz.value.trim()})});};body.append(form);
 }
 function systemEditor(body,form,task){
  form.append(el('p','同步范围固定为当前 Agent 及全部登记项目。每日只尝试一次，手动执行也遵守今日去重。','ar-muted'));
  if(task.alreadyAttempted)form.append(el('p','今日已有尝试记录；请查看执行记录，今天不会重复同步。','ar-warning'));
  form.append(el('p',safe(task.constraints)));
  const time=field(form,'每日执行时间',task.schedule.time,'time'),zone=field(form,'时区',task.schedule.tz);
  const save=el('button','保存设置');save.type='submit';save.disabled=busy||!canWrite()||!task.sourceValid||task.busy||!['enabled','paused'].includes(task.status);form.append(save);
  form.onsubmit=e=>{e.preventDefault();confirm('update',task,{time:time.value,timeZone:zone.value.trim()});};body.append(form);
 }
 function render(){
  if(disposed)return;dialog.replaceChildren();const header=el('header',undefined,'ar-sync-dialog-header');header.append(el('h2','管理定时任务'),button('关闭',close));dialog.append(header);const body=el('div',undefined,'ar-sync-dialog-body');dialog.append(body);
  if(error)body.append(el('p',error,'ar-error'));if(notice)body.append(el('p',notice,'ar-notice'));
  if(loading)body.append(el('p','正在读取…'));if(!data)return;if(!data.available){body.append(el('p','定时任务服务不可用。'));return;}
  if(!canWrite())body.append(el('p','当前连接只读；管理操作需要写入权限。','ar-muted'));
  if(confirmation){const t=data.tasks.find(t=>t.id===(confirmation.id??confirmation.sourceId));body.append(el('h3','确认'+labels[confirmation.action]),el('p',safe(t?.name+(t?.kind==='repository-sync'?' · 当前 Agent 全部登记项目':' · 原群 '+t?.chatId))),el('pre',safe(JSON.stringify({name:confirmation.name,expr:confirmation.expr,timeZone:confirmation.timeZone,time:confirmation.time,at:confirmation.at},null,2))));body.append(el('p',confirmation.action==='run'?(t?.kind==='repository-sync'?'通过 OpenClaw 执行今日同步；当天已尝试则跳过，不改变下一次计划。':'将立即在原群执行并回复；不会改变下一次计划时间。'):confirmation.action==='remove'?'删除 OpenClaw 计划并保留执行历史；已运行任务不因此回滚。':confirmation.action==='pause'?'阻止后续触发；已运行任务需另行核验。':'通过 OpenClaw 原生调度保存此计划。'));const yes=button(busy?'正在提交…':'确认执行',execute);yes.disabled=busy||!canWrite();const no=button('取消',()=>{confirmation=null;render();});no.disabled=busy;body.append(yes,no);return;}
  const toolbar=el('div',undefined,'ar-schedule-actions');const add=button('基于群请求新建',()=>{creating=true;selected=null;notice='';render();});add.disabled=busy||!canWrite();const reload=button('刷新',()=>{error='';refresh();});reload.disabled=busy;toolbar.append(add,reload);body.append(toolbar);
  const tasks=el('div',undefined,'ar-schedule-choices');for(const t of data.tasks){const b=button(safe(t.name+' · '+(status[t.status]??t.status)),()=>{selected=t.id;creating=false;notice='';render();});b.disabled=busy;if(selected===t.id&&!creating)b.setAttribute('aria-current','true');tasks.append(b);}body.append(tasks);
  const task=data.tasks.find(t=>t.id===selected);
  if(task&&!creating){body.append(el('h3',safe(task.name)));if(task.nativeWarning)body.append(el('p',safe(task.nativeWarning),'ar-warning'));if(task.busy)body.append(el('p','已有运行中、排队或结果待核验的记录，不能重复执行或编辑。','ar-warning'));if(!task.sourceValid)body.append(el('p',task.kind==='repository-sync'?'部署配置未授权仓库同步。只能暂停或删除。':'原群请求已失效。只能暂停或删除。','ar-warning'));const actions=el('div',undefined,'ar-schedule-actions');for(const action of ['run',task.status==='enabled'?'pause':'resume','remove']){const b=button(labels[action],()=>confirm(action,task));b.disabled=busy||!canWrite()||(task.status==='removed'&&!(task.kind==='repository-sync'&&action==='resume'))||(['run','resume'].includes(action)&&(!task.sourceValid||task.busy||!['enabled','paused',...(task.kind==='repository-sync'&&action==='resume'?['removed']:[])].includes(task.status)))||(action==='run'&&(!(task.canRun??data.canRun)||task.status!=='enabled'));actions.append(b);}body.append(actions);}
  if(creating||task)editor(body,task);
  const audit=el('section');audit.append(el('h3','最近管理操作'));for(const o of data.operations??[])audit.append(el('p',safe(new Date(o.createdAt).toLocaleString()+' · '+(labels[o.action]??o.action)+' · '+({succeeded:'成功',unknown:'结果待核验',pending:'处理中或中断待核验'}[o.status]??o.status))));body.append(audit);
 }
 render();dialog.showModal();refresh();return {dispose};
}
