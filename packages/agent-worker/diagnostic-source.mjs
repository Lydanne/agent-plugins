import {open,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {requestKeyFor} from './jobs.mjs';
import {registerDiagnosticSource} from './dist/diagnostics-api.mjs';
const uuid=/^[a-f0-9-]{36}$/i;
const hash=value=>createHash('sha256').update(value).digest('hex');
async function safeFile(path,limit,reader){let handle;try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const metadata=await handle.stat();if(!metadata.isFile()||metadata.size>limit)throw Error('Diagnostic file exceeds budget');return await reader(handle,metadata);}finally{await handle?.close();}}
const json=path=>safeFile(path,256*1024,async handle=>JSON.parse(await handle.readFile('utf8')));
// Runs exclusively in Main. Never opens a Worker plugin execution channel.
export function installWorkerDiagnostics({root},owner){
 return registerDiagnosticSource({apiVersion:1,id:'agent-worker.events',pluginId:'agent-worker',label:'Worker 执行与 Main 协作',
  async open({agentId,signal}){
   const cursors=new Map();let closed=false,started=false,rotation=0;
   async function catalog(){
    let names;try{names=await readdir(root);}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const ids=names.filter(name=>uuid.test(name.slice(0,-5))&&name.endsWith('.json')).sort().map(name=>name.slice(0,-5));
    if(ids.length>2000)throw Error('Worker diagnostic catalog exceeds budget');
    const valid=new Set(ids);for(const id of cursors.keys())if(!valid.has(id))cursors.delete(id);return ids;
   }
   async function authorized(ids){
    const jobs=[];
    for(const jobId of ids){signal.throwIfAborted();let job,request;try{job=await json(join(root,jobId+'.json'));if(job.provenance?.agentId&&job.provenance.agentId!==agentId)continue;request=await json(join(root,jobId+'.request.json'));}catch{continue;}
     if(job.jobId!==jobId||typeof request.params?.topic!=='string'||typeof request.scope!=='string'||!request.scope.startsWith('agent:'+agentId+':')||job.scope!==hash(request.scope)||request.params?.topic!==job.topic||job.requestKey!==requestKeyFor(request.params,request.scope,job.provenance))continue;
     jobs.push({jobId,job});
    }return jobs;
   }
   async function scan(baseline=false){
    const ids=await catalog(),events=[];
    if(baseline){
     // Snapshot offsets without reading any event body or task metadata. Authorization
     // is rechecked in Main for each bounded group immediately before reading bytes.
     for(let from=0;from<ids.length;from+=16){signal.throwIfAborted();await Promise.all(ids.slice(from,from+16).map(async jobId=>{try{await safeFile(join(root,jobId+'.events.jsonl'),6*1024*1024,async(_,metadata)=>{cursors.set(jobId,{offset:metadata.size,tail:'',skip:false,identity:String(metadata.dev)+':'+metadata.ino});});}catch{}}));}return [];
    }
    // Scan cheap file metadata first: hundreds of idle historical jobs must not
    // impose a full round-robin delay on a newly active job. Event bodies and
    // ownership metadata are still read only for a bounded changed set.
    const changed=[];
    for(let from=0;from<ids.length;from+=16){signal.throwIfAborted();await Promise.all(ids.slice(from,from+16).map(async jobId=>{try{await safeFile(join(root,jobId+'.events.jsonl'),6*1024*1024,async(_,metadata)=>{const prior=cursors.get(jobId),identity=String(metadata.dev)+':'+metadata.ino;if(!prior||prior.identity!==identity||prior.offset!==metadata.size)changed.push(jobId);});}catch(error){if(error.code!=='ENOENT')changed.push(jobId);}}));}
    changed.sort();const selected=Array.from({length:Math.min(changed.length,16)},(_,i)=>changed[(rotation+i)%changed.length]);if(changed.length)rotation=(rotation+16)%changed.length;
    const batch=await authorized(selected);
    for(const {jobId,job} of batch){if(closed||signal.aborted)break;
     try{await safeFile(join(root,jobId+'.events.jsonl'),6*1024*1024,async(handle,metadata)=>{
      const identity=String(metadata.dev)+':'+metadata.ino,prior=cursors.get(jobId);let cursor=prior??{offset:baseline?metadata.size:0,tail:'',skip:false,identity};
      if(cursor.identity!==identity||cursor.offset>metadata.size){cursor={offset:0,tail:'',skip:false,identity};events.push({level:'warn',eventName:'capture.reset',category:'capture',message:'Worker 日志文件已轮换或截断',jobId});}
      cursors.set(jobId,cursor);if(baseline)return;
      const buffer=Buffer.alloc(Math.min(64*1024,Math.max(0,metadata.size-cursor.offset))),{bytesRead}=await handle.read(buffer,0,buffer.length,cursor.offset);cursor.offset+=bytesRead;
      // Keep raw bytes until a newline so split UTF-8 characters survive reads.
      const content=Buffer.concat([Buffer.from(cursor.tail,'base64'),buffer.subarray(0,bytesRead)]);let from=0;
      for(let end=content.indexOf(10);end>=0;end=content.indexOf(10,from)){
       const line=content.subarray(from,end);from=end+1;if(cursor.skip){cursor.skip=false;continue;}
       if(line.length>16*1024){events.push({level:'warn',eventName:'capture.omitted',category:'capture',message:'一条 Worker 调试记录超过大小限制，已省略',jobId});continue;}
       try{const row=JSON.parse(line.toString('utf8'));events.push({time:row.time,level:/failed|error/.test(row.event??'')?'error':row.event==='inspection.omitted'?'warn':'debug',category:'worker',eventName:row.event??'worker.event',message:row.event??'Worker 调试事件',jobId,projectId:job.projectId,traceId:jobId,phase:/^main\./.test(row.event??'')?'main':'worker',data:row});}catch{events.push({level:'warn',category:'capture',eventName:'capture.invalid',message:'一条 Worker 事件无法解析',jobId});}
      }
      const remainder=content.subarray(from);if(remainder.length>16*1024){if(!cursor.skip)events.push({level:'warn',category:'capture',eventName:'capture.omitted',message:'一条 Worker 调试记录超过大小限制，已省略',jobId});cursor.tail='';cursor.skip=true;}else cursor.tail=remainder.toString('base64');
     });}catch(error){if(error.code!=='ENOENT')events.push({level:'warn',category:'capture',eventName:'capture.unavailable',message:'Worker 调试文件暂不可读',jobId});}
    }
    if(events.length>100)return [{level:'warn',category:'capture',eventName:'capture.omitted',message:'本批超出上报限制，已省略 '+(events.length-99)+' 条 Worker 事件'},...events.slice(-99)];return events;
   }
   await scan(true);started=true;
   return {async read(){if(closed||!started)return [];return scan();},close(){closed=true;cursors.clear();}};
  },
 },owner);
}
