<script setup lang="ts">
import {computed,ref} from 'vue';
import {Button} from '@openclaw-plugins/control-ui-kit';
const props=withDefaults(defineProps<{title:string;value:unknown;redact:(value:string)=>string;initialOpen?:boolean}>(),{initialOpen:false});
const root=ref<HTMLElement>(),open=ref(props.initialOpen),activated=ref(props.initialOpen),nowrap=ref(false),feedback=ref('');
const isText=computed(()=>typeof props.value==='string');
const text=computed(()=>props.redact(isText.value?props.value as string:JSON.stringify(props.value,null,2)??''));
const lines=computed(()=>text.value.split('\n'));
function toggle(event:Event){open.value=(event.target as HTMLDetailsElement).open;if(open.value)activated.value=true;}
function tokens(line:string):{text:string;kind?:string}[]{
 if(isText.value)return [{text:line||' '}];
 const result:{text:string;kind?:string}[]=[];let offset=0;
 for(const token of line.matchAll(/"(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)){
  if(token.index!>offset)result.push({text:line.slice(offset,token.index)});
  result.push({text:token[0],kind:token[0].endsWith(':')?'key':token[0].startsWith('"')?'string':'literal'});offset=token.index!+token[0].length;
 }
 if(offset<line.length||!line.length)result.push({text:line.slice(offset)||' '});return result;
}
async function copy(){try{await root.value!.ownerDocument.defaultView!.navigator.clipboard.writeText(text.value);feedback.value='已复制';}catch{feedback.value='复制失败，请选择文本复制';}}
</script>
<template>
 <details ref="root" class="cq-disclosure cq-source-section" :open="open" :data-fold-key="title" @toggle="toggle">
  <summary>{{title}} · {{lines.length}} 行</summary>
  <div class="cq-source cq-disclosure-body"><div class="cq-source-toolbar"><span class="cq-source-kind">{{isText?'TEXT':'JSON'}}</span><Button variant="ghost" size="xs" :aria-pressed="nowrap" @click="nowrap=!nowrap">{{nowrap?'自动换行':'不换行'}}</Button><Button variant="ghost" size="xs" @click="copy">复制</Button></div><span class="cq-source-feedback" role="status">{{feedback}}</span>
   <pre class="cq-source-code" :class="{'cq-nowrap':nowrap}" tabindex="0" :aria-label="title+'源码'"><template v-if="activated"><span v-for="(line,index) in lines" :key="index" class="cq-source-line"><span class="cq-line-number" aria-hidden="true">{{index+1}}</span><code class="cq-line-content"><template v-for="(token,i) in tokens(line)" :key="i"><span v-if="token.kind" :class="'cq-token-'+token.kind">{{token.text}}</span><template v-else>{{token.text}}</template></template></code></span></template></pre>
  </div>
 </details>
</template>
