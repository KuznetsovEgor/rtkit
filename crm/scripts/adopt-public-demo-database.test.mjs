import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSyntheticDemoSeed } from './seed-synthetic-demo.mjs';
import {
  adoptExistingPublicDemoDatabase, assertAdoptionOptIn, parseAdoptionArgs,
  resolveAndVerifyPublicDemoKeycloakAccounts, verifyExistingPublicDemoDatabase,
} from './adopt-public-demo-database.mjs';
import { PUBLIC_DEMO_DATABASE_MARKER } from './provision-public-demo-accounts.mjs';

const users = buildSyntheticDemoSeed().users;
const subjects = new Map(users.map((user, index) => [user.username, `public-sub-${index}`]));

function accessRows() {
  const known = users.map((user) => ({ user_sub: subjects.get(user.username), display_name: user.name,
    realm_roles: user.roles, provision_source: 'public-demo-provisioning', disabled_at: null }));
  const kams = users.filter((user) => user.roles.includes('kam')).map((user) => ({ user_sub: subjects.get(user.username),
    display_name: user.name, enabled: true, provision_source: 'public-demo-provisioning' }));
  return { known, kams };
}

function makeDatabase({ marker = null, nonemptyTable = null, knownOverride, kamOverride, reportJobs = [] } = {}) {
  const { known, kams } = accessRows();
  const state = { marker, statements: [] };
  const tables = [
    'schema_migrations', 'known_crm_users', 'kam_directory', 'organizations', 'people', 'activities', 'activity_products',
    'tasks', 'activity_events', 'products', 'workflow_stages', 'workflow_transitions', 'learning_programs',
    'university_step_definitions', 'workflow_config_revisions', 'stage_guidance_articles', 'future_business_rows',
    'report_jobs', 'report_snapshot_rows',
  ];
  const client = { query: async (sql) => {
    state.statements.push(sql);
    if (sql.includes('current_database()')) return { rows: [{ database: 'lctcrm', marker: state.marker }], rowCount: 1 };
    if (sql.includes('FROM known_crm_users')) return { rows: knownOverride ?? known, rowCount: (knownOverride ?? known).length };
    if (sql.includes('FROM kam_directory')) return { rows: kamOverride ?? kams, rowCount: (kamOverride ?? kams).length };
    if (sql.includes('FROM report_jobs')) return { rows: reportJobs, rowCount: reportJobs.length };
    if (sql.includes('information_schema.tables')) return { rows: tables.map((table_name) => ({ table_name })), rowCount: tables.length };
    if (sql.includes('count(*)::integer')) {
      const table = sql.match(/FROM public\."([a-z_][a-z0-9_]*)"/)?.[1];
      return { rows: [{ count: table === nonemptyTable ? 1 : 0 }], rowCount: 1 };
    }
    if (sql.startsWith('COMMENT ON DATABASE')) {
      state.marker = PUBLIC_DEMO_DATABASE_MARKER;
      return { rowCount: 1 };
    }
    return { rowCount: 0, rows: [] };
  } };
  return { client, state };
}

function emptyPortfolioSnapshot(actorIndex = 2) {
  const actor = users[actorIndex];
  return { job_type: 'snapshot', report_id: 'crm_portfolio', actor_sub: subjects.get(actor.username), actor_name: actor.name,
    parameters: {}, payload: { rowCount: 0, page: 1, pageSize: 25, metrics: [], charts: [], notes: [] },
    source_snapshot_id: null, format: null, file_key: null, file_name: null, media_type: null, file_size: null,
    file_sha256: null, row_count: '0', status: 'completed' };
}

test('adoption parser defaults to read-only checks and requires dual opt-in to mark', async () => {
  assert.deepEqual(parseAdoptionArgs([]), { dryRun: true });
  assert.deepEqual(parseAdoptionArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseAdoptionArgs(['--adopt-public-demo']), { apply: true });
  assert.deepEqual(parseAdoptionArgs(['--help']), { help: true });
  assert.throws(() => parseAdoptionArgs(['--adopt-public-demo', '--force']), /Use --dry-run/);
  assert.throws(() => assertAdoptionOptIn({}), /PUBLIC_DEMO_ADOPT=1/);
  assert.doesNotThrow(() => assertAdoptionOptIn({ PUBLIC_DEMO_ADOPT: '1' }));

  const { client, state } = makeDatabase();
  await assert.rejects(() => adoptExistingPublicDemoDatabase(client, subjects), /PUBLIC_DEMO_ADOPT=1/);
  assert.equal(state.statements.length, 0, 'direct apply calls check opt-in before database access');
});

test('adoption requires exact CRM account provenance, exactly two enabled KAMs, and empty business tables', async () => {
  const { client } = makeDatabase();
  const plan = await verifyExistingPublicDemoDatabase(client, subjects);
  assert.equal(plan.alreadyMarked, false);
  assert.deepEqual(plan.accounts, { users: 4, kamAccounts: 2 });
  assert.ok(plan.businessTables.some((row) => row.table === 'future_business_rows' && row.rows === 0), 'unknown public tables are checked fail-closed');
  assert.ok(plan.businessTables.every((row) => row.rows === 0));

  const { known } = accessRows();
  await assert.rejects(() => verifyExistingPublicDemoDatabase(makeDatabase({ knownOverride: [...known, { ...known[0], user_sub: 'unrelated' }] }).client, subjects), /exactly the four expected CRM users/);
  const { kams } = accessRows();
  await assert.rejects(() => verifyExistingPublicDemoDatabase(makeDatabase({ kamOverride: kams.map((row, index) => index ? row : { ...row, enabled: false }) }).client, subjects), /exactly two enabled KAM/);
  await assert.rejects(() => verifyExistingPublicDemoDatabase(makeDatabase({ nonemptyTable: 'future_business_rows' }).client, subjects), /future_business_rows contains 1 rows/);
});

test('adoption narrowly permits one empty completed crm_portfolio snapshot with no embedded or external rows', async () => {
  const { client } = makeDatabase({ reportJobs: [emptyPortfolioSnapshot()] });
  const plan = await verifyExistingPublicDemoDatabase(client, subjects);
  assert.equal(plan.allowedEmptyReportJobs, 1);
  assert.ok(plan.businessTables.every((table) => table.table !== 'report_jobs'));

  const valid = emptyPortfolioSnapshot();
  const invalidJobs = [
    { ...valid, job_type: 'export' },
    { ...valid, report_id: 'demand_learning' },
    { ...valid, actor_sub: 'unrelated-sub' },
    { ...valid, actor_name: 'Unrelated Person' },
    { ...valid, row_count: 1 },
    { ...valid, status: 'failed' },
    { ...valid, file_key: '11111111-1111-4111-8111-111111111111' },
    { ...valid, file_name: 'report.xlsx' },
    { ...valid, source_snapshot_id: '11111111-1111-4111-8111-111111111111' },
    { ...valid, payload: { rows: [] } },
    { ...valid, payload: { metrics: [{ rows: [{ private: 'row' }] }] } },
    { ...valid, parameters: { rows: [{ private: 'row' }] } },
  ];
  for (const reportJob of invalidJobs) {
    await assert.rejects(() => verifyExistingPublicDemoDatabase(makeDatabase({ reportJobs: [reportJob] }).client, subjects), /empty crm_portfolio snapshot/);
  }
  await assert.rejects(() => verifyExistingPublicDemoDatabase(makeDatabase({ reportJobs: [valid, valid] }).client, subjects), /at most 1 pre-existing/);
  await assert.rejects(() => verifyExistingPublicDemoDatabase(makeDatabase({ reportJobs: [valid], nonemptyTable: 'report_snapshot_rows' }).client, subjects), /report_snapshot_rows contains 1 rows/);
});

test('apply locks and rechecks tables, then writes only the marker; failed checks roll back without marking', async () => {
  const { client, state } = makeDatabase();
  const dryRun = await adoptExistingPublicDemoDatabase(client, subjects, { dryRun: true });
  assert.equal(dryRun.changed, false);
  assert.equal(state.marker, null);

  const result = await adoptExistingPublicDemoDatabase(client, subjects, { env: { PUBLIC_DEMO_ADOPT: '1' } });
  assert.equal(result.changed, true);
  assert.equal(state.marker, PUBLIC_DEMO_DATABASE_MARKER);
  assert.ok(state.statements.some((sql) => sql.startsWith('LOCK TABLE')));
  assert.ok(state.statements.some((sql) => sql.startsWith('COMMENT ON DATABASE')));
  assert.ok(state.statements.at(-1).startsWith('COMMIT'));
  assert.ok(state.statements.every((sql) => !/^\s*(INSERT|UPDATE|DELETE\s+FROM)\b/i.test(sql)), 'adoption never changes CRM rows');

  const blocked = makeDatabase({ nonemptyTable: 'activities' });
  await assert.rejects(() => adoptExistingPublicDemoDatabase(blocked.client, subjects, { env: { PUBLIC_DEMO_ADOPT: '1' } }), /activities contains 1 rows/);
  assert.equal(blocked.state.marker, null);
  assert.ok(blocked.state.statements.at(-1).startsWith('ROLLBACK'));
  assert.ok(!blocked.state.statements.some((sql) => sql.startsWith('COMMENT ON DATABASE')));
});

test('already marked databases are a no-op', async () => {
  const { client, state } = makeDatabase({ marker: PUBLIC_DEMO_DATABASE_MARKER });
  const result = await verifyExistingPublicDemoDatabase(client, subjects);
  assert.equal(result.alreadyMarked, true);
  const applied = await adoptExistingPublicDemoDatabase(client, subjects, { env: { PUBLIC_DEMO_ADOPT: '1' } });
  assert.equal(applied.changed, false);
  assert.equal(state.statements.some((sql) => sql.startsWith('COMMENT ON DATABASE')), false);
});

test('Keycloak adoption check requires exact enabled users and exactly their application roles', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/protocol/openid-connect/token')) return { ok: true, json: async () => ({ access_token: 'test-token' }) };
    if (parsed.pathname.endsWith('/users') && !parsed.pathname.includes('/role-mappings/')) {
      const username = parsed.searchParams.get('username');
      const user = users.find((row) => row.username === username);
      return { ok: true, json: async () => [{ username: user.username, id: subjects.get(username) }] };
    }
    const user = users.find((row) => parsed.pathname.includes(encodeURIComponent(subjects.get(row.username))));
    if (parsed.pathname.endsWith('/role-mappings/realm')) return { ok: true, json: async () => [...user.roles.map((name) => ({ name })), { name: 'offline_access' }] };
    return { ok: true, json: async () => ({ id: subjects.get(user.username), username: user.username, enabled: true }) };
  };
  const result = await resolveAndVerifyPublicDemoKeycloakAccounts({ baseUrl: 'http://keycloak:8080', adminUser: 'root', adminPassword: 'secret', fetchImpl });
  assert.deepEqual([...result], [...subjects]);

  const disabled = async (url) => {
    const response = await fetchImpl(url);
    if (new URL(url).pathname.includes('/users/') && !new URL(url).pathname.endsWith('/role-mappings/realm')) {
      return { ...response, json: async () => ({ ...(await response.json()), enabled: false }) };
    }
    return response;
  };
  await assert.rejects(() => resolveAndVerifyPublicDemoKeycloakAccounts({ baseUrl: 'http://keycloak:8080', adminUser: 'root', adminPassword: 'secret', fetchImpl: disabled }), /missing or disabled/);
});
