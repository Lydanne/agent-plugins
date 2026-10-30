import {Virtualizer,observeElementRect,observeElementOffset,elementScroll} from '@tanstack/virtual-core';

const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const btn=(text,action)=>{const node=el('button',text);node.type='button';node.onclick=action;return node;};
const moment=event=>new Date(event.time??event.observedAt);
const fullTime=event=>Number.isNaN(moment(event).getTime())?'时间未记录':moment(event).toLocaleString();
const day=event=>Number.isNaN(moment(event).getTime())?'时间未记录':moment(event).toLocaleDateString();
const capabilities=source=>source?.capabilities??{live:source?.live===true,history:false,clearHistory:false};
function repeatKey(event){
 const data=event.data&&typeof event.data==='object'&&!Array.isArray(event.data)?Object.fromEntries(Object.entries(event.data).filter(([key,value])=>!(['time','timestamp','observedAt'].includes(key)&&[event.time,event.observedAt].some(time=>time!==undefined&&String(time)===String(value))))):event.data;
 return JSON.stringify([event.sourceId,event.level,event.message,event.jobId,event.traceId,event.projectId,event.eventName,event.category,event.phase,data]);
}
export function mountLogConsole(container,{invoke,safe=String,canWrite=()=>false,signal,actionsContainer,agentId:expectedAgent}){
 let disposed=false,generation=0,historyGeneration=0,catalogGeneration=0,mode='history',historyRows=[],liveRows=[],sources=[],agentId=expectedAgent,lease=null,starting=false,connection='off',pollTimer,renewTimer,cursor=0;
 let source='',level='',category='',query='',find='',groupBy='',mergeRepeats=true,selected=null,follow=false,dropped=0,localDropped=0,historyDropped=0,historyLoading=false,historyError='',catalogError='',historyWarnings=[],findIndex=-1,findOpen=false,clearing=false,confirmation=null;
 let visible=[],matches=[],groups=new Map(),repetitions=[],virtualizer;
 const collapsed=new Set(),expandedRepeats=new Set();
 const root=el('section',undefined,'ar-console-shell'),modebar=el('div',undefined,'ar-console-modebar'),tabs=el('nav',undefined,'ar-maintenance-views ar-console-tabs');tabs.setAttribute('aria-label','日志视图');
 const historyTab=btn('历史记录',()=>setMode('history')),liveTab=btn('实时调试',()=>setMode('live')),status=el('span',undefined,'ar-console-status'),live=btn('开启实时调试',toggle);live.className='ar-console-live';live.setAttribute('aria-pressed','false');tabs.append(historyTab,liveTab);modebar.append(tabs,status,live);
 const panel=el('section',undefined,'ar-console'),toolbar=el('div',undefined,'ar-console-toolbar'),feedback=el('p','','ar-log-feedback'),stats=el('span','','ar-console-stats');feedback.setAttribute('role','status');
 const refresh=btn('刷新日志',()=>mode==='history'?loadHistory():loadSources());if(actionsContainer)actionsContainer.append(refresh);else modebar.append(refresh);
 function picker(label,options,change){const node=el('select');node.setAttribute('aria-label',label);for(const [value,text] of options){const option=el('option',text);option.value=value;node.append(option);}node.onchange=()=>{dismissConfirmation();change(node.value);};return node;}
 const sourcePicker=picker('日志来源',[['','全部来源']],value=>{source=value;selected=null;render();});sourcePicker.title='筛选当前视图，不改变采集来源';
 const levelPicker=picker('日志级别',[['','全部级别'],['debug','调试'],['info','信息'],['warn','警告'],['error','错误']],value=>{level=value;render();});
 const more=el('details',undefined,'ar-console-more'),moreSummary=el('summary','更多操作'),menu=el('div',undefined,'ar-console-menu');moreSummary.title='查找日志：⌘F / Ctrl+F';more.append(moreSummary,menu);
 const closeMore=()=>{more.open=false;};
 function menuAction(label,action){const control=btn(label,()=>{closeMore();action();});menu.append(control);return control;}
 const copy=menuAction('复制筛选结果',async()=>{try{await document.defaultView.navigator.clipboard.writeText(safe(JSON.stringify(exportData(),null,2)));if(!disposed){feedback.textContent='已复制当前筛选结果。';render();}}catch{if(!disposed){feedback.textContent='无法访问剪贴板，可导出筛选结果。';render();}}});
 const download=menuAction('导出筛选结果',()=>{const browser=document.defaultView,url=browser.URL.createObjectURL(new browser.Blob([safe(JSON.stringify(exportData(),null,2))],{type:'application/json'})),link=el('a');link.href=url;link.download='agent-logs.json';link.click();browser.setTimeout(()=>browser.URL.revokeObjectURL(url),0);});
 menuAction('清空当前视图',()=>{if(mode==='history')historyRows=[];else liveRows=[];selected=null;render();});
 menuAction('查找日志',()=>showFind());
 const categoryPicker=picker('日志分类',[['','全部分类']],value=>{category=value;render();}),groupPicker=picker('日志分组',[['','按时间排列'],['sourceId','按来源分组'],['jobId','按任务分组'],['category','按分类分组']],value=>{groupBy=value;render();});
 for(const [label,control] of [['分类',categoryPicker],['分组',groupPicker]]){const field=el('label',label);field.append(control);menu.append(field);}
 const merge=el('input');merge.type='checkbox';merge.checked=true;merge.setAttribute('aria-label','合并连续重复记录');merge.onchange=()=>{mergeRepeats=merge.checked;render();};const mergeLabel=el('label');mergeLabel.append(merge,document.createTextNode('合并连续重复记录'));mergeLabel.title='仅合并相邻且来源、任务、追踪及内容相同的记录，原始事件仍全部保留';menu.append(mergeLabel);
 menuAction('折叠全部',()=>{for(const key of groups.keys())collapsed.add(key);expandedRepeats.clear();render();});
 menuAction('展开全部',()=>{collapsed.clear();for(const item of repetitions)expandedRepeats.add(item.events[0].eventId);render();});
 const clearStored=menuAction('清理来源历史',confirmClear);clearStored.className='ar-console-danger';
 const rawDetails=el('details',undefined,'ar-log-raw'),rawText=el('textarea');rawText.readOnly=true;rawText.setAttribute('aria-label','当前筛选结果 JSON');rawDetails.append(el('summary','查看筛选结果 JSON'),rawText);rawDetails.ontoggle=()=>{if(rawDetails.open)rawText.value=safe(JSON.stringify(exportData(),null,2));};menu.append(rawDetails);
 const followButton=btn('跟随最新',()=>{follow=!follow;followButton.setAttribute('aria-pressed',String(follow));if(follow)bottom();});followButton.setAttribute('aria-pressed','false');
 toolbar.append(sourcePicker,levelPicker,followButton,more);
 const findbar=el('div',undefined,'ar-console-find'),findInput=el('input'),findStats=el('span');findInput.type='search';findInput.placeholder='查找内容、任务或追踪 ID';findInput.setAttribute('aria-label','查找日志');
 findInput.oninput=()=>{find=findInput.value;query=onlyMatches.checked?find:'';findIndex=-1;if(selected){const event=activeRows().find(row=>row.eventId===selected);if(event)showEvent(event);}render();};
 const onlyMatches=el('input');onlyMatches.type='checkbox';onlyMatches.setAttribute('aria-label','仅显示匹配');onlyMatches.onchange=()=>{query=onlyMatches.checked?find:'';findIndex=-1;render();};const onlyMatchesLabel=el('label');onlyMatchesLabel.append(onlyMatches,document.createTextNode('仅显示匹配'));
 function closeFind(){findOpen=false;find=query='';findInput.value='';onlyMatches.checked=false;render();moreSummary.focus();}
 const previous=btn('上一个',()=>move(-1)),next=btn('下一个',()=>move(1));findbar.append(findInput,previous,next,findStats,onlyMatchesLabel,btn('关闭查找',closeFind));
 const workspace=el('div',undefined,'ar-console-workspace'),list=el('div',undefined,'ar-console-list'),viewport=el('div',undefined,'ar-console-viewport'),canvas=el('div',undefined,'ar-console-canvas');viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label','日志控制台');viewport.append(canvas);
 const empty=el('section',undefined,'ar-log-empty'),emptyTitle=el('h3'),emptyText=el('p'),emptyAction=btn('查看实时调试',()=>setMode('live'));empty.append(emptyTitle,emptyText,emptyAction);list.append(empty,viewport);
 const inspector=el('aside',undefined,'ar-console-inspector'),inspectorHeader=el('div',undefined,'ar-console-detail-heading'),inspectorTitle=el('strong','日志详情'),detail=el('div',undefined,'ar-console-data');inspector.setAttribute('aria-label','日志详情');inspectorHeader.append(inspectorTitle,btn('关闭详情',()=>{selected=null;render();viewport.focus();}));inspector.append(inspectorHeader,detail);workspace.append(list,inspector);
 const footer=el('div',undefined,'ar-console-footer'),scopeHint=el('span');footer.append(scopeHint,stats);panel.append(toolbar,feedback,findbar,workspace,footer);root.append(modebar,panel);container.append(root);
 const labelFor=id=>sources.find(item=>item.id===id)?.label??id;
 const activeRows=()=>mode==='history'?historyRows:liveRows;
 const filteredRows=()=>activeRows().filter(row=>(!source||row.sourceId===source)&&(!level||row.level===level)&&(!category||row.category===category)&&(!query||safe(JSON.stringify(row)).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
 const exportData=()=>({apiVersion:1,agentId,view:mode,filters:{sourceId:source||null,level:level||null,category:category||null,query},rows:filteredRows()});
 function actionSource(){if(source)return sources.find(item=>item.id===source);const eligible=sources.filter(item=>capabilities(item).history);return eligible.length===1?eligible[0]:null;}
 function marked(node,text){const value=safe(String(text??'')),needle=find.toLocaleLowerCase();if(!needle){node.append(document.createTextNode(value));return;}let from=0,index;while((index=value.toLocaleLowerCase().indexOf(needle,from))>=0){node.append(document.createTextNode(value.slice(from,index)),el('mark',value.slice(index,index+find.length)));from=index+find.length;}node.append(document.createTextNode(value.slice(from)));}
 function repeatGroups(events){const result=[];for(const event of events){const key=repeatKey(event),prior=result.at(-1);if(mergeRepeats&&prior?.key===key&&day(prior.events[0])===day(event))prior.events.push(event);else result.push({key,events:[event]});}return result;}
 function draw(){
  if(!virtualizer||disposed)return;const focused=canvas.contains(document.activeElement)?document.activeElement.closest('.ar-console-line'):null,focusKey=focused?.dataset.key,focusRole=document.activeElement?.dataset.control;
  canvas.style.height=virtualizer.getTotalSize()+'px';canvas.replaceChildren();
  for(const item of virtualizer.getVirtualItems()){
   const entry=visible[item.index];if(!entry)continue;const row=el('div',undefined,'ar-console-line');row.style.transform='translateY('+item.start+'px)';row.style.height=item.size+'px';row.dataset.key=entry.key;
   if(entry.type==='group'){row.classList.add('ar-console-group');const toggle=btn((collapsed.has(entry.group)?'展开 ':'收起 ')+safe(entry.label)+' · '+entry.count,()=>{collapsed.has(entry.group)?collapsed.delete(entry.group):collapsed.add(entry.group);render();});toggle.setAttribute('aria-expanded',String(!collapsed.has(entry.group)));row.append(toggle);}
   else if(entry.type==='date'){row.classList.add('ar-console-date');row.textContent=entry.label;}
   else{
    const event=entry.event;row.classList.add('ar-log-record');row.dataset.level=event.level;row.dataset.eventId=event.eventId;if(selected===event.eventId)row.classList.add('selected');if(entry.child)row.classList.add('ar-console-repeat-child');
    const time=el('time',Number.isNaN(moment(event).getTime())?'—':moment(event).toLocaleTimeString([], {hour12:false}));time.title=fullTime(event);const text=btn('',()=>showEvent(event));text.dataset.control='message';text.className='ar-console-message';text.title=safe(event.message);marked(text,event.message);
    const badge=el('span',({debug:'调试',info:'信息',warn:'警告',error:'错误'})[event.level]??event.level,'ar-console-level'),origin=el('span',safe(labelFor(event.sourceId)),'ar-console-origin');origin.title=safe(event.sourceId);row.append(time,badge,origin,text);
    if(entry.events?.length>1){const repeated=btn('×'+entry.events.length,()=>{expandedRepeats.has(event.eventId)?expandedRepeats.delete(event.eventId):expandedRepeats.add(event.eventId);render();});repeated.dataset.control='repeat';repeated.className='ar-console-repeat';repeated.setAttribute('aria-label','重复 '+entry.events.length+' 次');repeated.setAttribute('aria-expanded',String(expandedRepeats.has(event.eventId)));repeated.title='首次 '+fullTime(entry.events[0])+'；末次 '+fullTime(entry.events.at(-1));row.append(repeated);}
   }canvas.append(row);
  }
  if(focused){const replacement=[...canvas.children].find(node=>node.dataset.key===focusKey);(replacement?.querySelector(focusRole?'[data-control="'+focusRole+'"]':'button')??viewport).focus({preventScroll:true});}
 }
 const options=()=>({count:visible.length,getScrollElement:()=>viewport,estimateSize:()=>32,getItemKey:index=>visible[index]?.key??index,overscan:8,initialRect:{width:800,height:360},observeElementRect:(instance,callback)=>observeElementRect(instance,rect=>callback({width:rect.width||800,height:rect.height||360})),observeElementOffset,scrollToFn:elementScroll,onChange:draw});
 virtualizer=new Virtualizer(options());const cleanupVirtual=virtualizer._didMount();virtualizer._willUpdate();
 viewport.addEventListener('scroll',()=>{if(viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop>64){follow=false;followButton.setAttribute('aria-pressed','false');}});
 function bottom(){viewport.scrollTop=Math.max(0,virtualizer.getTotalSize()-viewport.clientHeight);}
 function showEvent(event){
  selected=event.eventId;inspectorTitle.textContent=safe(labelFor(event.sourceId));detail.replaceChildren();
  function tree(parent,value,key,depth=0){if(value&&typeof value==='object'&&depth<7){const node=el('details'),summary=el('summary');marked(summary,key+' '+(Array.isArray(value)?'['+value.length+']':'{'+Object.keys(value).length+'}'));node.append(summary);let loaded=false;node.ontoggle=()=>{if(node.open&&!loaded){loaded=true;for(const [name,item] of Object.entries(value))tree(node,item,name,depth+1);}};parent.append(node);if(depth===0){node.open=true;loaded=true;for(const [name,item] of Object.entries(value))tree(node,item,name,depth+1);}}else{const line=el('div');marked(line,key+': '+JSON.stringify(value));parent.append(line);}}
  tree(detail,event,'事件');inspector.hidden=false;workspace.classList.add('has-detail');draw();
 }
 function emptyState(filtered){
  emptyAction.hidden=true;
  if(mode==='history'&&historyLoading){emptyTitle.textContent='正在读取历史记录';emptyText.textContent='历史读取不会开启实时采集。';return;}
  if(mode==='history'&&historyError){emptyTitle.textContent='历史记录暂不可读';emptyText.textContent=historyError;return;}
  if(mode==='history'&&source&&!capabilities(sources.find(item=>item.id===source)).history){emptyTitle.textContent='此来源仅提供实时日志';emptyText.textContent='切换到实时调试后，可手动开启采集。';emptyAction.hidden=false;return;}
  const current=activeRows().filter(row=>!source||row.sourceId===source);
  if(!filtered.length&&(query||level||category)&&current.length){emptyTitle.textContent='没有匹配的日志';emptyText.textContent='调整筛选条件后重试，当前已有记录不会被删除。';return;}
  if(mode==='history'){emptyTitle.textContent='暂无历史记录';emptyText.textContent=historyWarnings.length?'部分来源暂不可读，可刷新后重试。':'只展示支持历史读取的来源；新增事件可到实时调试中查看。';}
  else if(starting){emptyTitle.textContent='正在连接日志来源';emptyText.textContent='建立连接后，仅采集开启后的新事件。';}
  else if(lease){emptyTitle.textContent='已连接，等待'+(source?safe(labelFor(source)):'来源')+'的新事件';emptyText.textContent='采集中。暂无新事件属于正常等待，不会补报开启前的日志。';}
  else if(connection==='error'){emptyTitle.textContent='实时连接已断开';emptyText.textContent='已有采集记录仍可查看；恢复后请手动重新开启。';}
  else{emptyTitle.textContent='实时调试尚未开启';emptyText.textContent='手动开启后查看新事件；离开实时视图会停止采集。';}
 }
 function render(){
  if(disposed)return;root.dataset.view=mode;historyTab.setAttribute('aria-current',mode==='history'?'page':'false');liveTab.setAttribute('aria-current',mode==='live'?'page':'false');
  live.hidden=mode!=='live';live.disabled=!canWrite()||(!lease&&!starting&&(!!catalogError||!sources.some(item=>capabilities(item).live)));live.title=canWrite()?'仅手动开启后采集，离页自动停止':'需要 operator.write 权限';live.textContent=starting?'取消连接':lease?'关闭实时调试':'开启实时调试';live.setAttribute('aria-pressed',String(!!lease||starting));
  status.dataset.state=mode==='history'?'history':starting?'connecting':lease?'live':connection;status.textContent=mode==='history'?'已保存记录':starting?'连接中':lease?'采集中':connection==='error'?'已断开':'未开启';refresh.textContent=mode==='history'?'刷新日志':'刷新来源';refresh.disabled=mode==='history'?historyLoading:false;
  feedback.hidden=!feedback.textContent;findbar.hidden=!findOpen;followButton.hidden=mode!=='live';followButton.setAttribute('aria-pressed',String(follow));
  const filtered=filteredRows();matches=find?filtered.filter(row=>safe(JSON.stringify(row)).toLocaleLowerCase().includes(find.toLocaleLowerCase())):[];findStats.textContent=find?matches.length+' 个匹配':'';previous.disabled=next.disabled=!matches.length;
  groups=new Map();for(const row of filtered){const key=groupBy?String(row[groupBy]??'未分类'):'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}visible=[];repetitions=[];
  for(const [key,events] of groups){if(groupBy)visible.push({type:'group',key:'group:'+key,group:key,label:groupBy==='sourceId'?labelFor(key):key,count:events.length});const compressed=repeatGroups(events);repetitions.push(...compressed);if(groupBy&&collapsed.has(key))continue;let previousDay;
   for(const repeat of compressed){const first=repeat.events[0],date=day(first);if(date!==previousDay){visible.push({type:'date',key:'date:'+key+':'+first.eventId,label:date});previousDay=date;}visible.push({type:'event',key:first.eventId,event:first,events:repeat.events});if(expandedRepeats.has(first.eventId))for(const event of repeat.events.slice(1))visible.push({type:'event',key:event.eventId,event,child:true});}
  }
  stats.textContent=filtered.length+' 条记录'+(repetitions.length<filtered.length?' · 合并为 '+repetitions.length+' 行':'')+((mode==='history'?historyDropped:dropped+localDropped)?' · 已省略 '+(mode==='history'?historyDropped:dropped+localDropped)+' 条':'');scopeHint.textContent=source?safe(labelFor(source)):mode==='history'?'支持历史读取的全部来源':'本次实时采集';empty.hidden=!!filtered.length;viewport.hidden=!filtered.length;emptyState(filtered);
  const candidate=actionSource();clearStored.hidden=mode!=='history'||!capabilities(candidate).clearHistory;clearStored.disabled=!canWrite()||clearing||!historyRows.some(row=>row.sourceId===candidate?.id);clearStored.title=candidate?'清理当前 Agent 的「'+safe(candidate.label)+'」历史记录':'';
  copy.disabled=download.disabled=!filtered.length;const categories=[...new Set([...activeRows().filter(row=>!source||row.sourceId===source).map(row=>row.category).filter(Boolean),...(category?[category]:[])])].sort(),categoryKey=JSON.stringify(categories);if(categoryPicker.dataset.options!==categoryKey){categoryPicker.dataset.options=categoryKey;categoryPicker.replaceChildren();for(const value of ['',...categories]){const option=el('option',value||'全部分类');option.value=value;categoryPicker.append(option);}categoryPicker.value=category;}
  if(selected&&!filtered.some(row=>row.eventId===selected))selected=null;inspector.hidden=!selected;workspace.classList.toggle('has-detail',!!selected);if(rawDetails.open)rawText.value=safe(JSON.stringify(exportData(),null,2));
  virtualizer.setOptions(options());virtualizer._willUpdate();draw();if(follow&&mode==='live')bottom();
 }
 function showFind(){findOpen=true;render();findInput.focus();}
 function move(direction){if(!matches.length)return;findIndex=(findIndex+direction+matches.length)%matches.length;const event=matches[findIndex];collapsed.delete(String(event[groupBy]??'未分类'));for(const repeated of repetitions)if(repeated.events.some(row=>row.eventId===event.eventId))expandedRepeats.add(repeated.events[0].eventId);follow=false;showEvent(event);render();virtualizer.scrollToIndex(visible.findIndex(row=>row.event?.eventId===event.eventId),{align:'center'});findStats.textContent=(findIndex+1)+' / '+matches.length;}
 const shortcut=event=>{if(!event.defaultPrevented&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();showFind();}};document.addEventListener('keydown',shortcut);
 root.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target===findInput){event.preventDefault();move(event.shiftKey?-1:1);}if(event.key==='Escape'){closeMore();if(findOpen)closeFind();}});
 function dismissConfirmation(){confirmation?.remove();confirmation=null;}
 function setMode(nextMode){if(mode===nextMode)return;stop({quiet:true});dismissConfirmation();mode=nextMode;selected=null;feedback.textContent='';closeMore();render();}
 async function stop({quiet=false}={}){
  const epoch=++generation;starting=false;const prior=lease;lease=null;if(connection!=='error')connection='off';clearTimeout(pollTimer);clearInterval(renewTimer);render();
  if(prior)try{await invoke('diagnosticStop',{leaseId:prior});if(!disposed&&generation===epoch&&!quiet){feedback.textContent='实时调试已关闭。';render();}}catch{if(!disposed&&generation===epoch){feedback.textContent='本页已停止接收；服务端会在心跳超时后释放采集会话。';render();}}
 }
 async function toggle(){
  if(lease||starting){await stop();return;}if(mode!=='live'||!canWrite()||document.hidden||signal?.aborted||disposed||catalogError)return;const epoch=++generation;starting=true;connection='connecting';feedback.textContent='';render();
  try{const result=await invoke('diagnosticStart',{});if(typeof result.leaseId!=='string')throw Error('实时调试响应无效');if(disposed||epoch!==generation||mode!=='live'||document.hidden){await invoke('diagnosticStop',{leaseId:result.leaseId});return;}starting=false;connection='live';lease=result.leaseId;cursor=0;liveRows=[];dropped=localDropped=0;follow=true;selected=null;render();
   renewTimer=setInterval(async()=>{try{await invoke('diagnosticRenew',{leaseId:result.leaseId});}catch{if(epoch===generation)await disconnect('连接中断，实时调试已关闭，请手动重新开启。');}},5000);renewTimer.unref?.();pump(epoch);
  }catch(error){if(epoch!==generation||disposed)return;starting=false;connection='error';feedback.textContent=safe(error.message);render();}
 }
 async function disconnect(message){connection='error';const stopping=stop({quiet:true}),epoch=generation;await stopping;if(!disposed&&epoch===generation){feedback.textContent=message;render();}}
 async function pump(epoch){
  try{const result=await invoke('diagnosticRead',{leaseId:lease,afterSeq:cursor});if(disposed||epoch!==generation)return;if(result.leaseId!==lease||result.agentId!==agentId)throw Error('调试日志来源不一致');cursor=result.nextSeq;dropped=result.dropped??0;const known=new Set(liveRows.map(row=>row.eventId));liveRows.push(...result.rows.filter(row=>!known.has(row.eventId)));if(liveRows.length>2000){localDropped+=liveRows.length-2000;liveRows=liveRows.slice(-2000);}if(result.gap)feedback.textContent='采集缓冲已覆盖部分记录，当前展示仍可用的日志。';render();pollTimer=setTimeout(()=>pump(epoch),1000);pollTimer.unref?.();}
  catch{if(epoch===generation&&!disposed)await disconnect('读取调试日志失败，已关闭实时调试；请手动重新开启。');}
 }
 function checkAgent(result){if(expectedAgent&&result.agentId!==expectedAgent||agentId&&result.agentId!==agentId)throw Error('日志来源与当前 Agent 不一致');agentId=result.agentId;}
 async function loadHistory(){const epoch=++historyGeneration;historyLoading=true;historyError='';if(mode==='history')feedback.textContent='';render();try{const result=await invoke('diagnosticHistory',{});if(disposed||epoch!==historyGeneration)return;checkAgent(result);historyRows=result.rows??[];historyWarnings=result.warnings??[];historyDropped=result.dropped??0;if(mode==='history')selected=null;if(mode==='history'&&historyWarnings.length)feedback.textContent='部分历史来源暂不可读，可刷新后重试。';}catch(error){if(disposed||epoch!==historyGeneration)return;historyError=safe(error.message);historyRows=[];if(mode==='history')feedback.textContent=historyError;}finally{if(!disposed&&epoch===historyGeneration){historyLoading=false;render();}}}
 async function loadSources(){const epoch=++catalogGeneration;try{const result=await invoke('diagnosticSources',{});if(disposed||epoch!==catalogGeneration)return;if(result.agentId)checkAgent(result);sources=result.sources??[];catalogError='';sourcePicker.replaceChildren();for(const row of [{id:'',label:'全部来源'},...sources]){const caps=capabilities(row),suffix=row.id?' · '+(caps.history&&caps.live?'历史 / 实时':caps.history?'历史':'仅实时'):'';const option=el('option',safe(row.label+suffix));option.value=row.id;sourcePicker.append(option);}if(source&&!sources.some(row=>row.id===source))source='';sourcePicker.value=source;render();}catch(error){if(disposed||epoch!==catalogGeneration)return;catalogError=safe(error.message);feedback.textContent='日志来源暂不可读，请刷新后重试。';render();}}
 function confirmClear(){
  const candidate=actionSource();if(mode!=='history'||!candidate||!capabilities(candidate).clearHistory||!canWrite()||disposed||clearing||confirmation)return;const sourceId=candidate.id;confirmation=el('section',undefined,'ar-log-confirm');confirmation.setAttribute('role','group');confirmation.setAttribute('aria-label','确认清理来源历史');confirmation.append(el('p','清理当前 Agent 的「'+safe(candidate.label)+'」历史记录？仓库日志移入回收站，可在保留期内恢复；其他来源以其能力为准。当前筛选只影响显示，不缩小历史清理范围。'));
  const cancel=btn('取消',()=>dismissConfirmation()),confirm=btn('确认清理',async()=>{if(!canWrite()||disposed||clearing||mode!=='history'||actionSource()?.id!==sourceId)return;clearing=true;confirm.disabled=cancel.disabled=true;render();try{const result=await invoke('diagnosticClearHistory',{sourceId,confirmed:true});if(disposed)return;checkAgent(result);historyRows=historyRows.filter(row=>row.sourceId!==sourceId);dismissConfirmation();if(mode==='history')feedback.textContent='已清理 '+result.cleared+' 条「'+safe(candidate.label)+'」历史记录。';}catch(error){if(!disposed){feedback.textContent=safe(error.message);confirm.disabled=cancel.disabled=false;}}finally{clearing=false;render();}});confirmation.append(cancel,confirm);toolbar.after(confirmation);cancel.focus();
 }
 const hidden=()=>{if(document.hidden)stop();},leave=()=>stop({quiet:true});signal?.addEventListener('abort',leave,{once:true});document.addEventListener('visibilitychange',hidden);document.defaultView.addEventListener('pagehide',leave);
 render();Promise.allSettled([loadHistory(),loadSources()]);
 return {refresh:()=>mode==='history'?loadHistory():loadSources(),dispose(){if(disposed)return;disposed=true;historyGeneration++;catalogGeneration++;stop({quiet:true});signal?.removeEventListener('abort',leave);document.removeEventListener('visibilitychange',hidden);document.removeEventListener('keydown',shortcut);document.defaultView.removeEventListener('pagehide',leave);cleanupVirtual?.();refresh.remove();root.remove();}};
}
