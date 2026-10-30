<script setup lang="ts">
import {DialogRoot,DialogPortal,DialogOverlay,DialogContent,DialogTitle,DialogDescription,DialogClose} from 'reka-ui';
import {useHostContext,useOverlayTarget} from '../host';
import {Button} from './button';
import {computed,useId,watch} from 'vue';
const props=defineProps<{open:boolean;title:string;description?:string}>();
const emit=defineEmits<{'update:open':[value:boolean]}>();
const context=useHostContext(),target=useOverlayTarget();
const descriptionId=useId();
watch([
 ()=>context.value.presented,()=>context.value.host.connection.canRead,()=>context.value.host.connection.canWrite,
 ()=>context.value.props.agentId??context.value.host.agents.selectedId,
 ()=>context.value.props.sessionKey??context.value.host.sessions.selectedKey,
 ()=>context.value.props.projectId,()=>context.value.props.jobId,()=>context.value.props.topic,
],()=>emit('update:open',false),{flush:'sync'});
const visible=computed(()=>props.open&&context.value.presented&&context.value.host.connection.canRead);
</script>
<template>
 <DialogRoot :open="visible" @update:open="emit('update:open',$event)">
  <DialogPortal :to="target">
   <DialogOverlay class="ocp:fixed ocp:inset-0 ocp:bg-foreground/20" />
   <DialogContent :aria-describedby="description ? descriptionId : undefined" class="ocp:fixed ocp:top-1/2 ocp:left-1/2 ocp:-translate-x-1/2 ocp:-translate-y-1/2 ocp:w-[calc(100%-2rem)] ocp:max-w-lg ocp:max-h-[85vh] ocp:overflow-auto ocp:rounded-lg ocp:border ocp:bg-background ocp:p-6 ocp:shadow-lg">
    <DialogTitle class="ocp:font-semibold ocp:text-lg">{{title}}</DialogTitle>
    <DialogDescription v-if="description" :id="descriptionId" class="ocp:text-sm ocp:text-muted-foreground">{{description}}</DialogDescription>
    <slot />
    <DialogClose as-child><Button variant="ghost" size="sm" aria-label="关闭">关闭</Button></DialogClose>
   </DialogContent>
  </DialogPortal>
 </DialogRoot>
</template>
