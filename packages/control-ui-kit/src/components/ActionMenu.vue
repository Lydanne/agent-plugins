<script setup lang="ts">
import {DropdownMenuRoot,DropdownMenuTrigger,DropdownMenuPortal,DropdownMenuContent,DropdownMenuItem} from 'reka-ui';
import {Button} from './button';
import {useOverlayTarget} from '../host';
defineProps<{open:boolean;label:string;items:{id:string;label:string;disabled?:boolean;destructive?:boolean;title?:string;class?:string}[]}>();
const emit=defineEmits<{'update:open':[value:boolean];select:[id:string]}>();
const target=useOverlayTarget();
</script>
<template><span><DropdownMenuRoot :open="open" @update:open="emit('update:open',$event)"><DropdownMenuTrigger as-child><Button variant="ghost" size="icon-xs" :aria-label="label" title="更多"><slot><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle v-for="x in [4,10,16]" :key="x" :cx="x" cy="10" r="1.5" fill="currentColor"/></svg></slot></Button></DropdownMenuTrigger><DropdownMenuPortal :to="target"><DropdownMenuContent data-slot="action-menu-content" align="end" :side-offset="4" :collision-padding="8" class="ocp:z-50 ocp:min-w-32 ocp:rounded-md ocp:border ocp:bg-background ocp:p-1 ocp:shadow-md"><DropdownMenuItem v-for="item in items" :key="item.id" as-child :disabled="item.disabled" @select="emit('select',item.id)"><Button variant="ghost" size="sm" :class="[item.class,{'ocp:text-destructive':item.destructive}]" :disabled="item.disabled" :title="item.title" :aria-label="item.label" class="ocp:flex ocp:w-full ocp:justify-start ocp:whitespace-nowrap ocp:data-[highlighted]:bg-accent">{{item.label}}</Button></DropdownMenuItem></DropdownMenuContent></DropdownMenuPortal></DropdownMenuRoot></span></template>
