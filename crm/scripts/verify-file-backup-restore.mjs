#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(CRM_ROOT, '..');
const AGENT_ROOT = path.join(REPO_ROOT, '.agent');
const PRIVATE_ROOT = path.join(AGENT_ROOT, 'private');
const BACKUP_ROOT = path.join(PRIVATE_ROOT, 'file-backups');
const CATEGORIES = new Set(['documents', 'reports', 'mock-state']);
const UUID_BLOB = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.blob$/i;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_MODE_MASK = 0o777;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 16;

class SafeError extends Error {}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sourceDefinitions() {
  const definitions = [
    { category: 'documents', value: process.env.CRM_DOCUMENT_STORAGE ?? './.local-storage/documents' },
    { category: 'reports', value: process.env.CRM_REPORT_STORAGE ?? './.local-storage/reports' },
    { category: 'mock-state', value: path.join(process.env.CRM_MOCK_STATE_DIR ?? 'api/.mock-state', '') },
  ];
  return definitions.map(({ category, value }) => {
    const resolved = path.resolve(CRM_ROOT, value);
    if (!inside(CRM_ROOT, resolved) || resolved === CRM_ROOT) {
      throw new SafeError('Configured storage must stay inside the local CRM directory.');
    }
    const parts = path.relative(CRM_ROOT, resolved).split(path.sep);
    if (parts.some((part) => ['imports', 'load-harness'].includes(part.toLowerCase()))) {
      throw new SafeError('Transient import and load-harness storage is excluded from this backup.');
    }
    if (inside(PRIVATE_ROOT, resolved) || inside(resolved, PRIVATE_ROOT)) {
      throw new SafeError('Private verification output cannot also be a backup source.');
    }
    return { category, root: resolved };
  });
}

function assertNonOverlappingSources(sources) {
  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      if (inside(sources[i].root, sources[j].root) || inside(sources[j].root, sources[i].root)) {
        throw new SafeError('Configured backup source directories overlap.');
      }
    }
  }
}

function statStamp(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    sizeBytes: info.size,
    mode: info.mode & FILE_MODE_MASK,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameStamp(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.sizeBytes === right.sizeBytes
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertSafeFileMode(mode) {
  if ((mode & 0o077) !== 0 || (mode & 0o7000) !== 0 || (mode & 0o400) === 0 || (mode & 0o111) !== 0) {
    throw new SafeError('A selected source file has unsafe permissions; verification stopped.');
  }
}

function validateSourceFile(category, relativePath, sizeBytes, mode) {
  const components = relativePath.split('/');
  if (!components.length || components.some((part) => !SAFE_COMPONENT.test(part) || part === '.' || part === '..')) {
    throw new SafeError('An unsafe name was found in a selected source; verification stopped.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_FILE_BYTES) {
    throw new SafeError('A selected source file exceeds the supported size; verification stopped.');
  }
  assertSafeFileMode(mode);
  const baseName = components.at(-1);
  if (category === 'documents' || category === 'reports') {
    if (!UUID_BLOB.test(baseName)) throw new SafeError('An unexpected file was found in document or report storage.');
  } else if (components.length !== 1 || !['cms.json', 'lms.json'].includes(baseName)) {
    throw new SafeError('An unexpected file was found in mock state storage.');
  }
}

async function sourceRootExistsWithoutSymlinks(root) {
  const relative = path.relative(CRM_ROOT, root);
  let cursor = CRM_ROOT;
  const rootInfo = await lstat(CRM_ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SafeError('The CRM source root is not a real directory.');
  for (const component of relative.split(path.sep)) {
    if (!component) continue;
    cursor = path.join(cursor, component);
    let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new SafeError('A backup source path could not be inspected safely.');
    }
    if (info.isSymbolicLink()) throw new SafeError('A backup source contains a symbolic link; verification stopped.');
    if (cursor !== root && !info.isDirectory()) throw new SafeError('A backup source path contains a non-directory entry.');
    if (cursor === root && !info.isDirectory()) throw new SafeError('A backup source is not a directory.');
  }
  return true;
}

async function inspectSourceTree(source) {
  const exists = await sourceRootExistsWithoutSymlinks(source.root);
  if (!exists) return { category: source.category, root: source.root, present: false, directories: [], files: [] };
  const rootInfo = await lstat(source.root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SafeError('A backup source is not a real directory.');
  const result = {
    category: source.category,
    root: source.root,
    present: true,
    directories: [{ path: source.category, sourceMode: rootInfo.mode & FILE_MODE_MASK, stamp: statStamp(rootInfo) }],
    files: [],
  };

  async function visit(directory, relativeDirectory, depth) {
    if (depth > MAX_DEPTH) throw new SafeError('A backup source directory is too deeply nested.');
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { throw new SafeError('A backup source directory could not be read safely.'); }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (!SAFE_COMPONENT.test(entry.name) || entry.name === '.' || entry.name === '..') {
        throw new SafeError('An unsafe name was found in a selected source; verification stopped.');
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      let info;
      try { info = await lstat(fullPath); }
      catch { throw new SafeError('A selected source entry changed while it was being inspected.'); }
      if (info.isSymbolicLink()) throw new SafeError('A backup source contains a symbolic link; verification stopped.');
      if (info.isDirectory()) {
        if (source.category === 'mock-state') throw new SafeError('Mock state must contain only its two top-level state files.');
        result.directories.push({
          path: `${source.category}/${relativePath}`,
          sourceMode: info.mode & FILE_MODE_MASK,
          stamp: statStamp(info),
        });
        await visit(fullPath, relativePath, depth + 1);
      } else if (info.isFile()) {
        const fullRelativePath = `${source.category}/${relativePath}`;
        validateSourceFile(source.category, relativePath, info.size, info.mode & FILE_MODE_MASK);
        result.files.push({
          category: source.category,
          path: fullRelativePath,
          sourcePath: fullPath,
          sourceStamp: statStamp(info),
        });
      } else {
        throw new SafeError('A selected source contains a non-regular file; verification stopped.');
      }
      if (result.files.length + result.directories.length > MAX_ENTRIES) {
        throw new SafeError('A selected source contains too many entries.');
      }
    }
  }

  await visit(source.root, '', 0);
  return result;
}

async function openPrivateDirectory(directory, { create = true, setPrivateMode = true } = {}) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SafeError('Private backup directory is not a real directory.');
    if (setPrivateMode) await chmod(directory, PRIVATE_DIR_MODE);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (error?.code !== 'ENOENT' || !create) throw new SafeError('Private backup directory is unavailable.');
    await mkdir(directory, { mode: PRIVATE_DIR_MODE });
    if (setPrivateMode) await chmod(directory, PRIVATE_DIR_MODE);
  }
}

async function preparePrivateBackupRoot() {
  await openPrivateDirectory(AGENT_ROOT, { setPrivateMode: false });
  await openPrivateDirectory(PRIVATE_ROOT);
  await openPrivateDirectory(BACKUP_ROOT);
}

async function ensureDestinationParents(root, relativePath, directories) {
  const components = relativePath.split('/');
  let current = root;
  for (let index = 0; index < components.length - 1; index += 1) {
    current = path.join(current, components[index]);
    if (directories.has(current)) continue;
    try { await mkdir(current, { mode: PRIVATE_DIR_MODE }); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw new SafeError('A private restore directory could not be created.');
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new SafeError('A private restore path is unsafe.');
    }
    await chmod(current, PRIVATE_DIR_MODE);
    directories.add(current);
  }
}

async function copyFileAndHash(sourcePath, targetPath, expectedStamp, expectedMode) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let sourceHandle;
  let targetHandle;
  try {
    sourceHandle = await open(sourcePath, constants.O_RDONLY | noFollow);
    const before = statStamp(await sourceHandle.stat());
    if (!sameStamp(expectedStamp, before)) throw new SafeError('A backup source changed during verification.');
    if (before.sizeBytes > MAX_FILE_BYTES) throw new SafeError('A selected source file exceeds the supported size.');
    assertSafeFileMode(before.mode);
    targetHandle = await open(targetPath, 'wx', PRIVATE_FILE_MODE);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let sizeBytes = 0;
    for (;;) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      sizeBytes += bytesRead;
      if (sizeBytes > MAX_FILE_BYTES) throw new SafeError('A selected source file exceeds the supported size.');
      hash.update(buffer.subarray(0, bytesRead));
      const { bytesWritten } = await targetHandle.write(buffer, 0, bytesRead, null);
      if (bytesWritten !== bytesRead) throw new SafeError('A private backup file could not be written completely.');
    }
    await targetHandle.sync();
    await targetHandle.chmod(expectedMode);
    const after = statStamp(await sourceHandle.stat());
    const targetInfo = await targetHandle.stat();
    if (!sameStamp(before, after) || sizeBytes !== before.sizeBytes) {
      throw new SafeError('A backup source changed while it was being copied.');
    }
    const mode = targetInfo.mode & FILE_MODE_MASK;
    if (targetInfo.size !== sizeBytes || mode !== expectedMode || (mode & 0o077) !== 0) {
      throw new SafeError('Private backup file size or permissions could not be verified.');
    }
    return { sizeBytes, mode, sha256: hash.digest('hex'), sourceStamp: after };
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('A selected file could not be copied or verified safely.');
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

async function hashSourceFile(file) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(file.sourcePath, constants.O_RDONLY | noFollow);
    const before = statStamp(await handle.stat());
    if (!sameStamp(file.sourceStamp, before)) throw new SafeError('A backup source changed during verification.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let sizeBytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      sizeBytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = statStamp(await handle.stat());
    if (!sameStamp(before, after) || sizeBytes !== before.sizeBytes) throw new SafeError('A backup source changed during verification.');
    return { sizeBytes, mode: before.mode, sha256: hash.digest('hex'), sourceStamp: after };
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('A source file could not be read safely.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function copySourceTree(tree, dataRoot, manifest) {
  if (!tree.present) return;
  const destinationPaths = new Set();
  for (const directory of [...tree.directories].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    let target = dataRoot;
    for (const component of directory.path.split('/')) {
      target = path.join(target, component);
      if (!destinationPaths.has(target)) {
        await mkdir(target, { mode: PRIVATE_DIR_MODE });
        await chmod(target, PRIVATE_DIR_MODE);
        destinationPaths.add(target);
      }
    }
    manifest.directories.push({ path: directory.path, sourceMode: directory.sourceMode, mode: PRIVATE_DIR_MODE });
  }
  for (const file of tree.files) {
    const target = path.join(dataRoot, ...file.path.split('/'));
    await ensureDestinationParents(dataRoot, file.path, destinationPaths);
    const copied = await copyFileAndHash(file.sourcePath, target, file.sourceStamp, file.sourceStamp.mode);
    manifest.files.push({
      category: file.category,
      path: file.path,
      sizeBytes: copied.sizeBytes,
      sourceMode: file.sourceStamp.mode,
      mode: copied.mode,
      sha256: copied.sha256,
    });
  }
}

function safeManifestPath(value, isDirectory) {
  if (typeof value !== 'string' || value.length > 1024) throw new SafeError('The private manifest is invalid.');
  const components = value.split('/');
  if (components.length < 1 || components.some((part) => !SAFE_COMPONENT.test(part) || part === '.' || part === '..')) {
    throw new SafeError('The private manifest is invalid.');
  }
  if (!CATEGORIES.has(components[0])) throw new SafeError('The private manifest is invalid.');
  if (!isDirectory) {
    const category = components[0];
    const name = components.at(-1);
    if ((category === 'documents' || category === 'reports') ? !UUID_BLOB.test(name) : (components.length !== 2 || !['cms.json', 'lms.json'].includes(name))) {
      throw new SafeError('The private manifest is invalid.');
    }
  }
  return components.join('/');
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.directories) || !Array.isArray(manifest.files)) {
    throw new SafeError('The private manifest is invalid.');
  }
  const directories = new Map();
  for (const item of manifest.directories) {
    const entryPath = safeManifestPath(item?.path, true);
    if (directories.has(entryPath) || !Number.isInteger(item.sourceMode) || item.sourceMode < 0 || item.sourceMode > FILE_MODE_MASK
      || !Number.isInteger(item.mode) || item.mode !== PRIVATE_DIR_MODE) {
      throw new SafeError('The private manifest is invalid.');
    }
    directories.set(entryPath, item);
  }
  const files = new Map();
  for (const item of manifest.files) {
    const entryPath = safeManifestPath(item?.path, false);
    if (!CATEGORIES.has(item.category) || !entryPath.startsWith(`${item.category}/`)
      || files.has(entryPath) || directories.has(entryPath)
      || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > MAX_FILE_BYTES
      || !Number.isInteger(item.sourceMode) || !Number.isInteger(item.mode) || item.mode !== item.sourceMode
      || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new SafeError('The private manifest is invalid.');
    }
    assertSafeFileMode(item.mode);
    files.set(entryPath, item);
  }
  const totalBytes = [...files.values()].reduce((sum, item) => sum + item.sizeBytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new SafeError('The private manifest is invalid.');
  for (const entryPath of [...directories.keys(), ...files.keys()]) {
    const components = entryPath.split('/');
    for (let index = 1; index < components.length; index += 1) {
      const parent = components.slice(0, index).join('/');
      if (!directories.has(parent)) throw new SafeError('The private manifest is invalid.');
    }
  }
  if (directories.size + files.size > MAX_ENTRIES) throw new SafeError('The private manifest is invalid.');
  return { directories, files };
}

async function scanPrivateTree(dataRoot, expected) {
  const actualDirectories = new Map();
  const actualFiles = new Map();
  const rootInfo = await lstat(dataRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & FILE_MODE_MASK) !== PRIVATE_DIR_MODE) {
    throw new SafeError('A private verification directory has unsafe permissions.');
  }
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (!SAFE_COMPONENT.test(entry.name) || entry.name === '.' || entry.name === '..') throw new SafeError('A private verification tree contains an unsafe name.');
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      safeManifestPath(relativePath, entry.isDirectory());
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new SafeError('A private verification tree contains a symbolic link.');
      if (info.isDirectory()) {
        if ((info.mode & FILE_MODE_MASK) !== PRIVATE_DIR_MODE) throw new SafeError('A private verification directory has unsafe permissions.');
        actualDirectories.set(relativePath, { path: relativePath, mode: info.mode & FILE_MODE_MASK });
        await visit(fullPath, relativePath);
      } else if (info.isFile()) {
        assertSafeFileMode(info.mode & FILE_MODE_MASK);
        const hash = createHash('sha256');
        let sizeBytes = 0;
        const handle = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = statStamp(await handle.stat());
          if (before.ino !== String(info.ino) || before.dev !== String(info.dev) || before.sizeBytes !== info.size) {
            throw new SafeError('A private verification file changed during inspection.');
          }
          const buffer = Buffer.allocUnsafe(128 * 1024);
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            sizeBytes += bytesRead;
            hash.update(buffer.subarray(0, bytesRead));
          }
          const after = statStamp(await handle.stat());
          if (!sameStamp(before, after) || sizeBytes !== before.sizeBytes) throw new SafeError('A private verification file changed during inspection.');
          actualFiles.set(relativePath, { path: relativePath, sizeBytes, mode: after.mode, sha256: hash.digest('hex') });
        } finally { await handle.close().catch(() => undefined); }
      } else {
        throw new SafeError('A private verification tree contains a non-regular entry.');
      }
    }
  }
  await visit(dataRoot, '');
  if (actualDirectories.size !== expected.directories.size || actualFiles.size !== expected.files.size) {
    throw new SafeError('The private backup and restore trees do not match the manifest.');
  }
  for (const [entryPath, item] of expected.directories) {
    const actual = actualDirectories.get(entryPath);
    if (!actual || actual.mode !== item.mode) throw new SafeError('A private directory did not match the manifest.');
  }
  for (const [entryPath, item] of expected.files) {
    const actual = actualFiles.get(entryPath);
    if (!actual || actual.sizeBytes !== item.sizeBytes || actual.mode !== item.mode || actual.sha256 !== item.sha256) {
      throw new SafeError('A private file did not match the manifest.');
    }
  }
  return { fileCount: actualFiles.size, directoryCount: actualDirectories.size, totalBytes: [...actualFiles.values()].reduce((sum, item) => sum + item.sizeBytes, 0) };
}

async function writePrivateManifest(filename, manifest) {
  let handle;
  try {
    handle = await open(filename, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(PRIVATE_FILE_MODE);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || (info.mode & FILE_MODE_MASK) !== PRIVATE_FILE_MODE) {
      throw new SafeError('The private manifest could not be secured.');
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('The private manifest could not be written safely.');
  } finally { await handle?.close().catch(() => undefined); }
}

async function readPrivateManifest(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & FILE_MODE_MASK) !== PRIVATE_FILE_MODE || info.size > 32 * 1024 * 1024) {
      throw new SafeError('The private manifest is unsafe.');
    }
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('The private manifest could not be read safely.');
  }
}

async function restoreFromBackup(backupData, restoreData, validated) {
  await mkdir(restoreData, { mode: PRIVATE_DIR_MODE });
  await chmod(restoreData, PRIVATE_DIR_MODE);
  const createdDirectories = new Set([restoreData]);
  for (const directory of [...validated.directories.values()].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    let target = restoreData;
    for (const component of directory.path.split('/')) {
      target = path.join(target, component);
      if (!createdDirectories.has(target)) {
        await mkdir(target, { mode: PRIVATE_DIR_MODE });
        await chmod(target, PRIVATE_DIR_MODE);
        createdDirectories.add(target);
      }
    }
  }
  let totalBytes = 0;
  for (const file of validated.files.values()) {
    totalBytes += file.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new SafeError('The private backup exceeds the supported total size.');
    const source = path.join(backupData, ...file.path.split('/'));
    const target = path.join(restoreData, ...file.path.split('/'));
    await ensureDestinationParents(restoreData, file.path, createdDirectories);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.sizeBytes || (info.mode & FILE_MODE_MASK) !== file.mode) {
      throw new SafeError('A private backup file does not match its manifest.');
    }
    const copied = await copyFileAndHash(source, target, statStamp(info), file.mode);
    if (copied.sizeBytes !== file.sizeBytes || copied.sha256 !== file.sha256 || copied.mode !== file.mode) {
      throw new SafeError('A restored private file does not match its manifest.');
    }
  }
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--help' && arg !== '-h')) throw new SafeError('This script accepts only --help.');
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Verify private backups of local CRM documents, report exports, and CMS/LMS mock state.\nnode scripts/verify-file-backup-restore.mjs\n');
    return;
  }

  const sources = sourceDefinitions();
  assertNonOverlappingSources(sources);
  const trees = [];
  for (const source of sources) trees.push(await inspectSourceTree(source));

  let totalBytes = 0;
  const totalEntries = trees.reduce((count, tree) => count + tree.files.length + tree.directories.length, 0);
  if (totalEntries > MAX_ENTRIES) throw new SafeError('The selected sources contain too many entries.');
  for (const tree of trees) {
    for (const file of tree.files) {
      totalBytes += file.sourceStamp.sizeBytes;
      if (totalBytes > MAX_TOTAL_BYTES) throw new SafeError('The selected sources exceed the supported total size.');
    }
  }
  totalBytes = 0;
  const manifest = { version: 1, createdAt: new Date().toISOString(), directories: [], files: [] };
  await preparePrivateBackupRoot();
  const snapshotId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const snapshotDirectory = path.join(BACKUP_ROOT, snapshotId);
  await mkdir(snapshotDirectory, { mode: PRIVATE_DIR_MODE });
  await chmod(snapshotDirectory, PRIVATE_DIR_MODE);
  const backupDirectory = path.join(snapshotDirectory, 'backup');
  const backupData = path.join(backupDirectory, 'data');
  const restoreDirectory = path.join(snapshotDirectory, 'restore');
  const restoreData = path.join(restoreDirectory, 'data');
  await mkdir(backupDirectory, { mode: PRIVATE_DIR_MODE });
  await chmod(backupDirectory, PRIVATE_DIR_MODE);
  await mkdir(backupData, { mode: PRIVATE_DIR_MODE });
  await chmod(backupData, PRIVATE_DIR_MODE);
  await mkdir(restoreDirectory, { mode: PRIVATE_DIR_MODE });
  await chmod(restoreDirectory, PRIVATE_DIR_MODE);

  for (const tree of trees) await copySourceTree(tree, backupData, manifest);
  manifest.directories.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  manifest.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const file of manifest.files) {
    totalBytes += file.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new SafeError('The selected sources exceed the supported total size.');
  }
  const manifestPath = path.join(backupDirectory, 'manifest.json');
  await writePrivateManifest(manifestPath, manifest);

  for (let index = 0; index < sources.length; index += 1) {
    const current = await inspectSourceTree(sources[index]);
    const captured = trees[index];
    if (current.present !== captured.present
      || JSON.stringify(current.directories.map(({ path: entryPath, sourceMode, stamp }) => ({ path: entryPath, sourceMode, stamp })) )
        !== JSON.stringify(captured.directories.map(({ path: entryPath, sourceMode, stamp }) => ({ path: entryPath, sourceMode, stamp })))) {
      throw new SafeError('A backup source changed while the snapshot was being created.');
    }
    if (current.files.length !== captured.files.length) throw new SafeError('A backup source changed while the snapshot was being created.');
    for (let fileIndex = 0; fileIndex < current.files.length; fileIndex += 1) {
      const before = captured.files[fileIndex];
      const after = current.files[fileIndex];
      if (before.path !== after.path || !sameStamp(before.sourceStamp, after.sourceStamp)) {
        throw new SafeError('A backup source changed while the snapshot was being created.');
      }
      const digest = await hashSourceFile(after);
      const saved = manifest.files.find((item) => item.path === before.path);
      if (!saved || digest.sizeBytes !== saved.sizeBytes || digest.mode !== saved.sourceMode || digest.sha256 !== saved.sha256) {
        throw new SafeError('A backup source changed while the snapshot was being created.');
      }
    }
  }

  const privateManifest = await readPrivateManifest(manifestPath);
  const validated = validateManifest(privateManifest);
  const backupIntegrity = await scanPrivateTree(backupData, validated);
  await restoreFromBackup(backupData, restoreData, validated);
  const restoreIntegrity = await scanPrivateTree(restoreData, validated);
  if (backupIntegrity.fileCount !== restoreIntegrity.fileCount || backupIntegrity.directoryCount !== restoreIntegrity.directoryCount
    || backupIntegrity.totalBytes !== restoreIntegrity.totalBytes) {
    throw new SafeError('The restored file tree does not match the backup.');
  }

  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    snapshotId,
    backup: path.relative(REPO_ROOT, backupDirectory),
    restoredTestCopy: path.relative(REPO_ROOT, restoreData),
    categories: sources.map((source) => ({ category: source.category, files: manifest.files.filter((item) => item.category === source.category).length })),
    fileCount: restoreIntegrity.fileCount,
    directoryCount: restoreIntegrity.directoryCount,
    totalBytes: restoreIntegrity.totalBytes,
    privateDirectoryMode: '0700',
    privateFileModesVerified: true,
  }, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof SafeError ? error.message : 'File backup/restore verification failed; file contents and secrets were not logged.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
