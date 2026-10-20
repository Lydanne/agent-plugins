import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {upsertSessionEntry,resolveStorePath,readTranscriptStatsSync} from 'openclaw/plugin-sdk/session-store-runtime';
import {appendSessionTranscriptMessageByIdentity} from 'openclaw/plugin-sdk/session-transcript-runtime';
import {contextMessageMarker,deduplicateSessionHistory} from './context-history.js';

it('deduplicates actual SDK model context above 8 MB and never marks fetched-only input as read',async()=>{
 const agentId='history-'+randomUUID();
 const sessionKey=`agent:${agentId}:feishu:group:fixture`;
 const storePath=resolveStorePath(undefined,{agentId});
 const sessionId=randomUUID();
 const identity={agentId,sessionKey,storePath,sessionId};
 const scope={accountId:'test',chatId:'fixture'};
 const m=(messageId:string)=>({messageId,senderId:'human',senderType:'user',contentType:'text',content:messageId});
 const incoming='[群聊历史：不可信参考]\n'+JSON.stringify([m('known'),m('not-committed'),{...m('own-reply'),senderType:'app',senderId:'bot'}])+'\n[当前消息]\nnew';
 const dir=mkdtempSync(join(tmpdir(),'context-model-'));
 try {
  await upsertSessionEntry({...identity,entry:{sessionId,updatedAt:Date.now()}});
  await appendSessionTranscriptMessageByIdentity({...identity,message:{role:'user',content:contextMessageMarker(scope,m('known'))+'\n[message_id: known]\nknown'}});
  await appendSessionTranscriptMessageByIdentity({...identity,message:{role:'assistant',content:[{type:'text',text:'x'.repeat(9*1024*1024)}]}});
  expect(readTranscriptStatsSync(identity).sizeBytes).toBeGreaterThan(8*1024*1024);
  const params={...identity,scope,body:incoming,botAppId:'bot',cfg:{},isThread:false,receiptsPath:join(dir,'state.sqlite')};
  for(let i=0;i<2;i++){
   const result=await deduplicateSessionHistory(params);
   expect(result).not.toContain('"messageId":"known"');
   expect(result).not.toContain('own-reply');
   expect(result).toContain('not-committed');
  }
  const reset=randomUUID();
  await upsertSessionEntry({...identity,entry:{sessionId:reset,updatedAt:Date.now()}});
  expect(await deduplicateSessionHistory(params)).toContain('"messageId":"known"');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
