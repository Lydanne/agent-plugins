const params=new URLSearchParams(location.search),container=document.querySelector('#view');
const listeners=new Set(),pages=new Map(),panels=new Map(),activations=[],calls=[],opened=[];
let currentView,context,mutationStatus='succeeded',deferredReads=false,pendingReads=[];
let trash=Array.from({length:26},(_,i)=>({id:'plan-'+i,name:'测试计划 '+i,kind:'group-schedule',provider:'group-schedules',revision:'rev-'+i,deletedAt:1000,expiresAt:Date.now()+86400000,preview:{task:'读取本群进展',group:'测试群'}}));
const policy={retentionDays:30,revision:'policy-1'};
const task={jobId:'11111111-1111-4111-8111-111111111111',topic:'检查项目与依赖',taskSummary:'只读检查测试项目',projectId:'demo',sessionKey:'agent:main:real-chat',status:'running',createdAt:Date.now()-20000};
const counts={running:1,queued:0,awaiting_main:0,awaiting_user:0,completed:0,failed:0,timed_out:0,unknown:1};
const auditRecords=Array.from({length:26},(_,i)=>({id:'audit-'+i,at:Date.now()-i*1000,targetId:'plan-'+i,targetName:'测试计划 '+i,action:'update',status:i===0?'unknown':'succeeded',actor:{name:'测试管理员',id:'source',chatId:'fixture-group'},executor:'panel',requestId:'request-'+i,changes:[{field:'name',before:'source',after:'group'},{field:'deliveryMode',before:'source',after:'group'}]}));
async function resultFor(p){
 const v=p.payload??{};
 if(p.actionId==='projects-audit'){const records=auditRecords.filter(r=>(!v.targetId||v.targetId===r.targetId)&&(!v.status||v.status===r.status));return {records:records.slice(v.offset,v.offset+v.limit).map(r=>p.agentId==='other'?{...r,targetName:'其他 Agent '+r.targetName}:r),total:records.length,nextOffset:v.offset+v.limit<records.length?v.offset+v.limit:null};}
 if(p.actionId==='projects-recycleBin'){const records=trash.filter(r=>!v.query||r.name.includes(v.query)||r.id.includes(v.query));return {agentId:p.agentId,settings:{...policy},records:records.slice(v.offset,v.offset+v.limit),total:records.length,nextOffset:v.offset+v.limit<records.length?v.offset+v.limit:null,unavailable:[]};}
 if(p.actionId==='projects-recycleRestore'){if(mutationStatus==='succeeded')trash=trash.filter(r=>r.id!==v.id);return {status:mutationStatus};}
 if(p.actionId==='projects-recycleConfigure'){if(mutationStatus==='succeeded'){policy.retentionDays=v.retentionDays;policy.revision='policy-2';}return {status:mutationStatus};}
 if(p.actionId==='inspect-agentTasks')return {taskTotal:1,conversationTotal:1,counts,tasks:v.status&&v.status!==task.status?[]:[{...task}],projectIds:['demo'],total:1,hasMore:false,scannedAt:new Date().toISOString(),coverage:'模拟宿主：可核验任务绑定'};
 throw Error('Unsupported fixture action: '+p.actionId);
}
const host={apiVersion:1,pluginId:'agent-repo',basePath:'/',locale:'zh-CN',signal:new AbortController().signal,redact:String,
 connection:{canRead:true,canWrite:true,assistantAgentId:'main'},
 agents:{rows:[{id:'main',name:'测试 Ada'},{id:'other',name:'测试其他 Agent'}],selectedId:'main',defaultId:'main',select(id){this.selectedId=id;notify();}},
 sessions:{rows:[{key:'agent:main:real-chat',label:'测试群'}],selectedKey:'agent:main:real-chat'},
 subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
 ui:{registerPage(page){pages.set(page.id,page);return ()=>pages.delete(page.id);},registerPanel(panel){panels.set(panel.id,panel);return ()=>panels.delete(panel.id);},registerNavigation(){return ()=>{};}},
 navigation:{openPage(target){opened.push(target);}},
 async request(method,p){calls.push({method,...structuredClone(p)});if(deferredReads)await new Promise(resolve=>pendingReads.push(resolve));try{return {ok:true,result:await resultFor(p)};}catch(e){return {ok:false,error:e.message};}}
};
function notify(){for(const fn of [...listeners])fn();}
for(const name of ['agent-repo','agent-worker']){
 const manifest=await fetch('/plugins/'+name+'/openclaw.plugin.json').then(r=>r.json());
 for(const css of manifest.controlUi.styles){const link=document.createElement('link');link.rel='stylesheet';link.href='/plugins/'+name+'/'+css;document.head.append(link);await new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=reject;});}
 const module=await import('/plugins/'+name+'/'+manifest.controlUi.entry);activations.push(module.default.activate(host));
}
context={host,props:{section:params.get('section')??'audit'},signal:new AbortController().signal,presented:true};
currentView=pages.get('management').mount(container,context);
window.fixture={calls,opened,host,setMutationStatus(value){mutationStatus=value;},setConnection(value){Object.assign(host.connection,value);notify();},setPresented(value){context={...context,presented:value};currentView.update?.(context);},setTheme(value){document.documentElement.dataset.theme=value;},delayReads(value){deferredReads=value;},releaseReads(){deferredReads=false;for(const resolve of pendingReads)resolve();pendingReads=[];},subscriberCount:()=>listeners.size,dispose(){currentView?.dispose();for(const dispose of activations)dispose();}};
document.documentElement.dataset.ready='true';
