<script setup lang="ts">
import {ref,reactive,computed,onMounted,onBeforeUnmount} from 'vue';
import {Button,useHostContext} from '@openclaw-plugins/control-ui-kit';
import {useManagementRequest} from './management-request';
import {managementModules} from './management-model';
import type {CatalogOverview,PeopleOverview,MaintenanceOverview,OverviewValues,OverviewSource} from './overview-model';
import type {AgentTaskPage} from './worker-model';
import WorkerSummary from './WorkerSummary.vue';
const props=defineProps<{agentId:string;choose:(section:string)=>void}>();
const context=useHostContext(),repo=useManagementRequest(context,()=>props.agentId),worker=useManagementRequest(context,()=>props.agentId,'agent-worker','inspect-');
const values=reactive<OverviewValues>({}),errors=reactive<Partial<Record<OverviewSource,string>>>({}),loading=ref(true),loadedAt=ref('');
let generation=0;
const safe=(value:unknown)=>context.value.host.redact(String(value??''));
async function refresh(){
 const token=++generation,valid=repo.capture();loading.value=true;for(const key of Object.keys(values) as OverviewSource[])delete values[key];for(const key of Object.keys(errors) as OverviewSource[])delete errors[key];
 async function load<T>(key:OverviewSource,promise:Promise<T>,assign:(value:T)=>void){try{const value=await promise;if(valid()&&token===generation)assign(value);}catch(e){if(valid()&&token===generation)errors[key]=safe(e instanceof Error?e.message:e);}}
 await Promise.allSettled([
  load('catalog',repo.invoke<CatalogOverview>('list',{}),v=>values.catalog=v),load('people',repo.invoke<PeopleOverview>('people',{}),v=>values.people=v),
  load('entities',repo.invoke<{total:number}>('entityTypes',{}),v=>values.entities=v),load('logs',repo.invoke<{records:unknown[]}>('repositoryLogs',{}),v=>values.logs=v),
  load('worker',worker.invoke<AgentTaskPage>('agentTasks',{}),v=>values.worker=v),load('maintenance',repo.invoke<MaintenanceOverview>('maintenance',{}),v=>values.maintenance=v),
 ]);
 if(!valid()||token!==generation)return;loading.value=false;loadedAt.value=new Date().toISOString();
}
const count=(source:OverviewSource,value:unknown)=>errors[source]?'不可读取':values[source]?String(value):'—';
const metrics=computed(()=>[
 {label:'登记项目',count:count('catalog',values.catalog?.projects?.length),note:'已登记在项目清单中的仓库',module:'projects'},
 {label:'实体资料',count:count('entities',values.entities?.total),note:'人员、组织、服务与资产统一管理',module:'entities'},
 {label:'定时任务',count:count('catalog',values.catalog?.scheduledTasks?.length),note:'同步与 OpenClaw 联动任务',module:'tasks'},
 {label:'异常记录',count:count('logs',values.logs?.records?.length),note:'最近保留的仓库异常，最多 100 条',module:'logs'},
]);
const issues=computed(()=>{
 const result:{title:string;detail:string;module:string}[]=[];
 const add=(title:string,detail:string,module:string)=>result.push({title,detail,module});
 for(const [key,module,label] of [['catalog','projects','项目清单'],['people','entities','人员资料'],['entities','entities','实体资料'],['logs','logs','日志']] as const)if(errors[key])add(label+'读取失败',errors[key]!,module);
 if(errors.maintenance)add('技能维护状态不可读取',errors.maintenance,'projects');
 for(const p of values.maintenance?.providers??[])if(['unavailable','fallback','degraded'].includes(p.state))add(safe(p.label)+'需处理',safe(p.scope)+' · '+({unavailable:'不可读取',fallback:'正在使用已验证旧版',degraded:'检查或更新失败'} as Record<string,string>)[p.state],'projects');
 const d=values.worker?.diagnostics;if(d?.deliveryUncertain)add(d.deliveryUncertain+' 个投递结果待核查','Main 可能已经执行，先查看原任务及事件回执。','worker');if(d?.awaitingMainOverdue)add(d.awaitingMainOverdue+' 个任务等待 Main 超过 30 分钟','等待时间仅用于提醒，不代表任务失败。','worker');
 if(values.catalog&&!values.catalog.registrationCommitted)add('项目登记尚未提交','登记需提交后才能用于正式的项目准备与技能检查。','projects');
 if(values.people?.stats?.missing?.email)add(values.people.stats.missing.email+' 位人员缺少邮箱','可从实体资料库的人员资源查看来源和账号关联。','entities');
 if(values.people?.stats?.giteaSources?.email_prefix)add(values.people.stats.giteaSources.email_prefix+' 个账号关联待核验','邮箱推导的候选账号需要核验后再用于人员归属。','entities');
 if(values.logs?.records?.length)add('有 '+values.logs.records.length+' 条保留的异常记录','历史记录可能已处理，请结合时间与原因判断。','logs');
 return result;
});
const info=computed(()=>{
 const c=values.catalog,s=c?.agentSkills,tasks=c?.scheduledTasks;
 return [['Agent 工作区',c?.root??(errors.catalog?'不可读取':'读取中…')],['项目登记',c?(c.registrationCommitted?'已提交':'待提交'):'—'],['角色技能',s?.state==='unavailable'?'不可扫描':s?s.skills.length+' 项 · 不含项目技能':'—'],['定时任务',tasks?(tasks.length?tasks.filter(t=>t.enabled).length+' 项启用 / '+tasks.length+' 项总计':'尚未配置定时计划'):'—']];
});
const label=(id:string)=>managementModules.find(item=>item.id===id)?.label??id;
onMounted(refresh);onBeforeUnmount(()=>{generation++;});
</script>
<template>
 <section class="ar-overview" data-ocp-ui aria-label="AgentRepo 运行概览" :aria-busy="loading">
  <header class="ar-overview-heading ar-section-heading"><div><h2>管理概览</h2><p class="ar-description">当前 Agent 的资源、计划与待处理事项。</p></div><div class="ar-overview-tools"><span class="ar-meta" role="status">{{loading?'正在读取…':Object.values(errors).length?'部分数据不可用':'更新于 '+new Date(loadedAt).toLocaleString()}}</span><Button variant="outline" :disabled="loading" @click="refresh">刷新概览</Button></div></header>
  <div class="ar-management-metrics" aria-label="AgentRepo 资源统计"><button v-for="metric in metrics" :key="metric.module" type="button" class="ar-metric" :aria-label="'打开'+label(metric.module)" @click="choose(metric.module)"><span class="ar-metric-label">{{metric.label}}</span><strong>{{metric.count}}</strong><span class="ar-metric-note">{{metric.note}}</span></button></div>
  <WorkerSummary :value="values.worker" :error="errors.worker" :loading="loading" :safe="safe" :open="()=>choose('worker')" />
  <div class="ar-overview-columns"><section class="ar-overview-card"><h3>待处理事项</h3><p class="ar-description">基于本次读取结果，不代替完整健康检查。</p><div v-for="(issue,index) in issues" :key="index" class="ar-attention-row"><div><strong>{{issue.title}}</strong><p>{{issue.detail}}</p></div><Button variant="ghost" size="sm" @click="choose(issue.module)">查看{{label(issue.module)}}</Button></div><p v-if="!issues.length" class="ar-empty-note">{{loading?'正在检查待处理事项…':'本次读取未发现上述待处理事项。'}}</p></section><section class="ar-overview-card"><h3>工作区与计划</h3><div v-for="[name,value] in info" :key="name" class="ar-overview-info"><span>{{name}}</span><span>{{safe(value)}}</span></div><p class="ar-description">这里只读取状态；刷新不会拉取仓库、执行任务或同步飞书人员。</p></section></div>
  <section class="ar-overview-shortcuts"><h3>管理模块</h3><div class="ar-management-cards"><section v-for="item in managementModules.slice(1)" :key="item.id"><div><h4>{{item.label}}</h4><p>{{item.description}}</p></div><Button variant="ghost" size="sm" @click="choose(item.id)">打开{{item.label}}</Button></section></div></section>
 </section>
</template>
