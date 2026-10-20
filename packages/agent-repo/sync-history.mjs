import {readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {repositorySyncTaskId,repositorySyncRunId} from './scheduled-tasks.mjs';
import {git} from './repository-skills.mjs';
const validAgent=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const text=value=>typeof value==='string'?value.slice(0,2000):undefined;
function summary(record,date,agentId){
 if(record.agentId!==agentId||record.date!==date||!['running','completed','failed'].includes(record.status))throw Error('Invalid sync receipt');
 return {taskId:repositorySyncTaskId(agentId),runId:repositorySyncRunId(agentId,date),trigger:'scheduled',date,status:record.status,startedAt:text(record.startedAt),finishedAt:text(record.finishedAt),reason:text(record.result?.reason),failures:Array.isArray(record.result?.failures)?record.result.failures.slice(0,100).map(row=>({projectId:text(row.projectId),reason:text(row.reason)})):[],logCount:Array.isArray(record.logs)?record.logs.length:0,logsTruncated:record.logsTruncated===true};
}
async function read(directory,date,agentId,includeLogs){
 const handle=await open(join(directory,`agent-repo-daily-sync-${agentId}-${date}.json`),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>512*1024)throw Error('Invalid receipt size');
  const record=JSON.parse(await handle.readFile('utf8')),result=summary(record,date,agentId);
  if(includeLogs)result.logs=(Array.isArray(record.logs)?record.logs:[]).slice(0,400).map(row=>Object.fromEntries(['time','stage','status','projectId','repository','branch','head','reason'].flatMap(key=>typeof row[key]==='string'?[[key,text(row[key])]]:[])));
  return result;
 }finally{await handle.close();}
}
export async function readSyncHistory(root,agentId,date){
 if(!validAgent(agentId)||date!==undefined&&!validDate(date))throw Error('Invalid sync history selector');
 const directory=(await git(root,['rev-parse','--absolute-git-dir'])).trim();
 if(date!==undefined)return read(directory,date,agentId,true);
 const prefix=`agent-repo-daily-sync-${agentId}-`,names=await readdir(directory);
 const dates=names.filter(name=>name.startsWith(prefix)&&name.endsWith('.json')&&validDate(name.slice(prefix.length,-5))).map(name=>name.slice(prefix.length,-5)).sort().reverse();
 const records=[];
 for(const day of dates.slice(0,30)){
  try{records.push(await read(directory,day,agentId,false));}
  catch{records.push({taskId:repositorySyncTaskId(agentId),runId:repositorySyncRunId(agentId,day),trigger:'scheduled',date:day,status:'unavailable',reason:'记录不可读取或格式无效',failures:[],logCount:0});}
 }
 return {records,hasMore:dates.length>30};
}
