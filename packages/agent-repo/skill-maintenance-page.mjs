import {readInspectionResponse} from './dist/inspection-transport.mjs';
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const button=(label,action,className)=>{const node=el('button',label,className);node.type='button';node.onclick=action;return node;};
const states={available:'CLI 可用',fallback:'使用已验证旧版',not_installed:'未安装',disabled:'已禁用',unavailable:'不可读取',degraded:'需处理',running:'执行中',succeeded:'成功',failed:'失败',unknown:'结果待核查',unsupported:'版本不支持'};
const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未记录';
const sourceName=source=>({agent:'Agent 仓库',project:'项目仓库',repository:'子仓库'})[source]??'仓库技能';
export function mountSkillMaintenance(container,context,agentId,options={}){
 let disposed=false,generation=0,data=null,error='',notice='',loading=false,busy=false,confirmation=null,retry=null,query='',view='skills',selected=null,detailTab='overview',sources=options.sources??[],sourceKey=options.scopeKey??'';
 const search=el('input');let rememberedFocus=null;const drafts=new Map();
 const root=el('section',undefined,'ar-maintenance');root.setAttribute('aria-label','技能与关联 CLI');container.append(root);
 const safe=value=>context.host.redact(String(value??''));
 const canWrite=()=>context.host.connection.canWrite===true;
 const invoke=(action,payload)=>readInspectionResponse(async(_name,input)=>{context.signal.throwIfAborted();if(disposed)throw Error('维护页面已关闭');return context.host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+action,agentId,sessionKey:'agent:'+agentId+':agent-repo-management',payload:input});},action,payload);
 const providers=()=>data?.providers??[];
 const cliProviders=()=>providers().filter(provider=>provider.kind!=='generated-skill'&&provider.id!=='agent-repo.main-skill');
 function skills(){
  const repository=sources.flatMap(source=>(source.skills??[]).map(skill=>({...skill,key:'repo:'+skill.path,label:skill.name,sourceLabel:sourceName(source.source),scope:source.directory??'',state:skill.status??(skill.disabledReason?'disabled':source.state==='dirty'?'pending_commit':'candidate'),warning:source.warning,cli:null})));
  const managed=providers().flatMap(provider=>(provider.skills?.length?provider.skills:provider.kind==='generated-skill'||provider.id==='agent-repo.main-skill'?[{name:provider.id}]:[]).map(skill=>({...skill,key:provider.id+':'+skill.name,label:provider.kind==='generated-skill'||provider.id==='agent-repo.main-skill'?provider.label:skill.name,sourceLabel:provider.ownerLabel??provider.label,scope:provider.kind==='generated-skill'||provider.id==='agent-repo.main-skill'?provider.scope:skill.scope??'以技能说明与当前任务权限为准',state:provider.state,provider,cli:cliProviders().includes(provider)?provider:null})));
  return [...managed,...repository];
 }
 const skillState=skill=>skill.provider?(skill.cli?(skill.state==='available'?'CLI 可用 · 按任务授权':states[skill.state]??'未知'):skill.state==='available'?'已生成':states[skill.state]??'未知'):({candidate:'范围内候选',pending_commit:'待提交变化',shadowed:'同名覆盖',disabled:'已禁用'})[skill.state]??'状态待核验';
 function setView(next){view=next;options.onViewChange?.(view);}
 function choose(kind,key){selected={kind,key};detailTab='overview';confirmation=null;render();root.querySelector('.ar-maintenance-detail h3')?.focus({preventScroll:true});}
 async function refresh(){
  if(disposed||busy)return;const epoch=++generation;loading=true;error='';render();
  try{const next=await invoke('maintenance',{});if(next?.apiVersion!==1)throw Error('维护接口版本不兼容，请升级配套插件');if(!disposed&&epoch===generation){data=next;}}
  catch(failure){if(!disposed&&epoch===generation)error=safe(failure.message);}
  if(!disposed&&epoch===generation){loading=false;render();}
 }
 async function execute(provider,action,settings){
  if(disposed||busy||!canWrite())return;
  busy=true;error='';notice='';const input=retry??{providerId:provider.id,action:action.id,expectedRevision:confirmation?.providerId===provider.id?confirmation.revision:provider.revision,requestId:crypto.randomUUID(),confirmed:true,...(settings?{settings}:{})};retry=input;render();
  try{const operation=await invoke('maintenanceRun',input);retry=null;confirmation=null;drafts.delete(provider.id);notice=operation.status==='succeeded'?'维护操作已完成。':'维护请求已受理，可在维护记录中查看结果。';detailTab='history';}
  catch(failure){error=safe(failure.message)+'；结果未确认，请重试原维护请求以核查，避免重复执行。';}
  finally{busy=false;if(!disposed){if(!retry)await refresh();else render();}}
 }
 function exportDiagnostics(){const blob=new Blob([safe(JSON.stringify({...data,providers:providers().map(({body,...provider})=>provider)},null,2))],{type:'application/json'});const url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download='skill-maintenance-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),0);}
 function fields(entries){const list=el('dl',undefined,'ar-maintenance-fields');for(const [label,value] of entries)list.append(el('dt',label),el('dd',safe(value??'未记录')));return list;}
 function versions(provider){const result=fields([['当前版本',provider.versions?.current],['可更新版本',provider.versions?.available??'尚未检查']]);result.classList.add('ar-maintenance-versions');return result;}
 function status(provider){return provider.versions?.available&&provider.versions.available!==provider.versions.current?provider.policy?.version?'待切换至固定版本':'有新版本可用':states[provider.state]??'未知';}
 function actionButton(provider,action,label=action.label){const control=button(label,()=>{confirmation={providerId:provider.id,action,revision:provider.revision};render();root.querySelector('.ar-maintenance-confirm button')?.focus();},action.id==='update'?'ar-primary':'');control.disabled=busy||loading||!!retry||!canWrite()||!provider.revision;return control;}
 function confirmationForm(panel,provider){
  if(confirmation?.providerId!==provider.id)return;
  const form=el('section',undefined,'ar-maintenance-confirm');form.setAttribute('aria-label','确认维护操作');form.append(el('h4',confirmation.action.id==='configure'?'确认保存更新设置':confirmation.action.label),el('p',safe(provider.scope),'ar-maintenance-scope'));
  if(confirmation.action.effect)form.append(el('p',safe(confirmation.action.effect)));
  if(confirmation.settings)form.append(fields([['自动更新',confirmation.settings.autoUpdate?'开启':'关闭'],['固定版本',confirmation.settings.version||'跟随兼容稳定版'],['检查间隔',confirmation.settings.updateCheckIntervalHours+' 小时']]));
  else if(confirmation.action.id==='update')form.append(fields([['当前版本',provider.versions?.current],['目标版本',provider.policy?.version??provider.versions?.available??'检查后选择兼容稳定版']]));
  const current=confirmation;const confirm=button('确认执行',()=>execute(provider,current.action,current.settings),'ar-primary');confirm.disabled=busy||!canWrite()||!!retry;
  form.append(confirm,button('取消',()=>{confirmation=null;render();}));panel.append(form);
 }
 function policyForm(panel,provider){
  const action=provider.actions?.find(action=>action.settings);if(!action){panel.append(el('p','此提供方未开放更新设置。','ar-muted'));return;}
  panel.append(el('p',safe(provider.scope),'ar-maintenance-scope'));
  if(confirmation?.providerId===provider.id)return;
  const draft=drafts.get(provider.id)?.revision===provider.revision?drafts.get(provider.id).settings:provider.policy;
  const form=el('form',undefined,'ar-maintenance-settings'),controls={};
  for(const [name,label,type,value] of [['autoUpdate','自动更新 CLI 与配套技能','checkbox',draft?.autoUpdate],['version','固定版本','text',draft?.version??''],['updateCheckIntervalHours','检查间隔（小时）','number',draft?.updateCheckIntervalHours??24]]){
   const field=el('label'),input=el('input');input.type=type;input.setAttribute('aria-label',label);input.disabled=!canWrite()||busy||!!retry;
   if(type==='checkbox')input.checked=value===true;else input.value=String(value);
   if(type==='number'){input.min='1';input.max='720';input.required=true;}if(type==='text')input.placeholder='留空跟随兼容稳定版';
   if(type==='checkbox'){field.className='ar-maintenance-switch';field.append(input,el('span',label));}else field.append(el('span',label),input);
   controls[name]=input;form.append(field);input.oninput=input.onchange=()=>drafts.set(provider.id,{revision:provider.revision,settings:{autoUpdate:controls.autoUpdate.checked,version:controls.version?.value??'',updateCheckIntervalHours:Number(controls.updateCheckIntervalHours?.value??24)}});
  }
  form.append(el('p','固定版本优先于自动更新；自动更新默认开启。','ar-muted'));
  const save=el('button','保存更新设置','ar-primary');save.type='submit';save.disabled=!canWrite()||busy||!!retry||!provider.revision;form.append(save);
  form.onsubmit=event=>{event.preventDefault();drafts.set(provider.id,{revision:provider.revision,settings:{autoUpdate:controls.autoUpdate.checked,version:controls.version.value.trim(),updateCheckIntervalHours:Number(controls.updateCheckIntervalHours.value)}});confirmation={providerId:provider.id,action,revision:provider.revision,settings:{autoUpdate:controls.autoUpdate.checked,version:controls.version.value.trim(),updateCheckIntervalHours:Number(controls.updateCheckIntervalHours.value)}};render();root.querySelector('.ar-maintenance-confirm button')?.focus();};
  panel.append(form);
 }
 function history(panel,provider){panel.append(el('h4','维护记录'));if(!provider.history?.length)panel.append(el('p','暂无维护记录。','ar-muted'));for(const operation of provider.history??[]){const row=el('article',undefined,'ar-maintenance-event');row.append(el('strong',states[operation.status]??operation.status),el('p',safe((provider.actions?.find(action=>action.id===operation.action)?.label??operation.action)+' · '+time(operation.createdAt))),el('small',safe([operation.actorAgentId?'来源 Agent '+operation.actorAgentId:null,operation.finishedAt?'结束于 '+time(operation.finishedAt):null,operation.errorCode].filter(Boolean).join(' · '))));if(operation.status==='unknown')row.append(el('p','操作可能已执行，请核查当前状态；不会自动重放。','ar-warning'));panel.append(row);}}
 function diagnostic(panel,provider,skill){
  panel.append(fields(skill&&!skill.provider?[['路径',skill.path],['提交',skill.updatedCommit],['更新时间',time(skill.updatedAt)],['适用条件',skill.appliesWhen],['覆盖来源',skill.overriddenBy],['禁用原因',skill.disabledReason]]:(provider?.fields??[]).map(field=>[field.label,field.value])));
  if(provider?.body){const body=el('details');body.append(el('summary','查看已提交技能正文'),el('pre',safe(provider.body)));if(provider.bodyTruncated)body.append(el('p','正文预览达到上限。'));panel.append(body);}
  if(data)panel.append(button('导出脱敏诊断',exportDiagnostics));
 }
 function renderDetail(layout,rows){
  let skill=selected?.kind==='skill'?rows.find(row=>row.key===selected.key):null,provider=selected?.kind==='cli'?cliProviders().find(provider=>provider.id===selected.key):skill?.provider;
  if(!skill&&!provider){selected=null;layout.append(el('aside','选择技能或 CLI 查看详情。','ar-maintenance-empty'));return;}
  const panel=el('aside',undefined,'ar-maintenance-detail');panel.setAttribute('aria-label',skill?'技能详情':'CLI 详情');
  const heading=el('header'),title=el('h3',safe(skill?.label??provider.label));title.tabIndex=-1;heading.append(title,button('关闭详情',()=>{const prior=selected;selected=null;confirmation=null;render();[...root.querySelectorAll('[data-item-key]')].find(node=>node.dataset.itemKey===prior.key)?.focus();}));panel.append(heading,el('p',safe(skill?.sourceLabel??provider.ownerLabel??provider.label),'ar-description'));
  const tabs=el('nav',undefined,'ar-maintenance-detail-tabs');tabs.setAttribute('aria-label','详情视图');for(const [key,label] of [['overview','概览'],...(!skill?[['settings','更新设置']]:[]),...(provider?[['history','维护记录']]:[]),['diagnostic','诊断']]){const tab=button(label,()=>{detailTab=key;confirmation=null;render();});if(detailTab===key)tab.setAttribute('aria-current','page');tabs.append(tab);}panel.append(tabs);
  if(detailTab==='settings')policyForm(panel,provider);
  else if(detailTab==='history')history(panel,provider);
  else if(detailTab==='diagnostic')diagnostic(panel,provider,skill);
  else if(skill){
   panel.append(el('h4','技能用途'),el('p',safe(skill.description||'此技能尚未提供用途说明。')),fields([['来源',skill.sourceLabel],['当前状态',skillState(skill)],['适用范围',skill.scope||'当前仓库范围']]));
   if(skill.warning||skill.disabledReason)panel.append(el('p',safe(skill.disabledReason??skill.warning),'ar-warning'));
   if(skill.cli){panel.append(el('h4','关联 CLI'));const link=button(skill.cli.label,()=>{setView('cli');choose('cli',skill.cli.id);},'ar-maintenance-dependency');link.append(el('small',safe(skill.cli.scope)));panel.append(link,fields([['当前版本',skill.cli.versions?.current],['更新状态',status(skill.cli)],['自动更新',skill.cli.policy?.autoUpdate?'已开启':'已关闭']]),button('查看 CLI 详情',()=>{setView('cli');choose('cli',skill.cli.id);},'ar-primary'));}
   else if(provider){panel.append(el('p','由 AgentRepo 自动生成，供 Worker 按任务读取；版本通知不代表实际读取。','ar-muted'));for(const action of provider.actions??[])panel.append(actionButton(provider,action));}
   else panel.append(el('p','当前来源没有声明受托管的 CLI 依赖；不会根据技能名称推断安装状态。','ar-muted'));
  }else{
   panel.append(el('p',safe(provider.scope),'ar-maintenance-scope'),el('h4','版本信息'),el('strong',status(provider),'ar-maintenance-status'),versions(provider));
   panel.append(el('h4','关联技能（'+(provider.skills?.length??0)+'）'));
   for(const associated of provider.skills??[]){const linked=rows.find(row=>row.provider===provider&&row.name===associated.name);const open=button(associated.name,()=>{setView('skills');choose('skill',linked.key);},'ar-maintenance-linked-skill');if(associated.description)open.append(el('small',safe(associated.description)));panel.append(open);}
   panel.append(el('p','更新由提供方执行，关联技能索引与 CLI 一同维护。','ar-muted'),el('h4','自动更新设置'),fields([['当前状态',provider.policy?provider.policy.autoUpdate?'开启':'关闭':'未提供'],['固定版本',provider.policy?.version||'跟随兼容稳定版'],['检查间隔',provider.policy?provider.policy.updateCheckIntervalHours+' 小时':'未提供']]));
   if(provider.actions?.some(action=>action.settings))panel.append(button('修改设置',()=>{detailTab='settings';render();}));
   const actions=el('footer',undefined,'ar-maintenance-actions');for(const action of provider.actions??[]){if(action.settings||action.id==='rollback')continue;if(action.id==='check'){const check=button(action.label,()=>execute(provider,action));check.disabled=!canWrite()||busy||loading||!!retry||!provider.revision;actions.append(check);}else actions.append(actionButton(provider,action,action.id==='update'&&provider.versions?.available?'更新至 '+provider.versions.available:action.label));}
   const moreActions=(provider.actions??[]).filter(action=>action.id==='rollback');if(moreActions.length){const more=el('details');more.append(el('summary','更多操作'));for(const action of moreActions)more.append(actionButton(provider,action));actions.append(more);}panel.append(actions);
  }
  if(provider)confirmationForm(panel,provider);layout.append(panel);
 }
 function render(){
  const focused=root.contains(document.activeElement)?document.activeElement?.dataset?.itemKey:null;const focusKey=rememberedFocus?.focusKey??(root.contains(document.activeElement)?document.activeElement?.dataset.focusKey:null);
  const searchFocused=document.activeElement===search||rememberedFocus?.search,selection=rememberedFocus?.selection??[search.selectionStart,search.selectionEnd];rememberedFocus=null;
  const openFolds=new Set([...root.querySelectorAll('details[open]')].map(node=>node.querySelector('summary')?.textContent));
  root.replaceChildren();root.setAttribute('aria-busy',String(loading||busy));
  const top=el('header',undefined,'ar-maintenance-heading');top.append(el('h2','技能与关联 CLI'));const reload=button(loading?'正在刷新…':'刷新状态',refresh);reload.disabled=loading||busy;top.append(reload);root.append(top);
  const nav=el('nav',undefined,'ar-maintenance-views');nav.setAttribute('aria-label','技能管理视图');for(const [key,label] of [['skills','技能'],['cli','关联 CLI']]){const control=button(label,()=>{setView(key);selected=null;confirmation=null;query='';render();});if(view===key)control.setAttribute('aria-current','page');nav.append(control);}root.append(nav);
  if(error){const warning=el('p',error,'ar-error');warning.setAttribute('role','alert');root.append(warning);}
  if(notice){const message=el('p',notice,'ar-maintenance-notice');message.setAttribute('role','status');root.append(message);}
  if(!canWrite())root.append(el('p','只读模式：可以查看详情，维护操作需要写入权限。','ar-muted'));
  if(retry){const original=button('重试原维护请求',()=>execute({},{},null));original.disabled=busy||!canWrite();root.append(original);}
  const layout=el('div',undefined,'ar-maintenance-layout');if(selected)layout.classList.add('ar-has-detail');root.append(layout);const list=el('section',undefined,'ar-maintenance-list');list.setAttribute('aria-label',view==='skills'?'技能列表':'关联 CLI 列表');layout.append(list);
  const intro=el('p',view==='cli'?'提供方声明的 CLI 运行依赖；共享范围以每项标注为准。':'查看当前范围的技能、来源与运行依赖。','ar-description');list.append(intro);
  search.type='search';search.value=query;search.setAttribute('aria-label','搜索技能或关联 CLI');search.placeholder=view==='skills'?'搜索技能名称、用途或 CLI':'搜索 CLI 或关联技能';search.oninput=()=>{query=search.value;options.onQuery?.(query);render();};list.append(search);
  const rows=skills(),terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean),items=view==='skills'?rows:cliProviders();
  const matching=items.filter(row=>terms.every(term=>[row.label,row.name,row.path,row.description,row.sourceLabel,row.cli?.label,...(row.skills??[]).map(skill=>skill.name)].join(' ').toLocaleLowerCase().includes(term)));
  const table=el('table',undefined,'ar-maintenance-table'),thead=el('thead'),header=el('tr');for(const title of view==='skills'?['技能','用途 / 来源','状态','关联 CLI']:['CLI','来源','状态','自动更新','关联技能']){const th=el('th',title);th.scope='col';header.append(th);}thead.append(header);table.append(thead);const body=el('tbody');
  for(const row of matching){const key=view==='skills'?row.key:row.id,kind=view==='skills'?'skill':'cli',tr=el('tr');if(selected?.key===key)tr.className='ar-selected';const open=()=>choose(kind,key);tr.onclick=open;const name=button(safe(row.label),event=>{event.stopPropagation();open();},'ar-maintenance-item');name.dataset.itemKey=key;name.setAttribute('aria-pressed',String(selected?.key===key));const cell=el('td');cell.append(name);tr.append(cell);
   const values=view==='skills'?[[row.description||'查看技能说明',row.sourceLabel],[skillState(row)], [row.cli?.label??'未声明']]:[[row.ownerLabel??row.label,row.scope],[status(row),row.versions?.current??'版本未知'],[row.policy?row.policy.autoUpdate?'已开启':'已关闭':'未提供'],[String(row.skills?.length??0)+' 个技能']];
   for(const [primary,secondary] of values){const td=el('td');td.append(el('span',safe(primary)));if(secondary)td.append(el('small',safe(secondary)));tr.append(td);}body.append(tr);
  }
  table.append(body);list.append(table);if(!matching.length)list.append(el('p',query?'没有匹配的结果。':loading?'正在读取…':view==='skills'&&sources.length&&sources.every(source=>source.state==='unavailable')?'此范围暂不可扫描':view==='cli'?'尚无提供方声明关联 CLI；仓库技能仍可查看。':'当前范围没有可显示的技能。','ar-maintenance-empty'));
  for(const source of sources)if(source.warning)list.append(el('p',safe(source.warning),'ar-warning'));
  if(data)list.append(el('p','维护状态检查于 '+time(data.observedAt),'ar-meta'));
  renderDetail(layout,rows);
  for(const node of root.querySelectorAll('details'))if(openFolds.has(node.querySelector('summary')?.textContent))node.open=true;
  for(const control of root.querySelectorAll('button,summary'))control.dataset.focusKey=control.tagName+':'+control.textContent;
  if(searchFocused){search.focus({preventScroll:true});search.setSelectionRange(...selection);}else if(focused)[...root.querySelectorAll('[data-item-key]')].find(node=>node.dataset.itemKey===focused)?.focus({preventScroll:true});else if(focusKey)[...root.querySelectorAll('[data-focus-key]')].find(node=>node.dataset.focusKey===focusKey)?.focus({preventScroll:true});
 }
 const timer=setInterval(()=>{if(!disposed&&!confirmation&&!retry&&detailTab!=='settings'&&data?.providers.some(provider=>provider.history?.some(operation=>operation.status==='running')))refresh();},3000);
 refresh();return {element:root,get view(){return view;},rememberFocus(){if(document.activeElement===search)rememberedFocus={search:true,selection:[search.selectionStart,search.selectionEnd]};else if(root.contains(document.activeElement))rememberedFocus={focusKey:document.activeElement?.dataset.focusKey};},setSources(next,key){if(sourceKey!==key){sourceKey=key;if(selected?.key.startsWith('repo:'))selected=null;query='';options.onQuery?.('');confirmation=null;}sources=next;render();},refresh,dispose(){disposed=true;generation++;clearInterval(timer);root.remove();}};
}
