<script setup lang="ts">
defineProps<{entries:[string,unknown][];safe:(v:unknown)=>string}>();
</script>
<template><dl class="ar-maintenance-fields"><template v-for="([label,value],index) in entries" :key="index"><dt>{{label}}</dt><dd>{{safe(value??'未记录')}}</dd></template></dl></template>
