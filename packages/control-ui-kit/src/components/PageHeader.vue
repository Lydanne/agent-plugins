<script setup lang="ts">
import type {HTMLAttributes} from 'vue';
import {cn} from '../utils';
const props=defineProps<{title:string;description?:string;class?:HTMLAttributes['class']}>();
</script>
<template>
 <header data-slot="page-header" :class="cn('ocp:page-header',props.class)">
  <div><h2>{{title}}</h2><p v-if="description" data-slot="page-description">{{description}}</p><slot name="description" /></div>
  <div v-if="$slots.default" data-slot="page-actions"><slot /></div>
 </header>
</template>
