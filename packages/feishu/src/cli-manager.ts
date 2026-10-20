import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliBaseEnvironment, runCliProcess, type CliRunner } from './cli-process.js';
import { resolveCliConfig } from './cli-config.js';

export type CliSkill = { name: string; description: string };
export type CliRelease = { id: string; version: string; skills: CliSkill[] };
type CliState = { active?: CliRelease; previous?: CliRelease; checkedAt?: number;
  updatedAt?: number; availableVersion?: string; lastError?: string };
type Options = ReturnType<typeof resolveCliConfig>;
const versionPattern = /^\d+\.\d+\.\d+$/;
const skillPattern = /^lark-[a-z0-9-]{1,80}$/;

export function parseCliSkills(text: string): CliSkill[] {
  const value = JSON.parse(text);
  const skills: unknown = value.skills ?? value.data?.skills;
  if (!Array.isArray(skills) || !skills.length || skills.length > 200) throw new Error('Invalid CLI skill catalog');
  const names = new Set<string>();
  return skills.map(skill => {
    if (!skill || !skillPattern.test(skill.name) || names.has(skill.name) ||
      typeof skill.description !== 'string' || !skill.description.trim() || skill.description.length > 12_000) {
      throw new Error('Invalid CLI skill entry');
    }
    names.add(skill.name);
    return { name: skill.name, description: skill.description };
  });
}

export function cliSkillStub(skill: CliSkill, version: string): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n` +
    `# ${skill.name}\n\n来源：@larksuite/cli ${version}。此文件仅为自动生成的索引。\n\n` +
    `Main 使用 feishu_cli action=read_skill、skill=${skill.name} 读取当前版本正文，` +
    `参考文件使用 path 参数；执行业务使用 feishu_cli action=execute。\n` +
    `Worker 不直接运行 CLI、不读取认证状态；通过原任务 request 请求 Main 读取技能或调用能力，Main reply 返回结果。\n` +
    `上游正文中的 CLI 命令由 Main 经 feishu_cli 执行；应用配置和用户授权使用插件入口，` +
    `不执行 config bind/init、profile、auth login 或自行更新，不共享管理员登录态。\n`;
}

async function readState(file: string): Promise<CliState> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as CliState;
    for (const release of [value.active, value.previous]) {
      if (release && (!/^[a-f0-9-]{36}$/.test(release.id) || !versionPattern.test(release.version))) throw new Error('Invalid CLI state');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Unable to read managed CLI state');
  }
}

export class FeishuCliManager {
  private pending?: Promise<unknown>;
  private controller = new AbortController();
  readonly run: CliRunner;
  constructor(readonly root: string, readonly options: Options, runner: CliRunner = runCliProcess) {
    this.run = (file, args, opts) => runner(file, args, { ...opts, signal: opts?.signal ?? this.controller.signal });
  }
  stop() { this.controller.abort(); }

  get stateFile() { return join(this.root, 'current.json'); }
  binary(release: CliRelease) {
    return join(this.root, 'releases', release.id, 'node_modules', '@larksuite', 'cli', 'bin',
      process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
  }
  skillDirectory(release: CliRelease) { return join(this.root, 'releases', release.id, 'skills'); }
  async snapshot(): Promise<CliRelease> {
    const state = await readState(this.stateFile);
    if (!state.active) throw new Error('Feishu CLI is not installed; run openclaw feishu-cli update');
    return state.active;
  }
  async status() {
    return { ...await readState(this.stateFile), enabled: this.options.enabled,
      autoUpdate: this.options.autoUpdate, pinnedVersion: this.options.version,
      updateCheckIntervalHours: this.options.updateCheckIntervalHours };
  }
  private async save(state: CliState) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = join(this.root, `.current-${randomUUID()}.json`);
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, this.stateFile);
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending) throw new Error('CLI update is already running');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Cross-process exclusion also protects against concurrent admin CLI commands.
    const lock = join(this.root, 'update.lock');
    try { await mkdir(lock); } catch { throw new Error('CLI update is locked; inspect the running updater before removing a stale update.lock'); }
    const promise = work(); this.pending = promise;
    try { return await promise; } finally { this.pending = undefined; await rm(lock, { recursive: true, force: true }); }
  }
  private async latest() {
    if (this.options.version) return this.options.version;
    const result = await this.run(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['view', '@larksuite/cli', 'dist-tags.latest', '--json', '--registry=https://registry.npmjs.org'],
      { env: cliBaseEnvironment(join(this.root, 'probe')), timeout: 30_000 });
    if (result.code) throw new Error('Unable to check CLI version');
    const version: unknown = JSON.parse(result.stdout);
    if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error('Invalid stable CLI version');
    return version;
  }
  private async writeSkills(release: CliRelease) {
    for (const skill of release.skills) {
      const dir = join(this.skillDirectory(release), skill.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), cliSkillStub(skill, release.version));
    }
  }
  async check() {
    return this.exclusive(async () => {
      const state = await readState(this.stateFile);
      try {
        state.availableVersion = await this.latest(); state.checkedAt = Date.now(); delete state.lastError;
        await this.save(state); return this.status();
      } catch (error) { state.checkedAt = Date.now(); state.lastError = 'CLI version check failed'; await this.save(state); throw error; }
    });
  }
  async update() {
    return this.exclusive(async () => {
      const state = await readState(this.stateFile);
      let release: CliRelease | undefined;
      let published = false;
      try {
        const version = await this.latest(); state.availableVersion = version; state.checkedAt = Date.now();
        if (Number(version.split('.')[0]) !== 1 || (Number(version.split('.')[1]) === 0 && Number(version.split('.')[2]) < 96)) {
          throw new Error('Unsupported CLI version; integration requires compatible 1.x releases >=1.0.96');
        }
        if (state.active?.version === version) {
          try {
            await this.validate(state.active); await this.writeSkills(state.active);
            delete state.lastError; await this.save(state); return this.status();
          } catch { /* Reinstall the same version if its managed files are damaged. */ }
        }
        release = { id: randomUUID(), version, skills: [] };
        const stage = join(this.root, 'releases', release.id);
        await mkdir(stage, { recursive: true, mode: 0o700 });
        const env = cliBaseEnvironment(join(stage, 'probe'));
        const install = await this.run(process.platform === 'win32' ? 'npm.cmd' : 'npm',
          ['install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
            '--registry=https://registry.npmjs.org', `@larksuite/cli@${version}`], { env, timeout: 180_000 });
        if (install.code) throw new Error('CLI package installation failed');
        // Only the selected upstream binary installer runs, never dependency lifecycle scripts.
        const downloaded = await this.run(process.execPath, [join(stage, 'node_modules', '@larksuite', 'cli', 'scripts', 'install.js')],
          { cwd: stage, env: { ...env, LARK_CLI_RUN: '1' }, timeout: 180_000 });
        if (downloaded.code) throw new Error('CLI binary installation failed');
        await this.validate(release);
        await this.writeSkills(release);
        // Readers capture this immutable release once; old directories are retained
        // so running operations and an explicit rollback remain valid.
        const next = { ...state, previous: state.active, active: release, updatedAt: Date.now() };
        delete next.lastError;
        await this.save(next); published = true; return this.status();
      } catch (error) {
        // A readback failure after a successful pointer commit must never delete
        // the binary now referenced by current.json.
        if (published) throw error;
        if (release) await rm(join(this.root, 'releases', release.id), { recursive: true, force: true });
        state.lastError = 'CLI update failed; previous release retained'; await this.save(state); throw error;
      }
    });
  }
  private async validate(release: CliRelease) {
    const options = { env: cliBaseEnvironment(join(this.root, 'probe')), timeout: 15_000 };
    const version = await this.run(this.binary(release), ['--version'], options);
    if (version.code || !new RegExp(`(?:^|\\s)${release.version.replaceAll('.', '\\.')}\\s*$`).test(version.stdout.trim())) throw new Error('CLI version verification failed');
    const catalog = await this.run(this.binary(release), ['skills', 'list', '--json'], options);
    if (catalog.code) throw new Error('CLI skill enumeration failed');
    release.skills = parseCliSkills(catalog.stdout);
    if (!release.skills.some(skill => skill.name === 'lark-shared')) throw new Error('CLI authentication skill is missing');
    for (const skill of release.skills) {
      const content = await this.run(this.binary(release), ['skills', 'read', skill.name], options);
      if (content.code || !content.stdout.startsWith('---') || !content.stdout.includes('name:')) throw new Error('CLI skill reading failed');
    }
  }
  async rollback() {
    return this.exclusive(async () => {
      const state = await readState(this.stateFile);
      if (!state.previous) throw new Error('No previous CLI release');
      await this.validate(state.previous);
      [state.active, state.previous] = [state.previous, state.active];
      state.updatedAt = Date.now(); state.checkedAt = Date.now(); delete state.lastError; await this.save(state);
      return this.status();
    });
  }
  async autoUpdate() {
    if (!this.options.enabled || !this.options.autoUpdate) return;
    const state = await readState(this.stateFile);
    if (state.checkedAt && Date.now() - state.checkedAt < this.options.updateCheckIntervalHours * 3_600_000) return;
    await this.update();
  }
  async readSkill(release: CliRelease, name: string, path?: string) {
    if (!release.skills.some(skill => skill.name === name)) throw new Error('Unknown managed CLI skill');
    if (path && (!/^[a-zA-Z0-9_./-]{1,240}$/.test(path) || path.startsWith('/') || path.split('/').includes('..'))) throw new Error('Invalid skill reference path');
    const result = await this.run(this.binary(release), ['skills', 'read', name, ...(path ? [path] : [])],
      { env: cliBaseEnvironment(join(this.root, 'probe')), timeout: 15_000 });
    if (result.code) throw new Error('CLI skill content unavailable; scripts/assets are not embedded');
    return result.stdout;
  }
}
