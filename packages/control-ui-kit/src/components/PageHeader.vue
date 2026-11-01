<script setup lang="ts">
import {ref,type HTMLAttributes} from 'vue';
import {cn} from '../utils';
const props=withDefaults(defineProps<{title?:string;description?:string;heading?:'h1'|'h2'|'h3';compact?:boolean;class?:HTMLAttributes['class']}>(),{heading:'h2'});
const titleElement=ref<HTMLElement>();
defineExpose({focus:(options?:FocusOptions)=>titleElement.value?.focus(options)});
</script>
<template>
 <header data-slot="page-header" :class="cn('ocp:page-header',props.class)" :data-compact="compact||undefined">
  <div data-slot="page-heading"><slot name="leading" /><div v-if="title||description||$slots.description"><component :is="heading" v-if="title" ref="titleElement" tabindex="-1" data-slot="page-title">{{title}}</component><p v-if="description" data-slot="page-description">{{description}}</p><slot name="description" /></div></div>
  <div v-if="$slots.default" data-slot="page-actions"><slot /></div>
 </header>
</template>
