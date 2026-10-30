<script setup lang="ts">
import {ref,reactive,computed,onMounted,onBeforeUnmount} from 'vue';
import {Button,Table,Input,NativeSelect,AdvancedFilters,HelpTip,Dialog} from '@openclaw-plugins/control-ui-kit';
import {auditFeatures,statuses,actions,fields,display,type AuditOptions,type AuditPage,type AuditRecord} from './audit-model';
const props=defineProps<AuditOptions>();
const safe=(value:unknown)=>props.safe?.(value)??String(value??'');
const selected=ref<AuditRecord>();
const offset=ref(0),page=ref<AuditPage|null>(null),error=ref(''),loading=ref(false);
const filters=reactive<Record<string,string>>({feature:props.feature??'',targetId:props.targetId??'',status:'',actorId:'',action:'',from:'',to:''});
const advanced=reactive({...filters}),advancedCount=computed(()=>textFilters.filter(([name])=>filters[name!]&&!(name==='targetId'&&props.targetId)).length);
function applyAdvanced(){Object.assign(filters,advanced);submit();}
function resetAdvanced(){Object.assign(advanced,{...filters,actorId:'',action:'',targetId:props.targetId??'',from:'',to:''});}
let alive=true,epoch=0;
async function query(){
 selected.value=undefined;const token=++epoch;loading.value=true;error.value='';
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
  <header class="ar-section-heading"><div><h2>{{targetId?'修改日志':'审计'}}</h2><p>查看发起人、执行入口、修改前后值和操作结果。</p></div><div class="ar-heading-actions"><HelpTip title="审计记录说明"><p>{{safe(page?.notice??'审计自启用后记录。旧记录缺失的实名、指派依据和前后值不可推测补全。成功仅表示管理操作完成。')}}</p></HelpTip><Button variant="outline" @click="query">刷新审计</Button></div><Button v-if="onClose" variant="ghost" @click="onClose">关闭</Button></header>
  <div class="ar-list-toolbar"><form class="ar-quick-filters" @submit.prevent="submit">
   <label>功能<NativeSelect v-model="filters.feature" aria-label="功能" :disabled="!!feature"><option value="">全部功能</option><option v-for="(label,key) in auditFeatures" :key="key" :value="key">{{label}}</option></NativeSelect></label>
   <label>操作结果<NativeSelect v-model="filters.status" aria-label="操作结果"><option value="">全部结果</option><option v-for="(label,key) in statuses" :key="key" :value="key">{{label}}</option></NativeSelect></label>
   <Button type="submit" variant="outline" :disabled="loading">筛选</Button></form>
   <AdvancedFilters :session-scoped="false" title="审计高级筛选" :count="advancedCount" :disabled="loading" @open="Object.assign(advanced,filters)" @apply="applyAdvanced" @reset="resetAdvanced"><label v-for="[name,label,type] in textFilters" :key="name">{{label}}<Input v-model="advanced[name!]" :aria-label="label" :type="type" :disabled="name==='targetId'&&!!targetId"/></label></AdvancedFilters>
   <span v-if="advancedCount" class="ar-filter-summary" role="status">已应用 {{advancedCount}} 项高级条件</span>
  </div>
  <p v-if="page?.unavailable?.length" class="ar-warning">部分来源不可读取：{{safe(page.unavailable.join('、'))}}</p>
  <p v-if="error" role="alert" class="ar-error">{{error}}</p>
  <p v-else-if="loading">正在读取审计…</p>
  <template v-else>
   <p>共 {{page?.total??0}} 条审计记录</p><p v-if="!page?.records?.length">此筛选范围暂无审计记录。</p>
   <div v-if="page?.records?.length" class="ar-audit-table-wrap"><Table class="ar-audit-table"><caption class="ocp:sr-only">审计记录列表</caption><thead><tr><th>时间</th><th>对象 / 操作</th><th>发起人</th><th>结果</th><th/></tr></thead><tbody><tr v-for="record in page.records" :key="record.id"><td class="ar-audit-time">{{safe(new Date(record.at).toLocaleString())}}</td><td><Button variant="link" class="ar-audit-target" :aria-label="'查看审计 '+safe(record.targetName)" aria-haspopup="dialog" @click="selected=record">{{safe(record.targetName)}}</Button><span class="ar-audit-action">{{safe(actions[record.action]??record.action)}}</span></td><td>{{safe(record.actor?.name??record.actor?.id??(record.actor?.kind==='system'?'系统':'身份未记录'))}}</td><td><span class="ar-audit-status" :data-status="record.status">{{safe(statuses[record.status]??record.status)}}</span></td><td><Button variant="ghost" size="sm" :aria-label="'审计详情 '+safe(record.targetName)" @click="selected=record">详情</Button></td></tr></tbody></Table></div>
   <Dialog size="detail" :session-scoped="false" :open="!!selected" title="审计详情" content-class="ar-audit-detail" @update:open="value=>{if(!value)selected=undefined}"><template v-if="selected"><h3>{{safe(selected.targetName)}}</h3><p class="ar-meta">{{safe(new Date(selected.at).toLocaleString()+' · '+(actions[selected.action]??selected.action)+' · '+(statuses[selected.status]??selected.status))}}</p>
    <p>{{safe('发起指派：'+(selected.actor?.name??selected.actor?.id??'身份未记录')+' · 执行入口：'+(selected.executor??'未记录'))}}</p>
    <div v-if="selected.changes?.length" class="ocp:overflow-x-auto"><Table><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody><tr v-for="(change,index) in selected.changes" :key="index"><td>{{safe(fields[change.field]??change.field)}}</td><td>{{safe(display(change.before,change.field))}}</td><td>{{safe(display(change.after,change.field))}}</td></tr></tbody></Table></div>
    <p v-else>{{selected.status==='pending'?'操作尚未取得结果，待核验。':'未记录字段变化；立即执行等动作可能不修改配置。'}}</p>
    <p v-if="selected.status!=='succeeded'" class="ar-warning">以下是已保存状态的变化，不能据此推断原生写入或业务执行成功。</p>
    <template v-if="selected.requested&&Object.keys(selected.requested).length"><h4>请求修改内容</h4><pre>{{safe(JSON.stringify(selected.requested,null,2))}}</pre></template>
    <details><summary>来源与指派依据</summary><dl><template v-for="[label,value] in evidence(selected)" :key="label"><dt>{{label}}</dt><dd>{{safe(display(value))}}</dd></template></dl></details></template></Dialog>

   <nav class="ar-audit-pagination" aria-label="审计分页"><Button v-if="offset" variant="outline" @click="go(Math.max(0,offset-25))">上一页</Button><Button v-if="page?.nextOffset!=null" variant="outline" @click="go(page.nextOffset)">下一页</Button></nav>
  </template>
 </section>
</template>
