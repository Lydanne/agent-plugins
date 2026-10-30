<script setup lang="ts">
import {computed} from 'vue';
import {Button} from '@openclaw-plugins/control-ui-kit';
import {toolCalls,taskTime} from '../timing.mjs';
import {activeStatuses,statusLabels,time,type TaskRecord,type MessageEntry} from './models';
import MessageText from './MessageText.vue';
import ToolCalls from './ToolCalls.vue';
import ProcessTimeline from './ProcessTimeline.vue';
const props=defineProps<{record:TaskRecord;view:string;filter:string;redact:(value:string)=>string;now:number}>();
const emit=defineEmits<{original:[actor:string,record:TaskRecord,snapshot?:MessageEntry]}>();
const safe=(value:unknown)=>props.redact(String(value??''));
const messages=computed(()=>props.record.events.filter(e=>e.event==='item.completed'&&e.item?.type==='agent_message'));
const calls=computed(()=>toolCalls(props.record.events));
const textOf=(item:unknown)=>typeof item==='string'?item:'';
const entries=computed(()=>{
 const record=props.record,result:MessageEntry[]=[];
 for(const message of messages.value){const text=textOf(message.item?.text);let protocol:{type?:string}|undefined;try{protocol=JSON.parse(text);}catch{}if(!['context_request','request'].includes(protocol?.type??''))result.push({actor:'Worker',at:message.time,text,raw:message});}
 if(record.result&&messages.value.at(-1)?.item?.text!==record.result&&!['awaiting_main','awaiting_user'].includes(record.status))result.push({actor:'Worker',at:record.finishedAt??record.startedAt,text:record.result});
 for(const q of record.questions??[]){result.push({actor:'Worker',at:q.createdAt,text:q.question,question:q,raw:q});if(q.answer)result.push({actor:q.answerSource==='user_card'?'用户':'Main',at:q.answeredAt,text:q.answer,raw:q});}
 return result.sort((a,b)=>(a.at??0)-(b.at??0)).filter(entry=>props.filter==='all'||props.filter===entry.actor);
});
const toolLabel=computed(()=>`${calls.value.length} 条执行记录 · MCP ${calls.value.filter(c=>c.item.type==='mcp_tool_call').length} · 网站 ${calls.value.filter(c=>c.item.type==='web_search').length} · 技能相关命令 ${calls.value.filter(c=>/SKILL\.md/i.test(c.item.command??'')).length}`);
</script>
<template>
 <section class="cq-run" :data-record-key="record.jobId"><div class="cq-run-heading"><span>{{time(record.createdAt)}}</span><span class="cq-elapsed">{{taskTime(record,now)}}</span><span class="cq-state" :class="record.status">{{statusLabels[record.status]??record.status}}</span></div>
 <ProcessTimeline v-if="view==='process'" :record="record" :redact="redact" :now="now"/>
 <template v-else>
  <article v-if="filter!=='Worker'" class="cq-message main"><div class="cq-message-heading"><span class="cq-avatar">M</span><span class="cq-identity"><strong>Main</strong><span class="cq-speaker-note">任务交接</span></span><time>{{time(record.createdAt)}}</time><Button variant="ghost" size="xs" class="cq-original-button" @click="emit('original','Main',record)">原始消息</Button></div><template v-if="record.request.availability==='available'"><MessageText :text="safe(record.request.task)"/><details v-if="record.request.context" class="cq-disclosure"><summary>任务上下文</summary><MessageText class="cq-disclosure-body" :text="safe(record.request.context)"/></details><details v-if="record.request.constraints" class="cq-disclosure"><summary>执行限制</summary><MessageText class="cq-disclosure-body" :text="safe(record.request.constraints)"/></details></template><p v-else class="cq-unavailable">原始任务正文不可用</p></article>
  <template v-if="record.questions?.length">
   <article v-for="(entry,index) in entries" :key="index" class="cq-message" :class="entry.actor.toLowerCase()"><div class="cq-message-heading"><span class="cq-avatar">{{entry.actor==='用户'?'U':entry.actor==='Main'?'M':'W'}}</span><span class="cq-identity"><strong>{{entry.actor}}</strong><span class="cq-speaker-note">{{entry.actor==='用户'?'卡片补充':entry.actor==='Main'?'任务交接':'执行回复'}}</span></span><time>{{time(entry.at)}}</time><Button variant="ghost" size="xs" class="cq-original-button" @click="emit('original',entry.actor,record,entry)">原始消息</Button></div><MessageText :text="safe(entry.text)"/><template v-if="entry.question"><small>{{entry.question.requestKind==='plugin'?'请求 Main 调用插件':'请求 Main 补充上下文'}}</small><details class="cq-disclosure"><summary>提问原因与已完成工作</summary><MessageText class="cq-disclosure-body" :text="safe((entry.question.reason??'')+'\n'+(entry.question.progress??''))"/></details><p v-if="!entry.question.answer" class="cq-muted">{{['awaiting_main','awaiting_user'].includes(record.status)?statusLabels[record.status]+' 回复 · '+time(entry.question.expiresAt)+' 前有效':'任务已结束，问题未回答'}}</p></template></article>
   <details v-if="filter!=='Main'&&calls.length" class="cq-disclosure"><summary>Worker · 工具与执行记录</summary><ToolCalls class="cq-disclosure-body" :events="record.events" :redact="redact" :task="record" :now="now"/></details>
  </template>
  <article v-else-if="filter!=='Main'" class="cq-message worker"><div class="cq-message-heading"><span class="cq-avatar">W</span><span class="cq-identity"><strong>Worker</strong><span class="cq-speaker-note">执行回复</span></span><time>{{time(messages.at(-1)?.time??record.finishedAt??record.startedAt)}}</time><Button variant="ghost" size="xs" class="cq-original-button" @click="emit('original','Worker',record)">原始消息</Button></div><template v-for="(message,index) in messages" :key="index"><small v-if="messages.length>1" class="cq-reply-time">{{time(message.time)}}</small><MessageText :text="safe(message.item?.text)"/></template><MessageText v-if="record.result&&messages.at(-1)?.item?.text!==record.result" :text="safe(record.result)"/><p v-if="!messages.length&&!record.result" class="cq-muted">{{activeStatuses.has(record.status)?'尚未收到执行回复':'执行回复不可用'}}</p><details v-if="calls.length" class="cq-disclosure"><summary>{{toolLabel}}</summary><ToolCalls class="cq-disclosure-body" :events="record.events" :redact="redact" :task="record" :now="now"/></details></article>
 </template>
 <p v-if="record.eventsAvailability!=='available'" class="cq-muted">该任务没有可读取的详细过程记录。旧任务不会补造工具细节。</p><p v-if="record.omitted" class="cq-error">日志达到存储上限，{{record.omitted}} 条事件未保存。</p>
 </section>
</template>
