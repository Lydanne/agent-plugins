<script setup lang="ts">
import {computed} from 'vue';
import {toolCalls,callTime,type ToolItem,type ToolEvent,type ObservedToolCall,type TaskTiming} from '../timing.mjs';
import {time,statusLabels} from './models';
import SourceView from './SourceView.vue';
const props=defineProps<{events:ToolEvent[];redact:(value:string)=>string;task:TaskTiming;now:number}>();
const calls=computed(()=>props.events.every((event):event is ObservedToolCall=>typeof event.callKey==='string'&&!!event.item)?props.events:toolCalls(props.events));
const failed=(item:ToolItem)=>item.status==='failed'||typeof item.exit_code==='number'&&item.exit_code!==0||Boolean(item.error);
function name(item:ToolItem){const kind=item.type==='mcp_tool_call'?'MCP':item.type==='web_search'?'网站访问 / 搜索':item.type==='file_change'?'文件变更':/SKILL\.md/i.test(item.command??'')?'技能相关命令':'工具命令';const title=item.type==='mcp_tool_call'?`${item.server} / ${item.tool}`:item.command?.split('\n')[0];return props.redact((failed(item)?'执行失败 · ':'')+kind+(title?' · '+title:''));}
function fields(item:ToolItem):[string,unknown][]{return [['执行命令',item.command],['调用参数',item.arguments],['执行输出',item.aggregated_output],['返回结果',item.result],['错误信息',item.error],['网站操作',item.action]].filter(([,value])=>value!==undefined&&value!==null) as [string,unknown][];}
function urls(item:ToolItem){return [...new Set(JSON.stringify(item).match(/https?:\/\/[^\s"<>\\]+/g)??[])].filter(value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}});}
</script>
<template>
 <div class="cq-calls"><details v-for="call in calls" :key="call.callKey" class="cq-disclosure" :class="{'cq-call-failed':failed(call.item)}" :data-fold-key="redact(call.callKey)"><summary><span class="cq-call-name">{{name(call.item)}}</span><span class="cq-call-elapsed" :title="call.startedAt===undefined?'耗时未记录':call.finishedAt!==undefined?'工具调用耗时':'工具调用已用时；尚未取得完成记录'">{{callTime(call,task,now)}}</span></summary><div class="cq-disclosure-body">
  <div class="cq-call-meta"><time>{{time(call.time)}}</time><span v-if="call.startedAt!==undefined">开始 {{time(call.startedAt)}}</span><span v-if="call.finishedAt!==undefined">结束 {{time(call.finishedAt)}}</span><span v-if="call.item.status">{{redact(statusLabels[call.item.status]??call.item.status)}}</span><span v-if="call.item.exit_code!==undefined">退出码 {{String(call.item.exit_code)}}</span></div>
  <SourceView v-for="[title,value] in fields(call.item)" :key="title" :title="title" :value="value" :redact="redact" />
  <details v-if="call.item.changes" class="cq-disclosure"><summary>变更文件 · {{call.item.changes.length}}</summary><div class="cq-disclosure-body"><details v-for="(change,index) in call.item.changes" :key="index" class="cq-disclosure"><summary>{{redact(`${change.kind??'修改'} · ${change.path??'文件'}`)}}</summary><div class="cq-disclosure-body"><SourceView title="变更记录" :value="change" :redact="redact" /></div></details></div></details>
  <details v-if="urls(call.item).length" class="cq-disclosure"><summary>相关网站 · {{urls(call.item).length}}</summary><div class="cq-call-links cq-disclosure-body"><a v-for="url in urls(call.item)" :key="url" :href="redact(url)" target="_blank" rel="noopener noreferrer">{{redact(url)}}</a></div></details>
  <p v-if="/SKILL\.md/i.test(call.item.command??'')" class="cq-muted">包含技能文件路径的命令；不证明技能被完整读取或遵循。</p><SourceView title="原始记录" :value="call" :redact="redact" />
 </div></details></div>
</template>
