<script setup lang="ts">
import {ref,computed,watch} from 'vue';
import {Button,Dialog,HelpTip,Input,NativeSelect,useHostContext} from '@openclaw-plugins/control-ui-kit';
import {useManagementRequest} from './management-request';
import {recycleLabels,type RecyclePage,type RecycleItem,type Confirmation} from './recycle-model';
const props=defineProps<{agentId:string;onRestored?:()=>void|Promise<void>}>();
const context=useHostContext(),request=useManagementRequest(context,()=>props.agentId);
const policyOpen=ref(false);
const open=ref(false),busy=ref(false),data=ref<RecyclePage|null>(null),error=ref(''),offset=ref(0),feature=ref(''),query=ref(''),days=ref(30),confirmation=ref<Confirmation|null>(null);
let generation=0;
const writable=computed(()=>context.value.host.connection.canWrite===true);
const safe=(value:unknown)=>context.value.host.redact(String(value??''));
function close(){generation++;request.invalidate();open.value=false;policyOpen.value=false;confirmation.value=null;data.value=null;busy.value=false;error.value='';}
watch(open,value=>{if(!value)close();});
watch([()=>context.value.presented,()=>context.value.host.connection.canRead,()=>context.value.host.connection.canWrite,()=>props.agentId],close,{flush:'sync'});
async function refresh(){
 if(!open.value)return;const token=++generation,valid=request.capture();busy.value=true;error.value='';
 try{const result=await request.invoke<RecyclePage>('recycleBin',{...(feature.value?{feature:feature.value}:{}),...(query.value?{query:query.value}:{}),limit:25,offset:offset.value});
  if(!valid()||token!==generation||!open.value)return;
  if(result.agentId!==props.agentId)throw Error('回收站来源不一致');
  if(!result.records.length&&offset.value>0&&offset.value>=result.total){offset.value=Math.max(0,Math.floor((Math.max(result.total,1)-1)/25)*25);await refresh();return;}
  data.value=result;days.value=result.settings.retentionDays;
 }catch(e){if(!valid()||token!==generation)return;error.value=safe(e instanceof Error?e.message:e);}
 if(valid()&&token===generation)busy.value=false;
}
function launch(){if(!context.value.host.connection.canRead)return;open.value=true;void refresh();}
function filter(){offset.value=0;void refresh();}
function restore(item:RecycleItem){confirmation.value={action:'recycleRestore',label:safe(item.name),payload:{provider:item.provider,id:item.id,expectedRevision:item.revision,requestId:crypto.randomUUID(),confirmed:true}};}
function retention(){if(!data.value||!Number.isInteger(days.value)||days.value<1||days.value>3650)return;policyOpen.value=false;confirmation.value={action:'recycleConfigure',label:`保留 ${days.value} 天后自动永久删除`,payload:{retentionDays:days.value,expectedRevision:data.value.settings.revision,requestId:crypto.randomUUID(),confirmed:true}};}
async function execute(){
 if(!confirmation.value||busy.value||!writable.value)return;
 const pending=confirmation.value,token=generation,valid=request.capture();busy.value=true;
 try{const result=await request.invoke<{status:string}>(pending.action,pending.payload);if(!valid()||token!==generation||!open.value)return;
  if(result.status!=='succeeded'){error.value='操作结果待核验，请刷新查看回收站与审计；不要新建请求重复操作。';busy.value=false;return;}
  confirmation.value=null;await props.onRestored?.();if(!valid()||token!==generation)return;await refresh();
 }catch(e){if(!valid()||token!==generation)return;error.value=safe(e instanceof Error?e.message:e);busy.value=false;}
}
function go(next:number){offset.value=next;void refresh();}
</script>
<template>
 <Button class="ar-recycle-fab" aria-label="打开回收站" aria-haspopup="dialog" variant="outline" @click="launch">回收站</Button>
 <Dialog size="wide" :open="open" title="回收站" description="已删除内容、恢复与自动永久删除期限" @update:open="value=>{if(!value)close()}">
  <div class="ar-recycle-dialog" :aria-busy="busy">
   <p v-if="error" role="alert" class="ar-error">{{error}}</p>
   <template v-if="confirmation">
    <h3>{{confirmation.action==='recycleRestore'?'确认恢复':'确认修改保留期限'}}</h3><p>{{confirmation.label}}</p>
    <p>{{confirmation.action==='recycleRestore'?'计划恢复后保持暂停，需要手动启用；实体恢复不会重建已结束的关联。':'新期限会应用于当前仓库已有的回收站内容。缩短期限后，已到期内容会在下次后台清理时永久删除。审计仍保留。'}}</p>
    <Button :disabled="busy||!writable" @click="execute">{{busy?'提交中…':'确认执行'}}</Button><Button variant="outline" :disabled="busy" @click="confirmation=null;error=''">取消</Button>
   </template>
   <template v-else>
    <form class="ar-recycle-filters" @submit.prevent="filter"><NativeSelect v-model="feature" aria-label="回收站功能"><option value="">全部功能</option><option value="schedules">定时任务</option><option value="entities">实体与人员</option><option value="logs">日志</option></NativeSelect><Input v-model="query" type="search" placeholder="搜索名称或 ID" aria-label="搜索回收站"/><Button type="submit" :disabled="busy">筛选</Button><Button variant="outline" :disabled="busy" @click="refresh">刷新回收站</Button></form>
    <p v-if="!data">{{busy?'正在读取…':'暂未取得回收站'}}</p>
    <template v-else>
     <div class="ar-recycle-settings-row"><span class="ar-meta">删除后保留 {{data.settings.retentionDays}} 天</span><Button variant="ghost" aria-haspopup="dialog" @click="days=data.settings.retentionDays;policyOpen=true">保留期限设置</Button><HelpTip title="回收站说明"><p>后台每小时检查到期内容；运行中或结果待核验的任务会延后清理。恢复计划后保持暂停。</p></HelpTip></div>
     <p v-if="data.unavailable?.length" class="ar-warning">{{safe('部分来源不可用：'+data.unavailable.join('、'))}}</p>
     <p>共 {{data.total}} 项</p><p v-if="!data.records.length" class="ar-muted">回收站为空或没有匹配内容。</p>
     <article v-for="item in data.records" :key="item.provider+':'+item.id" class="ar-recycle-item"><div><h3>{{safe(item.name)}}</h3><p>{{safe((recycleLabels[item.kind]??item.kind)+' · '+item.id)}}</p><p>删除于 {{new Date(item.deletedAt).toLocaleString()}} · {{item.expired?'已到期，等待后台清理':'预计 '+new Date(item.expiresAt).toLocaleString()+' 后永久删除'}}</p><details v-if="item.preview"><summary>查看内容</summary><pre>{{safe(JSON.stringify(item.preview,null,2))}}</pre></details><p v-if="item.busy||item.restorePending" class="ar-warning">运行中或结果待核验，暂不能恢复。</p></div><Button variant="outline" :aria-label="'恢复'+item.name" :disabled="busy||!writable||item.busy||item.restorePending" @click="restore(item)">恢复</Button></article>
     <nav class="ar-recycle-paging" aria-label="回收站分页"><Button v-if="offset" variant="outline" @click="go(Math.max(0,offset-25))">上一页</Button><Button v-if="data.nextOffset!=null" variant="outline" @click="go(data.nextOffset)">下一页</Button></nav>
    </template>
   </template>
  </div>
 </Dialog>
 <Dialog size="confirm" v-if="data" :session-scoped="false" v-model:open="policyOpen" title="回收站保留设置" description="修改自动永久删除期限">     <form class="ar-recycle-policy" @submit.prevent="retention"><label>自动永久删除期限（天）<Input :model-value="days" @update:model-value="days=Number($event)" type="number" min="1" max="3650" step="1" required aria-label="回收站保留天数" :disabled="busy||!writable"/></label><Button type="submit" :disabled="busy||!writable">保存保留期限</Button></form>
     <p class="ar-muted">默认保留 30 天。删除时间起计算保留期限；后台每小时检查，运行中或结果待核验的任务延后清理。</p>
     <p class="ar-muted">{{data.cleanup?`最近清理：${new Date(data.cleanup.at).toLocaleString()} · ${data.cleanup.status==='succeeded'?'完成':'部分来源待核验'}`:'尚未取得后台清理记录；自动清理需原生调度服务可用。'}}</p>
</Dialog>
</template>

<style scoped>
.ar-recycle-dialog{width:100%;max-width:100%;min-width:0;}
</style>
