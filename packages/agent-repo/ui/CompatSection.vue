<script setup lang="ts">
// Temporary migration boundary. Remove when Projects and Entities become SFCs.
import {ref,onMounted,onBeforeUnmount,watch} from 'vue';
import type {ControlUiView,ControlUiViewContext} from 'openclaw/plugin-sdk/control-ui';
const props=defineProps<{mount:ControlUiView;context:ControlUiViewContext}>();
const root=ref<HTMLElement>();let view:ReturnType<ControlUiView>;
onMounted(()=>{view=props.mount(root.value!,props.context);});
watch(()=>props.context,next=>view?.update?.(next));
onBeforeUnmount(()=>view?.dispose?.());
</script>
<template><div ref="root" class="ocp:min-w-0" /></template>
