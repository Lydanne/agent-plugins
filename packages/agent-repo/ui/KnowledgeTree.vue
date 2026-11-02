<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {Card,Input} from '@openclaw-plugins/control-ui-kit';
import {VirtualNavigationTree,type NavigationTreeItem} from '@openclaw-plugins/control-ui-kit/virtual-navigation-tree';
import {buildKnowledgeTree,flattenKnowledgeTree,type KnowledgeTreeRow} from './knowledge-tree';
import type {KnowledgeEntry} from './knowledge-model';
const props=defineProps<{entries:KnowledgeEntry[];selected:string;redact:(v:unknown)=>string}>(),emit=defineEmits<{select:[path:string]}>();
const opened=ref(new Set<string>()),filter=ref(''),view=ref<InstanceType<typeof VirtualNavigationTree>>();
watch(()=>props.selected,p=>{const parts=p.split('/');for(let i=1;i<parts.length;i++)opened.value.add(parts.slice(0,i).join('/'));},{immediate:true});
watch(filter,()=>view.value?.reset());
const tree=computed(()=>buildKnowledgeTree(props.entries)),rows=computed(()=>flattenKnowledgeTree(tree.value,opened.value,filter.value));
const items=computed<NavigationTreeItem[]>(()=>rows.value.map(row=>({id:row.path,label:props.redact(row.title),depth:row.depth,expandable:row.folder,expanded:!!filter.value.trim()||opened.value.has(row.path),current:props.selected===row.entry?.path,hasDocument:!!row.entry,title:props.redact(row.entry?.path??row.path)})));
watch([()=>props.selected,tree],()=>{const row=rows.value.find(r=>r.entry?.path===props.selected);if(row)view.value?.reveal(row.path);},{flush:'post'});
function toggleId(id:string){const row=rows.value.find(r=>r.path===id);if(row)toggle(row);}
function selectId(id:string){const row=rows.value.find(r=>r.path===id);if(row)choose(row);}
function toggle(row:KnowledgeTreeRow){if(opened.value.has(row.path))opened.value.delete(row.path);else opened.value.add(row.path);}
function choose(row:KnowledgeTreeRow){if(row.entry){if(row.folder)opened.value.add(row.path);emit('select',row.entry.path);}else toggle(row);}
</script>
<template><Card as="aside" class="kb-tree"><nav aria-label="知识目录树"><Input v-model="filter" aria-label="筛选目录树" placeholder="查找知识标题或路径"/><VirtualNavigationTree ref="view" :items="items" label="知识文档" :searching="!!filter.trim()" @toggle="toggleId" @select="selectId"/><small>{{entries.length}} 篇文档<span v-if="filter&&!rows.length"> · 没有匹配的知识</span></small></nav></Card></template>
<style scoped>.kb-tree{min-width:0;min-height:650px;padding:12px;gap:0}.kb-tree nav{display:flex;flex:1 1 auto;min-height:0;flex-direction:column}small{color:var(--ocp-muted);font-size:12px}</style>
