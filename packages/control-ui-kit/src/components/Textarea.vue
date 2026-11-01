<script setup lang="ts">
import {computed,ref,type HTMLAttributes} from 'vue';
import {cn} from '../utils';
const props=defineProps<{modelValue?:string;defaultValue?:string;class?:HTMLAttributes['class']}>();
const emit=defineEmits<{'update:modelValue':[value:string]}>(),local=ref(props.defaultValue??'');
const value=computed({get:()=>props.modelValue??local.value,set:(v:string)=>{local.value=v;emit('update:modelValue',v);}});
</script>
<template><textarea v-model="value" data-slot="textarea" :class="cn('ocp:min-h-20 ocp:w-full ocp:min-w-0 ocp:rounded-md ocp:border ocp:border-input ocp:bg-transparent ocp:px-3 ocp:py-2 ocp:text-sm ocp:shadow-xs ocp:outline-none ocp:focus-visible:border-ring ocp:focus-visible:ring-ring/50 ocp:focus-visible:ring-3 ocp:disabled:cursor-not-allowed ocp:disabled:opacity-50 ocp:aria-invalid:border-destructive',props.class)" /></template>
