<script setup lang="ts">
import {DialogRoot,DialogPortal,DialogOverlay,DialogContent,DialogTitle,DialogDescription,DialogClose} from 'reka-ui';
import {useHostContext,useOverlayTarget} from '../host';
import {Button} from './button';
import {computed,watch} from 'vue';
const props=withDefaults(defineProps<{open:boolean;title:string;description?:string;preventClose?:boolean;showClose?:boolean;contentClass?:string;returnFocus?:()=>HTMLElement|null}>(),{showClose:true});
function externalNativeModal(){return Array.from(target.ownerDocument.querySelectorAll('dialog[open]')).some(dialog=>{try{return dialog.matches(':modal')&&!target.contains(dialog);}catch{return false;}});}
function changeOpen(value:boolean){if(!props.preventClose&&(value||!externalNativeModal()))emit('update:open',value);}
function guardClose(event:Event){if(props.preventClose)event.preventDefault();}
function escape(event:KeyboardEvent){if(externalNativeModal())return;emit('escape',event);guardClose(event);}
const emit=defineEmits<{'update:open':[value:boolean];escape:[event:KeyboardEvent]}>();
const context=useHostContext(),target=useOverlayTarget();
let returnFocus:HTMLElement|null=null;
watch(()=>props.open,value=>{if(value){const active=target.ownerDocument.activeElement;returnFocus=active instanceof target.ownerDocument.defaultView!.HTMLElement?active:null;}},{immediate:true,flush:'sync'});
function restoreFocus(event:Event){
 const destination=props.returnFocus?.()??returnFocus;
 if(destination?.isConnected&&context.value.presented&&context.value.host.connection.canRead){event.preventDefault();destination.focus({preventScroll:true});}
}

watch([
 ()=>context.value.presented,()=>context.value.host.connection.canRead,()=>context.value.host.connection.canWrite,
 ()=>context.value.props.agentId??context.value.host.agents.selectedId,
 ()=>context.value.props.sessionKey??context.value.host.sessions.selectedKey,
 ()=>context.value.props.projectId,()=>context.value.props.jobId,()=>context.value.props.topic,
],()=>emit('update:open',false),{flush:'sync'});
const visible=computed(()=>props.open&&context.value.presented&&context.value.host.connection.canRead);
</script>
<template>
 <DialogRoot :open="visible" @update:open="changeOpen">
  <DialogPortal :to="target">
   <DialogOverlay class="ocp:fixed ocp:inset-0 ocp:bg-foreground/20" />
   <DialogContent data-ocp-modal @close-auto-focus="restoreFocus" @escape-key-down="escape" @interact-outside="guardClose" :class="contentClass" v-bind="description?{}:{'aria-describedby':undefined}" class="ocp:fixed ocp:top-1/2 ocp:left-1/2 ocp:-translate-x-1/2 ocp:-translate-y-1/2 ocp:w-[calc(100%-2rem)] ocp:max-w-lg ocp:max-h-[85vh] ocp:overflow-auto ocp:rounded-lg ocp:border ocp:bg-background ocp:p-6 ocp:shadow-lg">
    <DialogTitle class="ocp:font-semibold ocp:text-lg">{{title}}</DialogTitle>
    <DialogDescription v-if="description" class="ocp:text-sm ocp:text-muted-foreground">{{description}}</DialogDescription>
    <slot />
    <DialogClose v-if="showClose!==false" as-child><Button variant="ghost" size="sm" :disabled="preventClose" aria-label="关闭">关闭</Button></DialogClose>
   </DialogContent>
  </DialogPortal>
 </DialogRoot>
</template>
