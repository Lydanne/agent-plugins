import {readInspectionResponse} from './dist/inspection-transport.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const button=(label,run)=>{const n=el('button',label);n.type='button';n.onclick=run;return n;};
export const auditFeatures={recycle:'回收站',schedules:'定时任务',entities:'实体与人员',workspace:'工作区',skills:'技能维护',logs:'日志管理'};
const statuses={accepted:'已受理，执行结果另查',failed:'失败',pending:'处理中或中断待核验',succeeded:'成功',unknown:'结果待核验'};
const actions={restore:'恢复',purge:'到期永久清理',configureRetention:'修改回收站保留期限',create:'创建',update:'修改',pause:'停止',resume:'开始',remove:'删除',run:'立即执行',workspacePoolSave:'保存工作区配置',maintenanceRun:'技能维护',syncPeople:'请求人员同步',updatePerson:'更正人员',deletePerson:'删除人员',clearRepositoryLogs:'清空仓库日志',diagnosticClearHistory:'清空历史日志'};
const fields={name:'名称',schedule:'执行时间与时区',status:'状态',deliveryMode:'投递位置',jobId:'原生任务 ID',revision:'版本',enabled:'启用',maxSize:'工作区容量'};
const display=v=>v===null||v===undefined?'未记录':typeof v==='object'?JSON.stringify(v):String(({source:'原请求位置',group:'群主会话',thread:'原请求话题'})[v]??v);
export function mountAudit(container,{invoke,safe=v=>String(v??''),feature='',targetId='',onClose}={}){
 let disposed=false,epoch=0,offset=0,page=null,error='',loading=false,filters={feature,targetId};
 const root=el('section',undefined,'ar-audit');root.setAttribute('aria-label','审计记录');container.append(root);
 const query=async()=>{const request=++epoch;loading=true;error='';render();try{const result=await invoke('audit',{...Object.fromEntries(Object.entries(filters).filter(([,v])=>v!=='')),limit:25,offset});if(disposed||request!==epoch)return;page=result;}catch(e){if(disposed||request!==epoch)return;error=safe(e.message);}loading=false;render();};
 function render(){
  root.replaceChildren();root.setAttribute('aria-busy',String(loading));const header=el('header',undefined,'ar-section-heading'),copy=el('div');copy.append(el('h2',targetId?'修改日志':'审计'),el('p','查看发起人、执行入口、修改前后值和操作结果。'));header.append(copy,button('刷新审计',query));if(onClose)header.append(button('关闭',onClose));root.append(header);
  const form=el('form',undefined,'ar-audit-filters');const controls={};
  const select=(name,label,options,value)=>{const field=el('label',label),input=el('select');input.setAttribute('aria-label',label);for(const [v,text] of options){const option=el('option',text);option.value=v;input.append(option);}input.value=value??'';field.append(input);form.append(field);controls[name]=input;};
  select('feature','功能',[['','全部功能'],...Object.entries(auditFeatures)],filters.feature);controls.feature.disabled=!!feature;
  select('status','操作结果',[['','全部结果'],...Object.entries(statuses)],filters.status);
  for(const [name,label,type] of [['actorId','发起人 ID','text'],['action','操作类型','text'],['targetId','对象 ID','text'],['from','开始时间','datetime-local'],['to','结束时间','datetime-local']]){const field=el('label',label),input=el('input');input.type=type;input.setAttribute('aria-label',label);input.value=filters[name]?(type==='datetime-local'?new Date(filters[name]-new Date(filters[name]).getTimezoneOffset()*60000).toISOString().slice(0,16):filters[name]):'';if(name==='targetId'&&targetId)input.disabled=true;field.append(input);form.append(field);controls[name]=input;}
  const submit=el('button','筛选');submit.type='submit';submit.disabled=loading;form.append(submit);form.onsubmit=e=>{e.preventDefault();filters=Object.fromEntries(Object.entries(controls).map(([k,n])=>[k,['from','to'].includes(k)&&n.value?new Date(n.value).getTime():n.value]));offset=0;page=null;query();};root.append(form);
  root.append(el('p',safe(page?.notice??'审计自启用后记录。旧记录缺失的实名、指派依据和前后值不可推测补全。成功仅表示管理操作完成。'),'ar-muted'));
  if(page?.unavailable?.length)root.append(el('p','部分来源不可读取：'+safe(page.unavailable.join('、')),'ar-warning'));
  if(error){root.append(el('p',error,'ar-error'));return;}
  if(loading){root.append(el('p','正在读取审计…'));return;}
  root.append(el('p',`共 ${page?.total??0} 条审计记录`));if(!page?.records?.length)root.append(el('p','此筛选范围暂无审计记录。'));
  for(const r of page?.records??[]){const row=el('details',undefined,'ar-audit-record'),summary=el('summary');summary.textContent=safe(new Date(r.at).toLocaleString()+' · '+(actions[r.action]??r.action)+' · '+r.targetName+' · '+(statuses[r.status]??r.status));row.append(summary);
   const data=el('dl');for(const [label,value] of [['发起指派',r.actor?.name??r.actor?.id??(r.actor?.kind==='system'?'系统':'身份未记录')],['发起人 ID',r.actor?.id],['身份说明',r.actor?.identityNote],['执行入口',r.executor],['来源账号',r.actor?.accountId],['来源群',r.actor?.chatId],['指派消息',r.actor?.messageIds],['请求 ID',r.requestId],['对象 ID',r.targetId],['审计 ID',r.id]]){data.append(el('dt',label),el('dd',safe(display(value))));}row.append(el('p',safe('发起指派：'+(r.actor?.name??r.actor?.id??'身份未记录')+' · 执行入口：'+(r.executor??'未记录'))));const evidence=el('details');evidence.append(el('summary','来源与指派依据'),data);
   if(r.changes?.length){const table=el('table'),head=el('tr');for(const label of ['字段','修改前','修改后'])head.append(el('th',label));table.append(head);for(const c of r.changes){const tr=el('tr');for(const value of [fields[c.field]??c.field,display(c.before),display(c.after)])tr.append(el('td',safe(value)));table.append(tr);}row.append(table);}else row.append(el('p',r.status==='pending'?'操作尚未取得结果，待核验。':'未记录字段变化；立即执行等动作可能不修改配置。'));
   if(r.status!=='succeeded')row.append(el('p','以下是已保存状态的变化，不能据此推断原生写入或业务执行成功。','ar-warning'));
   if(r.requested&&Object.keys(r.requested).length){row.append(el('h4','请求修改内容'),el('pre',safe(JSON.stringify(r.requested,null,2))));}row.append(evidence);root.append(row);
  }
  const nav=el('div',undefined,'ar-audit-pagination');if(offset)nav.append(button('上一页',()=>{offset=Math.max(0,offset-25);query();}));if(page?.nextOffset!==null&&page?.nextOffset!==undefined)nav.append(button('下一页',()=>{offset=page.nextOffset;query();}));root.append(nav);
 }
 query();return {dispose(){disposed=true;epoch++;root.remove();}};
}
export function mountAuditPage(container,context,agentId,filter={}){
 const invoke=(action,payload)=>readInspectionResponse((name,data)=>{context.signal.throwIfAborted();return context.host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+name,agentId,sessionKey:'agent:'+agentId+':agent-repo-management',payload:data});},action,payload);
 return mountAudit(container,{invoke,safe:value=>context.host.redact(String(value??'')),...filter});
}
