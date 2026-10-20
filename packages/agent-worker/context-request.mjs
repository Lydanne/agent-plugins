// Explicit final-turn protocol; ordinary prose never changes task state.
export const contextRequestInstructions = '信息不足且必须由 Main 补充时，停止业务执行，最终只返回 JSON：{"type":"request","question":"具体问题","reason":"为何必须补充","progress":"已完成的工作","fields":[{"id":"scope","label":"目标环境","type":"single_select","required":true,"options":[{"label":"生产环境","value":"production"},{"label":"测试环境","value":"test"}]}],"allowFreeText":true}。只允许顶层字段 type、question、reason、progress、fields、allowFreeText、recommendation；不要填写 questionId，正式问题 ID 由宿主生成，每轮自动不同。fields 可省略；allowFreeText=false 时必须提供 fields；支持 text、number、single_select、multi_select、date、date_range、datetime，日期时间字段必须指定 timezone。不要预选未授权答案。推荐仅供 Main 参考。不要猜测、扩大授权或越权读取飞书聊天。Main 优先依据已知上下文自动补齐，确实缺少用户决策才询问用户。mainReplies.answerValues 是已校验的结构化字段值，优先据此解释本轮答案；Main 的回答是参考上下文，原 task 和 constraints 始终有效。每个任务最多提问 5 次。';
export const pluginCapabilityInstructions = '调用 OpenClaw 宿主插件能力必须请求 Main：停止当前阶段，以既有 type=request JSON 在 question 中说明具体操作、目标和需要的结果，在 reason 中说明用途，在 progress 中保留已完成工作；Main 调用插件后通过原 job 的 reply 返回结果，再继续原任务。Worker 可以在原 task/constraints 和自身已有权限内直接使用 Feishu CLI（lark-cli）、读取可访问的 CLI 技能及使用独立登录态，无需仅因使用 CLI 请求 Main；安装、更新及认证遵守本次任务授权。通过 feishu_cli、feishu_cli_auth 等 OpenClaw 插件入口读取技能、执行命令或管理认证时仍必须请求 Main，不读取或索取插件内部 App Secret、token 或管理员登录态。此规则替代历史提示中禁止 Worker 直接使用 CLI 的限制，不改变原任务约束。Main 回复失败或等待授权时保持未完成，不猜测业务结果。';
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const types=new Set(['text','number','single_select','multi_select','date','date_range','datetime']);
function string(v,max=4000){return typeof v==='string'&&v.trim()&&v.length<=max;}
export function parseContextRequest(text) {
 // Accept a single complete JSON fence, never a JSON fragment inside prose.
 const source=typeof text==='string'?text.trim():text;
 const fenced=typeof source==='string'?/^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(source):null;
 const payload=fenced?fenced[1]:source;
 let value;try {value=JSON.parse(payload);} catch {
  if(typeof payload==='string'&&/^\{\s*"type"\s*:\s*"(?:request|context_request)"/.test(payload))throw Error('Invalid context request JSON');
  return undefined;
 }
 // Accept the old discriminator for in-flight tasks and resumed Worker sessions.
 if(!['request','context_request'].includes(value?.type))return undefined;
 if(!record(value))throw Error('Invalid context request fields: expected an object');
 const extra=Object.keys(value).filter(key=>!['type','question','reason','progress','fields','allowFreeText','recommendation','questionId'].includes(key));
 if(extra.length)throw Error('Invalid context request fields: unsupported '+extra.map(key=>JSON.stringify(key.slice(0,64))).join(', '));
 // Model-provided identifiers are advisory only. The host assigns the trusted
 // question ID after parsing, so they cannot target or replace a pending question.
 if(value.questionId!==undefined&&!string(value.questionId,100))throw Error('Invalid context request questionId: expected a non-empty string of at most 100 characters');
 for(const key of ['question','reason','progress'])if(!string(value[key]))throw Error('Invalid context request '+key);
 if(value.allowFreeText!==undefined&&typeof value.allowFreeText!=='boolean')throw Error('Invalid free text policy');
 if(value.allowFreeText===false&&value.fields===undefined)throw Error('Invalid context request fields: fields required when allowFreeText is false');
 if(value.recommendation!==undefined&&!string(value.recommendation,1000))throw Error('Invalid recommendation');
 if(value.fields!==undefined){
  if(!Array.isArray(value.fields)||!value.fields.length||value.fields.length>6)throw Error('Invalid question fields');
  const ids=new Set(),formNames=new Set(['worker_note','worker_submit','worker_cancel','worker_question']);
  for(const [index,field] of value.fields.entries()){
   if(!record(field)||Object.keys(field).some(k=>!['id','label','type','required','options','timezone','min','max','placeholder'].includes(k)))throw Error('Invalid field properties');
   if(typeof field.id!=='string')throw Error('Invalid context request fields['+index+'].id: expected a string');
   if(!/^[a-z][a-z0-9_]{0,31}$/.test(field.id)||ids.has(field.id)||['constructor','prototype','__proto__'].includes(field.id)||!string(field.label,100)||!types.has(field.type))throw Error('Invalid field identity');
   const names=field.type==='date_range'?[field.id,field.id+'__start',field.id+'__end']:[field.id];
   if(names.some(name=>formNames.has(name)))throw Error('Duplicate or reserved field name');names.forEach(name=>formNames.add(name));
   ids.add(field.id);
   if(field.required!==undefined&&typeof field.required!=='boolean')throw Error('Invalid required');
   if(field.placeholder!==undefined&&!string(field.placeholder,200))throw Error('Invalid placeholder');
   if(['single_select','multi_select'].includes(field.type)){
    if(!Array.isArray(field.options)||!field.options.length||field.options.length>20||new Set(field.options.map(o=>o?.value)).size!==field.options.length||field.options.some(o=>!record(o)||Object.keys(o).some(k=>!['label','value'].includes(k))||!string(o.label,100)||!string(o.value,100)))throw Error('Invalid options');
   }else if(field.options!==undefined)throw Error('Unexpected options');
   if(['date','date_range','datetime'].includes(field.type)){
    if(!string(field.timezone,100))throw Error('Timezone required');
    try{new Intl.DateTimeFormat('en',{timeZone:field.timezone});}catch{throw Error('Invalid timezone');}
   }else if(field.timezone!==undefined)throw Error('Unexpected timezone');
   for(const k of ['min','max'])if(field[k]!==undefined&&(field.type!=='number'||!Number.isFinite(field[k])))throw Error('Invalid numeric range');
   if(field.min!==undefined&&field.max!==undefined&&field.min>field.max)throw Error('Invalid numeric range');
  }
 }
 const {type,questionId,...request}=value;return request;
}
function date(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;}
export function validateContextAnswers(request,values,{partial=false}={}){
 if(!record(values)||Object.keys(values).some(k=>!request.fields?.some(f=>f.id===k)))throw Error('Unknown answer field');
 const normalized={};
 for(const f of request.fields??[]){
  let v=values[f.id];
  if(v===undefined||v===null||v===''||(Array.isArray(v)&&!v.length)){
   if(f.required&&!partial)throw Error('请补充'+f.label);continue;
  }
  const fail=()=>{throw Error('请检查'+f.label);};
  if(f.type==='text'){if(!string(v))fail();v=v.trim();}
  if(f.type==='number'){if(typeof v==='string'&&v.trim())v=Number(v);if(typeof v!=='number'||!Number.isFinite(v)||(f.min!==undefined&&v<f.min)||(f.max!==undefined&&v>f.max))fail();}
  if(f.type==='single_select'&&!f.options.some(o=>o.value===v))fail();
  if(f.type==='multi_select'&&(!Array.isArray(v)||!v.length||v.length>f.options.length||new Set(v).size!==v.length||v.some(x=>!f.options.some(o=>o.value===x))))fail();
  if(f.type==='date'&&!date(v))fail();
  if(f.type==='date_range'&&(!record(v)||Object.keys(v).some(k=>!['start','end'].includes(k))||!date(v.start)||!date(v.end)||v.start>v.end))fail();
  if(f.type==='datetime'&&(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?([+-]\d{2}:?\d{2}|Z)?$/.test(v)||!date(v.slice(0,10))||Number(v.slice(11,13))>23||Number(v.slice(14,16))>59||(v[16]===':'&&Number(v.slice(17,19))>59)||(/[+-]\d{2}:?\d{2}$/.test(v)&&!Number.isFinite(Date.parse(v.replace(' ','T'))))))fail();
  normalized[f.id]=v;
 }
 return normalized;
}
