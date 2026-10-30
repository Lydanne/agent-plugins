const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=message=>{throw Error(message);};
const text=(value,max=200,empty=false)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f]/.test(value)&&(empty||value.trim())?value.trim():fail('实体资料字段格式无效');
const key=value=>{const normalized=text(value,64);return /^[a-z][a-z0-9_-]{0,63}$/.test(normalized)?normalized:fail('实体类型或来源标识无效');};
const exact=(input,keys)=>{if(!object(input)||Object.keys(input).some(k=>!keys.includes(k)))fail('实体资料参数无效');};
const field=(label,type='string')=>({label,type});
export const builtinEntityTypes=[
 {id:'person',label:'人员资源',description:'联系人、身份资料与账号关联',fields:{email:field('邮箱'),department:field('部门'),role:field('职位')}},
 {id:'department',label:'部门',description:'组织部门',fields:{code:field('部门编码'),parentId:field('父部门 ID'),parentIdSource:field('父部门依据'),inDirectory:field('当前来源目录中','boolean'),leaderIds:field('负责人 ID','strings'),memberCount:field('成员数','number'),order:field('排序'),chatId:field('部门群 ID'),deleted:field('来源已删除','boolean')}},
 {id:'organization',label:'组织机构',description:'公司、部门、团队及合作单位',fields:{website:field('网站'),contact:field('联系方式'),tenantKey:field('飞书租户 ID'),displayId:field('企业编号'),domain:field('企业域名')}},
 {id:'service',label:'系统服务',description:'应用、接口与运行服务的资料',fields:{url:field('服务地址'),owner:field('负责人'),environment:field('环境')}},
 {id:'asset',label:'资产资源',description:'设备、资源与其他可管理资产',fields:{serialNumber:field('资产编号'),location:field('位置'),owner:field('负责人')}},
];
function definition(input){
 exact(input,['id','label','description','fields']);const result={id:key(input.id),label:text(input.label,80),description:text(input.description??'',500,true),fields:{}};
 if(!object(input.fields)||Object.keys(input.fields).length>32)fail('实体字段定义无效');
 for(const [name,spec] of Object.entries(input.fields)){key(name);if(['__proto__','constructor','prototype'].includes(name))fail('实体字段名称无效');exact(spec,['label','type']);if(!['string','number','boolean','strings'].includes(spec.type))fail('实体字段类型无效');result.fields[name]={label:text(spec.label,80),type:spec.type};}
 return result;
}
function attributes(input,type){
 if(!object(input)||Object.keys(input).length>32)fail('实体属性无效');const result={};
 for(const [name,value] of Object.entries(input)){
  if(!Object.hasOwn(type.fields,name))fail('未注册的实体属性：'+name);
  const kind=type.fields[name].type;
  if(value===null)result[name]=null;
  else if(kind==='string')result[name]=text(value,2000,true);
  else if(kind==='number'&&typeof value==='number'&&Number.isFinite(value))result[name]=value;
  else if(kind==='boolean'&&typeof value==='boolean')result[name]=value;
  else if(kind==='strings'&&Array.isArray(value)&&value.length<=50)result[name]=value.map(v=>text(v,200));
  else fail('实体属性类型不匹配：'+name);
 }
 return result;
}

export {object,fail,text,key,exact,definition,attributes};
