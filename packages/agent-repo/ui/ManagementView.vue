<script setup lang="ts">
import {computed,ref,watch,useId} from 'vue';
import {Button,useHostContext,StatusNotice,PageHeader,NativeSelect} from '@openclaw-plugins/control-ui-kit';
import {managementModules} from './management-model';
import {useManagementRequest} from './management-request';
import OverviewView from './OverviewView.vue';
import WorkerTasks from './WorkerTasks.vue';
import AuditView from './AuditView.vue';
import RecycleView from './RecycleView.vue';
import EntitiesView from './EntitiesView.vue';
import AuthorizationView from './AuthorizationView.vue';
import ProjectsView from './ProjectsView.vue';
import KnowledgeView from './KnowledgeView.vue';
import LogsView from './LogsView.vue';
import type {AuditPage} from './audit-model';
const context=useHostContext(),regionId=useId(),section=ref('overview'),revision=ref(0),projects=ref<InstanceType<typeof ProjectsView>>();
const safe=(value:unknown)=>context.value.host.redact(String(value??''));
const agentId=computed(()=>context.value.props.agentId??context.value.host.agents.selectedId??context.value.host.connection.assistantAgentId??context.value.host.agents.defaultId??'');
const knownAgent=computed(()=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId.value));
const request=useManagementRequest(context,()=>agentId.value);
const key=computed(()=>[agentId.value,context.value.host.connection.canRead,context.value.host.connection.canWrite,section.value,revision.value].join(':'));
const currentModule=computed(()=>managementModules.find(item=>item.id===section.value)!);
const moduleIcons:Record<string,string>={authorization:'M12 3l8 4v6c0 5-8 9-8 9s-8-4-8-9V7z',overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',projects:'M3 7V4h6l2 3h10v13H3z',worker:'M8 3h8v4H8z M5 7h14v14H5z M9 12h6 M9 16h4',entities:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 8v6 M17 11h6',knowledge:'M12 6C9 3 5 3 2 4v16c4-1 7-1 10 1 3-2 6-2 10-1V4c-3-1-7-1-10 2z M12 6v15',tasks:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 6v6l4 2',audit:'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4',logs:'M3 4h18v16H3z M7 8l4 4-4 4 M13 16h4'};
function choose(id:string){if(managementModules.some(m=>m.id===id))section.value=id;}
watch(()=>context.value.props.section,value=>{if(value==='people')choose('entities');else if(value)choose(value);},{immediate:true});
const auditInvoke=(action:string,payload:Record<string,unknown>)=>request.invoke<AuditPage>(action,payload);
function restored(){revision.value++;}
defineExpose({refreshFromUpdate:()=>projects.value?.refreshFromUpdate()});
</script>
<template>
 <section class="ar-management" data-ocp-ui aria-label="AgentRepo 管理中心" :data-section="section">
  <template v-if="context.presented">
   <StatusNotice compact tone="error" v-if="!context.host.connection.canRead" role="alert" class="ar-error">需要 operator.read 权限才能查看 AgentRepo。</StatusNotice>
   <p v-else-if="!knownAgent">请先选择一个 Agent。</p>
   <template v-else>
    <div class="ar-management-shell">
     <aside class="ar-management-sidebar" aria-label="管理中心导航">
      <PageHeader class="ar-management-header" title="AgentRepo" heading="h1" />
      <span class="ar-management-caption">管理中心</span>
      <nav class="ar-management-nav" aria-label="AgentRepo 功能模块"><Button v-for="item in managementModules" :key="item.id" variant="ghost" :data-section="item.id" :title="item.label" :aria-controls="regionId" :aria-current="section===item.id?'page':'false'" @click="choose(item.id)"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path :d="moduleIcons[item.id]" /></svg><span>{{item.label}}</span></Button></nav>
      <div class="ar-management-mobile-nav"><NativeSelect aria-label="管理中心模块" :model-value="section" @update:model-value="value=>choose(String(value))"><option v-for="item in managementModules" :key="item.id" :value="item.id">{{item.label}}</option></NativeSelect></div>
      <div class="ar-management-utilities"><RecycleView :key="agentId+':'+context.host.connection.canWrite" :agent-id="agentId" :on-restored="restored" /></div>
     </aside>
    <div :id="regionId" class="ar-management-body" role="region" :aria-label="currentModule.label+'内容'">
     <OverviewView :key="key" v-if="section==='overview'" :agent-id="agentId" :choose="choose" />
     <AuthorizationView :key="key" v-else-if="section==='authorization'" :agent-id="agentId"/>
     <KnowledgeView :key="key" v-else-if="section==='knowledge'" :agent-id="agentId" />
     <WorkerTasks :key="key" v-else-if="section==='worker'" :agent-id="agentId" />
     <AuditView :key="key" v-else-if="section==='audit'" :invoke="auditInvoke" :safe="safe" />
     <EntitiesView :key="key" v-else-if="section==='entities'" :agent-id="agentId" embedded/><LogsView :key="key" v-else-if="section==='logs'" :agent-id="agentId"/><ProjectsView ref="projects" :key="key" v-else :agent-id="agentId" :mode="section"/>
    </div>
    </div>
   </template>
  </template>
 </section>
</template>
