<script setup lang="ts">
import {ref,computed,onMounted,onBeforeUnmount,watch} from 'vue';
import {Button,useHostContext} from '@openclaw-plugins/control-ui-kit';
import {useManagementRequest} from './management-request';
import {taskTime} from '../../agent-worker/timing.mjs';
import {canOpenWorkerProject,openWorkerTask,subscribeWorkerNavigation} from '../../agent-repo-api/ui-navigation.mjs';
import {workerLabels,type AgentTaskPage,type ManagedTask} from './worker-model';
import WorkerSummary from './WorkerSummary.vue';
const props=defineProps<{agentId:string}>();
const context=useHostContext(),request=useManagementRequest(context,()=>props.agentId,'agent-worker','inspect-');
const root=ref<HTMLElement>(),data=ref<AgentTaskPage|null>(null),error=ref(''),loading=ref(false),projectId=ref(''),status=ref(''),query=ref(''),offset=ref(0),now=ref(Date.now()),canNavigate=ref(canOpenWorkerProject());
const safe=(value:unknown)=>context.value.host.redact(String(value??''));
const projects=computed(()=>[...new Set([...(data.value?.projectIds??[]),projectId.value].filter(Boolean))]);
let generation=0;
async function refresh(background=false){
 if(!context.value.presented||!context.value.host.connection.canRead||context.value.signal.aborted||background&&loading.value)return;
 const token=++generation,valid=request.capture();loading.value=true;error.value='';if(!background)data.value=null;
 try{const result=await request.invoke<AgentTaskPage>('agentTasks',{...(projectId.value?{projectId:projectId.value}:{}),...(status.value?{status:status.value}:{}),query:query.value,offset:offset.value,limit:20});
  if(!valid()||token!==generation)return;if(JSON.stringify(data.value)!==JSON.stringify(result))data.value=result;
 }catch(e){if(!valid()||token!==generation)return;error.value=safe(e instanceof Error?e.message:e);}
 if(valid()&&token===generation)loading.value=false;
}
function filter(){offset.value=0;void refresh();}
function go(delta:number){offset.value=Math.max(0,offset.value+delta);void refresh();}
function open(task:ManagedTask){try{openWorkerTask({agentId:props.agentId,...task});}catch(e){error.value=safe(e instanceof Error?e.message:e);}}
let clock:ReturnType<typeof setInterval>,timer:ReturnType<typeof setInterval>,stop=()=>{};
onMounted(()=>{
 stop=subscribeWorkerNavigation(()=>{canNavigate.value=canOpenWorkerProject();});
 clock=setInterval(()=>{if(context.value.presented&&context.value.host.connection.canRead&&!context.value.signal.aborted)now.value=Date.now();},1000);
 timer=setInterval(()=>{const focused=root.value?.ownerDocument.activeElement;if(!root.value?.contains(focused??null)||!focused?.matches('input,select,textarea'))void refresh(true);},5000);
 void refresh();
});
watch([()=>context.value.presented,()=>context.value.host.connection.canRead,()=>context.value.host.connection.canWrite,()=>props.agentId],()=>{generation++;if(context.value.presented&&context.value.host.connection.canRead)void refresh();else{data.value=null;loading.value=false;}},{flush:'sync'});
onBeforeUnmount(()=>{generation++;clearInterval(clock);clearInterval(timer);stop();});
</script>
<template>
 <section ref="root" class="ar-worker-page" data-ocp-ui aria-label="Agent Worker 任务管理" :aria-busy="loading">
  <header class="ar-overview-heading ar-section-heading"><div><h2>Worker 任务</h2><p class="ar-description">查看此 Agent 跨会话的委派任务；执行与历史由 agent-worker 维护。</p></div><Button variant="outline" :disabled="loading" @click="refresh(false)">刷新任务</Button></header>
  <WorkerSummary :value="data" :error="error" :loading="loading" :safe="safe" />
  <form class="ar-worker-filters" @submit.prevent="filter"><label><span>Worker 项目</span><select v-model="projectId" aria-label="Worker 项目" @change="filter"><option value="">所有项目</option><option v-for="id in projects" :key="id" :value="id">{{safe(id)}}</option></select></label><label><span>Worker 状态</span><select v-model="status" aria-label="Worker 状态" @change="filter"><option value="">全部状态</option><option v-for="(label,key) in workerLabels" :key="key" :value="key">{{label}}</option></select></label><input v-model="query" type="search" placeholder="搜索主题、任务摘要或 ID" aria-label="搜索 Worker 任务"><Button type="submit">搜索</Button></form>
  <template v-if="data">
   <p class="ar-description" role="status">{{safe('匹配 '+data.total+' 个任务 · 统计按项目计算，不随状态和搜索过滤 · 更新于 '+new Date(data.scannedAt).toLocaleString())}}</p>
   <p v-if="!data.tasks.length" class="ar-empty-note">当前筛选下没有可归属的 Worker 任务。</p>
   <template v-else><div class="ar-worker-table-wrap"><table class="ar-worker-table"><caption>Worker 任务列表</caption><thead><tr><th v-for="label in ['任务 / 主题','项目','状态','来源会话','创建时间','用时','操作']" :key="label">{{label}}</th></tr></thead><tbody><tr v-for="task in data.tasks" :key="task.jobId"><td :title="safe(task.jobId)"><strong>{{safe(task.topic)}}</strong><code class="ar-worker-task-id">{{safe(task.jobId.slice(0,8))}}</code><p class="ar-description">{{safe(task.taskSummary??'未保存任务摘要')}}</p><p v-if="task.notificationState==='uncertain'" class="ar-warning">投递待核查 · Main 可能已执行</p><p v-else-if="task.notificationErrorCode" class="ar-warning">{{safe('投递异常：'+task.notificationErrorCode)}}</p></td><td>{{safe(task.projectId??'未绑定项目')}}</td><td>{{workerLabels[task.status]??'状态待核实'}}</td><td :title="safe(task.sessionKey)">{{safe(task.sessionKey.replace('agent:'+agentId+':',''))}}</td><td>{{new Date(task.createdAt).toLocaleString()}}</td><td class="ar-worker-elapsed" title="从任务受理到结束，包含排队、执行及等待；不包含结果交付。">{{taskTime(task,now)}}</td><td><Button variant="outline" size="sm" :disabled="!canNavigate" :title="canNavigate?undefined:'Agent Worker 页面尚未加载，请检查插件 UI 是否启用'" @click="open(task)">查看详情</Button></td></tr></tbody></table></div><nav class="ar-worker-pager" aria-label="Worker 任务分页"><Button variant="outline" :disabled="offset===0" @click="go(-20)">上一页</Button><span>第 {{Math.floor(offset/20)+1}} 页</span><Button variant="outline" :disabled="!data.hasMore" @click="go(20)">下一页</Button></nav></template>
  </template>
 </section>
</template>
