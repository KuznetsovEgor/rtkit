#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_REPORT_BYTES = 100 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_BLOB = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.blob$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class SafeInspectionError extends Error {}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertRecordArray(rows, maximumSize) {
  if (!Array.isArray(rows) || rows.length > MAX_ENTRIES) {
    throw new SafeInspectionError('Metadata snapshot has an invalid or excessive record list.');
  }

  const records = new Map();
  for (const row of rows) {
    if (!hasExactKeys(row, ['key', 'sizeBytes', 'sha256']) ||
        typeof row.key !== 'string' || !UUID.test(row.key) ||
        !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1 || row.sizeBytes > maximumSize ||
        typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) {
      throw new SafeInspectionError('Metadata snapshot contains an invalid file record.');
    }
    const key = row.key.toLowerCase();
    if (records.has(key)) throw new SafeInspectionError('Metadata snapshot contains duplicate file keys.');
    records.set(key, { sizeBytes: row.sizeBytes, sha256: row.sha256 });
  }
  return records;
}

export function validateMetadataSnapshot(snapshot) {
  if (!hasExactKeys(snapshot, ['schemaVersion', 'documents', 'reports']) || snapshot.schemaVersion !== 1) {
    throw new SafeInspectionError('Metadata snapshot has an unsupported shape or version.');
  }
  return {
    documents: assertRecordArray(snapshot.documents, MAX_DOCUMENT_BYTES),
    reports: assertRecordArray(snapshot.reports, MAX_REPORT_BYTES),
  };
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function rootsOverlap(left, right) {
  return inside(left, right) || inside(right, left);
}

async function inspectRealDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new SafeInspectionError('Storage roots must be absolute paths.');
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  let finalInfo;
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    let info;
    try { info = await lstat(current, { bigint: true }); }
    catch { throw new SafeInspectionError('A selected storage path is unavailable.'); }
    if (info.isSymbolicLink()) throw new SafeInspectionError('A selected storage path contains a symbolic link.');
    if (!info.isDirectory()) throw new SafeInspectionError('A selected storage path is not a real directory.');
    finalInfo = info;
  }
  const finalMode = typeof finalInfo.mode === 'bigint' ? Number(finalInfo.mode) : finalInfo.mode;
  if ((finalMode & 0o077) !== 0 || (finalMode & 0o7000) !== 0) {
    return { resolved, unsafePermissions: true, stamp: stamp(finalInfo) };
  }
  return { resolved, unsafePermissions: false, stamp: stamp(finalInfo) };
}

function stamp(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    mode: typeof info.mode === 'bigint' ? Number(info.mode) : info.mode,
    size: Number(info.size),
    mtime: info.mtimeNs === undefined ? String(Math.round(info.mtimeMs * 1_000_000)) : String(info.mtimeNs),
    ctime: info.ctimeNs === undefined ? String(Math.round(info.ctimeMs * 1_000_000)) : String(info.ctimeNs),
  };
}

function sameStamp(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size &&
    left.mtime === right.mtime && left.ctime === right.ctime;
}

function emptyCounts(metadataCount, blobCount) {
  return {
    metadataCount,
    blobCount,
    missingBlobCount: 0,
    orphanBlobCount: 0,
    sizeMismatchCount: 0,
    checksumMismatchCount: 0,
    unsafeEntryCount: 0,
    unsafePermissionCount: 0,
    unreadableOrChangedCount: 0,
    invalidBlobNameCount: 0,
  };
}

async function hashStableFile(root, name, expectedStamp, expectedSize) {
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new SafeInspectionError('This platform cannot safely open files without following symbolic links.');
  }

  let handle;
  try {
    const fullPath = path.join(root, name);
    handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = stamp(await handle.stat({ bigint: true }));
    if (!sameStamp(expectedStamp, before) || (before.mode & 0o170000) !== 0o100000 ||
        (before.mode & 0o077) !== 0 || (before.mode & 0o7111) !== 0) {
      return { changed: true, unsafePermissions: (before.mode & 0o077) !== 0 || (before.mode & 0o7111) !== 0 };
    }

    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: expectedSize - 1 })) hash.update(chunk);
    const after = stamp(await handle.stat({ bigint: true }));
    let pathAfter;
    try { pathAfter = stamp(await lstat(fullPath, { bigint: true })); }
    catch { return { changed: true, unsafePermissions: false }; }
    if (!sameStamp(before, after) || !sameStamp(before, pathAfter)) return { changed: true, unsafePermissions: false };
    return { changed: false, unsafePermissions: false, sha256: hash.digest('hex') };
  } catch {
    return { changed: true, unsafePermissions: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectCategory(rootPath, expected, category) {
  const root = await inspectRealDirectory(rootPath);
  const counts = emptyCounts(expected.size, 0);
  if (root.unsafePermissions) counts.unsafePermissionCount += 1;

  let entries;
  try { entries = await readdir(root.resolved, { withFileTypes: true }); }
  catch { throw new SafeInspectionError('A selected storage directory could not be read.'); }
  let rootAfter;
  try { rootAfter = stamp(await lstat(root.resolved, { bigint: true })); }
  catch { throw new SafeInspectionError('A selected storage path changed while it was inspected.'); }
  if (!sameStamp(root.stamp, rootAfter)) throw new SafeInspectionError('A selected storage path changed while it was inspected.');
  if (entries.length > MAX_ENTRIES) throw new SafeInspectionError('A selected storage directory contains too many entries.');

  const found = new Map();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      counts.unsafeEntryCount += 1;
      continue;
    }
    if (entry.isDirectory()) {
      counts.unsafeEntryCount += 1;
      continue;
    }
    if (!entry.isFile()) {
      counts.unsafeEntryCount += 1;
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.blob')) continue;
    if (!UUID_BLOB.test(entry.name)) {
      counts.invalidBlobNameCount += 1;
      continue;
    }

    const fullPath = path.join(root.resolved, entry.name);
    let info;
    try { info = await lstat(fullPath, { bigint: true }); }
    catch { counts.unreadableOrChangedCount += 1; continue; }
    if (info.isSymbolicLink() || !info.isFile()) {
      counts.unsafeEntryCount += 1;
      continue;
    }
    const key = entry.name.slice(0, -'.blob'.length).toLowerCase();
    const fileStamp = stamp(info);
    const unsafePermissions = (fileStamp.mode & 0o077) !== 0 || (fileStamp.mode & 0o7111) !== 0;
    if (unsafePermissions) counts.unsafePermissionCount += 1;
    found.set(key, { name: entry.name, stamp: fileStamp, unsafePermissions });
  }

  counts.blobCount = found.size;
  for (const key of expected.keys()) {
    if (!found.has(key)) counts.missingBlobCount += 1;
  }
  for (const key of found.keys()) {
    if (!expected.has(key)) counts.orphanBlobCount += 1;
  }

  for (const [key, expectedRecord] of expected) {
    const file = found.get(key);
    if (!file) continue;
    if (file.stamp.size !== expectedRecord.sizeBytes) {
      counts.sizeMismatchCount += 1;
      continue;
    }
    if (root.unsafePermissions || file.unsafePermissions) continue;
    const checked = await hashStableFile(root.resolved, file.name, file.stamp, expectedRecord.sizeBytes);
    if (checked.unsafePermissions) counts.unsafePermissionCount += 1;
    if (checked.changed) counts.unreadableOrChangedCount += 1;
    else if (checked.sha256 !== expectedRecord.sha256) counts.checksumMismatchCount += 1;
  }

  return { category, ...counts };
}

function categoryHasIssues(result) {
  return result.missingBlobCount > 0 || result.orphanBlobCount > 0 || result.sizeMismatchCount > 0 ||
    result.checksumMismatchCount > 0 || result.unsafeEntryCount > 0 || result.unsafePermissionCount > 0 ||
    result.unreadableOrChangedCount > 0 || result.invalidBlobNameCount > 0;
}

export async function verifyPrivateBlobConsistency(snapshot, options = {}) {
  const { documentRoot, reportRoot } = options;
  if (typeof documentRoot !== 'string' || typeof reportRoot !== 'string' ||
      !path.isAbsolute(documentRoot) || !path.isAbsolute(reportRoot)) {
    throw new SafeInspectionError('Both storage roots must be provided explicitly.');
  }
  const documentsPath = path.resolve(documentRoot);
  const reportsPath = path.resolve(reportRoot);
  if (rootsOverlap(documentsPath, reportsPath)) throw new SafeInspectionError('Document and report storage roots must be separate.');

  const expected = validateMetadataSnapshot(snapshot);
  const documents = await inspectCategory(documentsPath, expected.documents, 'documents');
  const reports = await inspectCategory(reportsPath, expected.reports, 'reports');
  return { ok: !categoryHasIssues(documents) && !categoryHasIssues(reports), documents, reports };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const names = { '--metadata-file': 'metadataFile', '--documents-root': 'documentRoot', '--reports-root': 'reportRoot' };
    const name = names[argument];
    if (!name || result[name]) throw new SafeInspectionError('Use --help to see the supported arguments.');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new SafeInspectionError('Each argument requires a value.');
    result[name] = value;
    index += 1;
  }
  if (!result.metadataFile || !result.documentRoot || !result.reportRoot) {
    throw new SafeInspectionError('Metadata file and both storage roots must be provided explicitly.');
  }
  if (![result.metadataFile, result.documentRoot, result.reportRoot].every(path.isAbsolute)) {
    throw new SafeInspectionError('All paths must be absolute.');
  }
  return result;
}

function ensureLocalStorageRoot(root, category) {
  const setting = category === 'documents' ? process.env.CRM_DOCUMENT_STORAGE : process.env.CRM_REPORT_STORAGE;
  const fallback = category === 'documents' ? './.local-storage/documents' : './.local-storage/reports';
  const configuredRoot = path.resolve(CRM_ROOT, setting ?? fallback);
  if (path.resolve(root) !== configuredRoot || !inside(CRM_ROOT, configuredRoot) || configuredRoot === CRM_ROOT) {
    throw new SafeInspectionError(`The ${category} root must match its configured local CRM storage directory.`);
  }
}

async function readSnapshotFile(filePath) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  let initialFileStamp;
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    let info;
    try { info = await lstat(current, { bigint: true }); }
    catch { throw new SafeInspectionError('Metadata snapshot file is unavailable.'); }
    if (info.isSymbolicLink()) throw new SafeInspectionError('Metadata snapshot path contains a symbolic link.');
    if (index < components.length - 1 && !info.isDirectory()) throw new SafeInspectionError('Metadata snapshot path is not a real file path.');
    if (index === components.length - 1 && !info.isFile()) throw new SafeInspectionError('Metadata snapshot is not a regular file.');
    const infoMode = typeof info.mode === 'bigint' ? Number(info.mode) : info.mode;
    if (index === components.length - 1 && ((infoMode & 0o077) !== 0 || (infoMode & 0o7111) !== 0)) {
      throw new SafeInspectionError('Metadata snapshot file permissions must be private.');
    }
    if (index === components.length - 1) {
      if (Number(info.size) > SNAPSHOT_MAX_BYTES) throw new SafeInspectionError('Metadata snapshot is too large.');
      initialFileStamp = stamp(info);
    }
  }
  let bytes;
  let handle;
  try {
    if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
      throw new SafeInspectionError('This platform cannot safely open files without following symbolic links.');
    }
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStamp = stamp(await handle.stat({ bigint: true }));
    const currentStamp = stamp(await lstat(absolute, { bigint: true }));
    if (!sameStamp(initialFileStamp, openedStamp) || !sameStamp(openedStamp, currentStamp) || openedStamp.size > SNAPSHOT_MAX_BYTES) {
      throw new SafeInspectionError('Metadata snapshot changed while it was being inspected.');
    }
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      totalBytes += chunk.length;
      if (totalBytes > SNAPSHOT_MAX_BYTES) throw new SafeInspectionError('Metadata snapshot is too large.');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks, totalBytes);
    const finalStamp = stamp(await handle.stat({ bigint: true }));
    if (!sameStamp(openedStamp, finalStamp)) throw new SafeInspectionError('Metadata snapshot changed while it was being inspected.');
  } catch (error) {
    if (error instanceof SafeInspectionError) throw error;
    throw new SafeInspectionError('Metadata snapshot file could not be read safely.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (bytes.length > SNAPSHOT_MAX_BYTES) throw new SafeInspectionError('Metadata snapshot is too large.');
  let snapshot;
  try { snapshot = JSON.parse(bytes.toString('utf8')); }
  catch { throw new SafeInspectionError('Metadata snapshot is not valid JSON.'); }
  return snapshot;
}

function usage() {
  return [
    'Compare metadata-only CRM snapshots with local private .blob files.',
    'This tool never connects to PostgreSQL and does not use DATABASE_URL.',
    '',
    'node scripts/verify-private-blobs.mjs \\',
    '  --metadata-file /absolute/path/to/private-metadata.json \\',
    '  --documents-root /absolute/path/to/configured/documents \\',
    '  --reports-root /absolute/path/to/configured/reports',
    '',
    'Snapshot JSON must contain only schemaVersion, documents, and reports.',
    'Each category is an array of {"key":"UUID","sizeBytes":1,"sha256":"64 lowercase hex chars"}.',
    'Include all activity_documents rows and every completed export report_jobs row, regardless of expiry time.',
    'Keep missing/null completed-export fields in the snapshot so validation fails closed; set snapshot permissions to owner-only.',
    'The output contains aggregate counts only. Concurrent writes can cause transient mismatches.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  ensureLocalStorageRoot(args.documentRoot, 'documents');
  ensureLocalStorageRoot(args.reportRoot, 'reports');
  const snapshot = await readSnapshotFile(args.metadataFile);
  const result = await verifyPrivateBlobConsistency(snapshot, {
    documentRoot: args.documentRoot,
    reportRoot: args.reportRoot,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof SafeInspectionError
      ? error.message
      : 'Consistency verification stopped after a safe inspection error.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
