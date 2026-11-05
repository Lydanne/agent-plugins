import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse as parseToml} from 'smol-toml';
export const hermesIdPattern='^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
const variablePattern='^[A-Za-z][A-Za-z0-9_]{0,63}$';
const stringSchema={type:'string',maxLength:40000};
export const hermesVariablesSchema={type:'object',propertyNames:{type:'string',pattern:variablePattern},additionalProperties:stringSchema};
export const defaultHermesTemplates={codex:{
 name:'Codex CLI',description:'Codex exec JSONL，支持新建、恢复会话和只读技能刷新',adapter:'codex-jsonl',command:'{{cli}}',
 args:['exec','--cd','{{cwd}}','{{policyArgs}}','-c','developer_instructions={{json:instructions}}','-c','model_reasoning_effort={{json:reasoningEffort}}','{{speedArgs}}','--model','{{model}}','{{resumeArgs}}','{{schemaArgs}}','--json','-'],
 resumeArgs:['resume','{{sessionId}}'],stdin:'{{prompt}}',variables:{},
},'codex-live':{name:'Codex 实时引导',description:'Private app-server with turn/steer',adapter:'codex-app-server',command:'{{cli}}',args:['app-server','--stdio'],resumeArgs:['{{sessionId}}'],stdin:'{{prompt}}',variables:{}}};
const argsSchema={type:'array',maxItems:200,items:stringSchema};
export const hermesTemplatesSchema={type:'object',propertyNames:{type:'string',pattern:hermesIdPattern},additionalProperties:{type:'object',additionalProperties:false,required:['name','adapter','command','args','resumeArgs','stdin','variables'],default:defaultHermesTemplates.codex,properties:{name:{type:'string',pattern:'\\S',maxLength:160},description:{type:'string',maxLength:2000},adapter:{type:'string',enum:['codex-jsonl','codex-app-server']},command:{type:'string',pattern:'\\S',maxLength:40000},args:argsSchema,resumeArgs:argsSchema,stdin:stringSchema,variables:{...hermesVariablesSchema,propertyNames:{type:'string',pattern:'^(?!(?:model|reasoningEffort|speed)$)[A-Za-z][A-Za-z0-9_]{0,63}$'}}}}};
const reserved=new Set(['cwd','prompt','instructions','sessionId','schemaPath','policyArgs','speedArgs','resumeArgs','schemaArgs']);
const scalars=['cli','model','reasoningEffort','speed','codexHome','cwd','prompt','instructions','sessionId','schemaPath'];
const arrays=['policyArgs','speedArgs','resumeArgs','schemaArgs'];
export function validateHermesVariables(variables){
 if(!variables||typeof variables!=='object'||Array.isArray(variables)||Object.keys(variables).length>100)throw Error('Invalid Hermes variables');
 for(const [key,value] of Object.entries(variables))if(!new RegExp(variablePattern).test(key)||reserved.has(key)||typeof value!=='string'||value.length>40000||value.includes('\0'))throw Error('Invalid Hermes variable: '+key);
 return variables;
}
function substitute(source,values){
 if(typeof source!=='string'||source.includes('\0'))throw Error('Invalid Hermes template string');
 const syntax=source.replace(/\{\{(json:)?([A-Za-z][A-Za-z0-9_]*)\}\}/g,'');
 if(syntax.includes('{{')||syntax.includes('}}'))throw Error('Invalid Hermes placeholder syntax');
 return source.replace(/\{\{(json:)?([A-Za-z][A-Za-z0-9_]*)\}\}/g,(_match,json,key)=>{
  if(!Object.hasOwn(values,key)||typeof values[key]!=='string')throw Error('Unknown or non-scalar Hermes variable: '+key);
  return json?JSON.stringify(values[key]):values[key];
 });
}
function expandArgs(args,values){return args.flatMap(arg=>{
 const match=/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/.exec(arg);
 return match&&Array.isArray(values[match[1]])?[...values[match[1]]]:[substitute(arg,values)];
});}
export function validateHermesTemplates(templates,queues){
 if(!templates||typeof templates!=='object'||Array.isArray(templates)||!Object.keys(templates).length||Object.keys(templates).length>50)throw Error('Invalid hermesTemplates');
 for(const [id,template] of Object.entries(templates)){
  if(!new RegExp(hermesIdPattern).test(id)||!template||typeof template!=='object'||Array.isArray(template)||Object.keys(template).some(k=>!Object.hasOwn(hermesTemplatesSchema.additionalProperties.properties,k))||typeof template.name!=='string'||!template.name.trim()||template.name.length>160||!['codex-jsonl','codex-app-server'].includes(template.adapter)||typeof template.command!=='string'||!template.command.trim()||template.description!==undefined&&(typeof template.description!=='string'||template.description.length>2000))throw Error('Invalid Hermes template: '+id);
  validateHermesVariables(template.variables);
  for(const field of ['args','resumeArgs'])if(!Array.isArray(template[field])||template[field].length>200||!template[field].every(v=>typeof v==='string'&&v.length<=40000))throw Error('Invalid Hermes argument list: '+id);
  // Protocol-owned fragments remain mandatory so refresh/reply retain their contract.
  for(const token of template.adapter==='codex-jsonl'?['{{policyArgs}}','{{resumeArgs}}','{{schemaArgs}}']:[])if(template.args.filter(arg=>arg===token).length!==1)throw Error('Hermes codex-jsonl args require '+token);
  if(!template.resumeArgs.includes('{{sessionId}}')||template.stdin!=='{{prompt}}')throw Error('Hermes codex-jsonl requires sessionId and prompt transport');
  const values={...Object.fromEntries(scalars.map(key=>[key,'fixture'])),...template.variables,...Object.fromEntries(arrays.map(key=>[key,[]]))};
  substitute(template.command,values);substitute(template.stdin,values);expandArgs(template.args,values);expandArgs(template.resumeArgs,values);
 }
 for(const queue of Object.values(queues??{})){
  const id=queue.hermesTemplateId??'codex';
  if(!Object.hasOwn(templates,id))throw Error('Unknown Hermes template: '+id);
  validateHermesVariables(queue.hermesVariables??{});
  for(const key of Object.keys(queue.hermesVariables??{}))if(!['cli','model','reasoningEffort','speed','codexHome'].includes(key)&&!Object.hasOwn(templates[id].variables,key))throw Error('Undeclared Hermes variable: '+key);
 }
}
// Labels and descriptions never affect CLI/session identity. Sort dictionaries so
// equivalent operator edits do not migrate a session solely due to key order.
export function hermesExecutionIdentity(execution){
 const {template,variables}=execution;
 return {templateId:execution.templateId,adapter:template.adapter,command:template.command,args:template.args,resumeArgs:template.resumeArgs,stdin:template.stdin,
  variables:Object.fromEntries(Object.entries(variables).sort(([a],[b])=>a.localeCompare(b)))};
}
export function bindHermes(config,queue){
 const id=queue.hermesTemplateId??'codex',template=config.hermesTemplates[id];
 if(!template)throw Error('Unknown Hermes template: '+id);
 const variables={cli:config.cli,model:config.model,reasoningEffort:config.reasoningEffort,speed:config.speed??'',codexHome:config.codexHome,...template.variables,...queue.hermesVariables};
 for(const key of ['cli','codexHome'])if(variables[key]?.startsWith('~/'))variables[key]=join(homedir(),variables[key].slice(2));
 for(const key of ['cli','model','reasoningEffort','codexHome'])if(typeof variables[key]!=='string'||!variables[key].trim())throw Error('Missing Hermes variable: '+key);
 const hermesExecution=structuredClone({templateId:id,template,variables});
 const hermesRevision=createHash('sha256').update(JSON.stringify(hermesExecutionIdentity(hermesExecution))).digest('hex');
 return {...config,hermesExecution,hermesIdentityVersion:2,hermesTemplateId:id,hermesRevision,cli:variables.cli,model:variables.model,reasoningEffort:variables.reasoningEffort,speed:variables.speed||undefined,codexHome:variables.codexHome,
  modelSessionScope:createHash('sha256').update(JSON.stringify(['hermes',id,hermesRevision])).digest('hex')};
}
// Parse TOML keys, including quoted and dotted forms, rather than comparing raw
// argv prefixes. The CLI accepts an unquoted value as a string when TOML parsing
// fails, so validate the key independently from the value in that case.
const directoryOwnedConfig=new Set(['sandbox_mode','sandbox_permissions','sandbox_workspace_write','sandbox_read_only','permissions','default_permissions','profile','profiles','approval_policy','approvals_reviewer','projects','mcp_servers','hooks','notify','features','shell_environment_policy','cwd','experimental_permissions','experimental_use_unified_exec_tool','experimental_use_freeform_apply_patch','tools']);
function directoryOverrideConflicts(override){
 const equals=override.indexOf('=');if(equals<0)return true;
 let parsed;try{parsed=parseToml(override);}catch{
  try{parsed=parseToml(override.slice(0,equals)+' = 0');}catch{return true;}
 }
 return Object.keys(parsed).some(key=>directoryOwnedConfig.has(key));
}
function validateDirectoryArgs(args){
 for(let index=0;index<args.length;index++){
  const arg=args[index].trimStart();
  if(/^(?:--(?:dangerously-bypass-approvals-and-sandbox|dangerously-bypass-hook-trust|full-auto|approve-for-me|permission-profile|profile|ignore-user-config|ignore-rules|add-dir|sandbox|worktree|ask-for-approval|enable|disable)(?:=|$)|-[asPp])/.test(arg))throw Error('Hermes directory policy conflict');
  let override;
  if(arg==='-c'||arg==='--config')override=args[++index];
  else if(arg.startsWith('--config='))override=arg.slice(9);
  else if(arg.startsWith('-c'))override=arg.slice(2).replace(/^=/,'');
  else continue;
  if(typeof override!=='string'||directoryOverrideConflicts(override))throw Error('Hermes directory policy conflict');
 }
}
export function hermesCommand(config,{refresh=false,threadId,outputSchemaPath,prompt=''}={}){
 const template=config.hermesExecution?.template??defaultHermesTemplates.codex;
 const variables=config.hermesExecution?.variables??{cli:config.cli,model:config.model,reasoningEffort:config.reasoningEffort,speed:config.speed??'',codexHome:config.codexHome};
 const values={...variables,cwd:config.cwd,prompt,instructions:config.executorInstructions.replaceAll('{projectDir}',config.cwd),sessionId:threadId??'',schemaPath:outputSchemaPath??'',
  policyArgs:refresh?['--sandbox','read-only']:config.approvalMode==='dangerously-bypass-approvals-and-sandbox'?['--dangerously-bypass-approvals-and-sandbox']:['--sandbox',config.approvalMode],
  speedArgs:variables.speed?['-c','service_tier='+JSON.stringify(variables.speed)]:[],schemaArgs:refresh&&outputSchemaPath?['--output-schema',outputSchemaPath]:[],resumeArgs:[]};
 values.resumeArgs=threadId?expandArgs(template.resumeArgs,values):[];
 const command=substitute(template.command,values),args=expandArgs(template.args,values);
 if(!command.trim()||command.includes('\n')||command.includes('\r'))throw Error('Invalid Hermes command');
 // Do not allow another template flag to undo the host-owned read-only refresh policy.
 if(refresh&&template.adapter==='codex-jsonl'&&(args.includes('--dangerously-bypass-approvals-and-sandbox')||args.filter(a=>a==='--sandbox'||a==='-s').length!==1||args.some(a=>/^(?:--sandbox=|-s=|sandbox_mode=|--full-auto$)/.test(a))))throw Error('Hermes refresh policy conflict');
 if(config.directoryPolicy){
  const unowned=expandArgs(template.args,{...values,policyArgs:[],resumeArgs:threadId?expandArgs(template.resumeArgs,{...values,policyArgs:[]}):[]});
  validateDirectoryArgs(unowned);
 }

 return {command,args,stdin:substitute(template.stdin,values),adapter:template.adapter};
}
