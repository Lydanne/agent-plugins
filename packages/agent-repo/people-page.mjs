import {mountPeopleDialog} from './people-ui.mjs';
import {readInspectionResponse} from './dist/inspection-transport.mjs';
import {currentUiTarget} from './dist/ui-navigation.mjs';

const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
export function mountPeoplePage(container,initial){
 let context=initial,disposed=false,manager=null,agentId='',groupKey='',generation=0;
 let observedRead,observedWrite,observedPresented;
 const root=el('section',undefined,'ar-people-page');root.setAttribute('aria-label','Agent 人员库管理');container.append(root);
 const safe=value=>context.host.redact(String(value??''));
 // A management page follows Agent selection, never the currently open conversation.
 const selectedAgent=()=>currentUiTarget({...context,props:{agentId:context.props.agentId}}).agentId;
 function render(){
  manager?.dispose();manager=null;generation++;root.replaceChildren();
  const header=el('header',undefined,'ar-people-page-header'),copy=el('div');copy.append(el(context.props.embeddedManagement?'h2':'h1','飞书人员管理'),el('p','统一管理此 Agent 在全部会话中认识的人员，飞书同步和聊天采集使用同一份资料。'));
  const selector=el('select');selector.setAttribute('aria-label','人员库所属 Agent');
  const agents=context.host.agents.rows??[];
  for(const agent of agents){const option=el('option',safe(agent.name??agent.id));option.value=agent.id;selector.append(option);}
  if(agentId&&!agents.some(agent=>agent.id===agentId)){const option=el('option',safe(agentId));option.value=agentId;selector.append(option);}
  selector.value=agentId;selector.onchange=()=>{const id=selector.value;context.host.agents.select(id);if(context.props.agentId)context.host.navigation.openPage({id:'people',params:{agentId:id}});};header.append(copy);if(!context.props.embeddedManagement)header.append(selector);root.append(header);
  if(!context.presented)return;
  if(!context.host.connection.canRead){root.append(el('p','需要 operator.read 权限才能查看人员库。','ar-error'));return;}
  if(!agentId){root.append(el('p','请先选择一个 Agent。'));return;}
  root.append(el('p',safe('当前 Agent：'+agentId+' · 跨会话统一管理 · 与其他 Agent 隔离'),'ar-people-page-scope'));
  const stats=el('div',undefined,'ar-people-stats');stats.setAttribute('aria-label','人员库统计');root.append(stats);
  const controls=el('div',undefined,'ar-people-page-controls');
  const filter=(label,options)=>{const wrap=el('label'),select=el('select');wrap.append(el('span',label),select);select.setAttribute('aria-label',label);for(const [value,text] of options){const option=el('option',text);option.value=value;select.append(option);}controls.append(wrap);return select;};
  const mapping=filter('账号关联状态',[['','全部关联状态'],['admin','人工确认'],['email_prefix','邮箱推导待核验'],['unknown','未关联']]);
  const missing=filter('资料完整度',[['','全部资料'],['name','缺少姓名'],['email','缺少邮箱'],['departments','缺少部门'],['giteaUsername','缺少 Gitea 账号']]);
  const groups=(context.host.sessions.rows??[]).filter(row=>typeof row.key==='string'&&row.key.startsWith('agent:'+agentId+':feishu:group:oc_'));
  const group=filter('飞书同步来源',[['','选择已有群聊以同步成员'],...groups.map(row=>[row.key,safe(row.label??row.displayName??row.key.split(':feishu:group:')[1])])]);
  if(!groups.some(row=>row.key===groupKey))groupKey='';group.value=groupKey;
  group.onchange=()=>{groupKey=group.value;mountManager();};
  root.append(controls,el('p','聊天自动采集真实发送者和原生提及人；批量同步请先选择已有飞书群聊。人工更正始终优先保留。','ar-people-page-help'));
  const body=el('div',undefined,'ar-people-page-body');root.append(body);
  function mountManager(){
   manager?.dispose();body.replaceChildren();stats.replaceChildren();const epoch=++generation,owner=agentId,source=groupKey;
   const current=()=>!disposed&&context.presented&&epoch===generation&&agentId===owner&&context.host.connection.canRead===true;
   const invoke=async(action,payload)=>{
    if(!current())throw Error('当前人员库已切换或不可访问');
    const sessionKey=['peopleSyncInfo','syncPeople'].includes(action)?source:'agent:'+owner+':agent-repo-people';
    const result=await readInspectionResponse(async(name,data)=>{
     context.signal.throwIfAborted();if(!current())throw Error('当前人员库已切换');
     return context.host.request('plugins.sessionAction',{pluginId:'agent-repo',actionId:'projects-'+name,agentId:owner,sessionKey,payload:data});
    },action,payload);
    if(!current())throw Error('当前人员库已切换');return result;
   };
   manager=mountPeopleDialog(body,{inline:true,invoke,safe,canWrite:()=>current()&&context.host.connection.canWrite===true,isGroup:()=>!!source,
    filters:()=>({... (mapping.value?{giteaSource:mapping.value}:{}),... (missing.value?{missing:missing.value}:{})}),
    onLoaded:page=>{if(!current())return;stats.replaceChildren();const s=page.stats;
     for(const [label,value] of [['匹配人员',page.total],['已确认关联',s?.giteaSources?.admin??0],['待核验关联',s?.giteaSources?.email_prefix??0],['缺少邮箱',s?.missing?.email??0]]){const card=el('div');card.append(el('strong',String(value)),el('span',label));stats.append(card);}
    },
   });
  }
  mapping.onchange=()=>manager?.refresh();missing.onchange=()=>manager?.refresh();mountManager();
 }
 function update(next){
  if(disposed)return;context=next;const selected=selectedAgent(),read=context.host.connection.canRead,write=context.host.connection.canWrite,presented=context.presented;
  if(selected!==agentId||read!==observedRead||write!==observedWrite||presented!==observedPresented){agentId=selected;groupKey='';observedRead=read;observedWrite=write;observedPresented=presented;render();}
 }
 const stop=context.host.subscribe(()=>update(context));update(initial);
 return {update,dispose(){if(disposed)return;disposed=true;generation++;manager?.dispose();stop();root.remove();}};
}
