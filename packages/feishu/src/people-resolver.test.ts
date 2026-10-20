import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {resolvePeopleFromFeishu,registerFeishuPeopleResolver} from './people-resolver.js';
import {getPeopleResolver} from '../../agent-repo-api/people.mjs';
const mocks=vi.hoisted(()=>({accounts:vi.fn(),runtime:vi.fn(),get:vi.fn(),batch:vi.fn(),members:vi.fn(),department:vi.fn(),allowed:vi.fn()}));
vi.mock('./accounts.js',()=>({listEnabledFeishuAccounts:mocks.accounts,resolveFeishuRuntimeAccount:mocks.runtime}));
vi.mock('./client.js',()=>({createFeishuClient:()=>({contact:{user:{get:mocks.get,batchGetId:mocks.batch},department:{get:mocks.department}},im:{chatMembers:{get:mocks.members}}})}));
vi.mock('./read-policy.js',()=>({isFeishuGroupReadAllowed:mocks.allowed}));
const account={accountId:'a',appId:'app',configured:true,enabled:true};
const cfg={} as any;
beforeEach(()=>{vi.resetAllMocks();mocks.accounts.mockReturnValue([account]);mocks.runtime.mockImplementation(input=>({...account,accountId:input.accountId}));mocks.allowed.mockReturnValue(true);mocks.get.mockImplementation(async args=>({code:0,data:{user:{open_id:args.path.user_id,name:'张三',enterprise_email:'enterprise@example.invalid',email:'other@example.invalid',department_ids:['d']}}}));mocks.department.mockResolvedValue({code:0,data:{department:{name:'研发'}}});});
afterEach(()=>vi.restoreAllMocks());
it('gets OpenID details with application identity and prefers enterprise email',async()=>{
 const result=await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'ou_one'});expect(result.status).toBe('found');expect(result.people[0]).toEqual({accountId:'a',appId:'app',openId:'ou_one',name:'张三',email:'enterprise@example.invalid',departments:[{id:'d',name:'研发'}]});
});
it('resolves email to OpenID before fetching details and handles empty email matches',async()=>{
 mocks.batch.mockResolvedValue({code:0,data:{user_list:[{user_id:'ou_one'}]}});
 expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',email:'enterprise@example.invalid'})).people[0].openId).toBe('ou_one');
 expect(mocks.batch).toHaveBeenCalledWith({params:{user_id_type:'open_id'},data:{emails:['enterprise@example.invalid'],include_resigned:false}});
 mocks.batch.mockResolvedValue({code:0,data:{user_list:[]}});expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',email:'none@example.invalid'})).status).toBe('not_found');
});
it('finds name candidates only in the trusted current group, paginates, deduplicates, and returns all namesakes',async()=>{
 mocks.members.mockResolvedValueOnce({code:0,data:{items:[{member_id:'ou_one',name:'张三'},{member_id:'ou_other',name:'李四'}],has_more:true,page_token:'next'}}).mockResolvedValueOnce({code:0,data:{items:[{member_id:'ou_one',name:'张三'},{member_id:'ou_two',name:'张三'}]}});
 const result=await resolvePeopleFromFeishu(cfg,{agentId:'main',name:'张三',sessionKey:'agent:main:feishu:group:oc_test:topic:ot_1'});
 expect(result.people.map(p=>p.openId)).toEqual(['ou_one','ou_two']);expect(mocks.get).toHaveBeenCalledTimes(2);expect(mocks.members.mock.calls[1][0].params.page_token).toBe('next');
});
it('does not guess an account or cross the current delivery account',async()=>{
 mocks.accounts.mockReturnValue([account,{...account,accountId:'b'}]);
 expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'ou_one'})).status).toBe('account_required');
 expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'ou_one',accountId:'b',contextAccountId:'a'})).reason).toBe('account_mismatch');
 expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'ou_one',appId:'wrong'})).status).toBe('unavailable');expect(mocks.get).not.toHaveBeenCalled();
 expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'ou_one',contextAccountId:'b'})).status).toBe('found');
});
it('distinguishes unavailable permissions, malformed responses, group policy and unsupported lookups',async()=>{
 expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',name:'张三'})).status).toBe('unsupported');
 expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'not-an-openid'})).status).toBe('unsupported');
 mocks.allowed.mockReturnValue(false);expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',name:'张三',sessionKey:'agent:main:feishu:group:oc_test'})).status).toBe('unavailable');
 mocks.get.mockResolvedValue({code:99991672,msg:'secret details'});const denied=await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'ou_one'});expect(denied.status).toBe('error');expect(denied.code).toBe(99991672);expect(JSON.stringify(denied)).not.toContain('secret');
 mocks.get.mockResolvedValue({code:0,data:{user:{open_id:'ou_wrong'}}});expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'ou_one'})).reason).toBe('invalid_contact_identity');
 mocks.get.mockRejectedValue(Error('token-secret'));expect(JSON.stringify(await resolvePeopleFromFeishu(cfg,{agentId:'main',openId:'ou_one'}))).not.toContain('token-secret');
});
it('bounds member pagination and contact fetching; department failures retain department IDs',async()=>{
 mocks.members.mockResolvedValue({code:0,data:{items:Array.from({length:14},(_,i)=>({member_id:'ou_'+i,name:'张三'})),has_more:true,page_token:'next'}});mocks.department.mockRejectedValue(Error('denied'));
 const result=await resolvePeopleFromFeishu(cfg,{agentId:'main',name:'张',sessionKey:'agent:main:feishu:group:oc_test'});expect(result.people).toHaveLength(10);expect(result.truncated).toBe(true);expect(result.people[0].departments).toEqual([{id:'d'}]);
 mocks.members.mockReset().mockResolvedValue({code:0,data:{items:[],has_more:true,page_token:'repeated'}});expect((await resolvePeopleFromFeishu(cfg,{agentId:'main',name:'张',sessionKey:'agent:main:feishu:group:oc_test'})).reason).toBe('invalid_pagination');
});
it('registers and disposes the shared resolver over plugin lifecycle',async()=>{
 let service:any;registerFeishuPeopleResolver({config:cfg,registerService:(value:any)=>service=value} as any);expect(getPeopleResolver()).toBeTypeOf('function');service.stop();expect(getPeopleResolver()).toBeUndefined();service.start();expect(getPeopleResolver()).toBeTypeOf('function');service.stop();
});

it('returns safe permission metadata from SDK HTTP errors without exposing credentials',async()=>{
 mocks.batch.mockRejectedValue({response:{data:{code:99991672,msg:'credential-secret',error:{permission_violations:[{subject:'contact:user.id:readonly'}]}}}});
 const result=await resolvePeopleFromFeishu(cfg,{agentId:'main',email:'a@example.invalid'});
 expect(result).toMatchObject({status:'error',reason:'permission_denied',code:99991672,requiredScopes:['contact:user.id:readonly'],people:[]});expect(JSON.stringify(result)).not.toContain('credential-secret');
});
