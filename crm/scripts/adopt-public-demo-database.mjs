#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildKeycloakSubjectMap, buildSyntheticDemoSeed } from './seed-synthetic-demo.mjs';
import {
  assertPublicDemoDatabaseUrl, assertPublicDemoDatabaseIdentity, assertPublicDemoKeycloakUrl,
  PUBLIC_DEMO_DATABASE, PUBLIC_DEMO_DATABASE_MARKER,
} from './provision-public-demo-accounts.mjs';

const users = buildSyntheticDemoSeed().users;
const REQUIRED_TABLES = ['known_crm_users', 'kam_directory', 'organizations', 'people', 'activities', 'tasks', 'activity_events', 'report_jobs', 'report_snapshot_rows'];
const EMPTY_REPORT_JOBS_LIMIT = 1;
const NON_BUSINESS_TABLES = new Set([
  'schema_migrations', 'known_crm_users', 'kam_directory',
  // These tables contain versioned application catalogs or built-in guidance/config seeds.
  'products', 'workflow_stages', 'workflow_transitions', 'learning_programs', 'university_step_definitions',
  'workflow_config_revisions', 'stage_guidance_articles',
]);

export function parseAdoptionArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) return { dryRun: true };
  if (args.length === 1 && args[0] === '--adopt-public-demo') return { apply: true };
  throw new Error('Use --dry-run (default), --adopt-public-demo, or --help. Adoption requires PUBLIC_DEMO_ADOPT=1.');
}

export function assertAdoptionOptIn(env = process.env) {
  if (env.PUBLIC_DEMO_ADOPT !== '1') throw new Error('Set PUBLIC_DEMO_ADOPT=1 and pass --adopt-public-demo to adopt the existing public demo database.');
}

function quotePublicTable(tableName) {
  if (typeof tableName !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(tableName)) {
    throw new Error('Public CRM contains an unexpected table identifier; adoption was stopped.');
  }
  return `public."${tableName}"`;
}

async function publicTableNames(client) {
  const result = await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  const names = result.rows.map((row) => row.table_name);
  const set = new Set(names);
  const missing = REQUIRED_TABLES.filter((name) => !set.has(name));
  if (missing.length) throw new Error('CRM migrations are incomplete; start the public API and wait for migrations before adoption.');
  return names;
}

function assertFourCRMAccounts(knownRows, kamRows, subjects) {
  const expectedUsers = users.map((user) => ({ ...user, sub: subjects.get(user.username) }));
  if (expectedUsers.some((user) => typeof user.sub !== 'string' || !user.sub)
    || new Set(expectedUsers.map((user) => user.sub)).size !== users.length) {
    throw new Error('Keycloak did not resolve four distinct public-demo subjects.');
  }
  if (knownRows.length !== users.length || expectedUsers.some((expected) => {
    const row = knownRows.find((candidate) => candidate.user_sub === expected.sub);
    const roles = Array.isArray(row?.realm_roles) ? row.realm_roles.filter((role) => ['kam', 'manager', 'admin'].includes(role)).sort() : [];
    return !row || row.display_name !== expected.name || row.provision_source !== 'public-demo-provisioning' || row.disabled_at !== null
      || JSON.stringify(roles) !== JSON.stringify([...expected.roles].sort());
  })) {
    throw new Error('Adoption requires exactly the four expected CRM users with public-demo-provisioning source and matching roles.');
  }

  const expectedKams = expectedUsers.filter((user) => user.roles.includes('kam'));
  if (kamRows.length !== expectedKams.length || expectedKams.some((expected) => {
    const row = kamRows.find((candidate) => candidate.user_sub === expected.sub);
    return !row || row.display_name !== expected.name || row.enabled !== true || row.provision_source !== 'public-demo-provisioning';
  })) {
    throw new Error('Adoption requires exactly two enabled KAM directory rows with public-demo-provisioning source.');
  }
  return { users: expectedUsers.length, kamAccounts: expectedKams.length };
}

function containsRowsProperty(value) {
  if (Array.isArray(value)) return value.some(containsRowsProperty);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key === 'rows' || containsRowsProperty(child));
}

export function assertAdoptableEmptyReportJobs(rows, subjects) {
  if (rows.length > EMPTY_REPORT_JOBS_LIMIT) {
    throw new Error(`Adoption permits at most ${EMPTY_REPORT_JOBS_LIMIT} pre-existing empty crm_portfolio snapshot; other report jobs are not allowed.`);
  }
  const userBySubject = new Map(users.map((user) => [subjects.get(user.username), user]));
  for (const row of rows) {
    const actor = userBySubject.get(row.actor_sub);
    if (!actor || row.job_type !== 'snapshot' || row.report_id !== 'crm_portfolio' || row.actor_name !== actor.name
      || Number(row.row_count) !== 0 || row.status !== 'completed' || row.source_snapshot_id != null
      || row.format != null || row.file_key != null || row.file_name != null || row.media_type != null
      || row.file_size != null || row.file_sha256 != null || !row.payload || typeof row.payload !== 'object'
      || Array.isArray(row.payload) || containsRowsProperty(row.payload)
      || !row.parameters || typeof row.parameters !== 'object' || Array.isArray(row.parameters)
      || containsRowsProperty(row.parameters)
      || (row.payload.rowCount != null && Number(row.payload.rowCount) !== 0)) {
      throw new Error('Adoption only permits a completed empty crm_portfolio snapshot by one of the four provisioned users, with no export/file artifacts or embedded rows.');
    }
  }
  return rows.length;
}

export async function verifyExistingPublicDemoDatabase(client, subjects) {
  const identityResult = await client.query(`SELECT current_database() AS database,
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database') AS marker`);
  const identity = identityResult.rows[0] ?? {};
  assertPublicDemoDatabaseIdentity(identity, { requireMarker: false });
  if (identity.marker === PUBLIC_DEMO_DATABASE_MARKER) return { alreadyMarked: true, database: PUBLIC_DEMO_DATABASE, marker: identity.marker };

  const [knownResult, kamResult] = await Promise.all([
    client.query('SELECT user_sub,display_name,realm_roles,provision_source,disabled_at FROM known_crm_users'),
    client.query('SELECT user_sub,display_name,enabled,provision_source FROM kam_directory'),
  ]);
  const accounts = assertFourCRMAccounts(knownResult.rows, kamResult.rows, subjects);
  const tableNames = await publicTableNames(client);
  const reportJobsResult = await client.query(`SELECT job_type,report_id,actor_sub,actor_name,parameters,payload,
    source_snapshot_id,format,file_key,file_name,media_type,file_size,file_sha256,row_count,status FROM report_jobs`);
  const allowedEmptyReportJobs = assertAdoptableEmptyReportJobs(reportJobsResult.rows, subjects);
  const businessTables = tableNames.filter((name) => !NON_BUSINESS_TABLES.has(name) && name !== 'report_jobs');
  const counts = [];
  for (const tableName of businessTables) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${quotePublicTable(tableName)}`);
    const count = Number(result.rows[0]?.count);
    if (!Number.isInteger(count) || count !== 0) {
      throw new Error(`Adoption requires empty business tables; ${tableName} contains ${Number.isInteger(count) ? count : 'unknown'} rows.`);
    }
    counts.push({ table: tableName, rows: count });
  }
  return { alreadyMarked: false, database: PUBLIC_DEMO_DATABASE, marker: null, accounts, allowedEmptyReportJobs, businessTables: counts };
}

export async function adoptExistingPublicDemoDatabase(client, subjects, { dryRun = false, env = process.env } = {}) {
  if (dryRun) return { mode: 'dry-run', ...(await verifyExistingPublicDemoDatabase(client, subjects)), changed: false };
  assertAdoptionOptIn(env);

  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('public-demo-database-marker-adoption-v1'))");
    const tables = await publicTableNames(client);
    const lockList = tables.map(quotePublicTable).join(',');
    await client.query(`LOCK TABLE ${lockList} IN SHARE MODE`);
    const state = await verifyExistingPublicDemoDatabase(client, subjects);
    if (state.alreadyMarked) {
      await client.query('COMMIT');
      return { mode: 'apply', ...state, changed: false };
    }
    await client.query(`COMMENT ON DATABASE lctcrm IS '${PUBLIC_DEMO_DATABASE_MARKER}'`);
    await client.query('COMMIT');
    return { mode: 'apply', ...state, marker: PUBLIC_DEMO_DATABASE_MARKER, changed: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function resolveAndVerifyPublicDemoKeycloakAccounts({ baseUrl, adminUser, adminPassword, fetchImpl = fetch }) {
  const base = assertPublicDemoKeycloakUrl(baseUrl);
  if (!adminUser || !adminPassword) throw new Error('Public-demo Keycloak administrator credentials are missing.');
  let tokenResponse;
  try {
    tokenResponse = await fetchImpl(`${base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUser, password: adminPassword }),
    });
  } catch {
    throw new Error('Could not reach public-demo Keycloak over the private Compose network.');
  }
  if (!tokenResponse.ok) throw new Error('Could not authenticate to public-demo Keycloak.');
  const tokenPayload = await tokenResponse.json();
  if (typeof tokenPayload?.access_token !== 'string' || !tokenPayload.access_token) throw new Error('Public-demo Keycloak returned no access token.');
  const headers = { authorization: `Bearer ${tokenPayload.access_token}`, accept: 'application/json' };
  const keycloakUsers = [];
  for (const user of users) {
    let response;
    try {
      response = await fetchImpl(`${base}/admin/realms/lct/users?username=${encodeURIComponent(user.username)}&exact=true`, { redirect: 'error', headers });
    } catch {
      throw new Error('Could not read public-demo Keycloak accounts.');
    }
    if (!response.ok) throw new Error('Could not read public-demo Keycloak accounts.');
    const matches = await response.json();
    if (!Array.isArray(matches)) throw new Error('Public-demo Keycloak returned an invalid account list.');
    keycloakUsers.push(...matches);
  }
  const subjects = buildKeycloakSubjectMap(users, keycloakUsers);

  for (const user of users) {
    const id = subjects.get(user.username);
    let profileResponse;
    let rolesResponse;
    try {
      [profileResponse, rolesResponse] = await Promise.all([
        fetchImpl(`${base}/admin/realms/lct/users/${encodeURIComponent(id)}`, { redirect: 'error', headers }),
        fetchImpl(`${base}/admin/realms/lct/users/${encodeURIComponent(id)}/role-mappings/realm`, { redirect: 'error', headers }),
      ]);
    } catch {
      throw new Error('Could not verify public-demo Keycloak account roles.');
    }
    if (!profileResponse.ok || !rolesResponse.ok) throw new Error('Could not verify public-demo Keycloak account roles.');
    const [profile, assignedRoles] = await Promise.all([profileResponse.json(), rolesResponse.json()]);
    if (profile?.id !== id || profile?.username !== user.username || profile?.enabled !== true || !Array.isArray(assignedRoles)) {
      throw new Error(`Keycloak account ${user.username} is missing or disabled; adoption was stopped.`);
    }
    const appRoles = assignedRoles.map((role) => role?.name).filter((name) => ['kam', 'manager', 'admin'].includes(name)).sort();
    if (JSON.stringify(appRoles) !== JSON.stringify([...user.roles].sort())) {
      throw new Error(`Keycloak account ${user.username} does not have exactly its expected CRM role; adoption was stopped.`);
    }
  }
  return subjects;
}

function help() {
  console.log(`Adopt an existing public-demo CRM database after accounts were provisioned before the marker was added.

Preview the read-only checks:
  node scripts/adopt-public-demo-database.mjs --dry-run

Set the database marker after all checks pass:
  PUBLIC_DEMO_ADOPT=1 node scripts/adopt-public-demo-database.mjs --adopt-public-demo

The command accepts only postgres:5432/lctcrm and http://keycloak:8080,
confirms the four exact enabled Keycloak users and roles, their CRM rows and
two enabled KAM directory rows, empty business tables, and at most one completed
row-free crm_portfolio snapshot with no export/file metadata.
It writes only the database comment marker; it never creates users or prints credentials.
`);
}

async function main() {
  let options;
  try { options = parseAdoptionArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { help(); return; }
  if (options.apply) assertAdoptionOptIn();
  const databaseUrl = process.env.DATABASE_URL;
  assertPublicDemoDatabaseUrl(databaseUrl);
  const baseUrl = assertPublicDemoKeycloakUrl(process.env.KEYCLOAK_URL ?? 'http://keycloak:8080');
  const subjects = await resolveAndVerifyPublicDemoKeycloakAccounts({
    baseUrl, adminUser: process.env.KC_ADMIN_USER, adminPassword: process.env.KC_ADMIN_PASSWORD,
  });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await adoptExistingPublicDemoDatabase(client, subjects, { dryRun: options.dryRun });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
