import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DomainError } from './domain.js';

const storageDirectory = resolve(process.env.CRM_REPORT_STORAGE ?? './.local-storage/reports');
export const MAX_REPORT_BYTES = 100 * 1024 * 1024;

async function ensurePrivateDirectory() {
  await mkdir(resolve(storageDirectory, '..'), { recursive: true, mode: 0o700 });
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(storageDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Report storage directory must be a real directory.');
  await chmod(storageDirectory, 0o700);
}

function storagePath(key: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new DomainError(410, 'report_file_unavailable', 'Файл отчёта недоступен.');
  }
  const path = resolve(storageDirectory, `${key}.blob`);
  const rel = relative(storageDirectory, path);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new DomainError(410, 'report_file_unavailable', 'Файл отчёта недоступен.');
  return path;
}

export async function writePrivateReport(key: string, bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_REPORT_BYTES) throw new Error('Report file size is outside the allowed range.');
  await ensurePrivateDirectory();
  const destination = storagePath(key);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function removePrivateReport(key: string) {
  try { await unlink(storagePath(key)); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

export async function cleanupOrphanReportTemps(maxAgeMs = 24 * 60 * 60 * 1000) {
  await ensurePrivateDirectory();
  const now = Date.now();
  const entries = await readdir(storageDirectory, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.name.endsWith('.tmp') || !/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)) continue;
    const path = resolve(storageDirectory, entry.name);
    const stat = await lstat(path);
    if (entry.isDirectory() || now - stat.mtimeMs < maxAgeMs) continue;
    await unlink(path);
    removed += 1;
  }
  return removed;
}

export async function readPrivateReport(key: string, expectedSize: number, expectedSha256: string): Promise<Buffer> {
  try {
    await ensurePrivateDirectory();
    const path = storagePath(key);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize || stat.size < 1 || stat.size > MAX_REPORT_BYTES) throw new Error('Invalid private report file.');
    const bytes = await readFile(path);
    if (bytes.length !== expectedSize || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('Report file integrity check failed.');
    return bytes;
  } catch {
    throw new DomainError(410, 'report_file_unavailable', 'Файл отчёта недоступен или повреждён.');
  }
}
