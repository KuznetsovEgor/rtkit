import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertLocalKeycloakUrl, assertTargetDatabase, buildKeycloakSubjectMap, buildSyntheticDemoSeed,
  DEMO_DATABASE, DEMO_MARKER, migrateSeedSubjectReferences, parseArgs, seedUniversityContractLicenses,
  syntheticDemoSeed, upgradePriorVisibleLabels, verifyUniversityContractLicenses,
} from './seed-synthetic-demo.mjs';

test('preview is the default and apply requires the explicit local-demo flag', () => {
  assert.deepEqual(parseArgs([]), { dryRun: true });
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseArgs(['--apply-local-demo']), { apply: true });
  assert.deepEqual(parseArgs(['--help']), { help: true });
});

test('argument parsing rejects database or environment overrides', () => {
  assert.throws(() => parseArgs(['--apply-local-demo', '--database-url=postgres://remote']), /Database overrides are not supported/);
  assert.throws(() => parseArgs(['--apply-local-demo', '--force']), /Database overrides are not supported/);
});

test('database guard accepts only the marked fixed loopback demo database', () => {
  assert.doesNotThrow(() => assertTargetDatabase({ host: '127.0.0.1', port: 54329, database: DEMO_DATABASE, marker: DEMO_MARKER }));
  for (const target of [
    { host: 'db.example.net', port: 54329, database: DEMO_DATABASE, marker: DEMO_MARKER },
    { host: '127.0.0.1', port: 5432, database: DEMO_DATABASE, marker: DEMO_MARKER },
    { host: '127.0.0.1', port: 54329, database: 'lctcrm', marker: DEMO_MARKER },
    { host: '127.0.0.1', port: 54329, database: DEMO_DATABASE, marker: null },
  ]) assert.throws(() => assertTargetDatabase(target));
});

test('role subjects match the fixed local Keycloak test accounts', async () => {
  const provisioner = await readFile(new URL('./provision-keycloak.mjs', import.meta.url), 'utf8');
  for (const user of syntheticDemoSeed.users) {
    const row = provisioner.split(/\r?\n/).find((line) => line.includes(`username: '${user.username}'`));
    assert.ok(row, `local account ${user.username} is provisioned by username`);
    assert.ok(row.includes(`role: '${user.roles[0]}'`), `local account ${user.username} has the expected app role`);
  }
});

test('Keycloak subject mapping uses exact QA usernames and rejects incomplete or unsafe identity results', () => {
  const actual = [
    { username: 'admin', id: 'fc5227db-45e4-4da9-b4c7-a2a20176e5df' },
    { username: 'kam.dmitry', id: '639640d4-8f2f-47fe-8107-5adc5c72dcd0' },
    { username: 'manager', id: '8da8d1f5-f0ec-48d4-8662-b13d7b975622' },
    { username: 'kam.anna', id: '620e4e31-3301-4396-95e7-b77d4eebd5e0' },
    { username: 'unrelated-user', id: 'e93dc810-bddc-4ce8-8dc1-28a73236c9ff' },
  ];
  const subjects = buildKeycloakSubjectMap(syntheticDemoSeed.users, actual);
  assert.equal(subjects.get('kam.anna'), actual[3].id);
  assert.equal(subjects.get('kam.dmitry'), actual[1].id);
  assert.equal(subjects.get('manager'), actual[2].id);
  assert.equal(subjects.get('admin'), actual[0].id);
  assert.throws(() => buildKeycloakSubjectMap(syntheticDemoSeed.users, actual.slice(1)), /exactly one account/);
  assert.throws(() => buildKeycloakSubjectMap(syntheticDemoSeed.users, [...actual, actual[3]]), /exactly one account/);
  assert.throws(() => assertLocalKeycloakUrl('https://keycloak.example.net'), /loopback/);
  assert.throws(() => assertLocalKeycloakUrl('http://localhost.attacker.test:18080'), /loopback/);
});

test('subject migration is restricted to fixed seed row IDs, unchanged identity fields, and seed-owned profiles', async () => {
  const statements = [];
  const resolved = syntheticDemoSeed.users.map((user, index) => ({
    ...user,
    sub: ['620e4e31-3301-4396-95e7-b77d4eebd5e0', '639640d4-8f2f-47fe-8107-5adc5c72dcd0', '8da8d1f5-f0ec-48d4-8662-b13d7b975622', 'fc5227db-45e4-4da9-b4c7-a2a20176e5df'][index],
  }));
  await migrateSeedSubjectReferences({
    query: async (sql, params) => { statements.push({ sql, params }); return { rowCount: 0 }; },
  }, resolved);

  const annaActivity = statements.find(({ sql, params }) => sql.includes('UPDATE activities') && params[2] === syntheticDemoSeed.users[0].sub);
  assert.ok(annaActivity.params[0].includes(syntheticDemoSeed.activities[0].id));
  assert.equal(annaActivity.params[1], resolved[0].sub);
  assert.equal(annaActivity.params[3], syntheticDemoSeed.users[0].name);
  assert.match(annaActivity.sql, /owner_sub=\$3 AND owner_name=\$4/);
  assert.ok(statements.some(({ sql, params }) => sql.includes('UPDATE tasks') && params[0].includes(syntheticDemoSeed.tasks[0].id)));
  assert.ok(statements.some(({ sql, params }) => sql.includes('UPDATE activity_events') && params[0].includes(syntheticDemoSeed.events[0].id)));
  const licenseActorUpdate = statements.find(({ sql }) => sql.includes('UPDATE activity_contract_licenses SET actor_sub'));
  assert.deepEqual(licenseActorUpdate.params[0], syntheticDemoSeed.universityContractLicenses
    .filter((record) => record.activity.owner.username === syntheticDemoSeed.users[0].username).map((record) => record.id));
  assert.match(licenseActorUpdate.sql, /WHERE id=ANY\(\$1::uuid\[\]\) AND actor_sub=\$3 AND actor_name=\$4/);
  assert.ok(statements.some(({ sql, params }) => sql.includes('UPDATE activity_university_steps') && params[0] === syntheticDemoSeed.activities[4].id && params[1] === 'U03'));
  const deletions = statements.filter(({ sql }) => sql.startsWith('DELETE FROM'));
  assert.ok(deletions.length > 0);
  assert.ok(deletions.every(({ sql, params }) => sql.includes('provision_source=$2') && params[1] === 'synthetic-demo-seed-v1'));
  assert.ok(statements.every(({ sql }) => !sql.includes('DELETE FROM activities') && !sql.includes('DELETE FROM tasks') && !sql.includes('DELETE FROM activity_events')));
});

test('fixture is deterministic, referentially valid, and covers all process and role types', () => {
  assert.deepEqual(buildSyntheticDemoSeed(), buildSyntheticDemoSeed());
  const { users, organizations, people, activities, tasks, events, activityProducts, activityPrograms, corporatePlans, universitySteps, universityContractLicenses, productIds, programIds } = syntheticDemoSeed;
  assert.deepEqual(new Set(activities.map((row) => row.kind)), new Set(['university', 'corporate', 'individual']));
  assert.deepEqual(new Set(users.flatMap((user) => user.roles)), new Set(['kam', 'manager', 'admin']));
  assert.deepEqual(users.map((user) => user.sub), [
    '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004',
  ]);
  assert.ok(users.every((user) => !user.sub.startsWith('synthetic-demo:')));
  const visibleSeedText = [
    ...organizations.map((row) => row.name), ...people.map((row) => row.organizationName).filter(Boolean),
    ...activities.map((row) => row.title), ...events.map((row) => row.summary),
    ...events.map((row) => row.details.note).filter(Boolean),
    ...corporatePlans.flatMap((plan) => [
      ...Object.values(plan.brief), plan.methodologist.note, plan.approval.note,
    ]),
    ...universitySteps.map((step) => step.note),
    ...universityContractLicenses.flatMap((record) => [record.title, record.note]),
  ];
  assert.ok(visibleSeedText.every((value) => !value.startsWith('DEMO ·') && !value.includes('DEMO-активность')));
  assert.match(DEMO_MARKER, /synthetic_demo/);
  assert.ok(events.some((event) => event.details.syntheticDemo === true), 'synthetic source identity remains explicit in history');
  assert.ok(people.every((row) => row.email === undefined));
  assert.equal(organizations.length, 4);
  assert.equal(people.length, 7);
  assert.equal(activities.length, 11);
  assert.equal(tasks.length, 14);
  assert.equal(events.length, 51);
  assert.equal(corporatePlans.length, 4);
  assert.equal(universitySteps.length, 7);
  assert.equal(universityContractLicenses.length, 6);
  assert.equal(activityProducts.length, 6);
  assert.equal(activityPrograms.length, 8);

  const organizationCounts = new Map(organizations.map((org) => [org.id, activities.filter((activity) => activity.organizationId === org.id).length]));
  assert.ok([...organizationCounts.values()].every((count) => count === 2), 'each fictional organization has two activities');
  assert.deepEqual(
    Object.fromEntries(['university', 'corporate', 'individual'].map((kind) => [kind, activities.filter((row) => row.kind === kind).length])),
    { university: 4, corporate: 4, individual: 3 },
  );
  const ownerCounts = new Map(users.filter((user) => user.roles.includes('kam')).map((user) => [user.sub, activities.filter((activity) => activity.owner.sub === user.sub).length]));
  assert.deepEqual([...ownerCounts.values()].sort((a, b) => a - b), [5, 6]);
  assert.ok(activities.every((activity) => ownerCounts.has(activity.owner.sub)), 'every activity belongs to one of the two KAM owners');
  assert.ok(new Set(activities.map((row) => row.stageKey)).size >= 7, 'processes show varied stages');
  assert.ok(new Set(activities.map((row) => row.priority)).size >= 4, 'activities show varied priorities');
  assert.equal(tasks.filter((task) => task.status === 'done').length, 3);
  assert.equal(tasks.filter((task) => task.status === 'open').length, 11);

  for (const rows of [organizations, people, activities, tasks, events, universityContractLicenses]) {
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'primary keys must be unique');
  }
  const organizationIds = new Set(organizations.map((row) => row.id));
  const personIds = new Set(people.map((row) => row.id));
  const activityIds = new Set(activities.map((row) => row.id));
  const taskIds = new Set(tasks.map((row) => row.id));
  assert.ok(activities.every((row) => !row.organizationId || organizationIds.has(row.organizationId)));
  assert.ok(activities.every((row) => personIds.has(row.personId)));
  assert.ok(tasks.every((row) => activityIds.has(row.activityId)));
  assert.ok(events.every((row) => activityIds.has(row.activity.id)));
  assert.ok(activityProducts.every(([activityId, productId]) => activityIds.has(activityId) && Object.values(productIds).includes(productId)));
  assert.ok(activityPrograms.every(([activityId, programId]) => activityIds.has(activityId) && Object.values(programIds).includes(programId)));
  assert.ok(corporatePlans.every((plan) => plan.activity.kind === 'corporate' && plan.approval.status === 'not_recorded' && plan.methodologist.feasibility === 'unassessed'));
  assert.ok(universitySteps.every((step) => step.activity.kind === 'university' && ['in_progress', 'waiting', 'not_applicable'].includes(step.status) && !step.evidenceReference));
  assert.ok(universityContractLicenses.every((record) => record.activity.kind === 'university'));
  assert.ok(universityContractLicenses.every((record) => record.documentId === null && record.contractReference === null));
  assert.ok(universityContractLicenses.every((record) => ['draft', 'unknown'].includes(record.contractStatus)));
  assert.ok(universityContractLicenses.every((record) => record.note.includes('Синтетическ') || record.note.includes('синтетического')));
  assert.ok(universityContractLicenses.every((record) => record.licenseExpiryPrecision === 'year'
    ? Number.isInteger(record.licenseExpiresYear) && record.licenseExpiresOn === null
    : record.licenseExpiresYear === null && record.licenseExpiresOn === null));
  assert.equal(universityContractLicenses.filter((record) => record.licenseExpiryPrecision === 'year').length, 2);
  assert.ok(universityContractLicenses.some((record) => record.activity.id === activities[0].id));
  assert.ok(universityContractLicenses.some((record) => record.activity.id === activities[5].id));
  assert.deepEqual(
    Object.fromEntries([...new Set(universityContractLicenses.map((record) => record.activity.id))]
      .map((activityId) => [activityId, universityContractLicenses.filter((record) => record.activity.id === activityId).length])),
    { [activities[0].id]: 2, [activities[3].id]: 1, [activities[4].id]: 1, [activities[5].id]: 2 },
  );

  for (const activity of activities) {
    const history = events.filter((event) => event.activity.id === activity.id);
    const created = history.find((event) => event.type === 'created');
    assert.ok(created, `activity ${activity.id} has a creation event`);
    let stage = created.details.initialStage;
    for (const event of history.filter((candidate) => candidate.type === 'stage_changed').sort((left, right) => left.at.localeCompare(right.at))) {
      assert.equal(event.details.from, stage, 'stage history starts at the previous stage');
      stage = event.details.to;
    }
    assert.equal(stage, activity.stageKey, 'stage history ends at the current stage');
  }
  for (const task of tasks) {
    const history = events.filter((event) => event.activity.id === task.activityId && event.details.taskId === task.id);
    assert.ok(history.some((event) => event.type === 'task_created'), `task ${task.id} has a creation event`);
    assert.equal(history.some((event) => event.type === 'task_completed'), task.status === 'done');
  }

  assert.ok(events.every((row) => !row.details.factKind && !/lms|enrollment|learning_completed/i.test(row.type)));
  assert.equal('individualLearningFacts' in syntheticDemoSeed, false);
});

test('university agreement/license seed inserts only deterministic IDs and is safe to rerun', async () => {
  const insertedIds = new Set();
  const statements = [];
  const resolved = new Map(syntheticDemoSeed.users.map((user, index) => [user.username, `resolved-${index}`]));
  const query = async (sql, params) => {
    statements.push({ sql, params });
    const inserted = !insertedIds.has(params[0]);
    insertedIds.add(params[0]);
    return { rowCount: inserted ? 1 : 0 };
  };
  const subFor = (user) => resolved.get(user.username);
  assert.equal(await seedUniversityContractLicenses({ query }, subFor), 6);
  assert.equal(await seedUniversityContractLicenses({ query }, subFor), 0);
  assert.equal(statements.length, 12);
  for (const { sql, params } of statements) {
    assert.match(sql, /INSERT INTO activity_contract_licenses/);
    assert.match(sql, /ON CONFLICT\(id\) DO NOTHING/);
    assert.doesNotMatch(sql, /DO UPDATE|DELETE FROM/);
    const expected = syntheticDemoSeed.universityContractLicenses.find((record) => record.id === params[0]);
    assert.ok(expected, 'insert is limited to a fixed seed ID');
    assert.equal(params[1], expected.activity.id);
    assert.equal(params[2], expected.title);
    assert.equal(params[7], expected.licenseExpiresYear);
    assert.equal(params[8], null, 'the fixture does not attach document blobs');
    assert.equal(params[12], subFor(expected.activity.owner));
    assert.equal(params[13], expected.activity.owner.name);
  }
});

test('university agreement/license verification checks fixed row contents and actor ownership', async () => {
  const resolvedUsers = syntheticDemoSeed.users.map((user, index) => ({ ...user, sub: `resolved-${index}` }));
  const databaseRows = syntheticDemoSeed.universityContractLicenses.map((record) => ({
    id: record.id, activity_id: record.activity.id, title: record.title,
    contract_reference: record.contractReference, contract_status: record.contractStatus,
    license_expiry_precision: record.licenseExpiryPrecision, license_expires_on: record.licenseExpiresOn,
    license_expires_year: record.licenseExpiresYear, document_id: record.documentId, note: record.note,
    revision: record.revision, updated_at: new Date(record.updatedAt),
    actor_sub: resolvedUsers.find((user) => user.username === record.activity.owner.username).sub,
    actor_name: record.activity.owner.name,
  }));
  const client = { query: async (_sql, params) => {
    assert.deepEqual(params, [syntheticDemoSeed.universityContractLicenses.map((record) => record.id)]);
    return { rows: databaseRows };
  } };
  await verifyUniversityContractLicenses(client, resolvedUsers);
  databaseRows[0].actor_sub = 'unrelated-user';
  await assert.rejects(() => verifyUniversityContractLicenses(client, resolvedUsers), /conflicting university contract\/license context/);
});

test('legacy visible labels are upgraded only through exact old-value matches', async () => {
  const statements = [];
  await upgradePriorVisibleLabels({ query: async (sql, params) => { statements.push({ sql, params }); return { rowCount: 0 }; } });

  const organizationUpdate = statements.find(({ sql, params }) => sql.startsWith('UPDATE organizations') && params[0] === syntheticDemoSeed.organizations[0].id);
  assert.deepEqual(organizationUpdate.params, [
    syntheticDemoSeed.organizations[0].id,
    syntheticDemoSeed.organizations[0].name,
    `DEMO · ${syntheticDemoSeed.organizations[0].name}`,
  ]);
  const activityUpdate = statements.find(({ sql, params }) => sql.startsWith('UPDATE activities') && params[0] === syntheticDemoSeed.activities[0].id);
  assert.equal(activityUpdate.params[2], `DEMO · ${syntheticDemoSeed.activities[0].title}`);
  const planUpdate = statements.find(({ sql }) => sql.includes('SET brief=$2::jsonb'));
  assert.ok(planUpdate.sql.includes('AND brief=$3::jsonb'), 'corporate brief migration compares the full old seeded JSON value');
  assert.ok(statements.every(({ sql }) => /WHERE[\s\S]*=\$/.test(sql)), 'every upgrade is scoped by an exact old-value condition');
});
