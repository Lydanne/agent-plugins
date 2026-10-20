import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
const activeOperations=globalThis[Symbol.for('openclaw-plugins.maintenance-operations.v1')]??=new Set();
const providers=globalThis[Symbol.for('openclaw-plugins.skill-maintenance.v1')]??=new Map();
export const MaintenanceError=globalThis[Symbol.for('openclaw-plugins.skill-maintenance.error.v1')]??=class MaintenanceError extends Error {constructor(code,message){super(message);this.code=code;}};
export const maintenanceRevision=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function maintenanceContext(ctx,write=false){
 const agentId=ctx?.agentId,sessionKey=ctx?.sessionKey,scopes=ctx?.client?.scopes;
 if(typeof agentId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId)||typeof sessionKey!=='string'||!sessionKey.startsWith('agent:'+agentId+':'))throw new MaintenanceError('SCOPE_INVALID','维护请求不属于当前 Agent');
 if(!Array.isArray(scopes)||!scopes.some(scope=>(write?['operator.write','operator.admin']:['operator.read','operator.write','operator.admin']).includes(scope)))throw new MaintenanceError('PERMISSION_DENIED',write?'维护操作需要写入权限':'查看维护状态需要读取权限');
 return {agentId,sessionKey,client:{scopes:[...scopes]}};
}
export function registerMaintenanceProvider(provider,owner){
 if(provider?.id==='agent-repo.main-skill')throw Error('Main skill provider ID is reserved');
 if(!owner||provider?.apiVersion!==1||!/^[-a-z0-9.]{1,80}$/.test(provider.id)||typeof provider.snapshot!=='function'||typeof provider.run!=='function')throw Error('Invalid skill maintenance provider');
 const old=providers.get(provider.id);if(old&&old.owner!==owner)throw Error('Skill maintenance provider already registered');
 const entry={provider,owner};providers.set(provider.id,entry);return ()=>{if(providers.get(provider.id)===entry)providers.delete(provider.id);};
}
export async function maintenanceCatalog(ctx){
 const context=maintenanceContext(ctx);
 const rows=await Promise.all([...providers.values()].map(async({provider})=>{
  let timer;
  try{const value=await Promise.race([provider.snapshot(context),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),5000);})]);return value?.apiVersion===1?value:{apiVersion:1,id:provider.id,label:provider.label??provider.id,scope:provider.scope,state:'unsupported',skills:[],actions:[],observedAt:new Date().toISOString()};}
  catch{return {apiVersion:1,id:provider.id,label:provider.label??provider.id,state:'unavailable',scope:provider.scope,actions:[],skills:[],observedAt:new Date().toISOString()};}
  finally{clearTimeout(timer);}
 }));
 return {apiVersion:1,agentId:context.agentId,observedAt:new Date().toISOString(),providers:rows};
}
export async function runMaintenance(ctx,input){
 const context=maintenanceContext(ctx,true);
 if(!input||Object.keys(input).some(key=>!['providerId','action','expectedRevision','requestId','confirmed','settings'].includes(key))||input.confirmed!==true||typeof input.action!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedRevision??'')||!/^[a-f0-9-]{36}$/i.test(input.requestId??''))throw new MaintenanceError('INVALID_OPERATION','请确认操作目标并刷新版本后重试');
 const provider=providers.get(input.providerId)?.provider;if(!provider)throw new MaintenanceError('PROVIDER_UNAVAILABLE','维护提供方未加载或版本不支持');
 return provider.run(context,input);
}
// Providers own their operation journal. No business requests, output, credentials or arbitrary commands are persisted.
export function createMaintenanceOperations(directory){
 let pending,busy=false;
 const file=id=>join(directory,id+'.json');
 async function read(id){try{return JSON.parse(await readFile(file(id),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async function save(id,value){const temporary=file(id)+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,file(id));}
 async function prune(){const names=(await readdir(directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)),rows=[];for(const name of names){try{rows.push({name,value:JSON.parse(await readFile(join(directory,name),'utf8'))});}catch{}}rows.sort((a,b)=>String(b.value.createdAt).localeCompare(String(a.value.createdAt)));for(const row of rows.slice(100))if(['succeeded','failed'].includes(row.value.status)&&Date.parse(row.value.finishedAt)<Date.now()-30*86400000)await rm(join(directory,row.name),{force:true});}
 const view=value=>({id:value.id,action:value.action,status:value.status==='running'&&(value.pid!==process.pid||!activeOperations.has(directory+'\0'+value.id))?'unknown':value.status,createdAt:value.createdAt,finishedAt:value.finishedAt??null,errorCode:value.errorCode??null,actorAgentId:value.actorAgentId??null});
 return {
  async find(ctx,input){maintenanceContext(ctx,true);const prior=await read(maintenanceRevision([ctx.agentId,ctx.sessionKey,input.requestId]));if(!prior)return null;if(prior.digest!==maintenanceRevision([input.action,input.expectedRevision,input.settings??null]))throw new MaintenanceError('REQUEST_CONFLICT','同一操作标识不能改变参数');return view(prior);},
  async history(){let names;try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
   const rows=[];for(const name of names.filter(name=>/^[a-f0-9]{64}\.json$/.test(name))){try{const value=JSON.parse(await readFile(join(directory,name),'utf8'));rows.push(view(value));}catch{}}
   return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20);
  },
  async start(ctx,input,execute){
   maintenanceContext(ctx,true);
   const id=maintenanceRevision([ctx.agentId,ctx.sessionKey,input.requestId]),digest=maintenanceRevision([input.action,input.expectedRevision,input.settings??null]);
   await mkdir(directory,{recursive:true,mode:0o700});
   const previous=await read(id);if(previous){if(previous.digest!==digest)throw new MaintenanceError('REQUEST_CONFLICT','同一操作标识不能改变参数');return view(previous);}
   if(busy)throw new MaintenanceError('OPERATION_BUSY','已有维护操作执行中，请等待结果');
   busy=true;
   const row={id,digest,actorAgentId:ctx.agentId,action:input.action,status:'running',pid:process.pid,createdAt:new Date().toISOString()};
   // Exclusive creation is durable idempotency admission, even across plugin instances.
   try{await writeFile(file(id),JSON.stringify(row),{flag:'wx',mode:0o600});}catch(error){busy=false;if(error.code==='EEXIST'){const prior=await read(id);if(prior?.digest===digest)return view(prior);throw new MaintenanceError('REQUEST_CONFLICT','维护操作已存在，请刷新状态');}throw error;}
   activeOperations.add(directory+'\0'+id);
   pending=(async()=>{try{await execute();row.status='succeeded';}catch(error){row.status='failed';row.errorCode=error instanceof MaintenanceError?error.code:error?.message==='CLI update is already running'?'OPERATION_BUSY':'MAINTENANCE_FAILED';}finally{row.finishedAt=new Date().toISOString();await save(id,row);try{await prune();}catch{}}})().catch(()=>{}).finally(()=>{activeOperations.delete(directory+'\0'+id);pending=undefined;busy=false;});
   return view(row);
  },
 };
}
