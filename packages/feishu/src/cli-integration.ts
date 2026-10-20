import {registerCliMaintenance} from './cli-maintenance.js';
import { join, isAbsolute, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { Type } from 'typebox';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi, OpenClawConfig } from '../runtime-api.js';
import { listEnabledFeishuAccounts, resolveFeishuRuntimeAccount } from './accounts.js';
import { FeishuCliAuth, cliAuthEndpoints, type CliAccount } from './cli-auth.js';
import { resolveCliConfig } from './cli-config.js';
import { FeishuCliManager, type CliRelease } from './cli-manager.js';
import { cliBaseEnvironment, redactCliOutput } from './cli-process.js';
import { feishuExternalToolResult } from './tool-result.js';
import type { FeishuConfig } from './types.js';

const domains = new Set(['approval', 'attendance', 'base', 'calendar', 'contact', 'docs', 'drive',
  'im', 'mail', 'markdown', 'mindnotes', 'minutes', 'note', 'okr', 'sheets', 'slides', 'task', 'vc', 'whiteboard', 'wiki']);
const blockedFlags = /^(?:--(?:as|profile|yes|token|access-token|app-id|app-secret|config|config-dir|base-url|endpoint|host|output|output-dir|format|json|help|version|jq|page-all)|-[hoqv])(?:=|$)/;

export function validateCliArguments(args: string[]) {
  if (!Array.isArray(args) || !args.length || args.length > 100 || !domains.has(args[0]) ||
    args.some(arg => typeof arg !== 'string' || arg.length > 100_000 || arg.includes('\0'))) throw new Error('Only typed Feishu business commands are allowed');
  if (args.length < 2 || args[1].startsWith('-')) throw new Error('A typed Feishu operation is required');
  for (const arg of args.slice(1)) {
    if (blockedFlags.test(arg)) throw new Error('Identity, profile, confirmation and output flags are controlled by the plugin');
    // Input files are handled by existing plugin tools. CLI invocations here
    // accept inline data only, so they cannot read arbitrary host files/stdin.
    if (arg === '-' || arg.startsWith('@') || /^--[^=]+=(?:@|-\s*$)/.test(arg) || /^(?:--(?:file|output-file|input-file|body-file|upload-file))(?:=|$)/.test(arg)) {
      throw new Error('CLI file/stdin access is not supported; use the existing plugin file tools');
    }
    const value = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (isAbsolute(value) || win32.isAbsolute(value) || value.startsWith('~') || value.split(/[\\/]/).includes('..')) {
      throw new Error('CLI host paths are not accepted');
    }
  }
}

function options(cfg: OpenClawConfig) { return resolveCliConfig((cfg.channels?.feishu as FeishuConfig | undefined)?.cli); }
function manager(cfg: OpenClawConfig) { return new FeishuCliManager(join(resolveStateDir(), 'feishu-cli'), options(cfg)); }

export function resolveCliAccount(cfg: OpenClawConfig, context: Pick<OpenClawPluginToolContext, 'agentAccountId'>): CliAccount {
  let accountId = context.agentAccountId;
  if (!accountId) {
    const accounts = listEnabledFeishuAccounts(cfg).filter(account => account.configured);
    if (accounts.length !== 1) throw new Error('A trusted Feishu account is required when multiple applications are configured');
    accountId = accounts[0].accountId;
  }
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.enabled || !account.appId || !account.appSecret || account.config.cli?.enabled === false) throw new Error('Feishu CLI account is unavailable');
  cliAuthEndpoints(account.domain);
  return { accountId: account.accountId, appId: account.appId, appSecret: account.appSecret, domain: account.domain };
}

export function cliInvocationEnvironment(root: string, account: CliAccount, identity: 'bot' | 'user', token?: string) {
  if (!token) throw new Error(identity === 'user' ? 'User authorization required' : 'Application access token required');
  return { ...cliBaseEnvironment(join(root, 'isolated-cli-config')),
    LARKSUITE_CLI_APP_ID: account.appId, LARKSUITE_CLI_APP_SECRET: account.appSecret,
    LARKSUITE_CLI_BRAND: account.domain, LARKSUITE_CLI_DEFAULT_AS: identity,
    LARKSUITE_CLI_STRICT_MODE: identity,
    ...(identity === 'user' ? { LARKSUITE_CLI_USER_ACCESS_TOKEN: token } : { LARKSUITE_CLI_TENANT_ACCESS_TOKEN: token }) };
}

export async function executeManagedCli(params: {
  manager: FeishuCliManager; release: CliRelease; account: CliAccount; args: string[];
  identity: 'bot' | 'user'; token?: string; confirmed?: boolean; signal?: AbortSignal;
}) {
  validateCliArguments(params.args);
  const argv = [...params.args, '--as', params.identity, '--format', 'json', ...(params.confirmed ? ['--yes'] : [])];
  const operations = join(params.manager.root, 'operations');
  await mkdir(operations, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(operations, 'call-'));
  let result;
  try {
    result = await params.manager.run(params.manager.binary(params.release), argv, {
      cwd, env: cliInvocationEnvironment(params.manager.root, params.account, params.identity, params.token),
      timeout: 60_000, signal: params.signal });
  } finally { await rm(cwd, { recursive: true, force: true }); }
  const redact = (text: string) => redactCliOutput(text, [params.account.appSecret, params.token ?? '']);
  let payload: unknown;
  try { payload = JSON.parse(redact(result.code ? result.stderr : result.stdout)); }
  catch { payload = { message: redact(result.code ? result.stderr : result.stdout).slice(0, 16_000) }; }
  return { exitCode: result.code, version: params.release.version, identity: params.identity,
    confirmationRequired: result.code === 10, result: payload };
}

function isMainContext(context: OpenClawPluginToolContext) {
  return !context.sandboxed && !context.sessionKey?.includes(':subagent:') &&
    (context.messageChannel === 'feishu' || context.senderIsOwner === true);
}

export function registerFeishuCliCommands(api: OpenClawPluginApi) {
  api.registerCli(({ program, config }) => {
    const root = program.command('feishu-cli').description('管理 Feishu 插件托管的 CLI 和动态技能索引');
    for (const action of ['status', 'check', 'update', 'rollback'] as const) {
      root.command(action).description({ status: '查看版本与自动更新状态', check: '检查稳定版本',
        update: '安装或更新 CLI 与技能索引', rollback: '回滚上一版本 CLI 与技能索引' }[action])
        .action(async () => {
          const instance = manager(config);
          console.log(JSON.stringify(await instance[action](), null, 2));
        });
    }
  }, { commands: ['feishu-cli'], descriptors: [{ name: 'feishu-cli', description: '管理飞书 CLI、技能索引与自动更新', hasSubcommands: true }] });
}

export function registerFeishuCli(api: OpenClawPluginApi) {
  registerCliMaintenance(api);
  let timer: ReturnType<typeof setInterval> | undefined;
  let serviceManager: FeishuCliManager | undefined;
  let updating: Promise<void> | undefined;
  let stopped = true;
  api.registerService({
    id: 'feishu-cli-updater',
    reload: { configPrefixes: ['channels.feishu.cli', 'channels.feishu.accounts'] },
    start(context) {
      const cfg = context.config;
      if (!options(cfg).enabled || !listEnabledFeishuAccounts(cfg).some(account => account.configured)) return;
      stopped = false;
      const instance = new FeishuCliManager(join(context.stateDir, 'feishu-cli'), options(cfg));
      serviceManager = instance;
      let running = false;
      const tick = () => { if (!stopped && !running) {
        running = true;
        updating = instance.status().then(async state => {
          if (stopped) return;
          if (state.active) await instance.autoUpdate(); else await instance.update();
        }).catch(() => {
        if (!stopped) context.logger.warn('Feishu CLI 自动更新失败；当前可用版本保留，使用 openclaw feishu-cli status 查看状态');
        }).finally(() => { running = false; });
      } };
      tick(); timer = setInterval(tick, 60 * 60 * 1000); timer.unref();
    },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; serviceManager?.stop(); await updating; },
  });
  api.on('before_prompt_build', async (_event, context) => {
    if ((context.channel ?? context.messageProvider) !== 'feishu' || !options(api.config).enabled) return;
    try {
      const instance = manager(api.config), release = await instance.snapshot();
      const catalog = release.skills.map(skill => ({ name: skill.name, description: skill.description,
        location: join(instance.skillDirectory(release), skill.name, 'SKILL.md') }));
      return { appendSystemContext: `Feishu CLI 动态技能索引（版本 ${release.version}）：${JSON.stringify(catalog)}\n` +
        '命中技能时先用 feishu_cli action=read_skill 读取 lark-shared 和目标技能，再按需读取 reference。' +
        '业务命令由 Main 使用 feishu_cli action=execute 调用；不通过 exec/shell 直接运行。' +
        'Worker 调用 OpenClaw 插件必须通过原任务 request 请求 Main，Main 调用后用 agent_worker reply 返回结果；Worker 可在原任务授权及自身已有权限内直接使用独立 CLI，不传递插件内部认证信息。' };
    } catch { return { appendSystemContext: 'Feishu CLI 尚未就绪；管理员可执行 openclaw feishu-cli update 初始化，不能声称 CLI 能力已可用。' }; }
  });

  api.registerTool((context: OpenClawPluginToolContext) => {
    const initial = context.runtimeConfig ?? context.config ?? api.config;
    if (!isMainContext(context) || !options(initial).enabled) return null;
    return {
      name: 'feishu_cli', label: 'Feishu CLI', resultContentSource: 'network' as const,
      description: 'Main 专用飞书 CLI：skills 列出动态技能；read_skill 读取正文和参考文档；execute 执行已获授权的业务命令。args 不含 lark-cli、身份或 profile 参数；身份由可信账号与当前用户确定。exitCode=10 时先向用户展示操作并取得明确确认，再使用 confirmed=true 重试相同命令；不得自动确认。Worker 调用本插件工具时通过 request 请求 Main；直接使用独立 CLI 遵守原任务授权及自身已有权限。',
      parameters: Type.Object({ action: Type.Union([Type.Literal('skills'), Type.Literal('read_skill'), Type.Literal('execute')]),
        skill: Type.Optional(Type.String()), path: Type.Optional(Type.String()),
        args: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        identity: Type.Optional(Type.Union([Type.Literal('bot'), Type.Literal('user')])),
        confirmed: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      async execute(_id: string, raw: unknown, signal?: AbortSignal) {
        try {
          const params = raw as { action: string; skill?: string; path?: string; args?: string[]; identity?: 'bot' | 'user'; confirmed?: boolean };
          const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
          if (!options(cfg).enabled) throw new Error('Feishu CLI is disabled');
          const instance = manager(cfg), release = await instance.snapshot();
          if (params.action === 'skills') return feishuExternalToolResult({ version: release.version, skills: release.skills });
          if (params.action === 'read_skill') return feishuExternalToolResult({ version: release.version,
            content: await instance.readSkill(release, params.skill ?? '', params.path) });
          if (params.action !== 'execute') throw new Error('Unknown CLI action');
          if (params.confirmed !== undefined && typeof params.confirmed !== 'boolean') throw new Error('Invalid CLI confirmation');
          const account = resolveCliAccount(cfg, context), identity = params.identity ?? 'bot';
          if (!['bot', 'user'].includes(identity)) throw new Error('Invalid CLI identity');
          const auth = new FeishuCliAuth(join(instance.root, 'auth'));
          let token: string | undefined;
          if (identity === 'user') {
            if (!options(cfg).userAuth || !resolveCliConfig(resolveFeishuRuntimeAccount({ cfg, accountId: account.accountId }).config.cli).userAuth) throw new Error('User authorization is disabled by the administrator');
            token = await auth.accessToken(account, context.requesterSenderId ?? '');
          } else token = await auth.tenantAccessToken(account);
          return feishuExternalToolResult(await executeManagedCli({ manager: instance, release, account,
            args: params.args ?? [], identity, token, confirmed: params.confirmed, signal }));
        } catch (error) { return feishuExternalToolResult({ error: error instanceof Error ? error.message : 'CLI operation failed' }); }
      },
    };
  }, { name: 'feishu_cli' });

  api.registerTool((context: OpenClawPluginToolContext) => {
    const cfg = context.runtimeConfig ?? context.config ?? api.config;
    if (!isMainContext(context) || !options(cfg).enabled || !options(cfg).userAuth || !context.requesterSenderId) return null;
    return {
      name: 'feishu_cli_auth', label: 'Feishu CLI user authorization',
      description: 'Main 为当前可信飞书用户管理 OAuth。login 必须明确 scope；展示 verificationUrl 并等待用户授权后再 complete。token/device code 不返回模型；授权身份必须与当前请求用户一致。logout 只清本地授权，不撤销服务端授权。',
      parameters: Type.Object({ action: Type.Union(['status', 'login', 'complete', 'logout'].map(value => Type.Literal(value))),
        scope: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })) }, { additionalProperties: false }),
      async execute(_id: string, raw: unknown) {
        try {
          const latest = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
          if (!options(latest).enabled || !options(latest).userAuth) throw new Error('User authorization is disabled');
          const account = resolveCliAccount(latest, context);
          if (!resolveCliConfig(resolveFeishuRuntimeAccount({ cfg: latest, accountId: account.accountId }).config.cli).userAuth) throw new Error('User authorization is disabled for this account');
          const auth = new FeishuCliAuth(join(manager(latest).root, 'auth'));
          const params = raw as { action: string; scope?: string }, sender = context.requesterSenderId!;
          if (params.action === 'login') {
            const instance = manager(latest), release = await instance.snapshot();
            const result = await auth.login(account, sender, params.scope ?? '');
            const directory = join(instance.root, 'authorization-qr');
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const filename = `${randomUUID()}.png`;
            const qr = await instance.run(instance.binary(release), ['auth', 'qrcode', result.verificationUrl, '--output', filename],
              { cwd: directory, env: cliBaseEnvironment(join(instance.root, 'probe')), timeout: 15_000 });
            return feishuExternalToolResult({ ...result, qrPath: qr.code === 0 ? join(directory, filename) : undefined,
              qrStatus: qr.code === 0 ? 'generated' : 'unavailable' });
          }
          if (params.action === 'status') return feishuExternalToolResult(await auth.status(account, sender));
          if (params.action === 'complete') return feishuExternalToolResult(await auth.complete(account, sender));
          if (params.action === 'logout') return feishuExternalToolResult(await auth.logout(account, sender));
          throw new Error('Unknown authorization action');
        } catch { return feishuExternalToolResult({ error: 'User authorization failed; verify current user, application scopes, and authorization status' }); }
      },
    };
  }, { name: 'feishu_cli_auth' });
}
