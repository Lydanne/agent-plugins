import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuCliManager, parseCliSkills } from './cli-manager.js';
import { resolveCliConfig, FeishuCliConfigSchema } from './cli-config.js';
import type { CliRunner } from './cli-process.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(config = resolveCliConfig()) {
  const root = await mkdtemp(join(tmpdir(), 'feishu-cli-test-')); roots.push(root);
  let latest = '1.0.96', installed = latest, broken = false;
  const run = vi.fn<CliRunner>(async (_file, args) => {
    if (args[0] === 'view') return { code: 0, stdout: JSON.stringify(latest), stderr: '' };
    if (args[0] === 'install') installed = args.at(-1)!.split('@').at(-1)!;
    if (args[0] === '--version') return { code: 0, stdout: `lark-cli version ${installed}\n`, stderr: '' };
    if (args[0] === 'skills' && args[1] === 'list') return { code: 0, stdout: JSON.stringify({ skills: [
      { name: 'lark-shared', description: '应用认证' }, { name: 'lark-doc', description: '读取文档' },
    ] }), stderr: '' };
    if (args[0] === 'skills' && args[1] === 'read') return { code: broken ? 1 : 0,
      stdout: `---\nname: ${args[2]}\n---\nupstream-private-body`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const manager = new FeishuCliManager(root, config, run);
  return { root, run, manager, latest: (value: string) => { latest = value; }, broken: () => { broken = true; } };
}

describe('managed CLI lifecycle', () => {
  it('defaults automatic updates on, installs explicitly without dependency scripts, and generates only indexes', async () => {
    expect(resolveCliConfig()).toMatchObject({ enabled: true, autoUpdate: true, updateCheckIntervalHours: 24, userAuth: false });
    expect(FeishuCliConfigSchema.safeParse({ autoUpdate: false, updateCheckIntervalHours: 0 }).success).toBe(false);
    const f = await fixture(); await f.manager.autoUpdate();
    const current = await f.manager.snapshot();
    expect(current.version).toBe('1.0.96');
    const stub = await readFile(join(f.manager.skillDirectory(current), 'lark-doc', 'SKILL.md'), 'utf8');
    expect(stub).toContain('action=read_skill'); expect(stub).toContain('Worker'); expect(stub).not.toContain('upstream-private-body');
    expect(f.run.mock.calls.find(([, args]) => args[0] === 'install')?.[1]).toContain('--ignore-scripts');
    expect(f.run.mock.calls.some(([, args]) => args[0]?.endsWith('scripts/install.js'))).toBe(true);
    const count = f.run.mock.calls.length; await f.manager.autoUpdate(); expect(f.run).toHaveBeenCalledTimes(count);
  });
  it('turns automatic installation off but still permits manual update', async () => {
    const f = await fixture(resolveCliConfig({ autoUpdate: false }));
    await f.manager.autoUpdate(); expect(f.run).not.toHaveBeenCalled();
    await f.manager.update(); expect((await f.manager.snapshot()).version).toBe('1.0.96');
  });
  it('atomically swaps versions, retains captured binaries, and rolls CLI and catalog back together', async () => {
    const f = await fixture(); await f.manager.update(); const before = await f.manager.snapshot();
    f.latest('1.0.97'); await f.manager.update(); const after = await f.manager.snapshot();
    expect(after.id).not.toBe(before.id); expect((await f.manager.status()).previous).toEqual(before);
    expect(await readFile(join(f.manager.skillDirectory(before), 'lark-doc', 'SKILL.md'), 'utf8')).toContain('1.0.96');
    // Version probes run the release binary, not the newest global executable.
    f.run.mockImplementationOnce(async () => ({ code: 0, stdout: 'lark-cli version 1.0.96', stderr: '' }));
    await f.manager.rollback(); expect(await f.manager.snapshot()).toEqual(before);
    expect(f.manager.binary(before)).not.toEqual(f.manager.binary(after));
  });
  it('preserves current and previous state and removes failed candidates', async () => {
    const f = await fixture(); await f.manager.update(); const before = await f.manager.snapshot();
    f.latest('1.0.97'); f.broken(); await expect(f.manager.update()).rejects.toThrow('skill reading');
    expect(await f.manager.snapshot()).toEqual(before);
    expect(await readdir(join(f.root, 'releases'))).toEqual([before.id]);
    expect((await f.manager.status()).lastError).toContain('previous release retained');
  });
  it('rejects incompatible major versions and cross-process concurrent updates', async () => {
    const f = await fixture(); f.latest('2.0.0'); await expect(f.manager.update()).rejects.toThrow('Unsupported');
    f.latest('1.0.96');
    let release!: () => void;
    const wait = new Promise<void>(done => { release = done; });
    f.run.mockImplementationOnce(async () => { await wait; return { code: 0, stdout: '"1.0.96"', stderr: '' }; });
    const updating = f.manager.update();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    await expect(new FeishuCliManager(f.root, resolveCliConfig(), f.run).update()).rejects.toThrow('locked');
    release(); await updating;
  });
  it('keeps the old pointer when committing a candidate fails', async () => {
    const f = await fixture(); await f.manager.update(); const before = await f.manager.snapshot();
    f.latest('1.0.97');
    vi.spyOn(f.manager as unknown as { save: (state: unknown) => Promise<void> }, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(f.manager.update()).rejects.toThrow('disk full');
    expect(await f.manager.snapshot()).toEqual(before);
    expect(await readdir(join(f.root, 'releases'))).toEqual([before.id]);
  });
  it('rejects malicious catalog names, duplicates and reference traversal', async () => {
    for (const name of ['../evil', 'lark-doc/../../evil', 'other-doc']) expect(() => parseCliSkills(JSON.stringify({ skills: [{ name, description: 'x' }] }))).toThrow();
    expect(() => parseCliSkills(JSON.stringify({ skills: [{ name: 'lark-doc', description: 'x' }, { name: 'lark-doc', description: 'x' }] }))).toThrow();
    const f = await fixture(); await f.manager.update(); const current = await f.manager.snapshot();
    await expect(f.manager.readSkill(current, 'lark-doc', '../../config')).rejects.toThrow();
    await expect(f.manager.readSkill(current, 'lark-missing')).rejects.toThrow();
  });
});
