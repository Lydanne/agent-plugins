<script setup lang="ts">
import {KnowledgeSnapshotCache,type SnapshotData} from './knowledge-snapshot-cache';
import {ref,shallowRef,onMounted,onBeforeUnmount,watch} from 'vue';
import {Button,Dialog,Tabs,PageHeader,SearchField,NativeSelect,Card,Badge,EmptyState,StatusNotice,useHostContext,useRepositoryPaths} from '@openclaw-plugins/control-ui-kit';
import KnowledgeMarkdown from './KnowledgeMarkdown.vue';
import KnowledgeGraph from './KnowledgeGraph.vue';
import KnowledgeTree from './KnowledgeTree.vue';
import KnowledgeCompare from './KnowledgeCompare.vue';
import KnowledgeTimeline from './KnowledgeTimeline.vue';
import type {KnowledgeIndex,KnowledgeEntry,KnowledgeEdge} from './knowledge-model';
import type {KnowledgeLink} from './knowledge-markdown';
import {useManagementRequest} from './management-request';
import type {KnowledgeCatalog,KnowledgePage,KnowledgeDocument,KnowledgeValidation} from './knowledge-model';
const props=defineProps<{agentId:string}>(),context=useHostContext(),request=useManagementRequest(context,()=>props.agentId);
const projects=ref<KnowledgeCatalog['projects']>([]),projectId=ref(''),input=ref(''),query=ref(''),page=ref<KnowledgePage>(),document=ref<KnowledgeDocument>(),validation=ref<KnowledgeValidation>();
const catalogLoading=ref(false),loading=ref(false),reading=ref(false),validating=ref(false),catalogError=ref(''),listError=ref(''),readError=ref(''),validationError=ref(''),selected=ref('');
const focusDocument=ref(false);
const validationOpen=ref(false),fragment=ref(''),navigationId=ref(0),history=ref<{path:string;fragment:string}[]>([]);
const index=ref<KnowledgeIndex>(),allNodes=shallowRef<KnowledgeEntry[]>([]),allEdges=shallowRef<KnowledgeEdge[]>([]),snapshotId=ref(''),indexError=ref(''),indexLoading=ref(false),compareOpen=ref(false),compareBefore=ref(''),compareAfter=ref('');let indexEpoch=0,alive=true;
const snapshotCache=new KnowledgeSnapshotCache(),pendingSnapshots=new Map<string,Promise<SnapshotData>>(),renderedSnapshot=ref('');
watch(()=>props.agentId,()=>{snapshotCache.clear();pendingSnapshots.clear();renderedSnapshot.value='';},{flush:'sync'});
const view=ref('documents'),graphRevision=ref(0),graphRef=ref<InstanceType<typeof KnowledgeGraph>>(),views=[{id:'documents',label:'文档'},{id:'graph',label:'图谱'},{id:'updates',label:'更新'}];
function refreshKnowledge(){void catalog();if(projectId.value)void prepareIndex(true);graphRevision.value++;}
async function openGraphDocument(path:string){const project=projectId.value,valid=request.capture();view.value='documents';if(!page.value)await load();if(valid()&&projectId.value===project&&view.value==='documents'&&page.value?.available)selectEntry(path);}
let listEpoch=0,readEpoch=0,validationEpoch=0,catalogEpoch=0;
const safe=(value:unknown)=>context.value.host.redact(String(value??''));
function clearDetail(){readEpoch++;history.value=[];fragment.value='';selected.value='';document.value=undefined;readError.value='';reading.value=false;}
async function catalog(){
 const token=++catalogEpoch,valid=request.capture();catalogLoading.value=true;catalogError.value='';
 try{const result=await request.invoke<KnowledgeCatalog>('knowledgeCatalog',{});if(!valid()||token!==catalogEpoch)return;projects.value=result.projects;if(!projects.value.some(p=>p.projectId===projectId.value))projectId.value=preferredProject();}
 catch{if(valid()&&token===catalogEpoch)catalogError.value='项目清单读取失败，请重试。';}
 finally{if(valid()&&token===catalogEpoch)catalogLoading.value=false;}
}
function preferredProject(){let saved='';try{saved=localStorage.getItem('knowledge-project:'+props.agentId)??'';}catch{}const available=projects.value.filter(p=>p.knowledge?.available!==false);return available.find(p=>p.projectId===saved)?.projectId??available.find(p=>p.projectId==='xgj')?.projectId??available[0]?.projectId??projects.value[0]?.projectId??'';}
async function pages<T>(action:string,id:string,key:string,valid:()=>boolean){const result:T[]=[];let cursor:string|null=null;do{const r:{snapshotId:string;nextCursor:string|null;[key:string]:unknown}=await request.invoke<{snapshotId:string;nextCursor:string|null;[key:string]:unknown}>(action,{projectId:projectId.value,snapshotId:id,...(cursor?{cursor}:{})});if(!valid()||r.snapshotId!==id)throw Error('stale');result.push(...r[key] as T[]);cursor=r.nextCursor;}while(cursor);return result;}
async function snapshotData(id:string){
 const cached=snapshotCache.get(id);if(cached)return cached;const pending=pendingSnapshots.get(id);if(pending)return pending;
 const valid=request.capture();const promise=Promise.all([pages<KnowledgeEntry>('knowledgeNodes',id,'nodes',valid),pages<KnowledgeEdge>('knowledgeEdges',id,'edges',valid)]).then(([nodes,edges])=>{if(!alive||!valid())throw Error('stale');const data={nodes,edges};snapshotCache.set(id,data);return data;}).finally(()=>{if(pendingSnapshots.get(id)===promise)pendingSnapshots.delete(id);});pendingSnapshots.set(id,promise);return promise;
}
function prefetchSnapshot(value:KnowledgeIndex){if(value.snapshotId)void snapshotData(value.snapshotId).catch(()=>{});}
async function activateSnapshot(value:KnowledgeIndex,selectDefault=true){if(!value.snapshotId)return;const token=++indexEpoch,valid=request.capture(),id=value.snapshotId;indexLoading.value=true;indexError.value='';try{const validNow=()=>alive&&valid()&&token===indexEpoch;let data=snapshotCache.get(id);if(data){const verified=await request.invoke<KnowledgeIndex>('knowledgeIndex',{projectId:projectId.value,snapshotId:id});if(!validNow())return;if(verified.snapshotId!==id)throw Error('snapshot_mismatch');}else data=await snapshotData(id);const {nodes,edges}=data;if(!validNow())return;index.value=value;snapshotId.value=id;allNodes.value=nodes;allEdges.value=edges;if(view.value==='documents'||selectDefault)await load();else{clearDetail();page.value=undefined;}if(selectDefault&&value.entrypoint&&validNow())selectEntry(value.entrypoint,false);}catch{if(valid()&&token===indexEpoch)indexError.value='知识快照加载失败，请刷新重试。';}finally{if(token===indexEpoch)indexLoading.value=false;}}
async function prepareIndex(refresh=false){const token=++indexEpoch,valid=request.capture();indexLoading.value=true;indexError.value='';try{let first=true;while(alive&&valid()&&token===indexEpoch){const r=await request.invoke<KnowledgeIndex>('knowledgeIndex',{projectId:projectId.value,...(first&&refresh?{refresh:true}:{})});first=false;if(!alive||!valid()||token!==indexEpoch)return;index.value=r;if(r.state==='error')throw Error();if(r.state==='ready'){await activateSnapshot(r);return;}await new Promise(resolve=>setTimeout(resolve,350));}}catch{if(valid()&&token===indexEpoch)indexError.value='知识索引准备失败，请刷新重试。';}finally{if(token===indexEpoch)indexLoading.value=false;}}
async function historicalOpen(id:string,path:string){const valid=request.capture();try{const value=await request.invoke<KnowledgeIndex>('knowledgeIndex',{projectId:projectId.value,snapshotId:id});if(!valid())return;await activateSnapshot(value,false);if(!valid()||snapshotId.value!==id)return;view.value='documents';selectEntry(path);}catch{if(valid())indexError.value='历史正文加载失败，请重试。';}}
async function compare(before:string|undefined,after:string,path:string,previousPath?:string){const valid=request.capture();compareOpen.value=true;compareBefore.value='加载中…';compareAfter.value='加载中…';async function full(id:string|undefined,p:string){if(!id)return '此版本不存在该文档';let line=1,result='';do{const r=await request.invoke<KnowledgeDocument>('knowledgeRead',{projectId:projectId.value,snapshotId:id,path:p,startLine:line,maxLines:200});if(!valid())return '';if(!r.found)return '此版本不存在该文档';result+=r.content+(r.nextLine?'\n':'');line=r.nextLine??0;}while(line);return result;}try{const [a,b]=await Promise.all([full(before,previousPath??path),full(after,path)]);if(valid()){compareBefore.value=a;compareAfter.value=b;}}catch{if(valid()){compareBefore.value='对比读取失败';compareAfter.value='请重试';}}}
onBeforeUnmount(()=>{alive=false;indexEpoch++;snapshotCache.clear();pendingSnapshots.clear();});
async function load(offset=0){
 const token=++listEpoch,valid=request.capture();clearDetail();page.value=undefined;listError.value='';loading.value=!!projectId.value;if(!projectId.value)return;
 try{const result=await request.invoke<KnowledgePage>(query.value?'knowledgeSearch':'knowledgeList',{projectId:projectId.value,limit:20,offset,...(snapshotId.value?{snapshotId:snapshotId.value}:{}),...(query.value?{query:query.value}:{})});if(valid()&&token===listEpoch)page.value=result;}
 catch{if(valid()&&token===listEpoch)listError.value='知识库读取失败，请核对项目配置与目录权限后重试。';}
 finally{if(valid()&&token===listEpoch)loading.value=false;}
}
function search(value=input.value){query.value=value.trim();void load();}
async function read(path:string,append=false,targetFragment=''){
 const token=++readEpoch,valid=request.capture(),previous=append?document.value:undefined;selected.value=path;readError.value='';reading.value=true;if(!append){document.value=undefined;fragment.value=targetFragment;navigationId.value++;}
 try{
  const result=await request.invoke<KnowledgeDocument>('knowledgeRead',{projectId:projectId.value,path,...(snapshotId.value?{snapshotId:snapshotId.value}:{}),startLine:previous?.nextLine??1,maxLines:100});
  if(!valid()||token!==readEpoch)return;
  if(!result.found){document.value=undefined;readError.value='条目已不存在，请刷新列表。';return;}
  if(previous&&result.sha256!==previous.sha256){readError.value='条目已更新，请重新读取正文。';return;}
  document.value=previous?{...result,startLine:previous.startLine,content:previous.content+'\n'+result.content,lineTruncated:previous.lineTruncated||result.lineTruncated}:result;
 }catch{if(valid()&&token===readEpoch)readError.value='正文读取失败，请重试。';}
 finally{if(valid()&&token===readEpoch)reading.value=false;}
}
function selectEntry(path:string,focus=true){focusDocument.value=focus;history.value=[];void read(path);}
function navigate(link:KnowledgeLink){
 if(link.kind!=='document'||!document.value)return;
 focusDocument.value=true;history.value=[...history.value,{path:document.value.entry.path,fragment:fragment.value}].slice(-20);void read(link.path,false,link.fragment);
}
function back(){const previous=history.value.pop();if(previous)void read(previous.path,false,previous.fragment);}
function closeValidation(open=false){validationOpen.value=open;if(!open){validationEpoch++;validating.value=false;validation.value=undefined;validationError.value='';}}
async function validate(){
 validationOpen.value=true;
 const token=++validationEpoch,valid=request.capture();validating.value=true;validation.value=undefined;validationError.value='';
 try{const result=await request.invoke<KnowledgeValidation>('knowledgeValidate',{projectId:projectId.value});if(valid()&&token===validationEpoch)validation.value=result;}
 catch{if(valid()&&token===validationEpoch)validationError.value='结构校验失败，请重试。';}
 finally{if(valid()&&token===validationEpoch)validating.value=false;}
}
watch(projectId,()=>{snapshotCache.clear();pendingSnapshots.clear();renderedSnapshot.value='';request.invalidate();catalogLoading.value=false;loading.value=false;compareOpen.value=false;compareBefore.value='';compareAfter.value='';indexEpoch++;input.value='';query.value='';snapshotId.value='';index.value=undefined;allNodes.value=[];allEdges.value=[];page.value=undefined;clearDetail();closeValidation();try{localStorage.setItem('knowledge-project:'+props.agentId,projectId.value);}catch{}if(projectId.value)void prepareIndex(true);},{flush:'sync'});
onMounted(catalog);
const paths=useRepositoryPaths(),showPath=(value:unknown)=>safe(paths.display(value));
</script>
<template>
 <section class="ar-knowledge" aria-label="项目知识库">
  <PageHeader class="ar-section-heading" title="知识库" description="浏览项目文档，搜索知识条目并查看正文。"><Button variant="outline" :disabled="catalogLoading||loading" @click="refreshKnowledge">刷新知识库</Button></PageHeader>
  <StatusNotice v-if="catalogError" tone="error">{{catalogError}}</StatusNotice>
  <Tabs v-model="view" :items="views" label="知识库视图" list-class="kb-view-tabs" activation-mode="manual">
  <div class="kb-controls">
   <label class="kb-project">项目<NativeSelect v-model="projectId" aria-label="知识库项目" :disabled="catalogLoading"><option value="">{{catalogLoading?'正在读取项目…':'请选择项目'}}</option><option v-for="p in projects" :key="p.projectId" :value="p.projectId">{{safe(p.name)}} · {{safe(p.projectId)}}</option></NativeSelect></label>
   <SearchField v-if="view==='documents'" v-model="input" class="kb-search" aria-label="搜索知识库" placeholder="标题、UID 或正文关键词" maxlength="320" :disabled="!projectId" :busy="loading" @search="search" />
   <Button variant="outline" :disabled="!projectId||validating||page?.available===false" @click="validate">{{validating?'正在校验…':'校验结构'}}</Button>
  </div>
  <EmptyState v-if="!catalogLoading&&!catalogError&&!projects.length" title="当前 Agent 尚未登记项目。" description="登记项目后可浏览项目的 wiki。" />
  <EmptyState v-else-if="!projectId&&!catalogLoading&&!catalogError" title="请选择要查看的项目。" description="每个项目的知识目录、搜索结果和正文独立读取。" />
  <StatusNotice v-if="indexError" tone="error">{{indexError}}</StatusNotice><p v-if="indexLoading" role="status">正在准备完整知识快照… {{index?.processed??0}} / {{index?.total??0}}</p><StatusNotice v-if="index?.snapshotId&&!index.complete" tone="warning">部分文档或引用未能解析，请检查异常记录；当前结果不代表完整知识库。</StatusNotice><details v-if="index?.issues?.length"><summary>读取异常 · {{index.issues.length}}</summary><ul><li v-for="(issue,i) in index.issues.slice(0,100)" :key="i">{{safe(issue.path)}} · {{safe(issue.code)}}</li></ul></details><p v-if="index?.commit" class="kb-note">历史版本 {{index.commit}} · {{index.at}}</p>
  <div v-if="view==='graph'&&projectId" class="kb-graph-shell"><KnowledgeGraph ref="graphRef" :key="projectId+':'+graphRevision" :nodes="allNodes" :edges="allEdges" :snapshot-id="snapshotId" @open="openGraphDocument" @select="selected=$event" @ready="renderedSnapshot=$event??''"><template #timeline><KnowledgeTimeline :rendered-snapshot="renderedSnapshot" :agent-id="agentId" :project-id="projectId" :active-snapshot="snapshotId" :active-commit="index?.commit" @prefetch="prefetchSnapshot" @snapshot="activateSnapshot($event,false)" @latest="prepareIndex(true)" @open="historicalOpen" @compare="compare"/></template><template #overlay><KnowledgeCompare :open="compareOpen" :before="compareBefore" :after="compareAfter" @close="compareOpen=false"/></template></KnowledgeGraph></div>
  <KnowledgeTimeline v-if="view==='updates'&&projectId" :key="projectId" :agent-id="agentId" :project-id="projectId" :active-snapshot="snapshotId" :active-commit="index?.commit" @prefetch="prefetchSnapshot" @snapshot="activateSnapshot($event,false)" @latest="prepareIndex(true)" @open="historicalOpen" @compare="compare"/>
  <template v-if="view==='documents'">
  <StatusNotice v-if="listError" tone="error">{{listError}}<template #actions><Button variant="outline" @click="load()">重试列表</Button></template></StatusNotice>
  <p v-if="loading" role="status">正在读取知识条目…</p>
  <template v-if="page">
   <div class="kb-location"><span>{{showPath(page.knowledgePath)}}</span><Badge variant="secondary">{{page.normalized?'规范化知识库':'普通 wiki'}}</Badge></div>
   <EmptyState v-if="!page.available" title="项目尚无知识库目录" description="请添加 wiki 目录或配置知识库路径。" />
   <template v-else>
    <StatusNotice v-if="!page.complete" tone="warning" title="扫描未完成">以下结果可能不完整。请检查目录权限、链接与文件大小。</StatusNotice>
    <EmptyState v-if="!page.total&&!query" title="知识库暂无 Markdown 条目。"/><div class="kb-workspace">
     <KnowledgeTree v-if="!query" :entries="allNodes" :selected="selected" :redact="safe" @select="selectEntry"/>
     <Card v-if="query" class="kb-results kb-card" role="region" aria-label="知识条目">
      <div class="kb-card-heading"><h3>{{query?'搜索结果':'全部条目'}}</h3><Badge variant="secondary" role="status">{{page.total}} 条</Badge></div>
      <EmptyState v-if="!page.entries.length" :title="query?'没有找到匹配条目，请尝试其他关键词。':'知识库暂无 Markdown 条目。'" />
      <div class="kb-entries"><Button v-for="entry in page.entries" :key="entry.path" variant="ghost" class="kb-entry" :aria-pressed="selected===entry.path" @click="selectEntry(entry.path)"><strong>{{safe(entry.title)}}</strong><span>{{safe(entry.path)}}</span><small v-if="entry.uid||entry.status">{{safe(entry.uid)}} {{safe(entry.status)}}</small><span class="kb-excerpt">{{safe(entry.excerpt)}}</span></Button></div>
      <div class="kb-pagination"><Button variant="outline" :disabled="page.offset===0||loading" @click="load(Math.max(0,page.offset-20))">上一页</Button><span>{{page.total? page.offset+1:0}}–{{page.offset+page.entries.length}}</span><Button variant="outline" :disabled="page.nextOffset===null||loading" @click="load(page.nextOffset!)">下一页</Button></div>
     </Card>
     <Card class="kb-reader kb-card" role="region" aria-label="知识正文" :aria-busy="reading">
      <EmptyState v-if="!selected" title="选择左侧条目查看正文。" description="支持 Markdown 预览、标题目录和文档链接跳转。" />
      <Button v-if="history.length" class="kb-back" variant="ghost" size="sm" @click="back">返回上篇</Button>
      <StatusNotice v-if="readError" tone="error">{{readError}}<template #actions><Button variant="outline" @click="read(selected,false,fragment)">重新读取正文</Button></template></StatusNotice>
      <template v-if="document"><div class="kb-card-heading kb-document-heading"><div><h3>{{safe(document.entry.title)}}</h3><p>{{safe(document.entry.path)}} <span v-if="document.entry.uid">· {{safe(document.entry.uid)}}</span></p></div><Badge variant="outline">Markdown</Badge></div><div class="kb-document"><p class="kb-line-count">第 {{document.startLine}}–{{document.endLine}} 行 / 共 {{document.totalLines}} 行</p><KnowledgeMarkdown :content="safe(document.content)" :path="document.entry.path" :partial="!!document.nextLine" :fragment="fragment" :navigation-id="navigationId" :focus-on-load="focusDocument" @navigate="navigate" /><StatusNotice v-if="document.lineTruncated" tone="warning">部分超长行已截断，请在仓库中查看完整原文。</StatusNotice><p v-if="document.nextLine" class="kb-note">正文尚未全部加载，目录和标题跳转随后续内容更新。</p><Button v-if="document.nextLine" variant="outline" :disabled="reading" @click="read(selected,true)">加载后续内容</Button></div></template>
      <p v-if="reading" class="kb-reading" role="status">正在读取正文…</p>
     </Card>
    </div>
   </template>
  </template>
  </template>
  </Tabs>
  <KnowledgeCompare v-if="view!=='graph'" :open="compareOpen" :before="compareBefore" :after="compareAfter" @close="compareOpen=false"/>
 <Dialog :open="validationOpen" :session-scoped="false" title="知识库结构校验" description="检查当前项目的本地文档结构与引用。" size="detail" @update:open="closeValidation">
   <div class="kb-validation" aria-label="知识库结构校验结果" :aria-busy="validating">
    <p class="kb-note">项目：{{safe(projectId)}}</p>
    <p v-if="validating" role="status">正在校验知识库结构…</p>
    <StatusNotice v-if="validationError" tone="error">{{validationError}}</StatusNotice>
    <template v-if="validation">
     <StatusNotice :tone="validation.valid===true?'info':validation.valid===null?'warning':'error'" :title="!validation.available?'知识库目录不存在':validation.valid===null?'校验不完整':validation.valid?'结构校验通过':'存在结构问题'">{{validation.errors?.length??0}} 项错误 / {{validation.warnings?.length??0}} 项提醒</StatusNotice>
     <p class="kb-note">{{showPath(validation.knowledgePath)}}</p>
     <StatusNotice v-if="!validation.complete" tone="warning">扫描未完成，结果可能不完整。</StatusNotice>
     <ul v-if="validation.errors?.length||validation.warnings?.length"><li v-for="(issue,i) in [...(validation.errors??[]),...(validation.warnings??[])]" :key="i">{{safe(issue.path)}} · {{safe(issue.code)}}</li></ul>
    </template>
    <p class="kb-note">结构校验不代表内容事实或远程链接已核验。</p>
   </div>
   <template #footer><Button v-if="!validating" variant="outline" @click="validate">重新校验</Button><Button variant="outline" @click="closeValidation()">完成</Button></template>
  </Dialog>
 </section>
</template>
<style scoped>
.kb-graph-shell{min-width:0}@media(max-width:1000px){.kb-graph-shell{grid-template-columns:1fr}}.kb-diff{display:grid;grid-template-columns:1fr 1fr;gap:16px}.kb-diff pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:65vh;overflow:auto}.ar-knowledge{min-width:0}.ar-knowledge :deep(.kb-view-tabs){margin-top:16px;padding-bottom:8px;border-bottom:1px solid var(--ocp-border)}.kb-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:24px 0}.kb-project{display:flex;flex-direction:column;gap:6px;font-size:13px;max-width:300px}.kb-project :deep([data-slot=native-select-wrapper]){width:100%}.kb-project :deep(select){height:36px;background:var(--ocp-background);border-color:var(--ocp-border)}.kb-search{flex:1;min-width:220px}.kb-location{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 16px;font-size:12px;color:var(--ocp-muted)}.kb-location>span:first-child{overflow-wrap:anywhere;min-width:0}.kb-workspace{display:grid;grid-template-columns:minmax(240px,32%) minmax(0,1fr);gap:20px;margin-top:16px}.kb-card{padding:0;gap:0;min-width:0;overflow:hidden;background:var(--ocp-background)}.kb-card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--ocp-border)}.kb-card-heading h3{font-size:14px;line-height:1.5;margin:0;overflow-wrap:anywhere}.kb-card-heading p{font-size:12px;color:var(--ocp-muted);margin:6px 0 0;overflow-wrap:anywhere}.kb-entries{padding:8px}.kb-entry{display:flex;flex-direction:column;align-items:stretch;gap:4px;text-align:left;white-space:normal;width:100%;height:auto;padding:14px 12px;border:1px solid transparent;overflow-wrap:anywhere}.kb-entry[aria-pressed=true]{background:var(--ocp-muted-background);border-color:var(--ocp-border)}.kb-entry strong{font-size:13px;font-weight:600}.kb-entry span,.kb-entry small{font-size:12px;color:var(--ocp-muted);font-weight:400}.kb-excerpt{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.kb-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 16px;border-top:1px solid var(--ocp-border);margin-top:auto;font-size:12px;color:var(--ocp-muted)}.kb-document{padding:16px 20px}.kb-line-count,.kb-note{font-size:12px;color:var(--ocp-muted);margin:0 0 12px}.kb-reading{padding:0 20px}.kb-back{margin:12px 20px 0;align-self:flex-start}.kb-validation{display:grid;gap:16px}.kb-validation .kb-note{margin:0;overflow-wrap:anywhere}.kb-validation ul{max-height:250px;overflow:auto;font-size:12px;overflow-wrap:anywhere;padding-left:20px}@container agent-management (max-width:760px){.kb-workspace{grid-template-columns:1fr}.kb-project{width:100%;max-width:100%}.kb-search{min-width:0;flex-basis:calc(100% - 100px)}.kb-results{max-height:460px;overflow:auto}}
</style>
