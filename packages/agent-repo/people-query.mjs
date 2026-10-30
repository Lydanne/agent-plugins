import {getPeopleResolver} from './dist/people-api.mjs';
import {createPeopleStore} from './people.mjs';
export const peopleActions=['people','person','people_stats'];
const string=description=>({type:'string',minLength:1,maxLength:320,description});
export const peopleParameters={
 query:string('跨姓名、邮箱、OpenID、Gitea 账号、部门名称和 ID 的不区分大小写搜索'),
 id:string('人员资料 ID，精确匹配'),openId:string('飞书 OpenID，精确匹配'),
 accountId:string('飞书账号 ID，精确筛选'),appId:string('飞书应用 ID，精确筛选'),
 name:string('姓名，包含匹配'),email:string('邮箱，精确匹配，不区分大小写'),
 giteaUsername:string('Gitea 账号，精确匹配，不区分大小写'),department:string('部门名称或 ID，包含匹配'),
 giteaSource:{type:'string',enum:['admin','email_prefix','unknown'],description:'人工映射、邮箱前缀候选或未知'},
 missing:{type:'string',enum:['name','email','departments','giteaUsername'],description:'筛选缺少指定字段的人员'},
 offset:{type:'integer',minimum:0,description:'分页偏移，默认 0'},limit:{type:'integer',minimum:1,maximum:100,description:'每页数量，默认 20，最多 100'},
 sortBy:{type:'string',enum:['name','observedAt','updatedAt'],description:'排序字段，默认 name'},
 sortOrder:{type:'string',enum:['asc','desc'],description:'排序方向，默认 asc'},
};
export function queryPeople(root,params){
 const {action,...input}=params;
 if(!peopleActions.includes(action))throw Error('人员查询动作无效');
 for(const [key,value] of Object.entries(input)){
  const schema=peopleParameters[key];
  if(!schema||schema.type==='string'&&(typeof value!=='string'||!value.trim()||value.length>320||/[\u0000-\u001f]/.test(value))||schema.enum&&!schema.enum.includes(value)||schema.type==='integer'&&(!Number.isSafeInteger(value)||value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum))throw Error('人员查询参数无效：'+key);
 }
 if(action==='person'&&(!input.id&&!input.openId||input.id&&input.openId))throw Error('person 必须提供 id 或 openId，且只能提供一个');
 const paging=['offset','limit','sortBy','sortOrder'];
 if(action!=='people'&&paging.some(key=>input[key]!==undefined))throw Error('分页和排序仅支持 people');
 if(action==='person'&&Object.keys(input).some(key=>!['id','openId','accountId','appId'].includes(key)))throw Error('person 仅支持身份精确查询');
 const lower=value=>String(value??'').toLocaleLowerCase();
 const contains=(value,query)=>lower(value).includes(lower(query));
 const people=createPeopleStore(root).all().filter(p=>{
  for(const key of ['id','openId','accountId','appId','giteaSource'])if(input[key]!==undefined&&p[key]!==input[key])return false;
  for(const key of ['email','giteaUsername'])if(input[key]!==undefined&&lower(p[key])!==lower(input[key]))return false;
  if(input.name&&!contains(p.name,input.name))return false;
  if(input.department&&!p.departments.some(d=>contains(d.name,input.department)||contains(d.id,input.department)))return false;
  if(input.query&&![p.name,p.email,p.openId,p.giteaUsername,...p.departments.flatMap(d=>[d.id,d.name])].some(v=>contains(v,input.query)))return false;
  if(input.missing&&(input.missing==='departments'?p.departments.length:!!p[input.missing]))return false;
  return true;
 });
 if(action==='people_stats'){
  const missing={name:0,email:0,departments:0,giteaUsername:0},giteaSources={admin:0,email_prefix:0,unknown:0};
  for(const p of people){giteaSources[p.giteaSource]++;for(const key of Object.keys(missing))if(key==='departments'?!p.departments.length:!p[key])missing[key]++;}
  return {total:people.length,missing,giteaSources,accounts:[...new Set(people.map(p=>p.accountId))].sort(),apps:[...new Set(people.map(p=>p.appId))].sort()};
 }
 if(action==='person')return {found:people.length>0,ambiguous:people.length>1,total:people.length,person:people.length===1?people[0]:null,people:people.slice(0,100),truncated:people.length>100};
 const sortBy=input.sortBy??'name',direction=input.sortOrder==='desc'?-1:1;
 people.sort((a,b)=>direction*lower(a[sortBy]).localeCompare(lower(b[sortBy]))||a.id.localeCompare(b.id));
 const offset=input.offset??0,limit=input.limit??20;
 return {people:people.slice(offset,offset+limit),total:people.length,offset,limit,nextOffset:offset+limit<people.length?offset+limit:null};
}

const inFlight=new Map();
async function resolveOnce(resolver,root,input){
 const key=JSON.stringify([root,input]);
 if(inFlight.has(key))return inFlight.get(key);
 let timer;
 const promise=Promise.race([
  Promise.resolve().then(()=>resolver(input)),
  new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'error',reason:'feishu_lookup_timeout',people:[]}),20000);timer.unref?.();}),
 ]).finally(()=>{clearTimeout(timer);if(inFlight.get(key)===promise)inFlight.delete(key);});
 inFlight.set(key,promise);return promise;
}
/** Validate and query locally before any network lookup. Stats and browsing stay local. */
export async function queryPeopleWithFallback(root,params,context){
 const local=queryPeople(root,params);
 if(local.total||params.action==='people_stats'||params.id)return {...local,lookup:{source:'local',status:'not_needed'}};
 const identifier=params.openId?{openId:params.openId}:params.email?{email:params.email}:params.query?.startsWith('ou_')?{openId:params.query}:params.query?.includes('@')?{email:params.query}:params.name||params.query?{name:params.name??params.query}:null;
 if(!identifier)return {...local,lookup:{source:'local',status:'unsupported',reason:'requires_openid_email_or_name'}};
 const resolver=getPeopleResolver();
 if(!resolver)return {...local,lookup:{source:'feishu',status:'unavailable',reason:'feishu_resolver_unavailable'}};
 let remote;
 try{remote=await resolveOnce(resolver,root,{agentId:context.agentId,...identifier,...(params.accountId?{accountId:params.accountId}:{}),...(params.appId?{appId:params.appId}:{}),contextAccountId:context.deliveryContext?.accountId??context.agentAccountId,sessionKey:context.sessionKey});}catch{return {...local,lookup:{source:'feishu',status:'error',reason:'feishu_request_failed'}};}
 if(remote.status!=='found')return {...local,lookup:{source:'feishu',status:remote.status,reason:remote.reason,...(remote.code!==undefined?{code:remote.code}:{}),...(remote.requiredScopes?{requiredScopes:remote.requiredScopes}:{}),truncated:remote.truncated??false}};
 // Providers are trusted host code; still reject identity scope mismatches before persistence.
 const observations=remote.people;
 if(!Array.isArray(observations)||!observations.length||observations.length>10||observations.some(p=>!p.accountId||!p.appId||!/^ou_[A-Za-z0-9]+$/.test(p.openId)||params.accountId&&p.accountId!==params.accountId||params.appId&&p.appId!==params.appId||params.openId&&p.openId!==params.openId||(context.deliveryContext?.accountId??context.agentAccountId)&&p.accountId!==(context.deliveryContext?.accountId??context.agentAccountId)))throw Error('飞书人员身份范围不匹配');
 const store=createPeopleStore(root);
 let saved=0,hidden=0;for(const observation of observations){if(store.observe(observation).deletedAt)hidden++;else saved++;}
 return {...queryPeople(root,params),lookup:{source:'feishu',status:'saved',saved,...(hidden?{hidden}:{}),truncated:remote.truncated??false}};
}
