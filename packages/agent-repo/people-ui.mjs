// Personnel drafts live independently of catalog refreshes and host notifications.
export function mountPeopleDialog(parent,{invoke,canWrite,safe,onClose,isGroup=()=>false,inline=false,filters=()=>({}),onLoaded}){
 const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const button=(text,action,className)=>{const node=el('button',text,className);node.type='button';node.onclick=action;return node;};
 let disposed=false,epoch=0,page={people:[],total:0,nextOffset:null},offset=0,busy=false,loading=true,editing=null,selected=null,confirmDelete=null;
 const drafts=new Map(),previous=document.activeElement,overlay=el(inline?'div':'dialog',undefined,inline?'ar-people-inline':'ar-people-overlay');
 const dialog=el('section',undefined,'ar-people-dialog');overlay.setAttribute('aria-label','人员资料管理');
 const heading=el('div',undefined,'ar-people-heading'),titleRow=el('div',undefined,'ar-people-title-row'),count=el('span','0 位同事','ar-people-count');titleRow.append(el('h2','人员资料'),count);heading.append(titleRow,el('p','管理飞书联系人与 Gitea 账号映射'));
 const close=button('关闭',()=>dispose(true),'ar-people-close');close.setAttribute('aria-label','关闭人员资料');
 const header=el('header',undefined,'ar-people-header');header.append(heading);if(!inline)header.append(close);
 const search=el('input');search.placeholder='搜索姓名、部门、邮箱或账号';search.setAttribute('aria-label','搜索人员');search.type='search';
 const submit=button('搜索',()=>{offset=0;load();},'ar-people-search-submit'),refresh=button('刷新',()=>load(),'ar-people-secondary');refresh.setAttribute('aria-label','刷新人员');
 const searchBox=el('div',undefined,'ar-people-search');searchBox.append(search,submit);
 let syncInfo=null,syncTimer=null,syncing=false,syncAccount='',syncEpoch=0;
 const syncLabel=inline?'同步所选群成员':'同步本群成员';
 const sync=button(syncLabel,()=>startSync(),'ar-people-primary');sync.setAttribute('aria-label',syncLabel);
 const account=el('select');account.setAttribute('aria-label','同步使用的飞书账号');account.hidden=true;account.onchange=()=>{syncAccount=account.value;syncInfo=null;render();loadSync();};
 const syncStatus=el('p',undefined,'ar-people-sync-status');syncStatus.setAttribute('role','status');
 const toolbar=el('div',undefined,'ar-people-toolbar');toolbar.append(searchBox,refresh);if(isGroup())toolbar.append(account,sync);
 const notice=el('p',undefined,'ar-people-notice');notice.setAttribute('role','status');notice.hidden=true;
 const content=el('div',undefined,'ar-people-content'),roster=el('div',undefined,'ar-people-roster'),list=el('div',undefined,'ar-people-list'),pagination=el('div',undefined,'ar-people-pagination'),detail=el('div',undefined,'ar-people-detail');list.setAttribute('aria-label','人员列表');roster.append(list,pagination);content.append(roster,detail);
 const footer=el('footer',undefined,'ar-people-footer');footer.append(el('span','资料来自飞书，人工更正优先保留。'),el('span','仅用于身份关联，不改变操作权限。'));
 dialog.append(header,toolbar,syncStatus,notice,content,footer);overlay.append(dialog);parent.append(overlay);if(!inline){overlay.showModal();close.focus();}
 search.onkeydown=event=>{if(event.key==='Enter'&&!busy){offset=0;load();}};
 function dispose(notify=false){if(disposed)return;disposed=true;epoch++;clearTimeout(syncTimer);if(!inline)overlay.close();overlay.remove();if(!inline&&previous?.isConnected)previous.focus();if(notify)onClose?.();}
 overlay.oncancel=event=>{event.preventDefault();if(!busy)dispose(true);};
 overlay.onkeydown=event=>{
  if(event.key==='Escape'&&!busy){if(editing){event.preventDefault();editing=null;confirmDelete=null;render();}else if(!inline){event.preventDefault();dispose(true);}}
  if(!inline&&event.key==='Tab'){
   const nodes=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),summary')].filter(node=>!node.closest('details:not([open])')||node.tagName==='SUMMARY');if(!nodes.length)return;
   if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0].focus();}
  }
 };
 function message(text,error=false){notice.textContent=text;notice.hidden=!text;notice.classList.toggle('ar-people-error',error);}
 function syncSummary(run){
  if(!run)return '';
  const details=`已保存 ${run.saved} 人（新增 ${run.created}、更新 ${run.updated}），通讯录资料 ${run.profiled} 人，仅基本身份 ${run.identityOnly} 人。`;
  return run.status==='running'?`正在同步：已处理 ${run.processed} / ${run.discovered} 人…`:run.status==='completed'?'同步完成：'+details:run.status==='partial'?'部分同步完成：'+details+' 可重试同步补全。':run.status==='cancelled'?'同步已中断，已保存的资料会保留。':'同步失败，请核对群访问和通讯录权限后重试。';
 }
 async function loadSync(){
  clearTimeout(syncTimer);if(disposed||!isGroup())return;const request=++syncEpoch;
  try{
   const next=await invoke('peopleSyncInfo',syncAccount?{accountId:syncAccount}:{});if(disposed||request!==syncEpoch)return;
   const wasRunning=syncInfo?.run?.status==='running';syncInfo=next;
   if(!syncAccount&&next.accounts?.length===1)syncAccount=next.accounts[0].accountId;
   account.replaceChildren();if(next.accounts?.length>1){const placeholder=el('option','选择飞书账号');placeholder.value='';account.append(placeholder);for(const a of next.accounts){const option=el('option',a.accountId);option.value=a.accountId;account.append(option);}account.value=syncAccount;}account.hidden=!(next.accounts?.length>1);
   syncStatus.textContent=next.run?syncSummary(next.run):next.available?(next.onJoin?'已启用入群自动同步，需飞书订阅入群事件。':'入群自动同步已关闭，可手动同步。'):(next.reason||'当前群暂不可同步');
   if(next.run?.status==='running')syncTimer=setTimeout(loadSync,1500);
   if(wasRunning&&next.run?.status!=='running')await load();
  }catch(error){if(!disposed&&request===syncEpoch)syncStatus.textContent='无法读取同步状态：'+safe(error.message);}
  if(!disposed)render();
 }
 async function startSync(){
  if(disposed||syncing||busy||!canWrite()||!syncInfo?.available)return;syncing=true;render();
  try{const run=await invoke('syncPeople',syncAccount?{accountId:syncAccount}:{});if(disposed)return;syncInfo={...syncInfo,run};syncStatus.textContent=syncSummary(run);await loadSync();}
  catch(error){if(!disposed)syncStatus.textContent='无法开始同步：'+safe(error.message);}
  finally{syncing=false;if(!disposed)render();}
 }
 async function load(){
  const request=++epoch;loading=true;message('');render();
  try{const next=await invoke('people',{...filters(),query:search.value,offset});if(disposed||request!==epoch)return;page=next;editing=null;confirmDelete=null;drafts.clear();if(!page.people.some(person=>person.id===selected))selected=page.people[0]?.id??null;onLoaded?.(next);}
  catch(error){if(disposed||request!==epoch)return;message(safe(error.message),true);}
  if(!disposed&&request===epoch){loading=false;render();}
 }
 async function mutate(action,payload){
  if(busy||disposed||!canWrite())return;busy=true;message('');render();const request=epoch;
  try{await invoke(action,payload);if(!disposed&&request===epoch){offset=0;await load();}}
  catch(error){if(!disposed&&request===epoch)message(safe(error.message),true);}
  finally{busy=false;if(!disposed)render();}
 }
 const departments=person=>person.departments.map(d=>d.name||d.id).join('、');
 function status(person){const confirmed=person.giteaSource==='admin';return el('span',confirmed?'已确认':person.giteaUsername?'待核验':'未关联','ar-people-badge '+(confirmed?'confirmed':person.giteaUsername?'pending':'unknown'));}
 function empty(title,description){const node=el('div',undefined,'ar-people-empty');node.append(el('span','人员目录','ar-people-eyebrow'),el('h3',title),el('p',description));return node;}
 function field(label,value,helper){const node=el('div',undefined,'ar-people-field');node.append(el('dt',label),el('dd',safe(value||'暂未获取')));if(helper)node.append(el('p',helper));return node;}
 function render(){
  sync.disabled=!canWrite()||busy||syncing||!syncInfo?.available||syncInfo?.run?.status==='running'||(syncInfo.accounts?.length>1&&!syncAccount);sync.textContent=syncing||syncInfo?.run?.status==='running'?'同步中…':syncLabel;account.disabled=syncing||syncInfo?.run?.status==='running';
  count.textContent=page.total+' 位同事';search.disabled=busy;submit.disabled=busy||loading;refresh.disabled=busy||loading;refresh.textContent=loading?'刷新中…':'刷新';
  list.replaceChildren();pagination.replaceChildren();detail.replaceChildren();detail.classList.remove('is-editing');content.classList.toggle('is-empty',!page.people.length);
  if(!page.people.length){roster.hidden=true;detail.append(empty(loading?'正在加载人员资料':search.value?'没有找到相关人员':'还没有人员资料',loading?'请稍候，正在读取本地人员目录。':search.value?'试试姓名、部门、邮箱或 Gitea 账号，也可以清空搜索条件。':'与此 Agent 聊天、在消息中被原生 @，或从飞书同步后，人员资料会自动出现在这里。'));
   if(!loading&&search.value)detail.querySelector('.ar-people-empty').append(button('清空搜索',()=>{search.value='';offset=0;load();},'ar-people-secondary'));return;
  }
  roster.hidden=false;
  const caption=el('div','联系人','ar-people-list-caption');list.append(caption);
  for(const person of page.people){
   const item=button('',()=>{if(busy)return;selected=person.id;editing=null;confirmDelete=null;message('');render();},'ar-people-person');item.disabled=busy;item.classList.toggle('is-selected',selected===person.id);item.setAttribute('aria-label','查看 '+(person.name||'姓名未知'));item.setAttribute('aria-pressed',String(selected===person.id));
   const avatar=el('span',(person.name||'?').slice(-2),'ar-people-avatar'),identity=el('span',undefined,'ar-people-person-text');identity.append(el('strong',safe(person.name||'姓名未知')),el('span',safe(departments(person)||person.email||'部门暂未获取')));item.append(avatar,identity);list.append(item);
  }
  pagination.append(el('span',page.total+' 位人员 · 第 '+(Math.floor(offset/50)+1)+' 页'));
  if(offset>0||page.nextOffset!==null){const nav=el('div'),prev=button('上一页',()=>{offset=Math.max(0,offset-50);load();}),next=button('下一页',()=>{offset=page.nextOffset;load();});prev.disabled=busy||loading||offset===0;next.disabled=busy||loading||page.nextOffset===null;nav.append(prev,next);pagination.append(nav);}
  const person=page.people.find(person=>person.id===selected)??page.people[0],identity=el('div',undefined,'ar-people-identity'),name=el('div'),nameLine=el('div',undefined,'ar-people-name-line');
  nameLine.append(el('h3',safe(person.name||'姓名未知')),status(person));name.append(nameLine,el('p',safe(departments(person)||'部门暂未获取')));identity.append(el('span',(person.name||'?').slice(-2),'ar-people-avatar large'),name);detail.append(identity);
  if(editing===person.id){
   detail.classList.add('is-editing');
   const form=el('form',undefined,'ar-people-form'),inputs={},draft=drafts.get(person.id)??{};drafts.set(person.id,draft);
   const sectionHeading=el('div',undefined,'ar-people-section-heading');sectionHeading.append(el('h4','编辑资料'),el('p','保存后优先使用此处的更正。'));form.append(sectionHeading);
   const fields=el('div',undefined,'ar-people-edit-grid');
   for(const [key,label,value] of [['name','姓名',person.name],['departments','部门（多个用逗号分隔）',person.departments.map(d=>d.name||d.id).join(', ')],['email','邮箱',person.email],['giteaUsername','Gitea 账号',person.giteaUsername]]){
    const field=el('label',undefined,'ar-people-edit-field'),input=el('input');field.append(el('span',label));input.setAttribute('aria-label','编辑'+label);input.value=draft[key]??value??'';input.oninput=()=>{draft[key]=input.value;};input.disabled=busy;if(key==='email')input.type='email';field.append(input);if(key==='giteaUsername')field.append(el('small','填写用户名，无需添加 @。'));fields.append(field);inputs[key]=input;
   }
   form.onsubmit=event=>{event.preventDefault();for(const [key,input] of Object.entries(inputs))draft[key]=input.value;mutate('updatePerson',{id:person.id,revision:person.revision,patch:{name:inputs.name.value,email:inputs.email.value,giteaUsername:inputs.giteaUsername.value||null,departments:inputs.departments.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean).map(name=>person.departments.find(d=>d.name===name)||{id:name,name})}});};
   const actions=el('div',undefined,'ar-people-form-actions'),save=el('button',busy?'正在保存…':'保存更改','ar-people-primary'),cancel=button('取消编辑',()=>{editing=null;render();},'ar-people-secondary');save.type='submit';save.setAttribute('aria-label','保存人员资料');save.disabled=busy;cancel.disabled=busy;actions.append(cancel,save);form.append(fields,actions);detail.append(form);return;
  }
  const facts=el('dl',undefined,'ar-people-facts');facts.append(field('邮箱',person.email),field('Gitea 账号',person.giteaUsername?'@'+person.giteaUsername:null,person.giteaSource==='admin'?'管理员已确认此映射。':person.giteaUsername?'根据邮箱前缀推导，建单前需核验。':'关联后可用于 Issue 记录人与指派人。'));detail.append(facts);
  const technical=el('details',undefined,'ar-people-technical'),summary=el('summary','身份标识与采集信息'),meta=el('dl');
  for(const [label,value] of [['飞书账号 / 应用',person.accountId+' / '+person.appId],['OpenID',person.openId],['最近采集',new Date(person.observedAt).toLocaleString()]])meta.append(field(label,value));technical.append(summary,meta);detail.append(technical);
  if(!canWrite())return;
  const actions=el('div',undefined,'ar-people-detail-actions'),edit=button('编辑资料',()=>{editing=person.id;confirmDelete=null;render();},'ar-people-primary');edit.setAttribute('aria-label','编辑人员');edit.disabled=busy;
  const more=el('details',undefined,'ar-people-more');more.append(el('summary','更多操作'));
  const options=el('div',undefined,'ar-people-options'),restore=button('恢复飞书资料与邮箱推导',()=>mutate('updatePerson',{id:person.id,revision:person.revision,patch:{name:null,email:null,departments:null,giteaUsername:null}})),remove=button('删除人员',()=>{confirmDelete=person.id;render();},'ar-people-danger');restore.disabled=busy;remove.disabled=busy;options.append(restore,remove);more.append(options);actions.append(edit,more);detail.append(actions);
  if(confirmDelete===person.id){const confirm=el('div',undefined,'ar-people-confirm'),copy=el('div');copy.append(el('strong','删除这份本地资料？'),el('p','不会修改飞书通讯录。再次互动时会重新采集。'));const buttons=el('div'),cancel=button('取消删除',()=>{confirmDelete=null;render();}),remove=button('确认删除本地资料',()=>mutate('deletePerson',{id:person.id,revision:person.revision,confirmed:true}),'ar-people-danger');cancel.disabled=busy;remove.disabled=busy;buttons.append(cancel,remove);confirm.append(copy,buttons);detail.append(confirm);}
 }
 load();loadSync();return {dispose:()=>dispose(false),refresh:()=>{offset=0;return load();}};
}
