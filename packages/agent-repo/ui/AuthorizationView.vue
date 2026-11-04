<script setup lang="ts">
import {ref,watch,computed} from 'vue';
import {Button,Input,NativeSelect,PageHeader,StatusNotice,useHostContext} from '@openclaw-plugins/control-ui-kit';
import {useManagementRequest} from './management-request';
interface Row {id:string;revision:number;name?:string;status?:string;groupId?:string;entityId?:string;entityType?:string;membership?:string;kind?:string;effect?:string;actions?:string[];[key:string]:unknown}
interface Catalog {agentId:string;mode:string;canAdmin:boolean;actions:string[];groups:Row[];resources:Row[];rules:Row[];bindings:Row[];audit:Row[];policyVersions?:Row[]}
const props=defineProps<{agentId:string}>(),context=useHostContext(),request=useManagementRequest(context,()=>props.agentId,'agent-repo','authorization-');
const data=ref<Catalog|null>(null),error=ref(''),busy=ref(false),section=ref<'groups'|'resources'|'rules'|'bindings'|'audit'|'simulate'>('groups');
const editing=ref<Row|null>(null),name=ref(''),group=ref('internal'),entity=ref(''),entityType=ref('person'),membership=ref('self'),status=ref('active');
const effect=ref('allow'),ruleKind=ref('explicit'),actions=ref<string[]>([]),resourceIds=ref('');
const conditions=ref<Record<string,string>>({});
const parameterRules=ref('[]');
watch(editing,row=>{parameterRules.value=JSON.stringify(row?.parameters??[],null,2);});
const selectors=ref<Record<string,string>>({});
const selectorLabels:Record<string,string>={kinds:'资源类型',providers:'提供方',labels:'必须具备的分类标签'};
watch(editing,row=>{selectors.value=Object.fromEntries(Object.entries((row?.selector??{}) as Record<string,string[]>).filter(([key])=>key!=='resourceIds').map(([key,values])=>[key,values.join(',')]));});
const conditionLabels:Record<string,string>={destinationHost:'目标域名',destinationOrigin:'目标来源（协议与端口）',protocol:'协议',projectId:'项目',environment:'环境',accountId:'账号',access:'操作性质',atomicity:'原子性',recovery:'可恢复性',idempotency:'幂等性',externalEffect:'外部影响',sensitivity:'数据敏感度'};
interface DefaultPreview {resourceId:string;revision:string;before:unknown[];after:unknown[]}
const defaultPreview=ref<DefaultPreview|null>(null),reviewing=ref<Row|null>(null);
const reviewReady=computed(()=>{const behavior=reviewing.value?.behavior as Record<string,unknown>|undefined;return !!behavior&&['read','write','mixed'].includes(String(behavior.access))&&['none','present'].includes(String(behavior.externalEffect))&&['ordinary','sensitive','restricted'].includes(String(behavior.sensitivity));});
async function confirmReview(){if(!reviewing.value||!canEdit.value||!reviewReady.value)return;const valid=request.capture(),row=reviewing.value;busy.value=true;error.value='';try{await request.invoke('review',{resourceId:row.id,expectedRevision:row.revision,confirmed:true});if(!valid())return;reviewing.value=null;await refresh();}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}}
async function previewDefaults(row:Row){if(!canEdit.value)return;const valid=request.capture();busy.value=true;error.value='';try{const result=await request.invoke<DefaultPreview>('previewDefaults',{resourceId:row.id});if(valid())defaultPreview.value=result;}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}}
async function recomputeDefaults(){if(!defaultPreview.value||!canEdit.value)return;const valid=request.capture();busy.value=true;error.value='';try{await request.invoke('recomputeDefaults',{resourceId:defaultPreview.value.resourceId,expectedRevision:defaultPreview.value.revision});if(!valid())return;defaultPreview.value=null;await refresh();}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}}
const scanSummary=ref('');
const resourceLabels=ref(''),behavior=ref<Record<string,string>>({});
const behaviorChoices:Record<string,string[]>={access:['unknown','read','write','mixed'],atomicity:['unknown','guaranteed','not-guaranteed','not-applicable'],recovery:['unknown','reversible','compensatable','irreversible','not-applicable'],idempotency:['unknown','guaranteed','not-guaranteed','not-applicable'],externalEffect:['unknown','none','present'],sensitivity:['unknown','ordinary','sensitive','restricted']};
const labels:Record<string,string>={groups:'权限组',resources:'权限资源',rules:'授权与默认策略',bindings:'实体绑定',audit:'审计',simulate:'权限模拟'};
const rows=computed(()=>section.value==='simulate'?[]:data.value?.[section.value]??[]);
const simulatePerson=ref(''),simulateResource=ref(''),simulateAction=ref('read'),simulation=ref<unknown>(null);
const simulationContext=ref<Record<string,string>>({}),simulationParameters=ref('{}');
const simulationFields:Record<string,string>={projectId:'项目',environment:'环境',accountId:'账号',destinationHost:'目标域名',destinationOrigin:'目标来源',protocol:'协议'};
async function simulate(){
 if(!canEdit.value)return;const valid=request.capture();busy.value=true;error.value='';simulation.value=null;
 try{
  const parameters:unknown=JSON.parse(simulationParameters.value);
  if(parameters===null||typeof parameters!=='object'||Array.isArray(parameters))throw Error('调用参数必须是 JSON 对象');
  const result=await request.invoke('simulate',{entityId:simulatePerson.value,requirements:[{resourceId:simulateResource.value,action:simulateAction.value}],context:Object.fromEntries(Object.entries(simulationContext.value).filter(([,value])=>value.trim()).map(([key,value])=>[key,value.trim()])),parameters});
  if(valid())simulation.value=result;
 }catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}
}
const canEdit=computed(()=>data.value?.canAdmin===true&&!busy.value);
async function refresh(){const valid=request.capture();busy.value=true;error.value='';try{const value=await request.invoke<Catalog>('catalog',{});if(valid()){if(value.agentId!==props.agentId)throw Error('权限资料来源不一致');data.value=value;}}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}}
watch(()=>props.agentId,()=>{data.value=null;editing.value=null;defaultPreview.value=null;reviewing.value=null;scanSummary.value='';simulation.value=null;simulationContext.value={};simulationParameters.value='{}';simulatePerson.value='';simulateResource.value='';void refresh();},{immediate:true});
function edit(row?:Row){editing.value=row?{...row}:{id:crypto.randomUUID(),revision:0};name.value=String(row?.name??'');group.value=String(row?.groupId??'internal');entity.value=String(row?.entityId??'');entityType.value=String(row?.entityType??'person');membership.value=String(row?.membership??'self');status.value=String(row?.status??'active');effect.value=String(row?.effect??'allow');ruleKind.value=String(row?.kind??'explicit');actions.value=[...(row?.actions??[])];const selector=row?.selector as {resourceIds?:string[]}|undefined;resourceIds.value=selector?.resourceIds?.join('\n')??'';resourceLabels.value=((row?.labels??[]) as string[]).join(',');behavior.value={...((row?.behavior??{}) as Record<string,string>)};conditions.value=Object.fromEntries(Object.entries((row?.conditions??{}) as Record<string,string[]>).map(([key,values])=>[key,values.join(',')]));}
const defaultPresets=[{id:'read',label:'普通只读'},{id:'atomic',label:'原子性写入'},{id:'reversible',label:'可撤销写入'},{id:'atomic-reversible',label:'原子且可撤销写入'}];
function applyDefaultPreset(id:string){
 ruleKind.value='default';effect.value='allow';
 const read=id==='read';
 actions.value=read?['discover','read','execute']:['discover','execute','create','update','delete'];
 conditions.value={...conditions.value,access:read?'read':'write',sensitivity:'ordinary',externalEffect:'none',atomicity:id.includes('atomic')?'guaranteed':'',recovery:id.includes('reversible')?'reversible':''};
}
function editGroupDefaults(row:Row){section.value='rules';edit();group.value=row.id;ruleKind.value='default';applyDefaultPreset('read');}
async function save(){if(!editing.value||!canEdit.value)return;const valid=request.capture(),row=editing.value;let value:Record<string,unknown>;
 if(section.value==='rules')try{const parameters:unknown=JSON.parse(parameterRules.value);if(!Array.isArray(parameters))throw Error('参数约束必须是数组');row.parameters=parameters;}catch(e){error.value=String(e);return;}
 if(section.value==='resources'){busy.value=true;try{await request.invoke('classify',{resourceId:row.id,expectedRevision:row.revision,labels:resourceLabels.value.split(',').map(v=>v.trim()).filter(Boolean),behavior:behavior.value});if(!valid())return;editing.value=null;await refresh();}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}return;}
 if(section.value==='groups')value={...row,name:name.value,status:status.value};
 else if(section.value==='bindings')value={...row,groupId:group.value,entityId:entity.value,entityType:entityType.value,membership:entityType.value==='person'?'self':entityType.value==='organization'?'members':membership.value,status:status.value};
 else {const ids=resourceIds.value.split(/\s+/).filter(Boolean);value={...row,groupId:group.value,kind:ruleKind.value,effect:effect.value,actions:actions.value,selector:{...Object.fromEntries(Object.entries(selectors.value).filter(([,value])=>value.trim()).map(([key,value])=>[key,value.split(',').map(item=>item.trim()).filter(Boolean)])),...(ids.length?{resourceIds:ids}:{})},conditions:Object.fromEntries(Object.entries(conditions.value).filter(([,value])=>value.trim()).map(([key,value])=>[key,value.split(',').map(item=>item.trim()).filter(Boolean)]))};}
 busy.value=true;error.value='';try{await request.invoke('save',{kind:section.value,value,expectedRevision:row.revision});if(!valid())return;editing.value=null;await refresh();}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}}
async function publish(row:Row){if(!canEdit.value)return;const valid=request.capture();busy.value=true;error.value='';try{await request.invoke('publish',{id:row.id,expectedRevision:row.revision});if(valid())await refresh();}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}}
async function scan(){if(!canEdit.value)return;const valid=request.capture();busy.value=true;error.value='';try{const result=await request.invoke<{discovered:number;changed:number;complete:boolean;failures:Array<{scope:string;reason:string}>}>('scan',{});if(!valid())return;scanSummary.value=`发现 ${result.discovered} 项，变化 ${result.changed} 项。`+(result.complete?'扫描完成。':'部分范围未完成：'+result.failures.map(item=>item.scope+' '+item.reason).join('；'));await refresh();}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}}
async function mode(){if(!data.value||!canEdit.value)return;const valid=request.capture();busy.value=true;error.value='';try{await request.invoke('mode',{mode:data.value.mode==='audit'?'enforce':'audit'});if(valid())await refresh();}catch(e){if(valid())error.value=String(e);}finally{if(valid())busy.value=false;}}
</script>
<template>
 <section class="ar-authorization">
  <PageHeader title="权限中心" description="通过权限组管理组织、部门和个人交给 Worker 执行的能力；Main 沿用 OpenClaw 权限。"/>
  <StatusNotice v-if="error" tone="error">{{error}}</StatusNotice>
  <div v-if="data"><p>Worker 当前模式：{{data.mode==='audit'?'审计（记录判定，不拦截）':'强制（未授权操作会被拦截）'}}</p><Button v-if="data.canAdmin" variant="outline" :disabled="busy" @click="mode">{{data.mode==='audit'?'启用强制拦截':'切换为审计'}}</Button></div>
  <nav aria-label="权限管理分类"><Button v-for="(label,key) in labels" :key="key" variant="ghost" :aria-current="section===key?'page':undefined" @click="section=key as typeof section;editing=null">{{label}}</Button><Button variant="outline" :disabled="busy" @click="refresh">刷新</Button></nav>
  <Button v-if="section==='resources'&&canEdit" @click="scan">扫描当前能力</Button>
  <p v-if="section==='resources'&&scanSummary">{{scanSummary}}</p>
  <p v-if="section==='groups'">预置管理员组、内部组、外部组。实体只有通过绑定权限组才能获得授权。</p>
  <p v-if="section==='rules'">明确禁止优先。保存规则形成草稿，发布后生效。新增资源默认策略仅用于已核验且具备执行拦截的资源。</p>
  <Button v-if="canEdit&&['groups','rules','bindings'].includes(section)" @click="edit()">新增{{labels[section]}}</Button>
  <form v-if="editing" @submit.prevent="save">
   <label v-if="section==='groups'">名称<Input v-model="name" required/></label>
   <template v-else-if="section!=='resources'"><label>权限组<NativeSelect v-model="group"><option v-for="g in data?.groups" :key="g.id" :value="g.id">{{g.name}}</option></NativeSelect></label></template>
   <template v-if="section==='resources'"><label>分类标签（逗号分隔）<Input v-model="resourceLabels"/></label><label v-for="(choices,key) in behaviorChoices" :key="key">{{conditionLabels[key]}}<NativeSelect v-model="behavior[key]"><option v-for="choice in choices" :key="choice" :value="choice">{{choice}}</option></NativeSelect></label><p>分类修改不等于核验；通用工具需核验后执行，专用适配器保持自身约束。</p></template>
   <template v-if="section==='bindings'"><label>实体类型<NativeSelect v-model="entityType"><option value="person">个人</option><option value="department">部门</option><option value="organization">组织</option></NativeSelect></label><label>实体 ID<Input v-model="entity" required/></label><label v-if="entityType==='department'">覆盖范围<NativeSelect v-model="membership"><option value="members">直属成员</option><option value="descendants">包含下级部门</option></NativeSelect></label></template>
   <template v-if="section==='rules'"><label>策略类型<NativeSelect v-model="ruleKind"><option value="explicit">已有资源授权</option><option value="default">新增资源默认授权</option></NativeSelect></label><fieldset v-if="ruleKind==='default'"><legend>默认授权模板</legend><Button v-for="preset in defaultPresets" :key="preset.id" type="button" variant="outline" @click="applyDefaultPreset(preset.id)">{{preset.label}}</Button><p>模板仅允许普通数据且无外部副作用的操作。未匹配的写入与未知资源不自动授权；同时满足原子性与可撤销性可选组合模板。条件可在下方调整。</p></fieldset><label>效果<NativeSelect v-model="effect"><option value="allow">允许</option><option value="deny">明确禁止</option></NativeSelect></label><fieldset><legend>权限类型</legend><label v-for="action in data?.actions" :key="action"><input type="checkbox" v-model="actions" :value="action">{{action}}</label></fieldset><label>资源 ID（空格分隔；留空匹配全部资源）<Input v-model="resourceIds"/></label><fieldset><legend>授权条件（多个允许值用逗号分隔）</legend><label v-for="(label,key) in conditionLabels" :key="key">{{label}}<Input v-model="conditions[key]"/></label></fieldset></template>
   <label v-else-if="section!=='resources'">状态<NativeSelect v-model="status"><option value="active">启用</option><option value="disabled">停用</option></NativeSelect></label>
   <template v-if="section==='rules'"><fieldset><legend>资源范围（多值用逗号分隔）</legend><label v-for="(label,key) in selectorLabels" :key="key">{{label}}<Input v-model="selectors[key]" :aria-label="label"/></label><p>不同条件同时满足；分类标签要求全部具备。留空不限制该条件。</p></fieldset><label>参数约束（高级配置）<textarea v-model="parameterRules" aria-label="参数约束" rows="5"/></label><p>每项填写 path、op、value，所有约束必须同时满足。例如 [{"path":"limit","op":"max","value":100}] 限制单次数量。支持 equals、in、subset、present、max、min；空数组表示不限制参数。</p></template>
   <Button type="submit" :disabled="!canEdit">{{section==='rules'?'保存草稿':'保存'}}</Button><Button type="button" variant="outline" @click="editing=null">取消</Button>
  </form>
  <form v-if="section==='simulate'" @submit.prevent="simulate"><label>人员实体 ID<Input v-model="simulatePerson" required/></label><label>目标资源<NativeSelect v-model="simulateResource" required><option value="" disabled>选择资源</option><option v-for="r in data?.resources" :key="r.id" :value="r.id">{{r.name??r.id}}</option></NativeSelect></label><label>权限类型<NativeSelect v-model="simulateAction"><option v-for="a in data?.actions" :key="a" :value="a">{{a}}</option></NativeSelect></label><fieldset><legend>模拟执行上下文</legend><label v-for="(label,key) in simulationFields" :key="key">{{label}}<Input v-model="simulationContext[key]" :aria-label="'模拟'+label"/></label></fieldset><label>调用参数（JSON 对象）<textarea v-model="simulationParameters" aria-label="模拟调用参数" rows="5"/></label><p>这里只验证指定资源操作，不执行业务调用；模拟值不会替代真实执行时的可信上下文。</p><Button type="submit" :disabled="!canEdit">检查有效权限</Button><pre v-if="simulation">{{JSON.stringify(simulation,null,2)}}</pre></form>
  <section v-if="section==='rules'&&data?.policyVersions?.length" aria-label="策略版本"><h3>草稿与发布记录</h3><article v-for="version in data.policyVersions" :key="version.id"><p>{{version.status==='draft'?'待发布':'已发布'}} · {{version.id}}</p><details><summary>核对发布前后规则</summary><pre>{{JSON.stringify({before:version.before,after:version.rule},null,2)}}</pre></details><Button v-if="version.status==='draft'&&canEdit" @click="publish(version)">发布此规则</Button></article></section>
  <section v-if="reviewing&&section==='resources'" aria-label="工具分类核验"><h3>核验工具分类</h3><p>请核对当前定义和分类是否覆盖该工具全部行为。确认后应用权限组的新增资源默认策略。原子性、可撤销性由管理员依据实现核验；通用拦截控制调用入口，不提供沙箱或自动回滚。</p><pre>{{JSON.stringify({id:reviewing.id,definition:reviewing.definition,behavior:reviewing.behavior},null,2)}}</pre><p v-if="!reviewReady">请先编辑资源，明确操作性质、外部影响和数据敏感度。</p><Button :disabled="!canEdit||!reviewReady" @click="confirmReview">确认分类并启用</Button><Button variant="outline" @click="reviewing=null">取消核验</Button></section>
  <section v-if="defaultPreview&&section==='resources'" aria-label="默认授权变更预览"><h3>默认授权变更预览</h3><p>{{defaultPreview.resourceId}}</p><pre>{{JSON.stringify({before:defaultPreview.before,after:defaultPreview.after},null,2)}}</pre><Button :disabled="!canEdit" @click="recomputeDefaults">应用此授权变更</Button><Button variant="outline" @click="defaultPreview=null">取消</Button></section>
  <p v-if="section!=='simulate'&&!rows.length">{{busy?'正在读取…':'暂无记录'}}</p>
  <article v-for="row in rows" :key="row.id"><strong>{{row.name??row.id}}</strong><span v-if="row.status"> · {{row.status}}</span><StatusNotice v-if="row.defaultAuthorization==='explicit-only'" tone="warning">宽泛执行能力：不受自动授权策略放行。使用它会取得宿主可用范围内的完整执行能力，需要显式配置全部权限；分类标签不提供沙箱隔离。</StatusNotice><p v-if="row.groupId">权限组：{{row.groupId}}</p><p v-if="row.entityId">实体：{{row.entityId}}</p><p v-if="row.actions">{{row.effect}} · {{row.actions.join('、')}} · {{row.kind}}</p><details><summary>详情与判定依据</summary><pre>{{JSON.stringify(row,null,2)}}</pre></details><Button v-if="canEdit&&['groups','rules','bindings','resources'].includes(section)" variant="outline" @click="edit(row)">编辑</Button><Button v-if="canEdit&&section==='groups'" variant="outline" @click="editGroupDefaults(row)">配置新增资源默认授权</Button><Button v-if="canEdit&&section==='resources'&&row.reviewEligible" variant="outline" @click="reviewing=row">核验并启用</Button><Button v-if="canEdit&&section==='resources'" variant="outline" @click="previewDefaults(row)">预览默认授权</Button></article>
 </section>
</template>
<style scoped>
.ar-authorization nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}article,form{border:1px solid var(--ocp-border,#ddd);padding:16px;margin:12px 0;border-radius:8px}form{display:grid;gap:12px;max-width:760px}label{display:grid;gap:6px}fieldset{display:flex;flex-wrap:wrap;gap:12px}fieldset label{display:flex}pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
