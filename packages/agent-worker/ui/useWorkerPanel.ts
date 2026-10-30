import {computed,ref,shallowRef,reactive,watch,onMounted,onBeforeUnmount,nextTick} from 'vue';
import {useHostContext} from '@openclaw-plugins/control-ui-kit';
import {readInspectionResponse} from '../inspection-transport.mjs';
import {currentUiTarget} from '../../agent-repo-api/ui-navigation.mjs';
import {activeStatuses,sessionKey,type SessionRow,type SessionList,type DetailPage,type TaskRecord,type TaskSummary,type OriginalMessage,type MessageEntry} from './models';
export function useWorkerPanel(projectPage:()=>boolean){
 const context=useHostContext(),root=ref<HTMLElement>(),scroll=ref<HTMLElement>();
 const target=computed<Readonly<Record<string,string|undefined>>>(()=>projectPage()?{...context.value.props,...currentUiTarget(context.value)}:context.value.props);
 const binding=computed(()=>JSON.stringify([target.value.agentId,target.value.sessionKey,target.value.projectId,target.value.topic,target.value.jobId,target.value.executionScope,target.value.modelSessionScope]));
 const writable=computed(()=>context.value.host.connection.canWrite===true);
 const selected=ref<string|null>(target.value.topic??null),selectedScope=ref<string|null|undefined>(target.value.executionScope),selectedModelScope=ref<string|null|undefined>(target.value.modelSessionScope),selectedJobId=ref<string|undefined>(target.value.jobId);
 const view=ref('records'),filter=ref('all'),query=ref(''),project=ref(target.value.projectId??''),sort=ref('heat'),offset=ref(0),historyOffset=ref(0);
 const rows=shallowRef<SessionRow[]>([]),data=shallowRef<DetailPage|null>(null),list=shallowRef<SessionList|null>(null),projectIds=ref<string[]>([]),error=ref(''),loading=ref(false),now=ref(Date.now());
 const menu=ref<string|null>(null),selectionMode=ref(false),checked=reactive(new Map<string,SessionRow>()),collapsed=reactive(new Set<string>()),deleting=ref(false),deleteFeedback=ref<{failed:boolean;text:string}|null>(null);
 const confirmation=ref<{rows:SessionRow[];bulk:boolean;error:string}|null>(null),original=shallowRef<OriginalMessage|null>(null);
 let alive=true,generation=0,deleteRun=0;
 const safe=(value:unknown)=>context.value.host.redact(String(value??''));
 const validScope=(key:string)=>alive&&binding.value===key&&context.value.presented&&context.value.host.connection.canRead&&!context.value.signal.aborted;
 async function invoke<T>(action:string,payload:Record<string,unknown>){
  const key=binding.value,host=context.value.host,owner={...target.value};
  const result=await readInspectionResponse<T>((name,value)=>{context.value.signal.throwIfAborted();if(!validScope(key))throw Error('会话已切换或读取权限失效');return host.request('plugins.sessionAction',{pluginId:'agent-worker',actionId:'inspect-'+name,sessionKey:owner.sessionKey,agentId:owner.agentId,payload:JSON.parse(JSON.stringify(value)) as Record<string,unknown>});},action,payload);
  if(!validScope(key))throw Error('会话已切换或读取权限失效');return result;
 }
 const projects=computed(()=>[...new Set([...projectIds.value,project.value].filter(Boolean))]);
 const eligible=computed(()=>rows.value.filter(row=>row.canDelete===true)),checkedCount=computed(()=>eligible.value.filter(row=>checked.has(sessionKey(row))).length);
 const allChecked=computed(()=>eligible.value.length>0&&checkedCount.value===eligible.value.length),someChecked=computed(()=>checkedCount.value>0&&checkedCount.value<eligible.value.length);
 function clearSelection(){selectionMode.value=false;checked.clear();}
 function focusSelector(selector:string){const key=binding.value;void nextTick(()=>{if(validScope(key))root.value?.querySelector<HTMLElement>(selector)?.focus();});}
 function multiple(){menu.value=null;selectionMode.value=true;focusSelector('[aria-label="全选已加载的可删除会话"]');}
 function toggle(row:SessionRow){if(deleting.value||row.canDelete!==true)return;const key=sessionKey(row);if(checked.has(key))checked.delete(key);else checked.set(key,{...row});const owner=binding.value;void nextTick(()=>{if(validScope(owner))Array.from(root.value!.querySelectorAll<HTMLInputElement>('.cq-session-check')).find(input=>input.dataset.key===key)?.focus();});}
 function pick(row:SessionRow){menu.value=null;selectionMode.value=true;toggle(row);}
 function selectAll(value:boolean){for(const row of eligible.value){if(value)checked.set(sessionKey(row),{...row});else checked.delete(sessionKey(row));}}
 function cancelSelection(){clearSelection();focusSelector('header .cq-more button');}
 function closeDelete(force=false){if(!deleting.value||force){confirmation.value=null;focusSelector('.cq-refresh');}}
 function confirmDelete(chosen:SessionRow[],bulk=false){if(!alive||deleting.value||!writable.value||!chosen.length||chosen.some(row=>row.canDelete!==true))return;menu.value=null;confirmation.value={rows:chosen.map(row=>({...row})),bulk,error:''};}
 async function refresh(append=false,appendHistory=false,page?:{offset?:number;historyOffset?:number;clearJobId?:boolean}){
  if(!alive||deleting.value||confirmation.value||menu.value||context.value.signal.aborted||!context.value.presented||!context.value.host.connection.canRead||!target.value.sessionKey)return;
  const token=++generation,key=binding.value,requestedOffset=page?.offset??offset.value,requestedHistory=page?.historyOffset??historyOffset.value;loading.value=true;
  try{
   if(selected.value){
    const result=JSON.parse(JSON.stringify(await invoke<DetailPage>('detail',{topic:selected.value,executionScope:selectedScope.value,modelSessionScope:selectedModelScope.value,projectId:project.value||undefined,offset:requestedOffset,limit:1,historyOffset:requestedHistory,jobId:page?.clearJobId?undefined:selectedJobId.value}))) as DetailPage;
    if(token!==generation||!validScope(key))return;
    const previous=data.value;offset.value=result.offset??requestedOffset;historyOffset.value=requestedHistory;
    if(result.session){selectedScope.value=result.session.executionScope??null;selectedModelScope.value=result.session.modelSessionScope??null;}
    if(page?.clearJobId)selectedJobId.value=undefined;
    if(append&&previous)result.records=[...result.records,...previous.records];
    if(appendHistory&&previous)result.taskHistory=[...new Map([...(previous.taskHistory??[]),...(result.taskHistory??[])].filter(task=>!(result.currentTasks??[]).some(current=>current.jobId===task.jobId)).map(task=>[task.jobId,task])).values()].sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));
    data.value=result;
   }else{
    const result=JSON.parse(JSON.stringify(await invoke<SessionList>('list',{query:query.value,projectId:project.value||undefined,sort:sort.value,offset:requestedOffset,limit:30}))) as SessionList;
    if(token!==generation||!validScope(key))return;
    offset.value=requestedOffset;data.value=null;rows.value=append?[...new Map([...rows.value,...result.sessions].map(row=>[sessionKey(row),row])).values()]:result.sessions;list.value=result;projectIds.value=result.projectIds??[];
    let invalidated=0;for(const row of rows.value){const previous=checked.get(sessionKey(row));if(previous&&(row.canDelete!==true||row.deletionRevision!==previous.deletionRevision)){checked.delete(sessionKey(row));invalidated++;}}
    if(invalidated)deleteFeedback.value={failed:true,text:(deleteFeedback.value?.failed?deleteFeedback.value.text+'；':'')+`${invalidated} 个会话已变化或不可删除，已取消选择，请核对后重新选择。`};
   }
   error.value='';loading.value=false;
  }catch(e){if(token!==generation||!validScope(key))return;loading.value=false;error.value=safe(e instanceof Error?e.message:e);}
 }
 function choose(row:SessionRow){clearSelection();deleteFeedback.value=null;closeDelete();original.value=null;selected.value=row.topic;selectedScope.value=row.executionScope??null;selectedModelScope.value=row.modelSessionScope??null;selectedJobId.value=undefined;offset.value=0;historyOffset.value=0;data.value=null;view.value='records';generation++;void refresh();}
 function back(){closeDelete();selected.value=null;selectedScope.value=undefined;selectedModelScope.value=undefined;selectedJobId.value=undefined;offset.value=0;historyOffset.value=0;data.value=null;rows.value=[];generation++;void refresh();focusSelector('.cq-refresh');}
 function resetProject(){clearSelection();generation++;offset.value=0;rows.value=[];data.value=null;list.value=null;error.value='';void refresh();}
 function search(){clearSelection();generation++;offset.value=0;rows.value=[];void refresh();}
 function refreshButton(){historyOffset.value=0;if(!selected.value)offset.value=0;void refresh();}
 function more(){if(!loading.value)void refresh(true,false,{offset:offset.value+30});}
 function earlier(){if(!loading.value)void refresh(true,false,{offset:offset.value+1,clearJobId:true});}
 function moreHistory(){if(!loading.value)void refresh(false,true,{historyOffset:historyOffset.value+30});}
 function setView(value:string){view.value=value;scroll.value?.scrollTo(0,0);}
 function setFilter(value:string){filter.value=value;scroll.value?.scrollTo(0,0);}
 function toggleTask(task:TaskSummary){if(data.value?.records.some(r=>r.jobId===task.jobId)){if(collapsed.has(task.jobId))collapsed.delete(task.jobId);else collapsed.add(task.jobId);return;}collapsed.delete(task.jobId);selectedJobId.value=task.jobId;offset.value=task.index;void refresh(false,true);}
 function showOriginal(actor:string,record:TaskRecord,snapshot?:MessageEntry){original.value={actor,record,snapshot};}
 const originalPayload=computed(()=>{const value=original.value;if(!value)return null;return value.snapshot?.raw??value.snapshot??(value.actor.startsWith('Main')?value.record.request:{messages:value.record.events.filter(e=>e.event==='item.completed'&&e.item?.type==='agent_message'),result:value.record.result??null,questions:value.record.questions??[]});});
 const history=computed(()=>{const result=[...(data.value?.taskHistory??[])];for(const record of data.value?.records??[])if(!activeStatuses.has(record.status)&&!result.some(task=>task.jobId===record.jobId))result.unshift({...record,index:data.value?.offset??offset.value,task:record.request.task});return result;});
 async function executeDelete(){
  const pending=confirmation.value;if(!pending||deleting.value||!writable.value)return;
  const key=binding.value,run=++deleteRun;const valid=()=>validScope(key)&&writable.value&&confirmation.value===pending;
  deleting.value=true;generation++;pending.error='';let succeeded=0;const failed:{row:SessionRow;message:string}[]=[];
  try{
   for(const row of pending.rows){
    if(!valid())return;pending.error=pending.bulk?`正在删除 ${succeeded+failed.length+1} / ${pending.rows.length}…`:'';
    try{const result=await invoke<{deleted:boolean}>('deleteSession',{topic:row.topic,executionScope:row.executionScope??null,modelSessionScope:row.modelSessionScope??null,projectId:row.projectId??undefined,revision:row.deletionRevision,confirmed:true});if(result?.deleted!==true)throw Error('未收到删除成功确认，请刷新核对。');succeeded++;if(valid())checked.delete(sessionKey(row));}
    catch(e){if(!valid())return;failed.push({row,message:safe(e instanceof Error?e.message:e)});}
   }
   if(!valid())return;
   if(!pending.bulk&&failed.length){pending.error=failed[0]!.message;return;}
   deleteFeedback.value={failed:failed.length>0,text:failed.length?safe(`已删除 ${succeeded} 个会话，${failed.length} 个未确认删除：`+failed.map(({row,message})=>row.topic+'：'+message).join('；')):`已删除 ${succeeded} 个会话。`};
   confirmation.value=null;original.value=null;collapsed.clear();deleting.value=false;error.value='';if(!failed.length)clearSelection();back();
  }finally{if(run===deleteRun)deleting.value=false;}
 }
 watch(binding,()=>{generation++;deleteRun++;deleting.value=false;menu.value=null;clearSelection();deleteFeedback.value=null;confirmation.value=null;original.value=null;collapsed.clear();project.value=target.value.projectId??'';selected.value=target.value.topic??null;selectedScope.value=target.value.executionScope;selectedModelScope.value=target.value.modelSessionScope;selectedJobId.value=target.value.jobId;query.value='';rows.value=[];data.value=null;list.value=null;projectIds.value=[];error.value='';loading.value=false;offset.value=0;historyOffset.value=0;void refresh();},{flush:'sync'});
 watch([()=>context.value.presented,()=>context.value.host.connection.canRead,()=>context.value.host.connection.canWrite],()=>{generation++;deleteRun++;deleting.value=false;menu.value=null;clearSelection();confirmation.value=null;original.value=null;loading.value=false;if(!context.value.host.connection.canRead){rows.value=[];data.value=null;list.value=null;}if(context.value.presented&&context.value.host.connection.canRead)void refresh();},{flush:'sync'});
 let clock:ReturnType<typeof setInterval>,timer:ReturnType<typeof setInterval>;
 onMounted(()=>{clock=setInterval(()=>{if(alive&&context.value.presented&&context.value.host.connection.canRead)now.value=Date.now();},1000);timer=setInterval(()=>{if(loading.value)return;const active=root.value?.ownerDocument.activeElement;if((offset.value===0||selectedJobId.value)&&historyOffset.value===0&&!(root.value?.contains(active??null)&&active?.matches('input,select,textarea')))void refresh();},5000);void refresh();});
 onBeforeUnmount(()=>{alive=false;generation++;deleteRun++;clearInterval(clock);clearInterval(timer);});
 return {context,target,root,scroll,writable,selected,view,filter,query,project,sort,rows,data,list,projects,error,loading,now,menu,selectionMode,checked,collapsed,deleting,deleteFeedback,confirmation,original,originalPayload,history,eligible,allChecked,someChecked,safe,multiple,pick,toggle,selectAll,cancelSelection,confirmDelete,closeDelete,executeDelete,refresh,choose,back,resetProject,search,refreshButton,more,earlier,moreHistory,setView,setFilter,toggleTask,showOriginal};
}
