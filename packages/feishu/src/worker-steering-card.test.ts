import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('./send.js',()=>({editMessageFeishu:vi.fn(async()=>({}))}));
vi.mock('./accounts.js',()=>({resolveFeishuRuntimeAccount:()=>({accountId:'a'})}));
vi.mock('./bot-sender-name.js',()=>({resolveFeishuSenderName:vi.fn(async()=>({name:'同事'}))}));
import {editMessageFeishu} from './send.js';
import {updateSteeringCard,renderSteeringCard,type SteeringCardEvent} from './worker-steering-card.js';
import {bindAsyncTaskCard,readAsyncTaskCard,acceptAsyncCardResult} from './async-task-card.js';
import type {ClawdbotConfig} from '../runtime-api.js';
let root:string;
const source={taskId:'source',revision:0,accountId:'a',chatId:'chat',sessionKey:'session',senderId:'owner'};
const event:SteeringCardEvent={jobId:'job',provenance:source,kind:'supplement_received',steering:true,supplementId:'hint',answer:'新增完整账号 abc-123',supplementSenderId:'contributor',supplementAt:1793702054825};
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'steering-card-'));vi.clearAllMocks();bindAsyncTaskCard(root,source,['job'],{messageId:'original-working',imageKey:'gif'});});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
const update=(e:SteeringCardEvent=event,authorize=()=>true)=>updateSteeringCard({cfg:{} as ClawdbotConfig,stateDir:root,event:e,authorize});
it('edits the original working card with person, time, content and honest delivery status',async()=>{
 await update();const sent=vi.mocked(editMessageFeishu).mock.calls[0][0];expect(sent.messageId).toBe('original-working');expect(JSON.stringify(sent.card)).toContain('已补充');expect(JSON.stringify(sent.card)).toContain('同事（contributor）');expect(JSON.stringify(sent.card)).toContain('新增完整账号 abc-123');expect(JSON.stringify(sent.card)).toContain('正在等待送达');
 expect(readAsyncTaskCard(root,'job',source)?.result).toBeUndefined();await update();expect(editMessageFeishu).toHaveBeenCalledTimes(1);
 await update({...event,kind:'supplement_dispatched',liveState:'delivered'});expect(JSON.stringify(vi.mocked(editMessageFeishu).mock.calls[1][0].card)).toContain('已送入当前执行');
});
it('multiple supplements retain earlier authors and content without duplicate entries',async()=>{
 await update();await update({...event,supplementId:'second',supplementAt:1793702055825,answer:'第二条'});await update({...event,kind:'supplement_dispatched',liveState:'delivered'});
 const binding=readAsyncTaskCard(root,'job',source)!;expect(binding.steeringEntries).toHaveLength(2);expect(binding.progress).toContain('第二条');expect(binding.progress).toContain('abc-123');
});
it('does not replace final results or update another source or revoked input',async()=>{
 await update({...event,provenance:{...source,chatId:'other'}});await update(event,()=>false);expect(editMessageFeishu).not.toHaveBeenCalled();
 acceptAsyncCardResult(root,readAsyncTaskCard(root,'job',source)!,'final');await update();expect(editMessageFeishu).not.toHaveBeenCalled();
});
it('failed edits retain retryable state and untrusted text is plain text',async()=>{
 vi.mocked(editMessageFeishu).mockRejectedValueOnce(Error('network'));await expect(update()).rejects.toThrow('network');expect(readAsyncTaskCard(root,'job',source)?.steeringEntries).toBeUndefined();await update();expect(editMessageFeishu).toHaveBeenCalledTimes(2);
 const rendered=renderSteeringCard({...event,answer:'<at id="all"></at>'},'person');expect(rendered.card.body.elements[0].text.tag).toBe('plain_text');
});
