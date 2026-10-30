<script setup lang="ts">
import {computed} from 'vue';
import {toolCalls,type ObservedToolCall} from '../timing.mjs';
import {time,statusLabels,type TaskRecord,type WorkerQuestion} from './models';
import ToolCalls from './ToolCalls.vue';
import MessageText from './MessageText.vue';
import SourceView from './SourceView.vue';
const props=defineProps<{record:TaskRecord;redact:(value:string)=>string;now:number}>();
interface Entry {kind:string;at?:number;label:string;call?:ObservedToolCall;question?:WorkerQuestion}
const entries=computed(()=>{
 const record=props.record;
 const result:Entry[]=[{kind:'accepted',at:record.createdAt,label:'任务受理'},{kind:'started',at:record.startedAt,label:'Worker 开始执行'}].filter(e=>!!e.at);
 for(const round of record.executionRounds??[])if(round.resumed)result.push({kind:'resumed',at:round.startedAt,label:'Worker 继续执行'});
 for(const call of toolCalls(record.events))result.push({kind:'tool',at:call.startedAt??call.time,call,label:({command_execution:'Worker · 执行命令',mcp_tool_call:'Worker · 调用 MCP',web_search:'Worker · 网站访问 / 搜索',file_change:'Worker · 文件变更'} as Record<string,string>)[call.item.type]??'Worker · 工具调用'});
 for(const q of record.questions??[]){result.push({kind:'question',at:q.createdAt,label:q.requestKind==='plugin'?'Worker · 请求插件能力':'Worker · 请求上下文',question:q});if(q.waitingForUserAt)result.push({kind:'waiting_user',at:q.waitingForUserAt,label:'Main · 等待用户补充'});if(q.answer)result.push({kind:'answer',at:q.answeredAt,label:q.answerSource==='user_card'?'用户 · 卡片选择':q.answerSource==='main_context'?'Main · 自动补充':'Main · 补充上下文',question:q});}
 if(record.finishedAt)result.push({kind:'finished',at:record.finishedAt,label:statusLabels[record.status]??record.status});return result.sort((a,b)=>(a.at??0)-(b.at??0));
});
function state(entry:Entry){return entry.kind==='question'&&!entry.question?.answer?'awaiting_main':entry.kind==='waiting_user'?'awaiting_user':entry.kind==='finished'?props.record.status:entry.kind==='tool'&&entry.call&&(entry.call.item.status==='failed'||typeof entry.call.item.exit_code==='number'&&entry.call.item.exit_code!==0||entry.call.item.error)?'failed':'done';}
</script>
<template>
 <div class="cq-process-view"><div v-if="['awaiting_main','awaiting_user'].includes(record.status)" class="cq-process-current" :class="record.status"><strong>{{statusLabels[record.status]}}</strong><p>{{record.status==='awaiting_user'?'Main 需要用户补充信息，原任务暂时暂停。':'Worker 已提出问题，等待 Main 补充上下文。'}}</p></div>
 <div class="cq-process"><section v-for="(entry,index) in entries" :key="index" class="cq-process-node"><div class="cq-stage" :class="state(entry)"><span class="cq-stage-dot"/><strong>{{entry.label}}</strong><time>{{time(entry.at)}}</time></div>
  <div v-if="entry.call||entry.question||entry.kind==='waiting_user'" class="cq-process-body">
   <ToolCalls v-if="entry.call" :events="[entry.call]" :redact="redact" :task="record" :now="now" />
   <template v-if="entry.question&&entry.kind==='question'"><MessageText :text="redact(entry.question.question)"/><details class="cq-disclosure"><summary>原因与已完成工作</summary><MessageText class="cq-disclosure-body" :text="redact((entry.question.reason??'')+'\n'+(entry.question.progress??''))"/></details><SourceView title="提问原文" :value="entry.question" :redact="redact"/></template>
   <template v-if="entry.question&&entry.kind==='answer'"><MessageText :text="redact(entry.question.answer??'')"/><small v-if="entry.question.answerBasis" class="cq-muted">{{redact('依据：'+entry.question.answerBasis)}}</small><details v-if="entry.question.answerValues" class="cq-disclosure"><summary>已提交字段</summary><dl class="cq-information cq-disclosure-body"><template v-for="(value,id) in entry.question.answerValues" :key="id"><dt>{{entry.question.fields?.find(field=>field.id===id)?.label??id}}</dt><dd>{{redact(typeof value==='string'?value:JSON.stringify(value))}}</dd></template></dl></details><SourceView title="补充上下文原文" :value="entry.question" :redact="redact"/></template>
   <p v-if="entry.kind==='waiting_user'" class="cq-muted">等待用户回答；收到补充后继续原任务。</p>
  </div>
 </section></div></div>
</template>
