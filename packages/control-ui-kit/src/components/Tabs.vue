<script setup lang="ts">
import {TabsRoot,TabsList,TabsTrigger,TabsContent} from 'reka-ui';
import {Button} from './button';
defineProps<{modelValue:string;items:{id:string;label:string}[];label:string;listClass?:string;activationMode?:'manual'|'automatic'}>();
const emit=defineEmits<{'update:modelValue':[value:string]}>();
</script>
<template><TabsRoot :model-value="modelValue" :activation-mode="activationMode" class="ocp:flex ocp:min-h-0 ocp:flex-1 ocp:flex-col" @update:model-value="emit('update:modelValue',String($event))"><TabsList as="nav" :aria-label="label" :class="listClass" class="ocp:flex ocp:shrink-0 ocp:gap-1"><TabsTrigger v-for="item in items" :key="item.id" :value="item.id" as-child><Button variant="ghost" :data-tab-key="item.id" @click="emit('update:modelValue',item.id)" :class="{'ocp:bg-accent':modelValue===item.id}" class="ocp:data-[state=active]:text-primary">{{item.label}}</Button></TabsTrigger></TabsList><TabsContent :key="modelValue" :value="modelValue" class="ocp:flex ocp:min-h-0 ocp:flex-1 ocp:flex-col ocp:outline-none"><slot/></TabsContent></TabsRoot></template>
