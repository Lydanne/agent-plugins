<script setup lang="ts">
import {ref,reactive,onMounted,onBeforeUnmount} from 'vue';
import {Button,Table} from '@openclaw-plugins/control-ui-kit';
import {auditFeatures,statuses,actions,fields,display,type AuditOptions,type AuditPage,type AuditRecord} from './audit-model';
const props=defineProps<AuditOptions>();
const safe=(value:unknown)=>props.safe?.(value)??String(value??'');
const offset=ref(0),page=ref<AuditPage|null>(null),error=ref(''),loading=ref(false);
const filters=reactive<Record<string,string>>({feature:props.feature??'',targetId:props.targetId??'',status:'',actorId:'',action:'',from:'',to:''});
let alive=true,epoch=0;
async function query(){
 const token=++epoch;loading.value=true;error.value='';
 try{const payload=Object.fromEntries(Object.entries(filters).filter(([,v])=>v!=='').map(([key,value])=>[key,['from','to'].includes(key)?new Date(value).getTime():value]));
  const result=await props.invoke('audit',{...payload,limit:25,offset:offset.value});if(!alive||epoch!==token)return;page.value=result;
 }catch(e){if(!alive||epoch!==token)return;error.value=safe(e instanceof Error?e.message:e);}
 if(alive&&epoch===token)loading.value=false;
}
function submit(){offset.value=0;page.value=null;void query();}
function go(next:number){offset.value=next;void query();}
function evidence(r:AuditRecord):[string,unknown][]{return [['发起指派',r.actor?.name??r.actor?.id??(r.actor?.kind==='system'?'系统':'身份未记录')],['发起人 ID',r.actor?.id],['身份说明',r.actor?.identityNote],['执行入口',r.executor],['来源账号',r.actor?.accountId],['来源群',r.actor?.chatId],['指派消息',r.actor?.messageIds],['请求 ID',r.requestId],['对象 ID',r.targetId],['审计 ID',r.id]];}
const textFilters=[['actorId','发起人 ID','text'],['action','操作类型','text'],['targetId','对象 ID','text'],['from','开始时间','datetime-local'],['to','结束时间','datetime-local']];
onMounted(query);onBeforeUnmount(()=>{alive=false;epoch++;});
</script>
<template>
 <section class="ar-audit" data-ocp-ui aria-label="审计记录" :aria-busy="loading">
  <header class="ar-section-heading"><div><h2>{{targetId?'修改日志':'审计'}}</h2><p>查看发起人、执行入口、修改前后值和操作结果。</p></div><Button variant="outline" @click="query">刷新审计</Button><Button v-if="onClose" variant="ghost" @click="onClose">关闭</Button></header>
  <form class="ar-audit-filters" @submit.prevent="submit">
   <label>功能<select v-model="filters.feature" aria-label="功能" :disabled="!!feature"><option value="">全部功能</option><option v-for="(label,key) in auditFeatures" :key="key" :value="key">{{label}}</option></select></label>
   <label>操作结果<select v-model="filters.status" aria-label="操作结果"><option value="">全部结果</option><option v-for="(label,key) in statuses" :key="key" :value="key">{{label}}</option></select></label>
   <label v-for="[name,label,type] in textFilters" :key="name">{{label}}<input v-model="filters[name!]" :aria-label="label" :type="type" :disabled="name==='targetId'&&!!targetId"></label>
   <Button type="submit" :disabled="loading">筛选</Button>
  </form>
  <p class="ar-muted">{{safe(page?.notice??'审计自启用后记录。旧记录缺失的实名、指派依据和前后值不可推测补全。成功仅表示管理操作完成。')}}</p>
  <p v-if="page?.unavailable?.length" class="ar-warning">部分来源不可读取：{{safe(page.unavailable.join('、'))}}</p>
  <p v-if="error" role="alert" class="ar-error">{{error}}</p>
  <p v-else-if="loading">正在读取审计…</p>
  <template v-else>
   <p>共 {{page?.total??0}} 条审计记录</p><p v-if="!page?.records?.length">此筛选范围暂无审计记录。</p>
   <details v-for="record in page?.records??[]" :key="record.id" class="ar-audit-record">
    <summary>{{safe(new Date(record.at).toLocaleString()+' · '+(actions[record.action]??record.action)+' · '+record.targetName+' · '+(statuses[record.status]??record.status))}}</summary>
    <p>{{safe('发起指派：'+(record.actor?.name??record.actor?.id??'身份未记录')+' · 执行入口：'+(record.executor??'未记录'))}}</p>
    <div v-if="record.changes?.length" class="ocp:overflow-x-auto"><Table><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody><tr v-for="(change,index) in record.changes" :key="index"><td>{{safe(fields[change.field]??change.field)}}</td><td>{{safe(display(change.before,change.field))}}</td><td>{{safe(display(change.after,change.field))}}</td></tr></tbody></Table></div>
    <p v-else>{{record.status==='pending'?'操作尚未取得结果，待核验。':'未记录字段变化；立即执行等动作可能不修改配置。'}}</p>
    <p v-if="record.status!=='succeeded'" class="ar-warning">以下是已保存状态的变化，不能据此推断原生写入或业务执行成功。</p>
    <template v-if="record.requested&&Object.keys(record.requested).length"><h4>请求修改内容</h4><pre>{{safe(JSON.stringify(record.requested,null,2))}}</pre></template>
    <details><summary>来源与指派依据</summary><dl><template v-for="[label,value] in evidence(record)" :key="label"><dt>{{label}}</dt><dd>{{safe(display(value))}}</dd></template></dl></details>
   </details>
   <nav class="ar-audit-pagination" aria-label="审计分页"><Button v-if="offset" variant="outline" @click="go(Math.max(0,offset-25))">上一页</Button><Button v-if="page?.nextOffset!=null" variant="outline" @click="go(page.nextOffset)">下一页</Button></nav>
  </template>
 </section>
</template>
