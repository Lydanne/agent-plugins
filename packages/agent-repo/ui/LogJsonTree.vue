<script setup lang="ts">
import {computed,ref} from 'vue';
import HighlightedText from './HighlightedText.vue';
const props=withDefaults(defineProps<{value:unknown;label:string;needle:string;depth?:number;safe:(v:unknown)=>string}>(),{depth:0});
const object=computed(()=>props.value!==null&&typeof props.value==='object'&&props.depth<7);
const entries=computed(()=>object.value?Object.entries(props.value as Record<string,unknown>):[]);
const loaded=ref(props.depth===0),open=ref(props.depth===0);
const title=computed(()=>props.label+' '+(Array.isArray(props.value)?'['+props.value.length+']':'{'+entries.value.length+'}'));
function toggle(event:Event){open.value=(event.target as HTMLDetailsElement).open;if(open.value)loaded.value=true;}
</script>
<template><details v-if="object" :open="open" @toggle="toggle"><summary><HighlightedText :text="safe(title)" :needle="needle"/></summary><template v-if="loaded"><LogJsonTree v-for="[name,value] in entries" :key="name" :value="value" :label="name" :needle="needle" :depth="depth+1" :safe="safe"/></template></details><div v-else><HighlightedText :text="safe(label+': '+JSON.stringify(value))" :needle="needle"/></div></template>
