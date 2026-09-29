#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const PUBLIC_DEMO_DATABASE = 'lctcrm';
export const PUBLIC_DEMO_DATABASE_MARKER = 'lct CRM public_demo isolated database v1';
export const PUBLIC_DEMO_KEYCLOAK_URL = 'http://keycloak:8080';

const users = [
  { username: 'kam.anna', firstName: 'Анна', lastName: 'Орлова', email: 'anna.kam@local.test', role: 'kam' },
  { username: 'kam.dmitry', firstName: 'Дмитрий', lastName: 'Соколов', email: 'dmitry.kam@local.test', role: 'kam' },
  { username: 'manager', firstName: 'Елена', lastName: 'Руководитель', email: 'manager@local.test', role: 'manager' },
  { username: 'admin', firstName: 'Алексей', lastName: 'Администратор', email: 'admin@local.test', role: 'admin' },
];

export function assertPublicDemoDatabaseUrl(value) {
  let target;
  try { target = new URL(value); }
  catch { throw new Error('Public-demo provisioning requires its fixed private Compose PostgreSQL URL.'); }
  const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== 'postgres'
    || target.port !== '5432' || database !== PUBLIC_DEMO_DATABASE
    || decodeURIComponent(target.username) !== 'lctcrm' || !target.password || target.search || target.hash) {
    throw new Error('Public-demo provisioning is restricted to postgres:5432/lctcrm as user lctcrm.');
  }
  return target;
}

export function assertPublicDemoKeycloakUrl(value) {
  let target;
  try { target = new URL(value); }
  catch { throw new Error('Public-demo provisioning requires the private Compose Keycloak URL.'); }
  if (target.origin !== PUBLIC_DEMO_KEYCLOAK_URL || target.pathname !== '/' || target.username || target.password || target.search || target.hash) {
    throw new Error('Public-demo provisioning is restricted to http://keycloak:8080 on the private Compose network.');
  }
  return PUBLIC_DEMO_KEYCLOAK_URL;
}

export function assertPublicDemoSeedOptIn(env = process.env) {
  if (env.PUBLIC_DEMO_SEED !== '1') throw new Error('Set PUBLIC_DEMO_SEED=1 and pass --apply-public-demo to seed the public demo database.');
}

export function assertPublicDemoDatabaseIdentity({ database, marker }, { requireMarker = true } = {}) {
  if (database !== PUBLIC_DEMO_DATABASE) throw new Error(`Public demo database identity mismatch; expected ${PUBLIC_DEMO_DATABASE}.`);
  if (requireMarker && marker !== PUBLIC_DEMO_DATABASE_MARKER) throw new Error('Target database lacks the public-demo isolation marker; no data was changed.');
  if (!requireMarker && marker !== null && marker !== PUBLIC_DEMO_DATABASE_MARKER) {
    throw new Error('Target database has a different isolation marker; no data was changed.');
  }
}

export async function assertOrMarkPublicDemoDatabase(client) {
  const identity = await client.query(`SELECT current_database() AS database,
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database') AS marker`);
  const row = identity.rows[0] ?? {};
  assertPublicDemoDatabaseIdentity(row, { requireMarker: false });
  if (row.marker === PUBLIC_DEMO_DATABASE_MARKER) return { marked: false };

  const counts = await client.query(`SELECT
    (SELECT count(*)::integer FROM known_crm_users) AS known_users,
    (SELECT count(*)::integer FROM kam_directory) AS kam_users,
    (SELECT count(*)::integer FROM organizations) AS organizations,
    (SELECT count(*)::integer FROM people) AS people,
    (SELECT count(*)::integer FROM activities) AS activities,
    (SELECT count(*)::integer FROM tasks) AS tasks,
    (SELECT count(*)::integer FROM activity_events) AS events`);
  if (Object.values(counts.rows[0] ?? {}).some((count) => Number(count) !== 0)) {
    throw new Error('Unmarked CRM database already contains access or demo activity data; it was left unchanged.');
  }
  await client.query(`COMMENT ON DATABASE lctcrm IS '${PUBLIC_DEMO_DATABASE_MARKER}'`);
  return { marked: true };
}

async function request(base, endpoint, token, options = {}) {
  let response;
  try {
    response = await fetch(`${base}${endpoint}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
  } catch {
    throw new Error('Could not reach Keycloak over the private Compose network.');
  }
  if (!response.ok) throw new Error(`Keycloak admin request failed (${response.status}).`);
  return response;
}

async function authenticate(base, adminUser, adminPassword) {
  let response;
  try {
    response = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUser, password: adminPassword }),
    });
  } catch {
    throw new Error('Could not reach Keycloak over the private Compose network.');
  }
  if (!response.ok) throw new Error('Could not sign in to the Keycloak master realm.');
  return (await response.json()).access_token;
}

async function checkCredentialsDirectory(credentialsFile) {
  const directory = await lstat('/credentials').catch(() => null);
  if (!directory?.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
    throw new Error('Credential output directory must be a real directory with mode 700 or stricter.');
  }
  const target = await lstat(credentialsFile).catch(() => null);
  if (target) throw new Error('Credential output file already exists; refusing to reset or overwrite demo accounts.');
}

async function saveCredentials(credentialsFile, passwords) {
  const lines = ['Synthetic public demo accounts. Keep this file private and delete it after securely distributing the credentials.', ''];
  for (const user of users) lines.push(`${user.username}\t${passwords.get(user.username)}`);
  lines.push('');
  const handle = await open(credentialsFile, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(lines.join('\n'), { encoding: 'utf8' });
    await handle.sync();
  } catch {
    await handle.close();
    await unlink(credentialsFile).catch(() => {});
    throw new Error('Could not safely write the private credential file.');
  }
  await handle.close();
  await chmod(credentialsFile, 0o600);
}

async function main() {
  const base = assertPublicDemoKeycloakUrl(process.env.KEYCLOAK_URL ?? PUBLIC_DEMO_KEYCLOAK_URL);
  const databaseUrl = process.env.DATABASE_URL;
  assertPublicDemoDatabaseUrl(databaseUrl);
  const adminUser = process.env.KC_ADMIN_USER;
  const adminPassword = process.env.KC_ADMIN_PASSWORD;
  const credentialsFile = process.env.DEMO_CREDENTIALS_FILE ?? '/credentials/demo-accounts.txt';
  if (!adminUser || !adminPassword) throw new Error('Keycloak bootstrap administrator credentials are missing.');
  await checkCredentialsDirectory(credentialsFile);

  const token = await authenticate(base, adminUser, adminPassword);
  const roles = new Map();
  for (const name of new Set(users.map((user) => user.role))) {
    const response = await request(base, `/admin/realms/lct/roles/${encodeURIComponent(name)}`, token);
    roles.set(name, await response.json());
  }

  // Refuse to reset or adopt any pre-existing identity. This keeps a one-shot
  // public-demo run from touching an account created or managed elsewhere.
  for (const user of users) {
    const response = await request(base, `/admin/realms/lct/users?username=${encodeURIComponent(user.username)}&exact=true`, token);
    const matches = await response.json();
    if (matches.some((match) => match.username === user.username)) {
      throw new Error(`Account ${user.username} already exists; no accounts were changed.`);
    }
  }

  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query('SELECT user_sub FROM known_crm_users LIMIT 0');
    await db.query('SELECT user_sub FROM kam_directory LIMIT 0');
    await assertOrMarkPublicDemoDatabase(db);
  } catch (error) {
    await db.end();
    if (error.message.includes('isolation marker') || error.message.includes('Unmarked CRM database')) throw error;
    throw new Error('CRM schema is missing or the public-demo database guard failed; start the public-demo API once so migrations finish.');
  }
  await db.end();

  const passwords = new Map(users.map((user) => [user.username, randomBytes(32).toString('base64url')]));
  await saveCredentials(credentialsFile, passwords);

  const provisioned = [];
  for (const user of users) {
    const response = await request(base, '/admin/realms/lct/users', token, {
      method: 'POST',
      body: JSON.stringify({
        username: user.username, firstName: user.firstName, lastName: user.lastName,
        email: user.email, enabled: true, emailVerified: true,
      }),
    });
    if (response.status !== 201) throw new Error(`Keycloak did not create account ${user.username}.`);
    const location = response.headers.get('location');
    const id = location?.split('/').filter(Boolean).at(-1);
    if (!id) throw new Error(`Keycloak did not return the id for account ${user.username}.`);
    await request(base, `/admin/realms/lct/users/${encodeURIComponent(id)}/reset-password`, token, {
      method: 'PUT', body: JSON.stringify({ type: 'password', value: passwords.get(user.username), temporary: false }),
    });
    await request(base, `/admin/realms/lct/users/${encodeURIComponent(id)}/role-mappings/realm`, token, {
      method: 'POST', body: JSON.stringify([roles.get(user.role)]),
    });
    provisioned.push({ sub: id, name: `${user.firstName} ${user.lastName}`, role: user.role });
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('crm-access-policy'))");
    for (const user of provisioned) {
      const known = await client.query(`INSERT INTO known_crm_users(user_sub,display_name,realm_roles,provision_source,last_seen_at)
        VALUES($1,$2,ARRAY[$3]::text[],'public-demo-provisioning',now())
        ON CONFLICT(user_sub) DO NOTHING`, [user.sub, user.name, user.role]);
      if (known.rowCount !== 1) throw new Error('CRM already contains one of the newly created Keycloak ids; inspect both systems before retrying.');
      if (user.role === 'kam') {
        await client.query(`INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source,updated_at)
          VALUES($1,$2,true,'public-demo-provisioning',now())`, [user.sub, user.name]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }

  console.log(`Created four synthetic accounts and synchronized CRM access records. Credentials saved to ${credentialsFile} with mode 600; passwords were not printed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
