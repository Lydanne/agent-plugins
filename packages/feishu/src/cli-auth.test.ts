import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FeishuCliAuth, cliAuthEndpoints } from './cli-auth.js';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const account = { accountId: 'work', appId: 'cli_fixture', appSecret: 'fixture-private-key', domain: 'feishu' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'feishu-cli-auth-test-')); roots.push(root);
  const request = vi.fn<typeof fetch>();
  const auth = new FeishuCliAuth(root, request);
  return { root, request, auth };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const device = { device_code: 'private-device', verification_uri_complete: 'https://accounts.feishu.cn/verify?x=a%2Bb', interval: 5, expires_in: 240 };
const token = { access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'Bearer', expires_in: 7200, scope: 'docs:document:readonly' };

it('requires explicit scopes, keeps secrets private, and binds authorization to the exact requesting user', async () => {
  vi.useFakeTimers(); const f = await fixture();
  await expect(f.auth.login(account, 'ou_alice', '')).rejects.toThrow('scopes'); expect(f.request).not.toHaveBeenCalled();
  f.request.mockResolvedValueOnce(json(device));
  const started = await f.auth.login(account, 'ou_alice', 'docs:document:readonly');
  expect(started.verificationUrl).toBe(device.verification_uri_complete); expect(JSON.stringify(started)).not.toContain('private-device');
  expect(String(f.request.mock.calls[0][1]?.body)).toContain('offline_access');
  expect((await f.auth.complete(account, 'ou_alice')).status).toBe('authorization_pending');
  vi.advanceTimersByTime(5000);
  f.request.mockResolvedValueOnce(json(token)).mockResolvedValueOnce(json({ code: 0, data: { open_id: 'ou_alice' } }));
  expect(await f.auth.complete(account, 'ou_alice')).toMatchObject({ status: 'authorized', openId: 'ou_alice' });
  expect(await f.auth.accessToken(account, 'ou_alice')).toBe('private-access');
  await expect(f.auth.accessToken(account, 'ou_bob')).rejects.toThrow('required');
  await expect(f.auth.accessToken({ ...account, appId: 'cli_other' }, 'ou_alice')).rejects.toThrow('required');
  const files = (await readdir(f.root)).filter(file => file.endsWith('.json'));
  expect(files).toHaveLength(1); expect((await stat(join(f.root, files[0]))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(f.root, files[0]), 'utf8')).not.toContain('private-device');
});
it('rejects a different user scanning the authorization link and clears the pending challenge', async () => {
  vi.useFakeTimers(); const f = await fixture(); f.request.mockResolvedValueOnce(json(device));
  await f.auth.login(account, 'ou_alice', 'docs:document:readonly'); vi.advanceTimersByTime(5000);
  f.request.mockResolvedValueOnce(json(token)).mockResolvedValueOnce(json({ code: 0, data: { open_id: 'ou_bob' } }));
  await expect(f.auth.complete(account, 'ou_alice')).rejects.toThrow('does not match');
  expect(await f.auth.status(account, 'ou_alice')).toMatchObject({ authorized: false, pending: false });
});
it('refreshes only the bound user, retains refreshed tokens privately, and supports local logout', async () => {
  vi.useFakeTimers(); const f = await fixture(); f.request.mockResolvedValueOnce(json(device));
  await f.auth.login(account, 'ou_alice', 'docs:document:readonly'); vi.advanceTimersByTime(5000);
  f.request.mockResolvedValueOnce(json({ ...token, expires_in: 30 })).mockResolvedValueOnce(json({ code: 0, data: { open_id: 'ou_alice' } }));
  await f.auth.complete(account, 'ou_alice');
  f.request.mockResolvedValueOnce(json({ ...token, access_token: 'refreshed-access' })).mockResolvedValueOnce(json({ code: 0, data: { open_id: 'ou_alice' } }));
  expect(await f.auth.accessToken(account, 'ou_alice')).toBe('refreshed-access');
  expect(String(f.request.mock.calls[3][1]?.body)).toContain('refresh_token=private-refresh');
  expect(await f.auth.logout(account, 'ou_alice')).toMatchObject({ serverAuthorizationRevoked: false });
  await expect(f.auth.accessToken(account, 'ou_alice')).rejects.toThrow('required');
});
it('honors slow-down, handles expiry and denies untrusted identities/custom domains', async () => {
  vi.useFakeTimers(); const f = await fixture(); f.request.mockResolvedValueOnce(json(device));
  await f.auth.login(account, 'ou_alice', 'docs:document:readonly'); vi.advanceTimersByTime(5000);
  f.request.mockResolvedValueOnce(json({ error: 'slow_down' }));
  expect(await f.auth.complete(account, 'ou_alice')).toMatchObject({ status: 'authorization_pending', retryAfterMs: 10000 });
  vi.advanceTimersByTime(240000); await expect(f.auth.complete(account, 'ou_alice')).rejects.toThrow('expired');
  await expect(f.auth.login(account, '../bob', 'docs:read')).rejects.toThrow('trusted');
  expect(() => cliAuthEndpoints('https://example.test')).toThrow();
});
