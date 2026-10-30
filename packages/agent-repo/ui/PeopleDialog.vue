<script setup lang="ts">
import {ref,computed} from 'vue';
import {Dialog,useHostContext} from '@openclaw-plugins/control-ui-kit';
import PeopleManager from './PeopleManager.vue';
const props=defineProps<{options:{invoke:<T>(action:string,payload:Record<string,unknown>)=>Promise<T>;canWrite:()=>boolean;safe:(value:unknown)=>string;isGroup?:()=>boolean;onClose?:()=>void;inline?:boolean;filters?:()=>Record<string,string>;onLoaded?:(page:unknown)=>void}}>();
const context=useHostContext(),open=ref(true),busy=ref(false),manager=ref<InstanceType<typeof PeopleManager>>();
const canWrite=computed(()=>context.value.host.connection.canWrite&&props.options.canWrite());
function close(){open.value=false;props.options.onClose?.();}
defineExpose({refresh:()=>manager.value?.refresh()});
</script>
<template><PeopleManager v-if="options.inline" ref="manager" inline :invoke="options.invoke" :can-write="!!canWrite" :safe="options.safe" :is-group="options.isGroup?.()" :filters="options.filters?.()" @loaded="options.onLoaded?.($event)"/><Dialog size="wide" v-else :open="open" title="人员资料管理" :prevent-close="busy" @escape="manager?.escape($event)" @update:open="close"><PeopleManager ref="manager" hide-close @busy="busy=$event" :invoke="options.invoke" :can-write="!!canWrite" :safe="options.safe" :is-group="options.isGroup?.()" @close="close" @loaded="options.onLoaded?.($event)"/></Dialog></template>
