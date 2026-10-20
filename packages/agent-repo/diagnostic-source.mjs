import {bindingFor} from './configuration.mjs';
import {readRepositoryLogs} from './repository-log.mjs';
import {registerDiagnosticSource} from './dist/diagnostics-api.mjs';
export function installRepositoryDiagnostics(config,owner){
 return registerDiagnosticSource({apiVersion:1,id:'agent-repo.repository',pluginId:'agent-repo',label:'仓库同步与准备',async open({agentId,signal}){
  const binding=bindingFor(config,{agentId});if(!binding)throw Error('Agent repository is not bound');
  let seen=new Set((await readRepositoryLogs(binding.repo,agentId)).records.map(row=>JSON.stringify(row))),closed=false;
  return {async read(){if(closed)return [];signal.throwIfAborted();const {records}=await readRepositoryLogs(binding.repo,agentId),next=new Set(records.map(row=>JSON.stringify(row)));const events=records.filter(row=>!seen.has(JSON.stringify(row))).reverse().map(row=>({time:row.time,level:row.status==='failed'?'error':'warn',category:row.stage??'repository',eventName:'repository.'+(row.status??'record'),message:row.reason??row.effect??'仓库诊断记录',data:row}));seen=next;return events;},close(){closed=true;seen.clear();}};
 }},owner);
}
