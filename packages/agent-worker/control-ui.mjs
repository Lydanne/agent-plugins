import './control-ui.css';
import {taskTime,toolCalls,callTime,bindTiming,updateTimings} from './timing.mjs';
import {readInspectionResponse} from './inspection-transport.mjs';
import {currentUiTarget,registerWorkerNavigation} from './dist/ui-navigation.mjs';
const labels={awaiting_user:'等待用户',awaiting_main:'等待 Main',queued:'排队中',running:'运行中',completed:'已完成',failed:'失败',timed_out:'超时',cancelled:'已取消',cancelling:'取消中',unknown:'状态未知'};
const active=new Set(['queued','running','cancelling','unknown','awaiting_main','awaiting_user']);
const listGroup=row=>row.status==='unknown'?'unknown':active.has(row.status)?'active':'history';
let dialogSequence=0;
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function button(text,action,className){const node=element('button',text,className);node.type='button';node.onclick=action;return node;}
function time(value){return value?new Date(value).toLocaleString([], {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'时间未记录';}
function fold(title,body){const node=element('details',undefined,'cq-disclosure');body.classList.add('cq-disclosure-body');node.append(element('summary',title),body);return node;}
function disclosureKey(node){const parts=[];let current=node;while(current){if(current.matches('details'))parts.push(current.dataset.foldKey??current.querySelector('summary')?.textContent);if(current.dataset.recordKey)parts.push(current.dataset.recordKey);current=current.parentElement;}return JSON.stringify(parts);}
function messageText(text){
 const content=element('div',undefined,'cq-message-text');
 const fenced=[...text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)];if(fenced.length){let offset=0;for(const match of fenced){if(match.index>offset)content.append(messageText(text.slice(offset,match.index)));content.append(sourceView('代码'+(match[1].trim()?' · '+match[1].trim():''),match[2].replace(/\n$/,''),value=>value));offset=match.index+match[0].length;}if(offset<text.length)content.append(messageText(text.slice(offset)));return content;}
 for(const paragraph of text.split(/\n\s*\n/)){
  const line=element('p');let offset=0;
  for(const match of paragraph.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g)){
   line.append(document.createTextNode(paragraph.slice(offset,match.index)),element(match[1]?'strong':'code',match[1]??match[2]));offset=match.index+match[0].length;
  }
  line.append(document.createTextNode(paragraph.slice(offset)));content.append(line);
 }return content;
}
function messageHeading(actor,at,openOriginal){
 const heading=element('div',undefined,'cq-message-heading'),avatar=element('span',actor==='用户'?'U':actor.startsWith('Main')?'M':'W','cq-avatar');
 const identity=element('span',undefined,'cq-identity');identity.append(element('strong',actor),element('span',actor==='用户'?'卡片补充':actor.startsWith('Main')?'任务交接':'执行回复','cq-speaker-note'));
 heading.append(avatar,identity,element('time',time(at)));if(openOriginal)heading.append(button('原始消息',openOriginal,'cq-original-button'));return heading;
}
function information(fields){
 const list=element('dl',undefined,'cq-information');
 for(const [label,value] of fields){if(value===undefined||value===null||value==='')continue;const cell=element('dd',undefined,['任务标识','会话标识'].includes(label)?'cq-identifier':undefined);if(value?.nodeType)cell.append(value);else cell.textContent=value;list.append(element('dt',label),cell);}return list;
}
function processStage(label,at,state='done'){
 const stage=element('div',undefined,'cq-stage '+state);stage.append(element('span',undefined,'cq-stage-dot'),element('strong',label),element('time',time(at)));return stage;
}
const toolRecords=toolCalls;
const taskClock=task=>{const node=bindTiming(element('span',undefined,'cq-elapsed'),now=>taskTime(task,now));node.title='从任务受理到结束，包含排队、执行及等待；不包含结果交付。';return node;};
function sourceLine(text,json){
 const code=element('code',undefined,'cq-line-content');if(!json){code.textContent=text||' ';return code;}let offset=0;
 for(const token of text.matchAll(/"(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)){code.append(document.createTextNode(text.slice(offset,token.index)));const kind=token[0].endsWith(':')?'key':token[0].startsWith('"')?'string':'literal';code.append(element('span',token[0],'cq-token-'+kind));offset=token.index+token[0].length;}
 code.append(document.createTextNode(text.slice(offset)||(!text?' ':'')));return code;
}
function sourceView(title,value,redact){
 const isText=typeof value==='string',text=redact(isText?value:JSON.stringify(value,null,2));
 const body=element('div',undefined,'cq-source'),toolbar=element('div',undefined,'cq-source-toolbar');
 toolbar.append(element('span',isText?'TEXT':'JSON','cq-source-kind'));
 const code=element('pre',undefined,'cq-source-code'),wrap=button('不换行',()=>{const nowrap=code.classList.toggle('cq-nowrap');wrap.textContent=nowrap?'自动换行':'不换行';wrap.setAttribute('aria-pressed',String(nowrap));});wrap.setAttribute('aria-pressed','false');
 const feedback=element('span',undefined,'cq-source-feedback');feedback.setAttribute('role','status');
 const copy=button('复制',async()=>{try{await navigator.clipboard.writeText(text);feedback.textContent='已复制';}catch{feedback.textContent='复制失败，请选择文本复制';}});
 toolbar.append(wrap,copy);body.append(toolbar,feedback);
 const lines=text.split('\n');code.setAttribute('tabindex','0');code.setAttribute('aria-label',title+'源码');
 body.append(code);const section=fold(`${title} · ${lines.length} 行`,body);section.dataset.foldKey=title;section.classList.add('cq-source-section');
 section.addEventListener('toggle',()=>{if(!section.open||code.childElementCount)return;for(const [index,line] of lines.entries()){const row=element('span',undefined,'cq-source-line'),number=element('span',String(index+1),'cq-line-number');number.setAttribute('aria-hidden','true');row.append(number,sourceLine(line,!isText));code.append(row);}});return section;
}
function callFailed(item){return item.status==='failed'||(typeof item.exit_code==='number'&&item.exit_code!==0)||Boolean(item.error);}
function showCalls(events,redact,task={}){const area=element('div',undefined,'cq-calls');for(const record of events.every(e=>e.callKey!==undefined)?events:toolRecords(events)){
 const {item,time:at}=record;
 const kind=item.type==='mcp_tool_call'?'MCP':item.type==='web_search'?'网站访问 / 搜索':item.type==='file_change'?'文件变更':/SKILL\.md/i.test(item.command??'')?'技能相关命令':'工具命令';
 const name=item.type==='mcp_tool_call'?`${item.server} / ${item.tool}`:item.command?.split('\n')[0];
 const body=element('div'),meta=element('div',undefined,'cq-call-meta');meta.append(element('time',time(at)));
 if(record.startedAt!==undefined)meta.append(element('span','开始 '+time(record.startedAt)));
 if(record.finishedAt!==undefined)meta.append(element('span','结束 '+time(record.finishedAt)));
 if(item.status)meta.append(element('span',redact(labels[item.status]??item.status)));
 if(item.exit_code!==undefined)meta.append(element('span',`退出码 ${item.exit_code}`));body.append(meta);
 const add=(title,value)=>{if(value!==undefined&&value!==null)body.append(sourceView(title,value,redact));};
 add('执行命令',item.command);add('调用参数',item.arguments);add('执行输出',item.aggregated_output);add('返回结果',item.result);add('错误信息',item.error);add('网站操作',item.action);
 if(Array.isArray(item.changes)){const changes=element('div');for(const change of item.changes){const entry=element('div');entry.append(sourceView('变更记录',change,redact));changes.append(fold(redact(`${change.kind??'修改'} · ${change.path??'文件'}`),entry));}body.append(fold(`变更文件 · ${item.changes.length}`,changes));}
 const urls=JSON.stringify(item).match(/https?:\/\/[^\s"<>\\]+/g)??[],links=element('div',undefined,'cq-call-links');
 for(const url of [...new Set(urls)]){try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)continue;const a=element('a',redact(url));a.href=redact(url);a.target='_blank';a.rel='noopener noreferrer';links.append(a);}catch{}}
 if(links.childElementCount)body.append(fold(`相关网站 · ${links.childElementCount}`,links));
 if(/SKILL\.md/i.test(item.command??''))body.append(element('p','包含技能文件路径的命令；不证明技能被完整读取或遵循。','cq-muted'));
 body.append(sourceView('原始记录',record,redact));
 const failed=callFailed(item),call=fold('',body);if(failed)call.classList.add('cq-call-failed');const clock=bindTiming(element('span',undefined,'cq-call-elapsed'),now=>callTime(record,task,now));clock.title=record.startedAt===undefined?'耗时未记录':record.finishedAt!==undefined?'工具调用耗时':'工具调用已用时；尚未取得完成记录';call.querySelector('summary').append(element('span',redact((failed?'执行失败 · ':'')+kind+(name?' · '+name:'')),'cq-call-name'),clock);call.dataset.foldKey=redact(record.callKey);area.append(call);
 }return area;}
function processTimeline(record,safe){
 const wrapper=element('div',undefined,'cq-process-view');
 const waiting=['awaiting_main','awaiting_user'].includes(record.status);
 if(waiting){const note=element('div',undefined,'cq-process-current '+record.status);note.append(element('strong',labels[record.status]),element('p',record.status==='awaiting_user'?'Main 需要用户补充信息，原任务暂时暂停。':'Worker 已提出问题，等待 Main 补充上下文。'));wrapper.append(note);}
 const timeline=element('div',undefined,'cq-process'),entries=[{kind:'accepted',at:record.createdAt,label:'任务受理'},{kind:'started',at:record.startedAt,label:'Worker 开始执行'}].filter(e=>e.at);
 for(const round of record.executionRounds??[])if(round.resumed)entries.push({kind:'resumed',at:round.startedAt,label:'Worker 继续执行'});
 for(const event of toolRecords(record.events)){
  const type=event.item.type;entries.push({kind:'tool',at:event.startedAt??event.time,event,label:({command_execution:'Worker · 执行命令',mcp_tool_call:'Worker · 调用 MCP',web_search:'Worker · 网站访问 / 搜索',file_change:'Worker · 文件变更'})[type]??'Worker · 工具调用'});
 }
 for(const q of record.questions??[]){entries.push({kind:'question',at:q.createdAt,label:q.requestKind==='plugin'?'Worker · 请求插件能力':'Worker · 请求上下文',question:q});if(q.waitingForUserAt)entries.push({kind:'waiting_user',at:q.waitingForUserAt,label:'Main · 等待用户补充'});if(q.answer)entries.push({kind:'answer',at:q.answeredAt,label:q.answerSource==='user_card'?'用户 · 卡片选择':q.answerSource==='main_context'?'Main · 自动补充':'Main · 补充上下文',question:q});}
 if(record.finishedAt)entries.push({kind:'finished',at:record.finishedAt,label:labels[record.status]??record.status});
 for(const entry of entries.sort((a,b)=>(a.at??0)-(b.at??0))){
  const node=element('section',undefined,'cq-process-node'),state=entry.kind==='question'&&!entry.question.answer?'awaiting_main':entry.kind==='waiting_user'?'awaiting_user':entry.kind==='finished'?record.status:entry.kind==='tool'&&callFailed(entry.event.item)?'failed':'done';
  node.append(processStage(entry.label,entry.at,state));const content=element('div',undefined,'cq-process-body');
  if(entry.kind==='tool')content.append(showCalls([entry.event],safe,record));
  if(entry.kind==='question'){const q=entry.question;content.append(messageText(safe(q.question)),fold('原因与已完成工作',messageText(safe(q.reason+'\n'+q.progress))),sourceView('提问原文',q,safe));}
  if(entry.kind==='answer'){const q=entry.question;content.append(messageText(safe(q.answer)));if(q.answerBasis)content.append(element('small',safe('依据：'+q.answerBasis),'cq-muted'));if(q.answerValues)content.append(fold('已提交字段',information(Object.entries(q.answerValues).map(([id,value])=>[q.fields?.find(f=>f.id===id)?.label??id,safe(typeof value==='string'?value:JSON.stringify(value))]))));content.append(sourceView('补充上下文原文',q,safe));}
  if(entry.kind==='waiting_user')content.append(element('p','等待用户回答；收到补充后继续原任务。','cq-muted'));
  if(content.childNodes.length)node.append(content);timeline.append(node);
 }
 wrapper.append(timeline);return wrapper;
}
export function mountPanel(container,initial){
 let context=initial,disposed=false,generation=0,selected=initial.props.topic??null,selectedScope=initial.props.executionScope,selectedModelScope=initial.props.modelSessionScope,selectedJobId=initial.props.jobId,view='records',filter='all',query='',projectFilter=initial.props.projectId??'',sort='heat',offset=0,historyOffset=0,rows=[],data=null,error=null,loading=false,signature='',timer;
 const root=element('section',undefined,'cq-panel');root.setAttribute('aria-label','Agent Worker 会话');container.append(root);
 const safe=value=>context.host.redact(String(value??''));
 let deleteDialog=null,deleting=false,observedWrite=context.host.connection.canWrite,selectionMode=false,deleteFeedback=null;
 const checked=new Map(),rowKey=row=>JSON.stringify([row.topic,row.executionScope??null,row.modelSessionScope??null]);
 function clearSelection(){selectionMode=false;checked.clear();}
 function closeMenus(except){for(const menu of root.querySelectorAll('.cq-more[open]'))if(menu!==except)menu.open=false;}
 function outsideMenu(event){if(!root.contains(event.target)||!event.target.closest('.cq-more'))closeMenus();}
 function escapeMenu(event){if(event.key!=='Escape')return;const menu=root.querySelector('.cq-more[open]');if(menu){menu.open=false;menu.querySelector('summary').focus();event.preventDefault();}}
 document.addEventListener('pointerdown',outsideMenu);root.addEventListener('keydown',escapeMenu);
 function moreMenu(row){
  if(context.host.connection.canWrite!==true)return null;
  const menu=element('details',undefined,'cq-more'),trigger=element('summary'),actions=element('div',undefined,'cq-more-actions');
  const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 20 20');icon.setAttribute('width','18');icon.setAttribute('height','18');icon.setAttribute('aria-hidden','true');icon.setAttribute('focusable','false');
  for(const x of [4,10,16]){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('cx',String(x));dot.setAttribute('cy','10');dot.setAttribute('r','1.5');dot.setAttribute('fill','currentColor');icon.append(dot);}trigger.append(icon);trigger.title='更多';
  trigger.setAttribute('aria-label',row?safe((row.projectId?row.projectId+' / ':'')+row.topic+(row.model?' · '+row.model:'')+' 的更多操作'):'会话列表更多操作');
  menu.addEventListener('toggle',()=>{if(menu.open){closeMenus(menu);menu.classList.remove('cq-more-up');if(actions.getBoundingClientRect().bottom>root.getBoundingClientRect().bottom&&menu.getBoundingClientRect().top-actions.offsetHeight>root.getBoundingClientRect().top)menu.classList.add('cq-more-up');}});
  const add=(label,action,className)=>{const control=button(label,()=>{menu.open=false;action();},className);control.setAttribute('aria-label',label);actions.append(control);return control;};
  if(row){const remove=add('删除会话',()=>confirmDelete([row]),'cq-delete');remove.disabled=deleting||row.canDelete!==true;remove.title=safe(row.deleteReason??'删除此会话的历史任务和复用绑定');
   if(!selected){const pick=add('选择会话',()=>{selectionMode=true;toggleSelection(row);});pick.disabled=deleting||row.canDelete!==true;pick.title=safe(row.deleteReason??'选择此会话进行批量操作');}
  }else add('多选会话',()=>{selectionMode=true;render();root.querySelector('[aria-label="全选已加载的可删除会话"]')?.focus();});
  menu.append(trigger,actions);return menu;
 }
 function toggleSelection(row){
  if(deleting||row.canDelete!==true)return;const key=rowKey(row);
  if(checked.has(key))checked.delete(key);else checked.set(key,{...row});render();
  [...root.querySelectorAll('.cq-session-check')].find(input=>input.dataset.key===key)?.focus();
 }
 function selectionToolbar(){
  const bar=element('div',undefined,'cq-selection-bar'),eligible=rows.filter(row=>row.canDelete===true),label=element('label'),all=element('input');all.type='checkbox';all.setAttribute('aria-label','全选已加载的可删除会话');
  const count=eligible.filter(row=>checked.has(rowKey(row))).length;all.checked=eligible.length>0&&count===eligible.length;all.indeterminate=count>0&&count<eligible.length;all.disabled=deleting||!eligible.length;
  all.onchange=()=>{for(const row of eligible){if(all.checked)checked.set(rowKey(row),{...row});else checked.delete(rowKey(row));}render();root.querySelector('[aria-label="全选已加载的可删除会话"]')?.focus();};
  label.append(all,element('span','全选已加载'));const status=element('span',`已选 ${checked.size} 个会话`);status.setAttribute('role','status');bar.append(label,status);
  if(checked.size){const remove=button(`删除所选 (${checked.size})`,()=>confirmDelete([...checked.values()],true),'cq-delete');remove.disabled=deleting;bar.append(remove);}
  const cancel=button('取消多选',()=>{clearSelection();render();root.querySelector('header .cq-more summary')?.focus();});cancel.disabled=deleting;bar.append(cancel);return bar;
 }
 function closeDelete(){const dialog=deleteDialog;deleteDialog=null;if(dialog){dialog.close();dialog.remove();}}
 function confirmDelete(targets,bulk=false){
  if(disposed||deleting||context.host.connection.canWrite!==true||!targets.length||targets.some(row=>row.canDelete!==true))return;
  const chosen=targets.map(row=>({...row}));closeMenus();closeDelete();const owner=context,dialog=element('dialog',undefined,'cq-raw-dialog cq-delete-dialog'),panel=element('section',undefined,'cq-panel cq-modal-panel');deleteDialog=dialog;
  const title=element('h2',bulk?`删除所选的 ${chosen.length} 个会话？`:'删除会话？');title.id='cq-delete-title-'+(++dialogSequence);dialog.setAttribute('aria-labelledby',title.id);
  const names=element('ul',undefined,'cq-delete-targets');for(const row of chosen)names.append(element('li',safe((row.projectId?row.projectId+' / ':'')+row.topic+(row.model?' · '+row.model:''))));
  const tasks=chosen.reduce((sum,row)=>sum+(row.taskCount??0),0);panel.append(title,names,element('p',`将从列表移除${bulk?'所选会话':'此会话'}及其 ${tasks} 条历史任务；再次使用此主题会开启新会话。已生成的报告和附件保留。`));
  const feedback=element('p',undefined,'cq-error');feedback.setAttribute('role','alert');
  const isCurrent=()=>!disposed&&deleteDialog===dialog&&owner.props.sessionKey===context.props.sessionKey&&owner.props.agentId===context.props.agentId&&context.presented&&context.host.connection.canRead&&context.host.connection.canWrite===true;
  const cancel=button('取消',closeDelete),confirm=button(bulk?'确认批量删除':'确认删除',async()=>{
   if(deleting||!isCurrent())return;
   deleting=true;generation++;confirm.disabled=cancel.disabled=true;feedback.textContent='';const failed=[];let succeeded=0;
   try{
    for(const row of chosen){
     if(!isCurrent())return;
     feedback.textContent=bulk?`正在删除 ${succeeded+failed.length+1} / ${chosen.length}…`:'';
     try{const result=await invoke('deleteSession',{topic:row.topic,executionScope:row.executionScope??null,modelSessionScope:row.modelSessionScope??null,projectId:row.projectId??undefined,revision:row.deletionRevision,confirmed:true});if(result?.deleted!==true)throw Error('未收到删除成功确认，请刷新核对。');succeeded++;if(isCurrent())checked.delete(rowKey(row));}
     catch(e){failed.push({row,message:e.message});}
    }
    if(!isCurrent())return;
    if(!bulk&&failed.length){feedback.textContent=safe(failed[0].message);confirm.disabled=cancel.disabled=false;return;}
    deleteFeedback={failed:failed.length>0,text:failed.length?safe(`已删除 ${succeeded} 个会话，${failed.length} 个未确认删除：`+failed.map(({row,message})=>row.topic+'：'+message).join('；')):`已删除 ${succeeded} 个会话。`};
    closeDelete();closeOriginal();collapsedTasks.clear();deleting=false;error=null;if(!failed.length)clearSelection();back();
   }finally{deleting=false;}
  },'cq-delete');
  cancel.autofocus=true;const actions=element('div',undefined,'cq-delete-actions');actions.append(cancel,confirm);panel.append(feedback,actions);dialog.append(panel);container.append(dialog);dialog.addEventListener('cancel',event=>{if(deleting)event.preventDefault();});dialog.addEventListener('close',()=>{dialog.remove();if(deleteDialog===dialog)deleteDialog=null;root.querySelector('.cq-refresh')?.focus();});dialog.showModal();
 }
 let rawDialog=null;const collapsedTasks=new Set();
 function closeOriginal(){if(rawDialog){rawDialog.close();rawDialog.remove();rawDialog=null;}}
 function openOriginal(actor,record,snapshot){
  closeOriginal();const payload=snapshot?.raw??snapshot??(actor.startsWith('Main')?record.request:{messages:record.events.filter(e=>e.event==='item.completed'&&e.item?.type==='agent_message'),result:record.result??null,questions:record.questions??[]});
  const dialog=element('dialog',undefined,'cq-raw-dialog'),panel=element('section',undefined,'cq-panel cq-modal-panel');rawDialog=dialog;
  const heading=element('header'),title=element('strong',actor+' 原始消息');title.id='cq-raw-message-title-'+(++dialogSequence);dialog.setAttribute('aria-labelledby',title.id);
  const close=button('关闭',closeOriginal,'cq-dialog-close');close.autofocus=true;heading.append(title,close);panel.append(heading);
  panel.append(element('div',`任务 ${safe(record.jobId)} · ${time(snapshot?.at??record.createdAt)}`,'cq-muted'),element('p','展示已保存且经过脱敏的消息快照。','cq-muted'));
  const body=element('div',undefined,'cq-scroll cq-modal-body'),source=sourceView('原始 JSON',payload,safe);source.classList.add('cq-modal-source');source.open=true;body.append(source);panel.append(body);dialog.append(panel);container.append(dialog);
  dialog.addEventListener('close',()=>{dialog.remove();if(rawDialog===dialog)rawDialog=null;if(!rawDialog)root.querySelector('.cq-refresh')?.focus();});
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeOriginal();});dialog.showModal();
 }

 async function invoke(action,payload){const current=context;return readInspectionResponse(async(name,data)=>{current.signal.throwIfAborted();if(current!==context)throw Error('会话已切换');const response=await current.host.request('plugins.sessionAction',{pluginId:'agent-worker',actionId:'inspect-'+name,sessionKey:current.props.sessionKey,agentId:current.props.agentId,payload:data});current.signal.throwIfAborted();return response;},action,payload);}
 async function refresh(append=false,appendHistory=false){
  if(disposed||deleting||deleteDialog||root.querySelector('.cq-more[open]')||context.signal.aborted||!context.presented||!context.host.connection.canRead||!context.props.sessionKey)return;
  const request=++generation;loading=true;if(!rows.length&&!data)render();
  try{const result=await invoke(selected?'detail':'list',selected?{topic:selected,executionScope:selectedScope,modelSessionScope:selectedModelScope,projectId:projectFilter||undefined,offset,limit:1,historyOffset,jobId:selectedJobId}:{query,projectId:projectFilter||undefined,sort,offset,limit:30});if(disposed||request!==generation||!context.presented||!context.host.connection.canRead)return;
   error=null;loading=false;
   if(selected){offset=result.offset;const previous=data;data=append&&previous?{...result,records:[...result.records,...previous.records]}:result;if(appendHistory&&previous)data.taskHistory=[...new Map([...previous.taskHistory,...result.taskHistory].filter(task=>!result.currentTasks.some(current=>current.jobId===task.jobId)).map(task=>[task.jobId,task])).values()].sort((a,b)=>b.createdAt-a.createdAt);}
   else {data=null;rows=append?[...rows,...result.sessions]:result.sessions;listResult=result;projectIds=result.projectIds??[];
    let invalidated=0;for(const row of rows){const previous=checked.get(rowKey(row));if(previous&&(row.canDelete!==true||row.deletionRevision!==previous.deletionRevision)){checked.delete(rowKey(row));invalidated++;}}
    if(invalidated)deleteFeedback={failed:true,text:(deleteFeedback?.failed?deleteFeedback.text+'；':'')+`${invalidated} 个会话已变化或不可删除，已取消选择，请核对后重新选择。`};}
   const next=JSON.stringify({rows,data,listResult,error});if(next!==signature||(!rows.length&&!data)){signature=next;render();}
  }catch(e){if(disposed||request!==generation||!context.presented||!context.host.connection.canRead)return;loading=false;error=safe(e.message);render();}
 }
 let listResult=null,projectIds=[];
 function choose(topic,executionScope,modelSessionScope){clearSelection();deleteFeedback=null;closeDelete();selected=topic;selectedScope=executionScope??null;selectedModelScope=modelSessionScope??null;selectedJobId=undefined;offset=0;historyOffset=0;data=null;view='records';signature='';render();refresh();}
 function back(){closeDelete();selected=null;selectedScope=undefined;selectedModelScope=undefined;selectedJobId=undefined;offset=0;historyOffset=0;data=null;rows=[];signature='';render();refresh();}
 function render(){
  const scroll=root.querySelector('.cq-scroll')?.scrollTop??0;
  const expanded=new Set([...root.querySelectorAll('details[open]:not(.cq-more)')].map(disclosureKey));
  root.replaceChildren();root.classList.toggle('cq-detail',!!selected);const header=element('header');
  const refreshButton=button('刷新',()=>{historyOffset=0;if(!selected)offset=0;signature='';refresh();},'cq-refresh');
  const headerActions=element('div',undefined,'cq-header-actions');headerActions.append(refreshButton);
  if(selected)header.append(button('← 会话列表',back,'cq-back'));else {header.append(element('strong','Agent Worker 会话'));if(!selectionMode){const menu=moreMenu();if(menu)headerActions.append(menu);}}header.append(headerActions);root.append(header);
  if(!context.host.connection.canRead){root.append(element('p','需要 operator.read 权限才能查看。'));return;}
  if(!context.props.sessionKey){root.append(element('p','请选择当前 Agent 的会话后查看项目任务。'));return;}
  if(deleteFeedback){const notice=element('div',undefined,deleteFeedback.failed?'cq-bulk-feedback cq-error':'cq-bulk-feedback');notice.setAttribute('role',deleteFeedback.failed?'alert':'status');notice.append(element('span',deleteFeedback.text),button('关闭提示',()=>{deleteFeedback=null;render();}));root.append(notice);}
  if(error){root.append(element('p',error,'cq-error'),button('重试',()=>refresh()));}
  if(selected){const heading=element('div',undefined,'cq-detail-title');const title=element('h2',safe(selected));title.title=safe(selected);heading.append(title);const current=data?.session??data?.records.at(-1);if(current)heading.append(element('span',labels[current.status]??current.status,'cq-state '+current.status));const remove=data?.session&&moreMenu(data.session);if(remove)heading.append(remove);root.append(heading);const tabs=element('nav',undefined,'cq-detail-tabs');for(const [id,name] of [['records','对话记录'],['process','任务过程'],['info','任务信息'],['session','会话信息']]){const b=button(name,()=>{view=id;root.querySelector('.cq-scroll')?.scrollTo(0,0);render();},view===id?'cq-selected':'');b.setAttribute('aria-pressed',String(view===id));tabs.append(b);}root.append(tabs);}
  else {
   const project=element('select');project.setAttribute('aria-label','Worker 项目筛选');const all=element('option','所有项目');all.value='';project.append(all);for(const id of [...new Set([...projectIds,projectFilter].filter(Boolean))]){const option=element('option',safe(id));option.value=id;project.append(option);}project.value=projectFilter;project.onchange=()=>{clearSelection();generation++;projectFilter=project.value;offset=0;rows=[];data=null;listResult=null;error=null;signature='';refresh();};root.append(project);
   if(projectFilter)root.append(element('p',safe('项目 · '+projectFilter),'cq-muted'));
   const summary=element('div',listResult?`当前聊天 · 运行 ${listResult?.counts.running??0} 个任务 · 排队 ${listResult?.counts.queued??0} 个任务${listResult?.counts.awaitingMain?' · 等待 Main '+listResult.counts.awaitingMain+' 个任务':''}${listResult?.counts.awaitingUser?' · 等待用户 '+listResult.counts.awaitingUser+' 个任务':''}`:loading?'当前聊天 · 正在读取任务统计…':'当前聊天 · 任务统计尚未读取','cq-muted');root.append(summary);
   const input=element('input');input.placeholder='搜索会话或标签';input.setAttribute('aria-label','搜索会话或标签');input.value=query;input.onchange=()=>{clearSelection();query=input.value;offset=0;rows=[];signature='';refresh();};root.append(input);
   const options=element('div',undefined,'cq-options'),select=element('select');select.setAttribute('aria-label','会话排序');for(const [value,label] of [['heat','热度优先'],['recent','最近活动']]){const o=element('option',label);o.value=value;select.append(o);}select.value=sort;select.onchange=()=>{clearSelection();sort=select.value;offset=0;rows=[];signature='';refresh();};options.append(fold('热度说明',element('p',listResult?.heatPolicy??'有效交互随时间衰减；查询不增加热度。')),select);root.append(options);
  }
  if(!selected&&selectionMode&&context.host.connection.canWrite===true)root.append(selectionToolbar());
  const body=element('div',undefined,'cq-scroll');root.append(body);
  if(loading&&!rows.length&&!data)body.append(element('p','正在读取…','cq-muted'));
  if(!selected){
   for(const [title,groupId] of [['进行中','active'],['历史会话','history'],['状态待确认','unknown']]){
    const group=rows.filter(row=>listGroup(row)===groupId),total=listResult?.groupCounts?.[groupId]??group.length;
    if(!total)continue;
    const content=element('div',undefined,'cq-session-group');
    const count=group.length<total?`${group.length} / ${total}`:String(total);
    if(groupId!=='unknown'){const heading=element('h3',undefined,'cq-group-heading');heading.append(element('span',title),element('span',count,'cq-group-count'));heading.title=group.length<total?'已加载会话数 / 匹配会话总数':'匹配会话总数';body.append(heading,content);}
    else {const pending=fold(`${title} · ${count}`,content);pending.classList.add('cq-pending-group');pending.dataset.foldKey='unknown-sessions';body.append(pending);content.append(element('p','这些会话的执行状态暂无法核实，不计入已确认的运行任务。','cq-muted'));}
    for(const row of group){
     const entry=element('article',undefined,'cq-row');entry.dataset.recordKey=row.topic+':'+(row.executionScope??'legacy')+':'+(row.modelSessionScope??'legacy');
     if(selectionMode){const check=element('input');check.type='checkbox';check.className='cq-session-check';check.dataset.key=rowKey(row);check.setAttribute('aria-label',safe('选择会话 '+(row.projectId?row.projectId+' / ':'')+row.topic+(row.model?' · '+row.model:'')));check.checked=checked.has(rowKey(row));check.disabled=deleting||row.canDelete!==true;check.title=safe(row.deleteReason??'');check.onchange=()=>toggleSelection(row);entry.append(check);if(check.checked)entry.classList.add('cq-row-checked');}
     const open=button('',()=>selectionMode?toggleSelection(row):choose(row.topic,row.executionScope,row.modelSessionScope),'cq-row-open'),top=element('div',undefined,'cq-row-top'),title=element('strong',safe(row.projectId?row.projectId+' / '+row.topic:row.topic));title.title=safe(row.repository??row.topic);
     open.disabled=selectionMode&&(deleting||row.canDelete!==true);if(selectionMode&&row.deleteReason)open.title=safe(row.deleteReason);
     if(row.model)open.append(element('small',safe((row.harness??'codex')+' / '+row.model),'cq-muted'));
     top.append(title,element('span',(labels[row.status]??row.status)+(row.activeCount>1?` · ${row.activeCount}`:''),'cq-state '+row.status));open.append(top);
     const progress=safe(row.progress);if(progress&&!['执行已完成','结果已交付','历史任务记录不可用'].includes(progress)){const description=element('p',progress,'cq-muted');description.title=progress;open.append(description);}entry.append(open);
     const metrics=element('div',undefined,'cq-row-meta');const stats=element('div',undefined,'cq-metrics');stats.append(taskClock({...row,createdAt:row.jobCreatedAt}),element('span',`热度 ${row.heat}`,'cq-heat'),element('span',`${row.interactionCount} 次交互`),element('span',`${row.taskCount} 个任务`));
     const delivery=({delivered:'已交付',pending:'待交付',processing:'交付处理中',sending:'发送中',suppressed:'已抑制',uncertain:'交付待核查'})[row.notificationState]??(progress==='结果已交付'?'已交付':null);if(delivery)stats.append(element('span',delivery,'cq-delivery'));
     const updated=element('time',time(row.updatedAt));updated.title='最近活动 · '+time(row.updatedAt);metrics.append(stats,updated);const menu=!selectionMode&&moreMenu(row);if(menu)metrics.append(menu);entry.append(metrics);
     if(row.tags.length){const meta=element('div',undefined,'cq-tags');for(const tag of row.tags.slice(0,2)){const chip=element('span',safe(tag));chip.title=safe(tag);meta.append(chip);}if(row.tags.length>2){const extra=element('div',undefined,'cq-expanded-tags');for(const tag of row.tags.slice(2)){const chip=element('span',safe(tag));chip.title=safe(tag);extra.append(chip);}const more=fold(`+${row.tags.length-2}`,extra);more.dataset.foldKey='tags';more.classList.add('cq-tag-disclosure');meta.append(more);}entry.append(meta);}
     content.append(entry);
    }
   }
   if(!rows.length&&!loading&&!error)body.append(element('p','没有匹配的会话','cq-muted'));
   if(listResult?.hasMore)body.append(button('加载更多会话',()=>{offset+=30;refresh(true);}));
  }else if(data){
   if(view==='records'){const controls=element('nav',undefined,'cq-record-filters');for(const id of ['all','Main','Worker'])controls.append(button(id==='all'?'全部':id,()=>{filter=id;root.querySelector('.cq-scroll')?.scrollTo(0,0);render();},filter===id?'cq-selected':''));body.append(controls);}
   if(view==='session'){
    const session=data.session;
    if(session){body.append(information([['会话主题',safe(session.topic)],['运行目录',session.workspacePending?'等待分配 workspace':session.cwd?safe(session.cwd):'未记录运行目录'],['目录类型',session.workspacePending?'workspace（待分配）':session.cwd?(session.directoryKind==='workspace'?'独立 workspace':'项目目录'):'未知'],['执行模型',safe(session.model?(session.harness??'codex')+' / '+session.model:'旧会话未记录模型')],['会话标识',session.sessionId?safe(session.sessionId):'尚无可读取的 Worker 会话标识'],['所属聊天','当前聊天'],['Main',safe(context.props.agentId)],['整体状态',labels[session.status]??session.status],['当前进度',safe(session.progress)],['会话热度',String(session.heat)],['有效交互',`${session.interactionCount} 次`],['任务总数',`${session.taskCount} 个`],['进行中',`${session.activeCount??0} 个任务 · 运行 ${session.runningCount??0} · 排队 ${session.queuedCount??0} · 等待 Main ${session.awaitingMainCount??0} · 等待用户 ${session.awaitingUserCount??0}`],['首次任务',time(session.createdAt)],['最近活动',time(session.updatedAt)]]));const tags=element('div',undefined,'cq-session-tags');tags.append(element('h3','会话标签'));const chips=element('div',undefined,'cq-expanded-tags');for(const tag of session.tags)chips.append(element('span',safe(tag)));if(!session.tags.length)chips.append(element('span','暂无标签'));tags.append(chips);body.append(tags,element('p','热度按任务受理及 Worker 完成计算，7 天半衰期；查询和心跳不增加热度。','cq-muted'));}
    else body.append(element('p','没有可读取的会话基础信息。','cq-muted'));
   }
   const taskList=(title,tasks,empty)=>{
    const section=element('section',undefined,'cq-task-list');section.append(element('h3',title));
    if(!tasks.length)section.append(element('p',empty,'cq-muted'));
    for(const task of tasks){
     const record=data.records.find(record=>record.jobId===task.jobId),expanded=record&&!collapsedTasks.has(task.jobId),card=element('article',undefined,'cq-task-card');card.dataset.recordKey=task.jobId;
     const entry=button('',()=>{if(record){if(expanded)collapsedTasks.add(task.jobId);else collapsedTasks.delete(task.jobId);render();return;}collapsedTasks.delete(task.jobId);selectedJobId=task.jobId;offset=task.index;signature='';refresh(false,true);},'cq-task-entry');
     entry.setAttribute('aria-expanded',String(!!expanded));
     const heading=element('div',undefined,'cq-task-heading');heading.append(element('time',time(task.createdAt)),taskClock(task),element('span',labels[task.status]??task.status,'cq-state '+task.status));entry.append(heading);card.append(entry);
     if(expanded){
      card.classList.add('cq-task-selected');const details=element('div',undefined,'cq-task-details');
      if(record.request.availability==='available'){
       details.append(messageText(safe(record.request.task)));
       if(record.request.context)details.append(fold('任务上下文',messageText(safe(record.request.context))));
       if(record.request.constraints)details.append(fold('执行限制',messageText(safe(record.request.constraints))));
      }else details.append(element('p',safe(task.task??'原始任务正文不可用，旧任务不会补造任务内容。'),'cq-muted'));
      details.append(information([['任务标识',safe(record.jobId)],['执行模型',safe(record.model?(record.harness??'codex')+' / '+record.model:'旧任务未记录模型')],['任务队列',safe(record.queueId??record.taskClass??'short')],['Hermes 模板',safe(record.hermesTemplateId??'旧执行配置')],['用时',taskClock(record)],['受理时间',time(record.createdAt)],['开始时间',time(record.startedAt)],['结束时间',time(record.finishedAt)],[record.notificationKind==='context_request'?'提问投递':'结果交付',({delivered:'已交付',pending:'待交付',processing:'处理中',sending:'发送中',suppressed:'已抑制',uncertain:'待核查'})[record.notificationState]??record.notificationState??'无异步交付记录']]));
      if(record.collaboration){const diagnostic=record.collaboration,delivery=diagnostic.delivery;details.append(fold('Main–Worker 协作诊断',information([['插件请求额度',diagnostic.requests.plugin.used+' / '+diagnostic.requests.plugin.limit],['信息追问额度',diagnostic.requests.context.used+' / '+diagnostic.requests.context.limit],['事件投递尝试',String(delivery.attempts)],['下次重试',time(delivery.retryAt)],['最近失败代码',safe(delivery.lastErrorCode??'无记录')],['等待时长',diagnostic.waiting?Math.floor(diagnostic.waiting.ageMs/1000)+' 秒':'未等待'],['会话最近通知的技能版本',safe(diagnostic.skill.lastNotifiedRevision??'未记录')],['实际读取技能', '未知；更新通知不代表已读取'],['投递说明',safe(delivery.meaning)],['诊断采集时间',time(diagnostic.observedAt)]])));}
      if(record.progress)details.append(fold('当前进度',element('p',safe(record.progress))));if(record.error)details.append(element('p',safe(record.error),'cq-error'));
      const links=element('div',undefined,'cq-task-links');for(const [id,label] of [['records','查看对话'],['process','查看执行过程']])links.append(button(label,()=>{view=id;root.querySelector('.cq-scroll')?.scrollTo(0,0);render();}));links.append(button('原始任务 JSON',()=>openOriginal('Main',record),'cq-original-button'));details.append(links);card.append(details);
     }else {entry.append(element('p',safe(task.task??'任务摘要未保存，点击查看详情'),'cq-task-goal'));entry.title=safe(task.task??'查看任务详情');}
     section.append(card);
    }body.append(section);
   };
   if(view==='info'){
    taskList('当前任务 · '+(data.currentTasks?.length??0),data.currentTasks??[],'当前没有进行中的任务。');
    const history=[...(data.taskHistory??[])];
    for(const record of data.records)if(!active.has(record.status)&&!history.some(task=>task.jobId===record.jobId))history.unshift({...record,index:data.offset,task:record.request.task});
    taskList('历史任务 · '+(data.historyTotal??0),history,'还没有历史任务。');
    if(data.historyHasMore)body.append(button('加载更多历史任务',()=>{historyOffset+=30;refresh(false,true);},'cq-load-earlier'));
   }
   for(const record of ['session','info'].includes(view)?[]:data.records){const block=element('section',undefined,'cq-run');block.dataset.recordKey=record.jobId;const runHeading=element('div',undefined,'cq-run-heading');runHeading.append(element('span',time(record.createdAt)),taskClock(record),element('span',labels[record.status]??record.status,'cq-state '+record.status));block.append(runHeading);
    if(view==='process'){block.append(processTimeline(record,safe));}
    else {
     if(filter!=='Worker'){const main=element('article',undefined,'cq-message main');main.append(messageHeading('Main',record.createdAt,()=>openOriginal('Main',record)));if(record.request.availability==='available'){main.append(messageText(safe(record.request.task)));if(record.request.context)main.append(fold('任务上下文',messageText(safe(record.request.context))));if(record.request.constraints)main.append(fold('执行限制',messageText(safe(record.request.constraints))));}else main.append(element('p','原始任务正文不可用','cq-unavailable'));block.append(main);}
     if(record.questions?.length){
      const messages=record.events.filter(e=>e.event==='item.completed'&&e.item?.type==='agent_message');
      const entries=[];
      for(const message of messages){let protocol;try{protocol=JSON.parse(message.item.text);}catch{}if(!['context_request','request'].includes(protocol?.type))entries.push({actor:'Worker',at:message.time,text:message.item.text,raw:message});}
      if(record.result&&messages.at(-1)?.item.text!==record.result&&!['awaiting_main','awaiting_user'].includes(record.status))entries.push({actor:'Worker',at:record.finishedAt??record.startedAt,text:record.result});
      for(const q of record.questions){entries.push({actor:'Worker',at:q.createdAt,text:q.question,question:q,raw:q});if(q.answer)entries.push({actor:q.answerSource==='user_card'?'用户':'Main',at:q.answeredAt,text:q.answer,raw:q});}
      for(const entry of entries.sort((a,b)=>(a.at??0)-(b.at??0))){
       if(filter!=='all'&&filter!==entry.actor)continue;
       const item=element('article',undefined,'cq-message '+entry.actor.toLowerCase());item.append(messageHeading(entry.actor,entry.at,()=>openOriginal(entry.actor,record,entry)),messageText(safe(entry.text)));
       if(entry.question){const q=entry.question;item.append(element('small',q.requestKind==='plugin'?'请求 Main 调用插件':'请求 Main 补充上下文'),fold('提问原因与已完成工作',messageText(safe(q.reason+'\n'+q.progress))));if(!q.answer)item.append(element('p',['awaiting_main','awaiting_user'].includes(record.status)?(labels[record.status]+' 回复 · ')+time(q.expiresAt)+' 前有效':'任务已结束，问题未回答','cq-muted'));}block.append(item);
      }
      if(filter!=='Main'&&toolRecords(record.events).length)block.append(fold('Worker · 工具与执行记录',showCalls(record.events,safe,record)));
     }
     else if(filter!=='Main'){
      const messages=record.events.filter(e=>e.event==='item.completed'&&e.item?.type==='agent_message'),calls=toolRecords(record.events);const worker=element('article',undefined,'cq-message worker');worker.append(messageHeading('Worker',messages.at(-1)?.time??record.finishedAt??record.startedAt,()=>openOriginal('Worker',record)));
      for(const m of messages){if(messages.length>1)worker.append(element('small',time(m.time),'cq-reply-time'));worker.append(messageText(safe(m.item.text)));}
      if(record.result&&messages.at(-1)?.item.text!==record.result)worker.append(messageText(safe(record.result)));
      if(!messages.length&&!record.result)worker.append(element('p',active.has(record.status)?'尚未收到执行回复':'执行回复不可用','cq-muted'));
      if(calls.length){const mcp=calls.filter(e=>e.item.type==='mcp_tool_call').length,web=calls.filter(e=>e.item.type==='web_search').length,skills=calls.filter(e=>/SKILL\.md/i.test(e.item.command??'')).length;worker.append(fold(`${calls.length} 条执行记录 · MCP ${mcp} · 网站 ${web} · 技能相关命令 ${skills}`,showCalls(record.events,safe,record)));}block.append(worker);
     }
    }
    if(view!=='info'&&record.eventsAvailability!=='available')block.append(element('p','该任务没有可读取的详细过程记录。旧任务不会补造工具细节。','cq-muted'));
    if(record.omitted)block.append(element('p',`日志达到存储上限，${record.omitted} 条事件未保存。`,'cq-error'));
    body.append(block);
   }
   if(!['session','info'].includes(view)&&data.hasMore)body.append(button('加载更早任务',()=>{selectedJobId=undefined;offset++;refresh(true);},'cq-load-earlier'));
   if(view!=='session'&&!data.records.length)body.append(element('p','暂无任务记录'));
  }
  for(const node of root.querySelectorAll('details'))if(!node.classList.contains('cq-more')&&expanded.has(disclosureKey(node)))node.open=true;
  body.scrollTop=scroll;
 }
 const clockTimer=setInterval(()=>{if(!disposed&&context.presented&&context.host.connection.canRead)updateTimings(root);},1000);
 timer=setInterval(()=>{if((offset===0||selectedJobId)&&historyOffset===0&&!(root.contains(document.activeElement)&&document.activeElement.matches('input,select')))refresh();},5000);render();refresh();
 return {update(next){const changed=next.props.sessionKey!==context.props.sessionKey||next.props.agentId!==context.props.agentId||next.props.projectId!==context.props.projectId||next.props.jobId!==context.props.jobId||next.props.topic!==context.props.topic||next.props.executionScope!==context.props.executionScope||next.props.modelSessionScope!==context.props.modelSessionScope;context=next;const writeChanged=observedWrite!==next.host.connection.canWrite;observedWrite=next.host.connection.canWrite;if(writeChanged){if(next.host.connection.canWrite!==true)clearSelection();render();}if(changed){clearSelection();deleteFeedback=null;closeDelete();projectFilter=next.props.projectId??'';closeOriginal();collapsedTasks.clear();generation++;selected=next.props.topic??null;selectedScope=next.props.executionScope;selectedModelScope=next.props.modelSessionScope;selectedJobId=next.props.jobId;query='';rows=[];data=null;listResult=null;projectIds=[];error=null;offset=0;historyOffset=0;signature='';render();}if(!next.presented){clearSelection();closeDelete();closeOriginal();generation++;return;}if(next.host.connection.canWrite!==true)closeDelete();if(!next.host.connection.canRead){clearSelection();closeDelete();closeOriginal();generation++;rows=[];data=null;listResult=null;projectIds=[];signature='';render();return;}refresh();},dispose(){document.removeEventListener('pointerdown',outsideMenu);clearSelection();closeDelete();closeOriginal();disposed=true;generation++;clearInterval(timer);clearInterval(clockTimer);root.remove();}};
}
export function mountProjectPage(container,initial){
 let context=initial;
 const normalize=current=>({...current,props:{...current.props,...currentUiTarget(current)}});
 const panel=mountPanel(container,normalize(context));
 const stop=context.host.subscribe(()=>panel.update(normalize(context)));
 return {update(next){context=next;panel.update(normalize(next));},dispose(){stop();panel.dispose();}};
}
export default {id:'agent-worker',activate(host){
 const panel=host.ui.registerPanel({id:'agent-worker-sessions',label:'Agent Worker 会话',mount:mountPanel});
 const page=host.ui.registerPage({id:'project-tasks',label:'Worker 项目任务',mount:mountProjectPage});
 const navigation=registerWorkerNavigation(params=>host.navigation.openPage({id:'project-tasks',params}));
 return ()=>{navigation();page();panel();};
}};
