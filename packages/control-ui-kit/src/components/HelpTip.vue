<script setup lang="ts">
import {ref} from 'vue';
import Popover from './Popover.vue';
import {Button} from './button';
defineProps<{title:string}>();
const open=ref(false);
</script>
<template><Popover v-model:open="open" :label="title"><template #trigger><Button variant="ghost" size="sm" :aria-label="title" class="ocp:text-muted-foreground">使用说明</Button></template><div class="ocp:grid ocp:gap-2 ocp:text-sm ocp:leading-relaxed"><strong>{{title}}</strong><slot/></div></Popover></template>
