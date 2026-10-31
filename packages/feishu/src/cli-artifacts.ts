import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type CliArtifact = { path: string; sizeBytes: number; sha256: string };
const maxFiles = 100;
const maxBytes = 100 * 1024 * 1024;

// CLI output is untrusted. Only explicit saved_path files inside this private
// operation may survive cleanup; never retain arbitrary CLI/config scratch data.
export async function persistCliDownloads(root: string, cwd: string, payload: unknown, signal?: AbortSignal) {
  const artifacts: CliArtifact[] = [];
  const saved = new Map<string, string>();
  let destination: string | undefined;
  let totalBytes = 0;
  const operation = await realpath(cwd);
  const inside = (base: string, path: string) => {
    const part = relative(base, path);
    return part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
  };
  async function persist(path: unknown) {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Invalid CLI download path');
    // Accept both logical /tmp paths and the canonical /private/tmp form on macOS.
    const source = resolve(cwd, path);
    const base = inside(resolve(cwd), source) ? resolve(cwd) : operation;
    if (!inside(base, source)) throw new Error('CLI download is outside its operation directory');
    let current = base;
    const parts = relative(base, source).split(sep);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new Error('Unsafe CLI download path');
    }
    const canonical = await realpath(source);
    if (!inside(operation, canonical)) throw new Error('CLI download escapes its operation directory');
    if (saved.has(canonical)) return saved.get(canonical)!;
    if (artifacts.length >= maxFiles) throw new Error('CLI download file limit exceeded');
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await input.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('CLI download must be an ordinary unlinked file');
      if (totalBytes + info.size > maxBytes) throw new Error('CLI download byte limit exceeded');
      if (!destination) {
        const downloads = join(await realpath(root), 'downloads');
        await mkdir(downloads, { recursive: true, mode: 0o700 });
        const directory = await lstat(downloads);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe CLI download storage');
        destination = await mkdtemp(join(downloads, 'call-'));
      }
      const directory = join(destination, String(artifacts.length + 1));
      await mkdir(directory, { mode: 0o700 });
      const target = join(directory, basename(source));
      const output = await open(target, 'wx', 0o600);
      const hash = createHash('sha256');
      let sizeBytes = 0;
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          signal?.throwIfAborted();
          sizeBytes += chunk.length;
          if (totalBytes + sizeBytes > maxBytes) throw new Error('CLI download byte limit exceeded');
          hash.update(chunk); await output.writeFile(chunk);
        }
        await output.sync();
      } finally { await output.close(); }
      const after = await input.stat();
      if (sizeBytes !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('CLI download changed during persistence');
      totalBytes += sizeBytes;
      artifacts.push({ path: target, sizeBytes, sha256: hash.digest('hex') });
      saved.set(canonical, target);
      return target;
    } finally { await input.close(); }
  }
  async function visit(value: unknown): Promise<unknown> {
    signal?.throwIfAborted();
    if (Array.isArray(value)) { const result = []; for (const item of value) result.push(await visit(item)); return result; }
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, { enumerable: true, value: key === 'saved_path' ? await persist(item) : await visit(item) });
    }
    return result;
  }
  try { return { payload: await visit(payload), artifacts }; }
  catch {
    if (destination) await rm(destination, { recursive: true, force: true });
    throw new Error('CLI download could not be persisted: missing, unsafe, changed, cancelled or exceeds 100 files / 100 MiB');
  }
}
