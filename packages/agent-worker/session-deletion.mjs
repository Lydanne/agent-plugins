import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {acquireLock} from './locks.mjs';
import {bindingKey} from './project-binding.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const terminal=new Set(['completed','failed','timed_out','cancelled']);
const settled=new Set(['delivered','suppressed']);
export function sessionDeletionState(bindings,jobs){
 const reason=jobs.some(job=>!terminal.has(job.status))?'会话仍有未结束或状态未知的任务，请先处理原任务。':jobs.some(job=>job.notification&&!settled.has(job.notification.state))?'会话仍有待交付或待核查的结果，请先处理交付状态。':null;
 return {canDelete:!reason,deleteReason:reason,deletionRevision:hash(JSON.stringify([bindings,jobs.map(({jobId,status,sessionId,notification})=>({jobId,status,sessionId,notification})).sort((a,b)=>a.jobId.localeCompare(b.jobId))]))};
}
export function createSessionDeletion({state}){
 return async function deleteSession(scope,payload={}){
  const {topic,executionScope,modelSessionScope,projectId,revision,confirmed}=payload;
  if(typeof scope!=='string'||!scope||Object.keys(payload).some(k=>!['topic','executionScope','modelSessionScope','projectId','revision','confirmed'].includes(k))||typeof topic!=='string'||!topic||topic.length>160||![executionScope,modelSessionScope].every(v=>v===null||typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||projectId!==undefined&&(typeof projectId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(projectId))||typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision)||confirmed!==true)throw Error('请确认要删除的具体会话。');
  const scopeHash=hash(scope),key=bindingKey(topic,{executionScope,modelSessionScope}),root=join(state,'jobs'),file=join(state,scopeHash+'.json');
  const readBindings=()=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
  const readJobs=()=>existsSync(root)?readdirSync(root).filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n)).map(n=>{const job=JSON.parse(readFileSync(join(root,n),'utf8'));if(job.jobId+'.json'!==n)throw Error('任务存储标识异常。');return job;}).filter(job=>job.scope===scopeHash&&bindingKey(job.topic,job)===key):[];
  const selectBindings=bindings=>Object.fromEntries(Object.entries(bindings).filter(([,entry])=>bindingKey(entry.topic,entry)===key));
  const check=()=>{
   const bindings=readBindings(),selected=selectBindings(bindings),jobs=readJobs();
   if(!jobs.length&&!Object.keys(selected).length)throw Error('会话不存在或已经删除，请刷新列表。');
   if(projectId!==undefined&&[...Object.values(selected),...jobs].some(entry=>(entry.projectId??entry.project?.projectId)!==projectId))throw Error('会话项目不匹配，请刷新列表。');
   const result=sessionDeletionState(selected,jobs);if(!result.canDelete)throw Error(result.deleteReason);
   if(result.deletionRevision!==revision)throw Error('会话已变化，请刷新后重新确认删除。');
   return {bindings,selected,jobs};
  };
  check();
  if(existsSync(join(state,'lock'))||existsSync(join(root,'active')))throw Error('旧执行器仍占用存储，请先处理原任务。');
  mkdirSync(join(state,'session-locks'),{recursive:true,mode:0o700});mkdirSync(root,{recursive:true,mode:0o700});
  const locks=[join(state,'session-locks',hash(JSON.stringify([scope,topic])))];
  if(executionScope)locks.push(join(state,'session-locks',hash(JSON.stringify([scope,executionScope,topic]))));
  if(modelSessionScope)locks.push(join(state,'session-locks',hash(JSON.stringify([scope,key]))));
  locks.push(join(state,'binding-'+scopeHash+'.lock'),join(root,'scheduler-lock'));
  const releases=[];
  try{
   for(const lock of new Set(locks))releases.push(await acquireLock(lock));
   const {bindings,selected,jobs}=check(),archive=join(state,'deleted-sessions',randomUUID()),moves=[];
   mkdirSync(join(archive,'jobs'),{recursive:true,mode:0o700});
   const remaining=Object.fromEntries(Object.entries(bindings).filter(([key])=>!Object.hasOwn(selected,key))),tmp=file+'.delete-'+randomUUID();
   // Synchronous mutation under admission/session/binding locks prevents partial reads
   // by the in-process scheduler and completion service. Roll back on storage errors.
   try{
    writeFileSync(join(archive,'session.json'),JSON.stringify({deletedAt:Date.now(),scope:scopeHash,bindings:selected,jobIds:jobs.map(job=>job.jobId)}),{mode:0o600});
    writeFileSync(tmp,JSON.stringify(remaining),{mode:0o600});
    const ids=new Set(jobs.map(job=>job.jobId));
    for(const name of readdirSync(root)){if(!ids.has(name.slice(0,36))||name[36]!=='.')continue;const from=join(root,name),to=join(archive,'jobs',name);renameSync(from,to);moves.push({from,to});}
    renameSync(tmp,file);
   }catch(error){for(const {from,to} of moves.reverse())renameSync(to,from);rmSync(tmp,{force:true});rmSync(archive,{recursive:true,force:true});throw error;}
   return {deleted:true,taskCount:jobs.length};
  }finally{for(const release of releases.reverse())release();}
 };
}
