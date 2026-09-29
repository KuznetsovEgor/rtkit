#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateMetadataSnapshot, verifyPrivateBlobConsistency } from './verify-private-blobs.mjs';

const CRM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_PREFIX = 'lct-crm-joint-fixture-';
const FIXTURE_USER = 'lct_fixture';
const FIXTURE_DB = 'fixture_source';
const RESTORED_DB = 'fixture_restore';
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class SafeError extends Error {}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: CRM_ROOT,
      env: options.env ?? cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-2000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', () => reject(new SafeError(`${path.basename(command)} is unavailable.`)));
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new SafeError(`${path.basename(command)} failed${options.label ? ` (${options.label})` : ''}: ${stderr.trim().slice(0, 1000)}`));
    });
  });
}

function exitStatus(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: CRM_ROOT, env: cleanEnvironment(), stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function locateTool(name) {
  const homebrew = `/opt/homebrew/opt/postgresql@18/bin/${name}`;
  try { await access(homebrew, constants.X_OK); return homebrew; }
  catch { /* Search PATH below; executable validation happens when run. */ }
  const result = await run('which', [name]);
  const selected = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!selected || !path.isAbsolute(selected)) throw new SafeError(`Could not locate ${name}.`);
  return selected;
}

async function toolMajor(command) {
  const result = await run(command, ['--version']);
  const major = result.stdout.match(/\b(?:PostgreSQL\)\s*)?(\d+)(?:\.\d+)?/i)?.[1];
  if (!major) throw new SafeError(`Could not determine ${path.basename(command)} version.`);
  return Number(major);
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
  return { ...env, LC_ALL: 'C', LANG: 'C' };
}

async function makePrivateDirectory(directory) {
  await mkdir(directory, { mode: PRIVATE_DIR_MODE });
  await chmod(directory, PRIVATE_DIR_MODE);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new SafeError('The temporary fixture directory is not private.');
  }
}

async function writePrivateFile(filename, bytes) {
  const handle = await open(filename, 'wx', PRIVATE_FILE_MODE);
  try { await handle.writeFile(bytes); }
  finally { await handle.close(); }
  await chmod(filename, PRIVATE_FILE_MODE);
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function makeBlob(root, key, text) {
  if (!SAFE_UUID.test(key)) throw new SafeError('Generated fixture key is invalid.');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) throw new SafeError('Synthetic fixture blobs must be non-empty.');
  await writePrivateFile(path.join(root, `${key}.blob`), bytes);
  return { key, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function databaseUrlEnvironment(socketDirectory, database) {
  return {
    ...cleanEnvironment(),
    PGHOST: socketDirectory,
    PGPORT: '5432',
    PGUSER: FIXTURE_USER,
    PGDATABASE: database,
    PGPASSFILE: '/dev/null',
    PGSSLMODE: 'disable',
    PGTZ: 'UTC',
    PGAPPNAME: 'crm-joint-fixture-verification',
  };
}

async function connect(socketDirectory, database) {
  const client = new pg.Client({
    host: socketDirectory,
    port: 5432,
    user: FIXTURE_USER,
    database,
    ssl: false,
    application_name: 'crm-joint-fixture-verification',
    options: '-c timezone=UTC',
  });
  await client.connect();
  return client;
}

async function createFixture(sourceClient, documents, reports) {
  await sourceClient.query(`
    CREATE TABLE activity_documents (
      id uuid PRIMARY KEY,
      object_key uuid NOT NULL UNIQUE,
      size_bytes bigint NOT NULL CHECK (size_bytes > 0),
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$')
    );
    CREATE TABLE report_jobs (
      id uuid PRIMARY KEY,
      job_type text NOT NULL,
      file_key uuid UNIQUE,
      file_size bigint,
      file_sha256 text,
      status text NOT NULL,
      expires_at timestamptz NOT NULL
    );
  `);
  for (const item of documents) {
    await sourceClient.query('INSERT INTO activity_documents (id, object_key, size_bytes, sha256) VALUES ($1,$2,$3,$4)',
      [randomUUID(), item.key, item.sizeBytes, item.sha256]);
  }
  for (const item of reports) {
    await sourceClient.query(`INSERT INTO report_jobs (id,job_type,file_key,file_size,file_sha256,status,expires_at)
      VALUES ($1,'export',$2,$3,$4,'completed',now()-interval '1 day')`,
    [randomUUID(), item.key, item.sizeBytes, item.sha256]);
  }
  // A completed row with no file key is deliberately invalid and must fail closed.
  const missingMetadata = await sourceClient.query(`
    SELECT count(*)::int AS count FROM report_jobs
    WHERE job_type='export' AND status='completed'
      AND (file_key IS NULL OR file_size IS NULL OR file_sha256 IS NULL)
  `);
  if (missingMetadata.rows[0].count !== 0) throw new SafeError('Synthetic report metadata is incomplete.');
}

async function metadataSnapshot(client) {
  const documents = await client.query(`
    SELECT object_key::text AS key, size_bytes::bigint AS "sizeBytes", sha256
    FROM activity_documents ORDER BY object_key::text COLLATE "C"
  `);
  const reports = await client.query(`
    SELECT file_key::text AS key, file_size::bigint AS "sizeBytes", file_sha256 AS sha256
    FROM report_jobs WHERE job_type='export' AND status='completed'
    ORDER BY file_key::text COLLATE "C"
  `);
  for (const row of [...documents.rows, ...reports.rows]) row.sizeBytes = Number(row.sizeBytes);
  const snapshot = { schemaVersion: 1, documents: documents.rows, reports: reports.rows };
  validateMetadataSnapshot(snapshot);
  return snapshot;
}

async function copyBlob(source, destination, expected) {
  if (NO_FOLLOW === 0) throw new SafeError('This platform cannot open fixture files without following symbolic links.');
  let input;
  let output;
  try {
    input = await open(source, constants.O_RDONLY | NO_FOLLOW);
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || Number(before.size) !== expected.sizeBytes || (before.mode & 0o7111n) !== 0n) {
      throw new SafeError('A synthetic fixture blob has an unsafe type, size, or mode.');
    }
    output = await open(destination, 'wx', PRIVATE_FILE_MODE);
    const hash = createHash('sha256');
    const chunks = [];
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      chunks.push(chunk);
    }
    const after = await input.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || hash.digest('hex') !== expected.sha256) {
      throw new SafeError('A synthetic fixture blob changed during the snapshot.');
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== expected.sizeBytes) throw new SafeError('A synthetic fixture blob changed during the snapshot.');
    await output.writeFile(bytes);
  } finally {
    await input?.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
  }
}

async function copyFixtureTrees(source, destination, snapshot) {
  for (const category of ['documents', 'reports']) {
    const sourceRoot = path.join(source, category);
    const destinationRoot = path.join(destination, category);
    await makePrivateDirectory(destinationRoot);
    for (const record of snapshot[category]) {
      const file = `${record.key}.blob`;
      await copyBlob(path.join(sourceRoot, file), path.join(destinationRoot, file), record);
    }
  }
}

async function restoreSnapshot(databaseTool, socketDirectory, dumpPath) {
  const admin = await connect(socketDirectory, 'postgres');
  try {
    await admin.query(`CREATE DATABASE "${RESTORED_DB}"`);
  } finally { await admin.end(); }
  await run(databaseTool, [
    '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges',
    '--dbname', RESTORED_DB, dumpPath,
  ], { env: databaseUrlEnvironment(socketDirectory, RESTORED_DB), label: 'restore synthetic fixture' });
}

async function verifySnapshotMatchesFiles(snapshot, roots) {
  const result = await verifyPrivateBlobConsistency(snapshot, roots);
  const categories = [result.documents, result.reports];
  const issues = categories.map((item) => item.missingBlobCount + item.orphanBlobCount + item.sizeMismatchCount
    + item.checksumMismatchCount + item.unsafeEntryCount + item.unsafePermissionCount
    + item.unreadableOrChangedCount + item.invalidBlobNameCount);
  if (!result.ok) throw new SafeError(`Metadata-to-blob verification failed (${categories.map((item, index) => `${item.category}:${issues[index]}`).join(', ')}).`);
  return categories.map(({ category, metadataCount, blobCount }) => ({
    category,
    metadataCount,
    blobCount,
    totalBytes: snapshot[category].reduce((sum, item) => sum + item.sizeBytes, 0),
  }));
}

async function removeOwnedFixture(root, tempBase, dataDirectory, pgCtl) {
  if (!root || !root.startsWith(path.join(tempBase, TEMP_PREFIX))) return false;
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo) return true;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
  if (dataDirectory && pgCtl) {
    try { await run(pgCtl, ['-D', dataDirectory, '-m', 'fast', '-w', 'stop']); }
    catch {
      try { await run(pgCtl, ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop']); }
      catch {
        // pg_ctl returns 3 only when the cluster is confirmed not running.
        if (await exitStatus(pgCtl, ['-D', dataDirectory, 'status']).catch(() => null) !== 3) return false;
      }
    }
  }
  await rm(root, { recursive: true, force: true });
  return true;
}

function usage() {
  return [
    'Create a private synthetic PostgreSQL + blob fixture, back it up, restore it separately, and verify metadata-to-blob links.',
    'The temporary PostgreSQL server uses a private Unix socket with TCP disabled. No CRM database or configured storage is read.',
    'Usage: node scripts/verify-joint-fixture-backup-restore.mjs',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--help' && arg !== '-h')) throw new SafeError('This script accepts only --help.');
  if (args.length) { process.stdout.write(`${usage()}\n`); return; }
  if (NO_FOLLOW === 0) throw new SafeError('This platform cannot safely inspect fixture files without following symbolic links.');
  process.umask(0o077);

  const [initdb, pgCtl, pgDump, pgRestore, postgres] = await Promise.all([
    locateTool('initdb'), locateTool('pg_ctl'), locateTool('pg_dump'), locateTool('pg_restore'), locateTool('postgres'),
  ]);
  const versions = await Promise.all([initdb, pgCtl, pgDump, pgRestore, postgres].map(toolMajor));
  if (new Set(versions).size !== 1) throw new SafeError('PostgreSQL fixture tools must come from one matching installation.');

  // macOS's default TMPDIR is too long for PostgreSQL's Unix-domain socket path.
  const tempBase = await realpath('/private/tmp');
  const tempRoot = await mkdtemp(path.join(tempBase, TEMP_PREFIX));
  await chmod(tempRoot, PRIVATE_DIR_MODE);
  const dataDirectory = path.join(tempRoot, 'database');
  const socketDirectory = path.join(tempRoot, 'socket');
  const sourceRoot = path.join(tempRoot, 'source');
  const snapshotDirectory = path.join(tempRoot, 'snapshot');
  const restoredRoot = path.join(tempRoot, 'restored');
  const logPath = path.join(tempRoot, 'postgres.log');
  let databaseStarted = false;
  let sourceClient;
  let restoredClient;
  let outcome;
  try {
    await Promise.all([makePrivateDirectory(socketDirectory), makePrivateDirectory(sourceRoot), makePrivateDirectory(snapshotDirectory), makePrivateDirectory(restoredRoot)]);
    await Promise.all(['documents', 'reports'].map((category) => makePrivateDirectory(path.join(sourceRoot, category))));
    await run(initdb, ['-D', dataDirectory, '-U', FIXTURE_USER, '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=reject', '--no-sync',
      '-c', 'shared_memory_type=mmap', '-c', 'dynamic_shared_memory_type=mmap']);
    await chmod(dataDirectory, PRIVATE_DIR_MODE);
    await writeFile(path.join(dataDirectory, 'postgresql.conf'), [
      "listen_addresses = ''",
      `unix_socket_directories = '${socketDirectory}'`,
      'unix_socket_permissions = 0700',
      'port = 5432',
      'ssl = off',
      'fsync = off',
      'synchronous_commit = off',
      'full_page_writes = off',
      'logging_collector = off',
      'max_connections = 10',
      '',
    ].join('\n'), { mode: PRIVATE_FILE_MODE });
    await chmod(path.join(dataDirectory, 'postgresql.conf'), PRIVATE_FILE_MODE);
    // A failed readiness check can still leave a child process behind, so cleanup treats start as attempted before launching it.
    databaseStarted = true;
    await run(pgCtl, ['-D', dataDirectory, '-l', logPath, '-w', 'start']);

    const admin = await connect(socketDirectory, 'postgres');
    try {
      const address = await admin.query('SELECT inet_server_addr() AS address, inet_server_port() AS port');
      if (address.rows[0].address !== null || address.rows[0].port !== null) throw new SafeError('The synthetic fixture server unexpectedly accepted a TCP connection.');
      await admin.query(`CREATE DATABASE "${FIXTURE_DB}"`);
    } finally { await admin.end(); }

    const documents = [
      await makeBlob(path.join(sourceRoot, 'documents'), randomUUID(), 'synthetic contract fixture\n'),
      await makeBlob(path.join(sourceRoot, 'documents'), randomUUID(), 'synthetic activity attachment\n'),
    ];
    const reports = [await makeBlob(path.join(sourceRoot, 'reports'), randomUUID(), 'synthetic generated report\n')];
    sourceClient = await connect(socketDirectory, FIXTURE_DB);
    await createFixture(sourceClient, documents, reports);

    // No writer remains after seeding; SHARE locks also block any accidental fixture update while both copies are captured.
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await sourceClient.query('LOCK TABLE activity_documents, report_jobs IN SHARE MODE');
    const exported = await sourceClient.query('SELECT pg_export_snapshot() AS snapshot_id');
    const sourceSnapshot = await metadataSnapshot(sourceClient);
    const sourceChecks = await verifySnapshotMatchesFiles(sourceSnapshot, {
      documentRoot: path.join(sourceRoot, 'documents'),
      reportRoot: path.join(sourceRoot, 'reports'),
    });
    const dumpPath = path.join(snapshotDirectory, 'database.dump');
    await run(pgDump, [
      '--format=custom', '--no-owner', '--no-acl', '--snapshot', exported.rows[0].snapshot_id,
      '--file', dumpPath, '--dbname', FIXTURE_DB,
    ], { env: databaseUrlEnvironment(socketDirectory, FIXTURE_DB), label: 'snapshot synthetic fixture' });
    const dumpInfo = await stat(dumpPath);
    if (dumpInfo.size < 1 || (dumpInfo.mode & 0o077) !== 0) throw new SafeError('The database fixture backup is empty or not private.');
    await copyFixtureTrees(sourceRoot, snapshotDirectory, sourceSnapshot);
    await sourceClient.query('COMMIT');
    await sourceClient.end();
    sourceClient = undefined;

    const backupChecks = await verifySnapshotMatchesFiles(sourceSnapshot, {
      documentRoot: path.join(snapshotDirectory, 'documents'),
      reportRoot: path.join(snapshotDirectory, 'reports'),
    });
    await restoreSnapshot(pgRestore, socketDirectory, dumpPath);
    await copyFixtureTrees(snapshotDirectory, restoredRoot, sourceSnapshot);
    restoredClient = await connect(socketDirectory, RESTORED_DB);
    const restoredSnapshot = await metadataSnapshot(restoredClient);
    if (!sameJson(sourceSnapshot, restoredSnapshot)) throw new SafeError('Restored metadata does not match the joint fixture snapshot.');
    const restoredChecks = await verifySnapshotMatchesFiles(restoredSnapshot, {
      documentRoot: path.join(restoredRoot, 'documents'),
      reportRoot: path.join(restoredRoot, 'reports'),
    });
    const dumpBytes = await readFile(dumpPath);
    outcome = {
      status: 'verified',
      scope: 'synthetic-fixture-only',
      databaseTransport: 'private-unix-socket; tcp-disabled',
      source: { database: FIXTURE_DB, documents: documents.length, reports: reports.length },
      restored: { database: RESTORED_DB, metadataMatches: true },
      jointSnapshot: {
        databaseDumpBytes: dumpBytes.length,
        databaseDumpSha256: sha256(dumpBytes),
        sourceMatchesBlobs: sourceChecks,
        backupMatchesMetadata: backupChecks,
        restoredMatchesMetadata: restoredChecks,
      },
      cleanedTemporaryFixture: false,
    };
  } finally {
    await restoredClient?.end().catch(() => undefined);
    await sourceClient?.query('ROLLBACK').catch(() => undefined);
    await sourceClient?.end().catch(() => undefined);
    const cleaned = await removeOwnedFixture(tempRoot, tempBase, databaseStarted ? dataDirectory : undefined, databaseStarted ? pgCtl : undefined);
    if (outcome) outcome.cleanedTemporaryFixture = cleaned;
    if (!cleaned) {
      process.stderr.write(`Temporary synthetic fixture kept at ${tempRoot}; PostgreSQL could not be confirmed stopped.\n`);
      throw new SafeError('The temporary PostgreSQL fixture could not be stopped and cleaned safely.');
    }
  }
  if (outcome) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message.slice(0, 1000) : 'Joint synthetic backup/restore verification failed.'}\n`);
  process.exitCode = 1;
});
