import {listEnabledFeishuAccounts} from './accounts.js';
import { join } from 'node:path';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { registerMaintenanceProvider, maintenanceContext, maintenanceRevision, createMaintenanceOperations,
  MaintenanceError, type MaintenanceContext, type MaintenanceInput, type MaintenanceSnapshot } from '../../agent-repo-api/maintenance.mjs';
import type { OpenClawPluginApi, OpenClawConfig } from '../runtime-api.js';
import type { FeishuConfig } from './types.js';
import { resolveCliConfig, FeishuCliConfigSchema } from './cli-config.js';
import { FeishuCliManager } from './cli-manager.js';

const id = 'feishu.cli';
const scope = '当前宿主共享 · 影响使用此托管 CLI 的账号和技能';
export function registerCliMaintenance(api: OpenClawPluginApi) {
  const root = join(resolveStateDir(), 'feishu-cli');
  const operations = createMaintenanceOperations(join(root, 'maintenance'));
  let stopped = false;
  const managers = new Set<FeishuCliManager>();
  const current = () => api.runtime.config.current();
  const policy = () => resolveCliConfig((current().channels?.feishu as FeishuConfig | undefined)?.cli);
  const instance = () => new FeishuCliManager(root, policy());
  async function snapshot(ctx: MaintenanceContext): Promise<MaintenanceSnapshot> {
    maintenanceContext(ctx);
    const state = await instance().status();
    const accounts = listEnabledFeishuAccounts(structuredClone(current()) as OpenClawConfig);
    return { apiVersion: 1, id, label: 'Lark CLI', kind: 'cli', ownerLabel: 'Feishu 插件', scope,
      versions: { current: state.active?.version, available: policy().version ?? state.availableVersion ?? undefined },
      state: !state.enabled ? 'disabled' : state.lastError ? 'degraded' : state.active ? 'available' : 'not_installed',
      revision: maintenanceRevision([policy(), state.active?.id ?? null, state.availableVersion ?? null]),
      observedAt: new Date().toISOString(),
      fields: [{ label: '提供方', value: 'Feishu 插件' }, { label: '当前版本', value: state.active?.version ?? '未安装' },
        { label: '可更新版本', value: state.availableVersion ?? '尚未检查' },
        { label: '最近检查', value: state.checkedAt ? new Date(state.checkedAt).toISOString() : '未记录' },
        { label: '最近更新', value: state.updatedAt ? new Date(state.updatedAt).toISOString() : '未记录' },
        { label: '更新结果', value: state.lastError ? '更新或检查失败，已保留原版本' : '未记录失败' },
        { label: '应用配置', value: accounts.filter(account => account.configured).length + ' 个启用账号已配置；不代表实时鉴权成功' },
        { label: '用户授权', value: policy().userAuth ? '宿主允许 OAuth；仍需按请求用户核验' : '宿主 OAuth 已关闭' },
        { label: '认证范围', value: '应用身份和每位用户授权由提供方独立校验；CLI 已安装不代表账号已授权' }],
      policy: { autoUpdate: state.autoUpdate, version: state.pinnedVersion, updateCheckIntervalHours: state.updateCheckIntervalHours },
      skills: state.active?.skills.map(skill => ({ name: skill.name, description: skill.description })) ?? [],
      actions: [...(state.enabled ? [{ id: 'check', label: '检查 CLI 更新' }, { id: 'update', label: '更新 CLI 与技能' },
        ...(state.previous ? [{ id: 'rollback', label: '回退 CLI 与技能', effect: '保留更新策略；自动更新或固定版本可能再次切换版本。' }] : [])] : []),
      { id: 'configure', label: '保存更新策略', settings: true, effect: '写入宿主配置；以刷新后显示的有效策略为准。' }],
      history: await operations.history() };
  }
  async function run(ctx: MaintenanceContext, input: MaintenanceInput) {
    maintenanceContext(ctx, true);
    if (stopped || input.providerId !== id || !['check', 'update', 'rollback', 'configure'].includes(input.action)) throw new MaintenanceError('UNSUPPORTED', '不支持的 CLI 维护操作');
    if (input.action !== 'configure' && input.settings !== undefined) throw new MaintenanceError('INVALID_OPERATION', '此操作不接受设置参数');
    let clearVersion = false;
    let settings: { autoUpdate?: boolean; version?: string; updateCheckIntervalHours?: number } | undefined;
    if (input.action === 'configure') {
      if (!input.settings || Object.keys(input.settings).some(key => !['autoUpdate', 'version', 'updateCheckIntervalHours'].includes(key))) throw new MaintenanceError('INVALID_OPERATION', '更新策略参数无效');
      const raw = { ...input.settings }; clearVersion = raw.version === ''; if (clearVersion) delete raw.version;
      const parsed = FeishuCliConfigSchema.safeParse(raw);
      if (!parsed.success || !parsed.data) throw new MaintenanceError('INVALID_OPERATION', '更新策略参数无效');
      settings = parsed.data;
      if (settings.version) { const [major, minor, patch] = settings.version.split('.').map(Number); if (major !== 1 || minor === 0 && patch < 96) throw new MaintenanceError('INVALID_OPERATION', '固定版本必须为兼容的 1.x，最低 1.0.96'); }
    }
    const previous = await operations.find(ctx, input); if (previous) return previous;
    const initial = await snapshot(ctx);
    if (initial.revision !== input.expectedRevision) throw new MaintenanceError('REVISION_CHANGED', 'CLI 或更新策略已变化，请刷新后重试');
    if (!initial.actions.some(action => action.id === input.action)) throw new MaintenanceError('UNSUPPORTED', 'CLI 已禁用或不支持此操作');
    const expectedPolicy = maintenanceRevision(policy());
    return operations.start(ctx, input, async () => {
      if (stopped || (await snapshot(ctx)).revision !== input.expectedRevision) throw new MaintenanceError('REVISION_CHANGED', 'CLI 状态已变化');
      if (input.action === 'configure') {
        await api.runtime.config.mutateConfigFile({ base: "runtime", afterWrite: { mode: "auto" }, mutate(draft) {
          const channel = draft.channels?.feishu as FeishuConfig | undefined;
          if (maintenanceRevision(resolveCliConfig(channel?.cli)) !== expectedPolicy) throw new MaintenanceError('REVISION_CHANGED', 'CLI 策略已变化');
          if (!draft.channels) draft.channels = {};
          const next = { ...channel, cli: { ...channel?.cli, ...settings } };
          if (clearVersion) delete next.cli.version;
          draft.channels.feishu = next;
        } });
        return;
      }
      const manager = input.action === 'update' ? new FeishuCliManager(root, { ...policy(), version: policy().version ?? initial.versions?.available }) : instance(); managers.add(manager);
      try {
        if (input.action === 'check') await manager.check();
        else if (input.action === 'update') await manager.update();
        else await manager.rollback();
      } finally { managers.delete(manager); }
    });
  }
  const owner = Symbol.for('openclaw-plugins.feishu.cli-maintenance.owner');
  let dispose = registerMaintenanceProvider({ apiVersion: 1, id, label: 'Lark CLI', scope, snapshot, run }, owner);
  api.registerService({ id: 'feishu-cli-maintenance', start() { stopped = false; dispose(); dispose = registerMaintenanceProvider({ apiVersion: 1, id, label: 'Lark CLI', scope, snapshot, run }, owner); },
    async stop() { stopped = true; dispose(); for (const manager of managers) manager.stop(); } });
}
