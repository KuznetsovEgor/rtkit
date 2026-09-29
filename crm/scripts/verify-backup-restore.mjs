#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, lstat, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_ROOT = path.resolve(ROOT, '..', '.agent', 'private');
const SOURCE_DB = 'lctcrm_load';
const SOURCE_MARKER = 'lct CRM local load harness v1';
const RESTORE_MARKER = 'lct CRM local backup restore verification v1';
const DB_HOST = '127.0.0.1';
const DB_PORT = 54329;
const DB_USER = 'lctcrm';
const CRITICAL_TABLES = new Set([
  'schema_migrations', 'activities', 'activity_events', 'tasks', 'people', 'organizations', 'products',
  'report_jobs', 'report_snapshot_rows', 'exchange_jobs', 'exchange_events', 'known_crm_users', 'kam_directory',
]);

class SafeError extends Error {}

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function localPgEnv(password, database) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('PG')) delete environment[name];
  return {
    ...environment,
    PGHOST: DB_HOST,
    PGPORT: String(DB_PORT),
    PGUSER: DB_USER,
    PGDATABASE: database,
    PGPASSWORD: password,
    PGPASSFILE: '/dev/null',
    PGHOSTADDR: '',
    PGSSLMODE: 'disable',
    PGTZ: 'UTC',
    PGAPPNAME: 'crm-backup-restore-verification',
  };
}

function runTool(command, args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000); });
    child.once('error', () => reject(new SafeError(`${label} недоступен.`)));
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new SafeError(`${label} завершился с ошибкой: ${diagnostic.trim().replaceAll(env.PGPASSWORD, '[hidden]').slice(0, 1000)}`)));
  });
}

async function toolMajor(command) {
  const child = spawn(command, ['--version'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', () => reject(new SafeError(`${command} недоступен.`)));
    child.once('exit', resolve);
  });
  if (code !== 0) throw new SafeError(`${command} недоступен.`);
  const major = output.match(/\b(?:PostgreSQL\)\s*)?(\d+)(?:\.\d+)?/i)?.[1];
  if (!major) throw new SafeError(`Не удалось определить версию ${command}.`);
  return Number(major);
}

async function selectPgTool(command) {
  const preferred = `/opt/homebrew/opt/postgresql@18/bin/${command}`;
  try { await access(preferred, constants.X_OK); return preferred; }
  catch { return command; }
}

async function openPrivateDump() {
  const agentRoot = path.resolve(ROOT, '..', '.agent');
  try {
    const rootInfo = await lstat(agentRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SafeError('Служебный каталог backup недоступен безопасно.');
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (error.code !== 'ENOENT') throw new SafeError('Служебный каталог backup недоступен.');
    await mkdir(agentRoot, { mode: 0o700 });
  }
  await mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  const privateInfo = await lstat(PRIVATE_ROOT);
  if (!privateInfo.isDirectory() || privateInfo.isSymbolicLink()) throw new SafeError('Закрытый каталог backup недоступен безопасно.');
  await chmod(PRIVATE_ROOT, 0o700);
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const filename = `lctcrm_load-${stamp}-${randomUUID().slice(0, 8)}.dump`;
  const dumpPath = path.join(PRIVATE_ROOT, filename);
  const handle = await open(dumpPath, 'wx', 0o600);
  await handle.close();
  await chmod(dumpPath, 0o600);
  return { dumpPath, filename };
}

async function dumpSha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function dumpSize(filename) {
  return (await stat(filename)).size;
}

async function getTableNames(client) {
  const result = await client.query(`
    SELECT c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname COLLATE "C"
  `);
  return result.rows.map((row) => row.table_name);
}

async function getPrimaryKeyColumns(client, tableName) {
  const result = await client.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_catalog = tc.constraint_catalog
      AND kcu.constraint_schema = tc.constraint_schema
      AND kcu.constraint_name = tc.constraint_name
      AND kcu.table_name = tc.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'public' AND tc.table_name = $1
    ORDER BY kcu.ordinal_position
  `, [tableName]);
  return result.rows.map((row) => row.column_name);
}

function hashRows(value) { return createHash('sha256').update(value ?? '').digest('hex'); }

async function tableIntegrity(client, tableName) {
  const table = `${quoteIdentifier('public')}.${quoteIdentifier(tableName)}`;
  const records = await client.query(`
    SELECT count(*)::text AS row_count,
      COALESCE(string_agg(md5(row_json::text), '' ORDER BY row_json::text COLLATE "C"), '') AS record_hashes
    FROM (SELECT to_jsonb(t) AS row_json FROM ${table} AS t) AS rows
  `);
  const columns = await getPrimaryKeyColumns(client, tableName);
  let primaryKeysSha256 = null;
  if (columns.length) {
    const keyArray = columns.map((column) => `t.${quoteIdentifier(column)}`).join(', ');
    const keys = await client.query(`
      SELECT COALESCE(string_agg(md5(key_json::text), '' ORDER BY key_json::text COLLATE "C"), '') AS key_hashes
      FROM (SELECT jsonb_build_array(${keyArray}) AS key_json FROM ${table} AS t) AS keys
    `);
    primaryKeysSha256 = hashRows(keys.rows[0].key_hashes);
  }
  return {
    rowCount: Number(records.rows[0].row_count),
    recordsSha256: hashRows(records.rows[0].record_hashes),
    primaryKeyCount: columns.length ? Number(records.rows[0].row_count) : null,
    primaryKeysSha256,
  };
}

async function databaseIntegrity(client) {
  await client.query("SET TIME ZONE 'UTC'");
  const tableNames = await getTableNames(client);
  const missing = [...CRITICAL_TABLES].filter((name) => !tableNames.includes(name));
  if (missing.length) throw new SafeError(`В базе отсутствуют обязательные таблицы: ${missing.join(', ')}.`);
  const tables = {};
  for (const tableName of tableNames) tables[tableName] = await tableIntegrity(client, tableName);
  const size = await client.query('SELECT pg_database_size(current_database())::text AS bytes');
  return { sizeBytes: Number(size.rows[0].bytes), tables };
}

function compareIntegrity(source, restored) {
  const sourceNames = Object.keys(source.tables);
  const restoredNames = Object.keys(restored.tables);
  if (JSON.stringify(sourceNames) !== JSON.stringify(restoredNames)) throw new SafeError('После восстановления отличается список публичных таблиц.');
  for (const tableName of sourceNames) {
    if (JSON.stringify(source.tables[tableName]) !== JSON.stringify(restored.tables[tableName])) {
      throw new SafeError(`После восстановления не совпали количество или контрольная сумма таблицы ${tableName}.`);
    }
  }
}

async function connectClient(password, database) {
  const client = new pg.Client({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password,
    database,
    ssl: false,
    application_name: 'crm-backup-restore-verification',
    options: '-c timezone=UTC',
  });
  await client.connect();
  return client;
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--help' && arg !== '-h')) throw new SafeError('Скрипт не принимает параметры подключения.');
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Локальная проверка backup/restore синтетической crm БД.\nnode scripts/verify-backup-restore.mjs\n');
    return;
  }

  let env;
  try { env = parseEnv(await readFile(path.join(ROOT, '.env.local'), 'utf8')); }
  catch { throw new SafeError('Не найден crm/.env.local с локальным паролем PostgreSQL.'); }
  const password = env.POSTGRES_PASSWORD;
  if (!password) throw new SafeError('В crm/.env.local отсутствует локальный пароль PostgreSQL.');

  const [dumpTool, restoreTool] = await Promise.all([selectPgTool('pg_dump'), selectPgTool('pg_restore')]);
  const [dumpMajor, restoreMajor] = await Promise.all([toolMajor(dumpTool), toolMajor(restoreTool)]);
  const admin = await connectClient(password, 'lctcrm');
  let sourceClient;
  let targetClient;
  let restoreDatabase;
  try {
    const sourceMeta = await admin.query(`
      SELECT d.datistemplate, pg_catalog.shobj_description(d.oid, 'pg_database') AS marker
      FROM pg_catalog.pg_database d WHERE d.datname = $1
    `, [SOURCE_DB]);
    if (!sourceMeta.rowCount || sourceMeta.rows[0].datistemplate || sourceMeta.rows[0].marker !== SOURCE_MARKER) {
      throw new SafeError('Источник не подтверждён как синтетическая база lctcrm_load.');
    }

    sourceClient = await connectClient(password, SOURCE_DB);
    const sourceConnection = await sourceClient.query(`
      SELECT current_database() AS database_name, current_user AS user_name,
        inet_server_port() AS server_port, current_setting('server_version_num')::int AS version_num
    `);
    const connection = sourceConnection.rows[0];
    if (connection.database_name !== SOURCE_DB || connection.user_name !== DB_USER || Number(connection.server_port) !== 5432) {
      throw new SafeError('Источник не совпал с локальным PostgreSQL 127.0.0.1:54329.');
    }
    const serverMajor = Math.floor(Number(connection.version_num) / 10000);
    if (dumpMajor < serverMajor || restoreMajor < serverMajor || restoreMajor < dumpMajor) {
      throw new SafeError(`pg_dump/pg_restore должны быть не старше локального PostgreSQL (client ${dumpMajor}/${restoreMajor}, server ${serverMajor}).`);
    }

    const privateDump = await openPrivateDump();
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await sourceClient.query("SET LOCAL TIME ZONE 'UTC'");
    const snapshot = await sourceClient.query('SELECT pg_export_snapshot() AS snapshot_id');
    const source = await databaseIntegrity(sourceClient);
    await runTool(dumpTool, [
      '--format=custom', '--no-owner', '--no-acl', '--snapshot', snapshot.rows[0].snapshot_id,
      '--file', privateDump.dumpPath, '--dbname', SOURCE_DB,
    ], localPgEnv(password, SOURCE_DB), 'pg_dump');
    await sourceClient.query('COMMIT');

    const dumpInfo = await stat(privateDump.dumpPath);
    if (dumpInfo.size === 0 || (dumpInfo.mode & 0o077) !== 0) throw new SafeError('Файл backup пуст или имеет слишком широкие права доступа.');
    const checksum = await dumpSha256(privateDump.dumpPath);

    const stem = `lctcrm_restore_${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    restoreDatabase = stem;
    const existing = await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [restoreDatabase]);
    if (existing.rowCount) throw new SafeError('Уникальное имя новой базы восстановления уже занято; данные не затронуты.');
    await admin.query(`CREATE DATABASE ${quoteIdentifier(restoreDatabase)}`);
    await admin.query(`COMMENT ON DATABASE ${quoteIdentifier(restoreDatabase)} IS '${RESTORE_MARKER}'`);

    await runTool(restoreTool, [
      '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges',
      '--dbname', restoreDatabase, privateDump.dumpPath,
    ], localPgEnv(password, restoreDatabase), 'pg_restore');

    targetClient = await connectClient(password, restoreDatabase);
    const restored = await databaseIntegrity(targetClient);
    compareIntegrity(source, restored);

    const tableCounts = Object.entries(source.tables).map(([name, values]) => ({
      name,
      source: values.rowCount,
      restored: restored.tables[name].rowCount,
    }));
    const criticalIntegrity = {};
    for (const tableName of CRITICAL_TABLES) {
      const original = source.tables[tableName];
      const copy = restored.tables[tableName];
      criticalIntegrity[tableName] = {
        rows: original.rowCount,
        sourceRecordSha256: original.recordsSha256,
        restoredRecordSha256: copy.recordsSha256,
        sourcePrimaryKeySetSha256: original.primaryKeysSha256,
        restoredPrimaryKeySetSha256: copy.primaryKeysSha256,
      };
    }

    process.stdout.write(`${JSON.stringify({
      status: 'verified',
      source: { database: SOURCE_DB, host: DB_HOST, port: DB_PORT, sizeBytes: source.sizeBytes, publicTableCount: tableCounts.length },
      restored: { database: restoreDatabase, sizeBytes: restored.sizeBytes, publicTableCount: tableCounts.length },
      dump: { file: path.relative(path.resolve(ROOT, '..'), privateDump.dumpPath), sizeBytes: dumpInfo.size, sha256: checksum },
      tableCounts,
      criticalIntegrity,
    }, null, 2)}\n`);
  } finally {
    if (targetClient) await targetClient.end().catch(() => undefined);
    if (sourceClient) await sourceClient.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof SafeError ? error.message : 'Проверка backup/restore завершилась ошибкой; данные и секреты не выведены.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
