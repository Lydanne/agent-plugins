import {readInspectionResponse} from './dist/inspection-transport.mjs';
import {canOpenWorkerProject,openWorkerTask,subscribeWorkerNavigation} from './dist/ui-navigation.mjs';
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const button=(text,action)=>{const node=el('button',text);node.type='button';node.onclick=action;return node;};
const labels={running:'运行中',queued:'排队中',awaiting_main:'等待 Main',awaiting_user:'等待用户',completed:'已完成',failed:'失败',timed_out:'超时',cancelled:'已取消',cancelling:'取消中',unknown:'状态待核实'};
export function renderWorkerSummary(container,{value,error},loading,open,safe=String){
 const block=el('section',undefined,'ar-worker-summary ar-overview-card'),header=el('header');header.append(el('h3','Worker 任务'));if(open)header.append(button('查看全部任务',open));block.append(header);
 if(error){const message=el('p','Agent Worker 暂不可读取：'+safe(error),'ar-error');message.setAttribute('role','alert');block.append(message);}
 else if(!value)block.append(el('p',loading?'正在读取 Worker 任务…':'Worker 任务尚未读取','ar-description'));
 else{
  block.append(el('p',value.taskTotal+' 个可归属任务 · '+value.conversationTotal+' 个来源会话 · 当前 Agent 全部会话','ar-description'));
  const counts=value.counts,metrics=el('div',undefined,'ar-worker-metrics');
  for(const [label,count] of [['运行中',counts.running],['排队中',counts.queued],['等待 Main',counts.awaiting_main],['等待用户',counts.awaiting_user],['已完成',counts.completed],['失败 / 超时',counts.failed+counts.timed_out]]){const item=el('div');item.append(el('strong',String(count)),el('span',label));metrics.append(item);}block.append(metrics);
  if(counts.unknown)block.append(el('p',counts.unknown+' 个任务状态待核实，不能视为仍在执行。','ar-warning'));
  block.append(el('p',safe(value.coverage),'ar-description'));
 }container.append(block);
}
export function mountWorkerPage(container,context,agentId){
 let disposed=false,generation=0,data=null,error='',loading=false,projectId='',status='',query='',offset=0;
 const root=el('section',undefined,'ar-worker-page');root.setAttribute('aria-label','Agent Worker 任务管理');container.append(root);
 const safe=value=>context.host.redact(String(value??''));
 async function refresh(){
  const epoch=++generation;loading=true;error='';data=null;render();
  try{
   const result=await readInspectionResponse((action,payload)=>{
    context.signal.throwIfAborted();if(disposed||epoch!==generation)throw Error('Worker 任务页面已切换');
    return context.host.request('plugins.sessionAction',{pluginId:'agent-worker',actionId:'inspect-'+action,agentId,sessionKey:'agent:'+agentId+':agent-repo-management',payload});
   },'agentTasks',{...(projectId?{projectId}:{}),...(status?{status}:{}),query,offset,limit:20});
   if(disposed||epoch!==generation)return;data=result;
  }catch(failure){if(disposed||epoch!==generation)return;error=safe(failure.message);}
  loading=false;render();
 }
 function render(){
  root.replaceChildren();root.setAttribute('aria-busy',String(loading));
  const header=el('header',undefined,'ar-overview-heading'),copy=el('div');copy.append(el('h2','Worker 任务'),el('p','查看此 Agent 跨会话的委派任务；执行与历史由 agent-worker 维护。','ar-description'));const refreshButton=button('刷新任务',refresh);refreshButton.disabled=loading;header.append(copy,refreshButton);root.append(header);
  renderWorkerSummary(root,{value:data,error},loading,null,safe);
  const form=el('form',undefined,'ar-worker-filters');
  const select=(label,options,value,change)=>{const wrap=el('label'),input=el('select');input.setAttribute('aria-label',label);wrap.append(el('span',label),input);for(const [key,text] of options){const option=el('option',text);option.value=key;input.append(option);}input.value=value;input.onchange=()=>{change(input.value);offset=0;refresh();};form.append(wrap);};
  select('Worker 项目',[['','所有项目'],...[...new Set([...(data?.projectIds??[]),projectId].filter(Boolean))].map(id=>[id,safe(id)])],projectId,value=>{projectId=value;});
  select('Worker 状态',[['','全部状态'],...Object.entries(labels)],status,value=>{status=value;});
  const search=el('input');search.type='search';search.value=query;search.placeholder='搜索主题、任务摘要或 ID';search.setAttribute('aria-label','搜索 Worker 任务');form.append(search);const submit=el('button','搜索');submit.type='submit';form.append(submit);form.onsubmit=event=>{event.preventDefault();query=search.value;offset=0;refresh();};root.append(form);
  if(!data)return;
  const meta=el('p',safe('匹配 '+data.total+' 个任务 · 统计按项目计算，不随状态和搜索过滤 · 更新于 '+new Date(data.scannedAt).toLocaleString()),'ar-description');meta.setAttribute('role','status');root.append(meta);
  if(!data.tasks.length){root.append(el('p','当前筛选下没有可归属的 Worker 任务。','ar-empty-note'));return;}
  const wrap=el('div',undefined,'ar-worker-table-wrap'),table=el('table',undefined,'ar-worker-table');table.append(el('caption','Worker 任务列表'));const head=el('thead'),tr=el('tr');for(const label of ['任务 / 主题','项目','状态','来源会话','创建时间','操作'])tr.append(el('th',label));head.append(tr);table.append(head);const body=el('tbody');
  for(const task of data.tasks){const row=el('tr'),name=el('td'),topic=el('strong',safe(task.topic));name.append(topic,el('code',safe(task.jobId.slice(0,8)),'ar-worker-task-id'),el('p',safe(task.taskSummary??'未保存任务摘要'),'ar-description'));name.title=safe(task.jobId);row.append(name,el('td',safe(task.projectId??'未绑定项目')),el('td',labels[task.status]??'状态待核实'));
   const scope=el('td',safe(task.sessionKey.replace('agent:'+agentId+':','')));scope.title=safe(task.sessionKey);row.append(scope,el('td',new Date(task.createdAt).toLocaleString()));
   const action=el('td'),open=button('查看详情',()=>{try{openWorkerTask({agentId,...task});}catch(failure){error=safe(failure.message);render();}});open.disabled=!canOpenWorkerProject();if(open.disabled)open.title='Agent Worker 页面尚未加载，请检查插件 UI 是否启用';action.append(open);row.append(action);body.append(row);
  }table.append(body);wrap.append(table);root.append(wrap);
  const pager=el('div',undefined,'ar-worker-pager'),previous=button('上一页',()=>{offset=Math.max(0,offset-20);refresh();}),next=button('下一页',()=>{offset+=20;refresh();});previous.disabled=offset===0;next.disabled=!data.hasMore;pager.append(previous,el('span','第 '+(Math.floor(offset/20)+1)+' 页'),next);root.append(pager);
 }
 const stop=subscribeWorkerNavigation(()=>{if(!disposed)render();});refresh();return {dispose(){disposed=true;generation++;stop();root.remove();}};
}
