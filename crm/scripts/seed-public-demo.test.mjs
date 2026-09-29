import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertOrMarkPublicDemoDatabase, assertPublicDemoDatabaseIdentity, assertPublicDemoDatabaseUrl,
  assertPublicDemoKeycloakUrl, assertPublicDemoSeedOptIn,
  PUBLIC_DEMO_DATABASE_MARKER,
} from './provision-public-demo-accounts.mjs';
import {
  assertProvisionedPublicAccounts, buildPublicDemoSeed, parsePublicSeedArgs,
  resolvePublicDemoKeycloakSubjects, seedPublicDemo, verifyPublicDemoSeedRows,
} from './seed-public-demo.mjs';

test('public seed is dry-run by default and requires both an exact apply flag and explicit opt-in', () => {
  assert.deepEqual(parsePublicSeedArgs([]), { dryRun: true });
  assert.deepEqual(parsePublicSeedArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parsePublicSeedArgs(['--apply-public-demo']), { apply: true });
  assert.deepEqual(parsePublicSeedArgs(['--help']), { help: true });
  assert.throws(() => parsePublicSeedArgs(['--apply-public-demo', '--database-url=x']), /Use --dry-run/);
  assert.throws(() => assertPublicDemoSeedOptIn({}), /PUBLIC_DEMO_SEED=1/);
  assert.doesNotThrow(() => assertPublicDemoSeedOptIn({ PUBLIC_DEMO_SEED: '1' }));
});

test('public target validation accepts only the fixed private Compose services and marked CRM database', () => {
  assert.equal(assertPublicDemoDatabaseUrl('postgresql://lctcrm:secret@postgres:5432/lctcrm').hostname, 'postgres');
  assert.equal(assertPublicDemoKeycloakUrl('http://keycloak:8080/'), 'http://keycloak:8080');
  assert.doesNotThrow(() => assertPublicDemoDatabaseIdentity({ database: 'lctcrm', marker: PUBLIC_DEMO_DATABASE_MARKER }));
  for (const target of [
    'postgresql://lctcrm:secret@localhost:5432/lctcrm',
    'postgresql://lctcrm:secret@production-db:5432/lctcrm',
    'postgresql://lctcrm:secret@postgres:5432/production',
    'postgresql://admin:secret@postgres:5432/lctcrm',
    'postgresql://lctcrm:secret@postgres:5433/lctcrm',
    'postgresql://lctcrm:secret@postgres:5432/lctcrm?options=-csearch_path%3Dpublic',
  ]) assert.throws(() => assertPublicDemoDatabaseUrl(target));
  assert.throws(() => assertPublicDemoKeycloakUrl('https://auth.example.test'), /private Compose network/);
  assert.throws(() => assertPublicDemoDatabaseIdentity({ database: 'lctcrm', marker: null }), /isolation marker/);
  assert.throws(() => assertPublicDemoDatabaseIdentity({ database: 'lctcrm', marker: 'production' }), /isolation marker/);
  assert.throws(() => assertPublicDemoDatabaseIdentity({ database: 'production', marker: PUBLIC_DEMO_DATABASE_MARKER }), /identity mismatch/);
});

test('public marker is initialized only for an empty unmarked application database', async () => {
  const statements = [];
  const emptyClient = { query: async (sql) => {
    statements.push(sql);
    if (sql.includes('current_database()')) return { rows: [{ database: 'lctcrm', marker: null }] };
    if (sql.includes('known_crm_users')) return { rows: [{ known_users: 0, kam_users: 0, organizations: 0, people: 0, activities: 0, tasks: 0, events: 0 }] };
    return { rowCount: 1 };
  } };
  assert.deepEqual(await assertOrMarkPublicDemoDatabase(emptyClient), { marked: true });
  assert.ok(statements.some((sql) => sql.includes(`COMMENT ON DATABASE lctcrm IS '${PUBLIC_DEMO_DATABASE_MARKER}'`)));

  const existingClient = { query: async (sql) => {
    if (sql.includes('current_database()')) return { rows: [{ database: 'lctcrm', marker: null }] };
    return { rows: [{ known_users: 1, kam_users: 0, organizations: 0, people: 0, activities: 0, tasks: 0, events: 0 }] };
  } };
  await assert.rejects(() => assertOrMarkPublicDemoDatabase(existingClient), /already contains access or demo activity data/);

  const wrongMarkerClient = { query: async () => ({ rows: [{ database: 'lctcrm', marker: 'production' }] }) };
  await assert.rejects(() => assertOrMarkPublicDemoDatabase(wrongMarkerClient), /different isolation marker/);
});

test('public fixture keeps the useful synthetic CRM detail while omitting completions and LMS facts', () => {
  const fixture = buildPublicDemoSeed();
  assert.equal(fixture.organizations.length, 4);
  assert.equal(fixture.people.length, 7);
  assert.equal(fixture.activities.length, 11);
  assert.equal(fixture.tasks.length, 14);
  assert.equal(fixture.events.length, 48);
  assert.ok(fixture.tasks.every((task) => task.status === 'open' && task.completedAt === null));
  assert.ok(fixture.events.every((event) => event.type !== 'task_completed'));
  assert.ok(fixture.events.every((event) => !event.details.factKind && !/lms|enrollment|learning_completed/i.test(event.type)));
  assert.equal('individualLearningFacts' in fixture, false);
  assert.ok(fixture.people.every((person) => person.email === undefined));
  assert.equal(fixture.universityContractLicenses.every((record) => record.documentId === null), true);
});

test('public account resolution uses exact usernames and rejects non-provisioned CRM identity rows', async () => {
  const keycloak = [
    { username: 'admin', id: 'fc5227db-45e4-4da9-b4c7-a2a20176e5df' },
    { username: 'kam.dmitry', id: '639640d4-8f2f-47fe-8107-5adc5c72dcd0' },
    { username: 'manager', id: '8da8d1f5-f0ec-48d4-8662-b13d7b975622' },
    { username: 'kam.anna', id: '620e4e31-3301-4396-95e7-b77d4eebd5e0' },
  ];
  let requestIndex = 0;
  const fetchImpl = async (url) => {
    requestIndex++;
    if (url.includes('/realms/master/')) return { ok: true, json: async () => ({ access_token: 'test-token' }) };
    const username = new URL(url).searchParams.get('username');
    return { ok: true, json: async () => keycloak.filter((row) => row.username === username) };
  };
  const subjects = await resolvePublicDemoKeycloakSubjects({ baseUrl: 'http://keycloak:8080', adminUser: 'admin', adminPassword: 'secret', fetchImpl });
  assert.equal(subjects.get('kam.anna'), keycloak[3].id);
  assert.equal(requestIndex, 5);

  const fixture = buildPublicDemoSeed();
  const knownRows = fixture.users.map((user) => ({
    user_sub: subjects.get(user.username), display_name: user.name, realm_roles: user.roles, provision_source: 'public-demo-provisioning',
  }));
  const kamRows = fixture.users.filter((user) => user.roles.includes('kam')).map((user) => ({
    user_sub: subjects.get(user.username), display_name: user.name, enabled: true, provision_source: 'public-demo-provisioning',
  }));
  const client = { query: async (sql) => sql.includes('known_crm_users') ? { rows: knownRows, rowCount: knownRows.length } : { rows: kamRows, rowCount: kamRows.length } };
  assert.equal((await assertProvisionedPublicAccounts(client, subjects)).length, 4);
  await assert.rejects(() => assertProvisionedPublicAccounts({ query: async () => ({ rows: [], rowCount: 0 }) }, subjects), /must already be provisioned/);
});

test('public row verification rejects an ID collision with a completed task', async () => {
  const fixture = buildPublicDemoSeed();
  const subjects = new Map(fixture.users.map((user, index) => [user.username, `public-sub-${index}`]));
  const iso = (value) => new Date(value);
  const tables = {
    organizations: fixture.organizations.map((r) => ({ id: r.id, name: r.name, segment: r.segment, created_at: iso(r.createdAt) })),
    people: fixture.people.map((r) => ({ id: r.id, full_name: r.fullName, organization_name: r.organizationName, created_at: iso(r.createdAt) })),
    activities: fixture.activities.map((r) => ({ id: r.id, kind: r.kind, title: r.title, origin: 'manual', route_version: r.routeVersion,
      organization_id: r.organizationId, person_id: r.personId, stage_key: r.stageKey, owner_sub: subjects.get(r.owner.username),
      owner_name: r.owner.name, priority: r.priority, created_at: iso(r.createdAt), updated_at: iso(r.updatedAt) })),
    tasks: fixture.tasks.map((r) => ({ id: r.id, activity_id: r.activityId, title: r.title, due_at: iso(r.dueAt), status: r.status,
      owner_sub: subjects.get(r.owner.username), owner_name: r.owner.name, completed_at: null, created_at: iso(r.createdAt) })),
    activity_events: fixture.events.map((r) => ({ id: r.id, activity_id: r.activity.id, event_type: r.type, summary: r.summary, details: r.details,
      actor_sub: subjects.get(r.actor.username), actor_name: r.actor.name, created_at: iso(r.at) })),
    activity_products: fixture.activityProducts.map(([activity_id, product_id]) => ({ activity_id, catalog_id: product_id })),
    activity_programs: fixture.activityPrograms.map(([activity_id, program_id]) => ({ activity_id, catalog_id: program_id })),
    corporate_activity_plans: fixture.corporatePlans.map((r) => ({ activity_id: r.activity.id, program_mode: r.programMode, requested_places: r.requestedPlaces,
      brief: r.brief, methodologist: r.methodologist, proposed: r.proposed, agreed: r.agreed, approval: r.approval, revision: r.revision,
      updated_at: iso(r.updatedAt), actor_sub: subjects.get(r.actor.username), actor_name: r.actor.name })),
    activity_university_steps: fixture.universitySteps.map((r) => ({ activity_id: r.activity.id, step_id: r.stepId, status: r.status, note: r.note,
      evidence_reference: null, evidence_source: null, actor_sub: subjects.get(r.activity.owner.username), actor_name: r.activity.owner.name,
      updated_at: iso(r.updatedAt), revision: 1 })),
  };
  const client = { query: async (sql) => {
    const table = Object.keys(tables).find((name) => sql.includes(`FROM ${name}`));
    return { rows: tables[table] ?? [], rowCount: tables[table]?.length ?? 0 };
  } };
  await assert.doesNotReject(() => verifyPublicDemoSeedRows(client, { subFor: (user) => subjects.get(user.username) }));
  tables.tasks[0].status = 'done';
  tables.tasks[0].completed_at = new Date('2026-09-19T14:00:00.000Z');
  await assert.rejects(() => verifyPublicDemoSeedRows(client, { subFor: (user) => subjects.get(user.username) }), /conflicting task row/);
});

test('public apply path is append-only and skips legacy subject/label rewrites', async () => {
  const fixture = buildPublicDemoSeed();
  const subjects = new Map(fixture.users.map((user, index) => [user.username, `public-sub-${index}`]));
  const knownRows = fixture.users.map((user) => ({ user_sub: subjects.get(user.username), display_name: user.name,
    realm_roles: user.roles, provision_source: 'public-demo-provisioning' }));
  const kamRows = fixture.users.filter((user) => user.roles.includes('kam')).map((user) => ({ user_sub: subjects.get(user.username),
    display_name: user.name, enabled: true, provision_source: 'public-demo-provisioning' }));
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (sql.includes('FROM known_crm_users') && sql.includes('WHERE user_sub=ANY')) return { rows: knownRows, rowCount: knownRows.length };
    if (sql.includes('FROM kam_directory') && sql.includes('WHERE user_sub=ANY')) return { rows: kamRows, rowCount: kamRows.length };
    if (sql.includes('current_database()')) return { rows: [{ database: 'lctcrm', marker: PUBLIC_DEMO_DATABASE_MARKER }] };
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
    if (sql.startsWith('INSERT')) return { rowCount: 1, rows: [] };
    return { rowCount: 0, rows: [] };
  } };
  await assert.rejects(() => seedPublicDemo(client, subjects, {}), /PUBLIC_DEMO_SEED=1/);
  assert.equal(statements.length, 0, 'the exported apply path checks opt-in before querying the database');
  await assert.rejects(() => seedPublicDemo(client, subjects, { PUBLIC_DEMO_SEED: '1' }), /Seed verification failed for organizations/);
  assert.ok(statements.some((sql) => sql.startsWith('ROLLBACK')));
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO activities')));
  assert.ok(statements.every((sql) => !/^\s*(UPDATE|DELETE\s+FROM)\b/i.test(sql)), 'public seed never updates or deletes existing rows');
});
