<script setup lang="ts">
import {ref} from 'vue';
import Dialog from './Dialog.vue';
import {Button} from './button';
withDefaults(defineProps<{count?:number;title?:string;disabled?:boolean;sessionScoped?:boolean}>(),{count:0,title:'高级筛选',sessionScoped:true});
const emit=defineEmits<{open:[];apply:[];reset:[]}>(),open=ref(false);
function launch(){emit('open');open.value=true;}
function apply(){emit('apply');open.value=false;}
</script>
<template>
 <Button variant="outline" :disabled="disabled" aria-haspopup="dialog" :aria-label="title" @click="launch">{{title}}<span v-if="count" class="ocp:rounded-full ocp:bg-secondary ocp:px-2 ocp:text-xs">{{count}}</span></Button>
 <Dialog v-model:open="open" :title="title" :session-scoped="sessionScoped" description="设置更多条件，应用后更新列表。" :show-close="false" content-class="ocp-filter-dialog">
  <form @submit.prevent="apply"><div class="ocp-filter-fields"><slot/></div><footer class="ocp-dialog-actions"><Button variant="ghost" @click="emit('reset')">重置条件</Button><span class="ocp:flex-1"/><Button variant="outline" @click="open=false">取消</Button><Button type="submit" :disabled="disabled">应用筛选</Button></footer></form>
 </Dialog>
</template>
<style>
[data-ocp-overlay] .ocp-filter-dialog{width:min(520px,calc(100vw - 32px));max-width:520px;}
[data-ocp-overlay] .ocp-filter-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 16px;padding:24px 0;}
[data-ocp-overlay] .ocp-filter-fields:has(>label:only-child){grid-template-columns:1fr;}
[data-ocp-overlay] .ocp-filter-fields label{display:grid;align-content:start;gap:7px;font-size:13px;min-width:0;}
[data-ocp-overlay] .ocp-filter-fields [data-slot=native-select-wrapper]{width:100%;}
[data-ocp-overlay] .ocp-filter-fields input,[data-ocp-overlay] .ocp-filter-fields select{width:100%;min-width:0;}
[data-ocp-overlay] .ocp-dialog-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid var(--ocp-border);padding-top:18px;margin-top:8px;}
@media(max-width:420px){[data-ocp-overlay] .ocp-filter-fields{grid-template-columns:1fr;gap:14px;}}
</style>
