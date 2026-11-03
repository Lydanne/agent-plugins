import {readAsyncTaskCard,prepareAsyncCardResult,acceptAsyncSteeringCard,type AsyncTaskCard} from './async-task-card.js';
import {editMessageFeishu} from './send.js';
import {resolveFeishuRuntimeAccount} from './accounts.js';
import {resolveFeishuSenderName} from './bot-sender-name.js';
import type {ClawdbotConfig} from '../runtime-api.js';

type Source=Pick<AsyncTaskCard,'taskId'|'revision'|'accountId'|'chatId'|'sessionKey'|'senderId'>;
export type SteeringCardEvent={jobId:string;provenance:Source;kind:string;steering?:unknown;supplementId?:string;answer?:unknown;supplementSenderId?:unknown;supplementAt?:unknown;liveState?:unknown};
export function renderSteeringCard(event:SteeringCardEvent,name:string){
 const delivered=event.kind==='supplement_dispatched';
 const state=delivered?(event.liveState==='delivered'?'已送入当前执行，任务继续运行。':'已交回原任务继续处理。'):event.kind==='supplement_unavailable'?'补充已保存，但未能确认送达，请核对任务状态。':'补充已保存，正在等待送达执行器；任务继续运行。';
 const original=typeof event.answer==='string'?event.answer:'';
 const answer=Buffer.byteLength(original,'utf8')>20000?original.slice(0,5000)+'\n（内容较长，此处为节选；完整补充保留在原消息和任务记录中。）':original;
 const at=typeof event.supplementAt==='number'?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium',hour12:false}).format(event.supplementAt):'时间未取得';
 const text=`补充人：${name}\n补充时间：${at}（北京时间）\n${state}\n\n补充内容：\n${answer}`;
 return {text,card:{schema:'2.0',config:{update_multi:true},header:{title:{tag:'plain_text',content:'已补充'},template:'blue'},body:{elements:[{tag:'div',text:{tag:'plain_text',content:text}}]}}};
}
export async function updateSteeringCard({cfg,stateDir,event,authorize}:{cfg:ClawdbotConfig;stateDir:string;event:SteeringCardEvent;authorize:()=>boolean}){
 if(event.steering!==true||!['supplement_received','supplement_dispatched','supplement_unavailable'].includes(event.kind)||typeof event.supplementSenderId!=='string'||!authorize())return;
 const binding=readAsyncTaskCard(stateDir,event.jobId,event.provenance);
 if(!binding||binding.result!==undefined)return;
 const account=resolveFeishuRuntimeAccount({cfg,accountId:event.provenance.accountId});
 let name=event.supplementSenderId;
 try{const directory=await resolveFeishuSenderName({account,senderId:name,log:()=>{}});if(directory.name)name=directory.name+'（'+event.supplementSenderId+'）';}catch{}
 const latestEntry=renderSteeringCard(event,name);
 const entries=[...(binding.steeringEntries??[]).filter(entry=>entry.id!==event.supplementId),{id:event.supplementId??'',text:latestEntry.text,at:typeof event.supplementAt==='number'?event.supplementAt:0,state:event.kind}].sort((a,b)=>a.at-b.at);
 const ownText=entries.map(entry=>entry.text).join('\n\n────────\n\n');
 const combined=prepareAsyncCardResult(stateDir,binding,ownText).combined;
 const text=Buffer.byteLength(combined,'utf8')>24000?'共 '+entries.length+' 次补充，以下展示最近一次；完整记录见原补充消息。\n\n'+entries.at(-1)!.text:combined;
 const rendered={text,card:{...latestEntry.card,body:{elements:[{tag:'div',text:{tag:'plain_text',content:text}}]}}};
 if(binding.progress===rendered.text||!authorize())return;
 const latest=readAsyncTaskCard(stateDir,event.jobId,event.provenance);
 if(!latest||latest.result!==undefined||latest.messageId!==binding.messageId)return;
 await editMessageFeishu({cfg,accountId:event.provenance.accountId,messageId:binding.originalMessageId??binding.messageId,card:rendered.card});
 acceptAsyncSteeringCard(stateDir,binding,entries,rendered.text);
}
