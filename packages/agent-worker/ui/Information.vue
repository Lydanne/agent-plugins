<script setup lang="ts">
defineProps<{fields:[string,unknown][]}>();
</script>
<template><dl class="cq-information"><template v-for="[label,value] in fields" :key="label"><template v-if="value!==undefined&&value!==null&&value!==''"><dt>{{label}}</dt><dd :class="{'cq-identifier':['任务标识','会话标识'].includes(label)}">{{value}}</dd></template></template></dl></template>
