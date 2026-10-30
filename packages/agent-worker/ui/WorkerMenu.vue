<script setup lang="ts">
import {computed} from 'vue';
import {ActionMenu} from '@openclaw-plugins/control-ui-kit';
import {sessionName,type SessionRow} from './models';
const props=defineProps<{open:boolean;row?:SessionRow;selected?:boolean;deleting?:boolean;redact:(value:string)=>string}>();
const emit=defineEmits<{'update:open':[value:boolean];remove:[row:SessionRow];pick:[row:SessionRow];multiple:[]}>();
const label=computed(()=>props.row?props.redact(sessionName(props.row)+' 的更多操作'):'会话列表更多操作');
const items=computed(()=>props.row?[
 {id:'remove',label:'删除会话',disabled:props.deleting||props.row.canDelete!==true,title:props.redact(props.row.deleteReason??'删除此会话的历史任务和复用绑定'),destructive:true,class:'cq-delete'},
 ...(!props.selected?[{id:'pick',label:'选择会话',disabled:props.deleting||props.row.canDelete!==true,title:props.redact(props.row.deleteReason??'选择此会话进行批量操作')}]:[]),
]:[{id:'multiple',label:'多选会话'}]);
function select(id:string){if(id==='remove'&&props.row)emit('remove',props.row);else if(id==='pick'&&props.row)emit('pick',props.row);else if(id==='multiple')emit('multiple');}
</script>
<template><ActionMenu class="cq-more" :open="open" :label="label" :items="items" @update:open="emit('update:open',$event)" @select="select"/></template>
