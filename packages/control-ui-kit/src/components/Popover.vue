<script setup lang="ts">
import {PopoverRoot,PopoverTrigger,PopoverPortal,PopoverContent} from 'reka-ui';
import {watch} from 'vue';
import {useHostContext,useOverlayTarget} from '../host';
const props=defineProps<{open:boolean;label:string}>();
const emit=defineEmits<{'update:open':[value:boolean];closeAutoFocus:[event:Event]}>();
const context=useHostContext(),target=useOverlayTarget();
watch([()=>context.value.presented,()=>context.value.host.connection.canRead,()=>context.value.host.connection.canWrite,()=>context.value.props.agentId??context.value.host.agents.selectedId,()=>context.value.props.sessionKey??context.value.host.sessions.selectedKey],()=>emit('update:open',false),{flush:'sync'});
</script>
<template><PopoverRoot :open="props.open" @update:open="emit('update:open',$event)"><PopoverTrigger as-child><slot name="trigger"/></PopoverTrigger><PopoverPortal :to="target"><PopoverContent @close-auto-focus="emit('closeAutoFocus',$event)" :aria-label="label" :side-offset="6" :collision-padding="12" align="end" class="ocp:z-10 ocp:grid ocp:gap-2 ocp:w-80 ocp:max-w-[calc(100vw-24px)] ocp:max-h-[min(70vh,var(--reka-popover-content-available-height))] ocp:overflow-auto ocp:rounded-md ocp:border ocp:bg-background ocp:p-3 ocp:shadow-lg ocp:outline-none"><slot/></PopoverContent></PopoverPortal></PopoverRoot></template>
