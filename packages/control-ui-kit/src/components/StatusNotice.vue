<script setup lang="ts">
import type {HTMLAttributes} from 'vue';
import {Alert,AlertTitle,AlertDescription} from './alert';
import {cn} from '../utils';
const props=withDefaults(defineProps<{title?:string;tone?:'info'|'warning'|'error';class?:HTMLAttributes['class']}>(),{tone:'info'});
</script>
<template>
 <Alert :class="cn('ocp:status-notice',props.class)" :variant="tone==='error'?'destructive':'default'" :data-tone="tone" :role="tone==='error'?'alert':'status'"><AlertTitle v-if="title">{{title}}</AlertTitle><AlertDescription><slot /></AlertDescription><div v-if="$slots.actions" data-slot="notice-actions"><slot name="actions" /></div></Alert>
</template>
