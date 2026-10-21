const modelIdPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
const effortSchema = {type:'string',enum:['minimal','low','medium','high','xhigh','max']};
const speedSchema = {type:'string',enum:['default','fast']};
const commandSchema = {type:'string',pattern:'\\S',maxLength:40000};
const levelProfilesSchema = properties=>({type:'object',additionalProperties:false,properties:Object.fromEntries(Array.from({length:7},(_,level)=>[String(level),{type:'object',additionalProperties:false,properties}]))});
export const modelSchema = {type:'object',required:['id','harness','model'],additionalProperties:false,properties:{
 id:{type:'string',pattern:modelIdPattern},name:{type:'string',maxLength:160},description:{type:'string',maxLength:2000},
 harness:{type:'string',enum:['codex']},model:commandSchema,cli:commandSchema,reasoningEffort:effortSchema,speed:speedSchema,
 thinkingProfiles:levelProfilesSchema({reasoningEffort:effortSchema,speed:speedSchema}),
}};
export function validValue(value,schema) {
 if(schema.enum&&!schema.enum.includes(value)||schema.not?.enum.includes(value))return false;
 if(schema.type==='string')return typeof value==='string'&&value.length<=(schema.maxLength??Infinity)&&(!schema.pattern||new RegExp(schema.pattern).test(value));
 if(schema.type==='integer')return Number.isInteger(value)&&value>=schema.minimum&&value<=schema.maximum;
 if(schema.type==='boolean')return typeof value==='boolean';
 if(schema.type==='array')return Array.isArray(value)&&value.length<=schema.maxItems&&value.every(item=>validValue(item,schema.items));
 if(schema.type==='object')return value!==null&&typeof value==='object'&&!Array.isArray(value)&&(schema.required??[]).every(key=>Object.hasOwn(value,key))&&Object.entries(value).every(([key,item])=>Object.hasOwn(schema.properties,key)&&validValue(item,schema.properties[key]));
 return false;
}
export function validateModelSettings({models,defaultModelId}) {
 if(!validValue(models,{type:'array',items:modelSchema,maxItems:50}))throw Error('Invalid models');
 if(typeof defaultModelId!=='string'||!new RegExp('^(?:$|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$').test(defaultModelId))throw Error('Invalid defaultModelId');
 if(new Set(models.map(model=>model.id)).size!==models.length||new Set(models.map(model=>JSON.stringify([model.harness,model.model]))).size!==models.length)throw Error('Invalid models: duplicate ID or harness/model');
 if(defaultModelId&&!(models.length?models.some(model=>model.id===defaultModelId):defaultModelId==='default'))throw Error('Invalid defaultModelId: choose a configured model');
 return {models,defaultModelId};
}
