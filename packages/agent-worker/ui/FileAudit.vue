<script setup lang="ts">
import {computed,ref,onMounted,onBeforeUnmount} from 'vue';
import {Button,NativeSelect,StatusNotice,EmptyState} from '@openclaw-plugins/control-ui-kit';
interface Change {path:string;previousPath?:string;status:string;patch?:string;binary?:boolean;notice?:string;modeChanged?:boolean;additions?:number;deletions?:number;beforeImage?:string;afterImage?:string}
interface Audit {available:boolean;capturedAt?:number;final?:boolean;isolated?:boolean;truncated?:boolean;stale?:boolean;notice?:string;base?:string;head?:string;files?:Change[];uncommitted?:Change[];commits?:string[]}
const props=defineProps<{jobId:string;load:<T>(action:string,payload:Record<string,unknown>)=>Promise<T>;redact:(value:string)=>string}>();
const data=ref<Audit>(),error=ref(''),loading=ref(false),mode=ref('task'),layout=ref('unified'),selected=ref('');let alive=true;
const files=computed(()=>mode.value==='task'?data.value?.files??[]:data.value?.uncommitted??[]);
const current=computed(()=>files.value.find(file=>file.path===selected.value)??files.value[0]);
const lines=computed(()=>current.value?.patch?.split('\n')??[]);
const pairs=computed(()=>{const result:{left:string;right:string;kind:string}[]=[];let removed:string[]=[],added:string[]=[];const flush=()=>{for(let i=0;i<Math.max(removed.length,added.length);i++)result.push({left:removed[i]??'',right:added[i]??'',kind:'change'});removed=[];added=[];};let inHunk=false;for(const line of lines.value){if(line.startsWith('@@'))inHunk=true;if(inHunk&&line.startsWith('-'))removed.push(line);else if(inHunk&&line.startsWith('+'))added.push(line);else{flush();result.push({left:line,right:line,kind:'context'});}}flush();return result;});
async function refresh(){if(loading.value)return;loading.value=true;error.value='';try{const result=await props.load<Audit>('files',{jobId:props.jobId});if(alive)data.value=result;}catch(e){if(alive)error.value=props.redact(e instanceof Error?e.message:String(e));}finally{if(alive)loading.value=false;}}
let timer:ReturnType<typeof setInterval>;
onMounted(()=>{void refresh();timer=setInterval(()=>{if(!data.value?.final)void refresh();},15000);});onBeforeUnmount(()=>{alive=false;clearInterval(timer);});
const image=(value?:string)=>value&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)?value:undefined;
</script>
<template>
 <section class="audit" aria-label="任务文件审计" :aria-busy="loading">
  <header><strong>文件变更</strong><code>{{jobId}}</code><Button variant="outline" :disabled="loading" @click="refresh">刷新文件</Button></header>
  <StatusNotice v-if="error" tone="error">{{error}}</StatusNotice>
  <p v-if="loading&&!data">正在读取文件快照…</p>
  <template v-if="data">
   <p class="meta">{{data.final?'结束快照':'执行快照'}} · {{data.capturedAt?new Date(data.capturedAt).toLocaleString():'尚未采集'}} · 每 15 秒采集，查看操作不访问当前工作区。</p>
   <StatusNotice v-if="data.notice" tone="warning">{{redact(data.notice)}}</StatusNotice>
   <template v-if="data.available">
    <StatusNotice v-if="!data.isolated" tone="warning">共享目录中的改动可能来自其他操作，不能仅凭此列表归属于本任务。</StatusNotice>
    <StatusNotice v-if="data.truncated" tone="warning">快照超出采集预算，列表或内容不完整；最多 100 个文件、单文件 256 KiB、总内容 2 MiB。</StatusNotice>
    <div class="controls"><NativeSelect v-model="mode" aria-label="变更范围"><option value="task">本次任务累计改动</option><option value="pending">当前未提交改动</option></NativeSelect><NativeSelect v-model="layout" aria-label="差异布局"><option value="unified">单栏 Diff</option><option value="split">并排 Diff</option></NativeSelect><span>{{files.length}} 个文件</span></div>
    <p class="meta">起始 {{data.base?.slice(0,12)}} → 当前 {{data.head?.slice(0,12)}}</p>
    <EmptyState v-if="!files.length" compact title="此快照没有文件内容变更" />
    <div v-else class="browser"><nav aria-label="变更文件"><button v-for="file in files" :key="file.path" :aria-pressed="current?.path===file.path" @click="selected=file.path"><span class="status">{{file.status}}</span><span class="path">{{redact(file.path)}}</span><small v-if="!file.binary&&!file.notice">+{{file.additions??0}} −{{file.deletions??0}}</small></button></nav>
     <article v-if="current"><h4>{{redact(current.path)}}</h4><p v-if="current.previousPath">重命名自 {{redact(current.previousPath)}}</p><p v-if="current.modeChanged">文件执行权限已改变</p><p v-if="current.notice">{{redact(current.notice)}}</p><p v-else-if="current.binary">二进制文件{{current.beforeImage||current.afterImage?' · 修改前后预览':'，不展示文本差异'}}</p>
      <div v-if="current.beforeImage||current.afterImage" class="images"><figure><figcaption>修改前</figcaption><img v-if="image(current.beforeImage)" :src="image(current.beforeImage)" alt="修改前图片"/><p v-else>无图片</p></figure><figure><figcaption>修改后</figcaption><img v-if="image(current.afterImage)" :src="image(current.afterImage)" alt="修改后图片"/><p v-else>无图片</p></figure></div>
      <pre v-else-if="current.patch&&layout==='unified'" class="diff" aria-label="文件差异"><span v-for="(line,index) in lines" :key="index" :class="line.startsWith('+')?'added':line.startsWith('-')?'removed':''">{{redact(line)}}{{'\n'}}</span></pre>
      <div v-else-if="current.patch" class="split" aria-label="并排文件差异"><div class="pair"><strong>修改前</strong><strong>修改后</strong></div><div v-for="(pair,index) in pairs" :key="index" class="pair"><pre :class="pair.kind==='change'?'removed':''">{{redact(pair.left)||' '}}</pre><pre :class="pair.kind==='change'?'added':''">{{redact(pair.right)||' '}}</pre></div></div>
     </article>
    </div>
    <details v-if="data.commits?.length"><summary>相关提交（最多 50 条）</summary><pre>{{redact(data.commits.join('\n'))}}</pre></details>
   </template>
  </template>
 </section>
</template>
<style scoped>
.audit{padding:12px;min-width:0}header,.controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}header code,.meta{font-size:12px;overflow-wrap:anywhere;opacity:.7}.browser{display:grid;grid-template-columns:minmax(160px,28%) minmax(0,1fr);border:1px solid var(--border,#8883);border-radius:6px;overflow:hidden}nav{display:block;padding:0;border-right:1px solid var(--border,#8883);max-height:65vh;overflow:auto}nav button{display:flex;gap:8px;align-items:center;width:100%;padding:8px;text-align:left;background:transparent;border:0;color:inherit;cursor:pointer}nav button[aria-pressed=true]{background:var(--accent,#8882)}nav button:focus-visible{outline:2px solid var(--ring,#5685ad);outline-offset:-2px}.path{overflow-wrap:anywhere;flex:1}small{white-space:nowrap}.status{font-family:monospace}article{min-width:0;padding:10px}h4{margin:0 0 10px;overflow-wrap:anywhere}.diff,.split{overflow:auto;max-height:65vh;font-size:12px;line-height:1.6}.diff span{display:inline-block;min-width:100%}.added{background:color-mix(in srgb,#22c55e 13%,transparent)}.removed{background:color-mix(in srgb,#ef4444 13%,transparent)}.pair{display:grid;grid-template-columns:1fr 1fr}.pair pre{margin:0;padding:0 6px;white-space:pre-wrap;overflow-wrap:anywhere;border-right:1px solid var(--border,#8883)}.images{display:flex;gap:8px}.images figure{flex:1;min-width:0;margin:0}.images img{max-width:100%;max-height:360px;object-fit:contain}details{margin-top:12px}details pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:640px){.browser{grid-template-columns:1fr}nav{max-height:180px;border-right:0;border-bottom:1px solid var(--border,#8883)}}
</style>
