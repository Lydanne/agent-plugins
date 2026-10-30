<script setup lang="ts">
import {computed} from 'vue';
import {statusLabels,time,type SessionRow} from './models';
import Information from './Information.vue';
const props=defineProps<{session?:SessionRow|null;agentId?:string;redact:(value:string)=>string}>();
const safe=(value:unknown)=>props.redact(String(value??''));
const fields=computed(():[string,unknown][]=>{const s=props.session;if(!s)return [];return [['会话主题',safe(s.topic)],['运行目录',s.workspacePending?'等待分配 workspace':s.cwd?safe(s.cwd):'未记录运行目录'],['目录类型',s.workspacePending?'workspace（待分配）':s.cwd?(s.directoryKind==='workspace'?'独立 workspace':'项目目录'):'未知'],['执行模型',safe(s.model?(s.harness??'codex')+' / '+s.model:'旧会话未记录模型')],['会话标识',s.sessionId?safe(s.sessionId):'尚无可读取的 Worker 会话标识'],['所属聊天','当前聊天'],['Main',safe(props.agentId)],['整体状态',statusLabels[s.status]??s.status],['当前进度',safe(s.progress)],['会话热度',String(s.heat)],['有效交互',`${s.interactionCount} 次`],['任务总数',`${s.taskCount} 个`],['进行中',`${s.activeCount??0} 个任务 · 运行 ${s.runningCount??0} · 排队 ${s.queuedCount??0} · 等待 Main ${s.awaitingMainCount??0} · 等待用户 ${s.awaitingUserCount??0}`],['首次任务',time(s.createdAt)],['最近活动',time(s.updatedAt)]];});
</script>
<template><template v-if="session"><Information :fields="fields"/><div class="cq-session-tags"><h3>会话标签</h3><div class="cq-expanded-tags"><span v-for="tag in session.tags" :key="tag">{{redact(tag)}}</span><span v-if="!session.tags.length">暂无标签</span></div></div><p class="cq-muted">热度按任务受理及 Worker 完成计算，7 天半衰期；查询和心跳不增加热度。</p></template><p v-else class="cq-muted">没有可读取的会话基础信息。</p></template>
