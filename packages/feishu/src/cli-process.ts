import { spawn } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type CliProcessResult = { code: number; stdout: string; stderr: string };
export type CliRunner = (file: string, args: string[], options?: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal;
}) => Promise<CliProcessResult>;

// Never interpolate shell text or put credentials in argv. Child output is
// bounded and process errors deliberately omit argv/environment/output.
export const runCliProcess: CliRunner = (file, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new Error('CLI process was cancelled')); return; }
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let stdout = '', stderr = '', oversized = false, timedOut = false;
  let bytes = 0;
  const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
  let cancelled = false;
  const kill = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* The process may have just exited. */ }
  };
  const abort = () => { cancelled = true; kill(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeout ?? 60_000);
  const collect = (chunk: Buffer, error: boolean) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) {
      oversized = true; kill(); return;
    }
    if (error) stderr += errDecoder.write(chunk); else stdout += outDecoder.write(chunk);
  };
  child.stdout.on('data', chunk => collect(chunk, false));
  child.stderr.on('data', chunk => collect(chunk, true));
  child.on('error', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(new Error('CLI process could not start or was cancelled')); });
  child.on('close', code => {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    stdout += outDecoder.end(); stderr += errDecoder.end();
    if (oversized || timedOut || cancelled) reject(new Error(cancelled ? 'CLI process was cancelled' : oversized ? 'CLI output limit exceeded' : 'CLI process timed out'));
    else resolve({ code: code ?? 1, stdout, stderr });
  });
});

// Do not inherit an operator's CLI profile, tokens, proxy-sidecar identity, or
// plugin credentials. Only pass OS/runtime/network settings required by the child.
export function cliBaseEnvironment(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy',
    'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = dirname(process.execPath) + delimiter + (env.PATH ?? '');
  return { ...env, LARKSUITE_CLI_CONFIG_DIR: configDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1', CI: '1' };
}

export function redactCliOutput(text: string, secrets: string[] = []): string {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/("(?:access_?token|refresh_?token|app_?secret|client_secret|device_code)"\s*:\s*")[^"]*/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [REDACTED]');
}
