<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {Button,NativeSelect,StatusNotice,useHostContext} from '@openclaw-plugins/control-ui-kit';
import {useManagementRequest} from './management-request';
interface Entity {id:string;name:string;type:string;sourceId:string;sourceLabel?:string}
interface Relation {fromId:string;toId:string;type:string}
interface Directory {agentId:string;entities:Entity[];relations:Relation[]}
const props=defineProps<{agentId:string;entityType:string;modelValue:string;disabled?:boolean}>();
const emit=defineEmits<{ 'update:modelValue':[value:string];validity:[value:boolean] }>();
const context=useHostContext(),request=useManagementRequest(context,()=>props.agentId,'agent-repo','authorization-');
const directory=ref<Directory|null>(null),loading=ref(false),error=ref(''),organization=ref(''),departments=ref<string[]>([]);
const other='__unassociated__';
const entities=computed(()=>directory.value?.entities??[]),byId=computed(()=>new Map(entities.value.map(e=>[e.id,e])));
const organizations=computed(()=>entities.value.filter(e=>e.type==='organization'));
const links=computed(()=>directory.value?.relations??[]);
const counts=computed(()=>{const result=new Map<string,number>();for(const e of entities.value){const key=e.type+'\0'+e.name;result.set(key,(result.get(key)??0)+1);}return result;});
const label=(e:Entity)=>e.name+((counts.value.get(e.type+'\0'+e.name)??0)>1?' · '+[e.sourceLabel,e.id].filter(Boolean).join(' · '):'');
const parentIndex=computed(()=>{const result=new Map<string,string[]>();for(const edge of links.value){const key=edge.type+'\0'+edge.fromId;result.set(key,[...(result.get(key)??[]),edge.toId]);}return result;});
function parents(id:string,type:string){return parentIndex.value.get(type+'\0'+id)??[];}
function pathTo(id:string,seen=new Set<string>()):string[]{
 if(seen.has(id))return [];const node=byId.value.get(id);if(!node)return [];if(node.type==='organization')return [id];
 const next=new Set(seen).add(id),parentIds=parents(id,node.type==='person'?'member_of':'parent_department');
 for(const parent of parentIds){const path=pathTo(parent,next);if(path.length)return [...path,id];}
 const org=parents(id,'belongs_to').find(key=>byId.value.get(key)?.type==='organization');
 return org?[org,id]:[id];
}
function restore(){
 const selected=byId.value.get(props.modelValue);organization.value='';departments.value=[];
 if(!selected||selected.type!==props.entityType)return;
 const path=pathTo(selected.id);organization.value=path.find(id=>byId.value.get(id)?.type==='organization')??other;
 departments.value=path.filter(id=>byId.value.get(id)?.type==='department');
}
const detached=computed(()=>entities.value.filter(e=>e.type!=='organization'&&!pathTo(e.id).some(id=>byId.value.get(id)?.type==='organization')));
const detachedIds=computed(()=>new Set(detached.value.map(e=>e.id)));
function children(parent:string){
 const all=entities.value.filter(e=>e.type==='department');
 if(parent===other)return detached.value.filter(e=>e.type==='department'&&!parents(e.id,'parent_department').some(id=>detachedIds.value.has(id)));
 const org=byId.value.get(parent)?.type==='organization';
 return all.filter(e=>org?parents(e.id,'belongs_to').includes(parent)&&!parents(e.id,'parent_department').some(id=>byId.value.has(id)):parents(e.id,'parent_department').includes(parent));
}
const levels=computed(()=>{
 if(!organization.value||props.entityType==='organization')return [];
 const result:Entity[][]=[];let parent=organization.value;
 for(let index=0;index<=departments.value.length;index++){
  let options=children(parent).filter(e=>!departments.value.slice(0,index).includes(e.id));
  // Keep disconnected/cyclic records reachable without inventing a hierarchy.
  if(parent===other&&!options.length)options=detached.value.filter(e=>e.type==='department');
  if(!options.length)break;result.push(options);if(!departments.value[index])break;parent=departments.value[index];
 }
 return result;
});
const people=computed(()=>{
 const parent=departments.value.at(-1)??organization.value;
 if(!parent)return [];
 return entities.value.filter(e=>e.type==='person'&&(parent===other?detachedIds.value.has(e.id)&&!parents(e.id,'member_of').some(id=>byId.value.has(id)):byId.value.get(parent)?.type==='department'?parents(e.id,'member_of').includes(parent):parents(e.id,'belongs_to').includes(parent)&&!parents(e.id,'member_of').some(id=>byId.value.has(id))));
});
function chooseOrganization(value:string){organization.value=value;departments.value=[];emit('update:modelValue',props.entityType==='organization'&&value!==other?value:'');}
function chooseDepartment(index:number,value:string){departments.value=[...departments.value.slice(0,index),...(value?[value]:[])];emit('update:modelValue',props.entityType==='department'?(departments.value.at(-1)??''):'');}
async function load(){const valid=request.capture();loading.value=true;error.value='';directory.value=null;try{const value=await request.invoke<Directory>('entityOptions',{});if(!valid())return;if(value.agentId!==props.agentId)throw Error('实体资料来源不一致');directory.value=value;restore();}catch(e){if(valid())error.value=String(e);}finally{if(valid())loading.value=false;}}
watch(()=>props.agentId,()=>{organization.value='';departments.value=[];void load();},{immediate:true});
watch(()=>props.entityType,()=>{emit('update:modelValue','');organization.value='';departments.value=[];});
watch(()=>props.modelValue,(value)=>{if(value&&value!==departments.value.at(-1)&&value!==organization.value&&!people.value.some(e=>e.id===value))restore();});
const selected=computed(()=>byId.value.get(props.modelValue));
watch([selected,loading,()=>props.entityType],()=>emit('validity',!loading.value&&selected.value?.type===props.entityType),{immediate:true});
</script>
<template>
 <div class="entity-picker" :aria-busy="loading">
  <p v-if="loading" role="status">正在读取组织和实体…</p>
  <StatusNotice v-if="error" tone="error">{{error}} <Button type="button" variant="outline" @click="load">重试</Button></StatusNotice>
  <template v-if="directory">
   <label>组织<NativeSelect aria-label="组织" :model-value="organization" :disabled="disabled||loading" @update:model-value="chooseOrganization(String($event))"><option value="">请选择组织</option><option v-for="item in organizations" :key="item.id" :value="item.id">{{label(item)}}</option><option v-if="entityType!=='organization'&&detached.length" :value="other">未关联组织的实体</option></NativeSelect></label>
   <label v-for="(options,index) in levels" :key="index">{{index===0?'部门':'下级部门 '+index}}<NativeSelect :aria-label="index===0?'部门':'下级部门 '+index" :model-value="departments[index]??''" :disabled="disabled||loading" @update:model-value="chooseDepartment(index,String($event))"><option value="">{{index===0?'请选择部门':'停留在当前部门'}}</option><option v-for="item in options" :key="item.id" :value="item.id">{{label(item)}}</option></NativeSelect></label>
   <label v-if="entityType==='person'&&organization">人员<NativeSelect aria-label="人员" :model-value="modelValue" :disabled="disabled||loading||!people.length" @update:model-value="emit('update:modelValue',String($event))"><option value="">{{people.length?'请选择人员':'当前范围暂无直属人员'}}</option><option v-for="item in people" :key="item.id" :value="item.id">{{label(item)}}</option></NativeSelect></label>
   <p v-if="selected">已选择：{{selected.name}} <small>{{selected.sourceLabel}}</small></p>
   <StatusNotice v-else-if="modelValue" tone="warning">原绑定实体已停用或不可读取，请重新选择后保存。</StatusNotice>
   <p v-if="!entities.length">暂无可选实体，请先在实体库中同步组织和人员资料。</p>
  </template>
 </div>
</template>
<style scoped>
.entity-picker{display:grid;gap:12px;min-width:0}label{display:grid;gap:6px}small{color:var(--ocp-muted-foreground);overflow-wrap:anywhere}
</style>
