<script setup lang="ts">
import {computed,ref,watch,useId} from 'vue';
import {Button,useHostContext} from '@openclaw-plugins/control-ui-kit';
import {managementModules} from './management-model';
import {useManagementRequest} from './management-request';
import OverviewView from './OverviewView.vue';
import WorkerTasks from './WorkerTasks.vue';
import AuditView from './AuditView.vue';
import RecycleView from './RecycleView.vue';
import EntitiesView from './EntitiesView.vue';
import ProjectsView from './ProjectsView.vue';
import LogsView from './LogsView.vue';
import type {AuditPage} from './audit-model';
const context=useHostContext(),regionId=useId(),section=ref('overview'),revision=ref(0),projects=ref<InstanceType<typeof ProjectsView>>();
const safe=(value:unknown)=>context.value.host.redact(String(value??''));
const agentId=computed(()=>context.value.props.agentId??context.value.host.agents.selectedId??context.value.host.connection.assistantAgentId??context.value.host.agents.defaultId??'');
const knownAgent=computed(()=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId.value));
const agents=computed(()=>{const rows=[...(context.value.host.agents.rows??[])];if(agentId.value&&!rows.some(a=>a.id===agentId.value))rows.push({id:agentId.value,name:agentId.value});return rows;});
const request=useManagementRequest(context,()=>agentId.value);
const key=computed(()=>[agentId.value,context.value.host.connection.canRead,context.value.host.connection.canWrite,section.value,revision.value].join(':'));
const currentModule=computed(()=>managementModules.find(item=>item.id===section.value)!);
function choose(id:string){if(managementModules.some(m=>m.id===id))section.value=id;}
watch(()=>context.value.props.section,value=>{if(value==='people')choose('entities');else if(value)choose(value);},{immediate:true});
function selectAgent(event:Event){const id=(event.target as HTMLSelectElement).value;context.value.host.agents.select(id);if(context.value.props.agentId)context.value.host.navigation.openPage({id:'management',params:{agentId:id,section:section.value}});}
const auditInvoke=(action:string,payload:Record<string,unknown>)=>request.invoke<AuditPage>(action,payload);
function restored(){revision.value++;}
defineExpose({refreshFromUpdate:()=>projects.value?.refreshFromUpdate()});
</script>
<template>
 <section class="ar-management" data-ocp-ui aria-label="AgentRepo 管理中心" :data-section="section">
  <header class="ar-management-header"><div><h1>AgentRepo</h1></div><label class="ar-management-agent"><span>当前 Agent</span><select aria-label="AgentRepo 所属 Agent" :value="agentId" @change="selectAgent"><option v-for="agent in agents" :key="agent.id" :value="agent.id">{{safe(agent.name??agent.id)}}</option></select></label></header>
  <template v-if="context.presented">
   <p v-if="!context.host.connection.canRead" role="alert" class="ar-error">需要 operator.read 权限才能查看 AgentRepo。</p>
   <p v-else-if="!knownAgent">请先选择一个 Agent。</p>
   <template v-else>
    <nav class="ar-management-nav" aria-label="AgentRepo 功能模块"><Button v-for="item in managementModules" :key="item.id" variant="ghost" :data-section="item.id" :aria-controls="regionId" :aria-current="section===item.id?'page':'false'" @click="choose(item.id)">{{item.label}}</Button></nav>
    <div :id="regionId" class="ar-management-body" role="region" :aria-label="currentModule.label+'内容'">
     <OverviewView :key="key" v-if="section==='overview'" :agent-id="agentId" :choose="choose" />
     <WorkerTasks :key="key" v-else-if="section==='worker'" :agent-id="agentId" />
     <AuditView :key="key" v-else-if="section==='audit'" :invoke="auditInvoke" :safe="safe" />
     <EntitiesView :key="key" v-else-if="section==='entities'" :agent-id="agentId" embedded/><LogsView :key="key" v-else-if="section==='logs'" :agent-id="agentId"/><ProjectsView ref="projects" :key="key" v-else :agent-id="agentId" :mode="section"/>
    </div>
    <RecycleView :key="agentId+':'+context.host.connection.canWrite" :agent-id="agentId" :on-restored="restored" />
   </template>
  </template>
 </section>
</template>
