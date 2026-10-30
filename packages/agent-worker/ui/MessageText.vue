<script setup lang="ts">
import {computed} from 'vue';
import SourceView from './SourceView.vue';
const props=defineProps<{text:string}>();
const identity=(value:string)=>value;
const blocks=computed(()=>{
 const values:{kind:'text'|'code';text:string;language?:string}[]=[];let offset=0;
 for(const match of props.text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)){
  if(match.index!>offset)values.push({kind:'text',text:props.text.slice(offset,match.index)});
  values.push({kind:'code',language:match[1]!.trim(),text:match[2]!.replace(/\n$/,'')});offset=match.index!+match[0].length;
 }
 if(offset<props.text.length||!values.length)values.push({kind:'text',text:props.text.slice(offset)});return values;
});
function inline(text:string){
 const result:{text:string;kind?:string}[]=[];let offset=0;
 for(const match of text.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g)){
  if(match.index!>offset)result.push({text:text.slice(offset,match.index)});
  result.push({text:match[1]??match[2]!,kind:match[1]?'strong':'code'});offset=match.index!+match[0].length;
 }
 if(offset<text.length)result.push({text:text.slice(offset)});return result;
}
</script>
<template>
 <div class="cq-message-text"><template v-for="(block,index) in blocks" :key="index"><SourceView v-if="block.kind==='code'" :title="'代码'+(block.language?' · '+block.language:'')" :value="block.text" :redact="identity" /><template v-else><p v-for="(paragraph,i) in block.text.split(/\n\s*\n/)" :key="i"><template v-for="(token,n) in inline(paragraph)" :key="n"><strong v-if="token.kind==='strong'">{{token.text}}</strong><code v-else-if="token.kind==='code'">{{token.text}}</code><template v-else>{{token.text}}</template></template></p></template></template></div>
</template>
