<script setup lang="ts">
import {computed,ref,useId,nextTick,type HTMLAttributes} from 'vue';
import {Button} from './button';
import Input from './input/Input.vue';
import {cn} from '../utils';
defineOptions({inheritAttrs:false});
const props=withDefaults(defineProps<{modelValue:string;label?:string;hideLabel?:boolean;placeholder?:string;disabled?:boolean;busy?:boolean;submitLabel?:string;clearLabel?:string;class?:HTMLAttributes['class']}>(),{label:'搜索',submitLabel:'搜索',clearLabel:'清空搜索'});
const emit=defineEmits<{'update:modelValue':[value:string];search:[value:string]}>(),id=useId(),composing=ref(false),form=ref<HTMLFormElement>();
const value=computed({get:()=>props.modelValue,set:(v:string|number)=>emit('update:modelValue',String(v))});
function submit(){if(props.disabled||props.busy||composing.value)return;const query=form.value?.querySelector('input')?.value??props.modelValue;emit('update:modelValue',query);emit('search',query.trim());}
function clear(){if(props.disabled||props.busy||composing.value||!props.modelValue)return;emit('update:modelValue','');emit('search','');void nextTick(()=>form.value?.querySelector('input')?.focus());}
</script>
<template>
 <form ref="form" role="search" data-slot="search-field" :class="cn('ocp:search-field',props.class)" :aria-label="label" @submit.prevent="submit">
  <label :for="id" :class="hideLabel?'ocp:sr-only':undefined">{{label}}</label>
  <div data-slot="search-controls"><div data-slot="search-input-wrapper"><Input :id="id" v-model="value" v-bind="$attrs" type="search" :placeholder="placeholder" :disabled="disabled" autocomplete="off" @compositionstart="composing=true" @compositionend="composing=false" @keydown.esc.prevent="clear" /><Button v-if="modelValue" type="button" variant="ghost" size="icon-sm" :aria-label="clearLabel" :disabled="disabled||busy" @click="clear"><span aria-hidden="true">×</span></Button></div><Button type="submit" :disabled="disabled||busy">{{submitLabel}}</Button></div>
 </form>
</template>
