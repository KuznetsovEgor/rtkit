#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import pg from 'pg';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOAD_DB = 'lctcrm_load';
const DB_MARKER = 'lct CRM local load harness v1';
const KC_REALM = 'lct';
const KC_CLIENT = 'lct-web';
const ACCOUNT_COUNT = 50;
const REPORT_COUNT = 10;
const SEED_PER_USER = 20;
const DB_HOST = '127.0.0.1';
const DB_PORT = 54329;
const API_HOST = '127.0.0.1';
const API_PORT = 3002;
const API_URL = `http://${API_HOST}:${API_PORT}`;
const ACCOUNT_PREFIX = 'load.kam.';
let currentPhase = 'argument validation';

function help() {
  console.log(`Локальная нагрузка CRM. Ничего не запускается без явного флага.

Подготовить отдельную БД lctcrm_load, 50 локальных KAM-сеансов, заполнить синтетический набор и провести прогон:
  node scripts/load-test.mjs --confirm-local-only

Только заполнить и проверить seed-набор, без нагрузки и отчётов:
  node scripts/load-test.mjs --confirm-local-only --seed-only

Параметры:
  --duration-seconds=60     длительность нагрузки (10..600)
  --activities-per-user=20  размер начального набора на пользователя (5..200)
  --seed-only               проверить seed и сохранность после перезапуска API
  --help                    показать справку

Результат печатается одним JSON-объектом. Скрипт не удаляет аккаунты и БД.
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const values = { confirm: args.includes('--confirm-local-only'), seedOnly: args.includes('--seed-only'), durationSeconds: 60, activitiesPerUser: SEED_PER_USER };
  for (const arg of args) {
    const duration = arg.match(/^--duration-seconds=(\d+)$/);
    const activities = arg.match(/^--activities-per-user=(\d+)$/);
    if (duration) values.durationSeconds = Number(duration[1]);
    else if (activities) values.activitiesPerUser = Number(activities[1]);
    else if (!['--confirm-local-only', '--seed-only'].includes(arg)) throw new Error('Неизвестный параметр запуска.');
  }
  if (values.durationSeconds < 10 || values.durationSeconds > 600) throw new Error('Длительность должна быть от 10 до 600 секунд.');
  if (values.activitiesPerUser < 5 || values.activitiesPerUser > 200) throw new Error('Число активностей на пользователя должно быть от 5 до 200.');
  return values;
}

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

async function loadLocalConfig() {
  let fileEnv;
  try { fileEnv = parseEnv(await readFile(path.join(ROOT, '.env.local'), 'utf8')); }
  catch { throw new Error('Не найден crm/.env.local. Сначала один раз запустите локальный стенд, чтобы создать локальные секреты.'); }
  const value = (name) => fileEnv[name] || process.env[name];
  const config = {
    postgresPassword: value('POSTGRES_PASSWORD'),
    adminUser: value('KC_ADMIN_USER'),
    adminPassword: value('KC_ADMIN_PASSWORD'),
    managerPassword: value('MANAGER_PASSWORD'),
    keycloakUrl: value('KEYCLOAK_URL') || 'http://127.0.0.1:18080',
  };
  if (Object.values(config).some((entry) => !entry)) throw new Error('В crm/.env.local отсутствуют нужные локальные секреты PostgreSQL, Keycloak или manager.');
  const kc = new URL(config.keycloakUrl);
  if (kc.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(kc.hostname) || (kc.port && kc.port !== '18080')) {
    throw new Error('Нагрузка разрешена только к локальному Keycloak на порту 18080.');
  }
  config.keycloakUrl = `http://127.0.0.1:18080`;
  config.baseDatabaseUrl = `postgres://lctcrm:${encodeURIComponent(config.postgresPassword)}@${DB_HOST}:${DB_PORT}/lctcrm?application_name=crm-load-harness`;
  config.loadDatabaseUrl = `postgres://lctcrm:${encodeURIComponent(config.postgresPassword)}@${DB_HOST}:${DB_PORT}/${LOAD_DB}?application_name=crm-load-harness`;
  config.issuer = 'http://localhost:18080/realms/lct';
  return config;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonResponse = async (response) => {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { _nonJson: true }; }
};

async function localFetch(url, options = {}, timeoutMs = 30_000) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Запрещён сетевой адрес за пределами локального компьютера.');
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function keycloakReady(base) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await localFetch(`${base}/realms/${KC_REALM}/.well-known/openid-configuration`, {}, 4000);
      if (response.ok) return;
    } catch { /* local Keycloak is still starting */ }
    await pause(1000);
  }
  throw new Error('Локальный Keycloak не ответил за 120 секунд.');
}

async function passwordLogin(config, realm, clientId, username, password, requiredRole) {
  const body = new URLSearchParams({ grant_type: 'password', client_id: clientId, username, password });
  const response = await localFetch(`${config.keycloakUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new Error('Не удалось получить отдельный токен локальной учётной записи.');
  const result = await response.json();
  if (typeof result.access_token !== 'string') throw new Error('Keycloak не выдал локальный access token.');
  const claims = decodeJwt(result.access_token);
  const expiresAt = Number(claims.exp) * 1000;
  const adminCli = realm === 'master' && clientId === 'admin-cli';
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()
    || (!adminCli && typeof claims.sub !== 'string') || claims.azp !== clientId) {
    throw new Error('Keycloak выдал JWT без ожидаемого срока, subject или клиента.');
  }
  if (requiredRole && !claims.realm_access?.roles?.includes(requiredRole)) throw new Error('Keycloak выдал токен без ожидаемой роли.');
  return { username, password, realm, clientId, requiredRole, token: result.access_token, claims, expiresAt, refreshPromise: null, refreshCount: 0 };
}

async function ensureFreshSession(config, session, force = false) {
  if (!force && session.expiresAt > Date.now() + 45_000) return session.token;
  if (session.refreshPromise) {
    await session.refreshPromise;
    return session.token;
  }
  const expectedSub = session.claims.sub;
  session.refreshPromise = (async () => {
    const fresh = await passwordLogin(config, session.realm, session.clientId, session.username, session.password, session.requiredRole);
    if (fresh.claims.sub !== expectedSub) throw new Error('Обновлённый Keycloak-сеанс получил другой subject.');
    session.token = fresh.token;
    session.claims = fresh.claims;
    session.expiresAt = fresh.expiresAt;
    session.refreshCount += 1;
  })();
  try { await session.refreshPromise; }
  finally { session.refreshPromise = null; }
  return session.token;
}

async function keycloakAdminToken(config) {
  await keycloakReady(config.keycloakUrl);
  return passwordLogin(config, 'master', 'admin-cli', config.adminUser, config.adminPassword);
}

async function kcRequest(config, session, route, options = {}) {
  const send = async (token) => localFetch(`${config.keycloakUrl}${route}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  let response = await send(await ensureFreshSession(config, session));
  if (response.status === 401) response = await send(await ensureFreshSession(config, session, true));
  if (!response.ok && response.status !== 409) throw new Error(`Локальный Keycloak вернул HTTP ${response.status} для admin API.`);
  return response;
}

function loadUsername(index) { return `${ACCOUNT_PREFIX}${String(index + 1).padStart(3, '0')}`; }
function loadDisplayName(index) { return `Load User ${String(index + 1).padStart(3, '0')}`; }
function loadPassword(adminPassword, username) {
  return createHmac('sha256', adminPassword).update(`lct-local-load-v1:${username}`).digest('hex');
}

async function provisionAccounts(config, adminToken) {
  const roleResponse = await kcRequest(config, adminToken, `/admin/realms/${KC_REALM}/roles/kam`);
  const kamRole = await roleResponse.json();
  const users = [];
  for (let index = 0; index < ACCOUNT_COUNT; index += 1) {
    const username = loadUsername(index);
    const marker = { lctLoadHarness: ['v1'] };
    const lookup = async () => {
      const response = await kcRequest(config, adminToken, `/admin/realms/${KC_REALM}/users?username=${encodeURIComponent(username)}&exact=true`);
      const matches = await response.json();
      const match = matches.find((item) => item.username === username);
      if (!match?.id) return undefined;
      const detail = await kcRequest(config, adminToken, `/admin/realms/${KC_REALM}/users/${match.id}`);
      return detail.json();
    };
    let user = await lookup();
    const expectedLastName = `User ${String(index + 1).padStart(3, '0')}`;
    const expectedEmail = `${username}@load.local.test`;
    const profileMatches = user && user.firstName === 'Load' && user.lastName === expectedLastName && user.email === expectedEmail;
    if (user && user.attributes?.lctLoadHarness?.[0] !== 'v1' && !profileMatches) {
      throw new Error(`Учётная запись ${username} уже существует без идентичного тестового профиля; остановлено без изменений.`);
    }
    if (!user) {
      await kcRequest(config, adminToken, `/admin/realms/${KC_REALM}/users`, {
        method: 'POST', body: JSON.stringify({ username, firstName: 'Load', lastName: expectedLastName, email: expectedEmail, emailVerified: true, enabled: true, attributes: marker }),
      });
      user = await lookup();
    } else {
      await kcRequest(config, adminToken, `/admin/realms/${KC_REALM}/users/${user.id}`, {
        method: 'PUT', body: JSON.stringify({ ...user, enabled: true, emailVerified: true, attributes: { ...(user.attributes ?? {}), ...marker } }),
      });
    }
    if (!user?.id) throw new Error(`Keycloak не вернул test account ${username}.`);
    await kcRequest(config, adminToken, `/admin/realms/${KC_REALM}/users/${user.id}/reset-password`, {
      method: 'PUT', body: JSON.stringify({ type: 'password', value: loadPassword(config.adminPassword, username), temporary: false }),
    });
    const mappedResponse = await kcRequest(config, adminToken, `/admin/realms/${KC_REALM}/users/${user.id}/role-mappings/realm`);
    const mappedRoles = await mappedResponse.json();
    if (mappedRoles.some((role) => role.name === 'admin' || role.name === 'manager')) throw new Error(`Учётная запись ${username} имеет привилегированную роль; нагрузка остановлена.`);
    if (!mappedRoles.some((role) => role.name === 'kam')) {
      await kcRequest(config, adminToken, `/admin/realms/${KC_REALM}/users/${user.id}/role-mappings/realm`, { method: 'POST', body: JSON.stringify([kamRole]) });
    }
    users.push({ username, sub: user.id, name: loadDisplayName(index), password: loadPassword(config.adminPassword, username) });
  }
  return users;
}

function makeClient(connectionString) { return new pg.Client({ connectionString }); }

async function createOrVerifyLoadDatabase(config) {
  const admin = makeClient(config.baseDatabaseUrl);
  await admin.connect();
  try {
    const current = await admin.query('SELECT current_database() AS name, inet_server_port() AS port');
    if (current.rows[0]?.name !== 'lctcrm' || Number(current.rows[0]?.port) !== 5432) {
      throw new Error('Источник PostgreSQL не совпал с локальным стендом lctcrm на 127.0.0.1:54329.');
    }
    const found = await admin.query('SELECT datistemplate, shobj_description(oid, \'pg_database\') AS marker FROM pg_database WHERE datname=$1', [LOAD_DB]);
    if (!found.rowCount) {
      await admin.query(`CREATE DATABASE ${LOAD_DB}`);
      await admin.query(`COMMENT ON DATABASE ${LOAD_DB} IS '${DB_MARKER}'`);
      return { created: true };
    }
    if (found.rows[0].datistemplate || found.rows[0].marker !== DB_MARKER) {
      throw new Error(`База ${LOAD_DB} уже существует и не принадлежит load harness; она оставлена без изменений.`);
    }
    return { created: false };
  } finally { await admin.end(); }
}

function runChild(command, args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: 'ignore' });
    child.once('error', () => reject(new Error(`Не удалось запустить ${label}.`)));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${label} завершился с кодом ${code ?? 'signal'}.`)));
  });
}

async function migrateLoadDatabase(config) {
  await runChild(process.execPath, ['--import', 'tsx', 'api/src/db/migrate.ts'], { ...process.env, DATABASE_URL: config.loadDatabaseUrl }, 'миграция изолированной базы');
}

async function provisionDatabaseUsers(config, users) {
  const client = makeClient(config.loadDatabaseUrl);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('crm-access-policy'))");
    for (const user of users) {
      const known = await client.query(`INSERT INTO known_crm_users(user_sub,display_name,realm_roles,provision_source,last_seen_at)
        VALUES($1,$2,ARRAY['kam']::text[],'local-load-harness',now())
        ON CONFLICT(user_sub) DO UPDATE SET display_name=EXCLUDED.display_name,realm_roles=EXCLUDED.realm_roles,
          provision_source=EXCLUDED.provision_source RETURNING disabled_at`, [user.sub, user.name]);
      if (known.rows[0]?.disabled_at) throw new Error(`Тестовая учётная запись ${user.username} отключена политикой CRM.`);
      const existing = await client.query('SELECT provision_source FROM kam_directory WHERE user_sub=$1', [user.sub]);
      if (existing.rowCount && existing.rows[0].provision_source !== 'local-load-harness') {
        throw new Error(`В каталоге КАМ найден чужой источник для ${user.username}; запись не перезаписана.`);
      }
      await client.query(`INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source,updated_at)
        VALUES($1,$2,TRUE,'local-load-harness',now())
        ON CONFLICT(user_sub) DO UPDATE SET display_name=EXCLUDED.display_name,enabled=TRUE,
          provision_source=EXCLUDED.provision_source,updated_at=EXCLUDED.updated_at`, [user.sub, user.name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

function buildApiEnv(config, reportStorage) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    API_HOST,
    API_PORT: String(API_PORT),
    DATABASE_URL: config.loadDatabaseUrl,
    OIDC_ISSUER: config.issuer,
    OIDC_JWKS_URL: `${config.keycloakUrl}/realms/${KC_REALM}/protocol/openid-connect/certs`,
    OIDC_CLIENT_ID: KC_CLIENT,
    CRM_REPORT_STORAGE: reportStorage,
  };
}

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => reject(new Error(error?.code === 'EADDRINUSE'
      ? 'Порт API 3002 уже занят; существующий процесс не затронут.'
      : `Не удалось проверить локальный порт API 3002 (${error?.code ?? 'unknown'}).`)));
    server.listen(API_PORT, API_HOST, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

async function startApi(config, reportStorage) {
  await assertPortFree();
  const child = spawn(process.execPath, ['--import', 'tsx', 'api/src/main.ts'], { cwd: ROOT, env: buildApiEnv(config, reportStorage), stdio: 'ignore' });
  let spawnError = false;
  child.once('error', () => { spawnError = true; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error('Не удалось запустить изолированный API.');
    if (child.exitCode !== null) throw new Error(`Локальный API на порту ${API_PORT} завершился при старте (код ${child.exitCode ?? 'signal'}).`);
    try {
      const response = await localFetch(`${API_URL}/health`, {}, 2000);
      if (response.ok) return child;
    } catch { /* API is starting */ }
    await pause(500);
  }
  child.kill('SIGTERM');
  await stopApi(child);
  throw new Error('Локальный API на порту 3002 не запустился за 60 секунд.');
}

async function stopApi(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = once(child, 'exit').then(() => true);
  if (await Promise.race([exited, pause(15_000).then(() => false)])) return;
  child.kill('SIGKILL');
  await exited;
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new Error('Keycloak вернул недопустимый JWT.'); }
}

async function login(config, username, password, requiredRole) {
  return passwordLogin(config, KC_REALM, KC_CLIENT, username, password, requiredRole);
}

async function loginAll(config, users, managerSession) {
  const sessions = [];
  for (let offset = 0; offset < users.length; offset += 5) {
    const batch = users.slice(offset, offset + 5);
    sessions.push(...await Promise.all(batch.map((user) => login(config, user.username, user.password, 'kam'))));
  }
  const subjects = new Set(sessions.map((session) => session.claims.sub));
  if (subjects.size !== ACCOUNT_COUNT || sessions.some((session) => session.claims.azp !== KC_CLIENT
    || !session.claims.realm_access?.roles?.includes('kam')
    || session.claims.realm_access.roles.includes('manager')
    || session.claims.realm_access.roles.includes('admin'))) {
    throw new Error('Нагрузка требует 50 разных JWT subject с ролью kam и клиентом lct-web.');
  }
  return { sessions, managerSession, distinctSubjects: subjects.size };
}

function titleForSeed(userIndex, activityIndex) {
  return `LOADTEST-SEED-${String(userIndex + 1).padStart(3, '0')}-${String(activityIndex + 1).padStart(3, '0')}`;
}

async function existingSeed(config, sessions, activitiesPerUser) {
  const client = makeClient(config.loadDatabaseUrl);
  await client.connect();
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('crm-load-harness-seed-v1')) AS acquired");
    if (!lock.rows[0]?.acquired) throw new Error('Другой load harness уже проверяет или заполняет seed-набор.');
    const rows = await client.query("SELECT id,owner_sub,title FROM activities WHERE title LIKE 'LOADTEST-SEED-%' ORDER BY title");
    const expected = new Map();
    sessions.forEach((session, userIndex) => {
      for (let activityIndex = 0; activityIndex < activitiesPerUser; activityIndex += 1) {
        expected.set(titleForSeed(userIndex, activityIndex), session.claims.sub);
      }
    });
    const seenTitles = new Set();
    for (const row of rows.rows) {
      if (seenTitles.has(row.title)) throw new Error('В lctcrm_load найдены дубликаты заголовков seed-активностей. База сохранена без очистки.');
      seenTitles.add(row.title);
      if (!expected.has(row.title) || expected.get(row.title) !== row.owner_sub) throw new Error('В lctcrm_load найдены синтетические активности, не принадлежащие ожидаемому seed-набору. База сохранена без очистки.');
    }
    const unrelated = await client.query("SELECT count(*)::integer AS n FROM activities WHERE title NOT LIKE 'LOADTEST-SEED-%'");
    if (Number(unrelated.rows[0].n) > 0) throw new Error('В lctcrm_load найдены записи вне пространства имён load harness. База сохранена без очистки.');
    return { client, existing: new Map(rows.rows.map((row) => [row.title, { id: row.id, ownerSub: row.owner_sub }])), expected };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

async function verifySeedRows(seedState) {
  const result = await seedState.client.query("SELECT id,owner_sub,title FROM activities WHERE title LIKE 'LOADTEST-SEED-%' ORDER BY title");
  const seen = new Set();
  const verified = new Map();
  for (const row of result.rows) {
    if (seen.has(row.title) || !seedState.expected.has(row.title) || seedState.expected.get(row.title) !== row.owner_sub) {
      throw new Error('Проверка seed-набора обнаружила дубликат или несовпадающего владельца.');
    }
    seen.add(row.title);
    verified.set(row.title, { id: row.id, ownerSub: row.owner_sub });
  }
  if (seen.size !== seedState.expected.size) throw new Error('Число seed-активностей в базе не совпало с ожидаемым.');
  seedState.existing = verified;
}

async function releaseSeedLock(seedState) {
  if (!seedState?.client) return;
  try { await seedState.client.query("SELECT pg_advisory_unlock(hashtext('crm-load-harness-seed-v1'))"); }
  finally { await seedState.client.end(); }
}

async function apiCall(config, sessionOrToken, method, route, payload, stats, group = 'setup') {
  const start = performance.now();
  const session = typeof sessionOrToken === 'string' ? null : sessionOrToken;
  const attempt = async () => {
    const attemptStart = performance.now();
    let response;
    let data;
    let networkError;
    try {
      const token = session ? await ensureFreshSession(config, session) : sessionOrToken;
      response = await localFetch(`${API_URL}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }, 45_000);
      data = await jsonResponse(response);
    } catch (error) { networkError = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? error.name : 'request_failed'; }
    const ms = performance.now() - attemptStart;
    if (stats) stats.record(group, method, route, response?.status ?? 0, ms, networkError, data?.code);
    return { response, data, networkError, ms };
  };
  let result = await attempt();
  if (session && result.response?.status === 401) {
    try {
      await ensureFreshSession(config, session, true);
      session.authRetryCount = (session.authRetryCount ?? 0) + 1;
      result = await attempt();
    } catch { session.authRefreshFailures = (session.authRefreshFailures ?? 0) + 1; }
  }
  return { ...result, ms: performance.now() - start };
}

async function seedThroughApi(config, sessions, activitiesPerUser, seedState, stats) {
  const missing = [];
  sessions.forEach((session, userIndex) => {
    for (let activityIndex = 0; activityIndex < activitiesPerUser; activityIndex += 1) {
      const title = titleForSeed(userIndex, activityIndex);
      if (!seedState.existing.has(title)) missing.push({ session, userIndex, activityIndex, title });
    }
  });
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const item = missing[next++];
      const kind = ['university', 'corporate', 'individual'][(item.userIndex + item.activityIndex) % 3];
      const payload = {
        kind,
        title: item.title,
        priority: (item.activityIndex % 5) + 1,
        ...(kind === 'individual' ? { personName: `Synthetic person ${item.userIndex + 1}-${item.activityIndex + 1}` } : {
          organizationName: `Synthetic ${kind} organization ${item.userIndex + 1}-${item.activityIndex + 1}`,
        }),
      };
      const result = await apiCall(config, item.session, 'POST', '/api/activities', payload, stats);
      if (!result.response?.ok || result.response.status !== 201 || typeof result.data?.id !== 'string') {
        throw new Error(`Не удалось подготовить синтетическую активность ${item.title} (HTTP ${result.response?.status ?? 0}).`);
      }
      seedState.existing.set(item.title, { id: result.data.id, ownerSub: item.session.claims.sub });
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  const bySubject = new Map(sessions.map((session) => [session.claims.sub, []]));
  for (const row of seedState.existing.values()) bySubject.get(row.ownerSub)?.push(row.id);
  if ([...bySubject.values()].some((ids) => ids.length !== activitiesPerUser)) throw new Error('Seed-набор не совпал с числом активностей на каждого отдельного КАМ.');
  return bySubject;
}

function createStats() {
  const groups = new Map();
  const samplesByGroup = new Map();
  const stats = {
    record(group, method, route, status, ms, networkError, errorCode) {
      const endpoint = `${method} ${route.replace(/\?.*$/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')}`;
      const key = `${group}::${endpoint}`;
      const current = groups.get(key) ?? { group, endpoint, samplesMs: [], requests: 0, errors: 0, statuses: {} };
      current.samplesMs.push(ms);
      if (!samplesByGroup.has(group)) samplesByGroup.set(group, []);
      samplesByGroup.get(group).push(ms);
      current.requests += 1;
      if (!responseOk(status) || networkError) {
        current.errors += 1;
        const errorKey = networkError ? `network:${networkError}` : `http:${status}${errorCode ? `:${errorCode}` : ''}`;
        current.statuses[errorKey] = (current.statuses[errorKey] ?? 0) + 1;
      }
      groups.set(key, current);
    },
    output() {
      return [...groups.values()].map(({ samplesMs, ...item }) => ({ ...item, latencyMs: summarize(samplesMs) })).sort((a, b) => a.group.localeCompare(b.group) || a.endpoint.localeCompare(b.endpoint));
    },
  };
  statsSamples.set(stats, samplesByGroup);
  return stats;
}

function responseOk(status) { return status >= 200 && status < 400; }

function summarize(samples) {
  if (!samples.length) return { count: 0, min: null, p50: null, p95: null, max: null, fractionLe1000ms: null, le1000msCount: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const nearest = (percentile) => sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
  const le1000msCount = samples.filter((sample) => sample <= 1000).length;
  return {
    count: sorted.length,
    min: round(sorted[0]),
    p50: round(nearest(0.5)),
    p95: round(nearest(0.95)),
    max: round(sorted.at(-1)),
    fractionLe1000ms: Number((le1000msCount / sorted.length).toFixed(6)),
    le1000msCount,
  };
}

function round(value) { return Number(value.toFixed(2)); }

function peakOverlappingExports(reports) {
  const events = [];
  for (const report of reports) {
    const startedAt = Date.parse(report.exportDbCreatedAt ?? '');
    const finishedAt = Date.parse(report.exportDbUpdatedAt ?? '');
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) continue;
    events.push({ at: startedAt, change: 1 });
    events.push({ at: finishedAt, change: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.change - b.change);
  let concurrent = 0;
  let peak = 0;
  for (const event of events) { concurrent += event.change; peak = Math.max(peak, concurrent); }
  return peak;
}

async function databaseMetrics(config) {
  const client = makeClient(config.loadDatabaseUrl);
  await client.connect();
  try {
    const result = await client.query(`SELECT current_setting('server_version') AS version,
      pg_database_size(current_database())::bigint AS size_bytes,
      (SELECT count(*) FROM activities) AS activity_count,
      (SELECT count(*) FROM tasks) AS task_count,
      (SELECT count(*) FROM activity_events) AS event_count,
      (SELECT count(*) FROM report_jobs) AS report_job_count`);
    const row = result.rows[0];
    return {
      name: LOAD_DB,
      postgresVersion: row.version,
      sizeBytes: Number(row.size_bytes),
      activityCount: Number(row.activity_count),
      taskCount: Number(row.task_count),
      activityEventCount: Number(row.event_count),
      reportJobCount: Number(row.report_job_count),
    };
  } finally { await client.end(); }
}

async function waitForGate(gate) { await gate.promise; }
function makeGate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function makeDeterministicRng(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

async function readApi(config, session, method, route, body, stats, group) {
  const result = await apiCall(config, session, method, route, body, stats, group);
  if (!result.response?.ok) return { ok: false, status: result.response?.status ?? 0, data: result.data };
  return { ok: true, status: result.response.status, data: result.data };
}

async function runVirtualUser(config, session, activityIds, gate, deadline, stats, counters, rng) {
  await waitForGate(gate);
  let index = 0;
  const choose = () => activityIds[(index++) % activityIds.length];
  while (performance.now() < deadline && !stopping) {
    const roll = rng();
    let name;
    if (roll < 0.25) {
      name = 'queue';
      await readApi(config, session, 'GET', '/api/activities?segment=all&collection=all&offset=0&limit=25', undefined, stats, 'users');
    } else if (roll < 0.45) {
      name = 'activity';
      await readApi(config, session, 'GET', `/api/activities/${choose()}`, undefined, stats, 'users');
    } else if (roll < 0.60) {
      name = 'history';
      await readApi(config, session, 'GET', `/api/activities/${choose()}/history`, undefined, stats, 'users');
    } else if (roll < 0.80) {
      name = 'task_cycle';
      const activityId = choose();
      const created = await readApi(config, session, 'POST', `/api/activities/${activityId}/tasks`, {
        title: `Synthetic load follow-up ${randomUUID().slice(0, 8)}`,
        dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }, stats, 'users');
      if (created.ok && typeof created.data?.id === 'string') {
        const completed = await readApi(config, session, 'POST', `/api/activities/${activityId}/tasks/${created.data.id}/complete`, undefined, stats, 'users');
        counters.taskCompletions += Number(completed.ok);
      }
    } else {
      name = 'outcome';
      await readApi(config, session, 'POST', `/api/activities/${choose()}/outcomes`, {
        outcome: 'connected', note: `Synthetic load contact ${randomUUID().slice(0, 8)}`,
      }, stats, 'users');
    }
    counters.actions[name] = (counters.actions[name] ?? 0) + 1;
  }
}

async function managerReportJob(config, index, managerSession, gate, stats, pollMs, timeoutMs) {
  await waitForGate(gate);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const reportId = index % 2 ? 'demand_learning' : 'crm_portfolio';
  const snapshot = await readApi(config, managerSession, 'POST', '/api/reports/snapshots', { reportId, filters: { includeClosed: true } }, stats, 'reports');
  if (!snapshot.ok || typeof snapshot.data?.snapshotId !== 'string') return { index: index + 1, reportId, status: 'snapshot_failed', startedAt, durationMs: round(performance.now() - started), httpStatus: snapshot.status };
  const snapshotId = snapshot.data.snapshotId;
  const snapshotMs = performance.now() - started;
  const exportPostStartedAt = new Date().toISOString();
  const exportPostStarted = performance.now();
  const exportJob = await readApi(config, managerSession, 'POST', '/api/reports/exports', { snapshotId, format: 'xlsx' }, stats, 'reports');
  const exportPostMs = performance.now() - exportPostStarted;
  if (!exportJob.ok || typeof exportJob.data?.id !== 'string') return {
    index: index + 1, reportId, status: 'export_submit_failed', snapshotId, startedAt, snapshotMs: round(snapshotMs),
    exportPostStartedAt, exportPostMs: round(exportPostMs), totalMs: round(performance.now() - started), httpStatus: exportJob.status,
  };
  const exportId = exportJob.data.id;
  let state;
  let timedOut = false;
  while (!stopping && performance.now() - exportPostStarted < timeoutMs) {
    const status = await readApi(config, managerSession, 'GET', `/api/reports/exports/${exportId}`, undefined, stats, 'reports');
    if (!status.ok) {
      state = { status: 'status_failed', httpStatus: status.status };
      break;
    }
    if (status.data?.status === 'completed' || status.data?.status === 'failed') {
      state = status.data;
      break;
    }
    await pause(pollMs);
  }
  if (!state) { timedOut = true; state = { status: 'timeout' }; }
  const exportReadyMs = state.status === 'completed' ? performance.now() - exportPostStarted : null;
  let downloadMs = null;
  let downloadAttemptMs = null;
  let fileBytes = 0;
  let downloadStatus = null;
  let downloadSucceeded = false;
  if (state.status === 'completed') {
    const downloadStart = performance.now();
    try {
      const send = async () => localFetch(`${API_URL}/api/reports/exports/${exportId}/file`, {
        headers: { authorization: `Bearer ${await ensureFreshSession(config, managerSession)}` },
      }, 120_000);
      let response = await send();
      if (response.status === 401) {
        await ensureFreshSession(config, managerSession, true);
        managerSession.authRetryCount = (managerSession.authRetryCount ?? 0) + 1;
        response = await send();
      }
      downloadStatus = response.status;
      if (response.ok) fileBytes = (await response.arrayBuffer()).byteLength;
      downloadSucceeded = response.status === 200 && fileBytes > 0;
      stats.record('reports', 'GET', '/api/reports/exports/:id/file', response.status, performance.now() - downloadStart,
        downloadSucceeded ? undefined : (response.ok ? 'empty_file' : 'download_failed'));
    } catch (error) {
      downloadStatus = 0;
      stats.record('reports', 'GET', '/api/reports/exports/:id/file', 0, performance.now() - downloadStart,
        error?.name === 'AbortError' || error?.name === 'TimeoutError' ? error.name : 'download_failed');
    }
    downloadAttemptMs = round(performance.now() - downloadStart);
    if (downloadSucceeded) downloadMs = downloadAttemptMs;
  }
  return {
    index: index + 1,
    reportId,
    snapshotId,
    exportId,
    status: state.status,
    rowCount: Number(exportJob.data.rowCount ?? snapshot.data.rowCount ?? 0),
    startedAt,
    exportPostStartedAt,
    exportPostMs: round(exportPostMs),
    exportDbCreatedAt: state.createdAt ?? null,
    exportDbUpdatedAt: state.updatedAt ?? null,
    snapshotMs: round(snapshotMs),
    exportReadyMs: exportReadyMs === null ? null : round(exportReadyMs),
    totalMs: round(performance.now() - started),
    timedOut,
    downloadStatus,
    downloadMs,
    downloadAttemptMs,
    downloadSucceeded,
    fileBytes: Number.isFinite(fileBytes) ? fileBytes : 0,
  };
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

async function main() {
  currentPhase = 'argument parsing';
  const args = parseArgs();
  if (args.help) { help(); return; }
  if (!args.confirm) {
    help();
    throw new Error('Нужен явный флаг --confirm-local-only; без него внешние сервисы, аккаунты и базы не меняются.');
  }
  currentPhase = 'local configuration';
  const config = await loadLocalConfig();
  await assertPortFree();
  currentPhase = 'Keycloak preflight';
  const managerSession = await login(config, 'manager', config.managerPassword, 'manager');
  if (managerSession.claims.azp !== KC_CLIENT) throw new Error('Токен локального manager относится к неожиданному клиенту.');
  currentPhase = 'Keycloak admin login';
  const adminSession = await keycloakAdminToken(config);
  await kcRequest(config, adminSession, `/admin/realms/${KC_REALM}/roles/kam`);
  currentPhase = 'isolated database setup';
  const databaseOwnership = await createOrVerifyLoadDatabase(config);
  await migrateLoadDatabase(config);
  currentPhase = 'test account provisioning';
  const accounts = await provisionAccounts(config, adminSession);
  await provisionDatabaseUsers(config, accounts);

  currentPhase = 'distinct account authentication';
  const auth = await loginAll(config, accounts, managerSession);
  const stats = createStats();
  const runId = randomUUID();
  const reportStorage = path.join(ROOT, '.local-storage', 'load-harness', 'reports');
  let api;
  let output;
  try {
    currentPhase = 'isolated API startup';
    api = await startApi(config, reportStorage);
    const health = await localFetch(`${API_URL}/health`, {}, 2000);
    if (!health.ok) throw new Error('Изолированный API на порту 3002 не прошёл health-check.');
    currentPhase = 'synthetic seed preparation';
    const seedState = await existingSeed(config, auth.sessions, args.activitiesPerUser);
    let activitiesByUser;
    let newSeedActivitiesThisRun;
    try {
      newSeedActivitiesThisRun = seedState.expected.size - seedState.existing.size;
      await seedThroughApi(config, auth.sessions, args.activitiesPerUser, seedState, stats);
      await verifySeedRows(seedState);
      activitiesByUser = new Map(auth.sessions.map((session) => [session.claims.sub, []]));
      for (const row of seedState.existing.values()) activitiesByUser.get(row.ownerSub)?.push(row.id);
      if ([...activitiesByUser.values()].some((ids) => ids.length !== args.activitiesPerUser)) throw new Error('Seed-набор не совпал с числом активностей на каждого отдельного КАМ.');
    } finally {
      await releaseSeedLock(seedState);
    }
    if (args.seedOnly) {
      const witnessTitle = titleForSeed(0, 0);
      const witness = seedState.existing.get(witnessTitle);
      if (!witness) throw new Error('Проверочная seed-активность отсутствует после подготовки набора.');
      const verifyActivityAfterRestart = async () => {
        const result = await apiCall(config, auth.sessions[0], 'GET', `/api/activities/${witness.id}`, undefined, null, 'seed-only');
        if (!result.response?.ok || result.data?.id !== witness.id || result.data?.title !== witnessTitle) {
          throw new Error('Изолированный API не прочитал ожидаемую seed-активность.');
        }
      };
      currentPhase = 'seed-only API persistence check';
      await verifyActivityAfterRestart();
      await stopApi(api);
      api = undefined;
      api = await startApi(config, reportStorage);
      await verifyActivityAfterRestart();

      currentPhase = 'seed-only idempotence check';
      const secondSeedState = await existingSeed(config, auth.sessions, args.activitiesPerUser);
      let idempotenceNewSeedActivities;
      try {
        idempotenceNewSeedActivities = secondSeedState.expected.size - secondSeedState.existing.size;
        if (idempotenceNewSeedActivities !== 0) throw new Error('Повторная проверка обнаружила отсутствующие seed-активности.');
        await verifySeedRows(secondSeedState);
      } finally {
        await releaseSeedLock(secondSeedState);
      }
      output = {
        schemaVersion: 1,
        ok: true,
        mode: 'seed-only',
        generatedAt: new Date().toISOString(),
        setup: {
          localOnly: true,
          database: LOAD_DB,
          databaseCreatedThisRun: databaseOwnership.created,
          api: API_URL,
          apiStartedByHarness: true,
          apiRestarts: 1,
          sameSeedActivityReadableAfterRestart: true,
          keycloakRealm: KC_REALM,
          distinctKamSessions: auth.distinctSubjects,
          seedActivitiesPerUser: args.activitiesPerUser,
          seedActivityCount: ACCOUNT_COUNT * args.activitiesPerUser,
          newSeedActivitiesThisRun,
          idempotenceNewSeedActivities,
        },
      };
    } else {
      const databaseAtStart = await databaseMetrics(config);
      const counters = { actions: {}, taskCompletions: 0 };
      const gate = makeGate();
      const durationMs = args.durationSeconds * 1000;
      const loadStart = performance.now();
      const loadStartIso = new Date().toISOString();
      const deadline = loadStart + durationMs;
      currentPhase = 'timed workload and concurrent reports';
      const usersPromise = Promise.all(auth.sessions.map((session, index) => runVirtualUser(
        config, session, activitiesByUser.get(session.claims.sub), gate, deadline, stats, counters, makeDeterministicRng(index + 1),
      )));
      const reportPromises = Array.from({ length: REPORT_COUNT }, (_, index) => managerReportJob(config, index, auth.managerSession, gate, stats, 250, 10 * 60 * 1000));
      gate.release();
      await usersPromise;
      const loadDurationMs = performance.now() - loadStart;
      const reports = await Promise.all(reportPromises);
      const databaseAtEnd = await databaseMetrics(config);
      const groupedStats = stats.output();
      const loadGroups = groupedStats.filter((item) => item.group === 'users');
      const totalLoadRequests = loadGroups.reduce((sum, item) => sum + item.requests, 0);
      const totalLoadErrors = loadGroups.reduce((sum, item) => sum + item.errors, 0);
      const reportGroups = groupedStats.filter((item) => item.group === 'reports');
      const totalReportErrors = reportGroups.reduce((sum, item) => sum + item.errors, 0);
      const userSamples = statsInternalSamples(stats, 'users');
      const reportFinished = reports.filter((report) => report.status === 'completed');
      const successfulDownloads = reports.filter((report) => report.downloadSucceeded === true);
      const failedDownloads = reports.filter((report) => report.status === 'completed' && report.downloadSucceeded !== true).length;
      const successfulCompletionSamples = reportFinished.map((report) => report.exportReadyMs).filter(Number.isFinite);
      const successfulDownloadSamples = successfulDownloads.map((report) => report.downloadMs).filter(Number.isFinite);
      const allWorkSucceeded = !stopping && totalLoadRequests > 0 && totalLoadErrors === 0 && totalReportErrors === 0
        && reports.length === REPORT_COUNT && reportFinished.length === REPORT_COUNT && failedDownloads === 0
        && successfulDownloads.length === REPORT_COUNT;
      output = {
        schemaVersion: 1,
        ok: allWorkSucceeded,
        interrupted: stopping,
        runId,
        generatedAt: new Date().toISOString(),
        setup: {
          localOnly: true,
          database: LOAD_DB,
          databaseCreatedThisRun: databaseOwnership.created,
          api: API_URL,
          apiStartedByHarness: true,
          keycloakRealm: KC_REALM,
          distinctKamSessions: auth.distinctSubjects,
          concurrentVirtualUsers: ACCOUNT_COUNT,
          seedActivitiesPerUser: args.activitiesPerUser,
          seedActivityCount: ACCOUNT_COUNT * args.activitiesPerUser,
          newSeedActivitiesThisRun,
        },
        machine: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          logicalCpuCount: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          loadAverage: os.loadavg(),
        },
        database: {
          beforeTimedLoad: databaseAtStart,
          afterLoadAndReports: databaseAtEnd,
          sizeDeltaBytes: databaseAtEnd.sizeBytes - databaseAtStart.sizeBytes,
        },
        timedLoad: {
          startedAt: loadStartIso,
          targetSeconds: args.durationSeconds,
          actualSeconds: round(loadDurationMs / 1000),
          virtualUsers: ACCOUNT_COUNT,
          actionCycles: counters.actions,
          taskCompletions: counters.taskCompletions,
          requests: totalLoadRequests,
          errors: totalLoadErrors,
          requestsPerSecond: round(totalLoadRequests / (loadDurationMs / 1000)),
          latencyMs: summarize(userSamples),
        },
        latencyByEndpoint: groupedStats,
        managerReports: {
          requestedConcurrentJobs: REPORT_COUNT,
          peakOverlappingExportsFromDbTimestamps: peakOverlappingExports(reports),
          exportPostStartedAt: reports.map((report) => report.exportPostStartedAt).filter(Boolean),
          completedExportJobs: reportFinished.length,
          failedOrTimedOutJobs: reports.length - reportFinished.length,
          successfulDownloads: successfulDownloads.length,
          failedDownloads,
          completionMs: summarize(successfulCompletionSamples),
          downloadMs: summarize(successfulDownloadSamples),
          downloadedFileBytes: reports.reduce((sum, report) => sum + (Number.isFinite(report.fileBytes) ? report.fileBytes : 0), 0),
          jobs: reports,
        },
      };
    }
  } finally {
    await stopApi(api);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = stopping ? 130 : (output.ok ? 0 : 1);
}

// Kept separate from the public stats output so exact aggregate p50/p95 are retained.
const statsSamples = new WeakMap();
function statsInternalSamples(stats, group) { return statsSamples.get(stats)?.get(group) ?? []; }

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, phase: currentPhase, error: 'Подробности скрыты, чтобы не раскрывать локальные секреты.' })}\n`);
  process.exitCode = 1;
});
