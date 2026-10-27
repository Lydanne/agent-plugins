import {open,readdir,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {git} from './repository-skills.mjs';
const validAgent=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const fields=['time','repository','stage','status','reason','effect','code','cause','errorType','runId'];
const clean=value=>value.replace(/https?:\/\/\S+/g,'[URL omitted]').slice(0,2000);
async function location(root,agentId){
 if(!validAgent(agentId))throw Error('Invalid repository log Agent');
 return {directory:(await git(root,['rev-parse','--absolute-git-dir'])).trim(),prefix:`agent-repo-log-${agentId}-`};
}
async function names(directory,prefix){return (await readdir(directory)).filter(name=>name.startsWith(prefix)&&/^\d{13}-[a-f0-9-]{36}\.json$/.test(name.slice(prefix.length))).sort().reverse();}
export async function writeRepositoryLog(root,agentId,entry){
 const {directory,prefix}=await location(root,agentId),record={agentId,time:new Date().toISOString()};
 for(const field of fields.filter(key=>key!=='time'))if(typeof entry[field]==='string')record[field]=clean(entry[field]);
 const handle=await open(join(directory,`${prefix}${Date.now()}-${randomUUID()}.json`),'wx',0o600);
 try{await handle.writeFile(JSON.stringify(record));}finally{await handle.close();}
 for(const name of (await names(directory,prefix)).slice(100))await unlink(join(directory,name)).catch(()=>{});
}
export async function readRepositoryLogs(root,agentId){
 const {directory,prefix}=await location(root,agentId),records=[];
 for(const name of (await names(directory,prefix)).slice(0,100)){
  let handle;
  try{
   handle=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   const stat=await handle.stat();if(!stat.isFile()||stat.size>32*1024)continue;
   const record=JSON.parse(await handle.readFile('utf8'));if(record.agentId!==agentId)continue;
   records.push(Object.fromEntries(fields.flatMap(key=>typeof record[key]==='string'?[[key,clean(record[key])]]:[])));
  }catch{}finally{await handle?.close();}
 }
 return {agentId,records,limit:100};
}
export async function clearRepositoryLogs(root,agentId){
 const {directory,prefix}=await location(root,agentId);
 const selected=await names(directory,prefix);
 let cleared=0;
 for(const name of selected){
  try{await unlink(join(directory,name));cleared++;}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 // Entries created after the selection remain visible, rather than being
 // deleted by a second scan while clearing is in progress.
 return {...await readRepositoryLogs(root,agentId),cleared};
}
