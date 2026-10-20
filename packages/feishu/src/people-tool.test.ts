import {beforeEach,expect,it,vi} from 'vitest';
import {registerFeishuPeopleTool} from './people-tool.js';
const mock=vi.hoisted(()=>({resolve:vi.fn(),account:vi.fn(),enabled:vi.fn(),accounts:vi.fn()}));
vi.mock('./people-resolver.js',()=>({resolvePeopleFromFeishu:mock.resolve}));
vi.mock('./tool-account.js',()=>({resolveFeishuToolAccount:mock.account,resolveAnyEnabledFeishuToolsConfig:mock.enabled}));
vi.mock('./accounts.js',()=>({listEnabledFeishuAccounts:mock.accounts}));
beforeEach(()=>{vi.resetAllMocks();mock.enabled.mockReturnValue({chat:true});mock.account.mockReturnValue({accountId:'default',appId:'cli_test'});mock.resolve.mockResolvedValue({status:'found',people:[{openId:'ou_target'}]});});
function tool(context:object={}){
 const api={config:{},registerTool:vi.fn()};registerFeishuPeopleTool(api as any);
 return api.registerTool.mock.calls[0][0]({agentId:'alice',agentAccountId:'default',sessionKey:'agent:alice:feishu:group:oc_test',...context});
}
it('uses trusted Agent/account/session and fences directory result as external data',async()=>{
 const result=await tool().execute('t',{openId:'ou_target'});
 expect(mock.resolve).toHaveBeenCalledWith({},expect.objectContaining({agentId:'alice',contextAccountId:'default',accountId:'default',appId:'cli_test',sessionKey:'agent:alice:feishu:group:oc_test',openId:'ou_target'}));
 expect(result.details.status).toBe('found');expect(result.content[0].text).toContain('EXTERNAL');
});
it('rejects cross-account, cross-Agent, arbitrary sessions and mixed identifiers before network',async()=>{
 const t=tool();expect((await t.execute('t',{openId:'ou_target',accountId:'other'})).details.reason).toBe('account_mismatch');
 for(const params of [{},{openId:'ou_one',name:'同名'},{openId:'ou_one',agentId:'other'},{name:'同名',sessionKey:'other'},{email:''},{name:'x\n'},{name:3}])await expect(t.execute('t',params)).rejects.toThrow();
 expect(mock.resolve).not.toHaveBeenCalled();
});
it('honors chat tool controls and returns lookup errors without treating them as empty success',async()=>{
 mock.enabled.mockReturnValue({chat:false});expect(tool()).toBeNull();
 mock.enabled.mockReturnValue({chat:true});mock.resolve.mockResolvedValue({status:'error',reason:'permission_denied',code:99991672,people:[]});
 expect((await tool().execute('t',{email:'user@example.invalid'})).details).toMatchObject({status:'error',reason:'permission_denied'});
 mock.account.mockImplementation(()=>{throw Error('chat disabled for account');});
 await expect(tool().execute('t',{name:'同名'})).rejects.toThrow('chat disabled');
});
it('requires an explicit account without delivery context when multiple apps are configured',async()=>{
 mock.accounts.mockReturnValue([{configured:true},{configured:true}]);
 expect((await tool({agentAccountId:undefined}).execute('t',{openId:'ou_target'})).details.status).toBe('account_required');
 expect(mock.resolve).not.toHaveBeenCalled();
});
