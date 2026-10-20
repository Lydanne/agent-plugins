import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {readContextReceipts,recordContextReceipts,replyTextHash,readContextState,recordContextState} from './context-receipts.js';
it('persists only confirmed receipt identities and hashes; isolates session, agent, account and group',()=>{
 const dir=mkdtempSync(join(tmpdir(),'context-receipts-'));const path=join(dir,'receipts.sqlite');
 const scope={agentId:'main',sessionId:'session',accountId:'account',chatId:'group'};
 try {
  expect(readContextReceipts(path,scope).size).toBe(0);
  recordContextReceipts(path,scope,['reply'],'完成');
  expect(readContextReceipts(path,scope).get('reply')).toBe(replyTextHash('完成'));
  for(const field of ['agentId','sessionId','accountId','chatId']) expect(readContextReceipts(path,{...scope,[field]:'other'}).size).toBe(0);
  recordContextReceipts(path,scope,['reply'],'已更新');
  expect(readContextReceipts(path,scope).get('reply')).toBe(replyTextHash('已更新'));
  expect(statSync(path).mode&0o777).toBe(0o600);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

it('replaces confirmed snapshots, isolates session keys, and rejects stale versions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'context-state-'));const path=join(dir,'state.sqlite');
 const scope={agentId:'main',sessionKey:'key',sessionId:'s',accountId:'a',chatId:'c'};
 try {
  recordContextState(path,scope,'version-1',new Map([['m','hash']]));
  expect(readContextState(path,scope,'version-1')?.get('m')).toBe('hash');
  expect(readContextState(path,scope,'version-2')).toBeUndefined();
  for(const field of Object.keys(scope))expect(readContextState(path,{...scope,[field]:'different'},'version-1')).toBeUndefined();
  recordContextState(path,scope,'version-2',new Map());
  expect(readContextState(path,scope,'version-2')?.size).toBe(0);
  expect(readContextState(path,scope,'version-1')).toBeUndefined();
 }finally {rmSync(dir,{recursive:true,force:true});}
});
