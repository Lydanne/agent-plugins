import {mountAuditPage} from './audit-page.mjs';
import {mountPeoplePage} from './people-page.mjs';
import {readInspectionResponse} from './dist/inspection-transport.mjs';
import {currentUiTarget} from './dist/ui-navigation.mjs';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
const button=(text,action,cls)=>{const node=el('button',text,cls);node.type='button';node.onclick=action;return node;};
const kinds={channel:'渠道采集',program:'程序同步',ai:'AI 同步',manual:'人工维护'};
export function mountEntitiesPage(container,initial){
 let context=initial,disposed=false,generation=0,agentId='',read,write,presented,types=[],sources=[],page=null,selected=null,typeId='',query='',source='',offset=0,loading=false,error='',people=null,personMode=false,syncInfo=null,syncBusy=false,syncRequestId=null,accountId='';
 const root=el('section',undefined,'ar-entities');root.setAttribute('aria-label','Agent 实体资料库');container.append(root);
 let auditView=null,auditDialog=null;
 function closeAudit(){auditView?.dispose();auditView=null;auditDialog?.remove();auditDialog=null;}
 function openAudit(targetId=''){closeAudit();auditDialog=el('dialog',undefined,'ar-sync-dialog');container.append(auditDialog);auditView=mountAuditPage(auditDialog,context,agentId,{feature:'entities',targetId,onClose:closeAudit});auditDialog.addEventListener('cancel',e=>{e.preventDefault();closeAudit();});auditDialog.showModal();}
 const safe=value=>context.host.redact(String(value??''));
 const owner=()=>currentUiTarget({...context,props:{agentId:context.props.agentId}}).agentId;
 async function invoke(action,payload,epoch){
  return readInspectionResponse(async(name,data)=>{context.signal.throwIfAborted();if(disposed||epoch!==generation||!context.presented||!context.host.connection.canRead)throw Error('实体资料库已切换');return context.host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+name,agentId,sessionKey:'agent:'+agentId+':agent-repo-entities',payload:data});},action,payload);
 }
 async function refresh(){
  if(disposed||!presented||!read||!agentId||personMode)return;
  const epoch=++generation;loading=true;error='';page=null;selected=null;render();
  try{
   try{const info=await invoke('directorySyncInfo',accountId?{accountId}:{},epoch);if(disposed||epoch!==generation)return;syncInfo=Array.isArray(info.accounts)?info:null;if(!accountId&&info.accounts?.length===1)accountId=info.accounts[0].accountId;}catch{syncInfo={available:false,accounts:[],run:null,reason:'组织同步状态读取失败'};}
   const [catalog,next]=await Promise.all([invoke('entityTypes',{},epoch),invoke('entities',{...(typeId?{typeId}:{}),...(query.trim()?{query:query.trim()}:{}),...(source.trim()?{source:source.trim()}:{}),offset,limit:20},epoch)]);
   if(disposed||epoch!==generation)return;types=catalog.types;sources=catalog.sources??[...new Set(next.entities.map(record=>record.source.namespace))].map(namespace=>({namespace}));page=next;selected=page.entities[0]??null;
  }catch(failure){if(disposed||epoch!==generation)return;error=safe(failure.message);}
  loading=false;render();
 }
 async function syncDirectory(){if(syncBusy||!write||!syncInfo?.available)return;const epoch=generation;syncRequestId??=crypto.randomUUID();syncBusy=true;render();try{const run=await invoke('directorySync',{...(accountId?{accountId}:{}),requestId:syncRequestId},epoch);if(disposed||epoch!==generation)return;syncInfo={...syncInfo,run};syncRequestId=null;}catch(failure){if(!disposed&&epoch===generation)error=safe(failure.message);}finally{if(!disposed&&epoch===generation){syncBusy=false;render();}}}
 function openPeople(){generation++;personMode=true;render();}
 function render(){
  people?.dispose();people=null;root.replaceChildren();root.setAttribute('aria-busy',String(loading));
  const header=el('header',undefined,'ar-entities-header'+(context.props.embeddedManagement?' ar-section-heading':'')),copy=el('div');copy.append(el(context.props.embeddedManagement?'h2':'h1','实体资料库'),el('p','AI 与程序共同维护的结构化资料，按类型组织，跨会话查询。'));header.append(copy,button('查看审计',()=>openAudit()));root.append(header);
  if(!presented)return;if(!read){root.append(el('p','需要 operator.read 权限才能查看实体资料库。','ar-error'));return;}if(!agentId){root.append(el('p','请先选择一个 Agent。'));return;}
  if(!context.props.embeddedManagement){const picker=el('select');picker.setAttribute('aria-label','实体资料库所属 Agent');for(const agent of context.host.agents.rows??[{id:agentId}]){const option=el('option',safe(agent.name??agent.id));option.value=agent.id;picker.append(option);}picker.value=agentId;picker.onchange=()=>{context.host.agents.select(picker.value);if(context.props.agentId)context.host.navigation.openPage({id:'entities',params:{agentId:picker.value}});};header.append(picker);}
  if(!context.props.embeddedManagement)root.append(el('p',safe('Agent '+agentId+' · 跨会话共享 · 与其他 Agent 隔离'),'ar-meta'));
  if(personMode){root.append(button('返回实体资料库',()=>{personMode=false;refresh();},'ar-entities-back'));const body=el('div');root.append(body);people=mountPeoplePage(body,{...context,props:{agentId,embeddedManagement:true}});return;}
  const toolbar=el('form',undefined,'ar-entities-toolbar'),search=el('input'),sourceInput=el('select');search.setAttribute('aria-label','搜索实体');search.placeholder='搜索名称、摘要或属性';search.value=query;sourceInput.setAttribute('aria-label','实体来源');for(const item of [{namespace:'',label:'全部来源'},...sources]){const option=el('option',item.label??safe(item.namespace==='feishu'?'飞书':item.namespace));option.value=item.namespace;sourceInput.append(option);}sourceInput.value=source;
  const submit=el('button','搜索'),reload=button('刷新资料',refresh);submit.type='submit';submit.disabled=loading;reload.disabled=loading;
  toolbar.onsubmit=event=>{event.preventDefault();query=search.value;source=sourceInput.value;offset=0;refresh();};toolbar.append(search,sourceInput,submit);if(context.props.embeddedManagement)header.append(reload);else toolbar.append(reload);root.append(toolbar);
  if(syncInfo){const section=el('section',undefined,'ar-entities-sync');section.append(el('strong','飞书组织与部门目录'));const accounts=syncInfo.accounts??[];
   if(accounts.length>1){const selector=el('select');selector.setAttribute('aria-label','组织同步飞书账号');for(const item of [{accountId:'',label:'选择飞书账号'},...accounts]){const option=el('option',safe(item.label??item.accountId));option.value=item.accountId;selector.append(option);}selector.value=accountId;selector.onchange=()=>{accountId=selector.value;syncRequestId=null;refresh();};section.append(selector);}
   if(syncInfo.automatic){const a=syncInfo.automatic,when=v=>v?new Date(v).toLocaleString():'暂无';section.append(el('p',safe('自动同步'+(a.enabled?'已启用':'已关闭')+' · 待处理 '+a.pending+' · 部门事件'+(a.eventSubscription==='observed'?'已收到':'订阅待验证'))));section.append(el('p',safe('上次完整校准：'+when(a.lastFullSuccessAt)+' · 组织更新：'+when(a.lastOrganizationSuccessAt))));if(a.missingDepartmentIds?.length)section.append(el('p',safe(a.missingDepartmentIds.length+' 个部门本次未发现，已保留历史关系待核验')));if(a.lastError)section.append(el('p',safe('自动同步异常：'+a.lastError),'ar-error'));}
   const run=syncInfo.run,labels={running:'正在同步全部部门',completed:'上次全量同步完成',partial:'部分完成，资料仍不完整',failed:'同步失败',unknown:'上次同步结果待核查'};
   section.append(el('p',run?safe((labels[run.status]??run.status)+' · 部门 '+run.storedDepartments+'/'+run.departments+' · 组织 '+(run.organizationId?'已取得':'未取得')):safe(syncInfo.reason??'尚未同步完整组织目录')));
   for(const issue of run?.errors??[])section.append(el('p',safe((issue.requiredScopes?.length?'缺少权限：'+issue.requiredScopes.join('、'):issue.reason??issue.stage)+(issue.code!==undefined?'（'+issue.code+'）':'')),'ar-error'));
   const start=button('同步飞书组织与全部部门',syncDirectory);start.disabled=!write||!syncInfo.available||syncBusy||run?.status==='running'||accounts.length>1&&!accountId;section.append(start,el('small','从组织根目录逐级读取全部部门；刷新资料可查看进度，权限不足或中途失败不会按缺失结果断联。'));root.append(section);
  }
  const layout=el('div',undefined,'ar-entities-layout'),nav=el('nav',undefined,'ar-entity-types');nav.setAttribute('aria-label','实体类型');
  for(const type of [{id:'',label:'全部资料',count:types.reduce((n,t)=>n+t.count,0)},...types]){const tab=button('',()=>{typeId=type.id;offset=0;refresh();});tab.setAttribute('aria-current',typeId===type.id?'page':'false');tab.append(el('span',safe(type.label)),el('span',String(type.count)));nav.append(tab);}
  nav.append(el('p','按类型整理人员、组织与资源，资料随来源同步更新。','ar-description'));layout.append(nav);
  const workspace=el('div',undefined,'ar-entities-workspace'),top=el('div',undefined,'ar-entities-result-heading');top.append(el('strong',safe(types.find(t=>t.id===typeId)?.label??'全部资料')),el('span',page?page.total+' 条资料':loading?'正在读取…':'未读取','ar-meta'));if(typeId==='person')top.append(button('飞书人员同步与更正',openPeople));workspace.append(top);layout.append(workspace);root.append(layout);
  const notice=el('p',error||'资料由各来源同步维护，可在详情中查看采集时间与来源。',error?'ar-error':'ar-entities-notice');notice.setAttribute('role',error?'alert':'status');workspace.append(notice);
  if(error){workspace.append(button('重试读取',refresh));return;}
  if(!page?.entities.length){workspace.append(el('div',loading?'正在加载资料…':query||source?'没有匹配资料，请调整搜索条件。':'此分类暂无资料。AI 或程序完成同步后会自动出现在这里。','ar-entities-empty'));return;}
  const content=el('div',undefined,'ar-entities-content'),list=el('div',undefined,'ar-entities-list');list.setAttribute('aria-label','实体列表');
  for(const record of page.entities){const row=button('',()=>{selected=record;render();});row.setAttribute('aria-pressed',String(selected?.id===record.id));row.append(el('strong',safe(record.name)),el('span',safe((types.find(t=>t.id===record.typeId)?.label??record.typeId)+' · '+record.source.namespace)),el('small',safe(record.summary||'暂无摘要')));list.append(row);}content.append(list);
  if(selected){const record=selected,detail=el('article',undefined,'ar-entity-detail'),heading=el('div',undefined,'ar-entity-detail-heading');heading.append(el('h3',safe(record.name)),el('span',kinds[record.source.kind]??'未知来源','ar-entity-origin'));heading.append(button('修改日志',()=>openAudit(record.id)));detail.append(heading,el('p',safe(record.summary||'暂无摘要')));
   const fields=el('dl');const fact=(label,value)=>{const cell=el('div');cell.append(el('dt',safe(label)),el('dd',safe(Array.isArray(value)?value.join('、'):value===null||value===undefined||value===''?'暂未获取':String(value))));fields.append(cell);};
   const type=types.find(t=>t.id===record.typeId);for(const [name,value] of Object.entries(record.attributes))fact(type?.fields[name]?.label??({giteaUsername:'Gitea 账号',giteaSource:'账号映射来源'}[name]??name),value);
   detail.append(fields);const provenance=el('details'),meta=el('dl');provenance.append(el('summary','来源与同步信息'));for(const [label,value] of [['来源标识',record.source.namespace],['来源记录 ID',record.source.externalId],['采集时间',record.observedAt],['更新时间',record.updatedAt],['实体 ID',record.id],['修订版本',record.revision]]){const cell=el('div');cell.append(el('dt',label),el('dd',safe(value)));meta.append(cell);}provenance.append(meta);detail.append(provenance);
   const related=el('details'),relationsBody=el('div');related.append(el('summary','查看关联关系'),relationsBody);let fetched=false;
   related.ontoggle=async()=>{if(!related.open||fetched)return;fetched=true;const epoch=generation;relationsBody.textContent='正在读取…';try{const result=await invoke('graph',{id:record.id,depth:1,limit:100},epoch);if(disposed||epoch!==generation)return;relationsBody.textContent='';for(const relation of result.relations){const target=result.entities.find(e=>e.id===(relation.fromId===record.id?relation.toId:relation.fromId));relationsBody.append(el('p',safe((relation.fromId===record.id?'→ ':'← ')+(result.relationTypes?.find(type=>type.id===relation.typeId)?.label??relation.typeId)+' · '+(target?.name??'未知实体'))));}if(!result.relations.length)relationsBody.append(el('p','暂无有效关联'));if(result.truncated)relationsBody.append(el('p','关联较多，仅展示前 100 条'));}catch{if(!disposed&&epoch===generation){relationsBody.textContent='关联读取失败，请重新展开重试';fetched=false;}}};detail.append(related);
   if(record.legacyPersonId)detail.append(button('打开飞书人员管理',openPeople));else detail.append(el('p','由来源同步更新。相同来源记录会更新原实体，不按名称自动合并。','ar-description'));content.append(detail);
  }workspace.append(content);
  const paging=el('div',undefined,'ar-entities-pagination');if(offset)paging.append(button('上一页',()=>{offset=Math.max(0,offset-20);refresh();}));if(page.nextOffset!==null)paging.append(button('下一页',()=>{offset=page.nextOffset;refresh();}));workspace.append(paging);
 }
 function update(next){if(disposed)return;context=next;const id=owner(),nextRead=context.host.connection.canRead,nextWrite=context.host.connection.canWrite,nextPresented=context.presented;if(id!==agentId||read!==nextRead||write!==nextWrite||presented!==nextPresented){closeAudit();generation++;agentId=id;read=nextRead;write=nextWrite;presented=nextPresented;types=[];sources=[];page=null;selected=null;typeId='';query='';source='';offset=0;personMode=false;syncInfo=null;syncBusy=false;syncRequestId=null;accountId='';loading=false;error='';render();refresh();}}
 const stop=context.host.subscribe(()=>update(context));update(initial);return {update,dispose(){closeAudit();disposed=true;generation++;people?.dispose();stop();root.remove();}};
}
