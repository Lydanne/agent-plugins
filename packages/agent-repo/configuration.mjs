import {isAbsolute,resolve,relative} from 'node:path';
export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const object = value => value!==null && typeof value==='object' && !Array.isArray(value);
const gitName = value => typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)&&!value.includes('..')&&!/[\u0000\r\n]/.test(value);
export function resolveSync(input) {
 if(input===undefined)return undefined;
 if(!object(input)||Object.keys(input).some(key=>!['enabled','timeoutMs','branch','remote','preserveLocalMemory','inboundChannels','submoduleSchedule','gitEnvironment'].includes(key))||
  input.enabled!==undefined&&typeof input.enabled!=='boolean'||input.preserveLocalMemory!==undefined&&typeof input.preserveLocalMemory!=='boolean'||
  input.timeoutMs!==undefined&&(!Number.isInteger(input.timeoutMs)||input.timeoutMs<1000||input.timeoutMs>60000)||
  input.branch!==undefined&&!gitName(input.branch)||input.remote!==undefined&&!gitName(input.remote))throw Error('Invalid Agent Repo synchronization configuration');
 const gitEnvironment=input.gitEnvironment;
 if(gitEnvironment!==undefined&&(!object(gitEnvironment)||Object.keys(gitEnvironment).length>100||Object.entries(gitEnvironment).some(([key,value])=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)||/[\u0000\r\n]/.test(key)||typeof value!=='string'||[...value].length>40000||value.includes('\0'))))throw Error('Invalid synchronization Git environment');
 const schedule=input.submoduleSchedule;
 if(schedule!==undefined){
  if(!object(schedule)||Object.keys(schedule).some(key=>!['time','timeZone'].includes(key))||typeof schedule.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)||/[\r\n]/.test(schedule.time)||typeof schedule.timeZone!=='string'||!schedule.timeZone||schedule.timeZone.length>100)throw Error('Invalid submodule schedule');
  try{new Intl.DateTimeFormat('en',{timeZone:schedule.timeZone});}catch{throw Error('Invalid submodule schedule time zone');}
 }
 const inboundChannels=input.inboundChannels===undefined?{feishu:{messageIdPrefix:'om_'}}:input.inboundChannels;
 if(!object(inboundChannels)||!Object.keys(inboundChannels).length||Object.keys(inboundChannels).length>20||Object.entries(inboundChannels).some(([channel,rule])=>
  !/^[a-z][a-z0-9_-]{0,63}$/.test(channel)||/[\u0000\r\n]/.test(channel)||!object(rule)||Object.keys(rule).some(key=>key!=='messageIdPrefix')||
  typeof rule.messageIdPrefix!=='string'||!rule.messageIdPrefix||[...rule.messageIdPrefix].length>100||/[\u0000\r\n]/.test(rule.messageIdPrefix)))throw Error('Invalid synchronization inbound channels');
 return {enabled:input.enabled===true,timeoutMs:input.timeoutMs??30000,branch:input.branch??'main',remote:input.remote??'origin',preserveLocalMemory:input.preserveLocalMemory!==false,inboundChannels:structuredClone(inboundChannels),...(gitEnvironment!==undefined?{gitEnvironment:{...gitEnvironment}}:{}),...(schedule?{submoduleSchedule:structuredClone(schedule)}:{})};
}
export function resolveConfiguration(input={}) {
 if(!object(input)||Object.keys(input).some(key=>key!=='agents'))throw Error('Invalid agent-repo configuration');
 const agents=input.agents??{};
 if(!object(agents)||Object.keys(agents).length>100)throw Error('Invalid Agent Repo bindings');
 const result={};
 for(const [agentId,binding] of Object.entries(agents)) {
  if(!idPattern.test(agentId)||!object(binding)||Object.keys(binding).some(key=>!['repo','defaultProject','sync'].includes(key)) ||
   typeof binding.repo!=='string'||!isAbsolute(binding.repo)||/[\u0000\r\n]/.test(binding.repo)||
   binding.defaultProject!==undefined&&(typeof binding.defaultProject!=='string'||!idPattern.test(binding.defaultProject)))throw Error('Invalid Agent Repo binding');
  const repo=resolve(binding.repo);
  if(repo===resolve('/'))throw Error('Agent Repo cannot be filesystem root');
  for(const other of Object.values(result)) {
   const a=relative(repo,other.repo),b=relative(other.repo,repo);
   if(!a||(a!=='..'&&!a.startsWith('../')&&!isAbsolute(a))||(b!=='..'&&!b.startsWith('../')&&!isAbsolute(b)))throw Error('Agent Repo bindings must not overlap');
  }
  const sync=resolveSync(binding.sync);
  result[agentId]={repo,...(binding.defaultProject?{defaultProject:binding.defaultProject}:{}),...(sync?{sync}:{})};
 }
 return {agents:result};
}
export function bindingFor(config,context) {
 // Agent ownership comes from the public host tool context, never tool arguments.
 return typeof context?.agentId==='string'&&Object.hasOwn(config.agents,context.agentId)?config.agents[context.agentId]:undefined;
}
