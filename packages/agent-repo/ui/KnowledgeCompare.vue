<script setup lang="ts">
import {Dialog,useHostContext} from '@openclaw-plugins/control-ui-kit';
defineProps<{open:boolean;before:string;after:string}>();const emit=defineEmits<{close:[]}>(),context=useHostContext();
</script>
<template><Dialog :open="open" :session-scoped="false" title="知识版本对比" size="detail" @update:open="!$event&&emit('close')"><div class="kb-diff"><div><h3>变更前</h3><pre>{{context.host.redact(before)}}</pre></div><div><h3>变更后</h3><pre>{{context.host.redact(after)}}</pre></div></div></Dialog></template>
<style scoped>.kb-diff{display:grid;grid-template-columns:1fr 1fr;gap:16px}.kb-diff pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:65vh;overflow:auto}@media(max-width:600px){.kb-diff{grid-template-columns:1fr}}</style>
