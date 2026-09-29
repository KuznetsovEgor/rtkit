#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import {
  buildKeycloakSubjectMap, buildSyntheticDemoSeed, seedSyntheticDemoRows,
} from './seed-synthetic-demo.mjs';
import {
  assertPublicDemoDatabaseIdentity, assertPublicDemoDatabaseUrl, assertPublicDemoKeycloakUrl,
  assertPublicDemoSeedOptIn, PUBLIC_DEMO_DATABASE, PUBLIC_DEMO_DATABASE_MARKER,
} from './provision-public-demo-accounts.mjs';

export const PUBLIC_DEMO_SEED_SOURCE = 'public-demo-synthetic-seed-v1';
const fixtureUsers = buildSyntheticDemoSeed().users;

export function parsePublicSeedArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) return { dryRun: true };
  if (args.length === 1 && args[0] === '--apply-public-demo') return { apply: true };
  throw new Error('Use --dry-run (default), --apply-public-demo, or --help. Public demo seeding requires the explicit PUBLIC_DEMO_SEED=1 opt-in.');
}

export function buildPublicDemoSeed() {
  const fixture = buildSyntheticDemoSeed();
  fixture.tasks = fixture.tasks.map((task) => ({ ...task, status: 'open', completedAt: null }));
  fixture.events = fixture.events.filter((event) => event.type !== 'task_completed');
  return fixture;
}

export async function resolvePublicDemoKeycloakSubjects({ baseUrl, adminUser, adminPassword, fetchImpl = fetch }) {
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

  const keycloakUsers = [];
  for (const user of fixtureUsers) {
    let response;
    try {
      response = await fetchImpl(`${base}/admin/realms/lct/users?username=${encodeURIComponent(user.username)}&exact=true`, {
        redirect: 'error', headers: { authorization: `Bearer ${tokenPayload.access_token}`, accept: 'application/json' },
      });
    } catch {
      throw new Error('Could not read demo accounts from public-demo Keycloak.');
    }
    if (!response.ok) throw new Error('Could not read demo accounts from public-demo Keycloak.');
    const matches = await response.json();
    if (!Array.isArray(matches)) throw new Error('Public-demo Keycloak returned an invalid account list.');
    keycloakUsers.push(...matches);
  }
  return buildKeycloakSubjectMap(fixtureUsers, keycloakUsers);
}

export async function assertProvisionedPublicAccounts(client, subjects) {
  const users = fixtureUsers.map((user) => ({ ...user, sub: subjects.get(user.username) }));
  if (users.some((user) => typeof user.sub !== 'string' || !user.sub)) throw new Error('Public-demo Keycloak did not resolve all four account subjects.');
  const expectedSubs = users.map((user) => user.sub);
  const known = await client.query(`SELECT user_sub,display_name,realm_roles,provision_source FROM known_crm_users
    WHERE user_sub=ANY($1::text[])`, [expectedSubs]);
  if (known.rowCount !== users.length || users.some((user) => {
    const row = known.rows.find((candidate) => candidate.user_sub === user.sub);
    const roles = Array.isArray(row?.realm_roles) ? row.realm_roles.filter((role) => ['kam', 'manager', 'admin'].includes(role)).sort() : [];
    return !row || row.display_name !== user.name || JSON.stringify(roles) !== JSON.stringify([...user.roles].sort())
      || row.provision_source !== 'public-demo-provisioning';
  })) throw new Error('All four public demo accounts must already be provisioned in CRM before seeding.');

  const expectedKams = users.filter((user) => user.roles.includes('kam'));
  const kams = await client.query(`SELECT user_sub,display_name,enabled,provision_source FROM kam_directory
    WHERE user_sub=ANY($1::text[])`, [expectedKams.map((user) => user.sub)]);
  if (kams.rowCount !== expectedKams.length || expectedKams.some((user) => {
    const row = kams.rows.find((candidate) => candidate.user_sub === user.sub);
    return !row || row.display_name !== user.name || row.enabled !== true || row.provision_source !== 'public-demo-provisioning';
  })) throw new Error('Both public demo KAM accounts must be enabled in the CRM directory before seeding.');
  return users;
}

function timestampMatches(actual, expected) {
  if (actual == null || expected == null) return actual === expected;
  return new Date(actual).toISOString() === new Date(expected).toISOString();
}

function conflictingFixtureRow(name) {
  throw new Error(`Public demo seed found a conflicting ${name} row; existing data was preserved.`);
}

export async function verifyPublicDemoSeedRows(client, { subFor } = {}) {
  const fixture = buildPublicDemoSeed();
  const orgs = await client.query('SELECT id,name,segment,created_at FROM organizations WHERE id=ANY($1::uuid[])', [fixture.organizations.map((row) => row.id)]);
  if (orgs.rowCount !== fixture.organizations.length || fixture.organizations.some((expected) => {
    const row = orgs.rows.find((candidate) => candidate.id === expected.id);
    return !row || row.name !== expected.name || row.segment !== expected.segment || !timestampMatches(row.created_at, expected.createdAt);
  })) conflictingFixtureRow('organization');

  const people = await client.query('SELECT id,full_name,organization_name,created_at FROM people WHERE id=ANY($1::uuid[])', [fixture.people.map((row) => row.id)]);
  if (people.rowCount !== fixture.people.length || fixture.people.some((expected) => {
    const row = people.rows.find((candidate) => candidate.id === expected.id);
    return !row || row.full_name !== expected.fullName || row.organization_name !== expected.organizationName || !timestampMatches(row.created_at, expected.createdAt);
  })) conflictingFixtureRow('person');

  const activities = await client.query(`SELECT id,kind,title,origin,route_version,organization_id,person_id,stage_key,
    owner_sub,owner_name,priority,created_at,updated_at FROM activities WHERE id=ANY($1::uuid[])`, [fixture.activities.map((row) => row.id)]);
  if (activities.rowCount !== fixture.activities.length || fixture.activities.some((expected) => {
    const row = activities.rows.find((candidate) => candidate.id === expected.id);
    return !row || row.kind !== expected.kind || row.title !== expected.title || row.origin !== 'manual'
      || row.route_version !== expected.routeVersion || row.organization_id !== expected.organizationId || row.person_id !== expected.personId
      || row.stage_key !== expected.stageKey || row.owner_sub !== subFor(expected.owner) || row.owner_name !== expected.owner.name
      || Number(row.priority) !== expected.priority || !timestampMatches(row.created_at, expected.createdAt)
      || !timestampMatches(row.updated_at, expected.updatedAt);
  })) conflictingFixtureRow('activity');

  const tasks = await client.query(`SELECT id,activity_id,title,due_at,status,owner_sub,owner_name,completed_at,created_at
    FROM tasks WHERE id=ANY($1::uuid[])`, [fixture.tasks.map((row) => row.id)]);
  if (tasks.rowCount !== fixture.tasks.length || fixture.tasks.some((expected) => {
    const row = tasks.rows.find((candidate) => candidate.id === expected.id);
    return !row || row.activity_id !== expected.activityId || row.title !== expected.title || !timestampMatches(row.due_at, expected.dueAt)
      || row.status !== 'open' || row.owner_sub !== subFor(expected.owner) || row.owner_name !== expected.owner.name
      || row.completed_at !== null || !timestampMatches(row.created_at, expected.createdAt);
  })) conflictingFixtureRow('task');

  const events = await client.query(`SELECT id,activity_id,event_type,summary,details,actor_sub,actor_name,created_at
    FROM activity_events WHERE id=ANY($1::uuid[])`, [fixture.events.map((row) => row.id)]);
  if (events.rowCount !== fixture.events.length || fixture.events.some((expected) => {
    const row = events.rows.find((candidate) => candidate.id === expected.id);
    return !row || row.activity_id !== expected.activity.id || row.event_type !== expected.type || row.summary !== expected.summary
      || !isDeepStrictEqual(row.details, expected.details) || row.actor_sub !== subFor(expected.actor)
      || row.actor_name !== expected.actor.name || !timestampMatches(row.created_at, expected.at);
  })) conflictingFixtureRow('history');

  for (const [table, foreignKey, pairs] of [
    ['activity_products', 'product_id', fixture.activityProducts],
    ['activity_programs', 'program_id', fixture.activityPrograms],
  ]) {
    const result = await client.query(`SELECT activity_id,${foreignKey} AS catalog_id FROM ${table} WHERE activity_id=ANY($1::uuid[])`,
      [[...new Set(fixture.activities.map((row) => row.id))]]);
    const actual = result.rows.map((row) => `${row.activity_id}:${row.catalog_id}`).sort();
    const expected = pairs.map(([activityId, catalogId]) => `${activityId}:${catalogId}`).sort();
    if (actual.length !== expected.length || !actual.every((value, index) => value === expected[index])) conflictingFixtureRow(`${table} links`);
  }

  const plans = await client.query(`SELECT activity_id,program_mode,requested_places,brief,methodologist,proposed,agreed,approval,
    revision,updated_at,actor_sub,actor_name FROM corporate_activity_plans WHERE activity_id=ANY($1::uuid[])`,
  [fixture.corporatePlans.map((row) => row.activity.id)]);
  if (plans.rowCount !== fixture.corporatePlans.length || fixture.corporatePlans.some((expected) => {
    const row = plans.rows.find((candidate) => candidate.activity_id === expected.activity.id);
    return !row || row.program_mode !== expected.programMode || Number(row.requested_places) !== expected.requestedPlaces
      || !isDeepStrictEqual(row.brief, expected.brief) || !isDeepStrictEqual(row.methodologist, expected.methodologist)
      || !isDeepStrictEqual(row.proposed, expected.proposed) || !isDeepStrictEqual(row.agreed, expected.agreed)
      || !isDeepStrictEqual(row.approval, expected.approval) || Number(row.revision) !== expected.revision
      || !timestampMatches(row.updated_at, expected.updatedAt) || row.actor_sub !== subFor(expected.actor) || row.actor_name !== expected.actor.name;
  })) conflictingFixtureRow('corporate plan');

  const steps = await client.query(`SELECT activity_id,step_id,status,note,evidence_reference,evidence_source,actor_sub,actor_name,updated_at,revision
    FROM activity_university_steps WHERE activity_id=ANY($1::uuid[])`, [fixture.universitySteps.map((row) => row.activity.id)]);
  if (steps.rowCount !== fixture.universitySteps.length || fixture.universitySteps.some((expected) => {
    const row = steps.rows.find((candidate) => candidate.activity_id === expected.activity.id && candidate.step_id === expected.stepId);
    return !row || row.status !== expected.status || row.note !== expected.note || row.evidence_reference !== null || row.evidence_source !== null
      || row.actor_sub !== subFor(expected.activity.owner) || row.actor_name !== expected.activity.owner.name
      || !timestampMatches(row.updated_at, expected.updatedAt) || Number(row.revision) !== 1;
  })) conflictingFixtureRow('university step');
}

export async function seedPublicDemo(client, subjects, env = process.env) {
  assertPublicDemoSeedOptIn(env);
  const fixture = buildPublicDemoSeed();
  await assertProvisionedPublicAccounts(client, subjects);
  return seedSyntheticDemoRows(client, subjects, {
    targetGuard: (identity) => assertPublicDemoDatabaseIdentity(identity),
    seedSource: PUBLIC_DEMO_SEED_SOURCE,
    tasks: fixture.tasks,
    events: fixture.events,
    upgradeLegacyRows: false,
    kamProvisionSources: ['public-demo-provisioning'],
    verifyExtra: verifyPublicDemoSeedRows,
  });
}

function help() {
  console.log(`Seed the marked public-demo CRM database after all four public accounts are provisioned.

Preview the deterministic fixture:
  node scripts/seed-public-demo.mjs --dry-run

Apply from the public-demo Compose network:
  PUBLIC_DEMO_SEED=1 node scripts/seed-public-demo.mjs --apply-public-demo

The apply requires PUBLIC_DEMO_SEED=1, the fixed postgres:5432/lctcrm target,
the public-demo database marker, and the four already-provisioned Keycloak accounts.
It resolves live Keycloak subjects and only inserts deterministic synthetic rows.
Existing rows are preserved; ID conflicts must verify as the same fixture. No
task completions, payments, documents, or LMS learning facts are seeded.
`);
}

async function main() {
  let options;
  try { options = parsePublicSeedArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { help(); return; }
  if (options.dryRun) {
    const fixture = buildPublicDemoSeed();
    console.log(JSON.stringify({ mode: 'dry-run', database: PUBLIC_DEMO_DATABASE, marker: PUBLIC_DEMO_DATABASE_MARKER,
      processes: ['university', 'corporate', 'individual'], accountsRequired: fixtureUsers.map((user) => user.username),
      plannedRows: { organizations: fixture.organizations.length, people: fixture.people.length, activities: fixture.activities.length,
        tasks: fixture.tasks.length, openTasks: fixture.tasks.filter((task) => task.status === 'open').length,
        history: fixture.events.length, productLinks: fixture.activityProducts.length, programLinks: fixture.activityPrograms.length,
        corporatePlans: fixture.corporatePlans.length, universitySteps: fixture.universitySteps.length,
        universityContractLicenses: fixture.universityContractLicenses.length }, lmsFacts: 0, payments: 0, completedTasks: 0 }, null, 2));
    return;
  }

  assertPublicDemoSeedOptIn();
  const databaseUrl = process.env.DATABASE_URL;
  assertPublicDemoDatabaseUrl(databaseUrl);
  const baseUrl = assertPublicDemoKeycloakUrl(process.env.KEYCLOAK_URL ?? 'http://keycloak:8080');
  const adminUser = process.env.KC_ADMIN_USER;
  const adminPassword = process.env.KC_ADMIN_PASSWORD;
  const subjects = await resolvePublicDemoKeycloakSubjects({ baseUrl, adminUser, adminPassword });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const identity = await client.query(`SELECT current_database() AS database,
      shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database') AS marker`);
    assertPublicDemoDatabaseIdentity(identity.rows[0] ?? {});
    await client.query('SELECT user_sub FROM known_crm_users LIMIT 0');
    await client.query('SELECT user_sub FROM kam_directory LIMIT 0');
    const inserted = await seedPublicDemo(client, subjects);
    console.log(JSON.stringify({ database: PUBLIC_DEMO_DATABASE, marker: PUBLIC_DEMO_DATABASE_MARKER,
      inserted, completedTasks: 0, payments: 0, lmsFacts: 0 }, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
