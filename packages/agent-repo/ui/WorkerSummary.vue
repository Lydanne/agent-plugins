<script setup lang="ts">
import {computed} from 'vue';
import {Button} from '@openclaw-plugins/control-ui-kit';
import type {AgentTaskPage} from './worker-model';
const props=withDefaults(defineProps<{value?:AgentTaskPage|null;error?:string;loading?:boolean;open?:()=>void;safe?:(value:unknown)=>string}>(),{safe:(value:unknown)=>String(value??'')});
const metrics=computed(()=>{const c=props.value?.counts??{};return [['运行中',c.running??0],['排队中',c.queued??0],['等待 Main',c.awaiting_main??0],['等待用户',c.awaiting_user??0],['已完成',c.completed??0],['失败 / 超时',(c.failed??0)+(c.timed_out??0)]];});
</script>
<template>
 <section class="ar-worker-summary ar-overview-card" data-ocp-ui><header><h3>Worker 任务</h3><Button v-if="open" variant="ghost" size="sm" @click="open">查看全部任务</Button></header>
 <p v-if="error" role="alert" class="ar-error">Agent Worker 暂不可读取：{{safe(error)}}</p>
 <p v-else-if="!value" class="ar-description">{{loading?'正在读取 Worker 任务…':'Worker 任务尚未读取'}}</p>
 <template v-else><p class="ar-description">{{value.taskTotal}} 个可归属任务 · {{value.conversationTotal}} 个来源会话 · 当前 Agent 全部会话</p><div class="ar-worker-metrics"><div v-for="[label,count] in metrics" :key="label"><strong>{{count}}</strong><span>{{label}}</span></div></div><p v-if="value.counts.unknown" class="ar-warning">{{value.counts.unknown}} 个任务状态待核实，不能视为仍在执行。</p><p class="ar-description">{{safe(value.coverage)}}</p></template>
 </section>
</template>
