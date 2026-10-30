<script setup lang="ts">
import {ref,onBeforeUnmount} from 'vue';
import type {GraphService} from '../../agent-repo-api/entities.mjs';
const props=defineProps<{id:string;invoke:<T>(action:string,payload:Record<string,unknown>)=>Promise<T>;safe:(v:unknown)=>string}>();
const result=ref<ReturnType<GraphService['traverse']>>(),loading=ref(false),error=ref('');let alive=true;
async function expand(event:Event){if(!(event.target as HTMLDetailsElement).open||result.value||loading.value)return;loading.value=true;error.value='';try{const next=await props.invoke<ReturnType<GraphService['traverse']>>('graph',{id:props.id,depth:1,limit:100});if(alive)result.value=next;}catch{if(alive)error.value='关联读取失败，请重新展开重试';}finally{if(alive)loading.value=false;}}
function name(fromId:string,toId:string){return result.value?.entities.find(e=>e.id===(fromId===props.id?toId:fromId))?.name??'未知实体';}
onBeforeUnmount(()=>{alive=false;});
</script>
<template><details @toggle="expand"><summary>查看关联关系</summary><p v-if="loading">正在读取…</p><p v-if="error" role="alert">{{error}}</p><template v-if="result"><p v-for="relation in result.relations" :key="relation.id">{{safe((relation.fromId===id?'→ ':'← ')+(result.relationTypes?.find(type=>type.id===relation.typeId)?.label??relation.typeId)+' · '+name(relation.fromId,relation.toId))}}</p><p v-if="!result.relations.length">暂无有效关联</p><p v-if="result.truncated">关联较多，仅展示前 100 条</p></template></details></template>
