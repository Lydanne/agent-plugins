<script setup lang="ts">
import {onMounted,onBeforeUnmount,provide,ref} from 'vue';
import {overlayKey} from '../host';
const host=ref<HTMLElement>();
const target=document.createElement('div');target.dataset.ocpUi='';target.dataset.ocpOverlay='';
provide(overlayKey,target);
onMounted(()=>host.value?.append(target));onBeforeUnmount(()=>target.remove());
</script>
<template><div ref="host" class="ocp-overlay-scope"><slot/></div></template>
<style scoped>.ocp-overlay-scope{min-width:0;height:100%;position:relative}</style>
