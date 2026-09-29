#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import pg from 'pg';
import {
  assertPublicDemoDatabaseUrl,
  assertPublicDemoKeycloakUrl,
  PUBLIC_DEMO_DATABASE_MARKER,
} from './provision-public-demo-accounts.mjs';

const username = 'kam.anna';
const credentialsFile = '/credentials/demo-accounts.txt';

async function keycloakRequest(base, path, token, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw new Error(`Keycloak operation failed (${response.status}).`);
  return response;
}

async function main() {
  if (process.argv[2] !== '--rotate-kam-anna' || process.env.PUBLIC_DEMO_ROTATE !== '1') {
    throw new Error('Explicit public-demo rotation flag is required.');
  }
  const base = assertPublicDemoKeycloakUrl(process.env.KEYCLOAK_URL);
  assertPublicDemoDatabaseUrl(process.env.DATABASE_URL);
  const directory = await lstat('/credentials');
  const file = await lstat(credentialsFile);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
    || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) {
    throw new Error('Private credential storage has unsafe ownership or permissions.');
  }
  const lines = (await readFile(credentialsFile, 'utf8')).split('\n');
  const matching = lines.flatMap((line, index) => line.startsWith(`${username}\t`) ? [index] : []);
  if (matching.length !== 1 || !lines[matching[0]].slice(username.length + 1)) {
    throw new Error('Expected one existing demo KAM account in the credential file.');
  }

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let expectedSub;
  try {
    const result = await db.query(`SELECT current_database() AS database,
      shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database') AS marker`);
    if (result.rows[0]?.database !== 'lctcrm' || result.rows[0]?.marker !== PUBLIC_DEMO_DATABASE_MARKER) {
      throw new Error('Public-demo database identity mismatch.');
    }
    const users = await db.query(`SELECT user_sub FROM known_crm_users
      WHERE display_name='Анна Орлова' AND realm_roles=ARRAY['kam']::text[]
        AND provision_source='public-demo-provisioning' AND disabled_at IS NULL`);
    if (users.rows.length !== 1) throw new Error('Public-demo KAM identity mismatch.');
    expectedSub = users.rows[0].user_sub;
  } finally {
    await db.end();
  }

  const adminUser = process.env.KC_ADMIN_USER;
  const adminPassword = process.env.KC_ADMIN_PASSWORD;
  if (!adminUser || !adminPassword) throw new Error('Keycloak administrator configuration is missing.');
  const login = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUser, password: adminPassword }),
  });
  if (!login.ok) throw new Error('Could not authenticate to private Keycloak.');
  const token = (await login.json()).access_token;
  const lookup = await keycloakRequest(base, `/admin/realms/lct/users?username=${encodeURIComponent(username)}&exact=true`, token);
  const users = (await lookup.json()).filter((user) => user.username === username);
  if (users.length !== 1 || users[0].id !== expectedSub || users[0].enabled !== true) {
    throw new Error('Keycloak account does not match the public-demo KAM identity.');
  }

  const password = randomBytes(32).toString('base64url');
  lines[matching[0]] = `${username}\t${password}`;
  const temporary = `${credentialsFile}.rotation-${process.pid}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(lines.join('\n'), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await keycloakRequest(base, `/admin/realms/lct/users/${encodeURIComponent(expectedSub)}/reset-password`, token, {
      method: 'PUT', body: JSON.stringify({ type: 'password', value: password, temporary: false }),
    });
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await rename(temporary, credentialsFile);
  const logout = await fetch(`${base}/admin/realms/lct/users/${encodeURIComponent(expectedSub)}/logout`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  if (!logout.ok) throw new Error(`Password rotated, but session revocation failed (${logout.status}).`);
  console.log('Rotated the synthetic kam.anna password, replaced the private credential file, and revoked sessions.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
