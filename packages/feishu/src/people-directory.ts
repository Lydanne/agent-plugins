import {getPeopleService, type Person} from '../../agent-repo-api/people.mjs';
import {resolveFeishuSenderName} from './bot-sender-name.js';
import type {ResolvedFeishuAccount} from './types.js';
export type TaskPeople = {requester:Person;mentions:Person[]};
/** Only call with the admitted channel event and its resolved Agent route. */
export async function collectTaskPeople(input:{agentId:string;account:ResolvedFeishuAccount;senderId:string;senderName?:string;directory:Awaited<ReturnType<typeof resolveFeishuSenderName>>;mentions:{openId:string;name?:string}[];log:(...args:unknown[])=>void}):Promise<TaskPeople|undefined>{
 const service=getPeopleService(input.agentId);
 if(!service||!input.account.appId)return;
 const scope={accountId:input.account.accountId,appId:input.account.appId};
 let senderDirectory=input.directory;
 if(!Object.keys(senderDirectory).length){try{senderDirectory=await resolveFeishuSenderName({account:input.account,senderId:input.senderId,log:input.log});}catch{ /* Event identity remains usable without contact permissions. */ }}
 const requester=service.observe({...scope,openId:input.senderId,name:senderDirectory.name??input.senderName,...senderDirectory});
 const mentions:Person[]=[];
 const targets=[...new Map(input.mentions.filter(item=>item.openId!==input.senderId&&item.openId.startsWith('ou_')).map(item=>[item.openId,item])).values()].slice(0,20);
 for(let offset=0;offset<targets.length;offset+=4){
  mentions.push(...await Promise.all(targets.slice(offset,offset+4).map(async target=>{
   let directory:Awaited<ReturnType<typeof resolveFeishuSenderName>>={};
   try{directory=await resolveFeishuSenderName({account:input.account,senderId:target.openId,log:input.log});}catch{ /* Preserve event identity when directory permissions are missing. */ }
   return service.observe({...scope,openId:target.openId,name:directory.name??target.name,...directory});
  })));
 }
 return {requester,mentions};
}
