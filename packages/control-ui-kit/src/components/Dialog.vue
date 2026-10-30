<script setup lang="ts">
import {DialogRoot,DialogPortal,DialogOverlay,DialogContent,DialogTitle,DialogDescription,DialogClose} from 'reka-ui';
import {useHostContext,useOverlayTarget} from '../host';
import {Button} from './button';
import {computed,watch} from 'vue';
const props=withDefaults(defineProps<{open:boolean;title:string;showHeader?:boolean;bodyPadding?:boolean;bodyScroll?:boolean;size?:'confirm'|'filter'|'form'|'detail'|'wide'|'reader';sessionScoped?:boolean;description?:string;preventClose?:boolean;showClose?:boolean;contentClass?:string;returnFocus?:()=>HTMLElement|null}>(),{showClose:true,sessionScoped:true,size:'form',showHeader:true,bodyPadding:true,bodyScroll:true});
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
 ()=>props.sessionScoped?(context.value.props.sessionKey??context.value.host.sessions.selectedKey):undefined,
 ()=>context.value.props.projectId,()=>context.value.props.jobId,()=>context.value.props.topic,
],()=>emit('update:open',false),{flush:'sync'});
const visible=computed(()=>props.open&&context.value.presented&&context.value.host.connection.canRead);
</script>
<template>
 <DialogRoot :open="visible" @update:open="changeOpen">
  <DialogPortal :to="target">
   <DialogOverlay class="ocp:fixed ocp:inset-0 ocp:bg-foreground/20" />
   <DialogContent data-ocp-modal :data-dialog-size="size" @close-auto-focus="restoreFocus" @escape-key-down="escape" @interact-outside="guardClose" :class="contentClass" v-bind="description?{}:{'aria-describedby':undefined}" class="ocp:fixed ocp:top-1/2 ocp:left-1/2 ocp:-translate-x-1/2 ocp:-translate-y-1/2 ocp:rounded-lg ocp:border ocp:bg-background ocp:shadow-lg">
    <header v-if="showHeader" class="ocp-dialog-header"><div><DialogTitle class="ocp:font-semibold ocp:text-lg">{{title}}</DialogTitle><DialogDescription v-if="description" class="ocp:text-sm ocp:text-muted-foreground">{{description}}</DialogDescription></div><DialogClose v-if="showClose!==false" as-child><Button variant="ghost" size="sm" :disabled="preventClose" class="ocp-dialog-close" aria-label="关闭">关闭</Button></DialogClose></header>
    <template v-else><DialogTitle class="ocp:sr-only">{{title}}</DialogTitle><DialogDescription v-if="description" class="ocp:sr-only">{{description}}</DialogDescription></template>
    <div class="ocp-dialog-body" :data-padding="bodyPadding" :data-scroll="bodyScroll"><slot /></div>
    <footer v-if="$slots.footer" class="ocp-dialog-footer"><slot name="footer"/></footer>
   </DialogContent>
  </DialogPortal>
 </DialogRoot>
</template>

<style>
[data-ocp-overlay] [data-ocp-modal][data-dialog-size]{--ocp-dialog-width:560px;width:min(var(--ocp-dialog-width),calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:min(88dvh,calc(100dvh - 48px));min-width:0;display:flex;flex-direction:column;padding:0;overflow:hidden;overflow-wrap:anywhere;overscroll-behavior:contain;}
[data-ocp-overlay] [data-ocp-modal][data-dialog-size=confirm]{--ocp-dialog-width:440px;}
[data-ocp-overlay] [data-ocp-modal][data-dialog-size=filter]{--ocp-dialog-width:520px;}
[data-ocp-overlay] [data-ocp-modal][data-dialog-size=detail]{--ocp-dialog-width:760px;}
[data-ocp-overlay] [data-ocp-modal][data-dialog-size=wide]{--ocp-dialog-width:1000px;}
[data-ocp-overlay] [data-ocp-modal][data-dialog-size=reader]{--ocp-dialog-width:1120px;height:min(800px,calc(100dvh - 48px));}
[data-ocp-overlay] .ocp-dialog-header{display:flex;flex:none;align-items:flex-start;justify-content:space-between;gap:16px;padding:24px 24px 16px;}
[data-ocp-overlay] .ocp-dialog-header>div{min-width:0;}
[data-ocp-overlay] .ocp-dialog-header h2{margin:0;line-height:1.4;}
[data-ocp-overlay] .ocp-dialog-header p{margin:8px 0 0;line-height:1.6;}
[data-ocp-overlay] .ocp-dialog-close{flex:none;}
[data-ocp-overlay] .ocp-dialog-body{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;padding:0 24px 24px;}
[data-ocp-overlay] .ocp-dialog-body[data-padding=false]{padding:0;}
[data-ocp-overlay] .ocp-dialog-body[data-scroll=false]{overflow:hidden;display:flex;flex-direction:column;}
[data-ocp-overlay] .ocp-dialog-footer{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 24px;border-top:1px solid var(--ocp-border);background:var(--ocp-background);}
[data-ocp-overlay] .ocp-dialog-footer>.ocp-dialog-actions{display:contents;}
[data-ocp-overlay] .ocp-dialog-footer .ar-people-form-actions,[data-ocp-overlay] .ocp-dialog-footer .cq-delete-actions{display:flex;justify-content:flex-end;gap:8px;margin:0;padding:0;border:0;}
@media(max-width:480px){[data-ocp-overlay] .ocp-dialog-header{padding:18px 16px 14px;}[data-ocp-overlay] .ocp-dialog-body:not([data-padding=false]){padding:0 16px 16px;}[data-ocp-overlay] .ocp-dialog-footer{padding:12px 16px;flex-wrap:wrap;}}
@media(max-width:480px){[data-ocp-overlay] [data-ocp-modal][data-dialog-size]{max-height:calc(100dvh - 32px);}}
@media(max-height:500px){[data-ocp-overlay] [data-ocp-modal][data-dialog-size]{max-height:calc(100dvh - 24px);}}
</style>
