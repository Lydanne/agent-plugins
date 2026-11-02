<script setup lang="ts">
import {computed,h,nextTick,ref,useId,watch} from 'vue';
import {Button,StatusNotice} from '@openclaw-plugins/control-ui-kit';
import {headingSlug,parseKnowledgeMarkdown,renderKnowledgeTokens,type KnowledgeLink} from './knowledge-markdown';
const props=withDefaults(defineProps<{content:string;path:string;partial:boolean;fragment:string;navigationId:number;focusOnLoad?:boolean}>(),{focusOnLoad:true});
const emit=defineEmits<{navigate:[link:KnowledgeLink]}>();
const parsed=computed(()=>parseKnowledgeMarkdown(props.content)),source=ref(false),root=ref<HTMLElement>(),notice=ref('');
const prefix='kb-'+useId().replace(/[^a-z0-9-]/gi,'')+'-';
const MarkdownBody=()=>h('article',{class:'kb-markdown',tabindex:-1,'aria-label':'Markdown 正文'},renderKnowledgeTokens(parsed.value.tokens,{path:props.path,prefix,navigate}));
function scroll(fragment:string){
 const slug=fragment?parsed.value.headings.find(item=>item.slug===fragment)?.slug??parsed.value.headings.find(item=>item.slug===headingSlug(fragment))?.slug:parsed.value.headings[0]?.slug;
 const target=fragment?Array.from(root.value?.querySelectorAll<HTMLElement>('[data-kb-heading]')??[]).find(el=>el.dataset.kbHeading===slug):root.value;
 if(!target){notice.value=props.partial?'目标标题尚未加载，请加载后续内容。':'未找到链接指向的标题。';return false;}
 notice.value='';target.scrollIntoView?.({block:'start',behavior:'smooth'});target.focus({preventScroll:true});return true;
}
function navigate(link:KnowledgeLink){
 if(link.kind==='anchor'){source.value=false;void nextTick(()=>jump(link.fragment));}
 else if(link.kind==='blocked')notice.value=link.reason;
 else emit('navigate',link);
}
let pendingFragment:string|undefined;
function jump(fragment:string){pendingFragment=!scroll(fragment)&&props.partial?fragment:undefined;}
watch(()=>[props.path,props.navigationId],async()=>{source.value=false;notice.value='';pendingFragment=undefined;await nextTick();if(props.focusOnLoad||props.fragment)jump(props.fragment);},{immediate:true});
watch(()=>props.content,async()=>{if(pendingFragment!==undefined&&!source.value){await nextTick();jump(pendingFragment);}});
</script>
<template>
 <div ref="root" class="kb-renderer" tabindex="-1">
  <div class="kb-reader-tools"><span>{{source?'Markdown 原文':'Markdown 预览'}}</span><Button variant="outline" size="sm" :aria-pressed="source" @click="source=!source">{{source?'查看预览':'查看原文'}}</Button></div>
  <StatusNotice v-if="notice" tone="warning" class="kb-link-notice">{{notice}}</StatusNotice>
  <pre v-if="source" class="kb-source" tabindex="0" aria-label="Markdown 原文">{{content}}</pre>
  <template v-else>
   <nav v-if="parsed.headings.length" class="kb-toc" aria-label="文档标题目录"><strong>目录</strong><small v-if="partial">随已加载正文更新</small><ol><li v-for="heading in parsed.headings" :key="heading.slug" :style="{paddingInlineStart:(heading.level-1)*12+'px'}"><a :href="'#'+prefix+heading.slug" @click.prevent="jump(heading.slug)">{{heading.text||'无标题'}}</a></li></ol></nav>
   <details v-if="parsed.frontmatter" class="kb-frontmatter"><summary>文档元数据</summary><pre>{{parsed.frontmatter}}</pre></details>
   <MarkdownBody />
  </template>
 </div>
</template>
<style scoped>
.kb-renderer{min-width:0}.kb-reader-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--ocp-muted);margin-bottom:16px}.kb-link-notice{margin-bottom:16px}.kb-toc{border:1px solid var(--ocp-border);border-radius:8px;background:var(--ocp-muted-background);padding:14px 16px;margin-bottom:24px;font-size:13px}.kb-toc strong{font-size:12px}.kb-toc small{margin-left:8px;color:var(--ocp-muted)}.kb-toc ol{list-style:none;padding:0;margin:10px 0 0;max-height:220px;overflow:auto}.kb-toc li{margin:6px 0;overflow-wrap:anywhere}.kb-toc a{color:var(--ocp-foreground);text-decoration:none}.kb-toc a:hover{text-decoration:underline}.kb-frontmatter{font-size:12px;margin:0 0 20px;color:var(--ocp-muted)}.kb-frontmatter summary{cursor:pointer}.kb-source,.kb-frontmatter pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:var(--ocp-muted-background);border-radius:8px;max-height:65vh;overflow:auto;line-height:1.8;color:var(--ocp-foreground)}
.kb-renderer :deep(.kb-markdown){font-size:14px;line-height:1.8;color:var(--ocp-foreground);overflow-wrap:anywhere}.kb-renderer :deep(.kb-markdown>*:first-child){margin-top:0}.kb-renderer :deep(.kb-markdown h1){font-size:26px}.kb-renderer :deep(.kb-markdown h2){font-size:22px;border-bottom:1px solid var(--ocp-border);padding-bottom:8px}.kb-renderer :deep(.kb-markdown h3){font-size:18px}.kb-renderer :deep(.kb-markdown h4),.kb-renderer :deep(.kb-markdown h5),.kb-renderer :deep(.kb-markdown h6){font-size:15px}.kb-renderer :deep(.kb-markdown :is(h1,h2,h3,h4,h5,h6)){line-height:1.5;margin:28px 0 12px;scroll-margin-top:24px}.kb-renderer :deep(.kb-markdown p){margin:12px 0}.kb-renderer :deep(.kb-markdown ul){list-style:disc;padding-left:24px}.kb-renderer :deep(.kb-markdown ol){list-style:decimal;padding-left:24px}.kb-renderer :deep(.kb-markdown li){margin:4px 0}.kb-renderer :deep(.kb-markdown a){color:var(--ocp-primary);text-decoration:underline;text-underline-offset:3px}.kb-renderer :deep(.kb-markdown a.kb-blocked-link){text-decoration-style:dashed}.kb-renderer :deep(.kb-markdown a:focus-visible),.kb-toc a:focus-visible{outline:2px solid var(--ocp-ring);outline-offset:3px}.kb-renderer :deep(.kb-markdown code){font-family:ui-monospace,monospace;font-size:.9em;background:var(--ocp-muted-background);border-radius:4px;padding:2px 5px}.kb-renderer :deep(.kb-markdown pre){white-space:pre;max-width:100%;overflow:auto;padding:16px;background:var(--ocp-muted-background);border:1px solid var(--ocp-border);border-radius:8px;font-size:13px}.kb-renderer :deep(.kb-markdown pre code){padding:0;background:transparent}.kb-renderer :deep(.kb-markdown blockquote){border-inline-start:3px solid var(--ocp-border);padding-inline-start:16px;margin:16px 0;color:var(--ocp-muted)}.kb-renderer :deep(.kb-markdown table){display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:16px 0;font-size:13px}.kb-renderer :deep(.kb-markdown :is(th,td)){border:1px solid var(--ocp-border);padding:8px 12px;min-width:80px}.kb-renderer :deep(.kb-markdown th){background:var(--ocp-muted-background);font-weight:600}.kb-renderer :deep(.kb-markdown hr){border:0;border-top:1px solid var(--ocp-border);margin:24px 0}.kb-renderer :deep(.kb-image){color:var(--ocp-muted);font-size:12px}
</style>
