#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import pg from 'pg';
import { assertPublicDemoDatabaseUrl, assertPublicDemoKeycloakUrl, assertPublicDemoDatabaseIdentity } from './provision-public-demo-accounts.mjs';

if (process.argv[2] !== '--apply' || process.env.PUBLIC_DEMO_ADD_KAM !== '1') throw new Error('Use --apply with PUBLIC_DEMO_ADD_KAM=1.');
const base = assertPublicDemoKeycloakUrl(process.env.KEYCLOAK_URL);
assertPublicDemoDatabaseUrl(process.env.DATABASE_URL);
const username = 'kam.polina';
const name = 'Полина Васильева';
const credentialsFile = '/credentials/kam-polina.txt';
const directory = await lstat('/credentials');
if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error('Private credentials directory is required.');
if (await lstat(credentialsFile).catch(() => null)) throw new Error('Credential file already exists.');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const identity = await db.query("SELECT current_database() AS database, shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database') AS marker");
  assertPublicDemoDatabaseIdentity(identity.rows[0]);
  if ((await db.query('SELECT count(*)::integer AS count FROM known_crm_users WHERE display_name=$1', [name])).rows[0].count) throw new Error('CRM name already exists.');
  const tokenResponse = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KC_ADMIN_USER, password: process.env.KC_ADMIN_PASSWORD }),
  });
  if (!tokenResponse.ok) throw new Error('Keycloak administrator authentication failed.');
  const token = (await tokenResponse.json()).access_token;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const existingResponse = await fetch(`${base}/admin/realms/lct/users?username=${username}&exact=true`, { headers });
  if (!existingResponse.ok || (await existingResponse.json()).length) throw new Error('Account exists or identity check failed.');
  const roleResponse = await fetch(`${base}/admin/realms/lct/roles/kam`, { headers });
  if (!roleResponse.ok) throw new Error('KAM role missing.');
  const role = await roleResponse.json();
  const password = randomBytes(32).toString('base64url');
  const file = await open(credentialsFile, 'wx', 0o600);
  try { await file.writeFile(`${username}\t${password}\n`); await file.sync(); } finally { await file.close(); }
  const created = await fetch(`${base}/admin/realms/lct/users`, { method: 'POST', headers, body: JSON.stringify({ username, firstName: 'Полина', lastName: 'Васильева', email: 'polina.vasilieva@crm.futura.team', enabled: true, emailVerified: true }) });
  if (created.status !== 201) throw new Error(`Keycloak account creation failed (${created.status}).`);
  const sub = created.headers.get('location')?.split('/').at(-1);
  if (!sub) throw new Error('Keycloak did not return a user id.');
  for (const [endpoint, method, body] of [
    [`users/${sub}/reset-password`, 'PUT', { type: 'password', value: password, temporary: false }],
    [`users/${sub}/role-mappings/realm`, 'POST', [role]],
  ]) {
    const response = await fetch(`${base}/admin/realms/lct/${endpoint}`, { method, headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Keycloak setup failed (${response.status}).`);
  }
  await db.query('BEGIN');
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('crm-access-policy'))");
    await db.query("INSERT INTO known_crm_users(user_sub,display_name,realm_roles,provision_source,last_seen_at) VALUES($1,$2,ARRAY['kam']::text[],'public-demo-provisioning',now())", [sub, name]);
    await db.query("INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source,updated_at) VALUES($1,$2,true,'public-demo-provisioning',now())", [sub, name]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  console.log('Additional KAM created; credentials saved privately.');
} finally { await db.end(); }
