import {validateModelSettings} from './model-settings.mjs';
const configPath='plugins.entries.agent-worker.config.models';
const efforts=['minimal','low','medium','high','xhigh','max'],speeds=['default','fast'];
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function btn(text,run){const node=el('button',text);node.type='button';node.onclick=run;return node;}
const copy=value=>JSON.parse(JSON.stringify(value));
export function mountModelSettings(container,initial){
 let context=initial,disposed=false,epoch=0,loading=false,saving=false,loaded=false,dirty=false,hash='',models=[],defaultModelId='',legacy=null,message='',error='',confirmation=false;
 const root=el('section',undefined,'cq-panel cq-model-settings');root.setAttribute('aria-label','Worker 模型配置');container.append(root);
 const safe=value=>context.host.redact(String(value??'')),canRead=()=>context.host.connection.canRead===true,canWrite=()=>context.host.connection.canAdmin===true,live=()=>!disposed&&!context.signal.aborted;
 function changed(){dirty=true;confirmation=false;message='';error='';root.querySelector('.cq-model-confirm')?.remove();root.querySelector('[role=alert]')?.remove();const submit=root.querySelector('.cq-model-submit');if(submit)submit.disabled=!canWrite()||saving;const reload=root.querySelector('.cq-model-reload');if(reload)reload.textContent='放弃草稿并重新读取';const status=root.querySelector('.cq-model-dirty');if(status)status.textContent='有未保存更改';}
 async function load(){
  if(!live()||!context.presented||!canRead()||saving)return;
  const request=++epoch;loading=true;error='';render();
  try{const result=await context.host.request('config.get',{});if(!live()||request!==epoch||!canRead())return;
   if(result?.valid===false||typeof result?.hash!=='string'||!result.hash||!result.config)throw Error('无法读取有效配置版本，请核对宿主权限及配置状态。');
   const worker=result.config.plugins?.entries?.['agent-worker']?.config??{};
   const next={models:worker.models??[],defaultModelId:worker.defaultModelId??''};validateModelSettings(next);
   models=copy(next.models);defaultModelId=next.defaultModelId;hash=result.hash;legacy={model:worker.model??'gpt-6.1-sol',reasoningEffort:worker.reasoningEffort??'low'};loaded=true;dirty=false;confirmation=false;message='';
  }catch(e){if(live()&&request===epoch)error=safe(e.message);}finally{if(live()&&request===epoch){loading=false;render();}}
 }
 async function save(){
  if(!live()||!canWrite()||!canRead()||!loaded||saving||!dirty||!confirmation)return;
  try{validateModelSettings({models,defaultModelId});}catch(e){error=validationMessage(e);confirmation=false;render();return;}
  const submitted=copy({models,defaultModelId}),request=++epoch,current=context;saving=true;error='';confirmation=false;render();
  try{
   const result=await current.host.request('config.patch',{baseHash:hash,raw:JSON.stringify({plugins:{entries:{'agent-worker':{config:submitted}}}}),replacePaths:[configPath]});
   if(!live()||request!==epoch)return;
   if(result?.ok!==true)throw Error('保存结果未确认，请重新读取配置核对后再操作。');
   // A write receipt is not evidence that a restart or model execution succeeded.
   dirty=false;loaded=false;message='配置已保存。宿主将应用配置，可能重启 Gateway；重新读取可核对当前版本。';
  }catch(e){if(live()&&request===epoch){error=safe(e.message)+'（保留草稿；若宿主提示已持久化或重启中，请先重新读取核对，勿重复保存。）';}}
  finally{if(live()&&request===epoch){saving=false;render();}}
 }
 function validationMessage(e){return e.message.includes('duplicate')?'模型 ID 及 harness + 模型名称不能重复。':e.message.includes('defaultModelId')?'请选择仍在列表中的默认模型。':'请填写有效的模型 ID、模型名称及参数；最多 50 个模型。';}
 function field(parent,label,value,change,{options,placeholder,multiline=false}={}){
  const wrapper=el('label',undefined,'cq-model-field');wrapper.append(el('span',label));const input=el(options?'select':multiline?'textarea':'input');input.setAttribute('aria-label',label);input.disabled=!canWrite()||saving;
  if(options)for(const [value,text] of options){const option=el('option',text);option.value=value;input.append(option);}else if(placeholder)input.placeholder=placeholder;
  input.value=value??'';input.addEventListener('change',()=>{if(!canWrite()||saving)return;change(input.value);changed();});wrapper.append(input);parent.append(wrapper);return input;
 }
 function render(){
  root.replaceChildren();const header=el('header');header.append(el('h2','Worker 模型配置'));const refresh=btn(dirty?'放弃草稿并重新读取':'重新读取',()=>{if(dirty){confirmation='discard';render();}else load();});refresh.className='cq-model-reload';refresh.disabled=loading||saving;header.append(refresh);root.append(header);root.append(el('p',dirty?'有未保存更改':'','cq-muted cq-model-dirty'));
  root.append(el('p','配置适用于当前实例的 Agent Worker。更改在点击保存并确认后生效，已受理任务保留原模型与参数。','cq-muted'));
  if(!canRead()){root.append(el('p','需要 operator.read 权限才能读取模型配置。'));return;}
  if(error){const note=el('p',error,'cq-error');note.setAttribute('role','alert');root.append(note);}if(message){const note=el('p',message);note.setAttribute('role','status');root.append(note);}
  if(loading){root.append(el('p','正在读取配置…'));return;}
  if(!loaded){if(!message&&!error)root.append(el('p','尚未读取配置。'));return;}
  if(!canWrite())root.append(el('p','当前为只读，需要 operator.admin 权限才能保存。','cq-muted'));
  if(!models.length)root.append(el('p',safe(`未配置模型列表，当前沿用兼容模型 ${legacy?.model}，默认推理强度 ${legacy?.reasoningEffort}。添加第一项后，默认使用列表首项或选定模型。`),'cq-muted'));
  const defaultOptions=()=>[['','自动（列表首项）'],...(!models.length&&defaultModelId==='default'?[['default','兼容默认模型']]:[]),...models.map(m=>[m.id,m.name?m.name+'（'+m.id+'）':m.id||'未填写 ID'])];
  const defaults=field(root,'默认模型',defaultModelId,value=>{defaultModelId=value;},{options:defaultOptions()});
  const refreshDefaults=()=>{defaults.replaceChildren();for(const [value,text]of defaultOptions()){const option=el('option',text);option.value=value;defaults.append(option);}defaults.value=defaultModelId;};
  const cards=el('div',undefined,'cq-model-cards');root.append(cards);
  for(const [index,model]of models.entries()){
   const card=el('article',undefined,'cq-model-card'),heading=el('header');heading.append(el('strong',safe(model.name||model.id||'新模型')));const remove=btn('删除模型',()=>{confirmation={remove:index};render();});remove.disabled=!canWrite()||saving;heading.append(remove);card.append(heading);
   const fields=el('div',undefined,'cq-model-fields');
   const set=key=>value=>{if(value==='')delete model[key];else model[key]=value;};
   field(fields,`模型 ${index+1} ID`,model.id,value=>{const previous=model.id;model.id=value;if(defaultModelId&&defaultModelId===previous)defaultModelId=value;refreshDefaults();},{placeholder:'例如 quick 或 deep'});
   field(fields,`模型 ${index+1} 名称`,model.name,value=>{set('name')(value);refreshDefaults();});
   field(fields,`模型 ${index+1} harness`,model.harness,value=>{model.harness=value;},{options:[['codex','Codex']]}).disabled=true;
   field(fields,`模型 ${index+1} 模型标识`,model.model,value=>{model.model=value;},{placeholder:'填写当前 CLI 可用的模型名'});
   field(fields,`模型 ${index+1} 用途描述`,model.description,set('description'),{multiline:true});
   field(fields,`模型 ${index+1} CLI 路径`,model.cli,set('cli'),{placeholder:'留空继承全局 Codex 命令'});
   field(fields,`模型 ${index+1} 默认推理强度`,model.reasoningEffort,set('reasoningEffort'),{options:[['','继承全局配置'],...efforts.map(v=>[v,v])]});
   field(fields,`模型 ${index+1} 默认速度`,model.speed,set('speed'),{options:[['','继承 CLI 默认值'],...speeds.map(v=>[v,v])]});card.append(fields);
   const profiles=el('details',undefined,'cq-model-profiles');profiles.append(el('summary','智慧等级 0–6 参数覆盖'));
   for(let level=0;level<=6;level++){
    const row=el('div',undefined,'cq-model-level');row.append(el('strong','等级 '+level));
    for(const [key,label,values]of [['reasoningEffort','推理强度',efforts],['speed','速度',speeds]])field(row,`模型 ${index+1} 等级 ${level} ${label}`,model.thinkingProfiles?.[level]?.[key],value=>{
     if(value){model.thinkingProfiles??={};model.thinkingProfiles[level]??={};model.thinkingProfiles[level][key]=value;}
     else if(model.thinkingProfiles?.[level]){delete model.thinkingProfiles[level][key];if(!Object.keys(model.thinkingProfiles[level]).length)delete model.thinkingProfiles[level];if(!Object.keys(model.thinkingProfiles).length)delete model.thinkingProfiles;}
    },{options:[['','使用等级默认值'],...values.map(v=>[v,v])]});profiles.append(row);
   }card.append(profiles);cards.append(card);
  }
  const actions=el('div',undefined,'cq-model-actions');const add=btn('新增模型',()=>{if(models.length>=50||!canWrite()||saving)return;if(!models.length)defaultModelId='';models.push({id:'',harness:'codex',model:''});changed();render();const inputs=root.querySelectorAll('input');[...inputs].find(input=>input.getAttribute('aria-label')===`模型 ${models.length} ID`)?.focus();});add.disabled=!canWrite()||saving||models.length>=50;
  const submit=btn(saving?'正在保存…':'保存模型配置',()=>{if(!canWrite()||saving)return;try{validateModelSettings({models,defaultModelId});confirmation='save';error='';}catch(e){error=validationMessage(e);}render();});submit.className='cq-model-submit';submit.disabled=!canWrite()||saving||!dirty;
  actions.append(add,submit);root.append(actions);
  if(confirmation){const box=el('section',undefined,'cq-model-confirm');box.setAttribute('role','group');box.setAttribute('aria-label','确认模型配置操作');
   const removal=typeof confirmation==='object'?confirmation.remove:undefined;
   box.append(el('p',removal!==undefined?'从草稿中移除此模型？已受理任务继续使用原配置。':confirmation==='discard'?'放弃当前未保存的草稿并重新读取？':'保存模型列表及默认模型？宿主将应用配置，可能重启 Gateway。在途任务保留原配置。'));
   const cancel=btn('取消',()=>{confirmation=false;render();});box.append(cancel);
   box.append(btn(removal!==undefined?'确认移除':confirmation==='discard'?'确认重新读取':'确认保存',()=>{
    if(saving||(confirmation!=='discard'&&!canWrite())){confirmation=false;render();return;}
    if(removal!==undefined){const [removed]=models.splice(removal,1);if(defaultModelId===removed.id)defaultModelId='';changed();render();}
    else if(confirmation==='discard'){confirmation=false;load();}else save();
   }));root.append(box);cancel.focus();
  }
 }
 let previousRead=canRead(),previousWrite=canWrite(),wasPresented=context.presented;
 function permissionsChanged(){
  const changed=previousRead!==canRead()||previousWrite!==canWrite();previousRead=canRead();previousWrite=canWrite();
  if(!canRead()){epoch++;loading=false;saving=false;loaded=false;dirty=false;models=[];hash='';error='';message='';confirmation=false;}
  if(!canWrite()&&confirmation!=='discard')confirmation=false;
  if(changed)render();return changed;
 }
 const stop=context.host.subscribe?.(()=>{if(live())permissionsChanged();})??(()=>{});
 render();load();
 return {update(next){context=next;permissionsChanged();const resumed=next.presented&&!wasPresented;wasPresented=next.presented;if(!next.presented&&!saving){epoch++;loading=false;}if(next.presented&&!loaded&&!saving&&!loading)load();else if(resumed)render();},dispose(){disposed=true;epoch++;stop();root.remove();}};
}
