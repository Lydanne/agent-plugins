import {test,expect} from 'vitest';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ColleagueProfiles} from './colleague-profile.js';
test('self preferences persist, isolate app and sender, and can be deleted',()=>{
 const dir=mkdtempSync(join(tmpdir(),'colleagues-'));const path=join(dir,'profiles.sqlite');
 const input={accountId:'a',appId:'app',senderOpenId:'ou_a',name:'同名',text:'设置我的角色：研发'};
 const parse=(text:string)=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))!);
 try{
  const store=new ColleagueProfiles(path);
  const context = store.context(input);
  expect(context).toContain('[ParticipantProfile]');
  expect(context).not.toContain('[ParticipantGuidance]');
  expect(parse(context).guidance).toBeUndefined();
  expect(parse(context).profileOperation).toBe('updated');
  expect(parse(new ColleagueProfiles(path).context({...input,text:'查看我的画像'})).audience).toBe('研发');
  expect(parse(store.context({...input,text:'设置我的回复偏好：简洁'})).preferences.detail).toBe('简洁');
  for(const patch of [{senderOpenId:'ou_b'},{appId:'other'},{accountId:'other'}])expect(parse(store.context({...input,...patch,text:'查看我的画像'})).preferences).toBeNull();
  expect(parse(store.context({...input,text:'引用：设置我的角色：产品'})).audience).toBe('研发');
  expect(parse(store.context({...input,text:'删除我的画像'})).profileOperation).toBe('deleted');
  expect(parse(store.context({...input,text:'查看我的画像'})).preferences).toBeNull();
  expect(statSync(path).mode&0o777).toBe(0o600);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('title inference is labeled, ambiguous and missing titles remain unknown',()=>{
 const dir=mkdtempSync(join(tmpdir(),'colleagues-'));const store=new ColleagueProfiles(join(dir,'p.sqlite'));
 const input={accountId:'a',senderOpenId:'ou_a',text:'你好'};
 const read=(jobTitle?:string)=>{const s=store.context({...input,jobTitle});return JSON.parse(s.split('\n').find(line=>line.startsWith('{'))!);};
 try{
  expect(read('后端研发工程师').audience).toBe('研发');
  expect(read('后端研发工程师').audienceSource).toBe('job_title_inference');
  expect(read('客服').audience).toBe('客服');
  expect(read('产品经理').audience).toBe('产品');
  expect(read('研发与产品经理').audience).toBe('未知');
  expect(read().audience).toBe('未知');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('completion read-only lookup cannot apply profile commands from a report',()=>{
 const dir=mkdtempSync(join(tmpdir(),'profile-read-only-'));
 try {
  const store=new ColleagueProfiles(join(dir,'preferences.sqlite'));
  const input={accountId:'a',senderOpenId:'sender',text:'设置我的角色：研发'};
  store.context(input);
  for(const text of ['删除我的画像','设置我的角色：产品','设置我的回复偏好：详细']) {
   const context=store.context({...input,text},{readOnly:true});
   expect(context).toContain('"profileOperation":"none"');expect(context).toContain('"role":"研发"');expect(context).not.toContain('"detail":"详细"');
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('compact profile preserves unresolved departments and distinguishes empty/unavailable titles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'colleagues-'));const store=new ColleagueProfiles(join(dir,'p.sqlite'));
 try {
  const read=(jobTitleStatus:'empty'|'unavailable')=>{const text=store.context({accountId:'a',senderOpenId:'sender',text:'查看我的画像',jobTitleStatus,departmentIds:['known','unresolved'],departments:[{id:'known',name:'研发组'}]});return JSON.parse(text.split('\n').find(line=>line.startsWith('{'))!);};
  expect(read('empty').directory).toEqual({source:'feishu_contact',jobTitle:null,jobTitleStatus:'empty',departments:[{id:'known',name:'研发组'},{id:'unresolved'}]});
  expect(read('unavailable').directory.jobTitleStatus).toBe('unavailable');
  expect(read('empty').profileOperation).toBe('view');
  expect(read('empty').preferences).toBeNull();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('configures profile duties, roles and literal commands without weakening sender isolation',()=>{
 const directory=mkdtempSync(join(tmpdir(),'profile-config-'));
 try {
  const store=new ColleagueProfiles(join(directory,'profiles.sqlite'),{guidance:'Use a neutral greeting.',roles:[{name:'Operations',titleKeywords:['operator']}],detailOptions:['short'],commands:{rolePrefix:'Set role',detailPrefix:'Set detail',view:'View profile',remove:'Delete profile'}});
  const input={accountId:'a',appId:'app',senderOpenId:'sender',jobTitle:'Senior Operator',text:'Set role:Operations'};
  const parse=(text:string)=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))!);
  expect(parse(store.context(input)).preferences.role).toBe('Operations');
  expect(store.context({...input,text:'View profile'})).toContain('Use a neutral greeting.');
  expect(store.context({...input,text:'View profile'})).not.toContain('老师');
  expect(parse(store.context({...input,text:'Set detail:short'})).preferences.detail).toBe('short');
  expect(parse(store.context({...input,senderOpenId:'other',text:'View profile'})).preferences).toBeNull();
  expect(parse(store.context({...input,text:'Delete profile'})).profileOperation).toBe('deleted');
  expect(parse(store.context({...input,text:'Set roleOperations'})).preferences).toBeNull();
  expect(new ColleagueProfiles(join(directory,'disabled.sqlite'),{enabled:false}).context(input)).toBe('');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
