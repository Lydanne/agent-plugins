<script setup lang="ts">
import {useRepositoryPaths} from '@openclaw-plugins/control-ui-kit';
const paths=useRepositoryPaths();
defineProps<{entries:[string,unknown][];safe:(v:unknown)=>string}>();
</script>
<template><dl class="ar-maintenance-fields"><template v-for="([label,value],index) in entries" :key="index"><dt>{{label}}</dt><dd>{{safe(typeof value==='string'?paths.display(value):value??'未记录')}}</dd></template></dl></template>
