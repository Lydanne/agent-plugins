import {Type} from 'typebox';
import type {OpenClawPluginToolContext} from 'openclaw/plugin-sdk/plugin-entry';
import type {OpenClawPluginApi} from '../runtime-api.js';
import {resolvePeopleFromFeishu} from './people-resolver.js';
import {resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount} from './tool-account.js';
import {feishuExternalToolResult} from './tool-result.js';
import {listEnabledFeishuAccounts} from './accounts.js';

export function registerFeishuPeopleTool(api: OpenClawPluginApi) {
  api.registerTool((context: OpenClawPluginToolContext) => {
    const cfg = context.runtimeConfig ?? context.config ?? api.config;
    if (!cfg || !resolveAnyEnabledFeishuToolsConfig(cfg).chat) return null;
    return {
      name: 'feishu_user', label: 'Feishu User', resultContentSource: 'network' as const,
      description: '查询应用可见的飞书用户：openId/email/name 必须且仅提供一个；姓名仅查当前可信群，不切换可信账号、不写人员库、不通知。人员库及人工映射优先用 agent_repo person/people；字段与边界见 feishu-context、agent-repo-context 技能。',
      parameters: Type.Object({
        openId: Type.Optional(Type.String({pattern:'^ou_[A-Za-z0-9]+$',maxLength:320})),
        email: Type.Optional(Type.String({minLength:1,maxLength:320})),
        name: Type.Optional(Type.String({minLength:1,maxLength:320})),
        accountId: Type.Optional(Type.String({minLength:1,maxLength:64})),
      }, {additionalProperties:false}),
      async execute(_id: string, params: unknown) {
        const raw = params as Record<string, unknown>;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.keys(raw).some(key => !['openId','email','name','accountId'].includes(key)) ||
          Object.values(raw).some(value => typeof value !== 'string' || !value.trim() || value.length > 320 || /[\u0000-\u001f]/.test(value)) ||
          ['openId','email','name'].filter(key => raw[key] !== undefined).length !== 1) {
          throw new Error('必须且只能提供 openId、email 或 name，不能指定其他 Agent 或会话');
        }
        const input = raw as {openId?:string;email?:string;name?:string;accountId?:string};
        // The trusted delivery account wins; model arguments cannot switch apps.
        const contextAccountId = context.agentAccountId;
        if (contextAccountId && input.accountId && contextAccountId !== input.accountId) {
          return feishuExternalToolResult({status:'unavailable',reason:'account_mismatch',people:[]});
        }
        if (!contextAccountId && !input.accountId) {
          const accounts = listEnabledFeishuAccounts(cfg).filter(account => account.configured);
          if (accounts.length !== 1) {
            return feishuExternalToolResult({status:accounts.length ? 'account_required' : 'unavailable',reason:accounts.length ? 'specify_account' : 'account_unavailable',people:[]});
          }
        }
        const account = resolveFeishuToolAccount({cfg, executeParams:{accountId:contextAccountId ?? input.accountId}, defaultAccountId:contextAccountId, requiredTool:{family:'chat',label:'chat'}});
        return feishuExternalToolResult(await resolvePeopleFromFeishu(cfg, {
          ...input, agentId:context.agentId ?? '', accountId:account.accountId,
          appId:account.appId, contextAccountId, sessionKey:context.sessionKey,
        }));
      },
    };
  }, {name:'feishu_user'});
}
