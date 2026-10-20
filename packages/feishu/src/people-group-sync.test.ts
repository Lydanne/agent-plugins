import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {createPeopleGroupSync,handlePeopleJoin} from './people-group-sync.js';
import {registerPeopleService,registerPeopleGroupSync} from '../../agent-repo-api/people.mjs';
import {createPeopleStore} from '../../agent-repo/people.mjs';
const mocks=vi.hoisted(()=>({accounts:vi.fn(),members:vi.fn(),lookup:vi.fn(),allowed:vi.fn()}));
vi.mock('./accounts.js',()=>({listEnabledFeishuAccounts:mocks.accounts}));
vi.mock('./client.js',()=>({createFeishuClient:()=>({im:{chatMembers:{get:mocks.members}}})}));
vi.mock('./read-policy.js',()=>({isFeishuGroupReadAllowed:mocks.allowed}));
vi.mock('./people-resolver.js',()=>({resolvePeopleFromFeishu:mocks.lookup}));
const account={accountId:'a',appId:'app',enabled:true,configured:true,config:{}},ctx={agentId:'main',sessionKey:'agent:main:feishu:group:oc_test',accountId:'a'};
let disposers:Array<()=>void|Promise<void>>=[];
beforeEach(()=>{vi.resetAllMocks();mocks.accounts.mockReturnValue([account]);mocks.allowed.mockReturnValue(true);mocks.members.mockResolvedValue({code:0,data:{items:[{member_id:'ou_one',name:'目录姓名'}]}});mocks.lookup.mockImplementation(async(_,input)=>({status:'found',people:[{accountId:'a',appId:'app',openId:input.openId,name:'飞书姓名',email:input.openId.slice(3)+'@example.invalid'}]}));});
afterEach(async()=>{for(const dispose of disposers.reverse())await dispose();disposers=[];});
function fixture(route=vi.fn().mockReturnValue('main')){
 const root=mkdtempSync(join(tmpdir(),'group-sync-')),store=createPeopleStore(root);disposers.push(()=>rmSync(root,{recursive:true,force:true}));disposers.push(registerPeopleService('main',store,Symbol()));
 const service=createPeopleGroupSync(()=>({}) as any,route);disposers.push(()=>service.stop());return {store,service,route};
}
async function finished(service:ReturnType<typeof createPeopleGroupSync>){for(let i=0;i<100;i++){const result=service.status(ctx);if(result?.status!=='running')return result;await tick();}throw Error('test sync did not finish');}
it('full sync paginates, deduplicates, persists profiles and preserves admin overrides',async()=>{
 const {service,store}=fixture();const first=store.observe({accountId:'a',appId:'app',openId:'ou_one',name:'旧姓名'});store.update({id:first.id,revision:first.revision,patch:{name:'人工姓名',giteaUsername:'confirmed'}});
 mocks.members.mockResolvedValueOnce({code:0,data:{items:[{member_id:'ou_one',name:'目录姓名'},{member_id:'cli_bot',name:'机器人'}],has_more:true,page_token:'p2'}}).mockResolvedValueOnce({code:0,data:{items:[{member_id:'ou_one'},{member_id:'ou_two'}]}});
 const started=service.start(ctx);expect(started.status).toBe('running');expect(service.start(ctx).id).toBe(started.id);
 const result=await finished(service);expect(result).toMatchObject({status:'completed',discovered:2,processed:2,saved:2,profiled:2,created:1,updated:1,failed:0});expect(mocks.lookup).toHaveBeenCalledTimes(2);
 expect(store.lookup({accountId:'a',appId:'app',openId:'ou_one'})).toMatchObject({name:'人工姓名',giteaUsername:'confirmed',email:'one@example.invalid'});expect(store.all()).toHaveLength(2);
});
it('bot join starts full sync, human join is incremental and repeated events do not create duplicate runs',async()=>{
 const {service,store}=fixture();disposers.push(registerPeopleGroupSync(service,Symbol()));
 handlePeopleJoin('a',{chat_id:'oc_test',event_id:'event1',app_id:'app'},'bot_join');await finished(service);expect(mocks.members).toHaveBeenCalledTimes(1);
 const first=service.status(ctx)!.id;handlePeopleJoin('a',{chat_id:'oc_test',event_id:'event1'},'bot_join');expect(service.status(ctx)!.id).toBe(first);
 handlePeopleJoin('a',{chat_id:'oc_test',event_id:'event2',users:[{user_id:{open_id:'ou_new'},name:'新同事'}]},'member_join');const second=await finished(service);expect(second!.source).toBe('member_join');expect(mocks.members).toHaveBeenCalledTimes(1);expect(store.all()).toHaveLength(2);
});
it('merges a joining user into an in-flight sync without losing the new identity',async()=>{
 const {service,store}=fixture();let release:any;mocks.members.mockImplementation(()=>new Promise(resolve=>release=resolve));const run=service.start(ctx);await tick();
 service.join('a',{chat_id:'oc_test',users:[{user_id:{open_id:'ou_new'}}]},'member_join');release({code:0,data:{items:[{member_id:'ou_one'}]}});
 expect((await finished(service))!.id).toBe(run.id);expect(store.all()).toHaveLength(2);
});
it('contact permission failures save only available native identity and report partial completion',async()=>{
 const {service,store}=fixture();mocks.lookup.mockResolvedValue({status:'error',people:[],reason:'permission_denied',code:99991672,requiredScopes:['contact:user.base:readonly']});service.start(ctx);const result=await finished(service);
 expect(result).toMatchObject({status:'partial',saved:1,profiled:0,identityOnly:1,failed:1});expect(result!.errors[0].code).toBe(99991672);expect(store.all()[0]).toMatchObject({name:'目录姓名',email:null,giteaUsername:null});
});
it('rejects invalid routing, denied groups, foreign account and optional auto-sync opt-out',async()=>{
 const {service,store,route}=fixture();expect(()=>service.start({...ctx,sessionKey:'agent:other:feishu:group:oc_test'})).toThrow();expect(()=>service.start({...ctx,sessionKey:'agent:main:main'})).toThrow();
 route.mockReturnValue('other');expect(service.info(ctx).available).toBe(false);expect(()=>service.start(ctx)).toThrow();route.mockReturnValue('main');mocks.allowed.mockReturnValue(false);service.join('a',{chat_id:'oc_test'},'bot_join');expect(store.all()).toHaveLength(0);
 mocks.allowed.mockReturnValue(true);mocks.accounts.mockReturnValue([{...account,config:{peopleSyncOnJoin:false}}]);service.join('a',{chat_id:'oc_test'},'bot_join');expect(service.status(ctx)).toBeNull();
 service.join('a',{chat_id:'oc_test',app_id:'wrong'},'bot_join');expect(service.status(ctx)).toBeNull();
});
it('detects broken pagination and shutdown prevents late writes',async()=>{
 const {service,store}=fixture();mocks.members.mockResolvedValue({code:0,data:{items:[],has_more:true,page_token:'repeated'}});service.start(ctx);expect((await finished(service))!.status).toBe('failed');expect(store.all()).toHaveLength(0);
 let release:any;mocks.members.mockResolvedValue({code:0,data:{items:[{member_id:'ou_one'}]}});mocks.lookup.mockImplementation(()=>new Promise(resolve=>release=resolve));service.start(ctx);await tick();await service.stop();release({status:'found',people:[{accountId:'a',appId:'app',openId:'ou_one',name:'late'}]});await tick();expect(store.all()).toHaveLength(0);expect(service.status(ctx)!.status).toBe('cancelled');
});

it('resolves the default Agent through the public routing API without a Feishu runtime singleton',async()=>{
 const {store}=fixture();const service=createPeopleGroupSync(()=>({agents:{list:[{id:'main',default:true}]}}) as any);disposers.push(()=>service.stop());
 expect(service.info(ctx).available).toBe(true);service.start(ctx);expect((await finished(service))!.status).toBe('completed');expect(store.all()).toHaveLength(1);
});
