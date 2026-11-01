<script setup lang="ts">
import {ref,onMounted,watch} from 'vue';
import {Button,PageHeader,SearchField,NativeSelect,Card,Badge,EmptyState,StatusNotice,useHostContext} from '@openclaw-plugins/control-ui-kit';
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
function search(value=input.value){query.value=value.trim();void load();}
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
  <PageHeader class="ar-section-heading" title="知识库" description="浏览项目文档，搜索知识条目并查看正文。"><Button variant="outline" :disabled="catalogLoading||loading" @click="catalog(); projectId && load()">刷新知识库</Button></PageHeader>
  <StatusNotice v-if="catalogError" tone="error">{{catalogError}}</StatusNotice>
  <div class="kb-controls">
   <label class="kb-project">项目<NativeSelect v-model="projectId" aria-label="知识库项目" :disabled="catalogLoading"><option value="">{{catalogLoading?'正在读取项目…':'请选择项目'}}</option><option v-for="p in projects" :key="p.projectId" :value="p.projectId">{{safe(p.name)}} · {{safe(p.projectId)}}</option></NativeSelect></label>
   <SearchField v-model="input" class="kb-search" aria-label="搜索知识库" placeholder="标题、UID 或正文关键词" maxlength="320" :disabled="!projectId" :busy="loading" @search="search" />
   <Button variant="outline" :disabled="!projectId||validating||!page?.available" @click="validate">{{validating?'正在校验…':'校验结构'}}</Button>
  </div>
  <EmptyState v-if="!catalogLoading&&!catalogError&&!projects.length" title="当前 Agent 尚未登记项目。" description="登记项目后可浏览项目的 wiki。" />
  <EmptyState v-else-if="!projectId&&!catalogLoading&&!catalogError" title="请选择要查看的项目。" description="每个项目的知识目录、搜索结果和正文独立读取。" />
  <StatusNotice v-if="listError" tone="error">{{listError}}<template #actions><Button variant="outline" @click="load()">重试列表</Button></template></StatusNotice>
  <p v-if="loading" role="status">正在读取知识条目…</p>
  <template v-if="page">
   <div class="kb-location"><span>{{safe(page.knowledgePath)}}</span><Badge variant="secondary">{{page.normalized?'规范化知识库':'普通 wiki'}}</Badge><Badge variant="outline">{{safe(page.metadataNamespace)}}</Badge></div>
   <EmptyState v-if="!page.available" title="项目尚无知识库目录" description="请添加 wiki 目录或配置知识库路径。" />
   <template v-else>
    <StatusNotice v-if="!page.complete" tone="warning" title="扫描未完成">以下结果可能不完整。请检查目录权限、链接与文件大小。</StatusNotice>
    <div class="kb-workspace">
     <Card class="kb-results kb-card" role="region" aria-label="知识条目">
      <div class="kb-card-heading"><h3>{{query?'搜索结果':'全部条目'}}</h3><Badge variant="secondary" role="status">{{page.total}} 条</Badge></div>
      <EmptyState v-if="!page.entries.length" :title="query?'没有找到匹配条目，请尝试其他关键词。':'知识库暂无 Markdown 条目。'" />
      <div class="kb-entries"><Button v-for="entry in page.entries" :key="entry.path" variant="ghost" class="kb-entry" :aria-pressed="selected===entry.path" @click="read(entry.path)"><strong>{{safe(entry.title)}}</strong><span>{{safe(entry.path)}}</span><small v-if="entry.uid||entry.status">{{safe(entry.uid)}} {{safe(entry.status)}}</small><span class="kb-excerpt">{{safe(entry.excerpt)}}</span></Button></div>
      <div class="kb-pagination"><Button variant="outline" :disabled="page.offset===0||loading" @click="load(Math.max(0,page.offset-20))">上一页</Button><span>{{page.total? page.offset+1:0}}–{{page.offset+page.entries.length}}</span><Button variant="outline" :disabled="page.nextOffset===null||loading" @click="load(page.nextOffset!)">下一页</Button></div>
     </Card>
     <Card class="kb-reader kb-card" role="region" aria-label="知识正文" :aria-busy="reading">
      <EmptyState v-if="!selected" title="选择左侧条目查看正文。" description="正文保留 Markdown 原文，分段读取以便核对。" />
      <StatusNotice v-if="readError" tone="error">{{readError}}<template #actions><Button variant="outline" @click="read(selected)">重新读取正文</Button></template></StatusNotice>
      <template v-if="document"><div class="kb-card-heading kb-document-heading"><div><h3>{{safe(document.entry.title)}}</h3><p>{{safe(document.entry.path)}} <span v-if="document.entry.uid">· {{safe(document.entry.uid)}}</span></p></div><Badge variant="outline">Markdown</Badge></div><div class="kb-document"><p class="kb-line-count">第 {{document.startLine}}–{{document.endLine}} 行 / 共 {{document.totalLines}} 行</p><pre tabindex="0" aria-label="Markdown 正文">{{safe(document.content)}}</pre><StatusNotice v-if="document.lineTruncated" tone="warning">部分超长行已截断，请在仓库中查看完整原文。</StatusNotice><Button v-if="document.nextLine" variant="outline" :disabled="reading" @click="read(selected,true)">加载后续内容</Button></div></template>
      <p v-if="reading" class="kb-reading" role="status">正在读取正文…</p>
     </Card>
    </div>
   </template>
  </template>
  <StatusNotice v-if="validationError" tone="error">{{validationError}}</StatusNotice>
  <Card v-if="validation" class="kb-validation kb-card" role="region" aria-label="知识库结构校验"><div class="kb-card-heading"><h3>结构校验</h3><Badge variant="secondary">{{validation.errors?.length??0}} 项错误 / {{validation.warnings?.length??0}} 项提醒</Badge></div><div class="kb-document"><p role="status">{{!validation.available?'知识库目录不存在':validation.valid===null?'校验不完整':validation.valid?'结构校验通过':'存在结构问题'}}</p><p class="kb-note">检查本地文档结构与引用，不代表内容事实或远程链接已核验。</p><ul><li v-for="(issue,i) in [...(validation.errors??[]),...(validation.warnings??[])]" :key="i">{{safe(issue.path)}} · {{safe(issue.code)}}</li></ul></div></Card>
 </section>
</template>
<style scoped>
.ar-knowledge{min-width:0}.kb-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:24px 0}.kb-project{display:flex;flex-direction:column;gap:6px;font-size:13px;max-width:300px}.kb-project :deep([data-slot=native-select-wrapper]){width:100%}.kb-project :deep(select){height:36px;background:var(--ocp-background);border-color:var(--ocp-border)}.kb-search{flex:1;min-width:220px}.kb-location{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 16px;font-size:12px;color:var(--ocp-muted)}.kb-location>span:first-child{overflow-wrap:anywhere;min-width:0}.kb-workspace{display:grid;grid-template-columns:minmax(240px,32%) minmax(0,1fr);gap:20px;margin-top:16px}.kb-card{padding:0;gap:0;min-width:0;overflow:hidden;background:var(--ocp-background)}.kb-card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--ocp-border)}.kb-card-heading h3{font-size:14px;line-height:1.5;margin:0;overflow-wrap:anywhere}.kb-card-heading p{font-size:12px;color:var(--ocp-muted);margin:6px 0 0;overflow-wrap:anywhere}.kb-entries{padding:8px}.kb-entry{display:flex;flex-direction:column;align-items:stretch;gap:4px;text-align:left;white-space:normal;width:100%;height:auto;padding:14px 12px;border:1px solid transparent;overflow-wrap:anywhere}.kb-entry[aria-pressed=true]{background:var(--ocp-muted-background);border-color:var(--ocp-border)}.kb-entry strong{font-size:13px;font-weight:600}.kb-entry span,.kb-entry small{font-size:12px;color:var(--ocp-muted);font-weight:400}.kb-excerpt{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.kb-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 16px;border-top:1px solid var(--ocp-border);margin-top:auto;font-size:12px;color:var(--ocp-muted)}.kb-document{padding:16px 20px}.kb-line-count,.kb-note{font-size:12px;color:var(--ocp-muted);margin:0 0 12px}.kb-reader pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.8;max-height:65vh;overflow:auto;margin:0 0 16px;padding:16px;background:var(--ocp-muted-background);color:var(--ocp-foreground);border-radius:8px}.kb-reading{padding:0 20px}.kb-validation{margin-top:20px}.kb-validation ul{max-height:250px;overflow:auto;font-size:12px;overflow-wrap:anywhere;padding-left:20px}@media(max-width:760px){.kb-workspace{grid-template-columns:1fr}.kb-project{width:100%;max-width:100%}.kb-search{min-width:0;flex-basis:calc(100% - 100px)}.kb-results{max-height:460px;overflow:auto}}
</style>
