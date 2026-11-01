<script setup lang="ts">
import type {HTMLAttributes} from 'vue';
import {Empty,EmptyHeader,EmptyTitle,EmptyDescription,EmptyContent,EmptyMedia} from './empty';
import {cn} from '../utils';
const props=defineProps<{title:string;description?:string;compact?:boolean;class?:HTMLAttributes['class']}>();
</script>
<template>
 <Empty :data-compact="compact||undefined" :class="cn('ocp:empty-state',props.class)" role="status"><EmptyHeader><EmptyMedia v-if="$slots.icon" variant="icon"><slot name="icon" /></EmptyMedia><EmptyTitle>{{title}}</EmptyTitle><EmptyDescription v-if="description">{{description}}</EmptyDescription></EmptyHeader><EmptyContent v-if="$slots.default"><slot /></EmptyContent></Empty>
</template>
