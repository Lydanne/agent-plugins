export function validatePluginCall(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['callId','capability','arguments','purpose'].includes(k)))throw Error('Invalid plugin call');
 for(const k of ['callId','capability','purpose'])if(typeof value[k]!=='string'||!value[k].trim()||value[k].length>(k==='purpose'?1000:100))throw Error('Invalid plugin call '+k);
 if(!/^[a-zA-Z0-9._-]+$/.test(value.callId)||!value.arguments||typeof value.arguments!=='object'||Array.isArray(value.arguments)||JSON.stringify(value.arguments).length>4000)throw Error('Invalid plugin arguments');
 return value;
}
// Explicit final-turn protocol; ordinary prose never changes task state.
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
 const extra=Object.keys(value).filter(key=>!['type','question','reason','progress','fields','allowFreeText','recommendation','questionId','requestKind','pluginCall','waitKind'].includes(key));
 if(extra.length)throw Error('Invalid context request fields: unsupported '+extra.map(key=>JSON.stringify(key.slice(0,64))).join(', '));
 // Model-provided identifiers are advisory only. The host assigns the trusted
 // question ID after parsing, so they cannot target or replace a pending question.
 if(value.questionId!==undefined&&!string(value.questionId,100))throw Error('Invalid context request questionId: expected a non-empty string of at most 100 characters');
 for(const key of ['question','reason','progress'])if(!string(value[key]))throw Error('Invalid context request '+key);
 if(value.requestKind!==undefined&&!['context','plugin'].includes(value.requestKind))throw Error('Invalid context request kind');
 if(value.pluginCall!==undefined){if(value.requestKind!=='plugin')throw Error('Plugin call requires plugin request');validatePluginCall(value.pluginCall);}
 if(value.waitKind!==undefined&&!['optional','required','decision','authorization'].includes(value.waitKind))throw Error('Invalid wait kind');
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
