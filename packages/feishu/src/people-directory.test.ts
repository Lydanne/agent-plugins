import {afterEach,expect,it,vi} from 'vitest';
import {collectTaskPeople} from './people-directory.js';
import {registerPeopleService} from '../../agent-repo-api/people.mjs';
import {FeishuConfigSchema} from './config-schema.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPeopleStore} from '../../agent-repo/people.mjs';
import {queryPeople} from '../../agent-repo/people-query.mjs';
const directory=vi.hoisted(()=>vi.fn());vi.mock('./bot-sender-name.js',()=>({resolveFeishuSenderName:directory}));
const disposers:Array<()=>void>=[];afterEach(()=>{disposers.splice(0).forEach(fn=>fn());vi.clearAllMocks();});
const account={accountId:'a',appId:'app',enabled:true,configured:true,appSecret:'test-only',domain:'feishu',config:FeishuConfigSchema.parse({})};
it('collects only sender and native mentions from the admitted Agent, keeping recorder separate',async()=>{
 const seen:any[]=[];disposers.push(registerPeopleService('main',{observe:(person:any)=>{seen.push(person);return {...person,giteaUsername:person.email?.split('@')[0]??null};},lookup:()=>null} as any,Symbol()));
 directory.mockResolvedValue({name:'开发同事',email:'developer@example.invalid',departments:[{id:'dev',name:'研发'}]});
 const result=await collectTaskPeople({agentId:'main',account,senderId:'ou_reporter',directory:{name:'客服同事',email:'reporter@example.invalid'},mentions:[{openId:'ou_dev'},{openId:'ou_dev'},{openId:'all'},{openId:'ou_reporter'}],log:vi.fn()});
 expect(result?.requester.giteaUsername).toBe('reporter');expect(result?.mentions.map(p=>p.giteaUsername)).toEqual(['developer']);expect(seen).toHaveLength(2);expect(seen.every(p=>p.appId==='app'&&p.accountId==='a')).toBe(true);
 expect(await collectTaskPeople({agentId:'other',account,senderId:'ou_reporter',directory:{},mentions:[],log:vi.fn()})).toBeUndefined();
});
it('retains native mention identity when directory data is unavailable',async()=>{
 disposers.push(registerPeopleService('main',{observe:(person:any)=>person,lookup:()=>null} as any,Symbol()));directory.mockRejectedValue(Error('no permissions'));
 const result=await collectTaskPeople({agentId:'main',account,senderId:'ou_reporter',directory:{},mentions:[{openId:'ou_dev',name:'开发同事'}],log:vi.fn()});expect(result?.mentions[0]).toMatchObject({openId:'ou_dev',name:'开发同事'});expect(result?.mentions[0].email).toBeUndefined();
});
it('persists admitted contacts into only the routed Agent Repo and exposes them through person/people',async()=>{
 const root=mkdtempSync(join(tmpdir(),'routed-people-'));
 try {
  const alice=join(root,'alice'),other=join(root,'other');
  const {mkdirSync}=await import('node:fs');mkdirSync(alice);mkdirSync(other);
  const store=createPeopleStore(alice);
  disposers.push(registerPeopleService('alice',store,Symbol()));
  directory.mockResolvedValue({name:'原生被提及人',email:'mention@example.invalid'});
  const result=await collectTaskPeople({agentId:'alice',account,senderId:'ou_reporter',directory:{name:'实际发送者',email:'reporter@example.invalid'},mentions:[{openId:'ou_mention'}],log:vi.fn()});
  expect(queryPeople(alice,{action:'person',openId:'ou_reporter'}).person.email).toBe('reporter@example.invalid');
  expect(queryPeople(alice,{action:'people'}).total).toBe(2);
  expect(queryPeople(other,{action:'people'}).total).toBe(0);
  // Effective manual corrections survive future incoming observations.
  const person=result!.requester;
  store.update({id:person.id,revision:person.revision,patch:{name:'人工更正姓名'}});
  const again=await collectTaskPeople({agentId:'alice',account,senderId:'ou_reporter',directory:{name:'旧通讯录姓名'},mentions:[],log:vi.fn()});
  expect(again!.requester.name).toBe('人工更正姓名');
  expect(queryPeople(alice,{action:'people'}).total).toBe(2);
 } finally {rmSync(root,{recursive:true,force:true});}
});
