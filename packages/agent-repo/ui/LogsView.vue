<script setup lang="ts">
import {ref} from 'vue';
import {Button,Dialog,useHostContext,PageHeader} from '@openclaw-plugins/control-ui-kit';
import LogConsole from './LogConsole.vue';
import AuditView from './AuditView.vue';
import type {AuditPage} from './audit-model';
import {useDiagnosticRequest} from './diagnostic-request';
const props=defineProps<{agentId:string;sessionKey?:string;embedded?:boolean}>();
const context=useHostContext(),request=useDiagnosticRequest(context,props.agentId,props.sessionKey),audit=ref(false);
const safe=(v:unknown)=>context.value.host.redact(String(v??''));
const auditInvoke=(action:string,payload:Record<string,unknown>)=>request.invoke<AuditPage>(action,payload);
</script>
<template><section class="ar-logs-view"><PageHeader :title="embedded?undefined:'日志'" :description="embedded?undefined:'统一查看插件与 Worker 日志；实时调试默认关闭。'" class="ar-section-heading"><Button variant="outline" @click="audit=true">查看审计</Button></PageHeader><LogConsole :invoke="request.invoke" :safe="safe" :agent-id="agentId" :can-write="()=>context.host.connection.canWrite===true" :signal="context.signal"/><Dialog size="wide" v-model:open="audit" title="日志修改审计"><AuditView v-if="audit" :invoke="auditInvoke" :safe="safe" feature="logs"/></Dialog></section></template>
