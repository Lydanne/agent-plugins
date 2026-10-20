import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type CliAccount = { accountId: string; appId: string; appSecret: string; domain: string };
type UserToken = { accessToken: string; refreshToken?: string; expiresAt: number; scope: string; openId: string };
type Pending = { deviceCode: string; expiresAt: number; nextPollAt: number; interval: number };
type Session = { token?: UserToken; pending?: Pending };
type Fetch = typeof fetch;
const activeAuthorizations = new Set<string>();

export function cliAuthEndpoints(domain: string) {
  if (domain !== 'feishu' && domain !== 'lark') throw new Error('CLI authentication supports feishu/lark domains only');
  return domain === 'lark'
    ? { accounts: 'https://accounts.larksuite.com', api: 'https://open.larksuite.com' }
    : { accounts: 'https://accounts.feishu.cn', api: 'https://open.feishu.cn' };
}

export class FeishuCliAuth {
  constructor(readonly root: string, readonly request: Fetch = fetch) {}
  private file(account: CliAccount, sender: string) {
    if (!/^ou_[A-Za-z0-9]+$/.test(sender)) throw new Error('A trusted Feishu sender OpenID is required');
    return join(this.root, createHash('sha256').update(JSON.stringify([account.accountId, account.appId, account.domain, sender])).digest('hex') + '.json');
  }
  private async load(file: string): Promise<Session> {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Unable to read user authorization'); }
  }
  private async save(file: string, session: Session) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(session), { mode: 0o600 });
    await rename(temp, file);
  }
  private async locked<T>(account: CliAccount, sender: string, work: (file: string, session: Session) => Promise<T>): Promise<T> {
    const file = this.file(account, sender);
    if (activeAuthorizations.has(file)) throw new Error('User authorization is already being updated');
    activeAuthorizations.add(file);
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      try { await mkdir(`${file}.lock`); } catch { throw new Error('User authorization is locked'); }
      try { return await work(file, await this.load(file)); }
      finally { await rm(`${file}.lock`, { recursive: true, force: true }); }
    } finally { activeAuthorizations.delete(file); }
  }
  private async form(url: string, values: Record<string, string>, basic?: string) {
    const response = await this.request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(basic ? { Authorization: `Basic ${basic}` } : {}) },
      body: new URLSearchParams(values) });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok && !value.error) throw new Error('OAuth service request failed');
    return value;
  }
  async status(account: CliAccount, sender: string) {
    const session = await this.load(this.file(account, sender));
    return { authorized: session.token?.openId === sender, expiresAt: session.token?.expiresAt,
      scope: session.token?.scope, pending: !!session.pending && session.pending.expiresAt > Date.now() };
  }
  async login(account: CliAccount, sender: string, scope: string) {
    if (!scope.trim() || scope.length > 4000 || !/^[a-zA-Z0-9_:.,\s-]+$/.test(scope)) throw new Error('Explicit OAuth scopes are required');
    const endpoints = cliAuthEndpoints(account.domain);
    return this.locked(account, sender, async (file, session) => {
      const scopes = new Set(scope.split(/[\s,]+/).filter(Boolean)); scopes.add('offline_access');
      // Preserve already granted scopes on an explicit incremental authorization.
      for (const old of session.token?.scope.split(/\s+/) ?? []) if (old) scopes.add(old);
      const value = await this.form(`${endpoints.accounts}/oauth/v1/device_authorization`,
        { client_id: account.appId, scope: [...scopes].join(' ') }, Buffer.from(`${account.appId}:${account.appSecret}`).toString('base64'));
      const url = value.verification_uri_complete ?? value.verification_uri;
      if (value.error || typeof url !== 'string' || typeof value.device_code !== 'string' || !value.device_code) throw new Error('Unable to start user authorization');
      if (new URL(url).protocol !== 'https:') throw new Error('Invalid authorization URL');
      const interval = Math.max(5, Number(value.interval) || 5) * 1000;
      const expiresAt = Date.now() + Math.min(1800, Math.max(1, Number(value.expires_in) || 240)) * 1000;
      session.pending = { deviceCode: value.device_code, interval, expiresAt, nextPollAt: Date.now() + interval };
      await this.save(file, session);
      // Device codes and access/refresh tokens never leave the plugin.
      return { status: 'authorization_required', verificationUrl: url, userCode: value.user_code, expiresAt };
    });
  }
  private async identify(account: CliAccount, accessToken: string): Promise<string> {
    const { api } = cliAuthEndpoints(account.domain);
    const response = await this.request(`${api}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const value = await response.json() as { code?: number; data?: { open_id?: string } };
    if (!response.ok || value.code !== 0 || !value.data?.open_id) throw new Error('Unable to verify authorized user');
    return value.data.open_id;
  }
  private token(value: Record<string, unknown>, sender: string, previous?: UserToken): UserToken {
    if (typeof value.access_token !== 'string' || !value.access_token ||
      (value.token_type && String(value.token_type).toLowerCase() !== 'bearer') ||
      !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0) throw new Error('Unsupported OAuth token response');
    return { accessToken: value.access_token, refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : previous?.refreshToken,
      expiresAt: Date.now() + Number(value.expires_in) * 1000, scope: typeof value.scope === 'string' ? value.scope : previous?.scope ?? '', openId: sender };
  }
  async complete(account: CliAccount, sender: string) {
    return this.locked(account, sender, async (file, session) => {
      const pending = session.pending;
      if (!pending || pending.expiresAt <= Date.now()) {
        delete session.pending; await this.save(file, session); throw new Error('Authorization expired; start a new login');
      }
      if (pending.nextPollAt > Date.now()) return { status: 'authorization_pending', retryAfterMs: pending.nextPollAt - Date.now() };
      // One bounded poll per Main call; never hold the conversation waiting for a browser.
      pending.nextPollAt = Date.now() + pending.interval; await this.save(file, session);
      const value = await this.form(`${cliAuthEndpoints(account.domain).accounts}/oauth/v3/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pending.deviceCode,
        client_id: account.appId, client_secret: account.appSecret });
      if (value.error === 'authorization_pending' || value.error === 'slow_down') {
        if (value.error === 'slow_down') pending.interval += 5000;
        pending.nextPollAt = Date.now() + pending.interval; await this.save(file, session);
        return { status: 'authorization_pending', retryAfterMs: pending.interval };
      }
      if (value.error) { delete session.pending; await this.save(file, session); throw new Error('Authorization was denied or expired'); }
      const token = this.token(value, sender);
      if (await this.identify(account, token.accessToken) !== sender) {
        delete session.pending; await this.save(file, session); throw new Error('Authorized user does not match the requesting Feishu user');
      }
      session.token = token; delete session.pending; await this.save(file, session);
      return { status: 'authorized', openId: sender, scope: token.scope, expiresAt: token.expiresAt };
    });
  }
  async accessToken(account: CliAccount, sender: string) {
    return this.locked(account, sender, async (file, session) => {
      const token = session.token;
      if (!token || token.openId !== sender) throw new Error('User authorization required');
      if (token.expiresAt > Date.now() + 60_000) return token.accessToken;
      if (!token.refreshToken) throw new Error('User authorization expired');
      const value = await this.form(`${cliAuthEndpoints(account.domain).accounts}/oauth/v3/token`, {
        grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: account.appId, client_secret: account.appSecret });
      if (value.error) throw new Error('User authorization refresh failed; authorize again');
      const refreshed = this.token(value, sender, token);
      if (await this.identify(account, refreshed.accessToken) !== sender) throw new Error('Refreshed user identity mismatch');
      session.token = refreshed; await this.save(file, session); return refreshed.accessToken;
    });
  }
  async logout(account: CliAccount, sender: string) {
    return this.locked(account, sender, async file => {
      await rm(file, { force: true }); return { status: 'logged_out', serverAuthorizationRevoked: false };
    });
  }
}
