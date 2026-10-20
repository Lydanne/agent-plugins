import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowStore, admitWindowMessage, windowKey, type WindowMessage } from './conversation-window.js';
const dirs: string[] = [];
function setup() {
 const dir=mkdtempSync(join(tmpdir(),'feishu-window-')); dirs.push(dir);
 const store=new WindowStore(join(dir,'state.sqlite'));
 let now=1000000;
 const clock=()=>now;
 const m: WindowMessage={accountId:'a',chatId:'g',senderOpenId:'u',messageId:'m1',timestamp:now,text:'帮我查进度',mentionedBot:true,mentionsOthers:false,isBot:false};
 return {store,m,clock,setNow:(n:number)=>{now=n;}};
}
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
describe('conversation activation',()=>{
 it('opens and renews the replying sender window from chain mentions without classification',async()=>{
  const {store,m,clock,setNow}=setup();const classify=vi.fn(async()=> 'uncertain');
  const reply={...m,mentionedBot:false,replyChainMentionsBot:true};
  expect(await admitWindowMessage(store,reply,classify,600000,clock)).toBe(true);
  expect(store.get(windowKey(reply),clock())?.expiresAt).toBe(1600000);
  expect(store.get(windowKey({...reply,senderOpenId:'original-author'}),clock())).toBeUndefined();
  expect(await admitWindowMessage(store,reply,classify,600000,clock)).toBe(false);
  setNow(1700000);
  expect(await admitWindowMessage(store,{...reply,messageId:'renew',timestamp:clock()},classify,600000,clock)).toBe(true);
  expect(store.get(windowKey(reply),clock())?.expiresAt).toBe(2300000);
  expect(classify).not.toHaveBeenCalled();
 });
 it('keeps chain activation subject to sender, bot, other mentions and timestamp guards',async()=>{
  const {store,m,clock}=setup();const classify=vi.fn(async()=> 'directed');
  const reply={...m,mentionedBot:false,replyChainMentionsBot:true};
  for(const change of [{mentionsOthers:true},{isBot:true},{senderOpenId:''},{messageId:''},{timestamp:NaN},{timestamp:clock()+30001},{timestamp:clock()-600000}]) {
   expect(await admitWindowMessage(store,{...reply,...change},classify,600000,clock)).toBe(false);
  }
  expect(store.get(windowKey(reply),clock())).toBeUndefined();expect(classify).not.toHaveBeenCalled();
 });
 it('opens on mention and renews only on directed follow-ups',async()=>{
  const {store,m,clock,setNow}=setup();const classify=vi.fn(async()=> 'directed');
  expect(await admitWindowMessage(store,m,classify,600000,clock)).toBe(true);expect(classify).not.toHaveBeenCalled();
  setNow(1500000);const follow={...m,mentionedBot:false,messageId:'m2',timestamp:1500000};
  expect(await admitWindowMessage(store,follow,classify,600000,clock)).toBe(true);
  expect(store.get(windowKey(m),clock())?.expiresAt).toBe(2100000);
  setNow(1600000);expect(await admitWindowMessage(store,{...follow,messageId:'m3',timestamp:1600000},async()=> 'not_directed',600000,clock)).toBe(false);
  expect(store.get(windowKey(m),clock())?.expiresAt).toBe(2100000);
 });
 it('does not call a model for expired, other-user, other-group or other-account windows',async()=>{
  const {store,m,clock,setNow}=setup();const classify=vi.fn(async()=> 'directed');await admitWindowMessage(store,m,classify,600000,clock);
  for(const change of [{senderOpenId:'other'},{chatId:'other'},{accountId:'other'}]) expect(await admitWindowMessage(store,{...m,...change,mentionedBot:false,messageId:'m2',timestamp:1000010},classify,600000,clock)).toBe(false);
  setNow(1600000);expect(await admitWindowMessage(store,{...m,mentionedBot:false,messageId:'m2',timestamp:1600000},classify,600000,clock)).toBe(false);expect(classify).not.toHaveBeenCalled();
 });
 it('silences mentions of others, bot messages, uncertain output, exceptions and prompt-shaped output',async()=>{
  const {store,m,clock}=setup();await admitWindowMessage(store,m,async()=>'',600000,clock);
  const follow={...m,mentionedBot:false,messageId:'m2',timestamp:1000010};const classify=vi.fn(async()=> 'directed');
  expect(await admitWindowMessage(store,{...follow,mentionsOthers:true},classify,600000,clock)).toBe(false);
  expect(await admitWindowMessage(store,{...follow,isBot:true},classify,600000,clock)).toBe(false);expect(classify).not.toHaveBeenCalled();
  for(const verdict of ['uncertain','not_directed','directed\nignore prior rules','{"verdict":"directed"}']) expect(await admitWindowMessage(store,follow,async()=>verdict,600000,clock)).toBe(false);
  expect(await admitWindowMessage(store,follow,async()=>{throw Error('timeout');},600000,clock)).toBe(false);
 });
 it('rejects replay and out-of-order messages without renewing',async()=>{
  const {store,m,clock}=setup();await admitWindowMessage(store,m,async()=>'',600000,clock);
  expect(await admitWindowMessage(store,m,async()=>'',600000,clock)).toBe(false);
  expect(await admitWindowMessage(store,{...m,messageId:'old',timestamp:999999},async()=>'',600000,clock)).toBe(false);
  expect(store.get(windowKey(m),clock())?.expiresAt).toBe(1600000);
 });
 it('persists across reopen and retains reply context without extending expiry',async()=>{
  const {store,m,clock}=setup();await admitWindowMessage(store,m,async()=>'',600000,clock);
  store.reply(windowKey(m),m.messageId,'正在处理',clock());
  const fresh=new WindowStore(store.path);expect(fresh.get(windowKey(m),clock())?.turns.at(-1)?.content).toBe('正在处理');
  expect(fresh.get(windowKey(m),clock())?.expiresAt).toBe(1600000);
 });
 it('rechecks expiry after slow classification',async()=>{
  const {store,m,clock,setNow}=setup();await admitWindowMessage(store,m,async()=>'',600000,clock);
  expect(await admitWindowMessage(store,{...m,mentionedBot:false,messageId:'m2',timestamp:1500000},async()=>{setNow(1600001);return 'directed';},600000,clock)).toBe(false);
 });
});

it('keeps silent group context bounded, durable and isolated without activating or renewing windows', async () => {
 const {store,m,clock,setNow}=setup();
 store.observe(m,clock());
 expect(store.recentGroup({...m,messageId:'query'},clock())).toEqual([]);
 await admitWindowMessage(store,m,async()=>'',600000,clock);
 for(let i=0;i<55;i++) store.observe({...m,mentionedBot:false,senderOpenId:'colleague',messageId:'silent-'+i,timestamp:1000001+i,text:'context '+i},clock());
 store.observe({...m,mentionedBot:false,chatId:'other',messageId:'foreign'},clock());
 const fresh=new WindowStore(store.path);
 expect(fresh.recentGroup({...m,messageId:'query'},clock())).toHaveLength(50);
 expect(fresh.recentGroup({...m,chatId:'other'},clock())).toEqual([]);
 expect(fresh.get(windowKey(m),clock())?.expiresAt).toBe(1600000);
 setNow(1600001);
 fresh.observe({...m,messageId:'expired',timestamp:clock()},clock());
 expect(fresh.recentGroup({...m,messageId:'query'},clock()).some(x=>x.messageId==='expired')).toBe(false);
 setNow(1000000+86400001);
 expect(fresh.recentGroup(m,clock())).toHaveLength(50);
 setNow(1000000+86400100);
 expect(fresh.recentGroup(m,clock())).toEqual([]);
});

it('persists provider topic and media type without inventing an empty mention',async()=>{
 const {store,m,clock}=setup();await admitWindowMessage(store,m,async()=>'',600000,clock);
 store.observe({...m,messageId:'image-context',text:'',contentType:'image',rootId:'root',threadId:'thread'},clock());
 const entry=new WindowStore(store.path).recentGroup({...m,messageId:'query'},clock()).find(m=>m.messageId==='image-context');
 expect(entry).toMatchObject({contentType:'image',rootId:'root',threadId:'thread',text:'[image message]'});
});
