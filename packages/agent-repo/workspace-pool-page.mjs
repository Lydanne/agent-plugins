import {mountAudit} from './audit-page.mjs';
const labels={idle:'空闲',preparing:'初始化中',ready:'待执行',running:'执行中',held:'等待补充',checking:'检查释放条件',blocked:'异常保留'};
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
export function mountWorkspacePool(container,{projectId,invoke,canWrite,safe=String}){
 const launcher=el('span');launcher.className='ar-workspace-pool';container.append(launcher);
 const trigger=el('button','工作区配置');trigger.type='button';trigger.setAttribute('aria-haspopup','dialog');launcher.append(trigger);
 let auditView=null,auditButton=null,saving=false;
 let disposed=false,version=0,data=null,busy=false,message='',dialog=null,root=null;
 function close(restore=true){auditView?.dispose();auditView=null;
  saving=false;auditButton=null;const previous=dialog;dialog=null;root=null;version++;busy=false;
  if(previous){if(previous.open)previous.close();previous.remove();}
  if(restore&&!disposed)trigger.focus({preventScroll:true});
 }
 trigger.onclick=()=>{
  if(disposed||dialog)return;
  dialog=el('dialog');dialog.className='ar-sync-dialog ar-workspace-dialog';dialog.setAttribute('aria-label','代码工作区池');
  const header=el('div');header.className='ar-sync-dialog-header';header.append(el('h2','代码工作区池'));
  const dismiss=el('button','关闭');dismiss.type='button';dismiss.onclick=()=>close();header.append(dismiss);const audit=el('button','修改日志');audit.type='button';auditButton=audit;audit.onclick=()=>{if(saving)return;version++;busy=false;auditView?.dispose();root.replaceChildren();auditView=mountAudit(root,{invoke,safe,feature:'workspace',targetId:projectId,onClose:load});};header.append(audit);
  root=el('div');root.className='ar-sync-dialog-body ar-workspace-content';dialog.append(header,root);launcher.append(dialog);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const current=dialog;dialog.addEventListener('close',()=>{if(dialog===current)close();});
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();});
  data=null;message='';dialog.showModal();dismiss.focus();load();
 };
 async function load(){auditView?.dispose();auditView=null;const token=++version;busy=true;render();try{const next=await invoke('workspacePool',{projectId});if(disposed||token!==version)return;if(!next?.config||!Array.isArray(next.slots))throw Error('当前宿主暂不支持工作区管理');data=next;message='';}catch(e){if(disposed||token!==version)return;message=e.message;}busy=false;render();}
 function render(){
  if(disposed||!root)return;if(auditButton)auditButton.disabled=saving;root.replaceChildren(el('p','projects 用于常规只读任务；workspace 用于已授权的代码修改与 PR。池满时原任务等待释放。'));
  const refresh=el('button','刷新工作区');refresh.type='button';refresh.disabled=busy;refresh.onclick=load;root.append(refresh);
  if(message){const note=el('p',safe(message));note.setAttribute('role','status');root.append(note);}if(!data){if(busy)root.append(el('p','正在读取…'));return;}
  root.append(el('p','保存会修改 projects.json；请在维护窗口调整，随后按仓库流程提交同步。不会自动 commit、push 或重启。'));
  const form=el('form'),enabled=el('input'),capacity=el('input');enabled.type='checkbox';enabled.checked=data.config.enabled;capacity.type='number';capacity.min='1';capacity.max='20';capacity.step='1';capacity.required=true;capacity.value=String(data.config.maxSize);
  const on=el('label','启用独立工作区 '),size=el('label','最大工作区数量 ');on.append(enabled);size.append(capacity);form.append(on,size);
  const save=el('button','保存池配置');save.type='submit';const writable=canWrite();enabled.disabled=capacity.disabled=save.disabled=busy||!writable;form.append(save);root.append(form);
  root.append(el('p',`已分配 ${data.slots.length} 个，占用或保留 ${data.occupied} 个。缩容或停用不会中断已分配任务，也不会删除目录。`));
  if(!writable)root.append(el('p','当前连接仅有读取权限。'));
  if(data.pendingCommit)root.append(el('p','projects.json 有待提交的变化；提交同步前，新任务准备与自动同步可能暂停，已分配任务不强制停止。'));
  form.onsubmit=async event=>{event.preventDefault();if(busy||!canWrite())return;const maxSize=Number(capacity.value);if(!Number.isInteger(maxSize)||maxSize<1||maxSize>20){message='容量必须为 1–20 的整数';render();return;}const input={projectId,revision:data.revision,enabled:enabled.checked,maxSize},token=++version;saving=true;busy=true;render();try{const next=await invoke('workspacePoolSave',input);if(disposed||token!==version)return;data=next;message='池配置已保存。';}catch(e){if(disposed||token!==version)return;message=e.message;}saving=false;busy=false;render();};
  if(!data.slots.length)root.append(el('p','尚未创建工作区；首次代码任务到来时按需创建。'));
  for(const slot of data.slots){const row=el('details'),heading=el('summary',safe(`${slot.id} · ${labels[slot.status]??slot.status}`));row.append(heading);for(const [key,value] of [['目录',slot.path],['任务',slot.owner],['分支',slot.branch],['目标仓库',slot.target],['保留原因',slot.error]])if(value)row.append(el('p',safe(key+'：'+value)));for(const d of slot.dependencies??[])row.append(el('p',safe('依赖 '+d.repository+' · '+(d.installedAt?new Date(d.installedAt).toLocaleString():'未记录'))));if(slot.status==='blocked')row.append(el('p','请先人工核验未提交代码、远端提交与进程状态；此处不执行强制释放或清理。'));root.append(row);}
 }
 return {dispose(){disposed=true;close(false);launcher.remove();}};
}
