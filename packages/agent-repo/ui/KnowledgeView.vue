<script setup lang="ts">
import {ref,onMounted,watch} from 'vue';
import {Button,useHostContext} from '@openclaw-plugins/control-ui-kit';
import {useManagementRequest} from './management-request';
import type {KnowledgeCatalog,KnowledgePage,KnowledgeDocument,KnowledgeValidation} from './knowledge-model';
const props=defineProps<{agentId:string}>(),context=useHostContext(),request=useManagementRequest(context,()=>props.agentId);
const projects=ref<KnowledgeCatalog['projects']>([]),projectId=ref(''),input=ref(''),query=ref(''),page=ref<KnowledgePage>(),document=ref<KnowledgeDocument>(),validation=ref<KnowledgeValidation>();
const catalogLoading=ref(false),loading=ref(false),reading=ref(false),validating=ref(false),catalogError=ref(''),listError=ref(''),readError=ref(''),validationError=ref(''),selected=ref('');
let listEpoch=0,readEpoch=0,validationEpoch=0,catalogEpoch=0;
const safe=(value:unknown)=>context.value.host.redact(String(value??''));
function clearDetail(){readEpoch++;selected.value='';document.value=undefined;readError.value='';reading.value=false;}
async function catalog(){
 const token=++catalogEpoch,valid=request.capture();catalogLoading.value=true;catalogError.value='';
 try{const result=await request.invoke<KnowledgeCatalog>('knowledgeCatalog',{});if(!valid()||token!==catalogEpoch)return;projects.value=result.projects;if(!projects.value.some(p=>p.projectId===projectId.value))projectId.value=projects.value.length===1?projects.value[0]!.projectId:'';}
 catch{if(valid()&&token===catalogEpoch)catalogError.value='项目清单读取失败，请重试。';}
 finally{if(valid()&&token===catalogEpoch)catalogLoading.value=false;}
}
async function load(offset=0){
 const token=++listEpoch,valid=request.capture();clearDetail();page.value=undefined;listError.value='';loading.value=!!projectId.value;if(!projectId.value)return;
 try{const result=await request.invoke<KnowledgePage>(query.value?'knowledgeSearch':'knowledgeList',{projectId:projectId.value,limit:20,offset,...(query.value?{query:query.value}:{})});if(valid()&&token===listEpoch)page.value=result;}
 catch{if(valid()&&token===listEpoch)listError.value='知识库读取失败，请核对项目配置与目录权限后重试。';}
 finally{if(valid()&&token===listEpoch)loading.value=false;}
}
function search(){query.value=input.value.trim();void load();}
async function read(path:string,append=false){
 const token=++readEpoch,valid=request.capture(),previous=append?document.value:undefined;selected.value=path;readError.value='';reading.value=true;if(!append)document.value=undefined;
 try{
  const result=await request.invoke<KnowledgeDocument>('knowledgeRead',{projectId:projectId.value,path,startLine:previous?.nextLine??1,maxLines:100});
  if(!valid()||token!==readEpoch)return;
  if(!result.found){document.value=undefined;readError.value='条目已不存在，请刷新列表。';return;}
  if(previous&&result.sha256!==previous.sha256){readError.value='条目已更新，请重新读取正文。';return;}
  document.value=previous?{...result,startLine:previous.startLine,content:previous.content+'\n'+result.content,lineTruncated:previous.lineTruncated||result.lineTruncated}:result;
 }catch{if(valid()&&token===readEpoch)readError.value='正文读取失败，请重试。';}
 finally{if(valid()&&token===readEpoch)reading.value=false;}
}
async function validate(){
 const token=++validationEpoch,valid=request.capture();validating.value=true;validation.value=undefined;validationError.value='';
 try{const result=await request.invoke<KnowledgeValidation>('knowledgeValidate',{projectId:projectId.value});if(valid()&&token===validationEpoch)validation.value=result;}
 catch{if(valid()&&token===validationEpoch)validationError.value='结构校验失败，请重试。';}
 finally{if(valid()&&token===validationEpoch)validating.value=false;}
}
watch(projectId,()=>{input.value='';query.value='';validationEpoch++;validation.value=undefined;validationError.value='';validating.value=false;void load();});
onMounted(catalog);
</script>
<template>
 <section class="ar-knowledge" aria-label="项目知识库">
  <header class="ar-section-heading"><div><h2>知识库</h2><p class="ar-description">浏览项目文档，搜索知识条目并查看正文。</p></div><Button variant="outline" :disabled="catalogLoading||loading" @click="catalog(); projectId && load()">刷新知识库</Button></header>
  <p v-if="catalogError" role="alert">{{catalogError}}</p>
  <div class="kb-controls"><label>项目<select v-model="projectId" aria-label="知识库项目" :disabled="catalogLoading"><option value="">{{catalogLoading?'正在读取项目…':'请选择项目'}}</option><option v-for="p in projects" :key="p.projectId" :value="p.projectId">{{safe(p.name)}} · {{safe(p.projectId)}}</option></select></label><form @submit.prevent="search"><label class="kb-search">搜索<input v-model="input" aria-label="搜索知识库" placeholder="标题、UID 或正文关键词" maxlength="320" :disabled="!projectId" /></label><Button type="submit" :disabled="!projectId||loading">搜索</Button></form><Button variant="outline" :disabled="!projectId||validating||!page?.available" @click="validate">{{validating?'正在校验…':'校验结构'}}</Button></div>
  <p v-if="!catalogLoading&&!catalogError&&!projects.length">当前 Agent 尚未登记项目。</p><p v-else-if="!projectId&&!catalogLoading">请选择要查看的项目。</p>
  <p v-if="listError" role="alert">{{listError}} <Button variant="ghost" @click="load()">重试列表</Button></p>
  <p v-if="loading" role="status">正在读取知识条目…</p>
  <template v-if="page">
   <p class="ar-meta kb-location">{{safe(page.knowledgePath)}} · {{page.normalized?'规范化知识库':'普通 wiki'}} · {{safe(page.metadataNamespace)}}</p>
   <p v-if="!page.available" role="status">项目尚无知识库目录，请添加 wiki 目录或配置知识库路径。</p>
   <template v-else>
    <p v-if="!page.complete" role="status">扫描未完成，以下结果可能不完整。请检查目录权限、链接与文件大小。</p>
    <div class="kb-workspace"><section class="kb-results" aria-label="知识条目"><p class="ar-meta" role="status">{{query?'搜索结果':'全部条目'}} · {{page.total}} 条</p><p v-if="!page.entries.length">{{query?'没有找到匹配条目，请尝试其他关键词。':'知识库暂无 Markdown 条目。'}}</p><button v-for="entry in page.entries" :key="entry.path" type="button" class="kb-entry" :aria-pressed="selected===entry.path" @click="read(entry.path)"><strong>{{safe(entry.title)}}</strong><span>{{safe(entry.path)}}</span><small v-if="entry.uid||entry.status">{{safe(entry.uid)}} {{safe(entry.status)}}</small><p>{{safe(entry.excerpt)}}</p></button><div class="kb-pagination"><Button variant="outline" :disabled="page.offset===0||loading" @click="load(Math.max(0,page.offset-20))">上一页</Button><span>{{page.total? page.offset+1:0}}–{{page.offset+page.entries.length}}</span><Button variant="outline" :disabled="page.nextOffset===null||loading" @click="load(page.nextOffset!)">下一页</Button></div></section>
    <section class="kb-reader" aria-label="知识正文" :aria-busy="reading"><p v-if="!selected">选择左侧条目查看正文。</p><p v-if="readError" role="alert">{{readError}} <Button variant="ghost" @click="read(selected)">重新读取正文</Button></p><template v-if="document"><h3>{{safe(document.entry.title)}}</h3><p class="ar-meta">{{safe(document.entry.path)}} <span v-if="document.entry.uid">· {{safe(document.entry.uid)}}</span></p><p class="ar-meta">Markdown 正文 · 第 {{document.startLine}}–{{document.endLine}} 行 / 共 {{document.totalLines}} 行</p><pre tabindex="0" aria-label="Markdown 正文">{{safe(document.content)}}</pre><p v-if="document.lineTruncated" role="status">部分超长行已截断，请在仓库中查看完整原文。</p><Button v-if="document.nextLine" variant="outline" :disabled="reading" @click="read(selected,true)">加载后续内容</Button></template><p v-if="reading" role="status">正在读取正文…</p></section></div>
   </template>
  </template>
  <p v-if="validationError" role="alert">{{validationError}}</p><section v-if="validation" class="kb-validation" aria-label="知识库结构校验"><h3>结构校验</h3><p role="status">{{!validation.available?'知识库目录不存在':validation.valid===null?'校验不完整':validation.valid?'结构校验通过':'存在结构问题'}} · {{validation.errors?.length??0}} 项错误 / {{validation.warnings?.length??0}} 项提醒</p><p class="ar-description">检查本地文档结构与引用，不代表内容事实或远程链接已核验。</p><ul><li v-for="(issue,i) in [...(validation.errors??[]),...(validation.warnings??[])]" :key="i">{{safe(issue.path)}} · {{safe(issue.code)}}</li></ul></section>
 </section>
</template>
<style scoped>
.ar-knowledge{min-width:0}.kb-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:20px 0}.kb-controls label{display:flex;flex-direction:column;gap:6px;font-size:13px}.kb-controls select,.kb-controls input{font:inherit;color:inherit;background:var(--card,transparent);border:1px solid var(--border,#8885);border-radius:7px;padding:9px 12px;min-height:38px}.kb-controls select{max-width:100%}.kb-controls form{display:flex;align-items:end;gap:8px;flex:1;min-width:240px}.kb-search{flex:1}.kb-workspace{display:grid;grid-template-columns:minmax(240px,32%) minmax(0,1fr);gap:20px}.kb-results,.kb-reader,.kb-validation{border:1px solid var(--border,#8885);border-radius:10px;padding:16px;min-width:0}.kb-entry{display:block;text-align:left;width:100%;padding:14px 10px;border:0;border-bottom:1px solid var(--border,#8885);background:transparent;color:inherit;cursor:pointer;overflow-wrap:anywhere}.kb-entry:hover,.kb-entry[aria-pressed=true]{background:var(--muted,#8882)}.kb-entry strong,.kb-entry span,.kb-entry small{display:block}.kb-entry span,.kb-entry small,.kb-entry p{font-size:12px;opacity:.75;margin:5px 0}.kb-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:16px;font-size:12px}.kb-reader h3{margin-top:0}.kb-reader pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.8;max-height:65vh;overflow:auto;padding:14px;background:var(--muted,#8881);border-radius:6px}.kb-location,.kb-reader p,.kb-validation li{overflow-wrap:anywhere}.kb-validation{margin-top:20px}.kb-validation ul{max-height:250px;overflow:auto}@media(max-width:760px){.kb-workspace{grid-template-columns:1fr}.kb-controls>label{width:100%}.kb-controls form{min-width:0;width:100%}.kb-results{max-height:420px;overflow:auto}}
</style>
