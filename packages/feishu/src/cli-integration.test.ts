import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuCliManager } from './cli-manager.js';
import { cliInvocationEnvironment, executeManagedCli, registerFeishuCli, registerFeishuCliCommands, resolveCliAccount, validateCliArguments } from './cli-integration.js';
import { resolveCliConfig } from './cli-config.js';
import { redactCliOutput, runCliProcess } from './cli-process.js';
import { FeishuConfigSchema } from './config-schema.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const account = { accountId: 'default', appId: 'cli_fixture', appSecret: 'private-app-secret', domain: 'feishu' };
const release = { id: '12345678-1234-1234-1234-123456789abc', version: '1.0.96', skills: [] };
const config = { channels: { feishu: { appId: account.appId, appSecret: account.appSecret } } };

it('isolates child credentials and preserves exact user binding without inheriting operator tokens', () => {
  vi.stubEnv('LARKSUITE_CLI_USER_ACCESS_TOKEN', 'operator-token');
  vi.stubEnv('LARKSUITE_CLI_PROFILE', 'operator');
  vi.stubEnv('FEISHU_APP_SECRET', 'unrelated-secret');
  try {
    const bot = cliInvocationEnvironment('/tmp/test-cli', account, 'bot', 'bound-bot-token');
    expect(bot.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBeUndefined(); expect(bot.LARKSUITE_CLI_PROFILE).toBeUndefined();
    expect(bot.FEISHU_APP_SECRET).toBeUndefined(); expect(bot.LARKSUITE_CLI_STRICT_MODE).toBe('bot');
    expect(bot.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe('bound-bot-token');
    expect(() => cliInvocationEnvironment('/tmp/test-cli', account, 'bot')).toThrow('Application access token required');
    expect(() => cliInvocationEnvironment('/tmp/test-cli', account, 'user')).toThrow();
    expect(cliInvocationEnvironment('/tmp/test-cli', account, 'user', 'bound-user-token').LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe('bound-user-token');
  } finally { vi.unstubAllEnvs(); }
});
it('bounds real child execution, supports cancellation and preserves split UTF-8 output', async () => {
  const result = await runCliProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),10)']);
  expect(result).toMatchObject({ code: 0, stdout: '中' });
  await expect(runCliProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 30 })).rejects.toThrow('timed out');
  const controller = new AbortController();
  const pending = runCliProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(); await expect(pending).rejects.toThrow('cancelled');
});
it.each([
  ['config', 'bind'], ['auth', 'login'], ['update'], ['api', 'POST', '/path'], ['apps', '+deploy'],
  ['docs', '+fetch', '--profile=other'], ['docs', '+fetch', '--as', 'user'], ['docs', '+fetch', '--yes'],
  ['docs', '+fetch', '--data', '@/private/file'], ['docs', '+fetch', '--data=@/private/file'],
  ['docs', '+fetch', '--file=private'], ['docs', '+fetch', '--output', 'file'], ['docs', '+fetch', '--data=-'],
  ['im', 'images', 'create', '--image', '/etc/passwd'], ['im', 'images', 'create', '--image=../auth/state'],
])('rejects identity changes, unmanaged commands, confirmation bypass and local-file access %j', (...args) => {
  expect(() => validateCliArguments(args)).toThrow();
});
it('returns confirmation_required without automatically executing again or exposing credentials', async () => {
  const run = vi.fn().mockResolvedValue({ code: 10, stdout: '', stderr: JSON.stringify({ ok: false,
    error: { type: 'confirmation', subtype: 'confirmation_required', message: 'private-app-secret private-user-token' } }) });
  const root = await mkdtemp(join(tmpdir(), 'feishu-cli-call-')); roots.push(root);
  const manager = new FeishuCliManager(root, resolveCliConfig(), run);
  const args = ['drive', '+delete', '--file-token', 'fixture'];
  const result = await executeManagedCli({ manager, release, account, args, identity: 'user', token: 'private-user-token' });
  expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0][1]).not.toContain('--yes');
  expect(result.confirmationRequired).toBe(true); expect(JSON.stringify(result)).not.toContain('private-app-secret');
  expect(JSON.stringify(result)).not.toContain('private-user-token');
  await executeManagedCli({ manager, release, account, args, identity: 'bot', token: 'private-bot-token', confirmed: true });
  expect(run.mock.calls[1][1].at(-1)).toBe('--yes');
  expect(run.mock.calls[1][0]).toContain(release.id);
  expect(redactCliOutput('{"access_token":"secret","appSecret":"key"}')).not.toContain('secret');
});
it('uses the trusted delivery account and refuses ambiguous or disabled application selection', () => {
  expect(resolveCliAccount(config, {})).toMatchObject(account);
  const multiple = { channels: { feishu: { accounts: {
    one: { appId: 'cli_one', appSecret: 'fixture-one' }, two: { appId: 'cli_two', appSecret: 'fixture-two' },
  } } } };
  expect(() => resolveCliAccount(multiple, {})).toThrow('trusted');
  expect(resolveCliAccount(multiple, { agentAccountId: 'two' }).appId).toBe('cli_two');
  expect(() => resolveCliAccount({ channels: { feishu: { ...config.channels.feishu, enabled: false } } }, {})).toThrow();
});
it('does not expose Main tools to subagents, sandboxes, or unrelated channels; opt-out and user-auth defaults are enforced', () => {
  const api = { config, registerTool: vi.fn(), registerCli: vi.fn(), registerService: vi.fn(), on: vi.fn() };
  registerFeishuCli(api as never);
  const [mainFactory, authFactory] = api.registerTool.mock.calls.map(([factory]) => factory);
  for (const context of [{}, { messageChannel: 'slack' }, { messageChannel: 'feishu', sandboxed: true },
    { messageChannel: 'feishu', sessionKey: 'agent:main:subagent:fixture' }]) expect(mainFactory(context)).toBeNull();
  expect(mainFactory({ messageChannel: 'feishu' }).name).toBe('feishu_cli');
  expect(mainFactory({ messageChannel: 'feishu', runtimeConfig: { channels: { feishu: { cli: { enabled: false } } } } })).toBeNull();
  expect(authFactory({ messageChannel: 'feishu', requesterSenderId: 'ou_alice' })).toBeNull();
  expect(FeishuConfigSchema.safeParse({ cli: { autoUpdate: false, userAuth: true } }).success).toBe(true);
  expect(FeishuConfigSchema.safeParse({ cli: { version: 'latest' } }).success).toBe(false);
  expect(FeishuConfigSchema.safeParse({ cli: { updateCheckIntervalHours: -1 } }).success).toBe(false);
});
it('advertises the admin CLI once and installs on first activation even with automatic updates off', async () => {
  const disabledAuto = { channels: { feishu: { ...config.channels.feishu, cli: { autoUpdate: false } } } };
  const api = { config: disabledAuto, registerTool: vi.fn(), registerCli: vi.fn(), registerService: vi.fn(), on: vi.fn() };
  registerFeishuCliCommands(api as never);
  registerFeishuCli(api as never);
  expect(api.registerCli).toHaveBeenCalledOnce();
  expect(api.registerCli.mock.calls[0][1].descriptors[0]).toMatchObject({ name: 'feishu-cli', hasSubcommands: true });
  vi.spyOn(FeishuCliManager.prototype, 'status').mockResolvedValue({ enabled: true, autoUpdate: false, updateCheckIntervalHours: 24 } as never);
  const update = vi.spyOn(FeishuCliManager.prototype, 'update').mockResolvedValue({} as never);
  const auto = vi.spyOn(FeishuCliManager.prototype, 'autoUpdate').mockResolvedValue();
  const service = api.registerService.mock.calls[0][0];
  service.start({ config: disabledAuto, stateDir: '/tmp/fixture-no-io', logger: { warn: vi.fn() } });
  try { await vi.waitFor(() => expect(update).toHaveBeenCalledOnce()); expect(auto).not.toHaveBeenCalled(); }
  finally { await service.stop(); }
});
