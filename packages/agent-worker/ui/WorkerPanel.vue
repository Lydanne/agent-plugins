<script setup lang="ts">
import {computed,ref} from 'vue';
import {Button,Dialog,Tabs,Input,NativeSelect,AdvancedFilters,HelpTip} from '@openclaw-plugins/control-ui-kit';
import {useWorkerPanel} from './useWorkerPanel';
import {statusLabels,time,sessionName,type SessionRow} from './models';
import WorkerMenu from './WorkerMenu.vue';
import SessionList from './SessionList.vue';
import SessionInformation from './SessionInformation.vue';
import TaskCards from './TaskCards.vue';
import ConversationRecord from './ConversationRecord.vue';
import SourceView from './SourceView.vue';
const props=defineProps<{projectPage?:boolean}>();
const {context,target,root,scroll,writable,selected,view,filter,query,project,sort,rows,data,list,projects,error,loading,now,menu,selectionMode,checked,collapsed,deleting,deleteFeedback,confirmation,original,originalPayload,history,eligible,allChecked,someChecked,safe,multiple,pick,toggle,selectAll,cancelSelection,confirmDelete,closeDelete,executeDelete,refresh,choose,back,resetProject,search,refreshButton,more,earlier,moreHistory,setView,setFilter,toggleTask,showOriginal}=useWorkerPanel(()=>props.projectPage===true);
const draftSort=ref('heat');
function applyOptions(){sort.value=draftSort.value;search();}
const current=computed(()=>data.value?.session??data.value?.records.at(-1));
const summary=computed(()=>list.value?`当前聊天 · 运行 ${list.value.counts.running??0} 个任务 · 排队 ${list.value.counts.queued??0} 个任务${list.value.counts.awaitingMain?' · 等待 Main '+list.value.counts.awaitingMain+' 个任务':''}${list.value.counts.awaitingUser?' · 等待用户 '+list.value.counts.awaitingUser+' 个任务':''}`:loading.value?'当前聊天 · 正在读取任务统计…':'当前聊天 · 任务统计尚未读取');
const deleteTaskCount=computed(()=>confirmation.value?.rows.reduce((count,row)=>count+(row.taskCount??0),0)??0);
const tabs=[{id:'records',label:'对话记录'},{id:'process',label:'任务过程'},{id:'info',label:'任务信息'},{id:'session',label:'会话信息'}];
function remove(row:SessionRow){confirmDelete([row]);}
</script>
<template>
 <section ref="root" v-show="context.presented" class="cq-panel" :class="{'cq-detail':selected}" aria-label="Agent Worker 会话" :aria-busy="loading">
  <header><Button v-if="selected" variant="ghost" class="cq-back" @click="back">← 会话列表</Button><strong v-else>Agent Worker 会话</strong><div class="cq-header-actions"><Button variant="ghost" class="cq-refresh" @click="refreshButton">刷新</Button><WorkerMenu v-if="!selected&&!selectionMode&&writable" :open="menu==='list'" :redact="safe" @update:open="menu=$event?'list':null" @multiple="multiple"/></div></header>
  <p v-if="!context.host.connection.canRead">需要 operator.read 权限才能查看。</p><p v-else-if="!target.sessionKey">请选择当前 Agent 的会话后查看项目任务。</p>
  <template v-else>
   <div v-if="deleteFeedback" class="cq-bulk-feedback" :class="{'cq-error':deleteFeedback.failed}" :role="deleteFeedback.failed?'alert':'status'"><span>{{deleteFeedback.text}}</span><Button variant="ghost" @click="deleteFeedback=null">关闭提示</Button></div>
   <template v-if="error"><p class="cq-error" role="alert">{{error}}</p><Button variant="outline" @click="refresh()">重试</Button></template>
   <template v-if="selected"><div class="cq-detail-title"><h2 :title="safe(selected)">{{safe(selected)}}</h2><span v-if="current" class="cq-state" :class="current.status">{{statusLabels[current.status]??current.status}}</span><WorkerMenu v-if="data?.session&&writable" :row="data.session" :selected="true" :open="menu==='detail'" :deleting="deleting" :redact="safe" @update:open="menu=$event?'detail':null" @remove="remove"/></div></template>
   <template v-else><div class="cq-list-tools"><NativeSelect :model-value="project" aria-label="Worker 项目筛选" @update:model-value="value=>{project=String(value);resetProject()}"><option value="">所有项目</option><option v-for="id in projects" :key="id" :value="id">{{safe(id)}}</option></NativeSelect><HelpTip title="会话热度说明"><p>{{list?.heatPolicy??'有效交互随时间衰减；查询不增加热度。'}}</p></HelpTip></div><div class="cq-search-row"><Input v-model="query" type="search" placeholder="搜索会话或标签" aria-label="搜索会话或标签" @change="search" @keydown.enter="search"/><AdvancedFilters title="会话筛选" :count="sort==='recent'?1:0" @open="draftSort=sort" @apply="applyOptions" @reset="draftSort='heat'"><label>会话排序<NativeSelect v-model="draftSort" aria-label="会话排序"><option value="heat">热度优先</option><option value="recent">最近活动</option></NativeSelect></label></AdvancedFilters></div><div class="cq-muted cq-list-summary">{{summary}}</div></template>
   <div v-if="!selected&&selectionMode&&writable" class="cq-selection-bar"><label><input type="checkbox" aria-label="全选已加载的可删除会话" :checked="allChecked" :indeterminate="someChecked" :disabled="deleting||!eligible.length" @change="selectAll(($event.target as HTMLInputElement).checked)"><span>全选已加载</span></label><span role="status">已选 {{checked.size}} 个会话</span><Button v-if="checked.size" variant="ghost" class="cq-delete" :disabled="deleting" @click="confirmDelete([...checked.values()],true)">删除所选 ({{checked.size}})</Button><Button variant="ghost" :disabled="deleting" @click="cancelSelection">取消多选</Button></div>
   <div v-if="!selected" ref="scroll" class="cq-scroll"><p v-if="loading&&!rows.length" class="cq-muted">正在读取…</p><SessionList :rows="rows" :list="list" :loading="loading" :error="error" :selection-mode="selectionMode" :checked="checked" :deleting="deleting" :writable="writable" :menu="menu" :redact="safe" :now="now" @choose="choose" @toggle="toggle" @remove="remove" @pick="pick" @menu="menu=$event" @more="more"/></div>
   <Tabs v-else :model-value="view" :items="tabs" label="Worker 会话详情" list-class="cq-detail-tabs" @update:model-value="setView"><div ref="scroll" class="cq-scroll"><p v-if="loading&&!data" class="cq-muted">正在读取…</p><template v-if="data"><nav v-if="view==='records'" class="cq-record-filters"><Button v-for="id in ['all','Main','Worker']" :key="id" variant="ghost" :class="{'cq-selected':filter===id}" @click="setFilter(id)">{{id==='all'?'全部':id}}</Button></nav><SessionInformation v-if="view==='session'" :session="data.session" :agent-id="target.agentId" :redact="safe"/>
     <template v-if="view==='info'"><TaskCards :title="'当前任务 · '+(data.currentTasks?.length??0)" :tasks="data.currentTasks??[]" empty="当前没有进行中的任务。" :records="data.records" :collapsed="collapsed" :now="now" :redact="safe" @toggle="toggleTask" @navigate="setView" @original="showOriginal('Main',$event)"/><TaskCards :title="'历史任务 · '+(data.historyTotal??0)" :tasks="history" empty="还没有历史任务。" :records="data.records" :collapsed="collapsed" :now="now" :redact="safe" @toggle="toggleTask" @navigate="setView" @original="showOriginal('Main',$event)"/><Button v-if="data.historyHasMore" variant="outline" class="cq-load-earlier" :disabled="loading" @click="moreHistory">加载更多历史任务</Button></template>
     <template v-if="!['session','info'].includes(view)"><ConversationRecord v-for="record in data.records" :key="record.jobId" :record="record" :view="view" :filter="filter" :redact="safe" :now="now" @original="showOriginal"/><Button v-if="data.hasMore" variant="outline" class="cq-load-earlier" :disabled="loading" @click="earlier">加载更早任务</Button></template><p v-if="view!=='session'&&!data.records.length">暂无任务记录</p>
    </template></div></Tabs>
  </template>
 </section>
 <Dialog :open="!!confirmation" :title="confirmation?.bulk?'删除所选的 '+confirmation.rows.length+' 个会话？':'删除会话？'" :show-close="false" :prevent-close="deleting" content-class="cq-delete-modal" @update:open="value=>{if(!value)closeDelete()}"><div v-if="confirmation" class="cq-delete-dialog"><ul class="cq-delete-targets"><li v-for="(row,index) in confirmation.rows" :key="index">{{safe(sessionName(row))}}</li></ul><p>将从列表移除{{confirmation.bulk?'所选会话':'此会话'}}及其 {{deleteTaskCount}} 条历史任务；再次使用此主题会开启新会话。已生成的报告和附件保留。</p><p class="cq-error" role="alert">{{confirmation.error}}</p><div class="cq-delete-actions"><Button variant="outline" :disabled="deleting" @click="closeDelete()">取消</Button><Button variant="destructive" :disabled="deleting" @click="executeDelete">{{confirmation.bulk?'确认批量删除':'确认删除'}}</Button></div></div></Dialog>
 <Dialog :open="!!original" :title="(original?.actor??'')+' 原始消息'" :show-close="false" content-class="cq-original-modal" @update:open="value=>{if(!value)original=null}"><section v-if="original" class="cq-panel cq-modal-panel"><header><strong>{{original.actor}} 原始消息</strong><Button variant="ghost" class="cq-dialog-close" @click="original=null">关闭</Button></header><div class="cq-muted">任务 {{safe(original.record.jobId)}} · {{time(original.snapshot?.at??original.record.createdAt)}}</div><p class="cq-muted">展示已保存且经过脱敏的消息快照。</p><div class="cq-scroll cq-modal-body"><SourceView class="cq-modal-source" title="原始 JSON" :value="originalPayload" :redact="safe" :initial-open="true"/></div></section></Dialog>
</template>
<style scoped>
.cq-panel{min-height:0;}
.cq-list-tools,.cq-search-row{display:flex;align-items:center;gap:8px;}
.cq-list-tools>[data-slot=native-select-wrapper],.cq-search-row>input{flex:1;min-width:0;}
.cq-list-summary{font-size:11px;line-height:1.6;padding:0 2px 4px;}
.cq-delete-dialog{max-width:100%;overflow-wrap:anywhere;}
</style>
<style>
[data-ocp-overlay] .cq-original-modal{width:min(760px,calc(100vw - 32px));max-width:calc(100vw - 32px);height:min(780px,calc(100dvh - 48px));padding:0;overflow:hidden;display:flex;flex-direction:column;}
[data-ocp-overlay] .cq-original-modal>h2{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden;}
[data-ocp-overlay] .cq-delete-modal{width:min(440px,calc(100vw - 32px));}
</style>
