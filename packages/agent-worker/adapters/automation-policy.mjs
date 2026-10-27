import {fault} from '../task-service/store.mjs';
export const automationDefaults={enabled:false,callers:[],agents:[],projects:[],queueId:'automation',timeoutMs:3600000};
const strings={type:'array',maxItems:50,items:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$',maxLength:160}};
export const automationSchema={type:'object',additionalProperties:false,required:Object.keys(automationDefaults),properties:{enabled:{type:'boolean'},callers:strings,agents:strings,projects:strings,queueId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',maxLength:64},timeoutMs:{type:'integer',minimum:1000,maximum:86400000}}};
/** Identity comes only from the authenticated transport, never workflow/runId or tool input. */
export function automationCaller(client,policy){
 if(!client||client.invalidated||client.connectionSignal?.aborted||client.internal?.syntheticClient||client.internal?.isLocalClient!==true)throw fault('AUTOMATION_CALLER_DENIED');
 const owner=client.authenticatedUserId?'user:'+client.authenticatedUserId:client.pairedClientId?'paired:'+client.pairedClientId:'local-gateway-operator';
 if(!policy.callers.includes(owner))throw fault('AUTOMATION_CALLER_DENIED');return owner;
}
