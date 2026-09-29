import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { buildApp, type Authenticator } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { closeRepository, PostgresRepository } from '../src/postgres-repository.js';
import { DomainError, type Actor } from '../src/domain.js';
import { removePrivateDocument } from '../src/document-files.js';
import { PostgresImportService, scheduleImportPreviewCleanup } from '../src/import-service.js';
import { PostgresExchangeService } from '../src/exchange-service.js';
import { startCmsMock, startLmsMock } from '../src/mock-services.js';
import { removePrivateReport } from '../src/report-files.js';
import { purgeExpiredReportJobs, ReportService, runReportExportJob } from '../src/report-service.js';
import { PostgresAccessPolicyService } from '../src/access-policy-service.js';
import { createPublicDemoInquiry } from '../src/public-demo-intake.js';
import * as XLSX from 'xlsx';

const runIntegration = process.env.CRM_INTEGRATION === '1';
if (runIntegration) {
  const database = await pool.query('SELECT current_database() AS name');
  if (database.rows[0]?.name !== 'lctcrm_integration') {
    throw new Error('Integration tests may only run against the separate lctcrm_integration database.');
  }
}
after(async () => { if (runIntegration) await closeRepository(); });
const kamA: Actor = { sub: 'b01-db-kam-a', name: 'КАМ Интеграционный А', roles: ['kam'] };
const kamB: Actor = { sub: 'b01-db-kam-b', name: 'КАМ Интеграционный Б', roles: ['kam'] };
const kamAIndividual: Actor = { ...kamA, allowedKinds: ['individual'] };
const kamACorporate: Actor = { ...kamA, allowedKinds: ['corporate'] };
const manager: Actor = { sub: 'b01-db-manager', name: 'Руководитель интеграционного теста', roles: ['manager'] };
const managerOther: Actor = { sub: 'b01-db-manager-other', name: 'Другой руководитель интеграционного теста', roles: ['manager'] };
const admin: Actor = { sub: 'b01-db-admin', name: 'Администратор интеграционного теста', roles: ['admin'] };
const managerAdmin: Actor = { sub: 'b01-db-manager-admin', name: 'Администратор-руководитель интеграционного теста', roles: ['admin', 'manager'] };
const largeReportKam: Actor = { sub: 'b12-db-large-report-kam', name: 'КАМ большого отчёта', roles: ['kam'] };
const authenticate: Authenticator = async (request: FastifyRequest) => {
  if (request.headers['x-test-user'] === 'a') return kamA;
  if (request.headers['x-test-user'] === 'a-individual') return kamAIndividual;
  if (request.headers['x-test-user'] === 'a-corporate') return kamACorporate;
  if (request.headers['x-test-user'] === 'b') return kamB;
  if (request.headers['x-test-user'] === 'manager') return manager;
  if (request.headers['x-test-user'] === 'manager-other') return managerOther;
  if (request.headers['x-test-user'] === 'admin') return admin;
  if (request.headers['x-test-user'] === 'admin-manager') return managerAdmin;
  if (request.headers['x-test-user'] === 'large') return largeReportKam;
  throw new DomainError(401, 'unauthorized', 'Войдите в рабочее пространство.');
};

test('public demo form creates one CRM activity atomically and deduplicates retries and repeated submissions', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const ownerSub = `public-intake-kam-${suffix}`;
  const idempotencyKey = randomUUID();
  const input = { kind: 'university' as const, name: `Синтетический контакт ${suffix}`, email: `demo-${suffix}@example.test`, phone: null, organization: `Синтетический вуз ${suffix}`, note: 'Обсудить практическую учебную программу для студентов.' };
  await pool.query("INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source) VALUES($1,$2,true,'integration-test')", [ownerSub, `000 Integration ${suffix}`]);
  let activityId: string | undefined;
  let manualActivityId: string | undefined;
  const app = buildApp({ repository: new PostgresRepository(), authenticate });
  await app.ready();
  context.after(async () => {
    await app.close();
    if (manualActivityId) {
      const manualPerson = await pool.query('SELECT person_id FROM activities WHERE id=$1::uuid', [manualActivityId]);
      await pool.query('DELETE FROM activities WHERE id=$1::uuid', [manualActivityId]);
      if (manualPerson.rows[0]?.person_id) await pool.query('DELETE FROM people WHERE id=$1::uuid', [manualPerson.rows[0].person_id]);
    }
    if (activityId) {
      const people = await pool.query('SELECT person_id FROM activities WHERE id=$1::uuid', [activityId]);
      await pool.query('DELETE FROM activities WHERE id=$1::uuid', [activityId]);
      if (people.rows[0]?.person_id) await pool.query('DELETE FROM people WHERE id=$1::uuid', [people.rows[0].person_id]);
    }
    await pool.query('DELETE FROM organizations WHERE name=$1', [input.organization]);
    await pool.query('DELETE FROM kam_directory WHERE user_sub=$1', [ownerSub]);
  });
  assert.deepEqual(await createPublicDemoInquiry(input, idempotencyKey), { duplicate: false });
  const byKey = await pool.query('SELECT activity_id FROM public_demo_intakes WHERE idempotency_key_hash=$1', [createHash('sha256').update(idempotencyKey).digest('hex')]);
  activityId = byKey.rows[0].activity_id;
  assert.ok(activityId);
  assert.deepEqual(await createPublicDemoInquiry(input, idempotencyKey), { duplicate: true });
  assert.deepEqual(await createPublicDemoInquiry(input, randomUUID()), { duplicate: true });
  const created = await pool.query(`SELECT a.kind,a.owner_sub,a.origin,a.title,o.name AS organization,p.full_name AS person,
      (SELECT count(*)::int FROM activity_events e WHERE e.activity_id=a.id) AS event_count
    FROM activities a JOIN organizations o ON o.id=a.organization_id JOIN people p ON p.id=a.person_id WHERE a.id=$1::uuid`, [activityId]);
  assert.equal(created.rows.length, 1);
  assert.equal(created.rows[0].kind, 'university');
  assert.equal(created.rows[0].owner_sub, ownerSub);
  assert.equal(created.rows[0].origin, 'manual');
  assert.match(created.rows[0].title, /^Сотрудничество с вузом · /);
  assert.equal(created.rows[0].organization, input.organization);
  assert.equal(created.rows[0].person, input.name);
  assert.equal(created.rows[0].event_count, 1);

  const publicDetail = await app.inject({ method: 'GET', url: `/api/activities/${activityId}`, headers: { 'x-test-user': 'manager' } });
  assert.equal(publicDetail.statusCode, 200, publicDetail.body);
  assert.equal(publicDetail.json().origin, 'manual', 'public-form provenance does not change the internal origin enum');
  assert.equal(publicDetail.json().originLabel, 'Заявка с сайта');
  const manualCreate = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: { kind: 'individual', title: 'Manual origin fixture', personName: `Manual ${suffix}` } });
  assert.equal(manualCreate.statusCode, 201, manualCreate.body);
  manualActivityId = manualCreate.json().id;
  const manualDetail = await app.inject({ method: 'GET', url: `/api/activities/${manualActivityId}`, headers: { 'x-test-user': 'a' } });
  assert.equal(manualDetail.statusCode, 200, manualDetail.body);
  assert.equal(manualDetail.json().originLabel, 'Ручная заявка');
});

test('public B2B demo intake creates a corporate activity linked to a company and deduplicates retries', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const ownerSub = `public-intake-b2b-kam-${suffix}`;
  const idempotencyKey = randomUUID();
  const input = { kind: 'corporate' as const, name: `Синтетический контакт ${suffix}`, email: `b2b-${suffix}@example.test`, phone: null, organization: `Синтетическая компания ${suffix}`, note: 'Обсудить учебную программу для команды.' };
  await pool.query("INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source) VALUES($1,$2,true,'integration-test')", [ownerSub, `000 B2B Integration ${suffix}`]);
  let activityId: string | undefined;
  context.after(async () => {
    if (activityId) {
      const people = await pool.query('SELECT person_id FROM activities WHERE id=$1::uuid', [activityId]);
      await pool.query('DELETE FROM activities WHERE id=$1::uuid', [activityId]);
      if (people.rows[0]?.person_id) await pool.query('DELETE FROM people WHERE id=$1::uuid', [people.rows[0].person_id]);
    }
    await pool.query('DELETE FROM organizations WHERE name=$1', [input.organization]);
    await pool.query('DELETE FROM kam_directory WHERE user_sub=$1', [ownerSub]);
  });
  assert.deepEqual(await createPublicDemoInquiry(input, idempotencyKey), { duplicate: false });
  assert.deepEqual(await createPublicDemoInquiry(input, idempotencyKey), { duplicate: true });
  const found = await pool.query(`SELECT a.kind,a.organization_id,o.segment,o.name AS organization,p.full_name AS person,
      (SELECT count(*)::int FROM activity_events e WHERE e.activity_id=a.id) AS event_count
    FROM activities a JOIN organizations o ON o.id=a.organization_id JOIN people p ON p.id=a.person_id
    WHERE a.title LIKE 'Корпоративное обучение%' AND p.email=$1`, [input.email]);
  assert.equal(found.rows.length, 1);
  activityId = (await pool.query('SELECT id FROM activities WHERE title LIKE $1 AND person_id=(SELECT id FROM people WHERE email=$2)', ['Корпоративное обучение%', input.email])).rows[0].id;
  assert.equal(found.rows[0].kind, 'corporate');
  assert.ok(found.rows[0].organization_id);
  assert.equal(found.rows[0].segment, 'company');
  assert.equal(found.rows[0].organization, input.organization);
  assert.equal(found.rows[0].person, input.name);
  assert.equal(found.rows[0].event_count, 1);
});

test('PostgreSQL terminal transitions require a real result or an explicit reasoned closure', { skip: !runIntegration }, async (context) => {
  const repository = new PostgresRepository();
  const suffix = randomUUID();
  const individual = await repository.createActivity(kamA, { kind: 'individual', title: `Completion individual ${suffix}`, personName: `Completion person ${suffix}` });
  const corporate = await repository.createActivity(kamA, { kind: 'corporate', title: `Completion corporate ${suffix}`, organizationName: `Completion company ${suffix}` });
  context.after(async () => {
    await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [[individual.id, corporate.id]]);
    await pool.query('DELETE FROM people WHERE full_name=$1', [`Completion person ${suffix}`]);
    await pool.query('DELETE FROM organizations WHERE name=$1', [`Completion company ${suffix}`]);
  });
  await pool.query("UPDATE activities SET stage_key='lms_handoff' WHERE id=$1::uuid", [individual.id]);
  await pool.query("UPDATE activities SET stage_key='launch' WHERE id=$1::uuid", [corporate.id]);

  await assert.rejects(repository.transition(kamA, individual.id, 'result', 'lms_handoff', null), { code: 'individual_completion_evidence_required' });
  await assert.rejects(repository.transition(kamA, corporate.id, 'closed', 'launch', null), { code: 'corporate_completion_evidence_required' });
  assert.equal((await repository.getActivity(kamA, individual.id)).stageKey, 'lms_handoff');
  assert.equal((await repository.getActivity(kamA, corporate.id)).stageKey, 'launch');

  await assert.rejects(repository.recordOutcome(kamA, individual.id, 'refused', ''), { code: 'closure_outcome_reason_required' });
  await repository.recordOutcome(kamA, individual.id, 'refused', 'Клиент отказался от продолжения');
  await repository.recordOutcome(kamA, corporate.id, 'cancelled', 'Заказчик отменил запрос');
  const closureEvidence = await pool.query("SELECT count(*)::int AS n FROM activity_events WHERE activity_id=$1::uuid AND event_type='closure_outcome_recorded' AND details->>'stageKey'='lms_handoff'", [individual.id]);
  assert.equal(closureEvidence.rows[0].n, 1, 'The reasoned refusal is stored for the current stage.');
  assert.equal((await repository.transition(kamA, individual.id, 'result', 'lms_handoff', null)).closed, true);
  assert.equal((await repository.transition(kamA, corporate.id, 'closed', 'launch', null)).closed, true);
});

test('university correction return atomically revises U04 and U05, writes history, and keeps activity scope', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const organizationName = `U05 integration university ${suffix}`;
  const personName = `U05 integration coordinator ${suffix}`;
  const email = `u05-${suffix}@example.test`;
  const repository = new PostgresRepository();
  const activity = await repository.createActivity(kamA, {
    kind: 'university', title: `U05 correction return ${suffix}`, organizationName, personName, email,
  });
  const app = buildApp({ repository, authenticate });
  context.after(async () => {
    await app.close();
    await pool.query('DELETE FROM activities WHERE id=$1::uuid', [activity.id]);
    await pool.query('DELETE FROM people WHERE email=$1', [email]);
    await pool.query('DELETE FROM organizations WHERE name=$1', [organizationName]);
  });

  const u04Url = `/api/activities/${activity.id}/university-steps/U04`;
  const returnUrl = `/api/activities/${activity.id}/university-steps/correction-return`;
  const forbidden = await app.inject({ method: 'PUT', url: u04Url, headers: { 'x-test-user': 'b' }, payload: {
    status: 'documented', note: 'Чужой доступ', evidenceReference: 'DOC-X', evidenceSource: 'Фикстура', expectedRevision: 0,
  } });
  assert.equal(forbidden.statusCode, 404);

  const packageSave = await app.inject({ method: 'PUT', url: u04Url, headers: { 'x-test-user': 'a' }, payload: {
    status: 'documented', note: 'Пакет передан', evidenceReference: 'DOC-PKG-U05', evidenceSource: 'Реестр передачи', expectedRevision: 0,
  } });
  assert.equal(packageSave.statusCode, 200, packageSave.body);
  const historyBefore = await app.inject({ method: 'GET', url: `/api/activities/${activity.id}/history`, headers: { 'x-test-user': 'a' } });
  assert.equal(historyBefore.statusCode, 200);
  const beforeEvents = historyBefore.json().length;

  const stale = await app.inject({ method: 'POST', url: returnUrl, headers: { 'x-test-user': 'a' }, payload: {
    expectedU04Revision: 1, expectedU05Revision: 4, note: 'Просроченная фикстура',
  } });
  assert.equal(stale.statusCode, 409);
  const afterStale = await app.inject({ method: 'GET', url: `/api/activities/${activity.id}/history`, headers: { 'x-test-user': 'a' } });
  assert.equal(afterStale.json().length, beforeEvents, 'A stale return must not append an event.');

  const returned = await app.inject({ method: 'POST', url: returnUrl, headers: { 'x-test-user': 'a' }, payload: {
    expectedU04Revision: 1, expectedU05Revision: 0, note: 'Уточнить приложение', evidenceReference: 'DOC-REV-U05', evidenceSource: 'Ответ координатора',
  } });
  assert.equal(returned.statusCode, 200, returned.body);
  assert.deepEqual([returned.json().u04.status, returned.json().u04.revision], ['in_progress', 2]);
  assert.deepEqual([returned.json().u05.status, returned.json().u05.revision], ['documented', 1]);

  const readback = await app.inject({ method: 'GET', url: `/api/activities/${activity.id}/university-steps`, headers: { 'x-test-user': 'a' } });
  const steps = readback.json().steps;
  const u04 = steps.find((step: { stepId: string }) => step.stepId === 'U04');
  const u05 = steps.find((step: { stepId: string }) => step.stepId === 'U05');
  assert.deepEqual([u04.status, u04.revision, u04.evidenceReference, u04.evidenceSource], ['in_progress', 2, 'DOC-PKG-U05', 'Реестр передачи']);
  assert.deepEqual([u05.status, u05.revision, u05.evidenceReference, u05.evidenceSource], ['documented', 1, 'DOC-REV-U05', 'Ответ координатора']);
  const history = await app.inject({ method: 'GET', url: `/api/activities/${activity.id}/history`, headers: { 'x-test-user': 'a' } });
  const correction = history.json().find((event: { eventType: string }) => event.eventType === 'university_correction_return');
  assert.ok(correction);
  assert.equal(correction.details.previousU04EvidenceReference, 'DOC-PKG-U05');
  assert.equal(correction.details.previousU05Revision, 0);
  assert.equal(correction.details.u04Revision, 2);
  assert.equal(correction.details.u05Revision, 1);
});

test('hidden catalog products cannot be newly linked but existing card links remain editable', { skip: !runIntegration }, async (context) => {
  const repository = new PostgresRepository();
  assert.ok((await repository.catalog(kamA)).products.some((product) => product.name === 'RT.Warehouse'),
    'The customer vendor sample product remains available for preview and linking.');
  const hiddenId = randomUUID();
  const visibleId = randomUUID();
  const suffix = randomUUID();
  const createdIds: string[] = [];
  const personIds: string[] = [];
  context.after(async () => {
    if (createdIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [createdIds]);
    if (personIds.length) await pool.query('DELETE FROM people WHERE id=ANY($1::uuid[])', [personIds]);
    await pool.query('DELETE FROM products WHERE id=ANY($1::uuid[])', [[hiddenId, visibleId]]);
  });
  await pool.query('INSERT INTO products(id,name,catalog_visible) VALUES($1,$3,false),($2,$4,true)',
    [hiddenId, visibleId, `Hidden fixture ${suffix}`, `Visible fixture ${suffix}`]);

  await assert.rejects(() => repository.createActivity(kamA, {
    kind: 'individual', title: `Hidden rejected ${suffix}`, personName: `Learner ${suffix}`, productIds: [hiddenId],
  }), (error: unknown) => error instanceof DomainError && error.code === 'product_not_found');
  const created = await repository.createActivity(kamA, {
    kind: 'individual', title: `Visible accepted ${suffix}`, personName: `Learner ${suffix}`, productIds: [visibleId],
  });
  createdIds.push(created.id);
  const person = await pool.query('SELECT person_id FROM activities WHERE id=$1::uuid', [created.id]);
  personIds.push(person.rows[0].person_id);
  await pool.query('INSERT INTO activity_products(activity_id,product_id) VALUES($1::uuid,$2::uuid)', [created.id, hiddenId]);

  const retained = await repository.updateActivityDetails(kamA, created.id, {
    personId: person.rows[0].person_id, productIds: [visibleId, hiddenId], priority: 3, expectedRevision: 0,
  });
  assert.equal(retained.productIds.length, 2);
  const removed = await repository.updateActivityDetails(kamA, created.id, {
    personId: person.rows[0].person_id, productIds: [visibleId], priority: 3, expectedRevision: 0,
  });
  assert.deepEqual(removed.productIds, [visibleId]);
  await assert.rejects(() => repository.updateActivityDetails(kamA, created.id, {
    personId: person.rows[0].person_id, productIds: [visibleId, hiddenId], priority: 3, expectedRevision: removed.revision,
  }), (error: unknown) => error instanceof DomainError && error.code === 'product_not_found');
});

async function createAuditedExternalActivityFixture(actor: Actor, input: { title: string; personName: string; source: string; reference: string }) {
  const activityId = randomUUID();
  const personId = randomUUID();
  const client = await pool.connect();
  const mappingReason = 'Готовый внешний заказ направлен к передаче в LMS; ручные стадии продажи пропущены. Зачисление, начало обучения и исход не создавались. Синтетическая фикстура интеграционного теста.';
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO people(id,full_name) VALUES($1,$2)', [personId, input.personName]);
    await client.query(`INSERT INTO activities(id,kind,title,origin,origin_source,origin_reference,route_version,person_id,stage_key,owner_sub,owner_name)
      VALUES($1,'individual',$2,'external_ready',$3,$4,'v2',$5,'lms_handoff',$6,$7)`, [activityId, input.title, input.source, input.reference, personId, actor.sub, actor.name]);
    await client.query(`INSERT INTO activity_events(id,activity_id,event_type,summary,details,actor_sub,actor_name)
      VALUES($1,$2,'created','Синтетическая внешняя заявка подготовлена для интеграционного теста.',$3::jsonb,$4,$5)`, [
      randomUUID(), activityId, JSON.stringify({ kind: 'individual', origin: 'external_ready', routeVersion: 'v2', source: input.source, reference: input.reference, initialStage: 'lms_handoff', mappingReason, fixture: 'synthetic_test' }), actor.sub, actor.name,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { id: activityId, personId };
}

test('PostgreSQL access policy immediately revokes existing JWT requests and audits the admin action', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const operator: Actor = { sub: `a10-admin-${suffix}`, name: 'A10 admin', roles: ['admin'] };
  const secondOperator: Actor = { sub: `a10-admin-b-${suffix}`, name: 'A10 second admin', roles: ['admin'] };
  const subject: Actor = { sub: `a10-kam-${suffix}`, name: 'A10 KAM', roles: ['kam'] };
  const testAuthenticate: Authenticator = async (request) => request.headers['x-test-user'] === 'admin' ? operator
    : request.headers['x-test-user'] === 'admin-b' ? secondOperator : subject;
  const accessPolicy = new PostgresAccessPolicyService();
  const app = buildApp({ repository: new PostgresRepository(), authenticate: testAuthenticate, accessPolicy });
  await app.ready();
  context.after(async () => {
    await app.close();
    await pool.query('DELETE FROM crm_access_policy_audit WHERE target_sub = ANY($1::text[])', [[operator.sub, secondOperator.sub, subject.sub]]);
    await pool.query('DELETE FROM known_crm_users WHERE user_sub = ANY($1::text[])', [[operator.sub, secondOperator.sub, subject.sub]]);
  });

  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/access/users', headers: { 'x-test-user': 'admin' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/access/users', headers: { 'x-test-user': 'admin-b' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${suffix}`, headers: { 'x-test-user': 'kam' } })).statusCode, 404,
    'a valid JWT is first observed even if its requested card is absent');
  const disabled = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${subject.sub}`, headers: { 'x-test-user': 'admin' }, payload: { enabled: false, reason: 'integration test' } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().enabled, false);

  for (const url of [
    `/api/activities/${suffix}`,
    `/api/activities/${suffix}/documents/${randomUUID()}`,
    `/api/reports/exports/${suffix}/file`,
    '/api/reports/ready',
  ]) {
    const response = await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'kam' } });
    assert.equal(response.statusCode, 403, `revoked JWT cannot access ${url}`);
    assert.equal(response.json().code, 'access_revoked');
  }
  const selfDisable = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${operator.sub}`, headers: { 'x-test-user': 'admin' }, payload: { enabled: false, reason: 'integration self-disable' } });
  assert.equal(selfDisable.statusCode, 409);
  assert.equal(selfDisable.json().code, 'cannot_disable_self');
  const audit = await pool.query(`SELECT action, actor_sub, reason FROM crm_access_policy_audit WHERE target_sub=$1 AND action='disabled' ORDER BY created_at DESC LIMIT 1`, [subject.sub]);
  assert.deepEqual(audit.rows[0], { action: 'disabled', actor_sub: operator.sub, reason: 'integration test' });

  const revokeOperator = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${operator.sub}`, headers: { 'x-test-user': 'admin-b' }, payload: { enabled: false, reason: 'integration in-flight admin' } });
  assert.equal(revokeOperator.statusCode, 200, revokeOperator.body);
  await assert.rejects(accessPolicy.setEnabled(operator, operator.sub, true, 'stale in-flight attempt'),
    (error: unknown) => error instanceof DomainError && error.code === 'access_revoked',
    'An already-started administrator request cannot restore its own access after waiting for serialization.');

  // A confirmation holds the shared policy gate; a revocation writer must wait
  // until that confirmation has observed its target policy and completed.
  const gate = await pool.connect();
  let enableAfterGate: Promise<unknown> | undefined;
  try {
    await gate.query('BEGIN');
    await gate.query("SELECT pg_advisory_xact_lock_shared(hashtext('crm-access-policy'))");
    enableAfterGate = accessPolicy.setEnabled(secondOperator, subject.sub, true, 'concurrency gate release');
    let writerWaiting = false;
    const waitDeadline = Date.now() + 3000;
    while (!writerWaiting && Date.now() < waitDeadline) {
      const waiting = await pool.query(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%pg_advisory_xact_lock%'
      ) AS waiting`);
      writerWaiting = waiting.rows[0]?.waiting === true;
      if (!writerWaiting) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(writerWaiting, true, 'The access-policy writer waits behind an in-flight confirmation gate.');
    assert.ok((await pool.query('SELECT disabled_at FROM known_crm_users WHERE user_sub=$1', [subject.sub])).rows[0].disabled_at,
      'The target is not re-enabled until the confirmation releases its gate.');
  } finally {
    await gate.query('COMMIT');
    gate.release();
  }
  await enableAfterGate;
  assert.equal((await pool.query('SELECT disabled_at FROM known_crm_users WHERE user_sub=$1', [subject.sub])).rows[0].disabled_at, null);
});

test('report owner options include a manager-visible owner with only closed activities', { skip: !runIntegration }, async (context) => {
  const activityId = randomUUID();
  const organizationId = randomUUID();
  const ownerSub = `report-closed-${randomUUID()}`;
  const service = new ReportService();
  let snapshotId: string | undefined;
  context.after(async () => {
    if (snapshotId) await pool.query('DELETE FROM report_jobs WHERE id=$1::uuid', [snapshotId]);
    await pool.query('DELETE FROM activities WHERE id=$1::uuid', [activityId]);
    await pool.query('DELETE FROM organizations WHERE id=$1::uuid', [organizationId]);
  });
  await pool.query("INSERT INTO organizations(id,name,segment) VALUES($1,'Closed owner report fixture','university')", [organizationId]);
  await pool.query(`INSERT INTO activities(id,kind,title,organization_id,stage_key,owner_sub,owner_name,closed)
    VALUES($1,'university','Closed owner report fixture',$2,'contact',$3,'Closed-only KAM',TRUE)`, [activityId, organizationId, ownerSub]);

  const owners = await service.listOwners(manager);
  assert.deepEqual(owners.find((owner) => owner.ownerSub === ownerSub), { ownerSub, ownerName: 'Closed-only KAM' });
  const scopedOwners = await service.listOwners({ ...manager, allowedKinds: ['corporate'] });
  assert.equal(scopedOwners.some((owner) => owner.ownerSub === ownerSub), false);
  const snapshot = await service.createSnapshot(manager, { reportId: 'crm_portfolio', filters: { ownerSub, includeClosed: true } });
  snapshotId = snapshot.snapshotId;
  assert.equal(snapshot.rowCount, 1);
  assert.equal(snapshot.rows[0]?.activityId, activityId);
});

test('report organization options and snapshots use only manager-visible organization links', { skip: !runIntegration }, async (context) => {
  const activityId = randomUUID();
  const organizationId = randomUUID();
  const service = new ReportService();
  let snapshotId: string | undefined;
  let emptySnapshotId: string | undefined;
  context.after(async () => {
    if (snapshotId) await pool.query('DELETE FROM report_jobs WHERE id=$1::uuid', [snapshotId]);
    if (emptySnapshotId) await pool.query('DELETE FROM report_jobs WHERE id=$1::uuid', [emptySnapshotId]);
    await pool.query('DELETE FROM activities WHERE id=$1::uuid', [activityId]);
    await pool.query('DELETE FROM organizations WHERE id=$1::uuid', [organizationId]);
  });
  await pool.query("INSERT INTO organizations(id,name,segment) VALUES($1,'Private report organization fixture','university')", [organizationId]);
  await pool.query(`INSERT INTO activities(id,kind,title,organization_id,stage_key,owner_sub,owner_name,import_owner_only)
    VALUES($1,'university','Private report organization fixture',$2,'contact',$3,$4,TRUE)`, [activityId, organizationId, manager.sub, manager.name]);

  const visibleOrganizations = await service.listOrganizations(manager);
  assert.ok(visibleOrganizations.some((organization) => organization.organizationId === organizationId));
  const otherManagerOrganizations = await service.listOrganizations(managerOther);
  assert.equal(otherManagerOrganizations.some((organization) => organization.organizationId === organizationId), false,
    'An import-owner-only organization does not leak through manager filter options.');

  const snapshot = await service.createSnapshot(manager, { reportId: 'crm_portfolio', filters: { organizationId, includeClosed: true } });
  snapshotId = snapshot.snapshotId;
  assert.equal(snapshot.rowCount, 1);
  assert.equal(snapshot.rows[0]?.activityId, activityId);
  assert.equal(snapshot.filters.organizationId, organizationId);
  assert.equal(snapshot.filters.organizationName, 'Private report organization fixture');
  await assert.rejects(service.createSnapshot(managerOther, { reportId: 'crm_portfolio', filters: { organizationId, includeClosed: true } }),
    (error: unknown) => error instanceof DomainError && error.statusCode === 403 && error.code === 'report_filter_forbidden');

  const emptySnapshot = await service.createSnapshot(manager, { reportId: 'crm_portfolio', filters: {
    organizationId, from: '1990-01-01', to: '1990-01-01', includeClosed: true,
  } });
  emptySnapshotId = emptySnapshot.snapshotId;
  assert.equal(emptySnapshot.rowCount, 0);
  await assert.rejects(service.getSnapshot({ ...manager, allowedOrganizationIds: [] }, emptySnapshotId),
    (error: unknown) => error instanceof DomainError && error.statusCode === 403 && error.code === 'report_scope_changed');
});

test('PostgreSQL guidance feedback persists per user and activity with a reasoned rejection', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const app = buildApp({ repository: new PostgresRepository(), authenticate });
  await app.ready();
  let activityId: string | undefined;
  let organizationId: string | undefined;
  context.after(async () => {
    await app.close();
    if (activityId) await pool.query('DELETE FROM activities WHERE id=$1', [activityId]);
    if (organizationId) await pool.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
  });

  const created = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'university', title: `A17 guidance ${suffix}`, organizationName: `A17 organization ${suffix}`,
  } });
  assert.equal(created.statusCode, 201, created.body);
  activityId = created.json().id;
  organizationId = created.json().organizationId;
  const guidance = await app.inject({ method: 'GET', url: `/api/activities/${activityId}/guidance`, headers: { 'x-test-user': 'a' } });
  assert.equal(guidance.statusCode, 200, guidance.body);
  const recommendationKey = guidance.json().tip.recommendationKey as string;
  const deferred = await app.inject({ method: 'POST', url: `/api/activities/${activityId}/guidance/feedback`, headers: { 'x-test-user': 'a' }, payload: { recommendationKey, action: 'defer' } });
  assert.equal(deferred.statusCode, 200, deferred.body);
  const rejected = await app.inject({ method: 'POST', url: `/api/activities/${activityId}/guidance/feedback`, headers: { 'x-test-user': 'a' }, payload: { recommendationKey, action: 'reject', reason: 'Актуальность уже подтверждена.' } });
  assert.equal(rejected.statusCode, 200, rejected.body);
  const row = await pool.query('SELECT actor_sub, recommendation_key, action, reason FROM guidance_feedback WHERE activity_id=$1', [activityId]);
  assert.deepEqual(row.rows[0], { actor_sub: kamA.sub, recommendation_key: recommendationKey, action: 'reject', reason: 'Актуальность уже подтверждена.' });
  const managerView = await app.inject({ method: 'GET', url: `/api/activities/${activityId}/guidance`, headers: { 'x-test-user': 'manager' } });
  assert.equal(managerView.statusCode, 200, managerView.body);
  assert.equal(managerView.json().feedback, null, 'another authorized user does not inherit personal feedback');
});

test('PostgreSQL stage guidance keeps audited draft and publication revisions and suppresses stale bindings', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const editor: Actor = { sub: `a17-guidance-editor-${suffix}`, name: 'A17 guidance editor', roles: ['manager'] };
  const publisher: Actor = { sub: `a17-guidance-publisher-${suffix}`, name: 'A17 guidance publisher', roles: ['admin'] };
  const reader: Actor = { sub: `a17-guidance-reader-${suffix}`, name: 'A17 guidance reader', roles: ['kam'] };
  const testAuthenticate: Authenticator = async (request) => request.headers['x-test-user'] === 'editor' ? editor
    : request.headers['x-test-user'] === 'publisher' ? publisher : reader;
  const kind = 'university';
  const stageKey = 'contact';
  const previousResult = await pool.query(`SELECT seed_stage_snapshot, draft_article, draft_revision, draft_stage_snapshot,
    published_article, published_revision, published_stage_snapshot, published_at, published_by_sub, published_by_name,
    updated_at, updated_by_sub, updated_by_name FROM stage_guidance_articles WHERE kind=$1 AND stage_key=$2`, [kind, stageKey]);
  const previous = previousResult.rows[0];
  const app = buildApp({ repository: new PostgresRepository(), authenticate: testAuthenticate });
  await app.ready();
  context.after(async () => {
    await app.close();
    if (previous) await pool.query(`UPDATE stage_guidance_articles SET seed_stage_snapshot=$3::jsonb, draft_article=$4::jsonb,
      draft_revision=$5, draft_stage_snapshot=$6::jsonb, published_article=$7::jsonb, published_revision=$8,
      published_stage_snapshot=$9::jsonb, published_at=$10, published_by_sub=$11, published_by_name=$12,
      updated_at=$13, updated_by_sub=$14, updated_by_name=$15 WHERE kind=$1 AND stage_key=$2`, [
      kind, stageKey, JSON.stringify(previous.seed_stage_snapshot), previous.draft_article == null ? null : JSON.stringify(previous.draft_article), previous.draft_revision,
      previous.draft_stage_snapshot == null ? null : JSON.stringify(previous.draft_stage_snapshot), previous.published_article == null ? null : JSON.stringify(previous.published_article),
      previous.published_revision, previous.published_stage_snapshot == null ? null : JSON.stringify(previous.published_stage_snapshot), previous.published_at,
      previous.published_by_sub, previous.published_by_name, previous.updated_at, previous.updated_by_sub, previous.updated_by_name,
    ]);
    else await pool.query('DELETE FROM stage_guidance_articles WHERE kind=$1 AND stage_key=$2', [kind, stageKey]);
    await pool.query('DELETE FROM stage_guidance_article_events WHERE actor_sub = ANY($1::text[])', [[editor.sub, publisher.sub]]);
  });

  const article = {
    title: `A17 guidance ${suffix}`, summary: 'Актуальная краткая инструкция.', focus: 'Проверить подтверждённую потребность.',
    checks: ['Записать контакт.'], boundary: 'Не считать интерес договорённостью.', draftMessage: 'Здравствуйте! Актуально ли обсуждение?',
    recommendationWhenNoOpenTask: 'Уточните актуальность у вуза.',
  };
  const saved = await app.inject({ method: 'PUT', url: `/api/guidance/${kind}/${stageKey}/draft`, headers: { 'x-test-user': 'editor' }, payload: { expectedRevision: previous?.draft_revision ?? 0, article } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().draftRevision, Number(previous?.draft_revision ?? 0) + 1);
  const draftAudit = await pool.query(`SELECT action, revision, actor_sub FROM stage_guidance_article_events
    WHERE kind=$1 AND stage_key=$2 AND actor_sub=$3 ORDER BY created_at DESC LIMIT 1`, [kind, stageKey, editor.sub]);
  assert.deepEqual(draftAudit.rows[0], { action: 'draft_saved', revision: saved.json().draftRevision, actor_sub: editor.sub });

  const draftSnapshot = await pool.query('SELECT draft_stage_snapshot FROM stage_guidance_articles WHERE kind=$1 AND stage_key=$2', [kind, stageKey]);
  await pool.query(`UPDATE stage_guidance_articles SET draft_stage_snapshot=jsonb_set(draft_stage_snapshot, '{label}', '"outdated"'::jsonb)
    WHERE kind=$1 AND stage_key=$2`, [kind, stageKey]);
  const staleDraftPublish = await app.inject({ method: 'POST', url: `/api/admin/guidance/${kind}/${stageKey}/publish`, headers: { 'x-test-user': 'publisher' }, payload: { expectedDraftRevision: saved.json().draftRevision } });
  assert.equal(staleDraftPublish.statusCode, 409, staleDraftPublish.body);
  await pool.query('UPDATE stage_guidance_articles SET draft_stage_snapshot=$3::jsonb WHERE kind=$1 AND stage_key=$2', [kind, stageKey, JSON.stringify(draftSnapshot.rows[0].draft_stage_snapshot)]);

  const published = await app.inject({ method: 'POST', url: `/api/admin/guidance/${kind}/${stageKey}/publish`, headers: { 'x-test-user': 'publisher' }, payload: { expectedDraftRevision: saved.json().draftRevision } });
  assert.equal(published.statusCode, 200, published.body);
  const active = await app.inject({ method: 'GET', url: `/api/guidance/${kind}/${stageKey}`, headers: { 'x-test-user': 'reader' } });
  assert.equal(active.statusCode, 200, active.body);
  assert.equal(active.json().article.title, article.title);
  const publishAudit = await pool.query(`SELECT action, revision, actor_sub FROM stage_guidance_article_events
    WHERE kind=$1 AND stage_key=$2 AND actor_sub=$3 ORDER BY created_at DESC LIMIT 1`, [kind, stageKey, publisher.sub]);
  assert.deepEqual(publishAudit.rows[0], { action: 'published', revision: saved.json().draftRevision, actor_sub: publisher.sub });

  await pool.query(`UPDATE stage_guidance_articles SET published_stage_snapshot=jsonb_set(published_stage_snapshot, '{label}', '"changed"'::jsonb)
    WHERE kind=$1 AND stage_key=$2`, [kind, stageKey]);
  const stale = await app.inject({ method: 'GET', url: `/api/guidance/${kind}/${stageKey}`, headers: { 'x-test-user': 'reader' } });
  assert.equal(stale.statusCode, 409);
  const handbook = await app.inject({ method: 'GET', url: '/api/guidance/handbook', headers: { 'x-test-user': 'reader' } });
  const staleItem = handbook.json().items.find((item: any) => item.id === `${kind}:${stageKey}`);
  assert.equal(staleItem.state, 'stale');
  assert.equal(staleItem.article, null);
});

test('PostgreSQL contract/license contexts are multiple per activity, scoped, revisioned, and retain exact expiry precision', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const app = buildApp({ repository: new PostgresRepository(), authenticate });
  await app.ready();
  const activityIds: string[] = [];
  const documentIds: string[] = [];
  let organizationId: string | undefined;
  context.after(async () => {
    await app.close();
    await Promise.all(documentIds.map((documentId) => removePrivateDocument(documentId)));
    if (activityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    if (organizationId) await pool.query('DELETE FROM organizations WHERE id=$1::uuid', [organizationId]);
  });

  const first = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'corporate', title: `A17 contract activity ${suffix}`, organizationName: `A17 contract org ${suffix}`,
  } });
  assert.equal(first.statusCode, 201, first.body);
  activityIds.push(first.json().id);
  organizationId = (await app.inject({ method: 'GET', url: `/api/activities/${first.json().id}`, headers: { 'x-test-user': 'a' } })).json().organizationId;
  const second = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'corporate', title: `A17 second activity ${suffix}`, organizationId,
  } });
  assert.equal(second.statusCode, 201, second.body);
  activityIds.push(second.json().id);
  const collectionUrl = `/api/activities/${first.json().id}/contract-licenses`;
  const empty = await app.inject({ method: 'GET', url: collectionUrl, headers: { 'x-test-user': 'a' } });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json(), [], 'contract details remain absent during an early activity');
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/activities/${second.json().id}/contract-licenses`, headers: { 'x-test-user': 'a' } })).json(), [], 'a second activity for the same organization has its own empty contract context');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const upload = await app.inject({ method: 'POST', url: `/api/activities/${first.json().id}/documents?filename=contract.png`, headers: { 'x-test-user': 'a', 'content-type': 'application/octet-stream' }, payload: png });
  assert.equal(upload.statusCode, 201, upload.body);
  documentIds.push(upload.json().id);
  const firstFields = {
    title: 'Договор программы', contractReference: 'RTK-A17-01', contractStatus: 'signed',
    licenseExpiryPrecision: 'exact_date', licenseExpiresOn: '2031-12-31', licenseExpiresYear: null,
    documentId: upload.json().id, note: null,
  };
  const created = await app.inject({ method: 'POST', url: collectionUrl, headers: { 'x-test-user': 'a' }, payload: firstFields });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().documentName, 'contract.png');
  assert.equal(created.json().licenseExpiresOn, '2031-12-31');
  const yearOnly = await app.inject({ method: 'POST', url: collectionUrl, headers: { 'x-test-user': 'a' }, payload: {
    title: 'Лицензия продукта', contractReference: null, contractStatus: null,
    licenseExpiryPrecision: 'year', licenseExpiresOn: null, licenseExpiresYear: 2034, documentId: null, note: 'Известен только год.',
  } });
  assert.equal(yearOnly.statusCode, 201, yearOnly.body);
  assert.equal(yearOnly.json().licenseExpiresOn, null, 'year-only data stores no fabricated month and day');
  assert.equal((await app.inject({ method: 'GET', url: collectionUrl, headers: { 'x-test-user': 'a' } })).json().length, 2);
  const crossActivityDocument = await app.inject({ method: 'POST', url: `/api/activities/${second.json().id}/contract-licenses`, headers: { 'x-test-user': 'a' }, payload: { ...firstFields, title: 'Чужой документ' } });
  assert.equal(crossActivityDocument.statusCode, 400, 'a contract context cannot link a private file from another activity');
  assert.equal((await app.inject({ method: 'GET', url: collectionUrl, headers: { 'x-test-user': 'b' } })).statusCode, 404);

  const updated = await app.inject({ method: 'PUT', url: `${collectionUrl}/${created.json().id}`, headers: { 'x-test-user': 'a' }, payload: {
    ...firstFields, expectedRevision: 1, licenseExpiryPrecision: 'unknown', licenseExpiresOn: null, licenseExpiresYear: null,
  } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().revision, 2);
  assert.equal(updated.json().licenseExpiresOn, null);
  assert.equal(updated.json().licenseExpiresYear, null);
  const stale = await app.inject({ method: 'PUT', url: `${collectionUrl}/${created.json().id}`, headers: { 'x-test-user': 'a' }, payload: { ...firstFields, expectedRevision: 1 } });
  assert.equal(stale.statusCode, 409);
  const history = await app.inject({ method: 'GET', url: `/api/activities/${first.json().id}/history`, headers: { 'x-test-user': 'a' } });
  assert.ok(history.json().some((event: { eventType: string; details: { current?: { licenseExpiryPrecision?: string } } }) => event.eventType === 'contract_license_updated' && event.details.current?.licenseExpiryPrecision === 'unknown'));
  await pool.query('UPDATE activities SET closed=TRUE WHERE id=$1::uuid', [first.json().id]);
  const closedDelete = await app.inject({ method: 'DELETE', url: `${collectionUrl}/${yearOnly.json().id}?expectedRevision=1`, headers: { 'x-test-user': 'a' } });
  assert.equal(closedDelete.statusCode, 409);
  assert.equal(closedDelete.json().code, 'activity_closed');
});

test('PostgreSQL segment scope restricts activity and report access and revokes saved exports after reduction', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const operator: Actor = { sub: `a11-admin-${suffix}`, name: 'A11 admin', roles: ['admin'] };
  const subject: Actor = { sub: `a11-kam-${suffix}`, name: 'A11 KAM', roles: ['kam'] };
  const scopedManager: Actor = { sub: `a11-manager-${suffix}`, name: 'A11 manager', roles: ['manager'] };
  const targetKamSub = `a11-target-kam-${suffix}`;
  const testAuthenticate: Authenticator = async (request) => request.headers['x-test-user'] === 'admin' ? operator
    : request.headers['x-test-user'] === 'manager' ? scopedManager : subject;
  const app = buildApp({ repository: new PostgresRepository(), authenticate: testAuthenticate, accessPolicy: new PostgresAccessPolicyService() });
  await app.ready();
  const activityIds: string[] = [];
  const organizationIds: string[] = [];
  const personIds: string[] = [];
  const reportActorSubs = [subject.sub];
  context.after(async () => {
    await app.close();
    const files = await pool.query('SELECT file_key AS "fileKey" FROM report_jobs WHERE actor_sub=ANY($1::text[]) AND file_key IS NOT NULL', [reportActorSubs]);
    await Promise.all((files.rows as { fileKey: string }[]).map((file) => removePrivateReport(file.fileKey)));
    await pool.query('DELETE FROM report_jobs WHERE actor_sub=ANY($1::text[])', [reportActorSubs]);
    await pool.query('DELETE FROM crm_activity_scope_audit WHERE target_sub=ANY($1::text[])', [[operator.sub, subject.sub, scopedManager.sub]]);
    if (activityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    if (organizationIds.length) await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [organizationIds]);
    if (personIds.length) await pool.query('DELETE FROM people WHERE id=ANY($1::uuid[])', [personIds]);
    await pool.query('DELETE FROM known_crm_users WHERE user_sub=ANY($1::text[])', [[operator.sub, subject.sub, scopedManager.sub]]);
    await pool.query('DELETE FROM kam_directory WHERE user_sub=$1', [targetKamSub]);
  });

  const kamHeaders = { 'x-test-user': 'kam' };
  const adminHeaders = { 'x-test-user': 'admin' };
  const managerHeaders = { 'x-test-user': 'manager' };
  assert.equal((await app.inject({ method: 'GET', url: '/api/activities', headers: kamHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/access/users', headers: adminHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/manager/overview', headers: managerHeaders })).statusCode, 200);
  await pool.query(`INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source)
    VALUES($1,'A11 target KAM',TRUE,'local-keycloak-provisioning')`, [targetKamSub]);

  const create = async (kind: 'university' | 'corporate' | 'individual') => {
    const payload = kind === 'individual'
      ? { kind, title: `A11 ${kind} ${suffix}`, personName: `A11 person ${suffix}` }
      : { kind, title: `A11 ${kind} ${suffix}`, organizationName: `A11 org ${kind} ${suffix}` };
    const response = await app.inject({ method: 'POST', url: '/api/activities', headers: kamHeaders, payload });
    assert.equal(response.statusCode, 201, response.body);
    const activity = response.json();
    activityIds.push(activity.id);
    if (activity.organizationId) organizationIds.push(activity.organizationId);
    if (activity.personId) personIds.push(activity.personId);
    return activity.id as string;
  };
  const universityId = await create('university');
  const corporateId = await create('corporate');
  const individualId = await create('individual');

  const initialScope = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${subject.sub}/scope`, headers: adminHeaders,
    payload: { allowedKinds: ['corporate', 'individual'], expectedRevision: 0, reason: 'A11 scope integration test' } });
  assert.equal(initialScope.statusCode, 200, initialScope.body);
  assert.deepEqual(initialScope.json().allowedKinds, ['corporate', 'individual']);
  assert.equal(initialScope.json().scopeRevision, 1);
  const scopedPage = await app.inject({ method: 'GET', url: '/api/activities?limit=100', headers: kamHeaders });
  assert.equal(scopedPage.statusCode, 200, scopedPage.body);
  const visibleIds = new Set(scopedPage.json().items.map((item: { id: string }) => item.id));
  assert.equal(visibleIds.has(universityId), false);
  assert.equal(visibleIds.has(corporateId), true);
  assert.equal(visibleIds.has(individualId), true);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${universityId}`, headers: kamHeaders })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/activities/${universityId}/tasks`, headers: kamHeaders,
    payload: { title: 'Недоступная задача', dueAt: new Date(Date.now() + 86_400_000).toISOString() } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${universityId}/history`, headers: kamHeaders })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${universityId}/documents`, headers: kamHeaders })).statusCode, 404);
  const deniedCreate = await app.inject({ method: 'POST', url: '/api/activities', headers: kamHeaders,
    payload: { kind: 'university', title: `A11 denied ${suffix}`, organizationName: `A11 denied org ${suffix}` } });
  assert.equal(deniedCreate.statusCode, 403);
  assert.equal(deniedCreate.json().code, 'segment_forbidden');

  const snapshotResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: kamHeaders, payload: { reportId: 'crm_portfolio' } });
  assert.equal(snapshotResponse.statusCode, 201, snapshotResponse.body);
  const snapshot = snapshotResponse.json();
  assert.equal(snapshot.rowCount, 2);
  assert.deepEqual(new Set(snapshot.rows.map((item: { kind: string }) => item.kind)), new Set(['corporate', 'individual']));
  const exportResponse = await app.inject({ method: 'POST', url: '/api/reports/exports', headers: kamHeaders,
    payload: { snapshotId: snapshot.snapshotId, format: 'csv', columns: ['activityId', 'kindLabel', 'title'] } });
  assert.equal(exportResponse.statusCode, 202, exportResponse.body);
  const exportId = exportResponse.json().id as string;
  let exportStatus: any;
  const exportDeadline = Date.now() + 20_000;
  do {
    const status = await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}`, headers: kamHeaders });
    assert.equal(status.statusCode, 200, status.body);
    exportStatus = status.json();
    if (exportStatus.status === 'completed' || exportStatus.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < exportDeadline);
  assert.equal(exportStatus.status, 'completed', exportStatus.errorMessage);
  const exportFile = await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}/file`, headers: kamHeaders });
  assert.equal(exportFile.statusCode, 200, exportFile.body);
  assert.ok(exportFile.rawPayload.length > 0);
  const snapshotCsv = exportFile.rawPayload.toString('utf8').replace(/^\uFEFF/, '').split('\r\n');
  assert.deepEqual(snapshotCsv[0], 'ID активности,Тип,Активность');
  assert.equal(snapshotCsv.length - 2, snapshot.rowCount, 'CSV exports every row in the author- and scope-protected report snapshot.');
  assert.ok(snapshotCsv.some((line: string) => line.includes(corporateId)));
  assert.ok(snapshotCsv.some((line: string) => line.includes(individualId)));

  const managerScope = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${scopedManager.sub}/scope`, headers: adminHeaders,
    payload: { allowedKinds: ['corporate'], expectedRevision: 0, reason: 'A11 manager scope integration test' } });
  assert.equal(managerScope.statusCode, 200, managerScope.body);
  const managerPage = await app.inject({ method: 'GET', url: '/api/activities?limit=100', headers: managerHeaders });
  assert.equal(managerPage.statusCode, 200, managerPage.body);
  assert.ok(managerPage.json().items.every((item: { kind: string }) => item.kind === 'corporate'));
  const overview = await app.inject({ method: 'GET', url: '/api/manager/overview', headers: managerHeaders });
  assert.equal(overview.json().metrics.byKind.university, 0);
  assert.equal(overview.json().metrics.byKind.individual, 0);
  const pipelineLanes = overview.json().pipeline as { kind: string; stages: { count: number }[] }[];
  for (const lane of pipelineLanes.filter((item) => item.kind === 'university' || item.kind === 'individual')) {
    assert.equal(lane.stages.reduce((sum, stage) => sum + stage.count, 0), 0, 'Pipeline counts follow the manager’s allowed segment scope.');
  }
  const hiddenAssignment = await app.inject({ method: 'POST', url: `/api/manager/activities/${universityId}/reassignment/preview`, headers: managerHeaders,
    payload: { targetKamSub, expectedOwnerSub: subject.sub, expectedAssignmentRevision: 0 } });
  assert.equal(hiddenAssignment.statusCode, 404);
  const allowedAssignment = await app.inject({ method: 'POST', url: `/api/manager/activities/${corporateId}/reassignment/preview`, headers: managerHeaders,
    payload: { targetKamSub, expectedOwnerSub: subject.sub, expectedAssignmentRevision: 0 } });
  assert.equal(allowedAssignment.statusCode, 200, allowedAssignment.body);
  assert.equal(allowedAssignment.json().canConfirm, true);

  const narrowing = await Promise.all([
    app.inject({ method: 'PUT', url: `/api/admin/access/users/${subject.sub}/scope`, headers: adminHeaders,
      payload: { allowedKinds: ['individual'], expectedRevision: 1, reason: 'A11 scope reduction test' } }),
    app.inject({ method: 'PUT', url: `/api/admin/access/users/${subject.sub}/scope`, headers: adminHeaders,
      payload: { allowedKinds: ['individual'], expectedRevision: 1, reason: 'A11 stale concurrent update' } }),
  ]);
  assert.deepEqual(narrowing.map((response) => response.statusCode).sort(), [200, 409]);
  const currentPolicy = await pool.query('SELECT allowed_kinds,scope_revision FROM known_crm_users WHERE user_sub=$1', [subject.sub]);
  assert.deepEqual(currentPolicy.rows[0], { allowed_kinds: ['individual'], scope_revision: 2 });
  const audits = await pool.query(`SELECT count(*)::integer AS count FROM crm_activity_scope_audit WHERE target_sub=$1`, [subject.sub]);
  assert.equal(audits.rows[0].count, 2);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${corporateId}`, headers: kamHeaders })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${individualId}`, headers: kamHeaders })).statusCode, 200);
  for (const url of [
    `/api/reports/snapshots/${snapshot.snapshotId}`,
    `/api/reports/exports/${exportId}`,
    `/api/reports/exports/${exportId}/file`,
  ]) {
    const revoked = await app.inject({ method: 'GET', url, headers: kamHeaders });
    assert.equal(revoked.statusCode, 403, `Narrowed segment policy revokes saved report access at ${url}`);
    assert.equal(revoked.json().code, 'report_scope_changed');
  }
  const deniedOldSnapshotExport = await app.inject({ method: 'POST', url: '/api/reports/exports', headers: kamHeaders,
    payload: { snapshotId: snapshot.snapshotId, format: 'json' } });
  assert.equal(deniedOldSnapshotExport.statusCode, 403);
  assert.equal(deniedOldSnapshotExport.json().code, 'report_scope_changed');
});

test('PostgreSQL organization scope covers both organization links, creation, manager data, reassignment and saved files', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const operator: Actor = { sub: `a12-admin-${suffix}`, name: 'A12 admin', roles: ['admin'] };
  const subject: Actor = { sub: `a12-kam-${suffix}`, name: 'A12 KAM', roles: ['kam'] };
  const scopedManager: Actor = { sub: `a12-manager-${suffix}`, name: 'A12 manager', roles: ['manager'] };
  const workflowAdmin: Actor = { sub: `a12-workflow-admin-${suffix}`, name: 'A12 workflow admin', roles: ['admin', 'manager'] };
  const targetKamSub = `a12-target-kam-${suffix}`;
  const testAuthenticate: Authenticator = async (request) => {
    if (request.headers['x-test-user'] === 'admin') return operator;
    if (request.headers['x-test-user'] === 'manager') return scopedManager;
    if (request.headers['x-test-user'] === 'workflow-admin') return workflowAdmin;
    if (request.headers['x-test-user'] === 'target') return { sub: targetKamSub, name: 'A12 target KAM', roles: ['kam'] };
    return subject;
  };
  const app = buildApp({ repository: new PostgresRepository(), authenticate: testAuthenticate, accessPolicy: new PostgresAccessPolicyService() });
  await app.ready();
  const activityIds: string[] = [];
  const organizationIds: string[] = [];
  const personIds: string[] = [];
  const reportActorSubs = [subject.sub];
  const documentIds: string[] = [];
  const workflowActivityIds: string[] = [];
  let originalWorkflow: any;
  context.after(async () => {
    await app.close();
    const files = await pool.query('SELECT file_key AS "fileKey" FROM report_jobs WHERE actor_sub=ANY($1::text[]) AND file_key IS NOT NULL', [reportActorSubs]);
    await Promise.all((files.rows as { fileKey: string }[]).map((file) => removePrivateReport(file.fileKey)));
    await Promise.all(documentIds.map((id) => removePrivateDocument(id)));
    await pool.query('DELETE FROM report_jobs WHERE actor_sub=ANY($1::text[])', [reportActorSubs]);
    await pool.query('DELETE FROM crm_activity_scope_audit WHERE target_sub=ANY($1::text[])', [[operator.sub, subject.sub, scopedManager.sub, workflowAdmin.sub, targetKamSub]]);
    if (activityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    if (workflowActivityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [workflowActivityIds]);
    if (organizationIds.length) await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [organizationIds]);
    if (personIds.length) await pool.query('DELETE FROM people WHERE id=ANY($1::uuid[])', [personIds]);
    await pool.query('DELETE FROM known_crm_users WHERE user_sub=ANY($1::text[])', [[operator.sub, subject.sub, scopedManager.sub, workflowAdmin.sub, targetKamSub]]);
    await pool.query('DELETE FROM kam_directory WHERE user_sub=$1', [targetKamSub]);
  });

  const adminHeaders = { 'x-test-user': 'admin' };
  const kamHeaders = { 'x-test-user': 'kam' };
  const managerHeaders = { 'x-test-user': 'manager' };
  const workflowHeaders = { 'x-test-user': 'workflow-admin' };
  const createActivity = async (headers: Record<string, string>, payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/api/activities', headers, payload });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { id: string };
  };
  const detail = async (headers: Record<string, string>, id: string) => {
    const response = await app.inject({ method: 'GET', url: `/api/activities/${id}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { organizationId: string | null; payerOrganizationId: string | null; personId: string | null };
  };
  const updateKinds = async (sub: string, allowedKinds: string[] | null, expectedRevision: number) => app.inject({
    method: 'PUT', url: `/api/admin/access/users/${sub}/scope`, headers: adminHeaders,
    payload: { allowedKinds, expectedRevision, reason: 'A12 regression scope' },
  });
  const updateOrganizations = async (sub: string, allowedOrganizationIds: string[] | null, expectedRevision: number) => app.inject({
    method: 'PUT', url: `/api/admin/access/users/${sub}/organizations`, headers: adminHeaders,
    payload: { allowedOrganizationIds, expectedRevision, reason: 'A12 regression organization scope' },
  });

  await pool.query(`INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source)
    VALUES($1,'A12 target KAM',TRUE,'local-keycloak-provisioning')`, [targetKamSub]);
  await app.inject({ method: 'GET', url: '/api/activities', headers: { 'x-test-user': 'target' } });
  await app.inject({ method: 'GET', url: '/api/activities', headers: adminHeaders });
  await app.inject({ method: 'GET', url: '/api/activities', headers: managerHeaders });
  await app.inject({ method: 'GET', url: '/api/activities', headers: workflowHeaders });

  const primaryActivity = await createActivity(kamHeaders, { kind: 'corporate', title: `A12 primary ${suffix}`, organizationName: `A12 primary org ${suffix}` });
  activityIds.push(primaryActivity.id);
  const primaryDetail = await detail(kamHeaders, primaryActivity.id);
  assert.ok(primaryDetail.organizationId);
  organizationIds.push(primaryDetail.organizationId!);
  const dualActivity = await createActivity(kamHeaders, {
    kind: 'corporate', title: `A12 dual allowed ${suffix}`, organizationName: `A12 secondary org ${suffix}`, payerOrganizationName: `A12 payer org ${suffix}`,
  });
  activityIds.push(dualActivity.id);
  const dualDetail = await detail(kamHeaders, dualActivity.id);
  assert.ok(dualDetail.organizationId && dualDetail.payerOrganizationId);
  organizationIds.push(dualDetail.organizationId!, dualDetail.payerOrganizationId!);
  const deniedDualActivity = await createActivity(kamHeaders, {
    kind: 'corporate', title: `A12 dual denied ${suffix}`, organizationName: `A12 denied primary ${suffix}`, payerOrganizationName: `A12 denied payer ${suffix}`,
  });
  activityIds.push(deniedDualActivity.id);
  const deniedDualDetail = await detail(kamHeaders, deniedDualActivity.id);
  assert.ok(deniedDualDetail.organizationId && deniedDualDetail.payerOrganizationId);
  organizationIds.push(deniedDualDetail.organizationId!, deniedDualDetail.payerOrganizationId!);
  const individualActivity = await createActivity(kamHeaders, { kind: 'individual', title: `A12 individual ${suffix}`, personName: `A12 person ${suffix}` });
  activityIds.push(individualActivity.id);
  const individualDetail = await detail(kamHeaders, individualActivity.id);
  assert.equal(individualDetail.organizationId, null);
  assert.equal(individualDetail.payerOrganizationId, null);
  personIds.push(individualDetail.personId!);
  const allowedIds = [primaryDetail.organizationId!, dualDetail.organizationId!, dualDetail.payerOrganizationId!];

  const names = await app.inject({ method: 'GET', url: `/api/admin/access/organizations?search=${encodeURIComponent(`A12 payer org ${suffix}`)}`, headers: adminHeaders });
  assert.equal(names.statusCode, 200, names.body);
  assert.equal(names.json().organizations.length, 1);
  assert.deepEqual(Object.keys(names.json().organizations[0]).sort(), ['id', 'name', 'segment']);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/access/organizations', headers: kamHeaders })).statusCode, 403);

  const subjectKinds = await updateKinds(subject.sub, ['corporate', 'individual'], 0);
  assert.equal(subjectKinds.statusCode, 200, subjectKinds.body);
  const subjectOrgScope = await updateOrganizations(subject.sub, allowedIds, 1);
  assert.equal(subjectOrgScope.statusCode, 200, subjectOrgScope.body);
  assert.deepEqual(subjectOrgScope.json().allowedOrganizationIds, allowedIds);
  assert.equal(subjectOrgScope.json().scopeRevision, 2);
  const managerKinds = await updateKinds(scopedManager.sub, ['corporate', 'individual'], 0);
  assert.equal(managerKinds.statusCode, 200, managerKinds.body);
  const managerOrgScope = await updateOrganizations(scopedManager.sub, allowedIds, 1);
  assert.equal(managerOrgScope.statusCode, 200, managerOrgScope.body);

  const scopedQueue = await app.inject({ method: 'GET', url: '/api/activities?limit=100', headers: kamHeaders });
  assert.equal(scopedQueue.statusCode, 200, scopedQueue.body);
  const visibleIds = new Set(scopedQueue.json().items.map((item: { id: string }) => item.id));
  assert.equal(visibleIds.has(primaryActivity.id), true);
  assert.equal(visibleIds.has(dualActivity.id), true, 'both the primary organization and payer are allowed');
  assert.equal(visibleIds.has(deniedDualActivity.id), false, 'a disallowed payer hides an otherwise allowed primary organization');
  assert.equal(visibleIds.has(individualActivity.id), true, 'an individual with no organization links remains in process scope');
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${deniedDualActivity.id}`, headers: kamHeaders })).statusCode, 404);
  const narrowedReference = await app.inject({ method: 'POST', url: '/api/activities', headers: kamHeaders, payload: {
    kind: 'corporate', title: `A12 new by reference ${suffix}`, organizationId: primaryDetail.organizationId,
  } });
  assert.equal(narrowedReference.statusCode, 201, narrowedReference.body);
  activityIds.push(narrowedReference.json().id);
  const deniedNameCreate = await app.inject({ method: 'POST', url: '/api/activities', headers: kamHeaders, payload: {
    kind: 'corporate', title: `A12 new name denied ${suffix}`, organizationName: `A12 blocked name ${suffix}`,
  } });
  assert.equal(deniedNameCreate.statusCode, 403);
  assert.equal(deniedNameCreate.json().code, 'organization_scope_forbidden');
  const deniedReferenceCreate = await app.inject({ method: 'POST', url: '/api/activities', headers: kamHeaders, payload: {
    kind: 'corporate', title: `A12 new payer denied ${suffix}`, organizationId: primaryDetail.organizationId,
    payerOrganizationId: deniedDualDetail.payerOrganizationId,
  } });
  assert.equal(deniedReferenceCreate.statusCode, 403);
  assert.equal(deniedReferenceCreate.json().code, 'organization_scope_forbidden');

  const managerQueue = await app.inject({ method: 'GET', url: '/api/activities?limit=100', headers: managerHeaders });
  assert.equal(managerQueue.statusCode, 200, managerQueue.body);
  assert.equal(managerQueue.json().items.some((item: { id: string }) => item.id === deniedDualActivity.id), false);
  const overview = await app.inject({ method: 'GET', url: '/api/manager/overview', headers: managerHeaders });
  assert.equal(overview.statusCode, 200, overview.body);
  const expectedManagerOpen = await pool.query(`SELECT count(*)::integer AS count FROM activities a WHERE a.closed=FALSE
    AND a.kind=ANY($1::text[]) AND (a.import_owner_only=FALSE OR a.owner_sub=$2)
    AND (a.organization_id IS NULL OR a.organization_id=ANY($3::uuid[]))
    AND (a.payer_organization_id IS NULL OR a.payer_organization_id=ANY($3::uuid[]))`, [['corporate', 'individual'], scopedManager.sub, allowedIds]);
  assert.equal(overview.json().metrics.totalOpen, expectedManagerOpen.rows[0].count);

  const targetOrgScope = await updateOrganizations(targetKamSub, [primaryDetail.organizationId!], 0);
  assert.equal(targetOrgScope.statusCode, 200, targetOrgScope.body);
  const reassignmentPreview = await app.inject({ method: 'POST', url: `/api/manager/activities/${primaryActivity.id}/reassignment/preview`, headers: managerHeaders, payload: {
    targetKamSub, expectedOwnerSub: subject.sub, expectedAssignmentRevision: 0,
  } });
  assert.equal(reassignmentPreview.statusCode, 200, reassignmentPreview.body);
  const revisedTargetScope = await updateOrganizations(targetKamSub, [dualDetail.payerOrganizationId!], 1);
  assert.equal(revisedTargetScope.statusCode, 200, revisedTargetScope.body);
  const staleReassignment = await app.inject({ method: 'POST', url: `/api/manager/activities/${primaryActivity.id}/reassignment/confirm`, headers: managerHeaders,
    payload: { previewToken: reassignmentPreview.json().previewToken } });
  assert.equal(staleReassignment.statusCode, 409, staleReassignment.body);
  assert.equal(staleReassignment.json().code, 'target_kam_organization_restricted');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const upload = await app.inject({ method: 'POST', url: `/api/activities/${dualActivity.id}/documents?filename=a12-scope.png`, headers: { ...kamHeaders, 'content-type': 'application/octet-stream' }, payload: png });
  assert.equal(upload.statusCode, 201, upload.body);
  documentIds.push(upload.json().id);
  const snapshotResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: kamHeaders, payload: { reportId: 'crm_portfolio' } });
  assert.equal(snapshotResponse.statusCode, 201, snapshotResponse.body);
  const snapshotId = snapshotResponse.json().snapshotId as string;
  assert.ok(snapshotResponse.json().rows.some((row: { activityId: string }) => row.activityId === dualActivity.id));
  const exportResponse = await app.inject({ method: 'POST', url: '/api/reports/exports', headers: kamHeaders, payload: { snapshotId, format: 'xlsx' } });
  assert.equal(exportResponse.statusCode, 202, exportResponse.body);
  const exportId = exportResponse.json().id as string;
  let exportStatus: any;
  const exportDeadline = Date.now() + 20_000;
  do {
    const status = await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}`, headers: kamHeaders });
    assert.equal(status.statusCode, 200, status.body);
    exportStatus = status.json();
    if (exportStatus.status === 'completed' || exportStatus.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < exportDeadline);
  assert.equal(exportStatus.status, 'completed', exportStatus.errorMessage);
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}/file`, headers: kamHeaders })).statusCode, 200);

  const reducedScope = await updateOrganizations(subject.sub, [primaryDetail.organizationId!], 2);
  assert.equal(reducedScope.statusCode, 200, reducedScope.body);
  assert.equal(reducedScope.json().scopeRevision, 3);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${dualActivity.id}`, headers: kamHeaders })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${dualActivity.id}/documents/${documentIds[0]}`, headers: kamHeaders })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${individualActivity.id}`, headers: kamHeaders })).statusCode, 200);
  for (const url of [`/api/reports/snapshots/${snapshotId}`, `/api/reports/exports/${exportId}`, `/api/reports/exports/${exportId}/file`]) {
    const revoked = await app.inject({ method: 'GET', url, headers: kamHeaders });
    assert.equal(revoked.statusCode, 403, `organization scope reduction revokes ${url}`);
    assert.equal(revoked.json().code, 'report_scope_changed');
  }
  const staleScope = await updateOrganizations(subject.sub, null, 2);
  assert.equal(staleScope.statusCode, 409);
  assert.equal(staleScope.json().code, 'scope_revision_conflict');
  const scopeAudit = await pool.query(`SELECT previous_allowed_organization_ids,allowed_organization_ids,revision,reason
    FROM crm_activity_scope_audit WHERE target_sub=$1 ORDER BY revision`, [subject.sub]);
  assert.deepEqual(scopeAudit.rows.map((row) => Number(row.revision)), [1, 2, 3]);
  assert.deepEqual(scopeAudit.rows[1].allowed_organization_ids, allowedIds);
  assert.deepEqual(scopeAudit.rows[2].previous_allowed_organization_ids, allowedIds);

  const workflowActivity = await createActivity(workflowHeaders, { kind: 'university', title: `A12 workflow secret ${suffix}`, organizationName: `A12 workflow org ${suffix}` });
  workflowActivityIds.push(workflowActivity.id);
  const workflowDetail = await detail(workflowHeaders, workflowActivity.id);
  organizationIds.push(workflowDetail.organizationId!);
  originalWorkflow = (await app.inject({ method: 'GET', url: '/api/admin/workflow/university', headers: workflowHeaders })).json();
  const workflowAdminScope = await updateOrganizations(workflowAdmin.sub, [], 0);
  assert.equal(workflowAdminScope.statusCode, 200, workflowAdminScope.body);
  const first = originalWorkflow.stages[0];
  const second = originalWorkflow.stages[1];
  const temporaryStageKey = `a12_${suffix.replaceAll('-', '')}`;
  try {
    const prepare = {
      expectedRevision: originalWorkflow.revision,
      stages: [originalWorkflow.stages[0], { key: temporaryStageKey, label: 'A12 temporary regression stage', ordinal: 2, terminal: false },
        ...originalWorkflow.stages.slice(1).map((stage: any, index: number) => ({ ...stage, ordinal: index + 3 }))],
      transitions: [...originalWorkflow.transitions, { from: first.key, to: temporaryStageKey }, { from: temporaryStageKey, to: second.key }],
      mappings: {},
    };
    const preparePreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: workflowHeaders, payload: prepare });
    assert.equal(preparePreview.statusCode, 200, preparePreview.body);
    const prepareApply = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: workflowHeaders, payload: { ...prepare, previewToken: preparePreview.json().previewToken } });
    assert.equal(prepareApply.statusCode, 200, prepareApply.body);
    await pool.query('UPDATE activities SET stage_key=$2 WHERE id=$1::uuid', [workflowActivity.id, temporaryStageKey]);
    const draft = {
      expectedRevision: prepareApply.json().revision,
      stages: prepare.stages.filter((stage: any) => stage.key !== temporaryStageKey).map((stage: any, index: number) => ({ ...stage, ordinal: index + 1 })),
      transitions: prepare.transitions.filter((edge: any) => edge.from !== temporaryStageKey && edge.to !== temporaryStageKey),
      mappings: { [temporaryStageKey]: second.key },
    };
    const workflowPreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: workflowHeaders, payload: draft });
    assert.equal(workflowPreview.statusCode, 200, workflowPreview.body);
    assert.equal(workflowPreview.json().impactedActivities.find((activity: any) => activity.id === workflowActivity.id).title, null,
      'the preview hides a university name outside the administrator-manager organization scope');
    const workflowApply = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: workflowHeaders, payload: { ...draft, previewToken: workflowPreview.json().previewToken } });
    assert.equal(workflowApply.statusCode, 200, workflowApply.body);
    assert.equal(workflowApply.json().changedActivities.find((activity: any) => activity.id === workflowActivity.id).title, null,
      'the apply response repeats the business-name redaction');
  } finally {
    const current = (await app.inject({ method: 'GET', url: '/api/admin/workflow/university', headers: workflowHeaders })).json();
    if (current.revision !== originalWorkflow.revision) {
      const restore = { expectedRevision: current.revision, stages: originalWorkflow.stages, transitions: originalWorkflow.transitions, mappings: {} };
      const restorePreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: workflowHeaders, payload: restore });
      if (restorePreview.statusCode === 200) {
        await app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: workflowHeaders, payload: { ...restore, previewToken: restorePreview.json().previewToken } });
      }
    }
  }
});

test('PostgreSQL persists independent activities, outcomes, tasks and validated stage changes', { skip: !runIntegration }, async (context) => {
  await pool.query('SELECT 1 FROM activities LIMIT 1');
  const individualStages = await pool.query("SELECT stage_key, ordinal FROM workflow_stages WHERE kind='individual'");
  const ordinalByKey = Object.fromEntries(individualStages.rows.map((stage: { stage_key: string; ordinal: number }) => [stage.stage_key, Number(stage.ordinal)]));
  assert.deepEqual(Object.fromEntries(['request', 'consultation', 'enrollment', 'learning', 'closed', 'conditions', 'lms_handoff', 'exceptions', 'result'].map((key) => [key, ordinalByKey[key]])), {
    request: 1, consultation: 2, enrollment: 3, learning: 4, closed: 5, conditions: 6, lms_handoff: 7, exceptions: 8, result: 9,
  });
  const organizationName = `B01-интеграция-${randomUUID()}`;
  const personName = `Слушатель-${randomUUID()}`;
  const companyName = `B01-компания-${randomUUID()}`;
  const repo = new PostgresRepository();
  const imports = new PostgresImportService();
  const mockStateDirectory = await mkdtemp(join(tmpdir(), 'crm-b09-integration-'));
  const [cmsMock, lmsMock] = await Promise.all([
    startCmsMock(0, { statePath: join(mockStateDirectory, 'cms.json') }),
    startLmsMock(0, { statePath: join(mockStateDirectory, 'lms.json') }),
  ]);
  const exchanges = new PostgresExchangeService(repo, { cmsUrl: cmsMock.url, lmsUrl: lmsMock.url });
  let app = buildApp({ repository: repo, imports, exchanges, authenticate });
  await app.ready();
  const createdActivityIds: string[] = [];
  const orgIds: string[] = [];
  const personIds: string[] = [];
  const documentKeys: string[] = [];
  const importJobIds: string[] = [];
  const importedVendorIds: string[] = [];
  const importSources: string[] = [];
  const importedProductNames: string[] = [];
  const reportActorSubs = [kamA.sub, kamB.sub, manager.sub, admin.sub, managerAdmin.sub, largeReportKam.sub];
  // Recover only the recognizable synthetic bulk fixtures from an interrupted prior test run.
  await pool.query("DELETE FROM activities WHERE title LIKE 'B12 строка %' AND owner_sub=ANY($1::text[])", [[largeReportKam.sub, kamB.sub]]);
  await pool.query(`DELETE FROM organizations org WHERE org.name LIKE 'B12 большой отчёт %'
    AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.organization_id=org.id)`);
  const staleReports = await pool.query('SELECT file_key AS "fileKey" FROM report_jobs WHERE actor_sub=ANY($1::text[]) AND file_key IS NOT NULL', [reportActorSubs]);
  await Promise.all((staleReports.rows as { fileKey: string }[]).map((file) => removePrivateReport(file.fileKey)));
  await pool.query('DELETE FROM report_jobs WHERE actor_sub=ANY($1::text[])', [reportActorSubs]);
  context.after(async () => {
    await app.close();
    await Promise.all([cmsMock.close(), lmsMock.close()]);
    await rm(mockStateDirectory, { recursive: true, force: true });
    await pool.query('DELETE FROM exchange_jobs WHERE actor_sub = ANY($1::text[])', [[kamA.sub, kamB.sub, admin.sub, managerAdmin.sub]]);
    const reportFiles = await pool.query('SELECT file_key AS "fileKey" FROM report_jobs WHERE actor_sub=ANY($1::text[]) AND file_key IS NOT NULL', [reportActorSubs]);
    await Promise.all((reportFiles.rows as { fileKey: string }[]).map((file) => removePrivateReport(file.fileKey)));
    await pool.query('DELETE FROM report_jobs WHERE actor_sub=ANY($1::text[])', [reportActorSubs]);
    await Promise.all(documentKeys.map((key) => removePrivateDocument(key)));
    if (importJobIds.length) {
      await pool.query('DELETE FROM import_provenance WHERE job_id = ANY($1::uuid[])', [importJobIds]);
      await pool.query('DELETE FROM import_jobs WHERE id = ANY($1::uuid[])', [importJobIds]);
    }
    if (importSources.length) await pool.query('DELETE FROM import_identities WHERE owner_sub=$1 AND source_system = ANY($2::text[])', [kamA.sub, importSources]);
    if (importedVendorIds.length) await pool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [importedVendorIds]);
    await pool.query('DELETE FROM activities WHERE owner_sub=$1', [largeReportKam.sub]);
    if (orgIds.length) await pool.query('DELETE FROM activities WHERE organization_id = ANY($1::uuid[])', [orgIds]);
    if (createdActivityIds.length) await pool.query('DELETE FROM activities WHERE id = ANY($1::uuid[])', [createdActivityIds]);
    if (importedProductNames.length) await pool.query('DELETE FROM products WHERE name = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM activity_products ap WHERE ap.product_id = products.id)', [importedProductNames]);
    if (orgIds.length) await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgIds]);
    if (personIds.length) await pool.query('DELETE FROM people WHERE id = ANY($1::uuid[])', [personIds]);
  });

  const directBoundaryActor: Actor = { sub: `direct-origin-boundary-${randomUUID()}`, name: 'Boundary test', roles: ['kam'] };
  const expectDirectRepositoryRejection = async (input: { kind: 'individual'; title: string; origin?: 'manual' | 'external_ready'; originSource?: string; originReference?: string }) => {
    try {
      const created = await repo.createActivity(directBoundaryActor, input);
      await pool.query('DELETE FROM activities WHERE id=$1::uuid', [created.id]);
      assert.fail('PostgresRepository.createActivity accepted external origin metadata.');
    } catch (error) {
      assert.ok(error instanceof DomainError, `Expected DomainError, received ${String(error)}`);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'external_origin_import_only');
    }
  };
  await expectDirectRepositoryRejection({ kind: 'individual', title: 'Rejected direct external order', origin: 'external_ready', originSource: 'synthetic test', originReference: `direct-${randomUUID()}` });
  await expectDirectRepositoryRejection({ kind: 'individual', title: 'Rejected direct metadata', origin: 'manual', originSource: 'synthetic test' });

  // CMS mock's built-in lead is deliberately stable, so clear only this synthetic fixture from an interrupted prior run.
  const staleCmsDemo = await pool.query(`SELECT id,person_id,organization_id FROM activities
    WHERE origin='cms_mock' AND origin_reference='CMS-REQ-001'`);
  await pool.query("DELETE FROM exchange_jobs WHERE external_event_id='cms-demo-inquiry-001'");
  if (staleCmsDemo.rowCount) {
    const staleActivityIds = staleCmsDemo.rows.map((row: { id: string }) => row.id);
    const stalePersonIds = staleCmsDemo.rows.map((row: { person_id: string | null }) => row.person_id).filter(Boolean);
    const staleOrganizationIds = staleCmsDemo.rows.map((row: { organization_id: string | null }) => row.organization_id).filter(Boolean);
    await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [staleActivityIds]);
    if (stalePersonIds.length) await pool.query('DELETE FROM people WHERE id=ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM activities WHERE activities.person_id=people.id)', [stalePersonIds]);
    if (staleOrganizationIds.length) await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM activities WHERE activities.organization_id=organizations.id OR activities.payer_organization_id=organizations.id)', [staleOrganizationIds]);
  }

  const expiredPreviewId = randomUUID(); importJobIds.push(expiredPreviewId);
  await pool.query(`INSERT INTO import_jobs(id,actor_sub,actor_name,target,source_system,file_name,file_format,payload,status,revision,expires_at)
    VALUES($1,$2,$3,'contacts','cleanup-test','cleanup-test.xlsx','xlsx','{"sheets":[{"name":"User Uploads","rows":[[{"value":"private","unsafe":null}]]}]}','preview_ready',1,now()-interval '1 minute')`, [expiredPreviewId, kamA.sub, kamA.name]);
  const cleanupErrors: unknown[] = [];
  const cleanupTimer = scheduleImportPreviewCleanup((error) => cleanupErrors.push(error), 10);
  let expiredWithoutRequest = false;
  try {
    const deadline = Date.now() + 1000;
    while (!expiredWithoutRequest && Date.now() < deadline) {
      const status = await pool.query('SELECT status,payload FROM import_jobs WHERE id=$1', [expiredPreviewId]);
      expiredWithoutRequest = status.rows[0]?.status === 'expired' && status.rows[0]?.payload?.sheets?.length === 0;
      if (!expiredWithoutRequest) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally { clearInterval(cleanupTimer); }
  assert.equal(expiredWithoutRequest, true, 'Scheduled cleanup scrubs an expired preview without any import request.');
  assert.equal(cleanupErrors.length, 0);

  const catalogResponse = await app.inject({ method: 'GET', url: '/api/catalog', headers: { 'x-test-user': 'a' } });
  assert.equal(catalogResponse.statusCode, 200);
  const catalog = catalogResponse.json();
  const productIds = catalog.products.slice(0, 2).map((product: { id: string }) => product.id);
  const create = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'university', title: 'Согласовать пилотную программу', organizationName, personName: 'Координатор',
    email: 'coordinator@local.test', phone: '+70000000000', productIds,
  } });
  assert.equal(create.statusCode, 201, create.body);
  const first = create.json(); createdActivityIds.push(first.id);

  const deniedBusinessRequests = await Promise.all([
    app.inject({ method: 'GET', url: '/api/catalog', headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'GET', url: '/api/activities', headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'GET', url: '/api/contacts', headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'GET', url: '/api/vendors', headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'GET', url: '/api/guidance/university/contact', headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'GET', url: '/api/reports/ready', headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'admin' }, payload: { reportId: 'crm_portfolio' } }),
    app.inject({ method: 'GET', url: '/api/manager/overview', headers: { 'x-test-user': 'admin' } }),
  ]);
  assert.ok(deniedBusinessRequests.every((response) => response.statusCode === 403),
    `Admin-only direct business requests are denied: ${deniedBusinessRequests.map((response) => response.statusCode).join(',')}`);
  const encodedBusinessRequests = await Promise.all([
    app.inject({ method: 'GET', url: '/api/%63ontacts', headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'GET', url: '/api/%76endors', headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'GET', url: `/api/%69mports/${first.id}`, headers: { 'x-test-user': 'admin' } }),
    app.inject({ method: 'POST', url: '/api/%69mports?filename=admin-denied.json&target=contacts&source=test', headers: { 'x-test-user': 'admin', 'content-type': 'application/vnd.lct.import' }, payload: Buffer.from('{}') }),
  ]);
  assert.ok(encodedBusinessRequests.every((response) => response.statusCode === 403),
    `Percent-encoded business route names remain role-gated after Fastify route matching: ${encodedBusinessRequests.map((response) => response.statusCode).join(',')}`);
  const roleDenied = (error: unknown) => error instanceof DomainError && error.statusCode === 403;
  const directImportCalls = [
    imports.upload(admin, 'admin-denied.json', 'contacts', 'test', Buffer.from('{}')),
    imports.get(admin, first.id),
    imports.getHeader(admin, first.id, 'sheet', 1),
    imports.preview(admin, first.id, { revision: 1, selectedSheet: 'sheet', headerRow: 1, mapping: {} }),
    imports.confirm(admin, first.id, { revision: 1, idempotencyKey: 'admin-denied-1', rowNumbers: [], reviewedRows: [] }),
    imports.cancel(admin, first.id),
    imports.listContacts(admin, ''),
    imports.listVendors(admin),
  ];
  await Promise.all(directImportCalls.map((call) => assert.rejects(call, roleDenied,
    'The import service enforces business access independently of URL routing.')));
  assert.deepEqual(await repo.getActivity(admin, first.id), null, 'The repository scope predicate also denies an admin-only direct card lookup.');
  const adminQueue = await repo.listActivities(admin, { segment: 'all', collection: 'all', offset: 0, limit: 100 });
  assert.equal(adminQueue.total, 0, 'The repository scope predicate does not turn an admin-only role into a team query.');
  await assert.rejects(repo.catalog(admin), (error: unknown) => error instanceof DomainError && error.statusCode === 403);
  await assert.rejects(repo.managerOverview(admin), (error: unknown) => error instanceof DomainError && error.statusCode === 403);
  const emptyAdminSnapshotId = randomUUID();
  await pool.query(`INSERT INTO report_jobs(id,job_type,report_id,actor_sub,actor_name,parameters,payload,row_count,status,expires_at)
    VALUES($1,'snapshot','crm_portfolio',$2,$3,'{}'::jsonb,'{}'::jsonb,0,'completed',now()+interval '1 hour')`, [emptyAdminSnapshotId, admin.sub, admin.name]);
  await assert.rejects(new ReportService().getSnapshot(admin, emptyAdminSnapshotId),
    (error: unknown) => error instanceof DomainError && error.statusCode === 403,
    'An old admin-owned empty snapshot cannot bypass the role check just because it has no rows to scope.');
  const combinedActivity = await app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'admin-manager' } });
  assert.equal(combinedActivity.statusCode, 200, combinedActivity.body);
  assert.equal(combinedActivity.json().title, first.title);
  const combinedCatalog = await app.inject({ method: 'GET', url: '/api/catalog', headers: { 'x-test-user': 'admin-manager' } });
  assert.equal(combinedCatalog.statusCode, 200, combinedCatalog.body);
  assert.ok(combinedCatalog.json().organizations.some((organization: { name: string }) => organization.name === organizationName));
  const combinedReportCreate = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'admin-manager' }, payload: { reportId: 'crm_portfolio' } });
  assert.equal(combinedReportCreate.statusCode, 201, combinedReportCreate.body);
  const combinedReport = await app.inject({ method: 'GET', url: `/api/reports/snapshots/${combinedReportCreate.json().snapshotId}`, headers: { 'x-test-user': 'admin-manager' } });
  assert.equal(combinedReport.statusCode, 200, combinedReport.body);
  assert.ok(combinedReport.json().rows.some((row: { activityId: string }) => row.activityId === first.id));
  const detail = await app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(detail.statusCode, 200);
  orgIds.push(detail.json().organizationId); personIds.push(detail.json().personId);
  assert.equal(detail.json().productNames.length, 2);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const fileUpload = await app.inject({ method: 'POST', url: `/api/activities/${first.id}/documents?filename=integration.png`, headers: { 'x-test-user': 'a', 'content-type': 'application/octet-stream' }, payload: png });
  assert.equal(fileUpload.statusCode, 201, fileUpload.body);
  const persistedDocument = fileUpload.json();
  documentKeys.push(persistedDocument.id);
  const persistedList = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/documents`, headers: { 'x-test-user': 'a' } });
  assert.equal(persistedList.statusCode, 200);
  assert.equal(persistedList.json()[0].sha256, persistedDocument.sha256);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${first.id}/documents`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${first.id}/documents/${persistedDocument.id}`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  const fileDownload = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/documents/${persistedDocument.id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(fileDownload.statusCode, 200);
  assert.deepEqual(fileDownload.rawPayload, png);
  assert.equal(fileDownload.headers['x-content-type-options'], 'nosniff');
  await pool.query('UPDATE activities SET owner_sub=$2, owner_name=$3 WHERE id=$1::uuid', [first.id, kamB.sub, kamB.name]);
  const previousOwnerDownload = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/documents/${persistedDocument.id}`, headers: { 'x-test-user': 'a' } });
  const newOwnerDownload = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/documents/${persistedDocument.id}`, headers: { 'x-test-user': 'b' } });
  assert.equal(previousOwnerDownload.statusCode, 404);
  assert.equal(newOwnerDownload.statusCode, 200);
  await pool.query('UPDATE activities SET owner_sub=$2, owner_name=$3 WHERE id=$1::uuid', [first.id, kamA.sub, kamA.name]);
  const documentAudit = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/history`, headers: { 'x-test-user': 'a' } });
  assert.ok(documentAudit.json().some((event: { eventType: string }) => event.eventType === 'document_uploaded'));
  assert.ok(documentAudit.json().some((event: { eventType: string }) => event.eventType === 'document_downloaded'));
  const otherKamCatalog = await app.inject({ method: 'GET', url: '/api/catalog', headers: { 'x-test-user': 'b' } });
  assert.equal(otherKamCatalog.json().organizations.some((organization: { id: string }) => organization.id === detail.json().organizationId), false);
  const scopeBypass = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'b' }, payload: {
    kind: 'university', title: 'Чужая организация', organizationId: detail.json().organizationId,
  } });
  assert.equal(scopeBypass.statusCode, 404);
  const personScopeBypass = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'b' }, payload: {
    kind: 'university', title: 'Чужой контакт', organizationName: `Второй вуз ${randomUUID()}`, personId: detail.json().personId,
  } });
  assert.equal(personScopeBypass.statusCode, 404);

  const second = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'university', title: 'Отдельная активность этого вуза', organizationId: detail.json().organizationId,
  } });
  assert.equal(second.statusCode, 201, second.body);
  createdActivityIds.push(second.json().id);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${second.json().id}`, headers: { 'x-test-user': 'a' } })).statusCode, 200);

  const universityCustomer = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'corporate', title: 'Корпоративное обучение для вуза', organizationId: detail.json().organizationId,
  } });
  assert.equal(universityCustomer.statusCode, 201, universityCustomer.body);
  createdActivityIds.push(universityCustomer.json().id);
  const universityCustomerDetail = await app.inject({ method: 'GET', url: `/api/activities/${universityCustomer.json().id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(universityCustomerDetail.json().organizationId, detail.json().organizationId);
  assert.equal(universityCustomerDetail.json().organizationSegment, 'university', 'using a university as a corporate customer must preserve its source segment');

  const universityPayer = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'individual', title: 'Индивидуальное обучение за счёт вуза', personName: `Плательщик-вуз-${randomUUID()}`, payerOrganizationId: detail.json().organizationId,
  } });
  assert.equal(universityPayer.statusCode, 201, universityPayer.body);
  createdActivityIds.push(universityPayer.json().id);
  const universityPayerDetail = await app.inject({ method: 'GET', url: `/api/activities/${universityPayer.json().id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(universityPayerDetail.json().payerOrganizationId, detail.json().organizationId);
  const preservedPayerSegment = await pool.query('SELECT segment FROM organizations WHERE id=$1::uuid', [universityPayerDetail.json().payerOrganizationId]);
  assert.equal(preservedPayerSegment.rows[0].segment, 'university', 'using a university as payer must not rewrite its source segment');

  const b2c = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'individual', title: 'Индивидуальный маршрут', personName, payerOrganizationName: 'Компания-плательщик B01',
  } });
  assert.equal(b2c.statusCode, 201, b2c.body);
  createdActivityIds.push(b2c.json().id);
  const individual = await app.inject({ method: 'GET', url: `/api/activities/${b2c.json().id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(individual.statusCode, 200);
  assert.equal(individual.json().organizationId, null);
  assert.equal(individual.json().payerOrganizationName, 'Компания-плательщик B01');
  assert.equal(individual.json().stageKey, 'request');
  assert.equal(individual.json().routeVersion, 'v2');
  assert.deepEqual(individual.json().allowedNext, ['consultation']);
  orgIds.push(individual.json().payerOrganizationId); personIds.push(individual.json().personId);
  let individualStage = 'request';
  for (const targetStage of ['consultation', 'conditions', 'lms_handoff']) {
    if (targetStage === 'conditions') {
      const atConsultation = await app.inject({ method: 'GET', url: `/api/activities/${b2c.json().id}`, headers: { 'x-test-user': 'a' } });
      assert.deepEqual(atConsultation.json().allowedNext, ['conditions']);
      const legacyEdgeRejected = await app.inject({ method: 'POST', url: `/api/activities/${b2c.json().id}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage: 'enrollment', expectedStageKey: individualStage, expectedWorkflowRevision: null } });
      assert.equal(legacyEdgeRejected.statusCode, 409);
    }
    const transition = await app.inject({ method: 'POST', url: `/api/activities/${b2c.json().id}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage, expectedStageKey: individualStage, expectedWorkflowRevision: null } });
    assert.equal(transition.statusCode, 200, transition.body);
    assert.equal(transition.json().stageKey, targetStage);
    individualStage = targetStage;
  }

  const legacyActivity = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'individual', title: 'Совместимость со старым маршрутом', personName: `Старый маршрут-${randomUUID()}`,
  } });
  assert.equal(legacyActivity.statusCode, 201, legacyActivity.body);
  createdActivityIds.push(legacyActivity.json().id);
  const legacyDetail = await app.inject({ method: 'GET', url: `/api/activities/${legacyActivity.json().id}`, headers: { 'x-test-user': 'a' } });
  personIds.push(legacyDetail.json().personId);
  const legacyFixtureToConsultation = await app.inject({ method: 'POST', url: `/api/activities/${legacyActivity.json().id}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage: 'consultation', expectedStageKey: 'request', expectedWorkflowRevision: null } });
  assert.equal(legacyFixtureToConsultation.statusCode, 200);
  await pool.query("UPDATE activities SET route_version='legacy' WHERE id=$1::uuid", [legacyActivity.json().id]);
  const beforeLegacyTransitionHistory = await app.inject({ method: 'GET', url: `/api/activities/${legacyActivity.json().id}/history`, headers: { 'x-test-user': 'a' } });
  assert.equal(beforeLegacyTransitionHistory.json().length, 2);
  const legacyAtConsultation = await app.inject({ method: 'GET', url: `/api/activities/${legacyActivity.json().id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(legacyAtConsultation.json().routeVersion, 'legacy');
  assert.equal(legacyAtConsultation.json().stageKey, 'consultation');
  assert.deepEqual(legacyAtConsultation.json().allowedNext, ['enrollment']);
  const v2EdgeRejected = await app.inject({ method: 'POST', url: `/api/activities/${legacyActivity.json().id}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage: 'conditions', expectedStageKey: 'consultation', expectedWorkflowRevision: null } });
  assert.equal(v2EdgeRejected.statusCode, 409);
  const legacyTransition = await app.inject({ method: 'POST', url: `/api/activities/${legacyActivity.json().id}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage: 'enrollment', expectedStageKey: 'consultation', expectedWorkflowRevision: null } });
  assert.equal(legacyTransition.statusCode, 200, legacyTransition.body);
  const afterLegacyTransitionHistory = await app.inject({ method: 'GET', url: `/api/activities/${legacyActivity.json().id}/history`, headers: { 'x-test-user': 'a' } });
  assert.equal(afterLegacyTransitionHistory.json().length, 3);
  for (const event of beforeLegacyTransitionHistory.json()) {
    assert.deepEqual(afterLegacyTransitionHistory.json().find((saved: { id: string }) => saved.id === event.id), event);
  }

  const externalOrderReference = `ORD-${randomUUID()}`;
  const externalOrder = await createAuditedExternalActivityFixture(kamA, {
    title: 'Готовый внешний заказ', personName: `Внешний слушатель-${randomUUID()}`,
    source: 'CMS orders mock', reference: externalOrderReference,
  });
  createdActivityIds.push(externalOrder.id);
  personIds.push(externalOrder.personId);
  const externalDetail = await app.inject({ method: 'GET', url: `/api/activities/${externalOrder.id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(externalDetail.statusCode, 200, externalDetail.body);
  assert.equal(externalDetail.json().origin, 'external_ready');
  assert.equal(externalDetail.json().originReference, externalOrderReference);
  assert.equal(externalDetail.json().stageKey, 'lms_handoff');
  assert.equal(externalDetail.json().organizationId, null);
  assert.deepEqual(externalDetail.json().tasks, []);
  const externalHistory = await app.inject({ method: 'GET', url: `/api/activities/${externalOrder.id}/history`, headers: { 'x-test-user': 'a' } });
  assert.equal(externalHistory.json().length, 1);
  assert.equal(externalHistory.json()[0].eventType, 'created');
  assert.equal(externalHistory.json()[0].details.initialStage, 'lms_handoff');
  assert.match(externalHistory.json()[0].details.mappingReason, /зачисление.*не создавались/i);
  const factsInitially = await app.inject({ method: 'GET', url: `/api/activities/${externalOrder.id}/learning-facts`, headers: { 'x-test-user': 'a' } });
  assert.equal(factsInitially.statusCode, 200);
  assert.deepEqual(factsInitially.json(), []);
  const learningFactId = randomUUID();
  const occurredAt = new Date('2026-09-26T12:34:00.000Z');
  await pool.query(`INSERT INTO individual_learning_facts(id, activity_id, fact_kind, source, occurred_at, reference)
    VALUES ($1::uuid, $2::uuid, 'enrollment', 'LMS mock', $3::timestamptz, 'enroll-ref-101')`, [learningFactId, externalOrder.id, occurredAt]);
  const facts = await app.inject({ method: 'GET', url: `/api/activities/${externalOrder.id}/learning-facts`, headers: { 'x-test-user': 'a' } });
  assert.equal(facts.statusCode, 200, facts.body);
  assert.deepEqual(facts.json(), [{ id: learningFactId, factKind: 'enrollment', source: 'LMS mock', occurredAt: occurredAt.toISOString(), reference: 'enroll-ref-101' }]);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${externalOrder.id}/learning-facts`, headers: { 'x-test-user': 'b' } })).statusCode, 404);

  const kamAdminPanelForbidden = await app.inject({ method: 'GET', url: '/api/admin/exchanges', headers: { 'x-test-user': 'a' } });
  assert.equal(kamAdminPanelForbidden.statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/exchanges/mocks/lms/fail-next', headers: { 'x-test-user': 'a' }, payload: { mode: 'http_error' } })).statusCode, 403);
  const cmsFailureConfigured = await app.inject({ method: 'POST', url: '/api/admin/exchanges/mocks/cms/fail-next', headers: { 'x-test-user': 'admin' }, payload: { mode: 'http_error' } });
  assert.equal(cmsFailureConfigured.statusCode, 200, cmsFailureConfigured.body);
  const cmsFailedPull = await app.inject({ method: 'POST', url: '/api/admin/exchanges/cms/pull', headers: { 'x-test-user': 'admin' } });
  assert.equal(cmsFailedPull.statusCode, 200, cmsFailedPull.body);
  assert.equal(cmsFailedPull.json().status, 'retryable_error');
  assert.equal(cmsFailedPull.json().attemptCount, 1);
  assert.equal((await app.inject({ method: 'POST', url: `/api/exchanges/${cmsFailedPull.json().id}/retry`, headers: { 'x-test-user': 'a' } })).statusCode, 404);
  const cmsRetriedPull = await app.inject({ method: 'POST', url: `/api/exchanges/${cmsFailedPull.json().id}/retry`, headers: { 'x-test-user': 'admin' } });
  assert.equal(cmsRetriedPull.statusCode, 200, cmsRetriedPull.body);
  assert.equal(cmsRetriedPull.json().status, 'accepted', cmsRetriedPull.body);
  assert.equal(cmsRetriedPull.json().attemptCount, 2);
  assert.equal(cmsRetriedPull.json().summary.processed + cmsRetriedPull.json().summary.matched + cmsRetriedPull.json().summary.duplicates, 1, `The admin-only retry returns safe processing counts without the lead payload: ${cmsRetriedPull.body}`);
  const exchangeAfterCms = await app.inject({ method: 'GET', url: '/api/admin/exchanges', headers: { 'x-test-user': 'admin' } });
  assert.equal(exchangeAfterCms.statusCode, 200, exchangeAfterCms.body);
  assert.ok(exchangeAfterCms.json().jobs.every((job: Record<string, unknown>) => !('activityId' in job) && !('externalEventId' in job) && !('payload' in job) && !('response' in job) && !('actorSub' in job)));
  assert.equal(JSON.stringify(exchangeAfterCms.json()).includes('Анна Сергеева'), false);
  assert.equal(JSON.stringify(exchangeAfterCms.json()).includes('CMS-REQ-001'), false);
  const managerExchangeAfterCms = await app.inject({ method: 'GET', url: '/api/admin/exchanges', headers: { 'x-test-user': 'admin-manager' } });
  assert.equal(managerExchangeAfterCms.statusCode, 200, managerExchangeAfterCms.body);
  const cmsActivityJob = managerExchangeAfterCms.json().jobs.find((job: { operation: string; externalEventId: string | null }) => job.operation === 'receive_inquiry' && job.externalEventId === 'cms-demo-inquiry-001');
  assert.ok(cmsActivityJob?.activityId);
  assert.ok('payload' in cmsActivityJob, 'Combined manager/admin receives details for a job linked to a team-visible activity.');
  const hiddenImportOnlyActivity = await repo.createActivity(kamA, { kind: 'individual', title: `B09 hidden import-only ${randomUUID()}`, personName: `B09 hidden owner ${randomUUID()}` });
  createdActivityIds.push(String(hiddenImportOnlyActivity.id));
  if (hiddenImportOnlyActivity.personId) personIds.push(String(hiddenImportOnlyActivity.personId));
  await pool.query('UPDATE activities SET import_owner_only=TRUE WHERE id=$1::uuid', [hiddenImportOnlyActivity.id]);
  const hiddenImportOnlyJobId = randomUUID();
  await pool.query(`INSERT INTO exchange_jobs(id,direction,system,operation,activity_id,actor_sub,scope_key,correlation_id,idempotency_key,status,attempt_count,payload,response,last_error)
    VALUES($1,'crm_to_lms','lms','prepare_access',$2::uuid,$3,$2::text,$4,$5,'retryable_error',1,$6::jsonb,$7::jsonb,$8)`, [
    hiddenImportOnlyJobId, hiddenImportOnlyActivity.id, kamA.sub, randomUUID(), `hidden-${randomUUID()}`,
    JSON.stringify({ marker: 'B09_PRIVATE_IMPORT_PAYLOAD' }), JSON.stringify({ marker: 'B09_PRIVATE_IMPORT_RESPONSE' }), 'B09_PRIVATE_IMPORT_ERROR',
  ]);
  const scopedManagerMonitor = await app.inject({ method: 'GET', url: '/api/admin/exchanges', headers: { 'x-test-user': 'admin-manager' } });
  assert.equal(scopedManagerMonitor.statusCode, 200, scopedManagerMonitor.body);
  const privateJob = scopedManagerMonitor.json().jobs.find((job: { id: string }) => job.id === hiddenImportOnlyJobId);
  assert.equal(privateJob.activityLinked, true);
  assert.equal(privateJob.canRetry, false, 'A manager cannot retry an import-owner-only job assigned to another person.');
  assert.ok(!('activityId' in privateJob) && !('actorSub' in privateJob) && !('payload' in privateJob) && !('response' in privateJob) && !('lastError' in privateJob));
  assert.equal(JSON.stringify(privateJob).includes('B09_PRIVATE_IMPORT'), false);
  assert.equal((await app.inject({ method: 'POST', url: `/api/exchanges/${hiddenImportOnlyJobId}/retry`, headers: { 'x-test-user': 'admin-manager' } })).statusCode, 404);
  const adminMonitorPrivateJob = (await app.inject({ method: 'GET', url: '/api/admin/exchanges', headers: { 'x-test-user': 'admin' } })).json().jobs.find((job: { id: string }) => job.id === hiddenImportOnlyJobId);
  assert.equal(adminMonitorPrivateJob.canRetry, false, 'Technical-only admin sees status but has no action for a linked business job.');
  createdActivityIds.push(cmsActivityJob.activityId);
  const cmsActivity = await app.inject({ method: 'GET', url: `/api/activities/${cmsActivityJob.activityId}`, headers: { 'x-test-user': 'admin' } });
  assert.equal(cmsActivity.statusCode, 403, 'The technical admin cannot open a business activity by the opaque ID.');
  const managerCmsActivity = await app.inject({ method: 'GET', url: `/api/activities/${cmsActivityJob.activityId}`, headers: { 'x-test-user': 'admin-manager' } });
  assert.equal(managerCmsActivity.statusCode, 200, managerCmsActivity.body);
  if (managerCmsActivity.json().personId) personIds.push(managerCmsActivity.json().personId);
  assert.equal(managerCmsActivity.json().origin, 'cms_mock');
  assert.equal(managerCmsActivity.json().originSource, 'CMS mock');
  assert.equal(managerCmsActivity.json().originReference, 'CMS-REQ-001');
  assert.equal(managerExchangeAfterCms.json().jobs.find((job: { direction: string; externalEventId: string | null }) => job.direction === 'crm_to_cms' && job.externalEventId === 'cms-demo-inquiry-001').status, 'accepted');
  const cmsRecipientTruth = await (await fetch(`${cmsMock.url}/events/cms-demo-inquiry-001/status`)).json() as { crmStatus: { activityReference: string } };
  assert.equal(cmsRecipientTruth.crmStatus.activityReference, cmsActivityJob.activityId);
  assert.ok(managerExchangeAfterCms.json().jobs.some((job: { direction: string }) => job.direction === 'cms_to_crm'));
  assert.ok(managerExchangeAfterCms.json().jobs.some((job: { direction: string }) => job.direction === 'crm_to_cms'));
  const duplicateCmsPull = await app.inject({ method: 'POST', url: '/api/admin/exchanges/cms/pull', headers: { 'x-test-user': 'admin' } });
  assert.equal(duplicateCmsPull.statusCode, 200, duplicateCmsPull.body);
  assert.equal(duplicateCmsPull.json().summary.processed, 0);
  assert.equal(duplicateCmsPull.json().summary.duplicates, 1);
  const kamIntake = await app.inject({ method: 'GET', url: '/api/cms-mock/intake', headers: { 'x-test-user': 'a' } });
  assert.equal(kamIntake.statusCode, 200, kamIntake.body);
  const expectedIntake = kamIntake.json().find((item: { id: string }) => item.id === cmsActivityJob.activityId);
  assert.ok(expectedIntake, 'The current CMS inquiry remains in the intake even when unrelated persisted fixtures exist.');
  assert.equal(expectedIntake.originReference, 'CMS-REQ-001');
  assert.equal('email' in expectedIntake, false);
  const corporateOnlyKam: Actor = { ...kamA, allowedKinds: ['corporate'] };
  const restrictedIntake = await exchanges.cmsIntake(corporateOnlyKam);
  assert.equal(restrictedIntake.some((item: { id: string }) => item.id === cmsActivityJob.activityId), false,
    'CMS intake excludes inquiries outside the actor\'s allowed activity kinds.');
  await assert.rejects(exchanges.claimCmsIntake(corporateOnlyKam, cmsActivityJob.activityId),
    (error: unknown) => error instanceof DomainError && error.code === 'segment_forbidden',
    'A disallowed CMS inquiry cannot be claimed even when it is otherwise available.');
  const cmsOwnerAfterRejectedClaim = await pool.query('SELECT owner_sub FROM activities WHERE id=$1::uuid', [cmsActivityJob.activityId]);
  assert.equal(cmsOwnerAfterRejectedClaim.rows[0].owner_sub, admin.sub,
    'A rejected segment claim leaves the inbound assignment unchanged.');

  const cmsCorporateEvent = {
    eventId: `cms-org-scope-${randomUUID()}`, correlationId: randomUUID(), eventType: 'inquiry.submitted', occurredAt: new Date().toISOString(),
    lead: { kind: 'corporate' as const, title: 'CMS corporate organization-scope regression', personName: 'CMS corporate scope contact',
      organizationName: `CMS organization scope ${randomUUID()}`, externalReference: `CMS-ORG-SCOPE-${randomUUID()}` },
  };
  const cmsOrganizationScopeExchange = new PostgresExchangeService(repo, {
    cmsUrl: 'http://127.0.0.1:3101', lmsUrl: lmsMock.url,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/events' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ events: [cmsCorporateEvent] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (/^\/events\/[^/]+\/ack$/.test(url.pathname) && init?.method === 'POST') {
        return new Response(JSON.stringify({ status: 'accepted' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const cmsCorporatePull = await cmsOrganizationScopeExchange.pullCms(admin);
  assert.equal(cmsCorporatePull.status, 'accepted');
  assert.equal(cmsCorporatePull.summary?.processed, 1);
  const cmsCorporateRow = (await pool.query(`SELECT a.id,a.owner_sub,a.organization_id,a.person_id
    FROM activities a JOIN exchange_jobs j ON j.activity_id=a.id
    WHERE j.external_event_id=$1 AND j.operation='receive_inquiry'`, [cmsCorporateEvent.eventId])).rows[0];
  assert.ok(cmsCorporateRow, 'The corporate CMS fixture is persisted for the organization-scope regression.');
  createdActivityIds.push(cmsCorporateRow.id);
  orgIds.push(cmsCorporateRow.organization_id);
  personIds.push(cmsCorporateRow.person_id);
  const payerOrganizationId = randomUUID();
  orgIds.push(payerOrganizationId);
  await pool.query("INSERT INTO organizations(id,name,segment) VALUES($1,$2,'company')", [payerOrganizationId, `CMS payer scope ${randomUUID()}`]);
  await pool.query('UPDATE activities SET payer_organization_id=$2::uuid WHERE id=$1::uuid', [cmsCorporateRow.id, payerOrganizationId]);
  const primaryOnlyKam: Actor = { ...kamA, allowedKinds: ['corporate'], allowedOrganizationIds: [cmsCorporateRow.organization_id] };
  const bothOrganizationsKam: Actor = { ...kamA, allowedKinds: ['corporate'], allowedOrganizationIds: [cmsCorporateRow.organization_id, payerOrganizationId] };
  const primaryOnlyIntake = await cmsOrganizationScopeExchange.cmsIntake(primaryOnlyKam);
  assert.equal(primaryOnlyIntake.some((item: { id: string }) => item.id === cmsCorporateRow.id), false,
    'CMS intake requires both the primary and payer organizations to be within scope.');
  const fullyAllowedIntake = await cmsOrganizationScopeExchange.cmsIntake(bothOrganizationsKam);
  assert.equal(fullyAllowedIntake.some((item: { id: string }) => item.id === cmsCorporateRow.id), true,
    'CMS intake includes the corporate inquiry when both linked organizations are allowed.');
  await assert.rejects(cmsOrganizationScopeExchange.claimCmsIntake(primaryOnlyKam, cmsCorporateRow.id),
    (error: unknown) => error instanceof DomainError && error.code === 'cms_inquiry_unavailable',
    'An organization-restricted KAM cannot claim a CMS corporate inquiry outside the atomic organization check.');
  const cmsOwnerAfterOrgRejectedClaim = await pool.query('SELECT owner_sub FROM activities WHERE id=$1::uuid', [cmsCorporateRow.id]);
  assert.equal(cmsOwnerAfterOrgRejectedClaim.rows[0].owner_sub, admin.sub,
    'A rejected organization-scope claim leaves the inbound assignment unchanged.');
  const claimedScopedCmsActivity = await cmsOrganizationScopeExchange.claimCmsIntake(bothOrganizationsKam, cmsCorporateRow.id);
  assert.equal(claimedScopedCmsActivity.ownerSub, kamA.sub,
    'A KAM whose scope includes both organizations can claim the corporate inquiry.');

  assert.equal((await app.inject({ method: 'POST', url: `/api/cms-mock/intake/${cmsActivityJob.activityId}/claim`, headers: { 'x-test-user': 'manager' } })).statusCode, 403);
  const claimedCmsActivity = await app.inject({ method: 'POST', url: `/api/cms-mock/intake/${cmsActivityJob.activityId}/claim`, headers: { 'x-test-user': 'a' } });
  assert.equal(claimedCmsActivity.statusCode, 200, claimedCmsActivity.body);
  assert.equal(claimedCmsActivity.json().ownerSub, kamA.sub);
  assert.equal((await app.inject({ method: 'GET', url: '/api/cms-mock/intake', headers: { 'x-test-user': 'a' } })).json().length, 0);
  assert.equal((await app.inject({ method: 'POST', url: `/api/cms-mock/intake/${cmsActivityJob.activityId}/claim`, headers: { 'x-test-user': 'b' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${cmsActivityJob.activityId}`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${cmsActivityJob.activityId}/exchanges`, headers: { 'x-test-user': 'a' } })).json().some((job: { direction: string; status: string }) => job.direction === 'crm_to_cms' && job.status === 'accepted'), true);

  const cmsMatchingReference = `CMS-MATCH-${randomUUID()}`;
  const cmsMatchingEvents = [
    { eventId: `cms-match-first-${randomUUID()}`, correlationId: randomUUID(), eventType: 'inquiry.submitted', occurredAt: new Date().toISOString(), lead: { kind: 'individual', title: 'CMS matching regression', personName: 'CMS matching person', externalReference: cmsMatchingReference } },
    { eventId: `cms-match-same-${randomUUID()}`, correlationId: randomUUID(), eventType: 'inquiry.submitted', occurredAt: new Date().toISOString(), lead: { kind: 'individual', title: 'CMS matching regression', personName: 'CMS matching person', externalReference: `  ${cmsMatchingReference.toLowerCase()}  ` } },
    { eventId: `cms-match-conflict-${randomUUID()}`, correlationId: randomUUID(), eventType: 'inquiry.submitted', occurredAt: new Date().toISOString(), lead: { kind: 'individual', title: 'Changed title must be reviewed', personName: 'CMS matching person', externalReference: cmsMatchingReference } },
  ];
  const cmsAcks: { eventId: string; activityReference: string }[] = [];
  const matchingExchange = new PostgresExchangeService(repo, {
    cmsUrl: 'http://127.0.0.1:3101', lmsUrl: lmsMock.url,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/events' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ events: cmsMatchingEvents }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const ack = url.pathname.match(/^\/events\/([^/]+)\/ack$/);
      if (ack && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { activityReference: string; status: string };
        assert.equal(body.status, 'received');
        cmsAcks.push({ eventId: decodeURIComponent(ack[1]), activityReference: body.activityReference });
        return new Response(JSON.stringify({ status: 'accepted', eventId: decodeURIComponent(ack[1]), activityReference: body.activityReference }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const matchingPull = await matchingExchange.pullCms(managerAdmin);
  assert.equal(matchingPull.status, 'accepted');
  assert.equal(matchingPull.summary?.processed, 1);
  assert.equal(matchingPull.summary?.matched, 1);
  assert.equal(matchingPull.summary?.conflicts, 1);
  assert.equal(matchingPull.summary?.errors, 0);
  assert.ok(!('response' in matchingPull) && !('payload' in matchingPull), 'Aggregate pull results stay compact even for manager/admin actors.');
  assert.equal(JSON.stringify(matchingPull).includes(cmsMatchingReference), false, 'Aggregate results do not expose references from individual events.');
  assert.equal(cmsAcks.length, 2, 'new, safely matched inquiries each receive a CMS acknowledgement; conflicts do not');
  assert.notEqual(cmsAcks[0].activityReference, undefined);
  assert.equal(cmsAcks[0].activityReference, cmsAcks[1].activityReference);
  const cmsIdentityRows = await pool.query(`SELECT j.external_event_id,j.status,j.activity_id,j.last_error,e.event_id,e.payload
    FROM exchange_jobs j JOIN exchange_events e ON e.job_id=j.id
    WHERE j.direction='cms_to_crm' AND j.operation='receive_inquiry' AND j.external_event_id=ANY($1::text[])
    ORDER BY j.created_at`, [cmsMatchingEvents.map((event) => event.eventId)]);
  assert.equal(cmsIdentityRows.rowCount, 3, 'different source event IDs remain distinct exchange records');
  assert.equal(new Set(cmsIdentityRows.rows.map((row: { activity_id: string }) => row.activity_id)).size, 1, 'matching external references converge on one activity');
  const matchingActivityId = cmsIdentityRows.rows[0].activity_id as string;
  createdActivityIds.push(matchingActivityId);
  const noOrganizationScopeManagerAdmin: Actor = { ...managerAdmin, allowedKinds: ['individual'], allowedOrganizationIds: [] };
  const noOrganizationCmsIntake = await matchingExchange.cmsIntake(noOrganizationScopeManagerAdmin);
  assert.equal(noOrganizationCmsIntake.some((item: { id: string }) => item.id === matchingActivityId), true,
    'An empty organization allowlist still permits a CMS inquiry whose primary and payer links are both null.');
  const matchingActivity = (await pool.query(`SELECT a.id,a.title,a.person_id FROM activities a WHERE a.id=$1`, [matchingActivityId])).rows[0];
  personIds.push(matchingActivity.person_id);
  assert.equal(matchingActivity.title, 'CMS matching regression', 'a conflicting event never overwrites the first lead details');
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM activities WHERE origin='cms_mock' AND lower(btrim(origin_reference))=lower(btrim($1))`, [cmsMatchingReference])).rows[0].count, 1);
  const conflictJob = cmsIdentityRows.rows.find((row: { external_event_id: string }) => row.external_event_id === cmsMatchingEvents[2].eventId);
  assert.equal(conflictJob.status, 'rejected');
  assert.match(conflictJob.last_error, /details differ/);
  assert.deepEqual(cmsIdentityRows.rows.find((row: { external_event_id: string }) => row.external_event_id === cmsMatchingEvents[1].eventId).payload.match, 'normalized_external_reference');
  assert.deepEqual(cmsIdentityRows.rows.find((row: { external_event_id: string }) => row.external_event_id === cmsMatchingEvents[2].eventId).payload.conflict.conflictingFields, ['title']);
  const repeatMatchingPull = await matchingExchange.pullCms(managerAdmin);
  assert.equal(repeatMatchingPull.summary?.duplicates, 2);
  assert.equal(repeatMatchingPull.summary?.conflicts, 1, 'the persisted conflict remains visible as a count on redelivery and is not acknowledged as received');
  assert.equal(cmsAcks.length, 2, 'idempotent event redelivery reuses the persisted acknowledgements');

  const concurrentReference = `CMS-CONCURRENT-${randomUUID()}`;
  const concurrentEvents = [1, 2].map((number) => ({
    eventId: `cms-concurrent-${number}-${randomUUID()}`, correlationId: randomUUID(), eventType: 'inquiry.submitted', occurredAt: new Date().toISOString(),
    lead: { kind: 'individual', title: 'Concurrent CMS match', personName: 'Concurrent CMS person', externalReference: concurrentReference },
  }));
  let concurrentBatchIndex = 0;
  const concurrentExchange = new PostgresExchangeService(repo, {
    cmsUrl: 'http://127.0.0.1:3101', lmsUrl: lmsMock.url,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/events' && (!init?.method || init.method === 'GET')) {
        const event = concurrentEvents[concurrentBatchIndex++];
        return new Response(JSON.stringify({ events: [event] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const ack = url.pathname.match(/^\/events\/([^/]+)\/ack$/);
      if (ack && init?.method === 'POST') return new Response(JSON.stringify({ status: 'accepted', eventId: decodeURIComponent(ack[1]) }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const concurrentPulls = await Promise.all([concurrentExchange.pullCms(admin), concurrentExchange.pullCms(admin)]);
  assert.equal(concurrentPulls.reduce((total, pull) => total + Number(pull.summary?.processed ?? 0) + Number(pull.summary?.matched ?? 0), 0), 2);
  assert.equal(concurrentPulls.reduce((total, pull) => total + Number(pull.summary?.processed ?? 0), 0), 1, 'the normalized-reference lock permits only one activity creation');
  const concurrentRows = await pool.query(`SELECT j.external_event_id,j.activity_id,j.status FROM exchange_jobs j
    JOIN exchange_events e ON e.job_id=j.id WHERE j.direction='cms_to_crm' AND j.operation='receive_inquiry'
      AND j.external_event_id=ANY($1::text[])`, [concurrentEvents.map((event) => event.eventId)]);
  assert.equal(concurrentRows.rowCount, 2);
  assert.equal(new Set(concurrentRows.rows.map((row: { activity_id: string }) => row.activity_id)).size, 1);
  assert.ok(concurrentRows.rows.every((row: { status: string }) => row.status === 'performed'));
  const concurrentActivity = (await pool.query(`SELECT a.id,a.person_id FROM activities a WHERE a.origin='cms_mock' AND lower(btrim(a.origin_reference))=lower(btrim($1))`, [concurrentReference])).rows[0];
  createdActivityIds.push(concurrentActivity.id);
  personIds.push(concurrentActivity.person_id);

  const exchangeOrder = await createAuditedExternalActivityFixture(kamA, {
    title: 'B09 демонстрационный заказ', personName: `B09 слушатель-${randomUUID()}`,
    source: 'B09 synthetic input', reference: `B09-${randomUUID()}`,
  });
  const exchangeOrderId = exchangeOrder.id;
  createdActivityIds.push(exchangeOrderId);
  personIds.push(exchangeOrder.personId);
  const exchangeOrderDetail = await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}`, headers: { 'x-test-user': 'a' } });
  assert.equal(exchangeOrderDetail.json().stageKey, 'lms_handoff');
  const secondExchangeOrder = await createAuditedExternalActivityFixture(kamA, {
    title: 'B09 второй синтетический заказ', personName: `B09 слушатель-${randomUUID()}`,
    source: 'B09 synthetic input', reference: `B09-${randomUUID()}`,
  });
  const secondExchangeOrderId = secondExchangeOrder.id;
  createdActivityIds.push(secondExchangeOrderId);
  personIds.push(secondExchangeOrder.personId);
  const secondOrderDetail = await app.inject({ method: 'GET', url: `/api/activities/${secondExchangeOrderId}`, headers: { 'x-test-user': 'a' } });
  const restrictedLmsJobId = randomUUID();
  await pool.query(`INSERT INTO exchange_jobs(id,direction,system,operation,activity_id,actor_sub,scope_key,correlation_id,idempotency_key,status,attempt_count,payload)
    VALUES($1,'crm_to_lms','lms','prepare_access',$2::uuid,$3,$2::text,$4,$5,'queued',0,'{}'::jsonb)`, [
    restrictedLmsJobId, exchangeOrderId, kamA.sub, randomUUID(), `restricted-${randomUUID()}`,
  ]);
  await assert.rejects((exchanges as any).claimLmsRequest(corporateOnlyKam, { id: restrictedLmsJobId, activityId: exchangeOrderId }),
    (error: unknown) => error instanceof DomainError && error.code === 'segment_forbidden',
    'The locked LMS request claim rechecks allowed activity kinds before changing job state.');
  const restrictedLmsJob = await pool.query('SELECT status,attempt_count FROM exchange_jobs WHERE id=$1::uuid', [restrictedLmsJobId]);
  assert.deepEqual(restrictedLmsJob.rows[0], { status: 'queued', attempt_count: 0 },
    'A disallowed LMS request remains unclaimed after the atomic segment check.');
  await pool.query('UPDATE activities SET payer_organization_id=$2::uuid WHERE id=$1::uuid', [exchangeOrderId, payerOrganizationId]);
  const organizationRestrictedLmsKam: Actor = {
    ...kamA, allowedKinds: ['individual'], allowedOrganizationIds: [cmsCorporateRow.organization_id],
  };
  const orgRestrictedLmsJobId = randomUUID();
  await pool.query(`INSERT INTO exchange_jobs(id,direction,system,operation,activity_id,actor_sub,scope_key,correlation_id,idempotency_key,status,attempt_count,payload)
    VALUES($1,'crm_to_lms','lms','prepare_access',$2::uuid,$3,$2::text,$4,$5,'queued',0,'{}'::jsonb)`, [
    orgRestrictedLmsJobId, exchangeOrderId, kamA.sub, randomUUID(), `org-restricted-${randomUUID()}`,
  ]);
  await assert.rejects(exchanges.requestLms(organizationRestrictedLmsKam, exchangeOrderId, `org-request-${randomUUID()}`),
    (error: unknown) => error instanceof DomainError && error.code === 'activity_not_found',
    'The LMS request route applies organization scope through repository activity access.');
  await assert.rejects((exchanges as any).claimLmsRequest(organizationRestrictedLmsKam, { id: orgRestrictedLmsJobId, activityId: exchangeOrderId }),
    (error: unknown) => error instanceof DomainError && error.code === 'exchange_job_not_found',
    'The locked LMS request claim rechecks both organization links before changing job state.');
  await assert.rejects(exchanges.retry(organizationRestrictedLmsKam, orgRestrictedLmsJobId),
    (error: unknown) => error instanceof DomainError && error.code === 'exchange_job_not_found',
    'A retry is denied when the linked activity has a payer organization outside scope.');
  const orgRestrictedLmsJob = await pool.query('SELECT status,attempt_count FROM exchange_jobs WHERE id=$1::uuid', [orgRestrictedLmsJobId]);
  assert.deepEqual(orgRestrictedLmsJob.rows[0], { status: 'queued', attempt_count: 0 },
    'A request and retry denied by organization scope leave the LMS job unclaimed.');
  const scopedMonitorActor: Actor = { ...managerAdmin, allowedKinds: ['individual'], allowedOrganizationIds: [cmsCorporateRow.organization_id] };
  const scopedMonitor = await exchanges.monitor(scopedMonitorActor);
  const redactedOrganizationJob = scopedMonitor.jobs.find((job: { id: string }) => job.id === orgRestrictedLmsJobId);
  assert.equal(redactedOrganizationJob.activityLinked, true);
  assert.equal(redactedOrganizationJob.canRetry, false,
    'An admin/manager monitor cannot retry a business job whose payer organization is outside its scope.');
  assert.ok(!('activityId' in redactedOrganizationJob) && !('payload' in redactedOrganizationJob) && !('response' in redactedOrganizationJob),
    'The monitor redacts organization-restricted activity details.');
  const sharedIdempotencyKey = `b09-shared-${randomUUID()}`;
  const parallelRequests = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/api/activities/${exchangeOrderId}/exchanges/lms-requests`, headers: { 'x-test-user': 'a' }, payload: { idempotencyKey: sharedIdempotencyKey } })));
  assert.equal(parallelRequests[0].statusCode, 201, parallelRequests[0].body);
  assert.equal(parallelRequests[1].statusCode, 201, parallelRequests[1].body);
  assert.equal(parallelRequests[0].json().id, parallelRequests[1].json().id);
  const parallelJob = (await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/exchanges`, headers: { 'x-test-user': 'a' } })).json().find((job: { idempotencyKey: string }) => job.idempotencyKey === sharedIdempotencyKey);
  assert.equal(parallelJob.status, 'accepted');
  assert.equal(parallelJob.attemptCount, 1);
  await pool.query("UPDATE exchange_jobs SET status='sent',updated_at=now()-interval '1 minute' WHERE id=$1", [parallelJob.id]);
  await app.inject({ method: 'GET', url: '/api/admin/exchanges', headers: { 'x-test-user': 'admin' } });
  const staleJob = (await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/exchanges`, headers: { 'x-test-user': 'a' } })).json().find((job: { id: string }) => job.id === parallelJob.id);
  assert.equal(staleJob.status, 'retryable_error');
  const recoveredJob = await app.inject({ method: 'POST', url: `/api/exchanges/${parallelJob.id}/retry`, headers: { 'x-test-user': 'a' } });
  assert.equal(recoveredJob.json().status, 'accepted');
  assert.equal(recoveredJob.json().attemptCount, 2);
  const sameKeyOtherActivity = await app.inject({ method: 'POST', url: `/api/activities/${secondExchangeOrderId}/exchanges/lms-requests`, headers: { 'x-test-user': 'a' }, payload: { idempotencyKey: sharedIdempotencyKey } });
  assert.equal(sameKeyOtherActivity.statusCode, 201, sameKeyOtherActivity.body);
  assert.notEqual(sameKeyOtherActivity.json().id, parallelJob.id);
  assert.equal(sameKeyOtherActivity.json().activityId, secondExchangeOrderId);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${secondExchangeOrderId}/exchanges`, headers: { 'x-test-user': 'a' } })).json().length, 1);
  const lmsFailureConfigured = await app.inject({ method: 'POST', url: '/api/admin/exchanges/mocks/lms/fail-next', headers: { 'x-test-user': 'admin' }, payload: { mode: 'http_error' } });
  assert.equal(lmsFailureConfigured.statusCode, 200, lmsFailureConfigured.body);
  const lmsFailedRequest = await app.inject({ method: 'POST', url: `/api/activities/${exchangeOrderId}/exchanges/lms-requests`, headers: { 'x-test-user': 'a' }, payload: { idempotencyKey: `b09-${randomUUID()}` } });
  assert.equal(lmsFailedRequest.statusCode, 201, lmsFailedRequest.body);
  assert.equal(lmsFailedRequest.json().status, 'retryable_error');
  assert.equal(lmsFailedRequest.json().attemptCount, 1);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/exchanges`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/exchanges/${lmsFailedRequest.json().id}/retry`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  const adminRetryableLmsJob = (await app.inject({ method: 'GET', url: '/api/admin/exchanges', headers: { 'x-test-user': 'admin' } })).json().jobs.find((job: { id: string }) => job.id === lmsFailedRequest.json().id);
  assert.equal(adminRetryableLmsJob.canRetry, false, 'A technical administrator cannot retry a business-linked LMS request without activity scope.');
  assert.equal((await app.inject({ method: 'POST', url: `/api/exchanges/${lmsFailedRequest.json().id}/retry`, headers: { 'x-test-user': 'admin' } })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/learning-facts`, headers: { 'x-test-user': 'a' } })).json(), []);
  const lmsRetriedRequest = await app.inject({ method: 'POST', url: `/api/exchanges/${lmsFailedRequest.json().id}/retry`, headers: { 'x-test-user': 'a' } });
  assert.equal(lmsRetriedRequest.statusCode, 200, lmsRetriedRequest.body);
  assert.equal(lmsRetriedRequest.json().status, 'accepted');
  assert.equal(lmsRetriedRequest.json().attemptCount, 2);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/learning-facts`, headers: { 'x-test-user': 'a' } })).json(), []);
  const lmsOutcome = await app.inject({ method: 'POST', url: `/api/admin/exchanges/lms/${lmsRetriedRequest.json().id}/outcome`, headers: { 'x-test-user': 'admin' }, payload: { outcome: 'perform', factKind: 'learning_completed' } });
  assert.equal(lmsOutcome.statusCode, 200, lmsOutcome.body);
  assert.equal(lmsOutcome.json().mode, 'mock');
  const lmsPulled = await app.inject({ method: 'POST', url: '/api/admin/exchanges/lms/pull', headers: { 'x-test-user': 'admin' } });
  assert.equal(lmsPulled.statusCode, 200, lmsPulled.body);
  assert.equal(lmsPulled.json().summary.processed, 1);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/exchanges`, headers: { 'x-test-user': 'a' } })).json().find((job: { direction: string }) => job.direction === 'crm_to_lms').status, 'performed');
  const projectedFacts = await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/learning-facts`, headers: { 'x-test-user': 'a' } });
  assert.equal(projectedFacts.statusCode, 200, projectedFacts.body);
  assert.equal(projectedFacts.json().length, 1);
  assert.equal(projectedFacts.json()[0].factKind, 'learning_completed');
  assert.equal(projectedFacts.json()[0].source, 'LMS mock');
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/learning-facts`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  const secondFact = await app.inject({ method: 'POST', url: `/api/admin/exchanges/lms/${lmsRetriedRequest.json().id}/outcome`, headers: { 'x-test-user': 'admin' }, payload: { outcome: 'perform', factKind: 'learning_started' } });
  assert.equal(secondFact.statusCode, 200, secondFact.body);
  const secondFactPull = await app.inject({ method: 'POST', url: '/api/admin/exchanges/lms/pull', headers: { 'x-test-user': 'admin' } });
  assert.equal(secondFactPull.statusCode, 200, secondFactPull.body);
  assert.equal(secondFactPull.json().summary.processed, 1);
  const projectedTwoFacts = await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/learning-facts`, headers: { 'x-test-user': 'a' } });
  assert.equal(projectedTwoFacts.json().length, 2);
  const duplicateLmsPull = await app.inject({ method: 'POST', url: '/api/admin/exchanges/lms/pull', headers: { 'x-test-user': 'admin' } });
  assert.equal(duplicateLmsPull.statusCode, 200, duplicateLmsPull.body);
  assert.equal(duplicateLmsPull.json().summary.processed, 0);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/learning-facts`, headers: { 'x-test-user': 'a' } })).json(), projectedTwoFacts.json());
  const replayLinks = await pool.query(`SELECT count(*)::integer AS facts,count(exchange_event_id)::integer AS linked,
      count(DISTINCT exchange_event_id)::integer AS distinct_events
    FROM individual_learning_facts WHERE activity_id=$1::uuid`, [exchangeOrderId]);
  assert.deepEqual(replayLinks.rows[0], { facts: 2, linked: 2, distinct_events: 2 },
    'Accepted LMS events link one-to-one to projected facts and replay adds no duplicate link.');

  // Simulate an LMS that persisted the request but whose accepted response was lost in transit.
  let loseNextLmsAcknowledgement = true;
  const lostAckExchanges = new PostgresExchangeService(repo, {
    cmsUrl: cmsMock.url,
    lmsUrl: lmsMock.url,
    fetcher: async (input, init) => {
      const response = await fetch(input, init);
      if (loseNextLmsAcknowledgement && new URL(String(input)).pathname === '/requests' && init?.method === 'POST') {
        loseNextLmsAcknowledgement = false;
        throw new Error('Simulated lost LMS acknowledgement after the request was persisted.');
      }
      return response;
    },
  });
  const lostAckRequest = await lostAckExchanges.requestLms(kamA, exchangeOrderId, `b09-lost-ack-${randomUUID()}`);
  assert.equal(lostAckRequest.status, 'retryable_error');
  assert.equal(loseNextLmsAcknowledgement, false);
  const remotePerformance = await fetch(`${lmsMock.url}/control/requests/${encodeURIComponent(lostAckRequest.correlationId)}/perform`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ factKind: 'enrollment' }),
  });
  assert.equal(remotePerformance.status, 200);
  const remoteFact = await remotePerformance.json() as { eventId: string };
  const beforeRetryPull = await lostAckExchanges.pullLms(admin);
  assert.equal(beforeRetryPull.summary?.deferred, 1, 'A fact for an outbound request with an unknown acknowledgement remains retryable.');
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM exchange_events WHERE source_system='lms' AND event_id=$1`, [remoteFact.eventId])).rows[0].count, 0,
    'Deferred facts are not written to the durable deduplication ledger.');
  const resolvedLostAck = await lostAckExchanges.retry(kamA, lostAckRequest.id);
  assert.equal(resolvedLostAck.status, 'accepted', 'Retry with the same idempotency key resolves the lost acknowledgement.');
  const afterRetryPull = await lostAckExchanges.pullLms(admin);
  assert.equal(afterRetryPull.summary?.processed, 1, 'The next pull applies the previously deferred fact.');
  const factsAfterLostAckRecovery = await app.inject({ method: 'GET', url: `/api/activities/${exchangeOrderId}/learning-facts`, headers: { 'x-test-user': 'a' } });
  assert.equal(factsAfterLostAckRecovery.statusCode, 200, factsAfterLostAckRecovery.body);
  assert.equal(factsAfterLostAckRecovery.json().length, projectedTwoFacts.json().length + 1);
  assert.equal(factsAfterLostAckRecovery.json().at(-1).factKind, 'enrollment');

  const rejectedOrder = await createAuditedExternalActivityFixture(kamA, {
    title: 'B09 отклоняемый синтетический заказ', personName: `B09 слушатель-${randomUUID()}`,
    source: 'B09 synthetic input', reference: `B09-${randomUUID()}`,
  });
  const rejectedOrderId = rejectedOrder.id;
  createdActivityIds.push(rejectedOrderId);
  personIds.push(rejectedOrder.personId);
  const rejectedOrderDetail = await app.inject({ method: 'GET', url: `/api/activities/${rejectedOrderId}`, headers: { 'x-test-user': 'a' } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/exchanges/mocks/lms/fail-next', headers: { 'x-test-user': 'admin' }, payload: { mode: 'reject_next' } })).statusCode, 200);
  const rejectedLmsRequest = await app.inject({ method: 'POST', url: `/api/activities/${rejectedOrderId}/exchanges/lms-requests`, headers: { 'x-test-user': 'a' }, payload: { idempotencyKey: `b09-reject-${randomUUID()}` } });
  assert.equal(rejectedLmsRequest.statusCode, 201, rejectedLmsRequest.body);
  assert.equal(rejectedLmsRequest.json().status, 'rejected');
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/activities/${rejectedOrderId}/learning-facts`, headers: { 'x-test-user': 'a' } })).json(), []);

  const corporate = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'corporate', title: 'Оценить адаптацию корпоративной программы', organizationName: companyName,
  } });
  assert.equal(corporate.statusCode, 201, corporate.body);
  createdActivityIds.push(corporate.json().id);
  const corporateDetail = await app.inject({ method: 'GET', url: `/api/activities/${corporate.json().id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(corporateDetail.json().organizationSegment, 'company');
  orgIds.push(corporateDetail.json().organizationId);
  const corporatePlanPath = `/api/activities/${corporate.json().id}/corporate-plan`;
  const corporatePlanBefore = await app.inject({ method: 'GET', url: corporatePlanPath, headers: { 'x-test-user': 'a' } });
  assert.equal(corporatePlanBefore.statusCode, 200, corporatePlanBefore.body);
  assert.equal(corporatePlanBefore.json().programMode, 'undecided');
  assert.equal(corporatePlanBefore.json().revision, 0);
  assert.equal(corporatePlanBefore.json().requestedPlaces, null);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${corporate.json().id}/learning-facts`, headers: { 'x-test-user': 'a' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: corporatePlanPath, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  const corporatePlanInput = {
    expectedRevision: 0, programMode: 'new', requestedPlaces: 30,
    brief: { expectedOutcome: 'Обучить работе с процессом', audience: 'Команда заказчика', entryLevel: null, deliveryFormat: 'Очный пилот', volume: '16 часов', technologyContext: null },
    methodologist: { name: 'Методолог интеграционного теста', feasibility: 'feasible', note: null },
    proposed: { scope: 'Создать программу и провести пилот', startDate: '2026-10-01', endDate: '2026-11-01', acceptanceCriteria: 'Пилотная группа прошла занятия' },
    agreed: { scope: null, startDate: null, endDate: null, acceptanceCriteria: null },
    approval: { status: 'pending', evidenceReference: 'REQ-42', evidenceSource: 'Запись встречи', note: null },
  };
  const corporateStageBeforePlan = corporateDetail.json().stageKey;
  const corporatePlanSaved = await app.inject({ method: 'PUT', url: corporatePlanPath, headers: { 'x-test-user': 'a' }, payload: corporatePlanInput });
  assert.equal(corporatePlanSaved.statusCode, 200, corporatePlanSaved.body);
  assert.equal(corporatePlanSaved.json().revision, 1);
  assert.equal(corporatePlanSaved.json().programMode, 'new');
  assert.equal(corporatePlanSaved.json().requestedPlaces, 30);
  assert.equal(corporatePlanSaved.json().methodologist.feasibility, 'feasible');
  const standardPlanInput = { ...corporatePlanInput, expectedRevision: 1, programMode: 'standard' };
  const standardPlanSaved = await app.inject({ method: 'PUT', url: corporatePlanPath, headers: { 'x-test-user': 'a' }, payload: standardPlanInput });
  assert.equal(standardPlanSaved.statusCode, 200, standardPlanSaved.body);
  assert.equal(standardPlanSaved.json().revision, 2);
  assert.equal(standardPlanSaved.json().programMode, 'standard');
  assert.equal(standardPlanSaved.json().brief.expectedOutcome, corporatePlanInput.brief.expectedOutcome);
  assert.equal(standardPlanSaved.json().proposed.scope, corporatePlanInput.proposed.scope);
  assert.equal(standardPlanSaved.json().approval.evidenceReference, corporatePlanInput.approval.evidenceReference);
  assert.equal((await app.inject({ method: 'PUT', url: corporatePlanPath, headers: { 'x-test-user': 'a' }, payload: corporatePlanInput })).statusCode, 409);
  const corporateAfterPlan = await app.inject({ method: 'GET', url: `/api/activities/${corporate.json().id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(corporateAfterPlan.json().stageKey, corporateStageBeforePlan);
  assert.equal(corporateAfterPlan.json().routeVersion, 'legacy');
  const corporateHistory = await app.inject({ method: 'GET', url: `/api/activities/${corporate.json().id}/history`, headers: { 'x-test-user': 'a' } });
  const corporatePlanEvent = corporateHistory.json().find((event: { eventType: string; details: { revision: number } }) => event.eventType === 'corporate_plan_updated' && event.details.revision === 2);
  assert.equal(corporatePlanEvent.details.previousRevision, 1);
  assert.equal(corporatePlanEvent.details.current.programMode, 'standard');
  assert.equal(corporatePlanEvent.details.current.requestedPlaces, 30);
  assert.equal(corporatePlanEvent.details.current.brief.expectedOutcome, corporatePlanInput.brief.expectedOutcome);
  const closedActionTask = await app.inject({ method: 'POST', url: `/api/activities/${corporate.json().id}/tasks`, headers: { 'x-test-user': 'a' }, payload: { title: 'Открытое действие перед закрытием', dueAt: new Date(Date.now() + 86_400_000).toISOString() } });
  assert.equal(closedActionTask.statusCode, 201, closedActionTask.body);
  await pool.query('UPDATE activities SET closed=true WHERE id=$1::uuid', [corporate.json().id]);
  const closedActivityDetail = await app.inject({ method: 'GET', url: `/api/activities/${corporate.json().id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(closedActivityDetail.statusCode, 200, 'the owner retains read access after closure');
  assert.equal(closedActivityDetail.json().closed, true);
  assert.equal(closedActivityDetail.json().tasks.some((savedTask: { id: string }) => savedTask.id === closedActionTask.json().id), true, 'closed activities keep their task list readable');
  assert.equal((await app.inject({ method: 'GET', url: corporatePlanPath, headers: { 'x-test-user': 'a' } })).json().readOnly, true);
  const closedPlanWrite = await app.inject({ method: 'PUT', url: corporatePlanPath, headers: { 'x-test-user': 'a' }, payload: { ...standardPlanInput, expectedRevision: 2 } });
  assert.equal(closedPlanWrite.statusCode, 409);
  assert.equal(closedPlanWrite.json().code, 'activity_closed');
  const beforeClosedActions = await pool.query(`SELECT (SELECT count(*)::int FROM tasks WHERE activity_id=$1::uuid) AS task_count,
    (SELECT count(*)::int FROM activity_events WHERE activity_id=$1::uuid) AS event_count`, [corporate.json().id]);
  const closedTaskCreate = await app.inject({ method: 'POST', url: `/api/activities/${corporate.json().id}/tasks`, headers: { 'x-test-user': 'a' }, payload: { title: 'Не должно добавиться', dueAt: new Date(Date.now() + 172_800_000).toISOString() } });
  assert.equal(closedTaskCreate.statusCode, 409);
  assert.equal(closedTaskCreate.json().code, 'activity_closed');
  const closedTaskComplete = await app.inject({ method: 'POST', url: `/api/activities/${corporate.json().id}/tasks/${closedActionTask.json().id}/complete`, headers: { 'x-test-user': 'a' } });
  assert.equal(closedTaskComplete.statusCode, 409);
  assert.equal(closedTaskComplete.json().code, 'activity_closed');
  const closedOutcome = await app.inject({ method: 'POST', url: `/api/activities/${corporate.json().id}/outcomes`, headers: { 'x-test-user': 'a' }, payload: { outcome: 'connected', note: 'Не должно сохраниться.' } });
  assert.equal(closedOutcome.statusCode, 409);
  assert.equal(closedOutcome.json().code, 'activity_closed');
  const afterClosedActions = await pool.query(`SELECT (SELECT count(*)::int FROM tasks WHERE activity_id=$1::uuid) AS task_count,
    (SELECT count(*)::int FROM activity_events WHERE activity_id=$1::uuid) AS event_count`, [corporate.json().id]);
  assert.deepEqual(afterClosedActions.rows[0], beforeClosedActions.rows[0], 'rejected writes leave tasks and activity history unchanged');
  const stillOpenTask = await pool.query('SELECT status FROM tasks WHERE id=$1::uuid', [closedActionTask.json().id]);
  assert.equal(stillOpenTask.rows[0].status, 'open', 'completing a task after closure has no effect');

  const dueAt = new Date(Date.now() + 86_400_000).toISOString();
  const taskResponse = await app.inject({ method: 'POST', url: `/api/activities/${first.id}/tasks`, headers: { 'x-test-user': 'a' }, payload: { title: 'Позвонить координатору', dueAt } });
  assert.equal(taskResponse.statusCode, 201, taskResponse.body);
  const task = taskResponse.json();
  const outcomeResponse = await app.inject({ method: 'POST', url: `/api/activities/${first.id}/outcomes`, headers: { 'x-test-user': 'a' }, payload: { outcome: 'awaiting_reply', note: 'Ждём подтверждения.' } });
  assert.equal(outcomeResponse.statusCode, 201);
  const firstRouteState = (await app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'a' } })).json();
  const disallowed = await app.inject({ method: 'POST', url: `/api/activities/${first.id}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage: 'closed', expectedStageKey: firstRouteState.stageKey, expectedWorkflowRevision: firstRouteState.workflowRevision } });
  assert.equal(disallowed.statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'a' } })).json().stageKey, 'contact');
  assert.equal((await app.inject({ method: 'POST', url: `/api/activities/${first.id}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage: 'meeting', expectedStageKey: firstRouteState.stageKey, expectedWorkflowRevision: firstRouteState.workflowRevision } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/activities/${first.id}/tasks/${task.id}/complete`, headers: { 'x-test-user': 'a' } })).statusCode, 200);

  const initialSteps = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/university-steps`, headers: { 'x-test-user': 'a' } });
  assert.equal(initialSteps.statusCode, 200, initialSteps.body);
  assert.equal(initialSteps.json().steps.length, 13);
  assert.equal(initialSteps.json().overview.openTaskCount, 0);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${first.id}/university-steps`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  const firstStepSave = await app.inject({ method: 'PUT', url: `/api/activities/${first.id}/university-steps/U01`, headers: { 'x-test-user': 'a' }, payload: { status: 'documented', note: 'Контакт подтверждён', expectedRevision: 0 } });
  assert.equal(firstStepSave.statusCode, 200, firstStepSave.body);
  for (const status of ['in_progress', 'waiting', 'documented']) {
    const bypass = await app.inject({ method: 'PUT', url: `/api/activities/${first.id}/university-steps/U05`, headers: { 'x-test-user': 'a' }, payload: { status, note: 'Generic path bypass', expectedRevision: 0 } });
    assert.equal(bypass.statusCode, 400, `generic endpoint must reject U05 ${status}`);
  }
  const staleStepSave = await app.inject({ method: 'PUT', url: `/api/activities/${first.id}/university-steps/U01`, headers: { 'x-test-user': 'a' }, payload: { status: 'waiting', note: 'Старая версия', expectedRevision: 0 } });
  assert.equal(staleStepSave.statusCode, 409);
  const stepScope = await app.inject({ method: 'PUT', url: `/api/activities/${first.id}/university-steps/U02`, headers: { 'x-test-user': 'b' }, payload: { status: 'waiting', note: '', expectedRevision: 0 } });
  assert.equal(stepScope.statusCode, 404);
  const missingTrainingEvidence = await app.inject({ method: 'PUT', url: `/api/activities/${first.id}/university-steps/U09`, headers: { 'x-test-user': 'a' }, payload: { status: 'documented', note: 'Прошли обучение', expectedRevision: 0 } });
  assert.equal(missingTrainingEvidence.statusCode, 400);
  const missingPackageSource = await app.inject({ method: 'PUT', url: `/api/activities/${first.id}/university-steps/U04`, headers: { 'x-test-user': 'a' }, payload: { status: 'documented', note: 'Пакет передан', evidenceReference: 'DOC-PKG-1', expectedRevision: 0 } });
  assert.equal(missingPackageSource.statusCode, 400);
  const packageSave = await app.inject({ method: 'PUT', url: `/api/activities/${first.id}/university-steps/U04`, headers: { 'x-test-user': 'a' }, payload: { status: 'documented', note: 'Пакет передан', evidenceReference: 'DOC-PKG-1', evidenceSource: 'Реестр передачи', expectedRevision: 0 } });
  assert.equal(packageSave.statusCode, 200, packageSave.body);
  const optionalCorrection = await app.inject({ method: 'PUT', url: `/api/activities/${first.id}/university-steps/U05`, headers: { 'x-test-user': 'a' }, payload: { status: 'not_applicable', note: '', expectedRevision: 0 } });
  assert.equal(optionalCorrection.statusCode, 200, optionalCorrection.body);
  const beforeStaleReturnHistory = (await app.inject({ method: 'GET', url: `/api/activities/${first.id}/history`, headers: { 'x-test-user': 'a' } })).json();
  const stalePairReturn = await app.inject({ method: 'POST', url: `/api/activities/${first.id}/university-steps/correction-return`, headers: { 'x-test-user': 'a' }, payload: { expectedU04Revision: 1, expectedU05Revision: 9, note: 'Уточнить приложение' } });
  assert.equal(stalePairReturn.statusCode, 409);
  const afterStalePair = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/university-steps`, headers: { 'x-test-user': 'a' } });
  assert.equal(afterStalePair.json().steps.find((step: { stepId: string }) => step.stepId === 'U04').status, 'documented');
  assert.equal(afterStalePair.json().steps.find((step: { stepId: string }) => step.stepId === 'U05').status, 'not_applicable');
  const afterStaleHistory = (await app.inject({ method: 'GET', url: `/api/activities/${first.id}/history`, headers: { 'x-test-user': 'a' } })).json();
  assert.equal(afterStaleHistory.length, beforeStaleReturnHistory.length);
  const correction = await app.inject({ method: 'POST', url: `/api/activities/${first.id}/university-steps/correction-return`, headers: { 'x-test-user': 'a' }, payload: { expectedU04Revision: 1, expectedU05Revision: 1, note: 'Уточнить приложение к пакету', evidenceReference: 'DOC-REF-7', evidenceSource: 'Ответ координатора' } });
  assert.equal(correction.statusCode, 200, correction.body);
  assert.equal(correction.json().u04.status, 'in_progress');
  assert.equal(correction.json().u05.status, 'documented');
  const correctedSteps = (await app.inject({ method: 'GET', url: `/api/activities/${first.id}/university-steps`, headers: { 'x-test-user': 'a' } })).json().steps;
  const correctedU04 = correctedSteps.find((step: { stepId: string }) => step.stepId === 'U04');
  assert.equal(correctedU04.evidenceReference, 'DOC-PKG-1');
  assert.equal(correctedU04.evidenceSource, 'Реестр передачи');
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'a' } })).json().stageKey, 'meeting');
  const stepHistory = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/history`, headers: { 'x-test-user': 'a' } });
  assert.ok(stepHistory.json().some((event: { eventType: string }) => event.eventType === 'university_step_updated'));
  assert.ok(stepHistory.json().some((event: { eventType: string }) => event.eventType === 'university_correction_return'));
  const correctionEvent = stepHistory.json().find((event: { eventType: string }) => event.eventType === 'university_correction_return');
  assert.equal(correctionEvent.details.previousU05Status, 'not_applicable');
  assert.equal(correctionEvent.details.previousU04EvidenceReference, 'DOC-PKG-1');

  await app.close();
  app = buildApp({ repository: repo, imports, exchanges, authenticate });
  await app.ready();
  const persisted = await app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(persisted.statusCode, 200);
  assert.equal(persisted.json().stageKey, 'meeting');
  assert.equal(persisted.json().productNames.length, 2);
  assert.equal(persisted.json().tasks.find((entry: { id: string }) => entry.id === task.id).status, 'done');
  const persistedSteps = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/university-steps`, headers: { 'x-test-user': 'a' } });
  assert.equal(persistedSteps.statusCode, 200, persistedSteps.body);
  assert.equal(persistedSteps.json().steps.find((step: { stepId: string }) => step.stepId === 'U01').revision, 1);
  assert.equal(persistedSteps.json().steps.find((step: { stepId: string }) => step.stepId === 'U04').status, 'in_progress');
  assert.equal(persistedSteps.json().steps.find((step: { stepId: string }) => step.stepId === 'U05').evidenceReference, 'DOC-REF-7');
  assert.equal(persistedSteps.json().steps.find((step: { stepId: string }) => step.stepId === 'U04').note, 'Пакет передан');
  assert.equal(persistedSteps.json().steps.find((step: { stepId: string }) => step.stepId === 'U04').evidenceReference, 'DOC-PKG-1');
  const events = await app.inject({ method: 'GET', url: `/api/activities/${first.id}/history`, headers: { 'x-test-user': 'a' } });
  assert.deepEqual(new Set(events.json().map((event: { eventType: string }) => event.eventType)), new Set(['created', 'task_created', 'outcome_recorded', 'stage_changed', 'task_completed', 'university_step_updated', 'university_correction_return', 'document_uploaded', 'document_downloaded']));
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${first.id}`, headers: { 'x-test-user': 'manager' } })).statusCode, 200);
  const ownQueue = await app.inject({ method: 'GET', url: '/api/activities?segment=all&collection=all', headers: { 'x-test-user': 'b' } });
  assert.equal(ownQueue.statusCode, 200);
  assert.equal(ownQueue.json().items.some((entry: { id: string }) => createdActivityIds.includes(entry.id)), false);

  const beforeOverview = (await app.inject({ method: 'GET', url: '/api/manager/overview', headers: { 'x-test-user': 'manager' } })).json();
  const fixtureOwnerSub = `b03-overview-${randomUUID()}`;
  const fixtureOwnerName = 'B03 срез интеграции';
  const activitySearchTerm = `b03-activity-${randomUUID()}`;
  const organizationSearchTerm = `b03-organization-${randomUUID()}`;
  const contactSearchTerm = `b03-contact-${randomUUID()}`;
  const universityId = randomUUID();
  const corporateId = randomUUID();
  const individualId = randomUUID();
  orgIds.push(universityId, corporateId);
  personIds.push(individualId);
  await pool.query(`INSERT INTO organizations (id, name, segment)
    VALUES ($1::uuid, $3, 'university'), ($2::uuid, $4, 'company')`, [universityId, corporateId, `${organizationSearchTerm} university`, `${organizationSearchTerm} company`]);
  await pool.query('INSERT INTO people (id, full_name) VALUES ($1::uuid, $2)', [individualId, `${contactSearchTerm} person`]);
  const fixtures = [
    { id: randomUUID(), kind: 'university', organizationId: universityId, personId: null, stage: 'contact', closed: false, awaiting: false },
    { id: randomUUID(), kind: 'corporate', organizationId: corporateId, personId: null, stage: 'qualification', closed: false, awaiting: true },
    { id: randomUUID(), kind: 'individual', organizationId: null, personId: individualId, stage: 'request', routeVersion: 'v2', closed: false, awaiting: false },
    { id: randomUUID(), kind: 'university', organizationId: universityId, personId: null, stage: 'contact', closed: true, awaiting: true },
    { id: randomUUID(), kind: 'individual', organizationId: null, personId: individualId, stage: 'request', routeVersion: 'legacy', closed: false, awaiting: false },
  ];
  createdActivityIds.push(...fixtures.map((fixture) => fixture.id));
  for (const fixture of fixtures) {
    await pool.query(`INSERT INTO activities (id, kind, title, organization_id, person_id, stage_key, route_version, owner_sub, owner_name, awaiting_reply, closed)
      VALUES ($1::uuid, $2, $11, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10)`,
    [fixture.id, fixture.kind, fixture.organizationId, fixture.personId, fixture.stage, ('routeVersion' in fixture ? fixture.routeVersion : undefined) ?? 'legacy', fixtureOwnerSub, fixtureOwnerName, fixture.awaiting, fixture.closed, activitySearchTerm]);
  }
  await pool.query('UPDATE activities SET owner_name = $1, updated_at = $2 WHERE id = $3::uuid', ['B03 older label', new Date(Date.now() - 3_600_000).toISOString(), fixtures[1].id]);
  const pastDue = new Date(Date.now() - 60_000).toISOString();
  const futureDue = new Date(Date.now() + 86_400_000).toISOString();
  const moscowParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const moscowDate = Object.fromEntries(moscowParts.map((part) => [part.type, part.value]));
  const todayEarly = new Date(`${moscowDate.year}-${moscowDate.month}-${moscowDate.day}T00:15:00+03:00`).toISOString();
  const todayLate = new Date(`${moscowDate.year}-${moscowDate.month}-${moscowDate.day}T23:45:00+03:00`).toISOString();
  await pool.query(`INSERT INTO tasks (id, activity_id, title, due_at, status, owner_sub, owner_name)
    VALUES ($1::uuid, $2::uuid, 'B03 overdue', $3::timestamptz, 'open', $4, $5),
           ($6::uuid, $2::uuid, 'B03 future', $7::timestamptz, 'open', $4, $5),
           ($8::uuid, $2::uuid, 'B03 completed', $3::timestamptz, 'done', $4, $5),
           ($9::uuid, $10::uuid, 'B03 future individual', $7::timestamptz, 'open', $4, $5),
           ($11::uuid, $12::uuid, 'B03 closed overdue', $3::timestamptz, 'open', $4, $5)`,
  [randomUUID(), fixtures[0].id, pastDue, fixtureOwnerSub, fixtureOwnerName, randomUUID(), futureDue, randomUUID(), randomUUID(), fixtures[2].id, randomUUID(), fixtures[3].id]);
  await pool.query(`INSERT INTO tasks (id, activity_id, title, due_at, status, owner_sub, owner_name)
    VALUES ($1::uuid, $2::uuid, 'B03 today early MSK', $3::timestamptz, 'open', $4, $5),
           ($6::uuid, $7::uuid, 'B03 today late MSK', $8::timestamptz, 'open', $4, $5)`,
  [randomUUID(), fixtures[2].id, todayEarly, fixtureOwnerSub, fixtureOwnerName, randomUUID(), fixtures[4].id, todayLate]);
  await pool.query('INSERT INTO activity_products (activity_id, product_id) VALUES ($1::uuid, $3::uuid), ($2::uuid, $3::uuid)', [fixtures[0].id, fixtures[1].id, productIds[0]]);
  const overviewResponse = await app.inject({ method: 'GET', url: '/api/manager/overview', headers: { 'x-test-user': 'manager' } });
  assert.equal(overviewResponse.statusCode, 200, overviewResponse.body);
  const overview = overviewResponse.json();
  assert.equal(overview.metrics.totalOpen - beforeOverview.metrics.totalOpen, 4);
  assert.equal(overview.metrics.byKind.university - beforeOverview.metrics.byKind.university, 1);
  assert.equal(overview.metrics.byKind.corporate - beforeOverview.metrics.byKind.corporate, 1);
  assert.equal(overview.metrics.byKind.individual - beforeOverview.metrics.byKind.individual, 2);
  const expectedOverdue = 1 + Number(Date.parse(todayEarly) < Date.now()) + Number(Date.parse(todayLate) < Date.now());
  assert.equal(overview.metrics.overdue - beforeOverview.metrics.overdue, expectedOverdue);
  assert.equal(overview.metrics.awaitingReply - beforeOverview.metrics.awaitingReply, 1);
  assert.equal(overview.metrics.noNextStep - beforeOverview.metrics.noNextStep, 1);
  assert.deepEqual(overview.byOwner.find((row: { ownerSub: string }) => row.ownerSub === fixtureOwnerSub), {
    ownerSub: fixtureOwnerSub, ownerName: fixtureOwnerName, open: 4, overdue: expectedOverdue,
  });
  const productBefore = beforeOverview.topProducts.find((product: { id: string }) => product.id === productIds[0])?.activityCount ?? 0;
  const productAfter = overview.topProducts.find((product: { id: string }) => product.id === productIds[0])?.activityCount ?? 0;
  assert.equal(productAfter - productBefore, 2);
  const pipeline = overview.pipeline as { kind: string; routeVersion: string; stages: { key: string; label: string; stageKeys: string[]; count: number; oldestUpdatedAt: string | null }[] }[];
  const priorPipeline = beforeOverview.pipeline as typeof pipeline;
  const stageCount = (rows: typeof pipeline, kind: string, version: string, key: string) => rows.find((lane) => lane.kind === kind && lane.routeVersion === version)?.stages.find((stage) => stage.key === key)?.count ?? 0;
  assert.equal(stageCount(pipeline, 'university', 'current', 'contact') - stageCount(priorPipeline, 'university', 'current', 'contact'), 1);
  const legacyPipeline = pipeline.find((lane) => lane.kind === 'individual' && lane.routeVersion === 'legacy');
  const v2Pipeline = pipeline.find((lane) => lane.kind === 'individual' && lane.routeVersion === 'v2');
  assert.equal(legacyPipeline?.routeLabel, 'Заявки прежнего процесса');
  assert.equal(v2Pipeline?.routeLabel, 'Заявки текущего процесса');
  assert.equal(stageCount(pipeline, 'individual', 'legacy', 'request') - stageCount(priorPipeline, 'individual', 'legacy', 'request'), 1);
  assert.equal(stageCount(pipeline, 'individual', 'v2', 'request') - stageCount(priorPipeline, 'individual', 'v2', 'request'), 1);
  const macroStageDrilldown = await app.inject({ method: 'GET', url: `/api/activities?segment=individual&stageKeys=request&routeVersion=v2&ownerSub=${fixtureOwnerSub}`, headers: { 'x-test-user': 'manager' } });
  assert.equal(macroStageDrilldown.statusCode, 200, macroStageDrilldown.body);
  assert.equal(macroStageDrilldown.json().total, 1);
  assert.equal(macroStageDrilldown.json().items[0].id, fixtures.find((fixture) => fixture.kind === 'individual' && 'routeVersion' in fixture && fixture.routeVersion === 'v2')?.id);
  assert.deepEqual(macroStageDrilldown.json().items[0].allowedNextLabels, ['Консультация']);
  const ownerFirstPage = await app.inject({ method: 'GET', url: `/api/activities?ownerSub=${fixtureOwnerSub}&limit=2`, headers: { 'x-test-user': 'manager' } });
  assert.equal(ownerFirstPage.statusCode, 200, ownerFirstPage.body);
  assert.equal(ownerFirstPage.json().total, 4);
  assert.equal(ownerFirstPage.json().items.length, 2);
  const ownerLastPage = await app.inject({ method: 'GET', url: `/api/activities?ownerSub=${fixtureOwnerSub}&offset=2&limit=2`, headers: { 'x-test-user': 'manager' } });
  assert.equal(ownerLastPage.json().items.length, 2);
  assert.ok(ownerFirstPage.json().items.every((item: { ownerSub: string }) => item.ownerSub === fixtureOwnerSub));
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities?ownerSub=${fixtureOwnerSub}`, headers: { 'x-test-user': 'a' } })).statusCode, 403);
  const activitySearch = await app.inject({ method: 'GET', url: `/api/activities?q=${encodeURIComponent(activitySearchTerm)}&ownerSub=${fixtureOwnerSub}&limit=2&offset=2`, headers: { 'x-test-user': 'manager' } });
  assert.equal(activitySearch.statusCode, 200, activitySearch.body);
  assert.equal(activitySearch.json().total, 4);
  assert.equal(activitySearch.json().items.length, 2);
  assert.ok(activitySearch.json().items.every((item: { title: string }) => item.title === activitySearchTerm));
  const organizationSearch = await app.inject({ method: 'GET', url: `/api/activities?q=${encodeURIComponent(organizationSearchTerm)}&ownerSub=${fixtureOwnerSub}`, headers: { 'x-test-user': 'manager' } });
  assert.equal(organizationSearch.json().total, 2);
  const contactSearch = await app.inject({ method: 'GET', url: `/api/activities?q=${encodeURIComponent(contactSearchTerm)}&segment=individual&ownerSub=${fixtureOwnerSub}`, headers: { 'x-test-user': 'manager' } });
  assert.equal(contactSearch.json().total, 2);
  const hiddenSearch = await app.inject({ method: 'GET', url: `/api/activities?q=${encodeURIComponent(activitySearchTerm)}`, headers: { 'x-test-user': 'b' } });
  assert.equal(hiddenSearch.json().total, 0, 'search results remain within the KAM owner scope');
  const productDrilldown = await app.inject({ method: 'GET', url: `/api/activities?productId=${productIds[0]}&limit=100`, headers: { 'x-test-user': 'manager' } });
  assert.equal(productDrilldown.statusCode, 200, productDrilldown.body);
  assert.equal(productDrilldown.json().total, productBefore + 2);
  const scopedProductDrilldown = await app.inject({ method: 'GET', url: `/api/activities?productId=${productIds[0]}&limit=100`, headers: { 'x-test-user': 'b' } });
  assert.equal(scopedProductDrilldown.statusCode, 200, scopedProductDrilldown.body);
  assert.ok(scopedProductDrilldown.json().items.every((item: { ownerSub: string }) => item.ownerSub === kamB.sub));
  const moscowToday = await app.inject({ method: 'GET', url: `/api/activities?ownerSub=${fixtureOwnerSub}&collection=today&limit=100`, headers: { 'x-test-user': 'manager' } });
  assert.equal(moscowToday.statusCode, 200, moscowToday.body);
  assert.ok(moscowToday.json().items.some((item: { id: string }) => item.id === fixtures[2].id));
  assert.ok(moscowToday.json().items.some((item: { id: string }) => item.id === fixtures[4].id));
  const closedSteps = await app.inject({ method: 'GET', url: `/api/activities/${fixtures[3].id}/university-steps`, headers: { 'x-test-user': 'manager' } });
  assert.equal(closedSteps.statusCode, 200, closedSteps.body);
  assert.equal(closedSteps.json().readOnly, true);
  const closedWrite = await app.inject({ method: 'PUT', url: `/api/activities/${fixtures[3].id}/university-steps/U01`, headers: { 'x-test-user': 'manager' }, payload: { status: 'waiting', note: '', expectedRevision: 0 } });
  assert.equal(closedWrite.statusCode, 409);
  const closedCorrectionWrite = await app.inject({ method: 'POST', url: `/api/activities/${fixtures[3].id}/university-steps/correction-return`, headers: { 'x-test-user': 'manager' }, payload: { expectedU04Revision: 0, expectedU05Revision: 0, note: 'Не должно сохраниться' } });
  assert.equal(closedCorrectionWrite.statusCode, 409);

  const importHeaders = { 'x-test-user': 'a' };
  const sourceContact = `User Uploads ${randomUUID()}`;
  const sourceVendor = `Vendors ${randomUUID()}`;
  const sourceApplications = `External Applications ${randomUUID()}`;
  const contactOne = { name: `КАМ импорт ${randomUUID()}`, email: `irina.${randomUUID()}@Example.test`, phone: `+7 000 ${String(Date.now()).slice(-7)}` };
  const contactTwo = { name: `КАМ импорт ${randomUUID()}`, email: `petr.${randomUUID()}@Example.test`, phone: `+7 000 ${String(Date.now() + 1).slice(-7)}` };
  importSources.push(sourceContact, sourceVendor, sourceApplications);
  const uploadSheet = (rows: unknown[][]) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'User Uploads');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };
  async function uploadImport(target: string, source: string, filename: string, bytes: Buffer, actorHeaders = importHeaders) {
    const query = new URLSearchParams({ target, source, filename });
    const response = await app.inject({ method: 'POST', url: `/api/imports?${query}`, headers: { ...actorHeaders, 'content-type': 'application/vnd.lct.import' }, payload: bytes });
    assert.equal(response.statusCode, 201, response.body);
    const value = response.json(); importJobIds.push(value.id); return value;
  }
  async function previewImport(job: { id: string; revision: number }, selectedSheet: string, mapping: Record<string, string | null>, headerRow = 1, actorHeaders = importHeaders) {
    const response = await app.inject({ method: 'PUT', url: `/api/imports/${job.id}/preview`, headers: actorHeaders, payload: { revision: job.revision, selectedSheet, headerRow, mapping } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  async function confirmImport(job: { id: string; revision: number }, rowNumbers: number[], reviewedRows: number[] = [], idempotencyKey = randomUUID()) {
    return app.inject({ method: 'POST', url: `/api/imports/${job.id}/confirm`, headers: importHeaders, payload: { revision: job.revision, rowNumbers, reviewedRows, idempotencyKey } });
  }
  const externalContactId = `contact-${randomUUID()}`;
  const externalContactId2 = `contact-${randomUUID()}`;
  const contactWorkbook = uploadSheet([['user_id','Full Name','Email','Phone','Organization'],
    [externalContactId,contactOne.name,contactOne.email,contactOne.phone,'Учебный центр'],
    [externalContactId2,contactTwo.name,contactTwo.email,contactTwo.phone,'Учебный центр'],
    [`invalid-${randomUUID()}`,'','invalid-email','+7 000 999 00 00','Учебный центр'],
  ]);
  const contactJob = await uploadImport('contacts', sourceContact, 'contacts.xlsx', contactWorkbook);
  const contactHeader = await app.inject({ method: 'GET', url: `/api/imports/${contactJob.id}/header?sheet=User%20Uploads&row=1`, headers: importHeaders });
  assert.equal(contactHeader.statusCode, 200, contactHeader.body);
  assert.deepEqual(contactHeader.json().values, ['user_id','Full Name','Email','Phone','Organization']);
  assert.equal((await app.inject({ method: 'GET', url: `/api/imports/${contactJob.id}/header?sheet=User%20Uploads&row=1`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  const contactPreview = await previewImport(contactJob, 'User Uploads', { '0':'externalKey','1':'fullName','2':'email','3':'phone','4':'organizationName' });
  assert.deepEqual(contactPreview.rawHeadings, ['user_id','Full Name','Email','Phone','Organization']);
  assert.equal(contactPreview.preview[0].values.email, contactOne.email);
  assert.equal(contactPreview.preview[0].values.phone, contactOne.phone);
  assert.equal(contactPreview.preview[0].status, 'valid');
  assert.equal(contactPreview.preview[2].status, 'invalid');
  const sparseSheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(sparseSheet, [['user_id','Full Name']], { origin: 'A7' });
  XLSX.utils.sheet_add_aoa(sparseSheet, [[`late-${randomUUID()}`,'Header beyond sample']], { origin: 'A8' });
  sparseSheet['!ref'] = 'A7:B8';
  const sparseBook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(sparseBook, sparseSheet, 'User Uploads');
  const lateHeaderJob = await uploadImport('contacts', sourceContact, 'contacts-late-heading.xlsx', XLSX.write(sparseBook, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
  assert.equal(lateHeaderJob.sheets[0].firstRow, 7);
  const lateHeader = await app.inject({ method: 'GET', url: `/api/imports/${lateHeaderJob.id}/header?sheet=User%20Uploads&row=7`, headers: importHeaders });
  assert.deepEqual(lateHeader.json().values, ['user_id','Full Name']);
  const lateHeaderPreview = await previewImport(lateHeaderJob, 'User Uploads', { '0':'externalKey','1':'fullName' }, 7);
  assert.equal(lateHeaderPreview.preview[0].rowNumber, 8);
  assert.equal(lateHeaderPreview.preview[0].values.fullName, 'Header beyond sample');
  const beforeContactWrite = await pool.query('SELECT id FROM people WHERE import_source=$1 AND import_external_key=$2', [sourceContact, externalContactId]);
  assert.equal(beforeContactWrite.rowCount, 0, 'Preview must not write contacts.');
  assert.equal((await app.inject({ method: 'GET', url: `/api/imports/${contactJob.id}`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/imports/${contactJob.id}`, headers: { 'x-test-user': 'manager' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/imports/${contactJob.id}`, headers: { 'x-test-user': 'admin' } })).statusCode, 403);
  const contactConfirmBody = { revision: contactPreview.revision, rowNumbers: [2,3,4], reviewedRows: [], idempotencyKey: `contact-confirm-${randomUUID()}` };
  const contactConfirmed = await app.inject({ method: 'POST', url: `/api/imports/${contactJob.id}/confirm`, headers: importHeaders, payload: contactConfirmBody });
  assert.equal(contactConfirmed.statusCode, 200, contactConfirmed.body);
  assert.equal(contactConfirmed.json().rowResults[0].status, 'created', JSON.stringify(contactConfirmed.json()));
  assert.equal(contactConfirmed.json().rowResults[1].status, 'created');
  assert.equal(contactConfirmed.json().rowResults[2].status, 'skipped');
  const foreignKeyJob = await uploadImport('contacts', sourceContact, 'foreign-key.xlsx', uploadSheet([
    ['user_id','Full Name'], [externalContactId,'Not the owner record'],
  ]), { 'x-test-user': 'b' });
  const foreignKeyPreview = await previewImport(foreignKeyJob, 'User Uploads', { '0':'externalKey','1':'fullName' }, 1, { 'x-test-user': 'b' });
  assert.equal(foreignKeyPreview.preview[0].status, 'blocked');
  assert.deepEqual(foreignKeyPreview.preview[0].matches, [], 'A global source-key collision does not disclose the record or owner.');
  const contactConfirmedRetry = await app.inject({ method: 'POST', url: `/api/imports/${contactJob.id}/confirm`, headers: importHeaders, payload: contactConfirmBody });
  assert.deepEqual(contactConfirmedRetry.json(), contactConfirmed.json(), 'The same idempotency key returns the saved result.');
  const subsetRetry = await confirmImport(contactPreview, [2]);
  assert.deepEqual(subsetRetry.json().rowResults.map((row: { rowNumber: number; status: string }) => [row.rowNumber,row.status]), [[2,'unchanged'],[3,'created'],[4,'skipped']], 'Later confirmations preserve earlier row results while refreshing retried rows.');
  const importedContact = (await pool.query('SELECT id,full_name,email,phone FROM people WHERE import_source=$1 AND import_external_key=$2', [sourceContact, externalContactId])).rows[0];
  const importedContact2 = (await pool.query('SELECT id,full_name,email,phone FROM people WHERE import_source=$1 AND import_external_key=$2', [sourceContact, externalContactId2])).rows[0];
  personIds.push(importedContact.id, importedContact2.id);
  assert.equal(importedContact.email, contactOne.email);
  assert.equal(importedContact.phone, contactOne.phone);
  const contactOrganizationLink = await app.inject({ method: 'POST', url: '/api/activities', headers: importHeaders, payload: {
    kind: 'corporate', title: `B08 contact organization scope ${randomUUID()}`, personId: importedContact.id,
    organizationName: `B08 contact primary ${randomUUID()}`, payerOrganizationName: `B08 contact payer ${randomUUID()}`,
  } });
  assert.equal(contactOrganizationLink.statusCode, 201, contactOrganizationLink.body);
  createdActivityIds.push(contactOrganizationLink.json().id);
  const contactOrganizations = (await app.inject({ method: 'GET', url: `/api/activities/${contactOrganizationLink.json().id}`, headers: importHeaders })).json();
  orgIds.push(contactOrganizations.organizationId, contactOrganizations.payerOrganizationId);
  const primaryOnlyContactScope: Actor = { ...kamA, allowedOrganizationIds: [contactOrganizations.organizationId] };
  const fullContactScope: Actor = { ...kamA, allowedOrganizationIds: [contactOrganizations.organizationId, contactOrganizations.payerOrganizationId] };
  const noOrganizationScope: Actor = { ...kamA, allowedOrganizationIds: [] };
  assert.equal((await imports.listContacts(fullContactScope, importedContact.full_name)).length, 1, 'A contact linked to primary and payer organizations is visible when both are allowed.');
  assert.deepEqual(await imports.listContacts(primaryOnlyContactScope, importedContact.full_name), [], 'A disallowed payer organization hides a contact linked to an otherwise allowed primary organization.');
  assert.equal((await imports.listContacts(noOrganizationScope, importedContact2.full_name)).length, 1, 'A standalone imported contact remains visible even when no organizations are allowed.');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM activities WHERE person_id=$1', [importedContact2.id])).rows[0].count, 0,
    'The imported organization name is descriptive text and does not create an organization link.');
  const scopedContactSource = `Organization scoped contact matches ${randomUUID()}`; importSources.push(scopedContactSource);
  const scopedContactJob = await imports.upload(fullContactScope, 'scoped-contact.xlsx', 'contacts', scopedContactSource,
    uploadSheet([['Full Name','Email'], [importedContact.full_name, importedContact.email]]));
  importJobIds.push(scopedContactJob.id);
  const scopedContactPreview = await imports.preview(fullContactScope, scopedContactJob.id, {
    revision: 1, selectedSheet: 'User Uploads', headerRow: 1, mapping: { '0':'fullName','1':'email' },
  });
  assert.equal((scopedContactPreview.preview as { status: string }[])[0].status, 'possible_duplicate');
  const narrowedContactPreview = await imports.get(primaryOnlyContactScope, scopedContactJob.id);
  const narrowedContactRow = (narrowedContactPreview.preview as { status: string; matches: unknown[] }[])[0];
  assert.deepEqual(narrowedContactRow.matches, [], 'A saved contact preview drops matches outside the current organization scope.');
  assert.equal(narrowedContactRow.status, 'valid');
  await assert.rejects(imports.confirm(primaryOnlyContactScope, scopedContactJob.id, {
    revision: scopedContactPreview.revision as number, idempotencyKey: `org-scope-match-${randomUUID()}`, rowNumbers: [2], reviewedRows: [2],
  }), (error: unknown) => error instanceof DomainError && error.code === 'import_scope_changed',
  'A contact preview cannot be confirmed after its organization-linked match becomes hidden.');

  const scopedContactUpdate = await imports.upload(fullContactScope, 'scoped-contact-update.xlsx', 'contacts', sourceContact,
    uploadSheet([['user_id','Full Name'], [externalContactId, `${contactOne.name} обновлено`]]));
  importJobIds.push(scopedContactUpdate.id);
  const scopedContactUpdatePreview = await imports.preview(fullContactScope, scopedContactUpdate.id, {
    revision: 1, selectedSheet: 'User Uploads', headerRow: 1, mapping: { '0':'externalKey','1':'fullName' },
  });
  assert.equal((scopedContactUpdatePreview.preview as { status: string }[])[0].status, 'changed_requires_review');
  const deniedContactUpdate = await imports.confirm(primaryOnlyContactScope, scopedContactUpdate.id, {
    revision: scopedContactUpdatePreview.revision as number, idempotencyKey: `org-scope-contact-update-${randomUUID()}`, rowNumbers: [2], reviewedRows: [2],
  });
  assert.equal((deniedContactUpdate.rowResults as { status: string }[])[0].status, 'conflict', 'An imported contact update rechecks its linked organizations at confirmation time.');
  assert.equal((await pool.query('SELECT full_name FROM people WHERE id=$1', [importedContact.id])).rows[0].full_name, contactOne.name);
  const provenance = await pool.query('SELECT source_system,source_row_number,raw_headings,mapping,action FROM import_provenance WHERE job_id=$1', [contactJob.id]);
  assert.equal(provenance.rows[0].source_system, sourceContact);
  assert.equal(provenance.rows[0].source_row_number, 2);
  assert.deepEqual(provenance.rows[0].raw_headings, ['user_id','Full Name','Email','Phone','Organization']);
  assert.equal(provenance.rows[0].action, 'created');
  const reorderedContacts = await uploadImport('contacts', sourceContact, 'contacts-reordered.xlsx', uploadSheet([
    ['user_id','Full Name','Email','Phone','Organization'],
    [externalContactId2,contactTwo.name,contactTwo.email,contactTwo.phone,'Учебный центр'],
    [externalContactId,contactOne.name,contactOne.email,contactOne.phone,'Учебный центр'],
    [`invalid-${randomUUID()}`,'','invalid-email','+7 000 999 00 00','Учебный центр'],
  ]));
  const reorderedPreview = await previewImport(reorderedContacts, 'User Uploads', { '0':'externalKey','1':'fullName','2':'email','3':'phone','4':'organizationName' });
  assert.deepEqual(reorderedPreview.preview.map((row: { status: string }) => row.status), ['unchanged','unchanged','invalid']);
  const reorderedResult = await confirmImport(reorderedPreview, [2,3,4]);
  assert.deepEqual(reorderedResult.json().rowResults.map((row: { status: string }) => row.status), ['unchanged','unchanged','skipped']);
  assert.equal((await app.inject({ method: 'GET', url: `/api/contacts?query=${encodeURIComponent(importedContact.full_name)}`, headers: { 'x-test-user': 'a' } })).json()[0].id, importedContact.id);
  assert.equal((await app.inject({ method: 'GET', url: `/api/contacts?query=${encodeURIComponent(importedContact.full_name)}`, headers: { 'x-test-user': 'admin' } })).statusCode, 403);
  const otherOwnerReference = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'manager' }, payload: {
    kind: 'individual', title: 'Чужой импортированный контакт', personId: importedContact.id,
  } });
  assert.equal(otherOwnerReference.statusCode, 404);
  const ownedContactActivity = await app.inject({ method: 'POST', url: '/api/activities', headers: importHeaders, payload: {
    kind: 'individual', title: 'Активность с импортированным контактом', personId: importedContact.id,
  } });
  assert.equal(ownedContactActivity.statusCode, 201, ownedContactActivity.body);
  createdActivityIds.push(ownedContactActivity.json().id);
  const protectedContactActivity = await pool.query('SELECT import_owner_only FROM activities WHERE id=$1', [ownedContactActivity.json().id]);
  assert.equal(protectedContactActivity.rows[0].import_owner_only, true);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${ownedContactActivity.json().id}`, headers: { 'x-test-user': 'manager' } })).statusCode, 404);

  const duplicateUpload = uploadSheet([['user_id','Full Name','Email','Phone'], [null,contactOne.name,contactOne.email,contactOne.phone]]);
  const duplicateJob = await uploadImport('contacts', sourceContact, 'contacts-duplicate.xlsx', duplicateUpload);
  const duplicatePreview = await previewImport(duplicateJob, 'User Uploads', { '0':'externalKey','1':'fullName','2':'email','3':'phone' });
  assert.equal(duplicatePreview.preview[0].status, 'possible_duplicate');
  assert.ok(duplicatePreview.preview[0].matches[0].reasons.includes('Совпадает email'));
  const unreviewedDuplicate = await confirmImport(duplicatePreview, [2]);
  assert.equal(unreviewedDuplicate.json().rowResults[0].status, 'skipped');
  const reviewedDuplicate = await confirmImport(duplicatePreview, [2], [2]);
  assert.equal(reviewedDuplicate.json().rowResults[0].status, 'created');
  const separateContacts = await pool.query('SELECT id FROM people WHERE import_owner_sub=$1 AND email=$2', [kamA.sub, contactOne.email]);
  assert.equal(separateContacts.rowCount, 2, 'A possible match is only surfaced; a reviewed import creates a separate contact.');
  personIds.push(...separateContacts.rows.map((row: { id: string }) => row.id));

  const keylessName = `Повтор без ключа ${randomUUID()}`;
  const keylessEmail = `keyless.${randomUUID()}@example.test`;
  const keylessJob = await uploadImport('contacts', sourceContact, 'contacts-keyless-duplicates.xlsx', uploadSheet([
    ['Full Name','Email'], [keylessName,keylessEmail], [` ${keylessName.toLocaleUpperCase('ru-RU')} `,keylessEmail.toLocaleUpperCase('en-US')],
  ]));
  const keylessPreview = await previewImport(keylessJob, 'User Uploads', { '0':'fullName','1':'email' });
  assert.deepEqual(keylessPreview.preview.map((row: { status: string }) => row.status), ['valid','duplicate_in_file']);
  const keylessResult = await confirmImport(keylessPreview, [2,3]);
  assert.deepEqual(keylessResult.json().rowResults.map((row: { status: string }) => row.status), ['created','skipped']);
  const keylessStored = await pool.query('SELECT id FROM people WHERE import_owner_sub=$1 AND full_name=$2', [kamA.sub, keylessName]);
  assert.equal(keylessStored.rowCount, 1);
  personIds.push(keylessStored.rows[0].id);

  const csvContactKey = `csv-contact-${randomUUID()}`;
  const csvContactName = `Контакт, CSV ${randomUUID()}`;
  const csvContactEmail = `csv-contact-${randomUUID()}@example.test`;
  const csvContactJob = await uploadImport('contacts', sourceContact, 'contacts.csv', Buffer.from(
    `external_id,full_name,email,phone,organization\r\n${csvContactKey},"${csvContactName}",${csvContactEmail},+7 900 987 65 43,"ООО, CSV клиент"\r\n`, 'utf8'));
  const csvContactPreview = await previewImport(csvContactJob, 'CSV', { '0':'externalKey','1':'fullName','2':'email','3':'phone','4':'organizationName' });
  assert.equal(csvContactPreview.preview[0].status, 'valid');
  assert.equal((await confirmImport(csvContactPreview, [2])).json().rowResults[0].status, 'created');
  const storedCsvContact = await pool.query('SELECT id,full_name,email,organization_name FROM people WHERE import_source=$1 AND import_external_key=$2', [sourceContact, csvContactKey]);
  assert.equal(storedCsvContact.rowCount, 1);
  assert.deepEqual(storedCsvContact.rows[0], { id: storedCsvContact.rows[0].id, full_name: csvContactName, email: csvContactEmail, organization_name: 'ООО, CSV клиент' });
  personIds.push(storedCsvContact.rows[0].id);

  const changedContactJob = await uploadImport('contacts', sourceContact, 'contacts-updated.xlsx', uploadSheet([['user_id','Full Name'], [externalContactId,`${contactOne.name}, обновлено`]]));
  const changedContactPreview = await previewImport(changedContactJob, 'User Uploads', { '0':'externalKey','1':'fullName' });
  assert.equal(changedContactPreview.preview[0].status, 'changed_requires_review');
  const noReview = await confirmImport(changedContactPreview, [2]);
  assert.equal(noReview.json().rowResults[0].status, 'skipped');
  const reviewedUpdate = await confirmImport(changedContactPreview, [2], [2]);
  assert.equal(reviewedUpdate.json().rowResults[0].status, 'updated');
  const changedStoredContact = (await pool.query('SELECT id,email,phone FROM people WHERE import_source=$1 AND import_external_key=$2', [sourceContact, externalContactId])).rows[0];
  assert.equal(changedStoredContact.id, importedContact.id);
  assert.equal(changedStoredContact.email, contactOne.email, 'Unmapped email remains unchanged.');
  assert.equal(changedStoredContact.phone, contactOne.phone, 'Unmapped phone remains unchanged.');
  assert.equal((await pool.query('SELECT organization_name FROM people WHERE id=$1',[changedStoredContact.id])).rows[0].organization_name,'Учебный центр','Unmapped organization remains unchanged.');
  assert.equal((await app.inject({ method: 'POST', url: `/api/imports/${changedContactJob.id}/confirm`, headers: importHeaders, payload: { revision: 1, idempotencyKey: randomUUID(), rowNumbers: [2], reviewedRows: [2] } })).statusCode, 409, 'Confirmation is tied to the preview revision.');

  const vendorKey = `vendor-${randomUUID()}`;
  const vendorName = `Вендор B08 ${randomUUID()}`;
  const newProductName = `B08 product ${randomUUID()}`;
  const vendorJob = await uploadImport('vendors', sourceVendor, 'vendors.xls', (() => {
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Vendor ID','Vendor name','Products'], [vendorKey,vendorName,newProductName]]), 'Vendors');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Buffer;
  })());
  const vendorPreview = await previewImport(vendorJob, 'Vendors', { '0':'externalKey','1':'name','2':'productNames' });
  assert.equal(vendorPreview.preview[0].status, 'valid');
  assert.equal((await app.inject({ method: 'GET', url: `/api/imports/${vendorJob.id}`, headers: { 'x-test-user': 'b' } })).statusCode, 404);
  const vendorConfirmed = await confirmImport(vendorPreview, [2]);
  assert.equal(vendorConfirmed.json().rowResults[0].status, 'created');
  const vendorRow = (await pool.query('SELECT id,name FROM vendors WHERE owner_sub=$1 AND import_external_key=$2', [kamA.sub, vendorKey])).rows[0];
  importedVendorIds.push(vendorRow.id); importedProductNames.push(newProductName);
  assert.equal(vendorRow.name, vendorName);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM vendor_products vp JOIN products p ON p.id=vp.product_id WHERE vp.vendor_id=$1 AND p.name=$2', [vendorRow.id, newProductName])).rows[0].count, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM organizations WHERE name=$1', [vendorName])).rows[0].count, 0, 'A vendor remains a distinct entity from a buying organization.');
  assert.equal((await app.inject({ method: 'GET', url: '/api/vendors', headers: { 'x-test-user': 'a' } })).json().some((vendor: { id: string }) => vendor.id === vendorRow.id), true);
  assert.equal((await app.inject({ method: 'GET', url: '/api/vendors', headers: { 'x-test-user': 'b' } })).json().some((vendor: { id: string }) => vendor.id === vendorRow.id), false);
  const csvVendorKey = `csv-vendor-${randomUUID()}`;
  const csvVendorName = `Поставщик, CSV ${randomUUID()}`;
  const csvVendorProduct = `CSV продукт ${randomUUID()}`;
  const csvVendorJob = await uploadImport('vendors', sourceVendor, 'vendors.csv', Buffer.from(
    `external_id,name,product_names\r\n${csvVendorKey},"${csvVendorName}","${csvVendorProduct}"\r\n`, 'utf8'));
  const csvVendorPreview = await previewImport(csvVendorJob, 'CSV', { '0':'externalKey','1':'name','2':'productNames' });
  assert.equal(csvVendorPreview.preview[0].status, 'valid');
  assert.equal((await confirmImport(csvVendorPreview, [2])).json().rowResults[0].status, 'created');
  const storedCsvVendor = await pool.query('SELECT id,name FROM vendors WHERE owner_sub=$1 AND import_external_key=$2', [kamA.sub, csvVendorKey]);
  assert.deepEqual(storedCsvVendor.rows[0], { id: storedCsvVendor.rows[0].id, name: csvVendorName });
  importedVendorIds.push(storedCsvVendor.rows[0].id); importedProductNames.push(csvVendorProduct);
  const vendorAgain = await uploadImport('vendors', sourceVendor, 'vendors-again.xls', (() => {
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Vendor ID','Vendor name','Products'], [vendorKey,vendorName,newProductName]]), 'Vendors');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Buffer;
  })());
  const vendorAgainPreview = await previewImport(vendorAgain, 'Vendors', { '0':'externalKey','1':'name','2':'productNames' });
  assert.equal(vendorAgainPreview.preview[0].status, 'unchanged');
  assert.equal((await confirmImport(vendorAgainPreview, [2])).json().rowResults[0].status, 'unchanged');

  const applicationKeys = Array.from({ length: 5 }, () => `application-${randomUUID()}`);
  const appKey = applicationKeys[0];
  const applicationFixtureToken = randomUUID();
  const appJson = (phone: string) => Buffer.from(JSON.stringify({ applications: [null, ...applicationKeys.map((applicationId, index) => ({
    applicationId, applicant: { fullName: `Заявитель B08 ${applicationFixtureToken} ${index + 1}`, email: `Applicant${applicationFixtureToken}.${index + 1}@Example.test`, phone }, productName: 'RT.DataLake',
  }))] }));
  const appJob = await uploadImport('individual_applications', sourceApplications, 'applications.json', appJson(`+7 900 ${String(Date.now()).slice(-6)}`));
  const appPreview = await previewImport(appJob, 'applications', { '0':'externalKey','1':'fullName','2':'email','3':'phone','4':'productName' });
  assert.deepEqual(appPreview.preview.map((row: { rowNumber: number; status: string }) => [row.rowNumber,row.status]), [[2,'skipped_null'],[3,'valid'],[4,'valid'],[5,'valid'],[6,'valid'],[7,'valid']]);
  assert.match(appPreview.preview[0].warnings[0], /null/);
  const overviewBeforeApplication = (await app.inject({ method: 'GET', url: '/api/manager/overview', headers: { 'x-test-user': 'manager' } })).json();
  const appConfirmed = await confirmImport(appPreview, [3,4,5,6,7]);
  assert.deepEqual(appConfirmed.json().rowResults.map((row: { rowNumber: number; status: string }) => [row.rowNumber,row.status]), [[2,'skipped'],[3,'created'],[4,'created'],[5,'created'],[6,'created'],[7,'created']]);
  const importedActivity = (await pool.query('SELECT id,person_id,title,stage_key,origin,origin_source,origin_reference,import_owner_only,organization_id,payer_organization_id FROM activities WHERE owner_sub=$1 AND origin_source=$2 AND origin_reference=$3', [kamA.sub, sourceApplications, appKey])).rows[0];
  const applicationProvenance = await pool.query('SELECT source_system,external_key,file_name,source_row_number,action,actor_sub FROM import_provenance WHERE job_id=$1::uuid AND entity_id=$2::uuid', [appJob.id, importedActivity.id]);
  assert.deepEqual(applicationProvenance.rows[0], { source_system: sourceApplications, external_key: appKey, file_name: `individual_applications-${appJob.id}.json`, source_row_number: 3, action: 'created', actor_sub: kamA.sub });
  const importedApplications = await pool.query('SELECT id,person_id,origin_reference,organization_id,payer_organization_id FROM activities WHERE owner_sub=$1 AND origin_source=$2 AND origin_reference=ANY($3::text[])', [kamA.sub, sourceApplications, applicationKeys]);
  assert.equal(importedApplications.rowCount, 5);
  assert.ok(importedApplications.rows.every((row: { organization_id: string | null; payer_organization_id: string | null }) => row.organization_id === null && row.payer_organization_id === null),
    'Individual application imports create unlinked activities even when the contact file contains an organization name.');
  const importedApplicationIds = importedApplications.rows.map((row: { id: string }) => row.id);
  createdActivityIds.push(...importedApplicationIds); personIds.push(...importedApplications.rows.map((row: { person_id: string }) => row.person_id));

  const csvApplicationKey = `csv-application-${randomUUID()}`;
  const csvApplicationName = `Заявитель, CSV ${randomUUID()}`;
  const csvApplicationPhone = `+7 900 ${randomUUID().replace(/\D/g, '').slice(0, 10)}`;
  const csvApplicationJob = await uploadImport('individual_applications', sourceApplications, 'applications.csv', Buffer.from(
    `application_id,full_name,email,phone,product\r\n${csvApplicationKey},"${csvApplicationName}",csv-${randomUUID()}@example.test,${csvApplicationPhone},RT.DataLake\r\n`, 'utf8'));
  assert.equal(csvApplicationJob.fileFormat, 'csv');
  const missingApplicationKey = await app.inject({ method: 'PUT', url: `/api/imports/${csvApplicationJob.id}/preview`, headers: importHeaders,
    payload: { revision: csvApplicationJob.revision, selectedSheet: 'CSV', headerRow: 1, mapping: { '1':'fullName','2':'email','3':'phone','4':'productName' } } });
  assert.equal(missingApplicationKey.statusCode, 400);
  assert.equal(missingApplicationKey.json().code, 'application_key_unmapped', 'CSV applications keep the same required stable external ID as JSON.');
  const csvApplicationPreview = await previewImport(csvApplicationJob, 'CSV', { '0':'externalKey','1':'fullName','2':'email','3':'phone','4':'productName' });
  assert.equal(csvApplicationPreview.preview[0].status, 'valid');
  const csvApplicationConfirmed = await confirmImport(csvApplicationPreview, [2]);
  assert.equal(csvApplicationConfirmed.statusCode, 200, csvApplicationConfirmed.body);
  assert.equal(csvApplicationConfirmed.json().rowResults[0].status, 'created');
  const storedCsvApplication = await pool.query('SELECT id FROM activities WHERE owner_sub=$1 AND origin_source=$2 AND origin_reference=$3', [kamA.sub, sourceApplications, csvApplicationKey]);
  assert.equal(storedCsvApplication.rowCount, 1);
  createdActivityIds.push(storedCsvApplication.rows[0].id);
  const csvApplicationFacts = await pool.query('SELECT count(*)::integer AS count FROM individual_learning_facts WHERE activity_id=$1::uuid', [storedCsvApplication.rows[0].id]);
  assert.equal(csvApplicationFacts.rows[0].count, 0, 'CSV intake records the application without inventing LMS enrollment facts.');

  const individualOnly = kamAIndividual;
  const corporateOnly = kamACorporate;
  const scopeError = (error: unknown) => error instanceof DomainError && error.statusCode === 403 && error.code === 'segment_forbidden';
  const applicationPersonName = `Заявитель B08 ${applicationFixtureToken} 1`;
  const applicationPersonEmail = `Applicant${applicationFixtureToken}.1@Example.test`;
  assert.equal((await imports.listContacts(individualOnly, applicationPersonName)).length, 1, 'A currently allowed individual segment can find its imported applicant.');
  const organizationEmptyIndividualScope: Actor = { ...kamAIndividual, allowedOrganizationIds: [] };
  const organizationEmptyApplicationName = `Заявитель B08 ${applicationFixtureToken} 2`;
  assert.equal((await imports.listContacts(organizationEmptyIndividualScope, organizationEmptyApplicationName)).length, 1,
    'An unlinked individual application remains visible when the actor is assigned no organizations.');
  assert.deepEqual(await imports.listContacts(corporateOnly, applicationPersonName), [], 'A revoked individual segment no longer exposes its private applicant through contacts.');

  await pool.query('UPDATE activities SET organization_id=$2,payer_organization_id=$3 WHERE id=$1', [importedActivity.id, contactOrganizations.organizationId, contactOrganizations.payerOrganizationId]);
  const bothOrganizationIndividualScope: Actor = { ...kamAIndividual, allowedOrganizationIds: [contactOrganizations.organizationId, contactOrganizations.payerOrganizationId] };
  const primaryOnlyIndividualScope: Actor = { ...kamAIndividual, allowedOrganizationIds: [contactOrganizations.organizationId] };
  const linkedApplicationName = applicationPersonName;
  assert.equal((await imports.listContacts(bothOrganizationIndividualScope, linkedApplicationName)).length, 1,
    'A private individual applicant linked to two allowed organizations remains visible.');
  assert.deepEqual(await imports.listContacts(primaryOnlyIndividualScope, linkedApplicationName), [],
    'The contact list applies payer organization scope to linked individual activities.');
  const changedLinkedApplication = await imports.upload(bothOrganizationIndividualScope, 'linked-application-update.json', 'individual_applications', sourceApplications,
    Buffer.from(JSON.stringify({ applications: [{ applicationId: appKey, applicant: {
      fullName: `${applicationPersonName} обновлено`, email: applicationPersonEmail,
      phone: (await pool.query('SELECT phone FROM people WHERE id=$1', [importedActivity.person_id])).rows[0].phone,
    }, productName: 'RT.DataLake' }] })));
  importJobIds.push(changedLinkedApplication.id);
  const changedLinkedApplicationPreview = await imports.preview(bothOrganizationIndividualScope, changedLinkedApplication.id, {
    revision: 1, selectedSheet: changedLinkedApplication.sheets[0].name, headerRow: 1,
    mapping: { '0':'externalKey','1':'fullName','2':'email','3':'phone','4':'productName' },
  });
  assert.equal((changedLinkedApplicationPreview.preview as { status: string }[])[0].status, 'changed_requires_review');
  const deniedLinkedApplicationUpdate = await imports.confirm(primaryOnlyIndividualScope, changedLinkedApplication.id, {
    revision: changedLinkedApplicationPreview.revision as number, idempotencyKey: `org-scope-application-update-${randomUUID()}`, rowNumbers: [2], reviewedRows: [2],
  });
  assert.equal((deniedLinkedApplicationUpdate.rowResults as { status: string }[])[0].status, 'conflict',
    'An existing linked application update rechecks both organization links during confirmation.');
  assert.equal((await pool.query('SELECT full_name FROM people WHERE id=$1', [importedActivity.person_id])).rows[0].full_name, applicationPersonName);

  const sameApplicantContact = await imports.upload(corporateOnly, 'same-applicant.xlsx', 'contacts', `Scope check ${randomUUID()}`, uploadSheet([
    ['Full Name','Email'], [applicationPersonName,applicationPersonEmail],
  ]));
  importJobIds.push(sameApplicantContact.id);
  const scopedMatchPreview = await imports.preview(corporateOnly, sameApplicantContact.id, { revision: 1, selectedSheet: 'User Uploads', headerRow: 1, mapping: { '0':'fullName','1':'email' } });
  assert.equal((scopedMatchPreview.preview as { matches: unknown[] }[])[0].matches.length, 0, 'Contact matching does not reveal a private individual applicant outside the actor scope.');
  const previouslyVisibleMatch = await imports.preview(individualOnly, sameApplicantContact.id, { revision: scopedMatchPreview.revision as number, selectedSheet: 'User Uploads', headerRow: 1, mapping: { '0':'fullName','1':'email' } });
  assert.equal((previouslyVisibleMatch.preview as { status: string }[])[0].status, 'possible_duplicate');
  const hiddenMatchRead = await imports.get(corporateOnly, sameApplicantContact.id);
  const hiddenMatchRow = (hiddenMatchRead.preview as { status: string; matches: unknown[] }[])[0];
  assert.deepEqual(hiddenMatchRow.matches, [], 'A saved contact preview drops candidates that became out of scope after preview creation.');
  assert.equal(hiddenMatchRow.status, 'valid');
  await assert.rejects(imports.confirm(corporateOnly, sameApplicantContact.id, { revision: hiddenMatchRead.revision as number, idempotencyKey: `scope-match-${randomUUID()}`, rowNumbers: [2], reviewedRows: [2] }),
    (error: unknown) => error instanceof DomainError && error.code === 'import_scope_changed', 'A contact preview with a newly hidden match must be refreshed before confirmation.');

  const scopedSource = `Scoped external applications ${randomUUID()}`; importSources.push(scopedSource);
  const deniedUploadRoute = await app.inject({ method: 'POST', url: `/api/imports?${new URLSearchParams({ filename: 'denied-applications.json', target: 'individual_applications', source: scopedSource })}`,
    headers: { 'x-test-user': 'a-corporate', 'content-type': 'application/vnd.lct.import' }, payload: Buffer.from('{"applications":[]}') });
  assert.equal(deniedUploadRoute.statusCode, 403, deniedUploadRoute.body);
  assert.equal(deniedUploadRoute.json().code, 'segment_forbidden');
  const scopedApplication = await imports.upload(individualOnly, 'scoped-applications.json', 'individual_applications', scopedSource, Buffer.from(JSON.stringify({ applications: [{
    applicationId: `scope-${randomUUID()}`, applicant: { fullName: `Scope Applicant ${randomUUID()}` },
  }] })));
  importJobIds.push(scopedApplication.id);
  const scopedSheet = scopedApplication.sheets[0].name;
  const scopedApplicationPreview = await imports.preview(individualOnly, scopedApplication.id, { revision: 1, selectedSheet: scopedSheet, headerRow: 1, mapping: { '0':'externalKey','1':'fullName' } });
  const scopedConfirmInput = { revision: scopedApplicationPreview.revision as number, idempotencyKey: `scope-retry-${randomUUID()}`, rowNumbers: [2], reviewedRows: [] };
  const deniedScopeCalls: (() => Promise<unknown>)[] = [
    () => imports.get(corporateOnly, scopedApplication.id),
    () => imports.getHeader(corporateOnly, scopedApplication.id, scopedSheet, 1),
    () => imports.preview(corporateOnly, scopedApplication.id, { revision: 2, selectedSheet: scopedSheet, headerRow: 1, mapping: { '0':'externalKey','1':'fullName' } }),
    () => imports.confirm(corporateOnly, scopedApplication.id, scopedConfirmInput),
    () => imports.cancel(corporateOnly, scopedApplication.id),
    () => imports.upload(corporateOnly, 'denied-applications.json', 'individual_applications', scopedSource, Buffer.from('{"applications":[]}')),
  ];
  for (const access of deniedScopeCalls) await assert.rejects(access(), scopeError, 'Individual import access is checked against the actor’s current allowed kinds.');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM activities WHERE owner_sub=$1 AND origin_source=$2', [kamA.sub, scopedSource])).rows[0].count, 0,
    'A stale individual preview cannot create an activity after individual scope is removed.');
  const scopedCreated = await imports.confirm(individualOnly, scopedApplication.id, scopedConfirmInput);
  const scopedActivityId = (scopedCreated.rowResults as { entityId?: string }[]).find((row) => row.entityId)?.entityId;
  assert.ok(scopedActivityId);
  createdActivityIds.push(scopedActivityId!);
  const scopedPerson = await pool.query('SELECT person_id FROM activities WHERE id=$1', [scopedActivityId]);
  if (scopedPerson.rows[0]?.person_id) personIds.push(scopedPerson.rows[0].person_id);
  const staleIdempotentRetry = imports.confirm(corporateOnly, scopedApplication.id, scopedConfirmInput);
  await assert.rejects(staleIdempotentRetry, scopeError, 'Revoked scope is checked before returning a saved idempotent confirmation result.');
  assert.equal(importedActivity.stage_key, 'lms_handoff');
  assert.equal(importedActivity.origin, 'external_ready');
  assert.equal(importedActivity.import_owner_only, true);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM tasks WHERE activity_id=ANY($1::uuid[])', [importedApplicationIds])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM individual_learning_facts WHERE activity_id=ANY($1::uuid[])', [importedApplicationIds])).rows[0].count, 0);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${importedActivity.id}`, headers: { 'x-test-user': 'a' } })).statusCode, 200);
  for (const testUser of ['b','manager']) assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${importedActivity.id}`, headers: { 'x-test-user': testUser } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${importedActivity.id}`, headers: { 'x-test-user': 'admin' } })).statusCode, 403);
  const importedHistory = await app.inject({ method: 'GET', url: `/api/activities/${importedActivity.id}/history`, headers: importHeaders });
  const importEvent = importedHistory.json().find((event: { eventType: string }) => event.eventType === 'external_application_imported');
  assert.ok(importEvent, 'The reviewed import records its own activity event.');
  assert.equal(importEvent.details.source, sourceApplications);
  assert.equal(importEvent.details.externalKey, appKey);
  assert.equal(importEvent.details.importJobId, appJob.id);
  assert.equal(importEvent.details.sourceRow, 3);
  assert.match(importEvent.details.payloadHash, /^[0-9a-f]{64}$/i);
  assert.equal(importEvent.details.paymentStatus, 'unknown');
  assert.equal(importEvent.details.enrollmentCreated, false);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${importedActivity.id}/learning-facts`, headers: importHeaders })).json().length, 0);
  const overviewAfterApplication = (await app.inject({ method: 'GET', url: '/api/manager/overview', headers: { 'x-test-user': 'manager' } })).json();
  assert.equal(overviewAfterApplication.metrics.totalOpen, overviewBeforeApplication.metrics.totalOpen, 'Private imported applications do not leak into another manager’s aggregate.');
  const managerQueue = await app.inject({ method: 'GET', url: '/api/activities?segment=individual&collection=all&limit=100', headers: { 'x-test-user': 'manager' } });
  assert.equal(managerQueue.json().items.some((item: { id: string }) => item.id === importedActivity.id), false);
  const changedAppJob = await uploadImport('individual_applications', sourceApplications, 'applications-changed.json', appJson('+7 900 000 02'));
  const changedAppPreview = await previewImport(changedAppJob, 'applications', { '0':'externalKey','1':'fullName','2':'email','3':'phone','4':'productName' });
  assert.equal(changedAppPreview.preview[1].status, 'changed_requires_review');
  const unreviewedApp = await confirmImport(changedAppPreview, [3]);
  assert.equal(unreviewedApp.json().rowResults.find((row: { rowNumber: number }) => row.rowNumber === 3).status, 'skipped');
  const reviewedApp = await confirmImport(changedAppPreview, [3], [3]);
  assert.equal(reviewedApp.json().rowResults.find((row: { rowNumber: number }) => row.rowNumber === 3).status, 'updated');
  const changedAppStored = (await pool.query('SELECT a.id,p.phone FROM activities a JOIN people p ON p.id=a.person_id WHERE a.id=$1', [importedActivity.id])).rows[0];
  assert.equal(changedAppStored.id, importedActivity.id);
  assert.equal(changedAppStored.phone, '+7 900 000 02');

  // B10/B12 reports preserve one full, permission-checked slice across metrics, drilldowns, pagination, and exports.
  const reportFixtures = await pool.query(`INSERT INTO activities(id,kind,title,organization_id,stage_key,owner_sub,owner_name,priority,created_at,updated_at)
    SELECT gen_random_uuid(),'university',$4 || g::text,$1::uuid,'contact',$2,$3,3,now()-g*interval '1 minute',now()-g*interval '1 minute'
    FROM generate_series(1,31) AS g RETURNING id`, [detail.json().organizationId, kamA.sub, kamA.name, `B10 отчёт ${randomUUID()} · `]);
  const reportFixtureIds = reportFixtures.rows.map((row: { id: string }) => row.id);
  createdActivityIds.push(...reportFixtureIds);
  const readAllReportRows = async (user: string, snapshot: any) => {
    const rows = [...snapshot.rows];
    const pageCount = Math.max(1, Math.ceil(snapshot.rowCount / snapshot.pageSize));
    for (let page = 2; page <= pageCount; page += 1) {
      const response = await app.inject({ method: 'GET', url: `/api/reports/snapshots/${snapshot.snapshotId}?page=${page}`, headers: { 'x-test-user': user } });
      assert.equal(response.statusCode, 200, response.body);
      rows.push(...response.json().rows);
    }
    return rows;
  };
  const managerReport = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'manager' }, payload: { reportId: 'crm_portfolio', filters: { kind: 'university', includeClosed: true } } });
  assert.equal(managerReport.statusCode, 201, managerReport.body);
  assert.equal(managerReport.headers['cache-control'], 'private, no-store');
  const managerSnapshot = managerReport.json();
  const managerRows = await readAllReportRows('manager', managerSnapshot);
  assert.ok(reportFixtureIds.every((id: string) => managerRows.some((row: { activityId: string }) => row.activityId === id)));
  assert.equal(managerRows.some((row: { activityId: string }) => row.activityId === importedActivity.id), false, 'Owner-private imported records are excluded from manager slices.');
  assert.ok(managerSnapshot.chart.series.reduce((sum: number, item: { value: number }) => sum + item.value, 0) <= managerSnapshot.rowCount);

  const kamReport = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'a' }, payload: { reportId: 'crm_portfolio', filters: { kind: 'university', includeClosed: true } } });
  assert.equal(kamReport.statusCode, 201, kamReport.body);
  const kamSnapshot = kamReport.json();
  const kamRows = await readAllReportRows('a', kamSnapshot);
  assert.ok(reportFixtureIds.every((id: string) => kamRows.some((row: { activityId: string }) => row.activityId === id)));
  assert.ok(kamSnapshot.rows.every((row: { ownerSub: string }) => row.ownerSub === kamA.sub));
  assert.ok(kamSnapshot.rowCount > 25, 'Snapshot includes more rows than the visible table page.');
  assert.equal(kamSnapshot.rows.length, 25);
  const kamSecondPage = await app.inject({ method: 'GET', url: `/api/reports/snapshots/${kamSnapshot.snapshotId}?page=2`, headers: { 'x-test-user': 'a' } });
  assert.equal(kamSecondPage.statusCode, 200, kamSecondPage.body);
  assert.equal(kamSecondPage.json().page, 2);
  assert.equal(kamSecondPage.json().rowCount, kamSnapshot.rowCount);
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/snapshots/${kamSnapshot.snapshotId}`, headers: { 'x-test-user': 'b' } })).statusCode, 404, 'Another KAM cannot read a snapshot created by a peer.');
  const kamBReport = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'b' }, payload: { reportId: 'crm_portfolio', filters: { kind: 'university', includeClosed: true } } });
  assert.equal(kamBReport.statusCode, 201, kamBReport.body);
  assert.ok(kamBReport.json().rows.every((row: { activityId: string }) => !reportFixtureIds.includes(row.activityId)));

  await pool.query('INSERT INTO activity_products(activity_id,product_id) VALUES($1::uuid,$2::uuid)', [corporate.json().id, productIds[0]]);
  const demandCorporate = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'a' }, payload: { reportId: 'demand_learning', filters: { kind: 'corporate', includeClosed: true } } });
  assert.equal(demandCorporate.statusCode, 201, demandCorporate.body);
  const corporateDemandRow = demandCorporate.json().rows.find((row: { activityId: string }) => row.activityId === corporate.json().id);
  assert.equal(corporateDemandRow.requestedPlaces, 30);
  assert.match(demandCorporate.json().metrics.find((item: { key: string }) => item.key === 'requestedPlaces').definition, /не число людей/);
  assert.equal(demandCorporate.json().dataProfile, 'synthetic_demo');
  const productDemandChart = demandCorporate.json().charts.find((chart: { id: string }) => chart.id === 'product-demand-places');
  const productPlacesSeries = productDemandChart.series.find((series: { filter?: { productId?: string } }) => series.filter?.productId === productIds[0]);
  assert.ok(productPlacesSeries.value >= 30);
  assert.equal(productPlacesSeries.filter.kind, 'corporate');
  assert.equal(productPlacesSeries.filter.requestedPlacesRecorded, true);
  assert.match(productDemandChart.unit, /не суммируется/);
  const placesByProductDrilldown = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'a' }, payload: { reportId: 'demand_learning', filters: { kind: 'corporate', productId: productIds[0], requestedPlacesRecorded: true, includeClosed: true } } });
  assert.equal(placesByProductDrilldown.statusCode, 201, placesByProductDrilldown.body);
  const placesDrillSnapshot = placesByProductDrilldown.json();
  assert.equal((await readAllReportRows('a', placesDrillSnapshot)).reduce((sum: number, row: { requestedPlaces: number | null }) => sum + (row.requestedPlaces ?? 0), 0), productPlacesSeries.value);
  assert.ok(placesByProductDrilldown.json().rows.some((row: { activityId: string }) => row.activityId === corporate.json().id));
  const demandUniversity = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'a' }, payload: { reportId: 'demand_learning', filters: { kind: 'university', includeClosed: true } } });
  assert.equal(demandUniversity.statusCode, 201, demandUniversity.body);
  const universityDemandSnapshot = demandUniversity.json();
  const universityRows = await readAllReportRows('a', universityDemandSnapshot);
  const firstLinkedProductCount = universityRows.filter((row: { productLinks: { id: string }[] }) => row.productLinks.some((product) => product.id === productIds[0])).length;
  const firstProductSeries = universityDemandSnapshot.charts.find((chart: { id: string }) => chart.id === 'product-activity-links').series.find((series: { filter?: { productId?: string } }) => series.filter?.productId === productIds[0]);
  assert.equal(firstProductSeries.value, firstLinkedProductCount, 'Product chart counts unique activities linked to that product.');
  assert.match(universityDemandSnapshot.charts.find((chart: { id: string }) => chart.id === 'product-activity-links').unit, /не суммируется/);
  const reportProductDrilldown = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'a' }, payload: { reportId: 'demand_learning', filters: { kind: 'university', productId: productIds[0], includeClosed: true } } });
  assert.equal(reportProductDrilldown.statusCode, 201, reportProductDrilldown.body);
  assert.equal(reportProductDrilldown.json().rowCount, firstProductSeries.value);
  assert.ok((await readAllReportRows('a', reportProductDrilldown.json())).every((row: { productLinks: { id: string }[] }) => row.productLinks.some((product) => product.id === productIds[0])));
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/snapshots/${universityDemandSnapshot.snapshotId}`, headers: { 'x-test-user': 'a' } })).headers['cache-control'], 'private, no-store');
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/snapshots/${universityDemandSnapshot.snapshotId}`, headers: { 'x-test-user': 'admin' } })).statusCode, 403,
    'An admin-only token cannot read a business snapshot, even through its direct ID.');
  assert.equal((await app.inject({ method: 'POST', url: '/api/reports/exports', headers: { 'x-test-user': 'admin' }, payload: { snapshotId: universityDemandSnapshot.snapshotId, format: 'json' } })).statusCode, 403,
    'An admin-only token cannot start a report export from a direct snapshot ID.');

  const exportCreated = await app.inject({ method: 'POST', url: '/api/reports/exports', headers: { 'x-test-user': 'a' }, payload: { snapshotId: kamSnapshot.snapshotId, format: 'xlsx' } });
  assert.equal(exportCreated.statusCode, 202, exportCreated.body);
  assert.equal(exportCreated.headers['cache-control'], 'private, no-store');
  const exportId = exportCreated.json().id;
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}`, headers: { 'x-test-user': 'admin' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}/file`, headers: { 'x-test-user': 'admin' } })).statusCode, 403);
  let exportStatus: any;
  const exportDeadline = Date.now() + 10_000;
  do {
    const statusResponse = await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}`, headers: { 'x-test-user': 'a' } });
    assert.equal(statusResponse.statusCode, 200, statusResponse.body);
    assert.equal(statusResponse.headers['cache-control'], 'private, no-store');
    exportStatus = statusResponse.json();
    if (exportStatus.status === 'completed' || exportStatus.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < exportDeadline);
  assert.equal(exportStatus.status, 'completed');
  assert.equal(exportStatus.rowCount, kamSnapshot.rowCount);
  const exportFile = await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}/file`, headers: { 'x-test-user': 'a' } });
  assert.equal(exportFile.statusCode, 200, exportFile.body);
  assert.equal(exportFile.headers['cache-control'], 'private, no-store');
  assert.deepEqual(exportFile.rawPayload.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const parsedExport = XLSX.read(exportFile.rawPayload, { type: 'buffer' });
  const exportedRows = XLSX.utils.sheet_to_json<unknown[]>(parsedExport.Sheets['Данные']!, { header: 1, defval: null });
  assert.equal(exportedRows.length - 2, kamSnapshot.rowCount, 'Downloaded workbook contains the complete slice rather than one page.');
  assert.equal(exportedRows[0][0], 'Отчёт: Портфель CRM');
  const exportListResponse = await app.inject({ method: 'GET', url: '/api/reports/exports?limit=20', headers: { 'x-test-user': 'a' } });
  assert.equal(exportListResponse.statusCode, 200, exportListResponse.body);
  assert.equal(exportListResponse.headers['cache-control'], 'private, no-store');
  assert.ok(exportListResponse.json().some((job: { id: string; status: string }) => job.id === exportId && job.status === 'completed'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/reports/exports?limit=21', headers: { 'x-test-user': 'a' } })).statusCode, 400,
    'The durable list enforces its maximum result count.');
  assert.equal((await app.inject({ method: 'GET', url: '/api/reports/exports?limit=20', headers: { 'x-test-user': 'b' } })).json().some((job: { id: string }) => job.id === exportId), false,
    'A peer cannot discover another user’s export through the list.');

  const selectedColumns = ['activityId', 'title', 'ownerName'];
  for (const invalidColumns of [[], ['unknown'], ['title', 'title']]) {
    const invalidExport = await app.inject({ method: 'POST', url: '/api/reports/exports', headers: { 'x-test-user': 'a' }, payload: { snapshotId: kamSnapshot.snapshotId, format: 'xlsx', columns: invalidColumns } });
    assert.equal(invalidExport.statusCode, 400, `Invalid export column selection must be rejected: ${JSON.stringify(invalidColumns)}`);
  }
  const selectedExportIds: string[] = [];
  for (const format of ['xls', 'xlsx'] as const) {
    const selectedCreated = await app.inject({ method: 'POST', url: '/api/reports/exports', headers: { 'x-test-user': 'a' }, payload: { snapshotId: kamSnapshot.snapshotId, format, columns: selectedColumns } });
    assert.equal(selectedCreated.statusCode, 202, selectedCreated.body);
    const selectedExportId = selectedCreated.json().id;
    selectedExportIds.push(selectedExportId);
    let selectedStatus: any;
    const selectedDeadline = Date.now() + 10_000;
    do {
      const status = await app.inject({ method: 'GET', url: `/api/reports/exports/${selectedExportId}`, headers: { 'x-test-user': 'a' } });
      assert.equal(status.statusCode, 200, status.body);
      selectedStatus = status.json();
      if (selectedStatus.status === 'completed' || selectedStatus.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < selectedDeadline);
    assert.equal(selectedStatus.status, 'completed');
    const selectedFile = await app.inject({ method: 'GET', url: `/api/reports/exports/${selectedExportId}/file`, headers: { 'x-test-user': 'a' } });
    assert.equal(selectedFile.statusCode, 200, selectedFile.body);
    const selectedBook = XLSX.read(selectedFile.rawPayload, { type: 'buffer' });
    const selectedRows = XLSX.utils.sheet_to_json<unknown[]>(selectedBook.Sheets['Данные']!, { header: 1, defval: null });
    assert.deepEqual(selectedRows[1], ['ID активности', 'Активность', 'Ответственный']);
    assert.equal(selectedRows.length - 2, kamSnapshot.rowCount, `${format} retains every snapshot row.`);
    assert.equal(selectedRows[2][1], kamSnapshot.rows[0].title);
    assert.equal(XLSX.utils.sheet_to_json(selectedBook.Sheets['Показатели']!, { header: 1 }).length, kamSnapshot.metrics.length + 2);
  }
  const multipleExportList = await app.inject({ method: 'GET', url: '/api/reports/exports', headers: { 'x-test-user': 'a' } });
  assert.equal(multipleExportList.statusCode, 200, multipleExportList.body);
  const listedExports = multipleExportList.json() as { id: string; createdAt: string }[];
  assert.ok([exportId, ...selectedExportIds].every((id) => listedExports.some((job) => job.id === id)),
    'Completed jobs remain discoverable together after more exports are created.');
  assert.deepEqual(listedExports.map((job) => job.id), [...listedExports].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)).map((job) => job.id),
    'The collection stays newest first.');
  const oneExportList = await app.inject({ method: 'GET', url: '/api/reports/exports?limit=1', headers: { 'x-test-user': 'a' } });
  assert.equal(oneExportList.json().length, 1);
  assert.equal(oneExportList.json()[0].id, listedExports[0].id, 'Callers can choose a smaller bounded window.');

  const failedExportId = randomUUID();
  const failedExportFileKey = randomUUID();
  await pool.query(`INSERT INTO report_jobs(id,job_type,report_id,actor_sub,actor_name,parameters,payload,source_snapshot_id,format,file_key,row_count,status,expires_at)
    VALUES($1,'export',$2,$3,$4,$5::jsonb,$6::jsonb,$7::uuid,'pdf',$8,$9,'queued',now()+interval '1 hour')`, [failedExportId, kamSnapshot.reportId, kamA.sub, kamA.name, JSON.stringify(kamSnapshot.filters), JSON.stringify({ ...kamSnapshot, rows: [] }), kamSnapshot.snapshotId, failedExportFileKey, kamSnapshot.rowCount]);
  await runReportExportJob(failedExportId, { render: async () => { throw new Error('deliberate test failure'); } });
  const failedStatus = await app.inject({ method: 'GET', url: `/api/reports/exports/${failedExportId}`, headers: { 'x-test-user': 'a' } });
  assert.equal(failedStatus.statusCode, 200);
  assert.equal(failedStatus.json().status, 'failed');
  assert.match(failedStatus.json().errorMessage, /Не удалось сформировать/);
  const failedFile = await app.inject({ method: 'GET', url: `/api/reports/exports/${failedExportId}/file`, headers: { 'x-test-user': 'a' } });
  assert.equal(failedFile.statusCode, 409);
  assert.equal(failedFile.headers['cache-control'], 'private, no-store');
  assert.ok((await app.inject({ method: 'GET', url: '/api/reports/exports', headers: { 'x-test-user': 'a' } })).json().some((job: { id: string; status: string }) => job.id === failedExportId && job.status === 'failed'),
    'Failed jobs remain visible in the durable list with their status.');

  const expiryFailureId = randomUUID();
  const expiryFailureFileKey = randomUUID();
  await pool.query(`INSERT INTO report_jobs(id,job_type,report_id,actor_sub,actor_name,parameters,payload,source_snapshot_id,format,file_key,row_count,status,expires_at)
    VALUES($1,'export',$2,$3,$4,$5::jsonb,$6::jsonb,$7::uuid,'pdf',$8,$9,'completed',now()-interval '1 minute')`, [expiryFailureId, kamSnapshot.reportId, kamA.sub, kamA.name, JSON.stringify(kamSnapshot.filters), JSON.stringify({ ...kamSnapshot, rows: [] }), kamSnapshot.snapshotId, expiryFailureFileKey, kamSnapshot.rowCount]);
  const stillRunningId = randomUUID();
  await pool.query(`INSERT INTO report_jobs(id,job_type,report_id,actor_sub,actor_name,parameters,payload,source_snapshot_id,format,file_key,row_count,status,expires_at)
    VALUES($1,'export',$2,$3,$4,$5::jsonb,$6::jsonb,$7::uuid,'pdf',$8,$9,'running',now()-interval '1 minute')`, [stillRunningId, kamSnapshot.reportId, kamA.sub, kamA.name, JSON.stringify(kamSnapshot.filters), JSON.stringify({ ...kamSnapshot, rows: [] }), kamSnapshot.snapshotId, randomUUID(), kamSnapshot.rowCount]);
  const reportCleanupErrors: unknown[] = [];
  await purgeExpiredReportJobs({ remove: async () => { throw new Error('simulated private storage deletion failure'); }, cleanupTemps: async () => 0, onError: (error) => reportCleanupErrors.push(error) });
  assert.ok(reportCleanupErrors.length > 0);
  assert.equal((await pool.query('SELECT status FROM report_jobs WHERE id=$1', [expiryFailureId])).rows[0].status, 'completed', 'A failed file deletion remains retryable instead of marking private bytes expired.');
  assert.equal((await pool.query('SELECT status FROM report_jobs WHERE id=$1', [stillRunningId])).rows[0].status, 'running', 'Expiry cleanup leaves an active writer alone until it settles.');
  const afterExpiryList = await app.inject({ method: 'GET', url: '/api/reports/exports', headers: { 'x-test-user': 'a' } });
  assert.ok([expiryFailureId, stillRunningId].every((id) => !afterExpiryList.json().some((job: { id: string }) => job.id === id)),
    'Expired jobs are omitted even when cleanup leaves their database status retryable.');

  await pool.query('UPDATE activities SET owner_sub=$2, owner_name=$3 WHERE id=$1::uuid', [reportFixtureIds[0], kamB.sub, kamB.name]);
  for (const url of [`/api/reports/snapshots/${kamSnapshot.snapshotId}`, `/api/reports/exports/${exportId}`, `/api/reports/exports/${exportId}/file`, ...selectedExportIds.flatMap((id) => [`/api/reports/exports/${id}`, `/api/reports/exports/${id}/file`])]) {
    const revoked = await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'a' } });
    assert.equal(revoked.statusCode, 403, `Current assignment must revoke ${url}.`);
    assert.equal(revoked.headers['cache-control'], 'private, no-store');
  }
  const afterRevocationList = await app.inject({ method: 'GET', url: '/api/reports/exports', headers: { 'x-test-user': 'a' } });
  assert.equal(afterRevocationList.statusCode, 200, afterRevocationList.body);
  assert.ok([exportId, ...selectedExportIds, failedExportId].every((id) => !afterRevocationList.json().some((job: { id: string }) => job.id === id)),
    'Exports whose source slice is no longer accessible are omitted from discovery.');

  // A07–A09: preview the full university scope, detect a concurrent transition,
  // atomically migrate open and closed records, and leave other process types alone.
  const originalWorkflowResponse = await app.inject({ method: 'GET', url: '/api/admin/workflow/university', headers: { 'x-test-user': 'admin' } });
  assert.equal(originalWorkflowResponse.statusCode, 200, originalWorkflowResponse.body);
  const originalWorkflow = originalWorkflowResponse.json();
  const terminalInitialTitle = `A07 invalid initial stage ${randomUUID()}`;
  await pool.query("UPDATE workflow_stages SET terminal=true WHERE kind='university' AND stage_key='contact'");
  try {
    const invalidInitialActivity = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: { kind: 'university', title: terminalInitialTitle, organizationId: orgIds[0] } });
    assert.equal(invalidInitialActivity.statusCode, 409);
    assert.equal(invalidInitialActivity.json().code, 'workflow_initial_stage_terminal');
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM activities WHERE title=$1', [terminalInitialTitle])).rows[0].count, 0);
  } finally {
    await pool.query("UPDATE workflow_stages SET terminal=false WHERE kind='university' AND stage_key='contact'");
  }
  assert.ok(originalWorkflow.stages.some((stage: { key: string }) => stage.key === 'documents'));
  const workflowActivityTitles = [`A07 open ${randomUUID()}`, `A07 closed ${randomUUID()}`, `A09 race ${randomUUID()}`];
  const workflowActivityIds: string[] = [];
  for (const title of workflowActivityTitles) {
    const created = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: { kind: 'university', title, organizationId: orgIds[0] } });
    assert.equal(created.statusCode, 201, created.body);
    workflowActivityIds.push(created.json().id);
    createdActivityIds.push(created.json().id);
    let expectedStageKey = 'contact';
    for (const targetStage of ['meeting', 'documents']) {
      const moved = await app.inject({ method: 'POST', url: `/api/activities/${created.json().id}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage, expectedStageKey, expectedWorkflowRevision: originalWorkflow.revision } });
      assert.equal(moved.statusCode, 200, moved.body);
      expectedStageKey = targetStage;
    }
  }
  const closedWorkflowActivityId = workflowActivityIds[1];
  const privateWorkflowActivityId = randomUUID();
  const privateWorkflowTitle = `A07 private ${randomUUID()}`;
  createdActivityIds.push(privateWorkflowActivityId);
  await pool.query(`INSERT INTO activities(id,kind,title,organization_id,stage_key,owner_sub,owner_name,import_owner_only)
    VALUES($1::uuid,'university',$2,$3::uuid,'documents',$4,$5,true)`, [privateWorkflowActivityId, privateWorkflowTitle, orgIds[0], kamA.sub, kamA.name]);
  await pool.query('UPDATE activities SET closed=true WHERE id=$1::uuid', [closedWorkflowActivityId]);
  const closedHistoryBefore = await pool.query(`SELECT id,event_type AS "eventType",summary,details,actor_sub AS "actorSub",actor_name AS "actorName",created_at AS "createdAt"
    FROM activity_events WHERE activity_id=$1::uuid ORDER BY created_at,id`, [closedWorkflowActivityId]);

  const untouchedCompanyId = randomUUID();
  const untouchedOrganizationId = randomUUID();
  orgIds.push(untouchedOrganizationId);
  createdActivityIds.push(untouchedCompanyId);
  await pool.query('INSERT INTO organizations(id,name,segment) VALUES($1::uuid,$2,\'company\')', [untouchedOrganizationId, `A07 company ${randomUUID()}`]);
  await pool.query(`INSERT INTO activities(id,kind,title,organization_id,stage_key,owner_sub,owner_name)
    VALUES($1::uuid,'corporate',$2,$3::uuid,'qualification',$4,$5)`, [untouchedCompanyId, `A07 untouched ${randomUUID()}`, untouchedOrganizationId, kamA.sub, kamA.name]);

  const removeStage = 'documents';
  const oldIncoming = originalWorkflow.transitions.filter((edge: { to: string }) => edge.to === removeStage).map((edge: { from: string }) => edge.from);
  const oldOutgoing = originalWorkflow.transitions.filter((edge: { from: string }) => edge.from === removeStage).map((edge: { to: string }) => edge.to);
  const newStages = originalWorkflow.stages.filter((stage: { key: string }) => stage.key !== removeStage)
    .map((stage: { key: string; label: string; ordinal: number; terminal: boolean }, index: number) => ({ ...stage, ordinal: index + 1 }));
  const newTransitions = [
    ...originalWorkflow.transitions.filter((edge: { from: string; to: string }) => edge.from !== removeStage && edge.to !== removeStage),
    ...oldIncoming.flatMap((from: string) => oldOutgoing.map((to: string) => ({ from, to }))),
  ];
  const change = {
    expectedRevision: originalWorkflow.revision,
    stages: newStages,
    transitions: newTransitions,
    mappings: { documents: 'meeting' },
  };
  const firstPreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: { 'x-test-user': 'admin' }, payload: change });
  assert.equal(firstPreview.statusCode, 200, firstPreview.body);
  assert.equal(firstPreview.json().canApply, true);
  const fullImpact = firstPreview.json().impactedActivities as { id: string; title: string | null; ownerName: string | null; closed: boolean; changeRequired: boolean }[];
  assert.ok(fullImpact.every((item) => item.title === null && item.ownerName === null), 'Admin-only workflow previews keep opaque migration identifiers and stages, not business names.');
  assert.ok(fullImpact.some((item) => item.id === workflowActivityIds[0] && item.changeRequired && !item.closed));
  assert.ok(fullImpact.some((item) => item.id === closedWorkflowActivityId && item.changeRequired && item.closed), 'Closed university activities are included in the same explicit mapping.');
  assert.ok(fullImpact.every((item) => item.id !== untouchedCompanyId));
  assert.equal((await pool.query('SELECT stage_key FROM activities WHERE id=$1::uuid', [workflowActivityIds[0]])).rows[0].stage_key, 'documents', 'Preview is read-only.');
  const managerPreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: { 'x-test-user': 'admin-manager' }, payload: change });
  assert.equal(managerPreview.statusCode, 200, managerPreview.body);
  assert.equal(managerPreview.json().impactedActivities.find((item: { id: string }) => item.id === workflowActivityIds[0]).title,
    (await pool.query('SELECT title FROM activities WHERE id=$1::uuid', [workflowActivityIds[0]])).rows[0].title,
    'The manager role keeps details when combined with admin.');
  const privateImpact = managerPreview.json().impactedActivities.find((item: { id: string }) => item.id === privateWorkflowActivityId);
  assert.equal(privateImpact.title, null, 'Combined admin and manager roles must not reveal owner-private imported records.');
  assert.equal(privateImpact.ownerName, null);
  assert.equal('ownerSub' in privateImpact, false);
  assert.equal('importOwnerOnly' in privateImpact, false);

  const racedTransition = await app.inject({ method: 'POST', url: `/api/activities/${workflowActivityIds[2]}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage: 'implementation', expectedStageKey: 'documents', expectedWorkflowRevision: originalWorkflow.revision } });
  assert.equal(racedTransition.statusCode, 200, racedTransition.body);
  const staleApply = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: { 'x-test-user': 'admin' }, payload: { ...change, previewToken: firstPreview.json().previewToken } });
  assert.equal(staleApply.statusCode, 409);
  assert.equal(staleApply.json().code, 'workflow_preview_stale');

  try {
    const freshPreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: { 'x-test-user': 'admin' }, payload: change });
    assert.equal(freshPreview.json().canApply, true);
    const applyPayload = { ...change, previewToken: freshPreview.json().previewToken };
    const competingApplies = await Promise.all([
      app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: { 'x-test-user': 'admin' }, payload: applyPayload }),
      app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: { 'x-test-user': 'admin' }, payload: applyPayload }),
    ]);
    assert.equal(competingApplies.filter((response) => response.statusCode === 200).length, 1);
    assert.equal(competingApplies.filter((response) => response.statusCode === 409).length, 1, 'A second writer must report a revision conflict instead of overwriting the first.');
    assert.ok(competingApplies.find((response) => response.statusCode === 200)!.json().changedActivities.every((activity: { title: string | null }) => activity.title === null),
      'Admin-only workflow apply results also keep business names hidden.');
    const conflict = competingApplies.find((response) => response.statusCode === 409)!;
    assert.equal(conflict.json().code, 'workflow_revision_conflict');

    const openAfterMigration = await pool.query('SELECT stage_key AS "stageKey",closed FROM activities WHERE id=$1::uuid', [workflowActivityIds[0]]);
    assert.deepEqual(openAfterMigration.rows[0], { stageKey: 'meeting', closed: false });
    const closedAfterMigration = await pool.query('SELECT stage_key AS "stageKey",closed FROM activities WHERE id=$1::uuid', [closedWorkflowActivityId]);
    assert.deepEqual(closedAfterMigration.rows[0], { stageKey: 'meeting', closed: true });
    const companyAfterMigration = await pool.query('SELECT stage_key AS "stageKey",closed FROM activities WHERE id=$1::uuid', [untouchedCompanyId]);
    assert.deepEqual(companyAfterMigration.rows[0], { stageKey: 'qualification', closed: false });
    const closedHistoryAfter = await pool.query(`SELECT id,event_type AS "eventType",summary,details,actor_sub AS "actorSub",actor_name AS "actorName",created_at AS "createdAt"
      FROM activity_events WHERE activity_id=$1::uuid AND event_type <> 'workflow_stage_migrated' ORDER BY created_at,id`, [closedWorkflowActivityId]);
    assert.deepEqual(closedHistoryAfter.rows, closedHistoryBefore.rows, 'Existing event IDs, old stage labels and outcomes remain untouched.');
    const migrationEvent = await pool.query(`SELECT details FROM activity_events WHERE activity_id=$1::uuid AND event_type='workflow_stage_migrated'`, [closedWorkflowActivityId]);
    assert.equal(migrationEvent.rowCount, 1);
    assert.deepEqual(migrationEvent.rows[0].details, { fromKey: 'documents', fromLabel: 'Документы и согласование', toKey: 'meeting', toLabel: 'Встреча и потребность', workflowRevision: originalWorkflow.revision + 1, closedPreserved: true });

    const migratedActivityDetail = await app.inject({ method: 'GET', url: `/api/activities/${workflowActivityIds[0]}`, headers: { 'x-test-user': 'a' } });
    assert.equal(migratedActivityDetail.json().stageKey, 'meeting');
    assert.equal(migratedActivityDetail.json().workflowRevision, originalWorkflow.revision + 1);
    const eventsBeforeStaleTransition = await pool.query('SELECT count(*)::integer AS count FROM activity_events WHERE activity_id=$1::uuid', [workflowActivityIds[0]]);
    const staleAfterMigration = await app.inject({ method: 'POST', url: `/api/activities/${workflowActivityIds[0]}/transition`, headers: { 'x-test-user': 'a' }, payload: { targetStage: 'implementation', expectedStageKey: 'documents', expectedWorkflowRevision: originalWorkflow.revision } });
    assert.equal(staleAfterMigration.statusCode, 409, staleAfterMigration.body);
    assert.equal(staleAfterMigration.json().code, 'transition_stage_conflict');
    const stateAfterStaleTransition = await pool.query('SELECT stage_key AS "stageKey",closed FROM activities WHERE id=$1::uuid', [workflowActivityIds[0]]);
    assert.deepEqual(stateAfterStaleTransition.rows[0], { stageKey: 'meeting', closed: false }, 'A pre-migration transition cannot act on the replacement stage.');
    const eventsAfterStaleTransition = await pool.query('SELECT count(*)::integer AS count FROM activity_events WHERE activity_id=$1::uuid', [workflowActivityIds[0]]);
    assert.equal(eventsAfterStaleTransition.rows[0].count, eventsBeforeStaleTransition.rows[0].count, 'Rejected stale transitions do not add history.');
  } finally {
    // Restore the shared test database's original route through the same preview/apply contract.
    const currentWorkflowResponse = await app.inject({ method: 'GET', url: '/api/admin/workflow/university', headers: { 'x-test-user': 'admin' } });
    const currentWorkflow = currentWorkflowResponse.json();
    const isOriginal = JSON.stringify(currentWorkflow.stages) === JSON.stringify(originalWorkflow.stages)
      && JSON.stringify(currentWorkflow.transitions) === JSON.stringify(originalWorkflow.transitions);
    if (!isOriginal) {
      const restore = { expectedRevision: currentWorkflow.revision, stages: originalWorkflow.stages, transitions: originalWorkflow.transitions, mappings: {} };
      const restorePreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: { 'x-test-user': 'admin' }, payload: restore });
      assert.equal(restorePreview.statusCode, 200, restorePreview.body);
      assert.equal(restorePreview.json().canApply, true, JSON.stringify(restorePreview.json().blockers));
      const restored = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: { 'x-test-user': 'admin' }, payload: { ...restore, previewToken: restorePreview.json().previewToken } });
      assert.equal(restored.statusCode, 200, restored.body);
    }
  }

  // A report larger than the old 20,000-row ceiling is fully stored, paged, exported, and revoked as one slice.
  const largeReportOrganizationId = randomUUID();
  orgIds.push(largeReportOrganizationId);
  await pool.query(`INSERT INTO organizations(id,name,segment) VALUES($1::uuid,$2,'university')`, [largeReportOrganizationId, `B12 большой отчёт ${randomUUID()}`]);
  const largeFixtureCount = 20_025;
  const insertedLargeFixtures = await pool.query(`INSERT INTO activities(id,kind,title,organization_id,stage_key,owner_sub,owner_name,priority,created_at,updated_at)
    SELECT gen_random_uuid(),'university',$3 || g::text,$1::uuid,'contact',$2,$4,3,now(),now()
    FROM generate_series(1,$5::integer) AS g`, [largeReportOrganizationId, largeReportKam.sub, `B12 строка ${randomUUID()} · `, largeReportKam.name, largeFixtureCount]);
  assert.equal(insertedLargeFixtures.rowCount, largeFixtureCount);
  const largeReportResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'large' }, payload: { reportId: 'crm_portfolio', filters: { kind: 'university', includeClosed: true } } });
  assert.equal(largeReportResponse.statusCode, 201, largeReportResponse.body);
  const largeSnapshot = largeReportResponse.json();
  assert.equal(largeSnapshot.rowCount, largeFixtureCount);
  assert.equal(largeSnapshot.rows.length, largeSnapshot.pageSize);
  const persistedLargePayload = await pool.query('SELECT payload ? \'rows\' AS "hasRows",row_count::integer AS "rowCount" FROM report_jobs WHERE id=$1::uuid', [largeSnapshot.snapshotId]);
  assert.equal(persistedLargePayload.rows[0].hasRows, false, 'The snapshot payload keeps metadata only; pages read their rows from the indexed row table.');
  assert.equal(persistedLargePayload.rows[0].rowCount, largeFixtureCount);
  assert.equal(largeSnapshot.metrics.find((metric: { key: string }) => metric.key === 'activities').value, largeFixtureCount);
  assert.equal(largeSnapshot.chart.series.find((item: { filter?: { kind?: string } }) => item.filter?.kind === 'university').value, largeFixtureCount);
  const storedLargeRows = await pool.query('SELECT count(*)::integer AS count FROM report_snapshot_rows WHERE snapshot_id=$1::uuid', [largeSnapshot.snapshotId]);
  assert.equal(storedLargeRows.rows[0].count, largeFixtureCount, 'The database stores the full as-of slice, not a first-page or capped subset.');
  const largeLastPageNumber = Math.ceil(largeFixtureCount / largeSnapshot.pageSize);
  const largeLastPage = await app.inject({ method: 'GET', url: `/api/reports/snapshots/${largeSnapshot.snapshotId}?page=${largeLastPageNumber}`, headers: { 'x-test-user': 'large' } });
  assert.equal(largeLastPage.statusCode, 200, largeLastPage.body);
  assert.equal(largeLastPage.json().rows.length, largeFixtureCount % largeSnapshot.pageSize || largeSnapshot.pageSize);
  assert.equal(largeLastPage.json().page, largeLastPageNumber);
  const firstLargeTitle = largeSnapshot.rows[0].title;
  const lastLargeTitle = largeLastPage.json().rows.at(-1).title;
  assert.notEqual(firstLargeTitle, lastLargeTitle, 'Pagination reaches the tail of the same deterministic snapshot.');
  const largeExportResponse = await app.inject({ method: 'POST', url: '/api/reports/exports', headers: { 'x-test-user': 'large' }, payload: { snapshotId: largeSnapshot.snapshotId, format: 'csv', columns: ['title'] } });
  assert.equal(largeExportResponse.statusCode, 202, largeExportResponse.body);
  const largeExportId = largeExportResponse.json().id;
  let largeExportStatus: any;
  const largeExportDeadline = Date.now() + 30_000;
  do {
    const status = await app.inject({ method: 'GET', url: `/api/reports/exports/${largeExportId}`, headers: { 'x-test-user': 'large' } });
    assert.equal(status.statusCode, 200, status.body);
    largeExportStatus = status.json();
    if (largeExportStatus.status === 'completed' || largeExportStatus.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < largeExportDeadline);
  assert.equal(largeExportStatus.status, 'completed', largeExportStatus.errorMessage);
  const largeFile = await app.inject({ method: 'GET', url: `/api/reports/exports/${largeExportId}/file`, headers: { 'x-test-user': 'large' } });
  assert.equal(largeFile.statusCode, 200, largeFile.body);
  assert.match(largeFile.headers['content-disposition'] ?? '', /\.csv/);
  assert.match(largeFile.headers['content-type'] ?? '', /text\/csv; charset=utf-8/);
  const largeCsv = largeFile.rawPayload.toString('utf8').replace(/^\uFEFF/, '');
  const largeExportRows = largeCsv.split('\r\n');
  assert.equal(largeExportRows.length - 2, largeFixtureCount, 'The CSV contains every stored source row, independent of the current UI page.');
  assert.equal(largeExportRows[0], 'Активность');
  assert.equal(largeExportRows[1], firstLargeTitle);
  assert.equal(largeExportRows.at(-2), lastLargeTitle);

  // An old snapshot may already be marked expired while a migrated/live export still owns it.
  await pool.query("UPDATE report_jobs SET status='expired',expires_at=now()-interval '1 minute',payload='{}'::jsonb WHERE id=$1::uuid", [largeSnapshot.snapshotId]);
  await purgeExpiredReportJobs({ remove: async () => {}, cleanupTemps: async () => 0 });
  const retainedRows = await pool.query('SELECT count(*)::integer AS count FROM report_snapshot_rows WHERE snapshot_id=$1::uuid', [largeSnapshot.snapshotId]);
  assert.equal(retainedRows.rows[0].count, largeFixtureCount, 'A live export pins legacy snapshot rows through cleanup.');
  const retainedFile = await app.inject({ method: 'GET', url: `/api/reports/exports/${largeExportId}/file`, headers: { 'x-test-user': 'large' } });
  assert.equal(retainedFile.statusCode, 200, retainedFile.body);

  const removedRow = await pool.query(`DELETE FROM report_snapshot_rows WHERE snapshot_id=$1::uuid AND row_number=1
    RETURNING row_number AS "rowNumber",activity_id AS "activityId",row_data AS "rowData"`, [largeSnapshot.snapshotId]);
  assert.equal(removedRow.rowCount, 1);
  const incompleteFile = await app.inject({ method: 'GET', url: `/api/reports/exports/${largeExportId}/file`, headers: { 'x-test-user': 'large' } });
  assert.equal(incompleteFile.statusCode, 403, 'An export fails closed if its source row count no longer matches the snapshot.');
  await pool.query('INSERT INTO report_snapshot_rows(snapshot_id,row_number,activity_id,row_data) VALUES($1::uuid,$2,$3::uuid,$4::jsonb)', [largeSnapshot.snapshotId, removedRow.rows[0].rowNumber, removedRow.rows[0].activityId, JSON.stringify(removedRow.rows[0].rowData)]);

  await pool.query(`UPDATE activities SET owner_sub=$2,owner_name=$3 WHERE id=(SELECT id FROM activities WHERE owner_sub=$1 ORDER BY title ASC LIMIT 1)`, [largeReportKam.sub, kamB.sub, kamB.name]);
  for (const url of [`/api/reports/exports/${largeExportId}`, `/api/reports/exports/${largeExportId}/file`]) {
    const revoked = await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'large' } });
    assert.equal(revoked.statusCode, 403, `Current scope recheck must revoke a large report and its export: ${url}`);
    assert.equal(revoked.headers['cache-control'], 'private, no-store');
  }
});

test('M05–M08 reassignment moves one activity and its open tasks while revoking the former KAM scope', { skip: !runIntegration }, async (context) => {
  await pool.query('SELECT 1 FROM activity_reassignment_previews LIMIT 1');
  const repo = new PostgresRepository();
  let lmsDispatches = 0;
  const exchanges = new PostgresExchangeService(repo, { cmsUrl: 'http://127.0.0.1', lmsUrl: 'http://127.0.0.1', fetcher: (async (_input, init) => {
    lmsDispatches += 1;
    const request = JSON.parse(String(init?.body)) as { correlationId: string };
    return new Response(JSON.stringify({ status: 'accepted', correlationId: request.correlationId }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  const app = buildApp({ repository: repo, exchanges, authenticate });
  await app.ready();
  const marker = `M05-M08-${randomUUID()}`;
  const activityIds: string[] = [];
  const personIds: string[] = [];
  const documentKeys: string[] = [];
  const exchangeJobIds: string[] = [];
  const overlayRevokedKamSub = `a10-revoked-kam-${randomUUID()}`;
  const reportActorSubs = [kamA.sub, kamB.sub];
  await pool.query(`INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source)
    VALUES($1,$2,TRUE,'local-keycloak-provisioning'),($3,$4,TRUE,'public-demo-provisioning')
    ON CONFLICT(user_sub) DO UPDATE SET display_name=EXCLUDED.display_name,enabled=TRUE,provision_source=EXCLUDED.provision_source`,
  [kamA.sub, kamA.name, kamB.sub, kamB.name]);
  await pool.query(`INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source)
    VALUES($1,'A10 revoked but Keycloak-enabled KAM',TRUE,'local-keycloak-provisioning')`, [overlayRevokedKamSub]);
  const staleReports = await pool.query('SELECT file_key AS "fileKey" FROM report_jobs WHERE actor_sub=ANY($1::text[]) AND file_key IS NOT NULL', [reportActorSubs]);
  await Promise.all((staleReports.rows as { fileKey: string }[]).map((file) => removePrivateReport(file.fileKey)));
  await pool.query('DELETE FROM report_jobs WHERE actor_sub=ANY($1::text[])', [reportActorSubs]);
  context.after(async () => {
    await app.close();
    const reportFiles = await pool.query('SELECT file_key AS "fileKey" FROM report_jobs WHERE actor_sub=ANY($1::text[]) AND file_key IS NOT NULL', [reportActorSubs]);
    await Promise.all((reportFiles.rows as { fileKey: string }[]).map((file) => removePrivateReport(file.fileKey)));
    await pool.query('DELETE FROM report_jobs WHERE actor_sub=ANY($1::text[])', [reportActorSubs]);
    if (exchangeJobIds.length) await pool.query('DELETE FROM exchange_jobs WHERE id=ANY($1::uuid[])', [exchangeJobIds]);
    await pool.query('DELETE FROM activity_reassignment_previews WHERE target_owner_sub=$1', [overlayRevokedKamSub]);
    if (documentKeys.length) await Promise.all(documentKeys.map((key) => removePrivateDocument(key)));
    if (activityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    if (personIds.length) await pool.query('DELETE FROM people WHERE id=ANY($1::uuid[])', [personIds]);
    await pool.query('DELETE FROM known_crm_users WHERE user_sub=$1', [overlayRevokedKamSub]);
    await pool.query('DELETE FROM kam_directory WHERE user_sub=$1', [overlayRevokedKamSub]);
    await pool.query('DELETE FROM kam_directory WHERE user_sub=ANY($1::text[])', [reportActorSubs]);
  });

  const primaryResponse = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'individual', title: `${marker} — перераспределяемая активность`, personName: `${marker} слушатель`,
  } });
  assert.equal(primaryResponse.statusCode, 201, primaryResponse.body);
  const primary = primaryResponse.json(); activityIds.push(primary.id);
  const primaryDetails = await app.inject({ method: 'GET', url: `/api/activities/${primary.id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(primaryDetails.statusCode, 200);
  personIds.push(primaryDetails.json().personId);
  assert.equal(primaryDetails.json().assignmentRevision, 0);
  const otherResponse = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'individual', title: `${marker} — другая активность`, personName: `${marker} другой слушатель`,
  } });
  assert.equal(otherResponse.statusCode, 201, otherResponse.body);
  const other = otherResponse.json(); activityIds.push(other.id);
  const otherDetails = await app.inject({ method: 'GET', url: `/api/activities/${other.id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(otherDetails.statusCode, 200);
  personIds.push(otherDetails.json().personId);
  const otherBefore = (await pool.query('SELECT owner_sub,owner_name,stage_key,assignment_revision,created_at FROM activities WHERE id=$1', [other.id])).rows[0];

  const outcomeResponse = await app.inject({ method: 'POST', url: `/api/activities/${primary.id}/outcomes`, headers: { 'x-test-user': 'a' }, payload: { outcome: 'awaiting_reply', note: 'Согласовали повторный контакт после передачи.' } });
  assert.equal(outcomeResponse.statusCode, 201, outcomeResponse.body);
  const completedDueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const openDueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const completedTaskResponse = await app.inject({ method: 'POST', url: `/api/activities/${primary.id}/tasks`, headers: { 'x-test-user': 'a' }, payload: { title: `${marker} завершённая задача`, dueAt: completedDueAt } });
  assert.equal(completedTaskResponse.statusCode, 201, completedTaskResponse.body);
  const completedTask = completedTaskResponse.json();
  assert.equal((await app.inject({ method: 'POST', url: `/api/activities/${primary.id}/tasks/${completedTask.id}/complete`, headers: { 'x-test-user': 'a' } })).statusCode, 200);
  const openTaskResponse = await app.inject({ method: 'POST', url: `/api/activities/${primary.id}/tasks`, headers: { 'x-test-user': 'a' }, payload: { title: `${marker} открытая задача`, dueAt: openDueAt } });
  assert.equal(openTaskResponse.statusCode, 201, openTaskResponse.body);
  const openTask = openTaskResponse.json();
  const taskRowsBefore = await pool.query(`SELECT id,title,due_at,status,owner_sub,owner_name,created_at,completed_at
    FROM tasks WHERE activity_id=$1 ORDER BY id`, [primary.id]);
  const stageAndDatesBefore = (await pool.query('SELECT stage_key,awaiting_reply,closed,created_at FROM activities WHERE id=$1', [primary.id])).rows[0];

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const upload = await app.inject({ method: 'POST', url: `/api/activities/${primary.id}/documents?filename=${marker}.png`, headers: { 'x-test-user': 'a', 'content-type': 'application/octet-stream' }, payload: png });
  assert.equal(upload.statusCode, 201, upload.body);
  const document = upload.json(); documentKeys.push(document.id);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${primary.id}/documents/${document.id}`, headers: { 'x-test-user': 'a' } })).statusCode, 200);
  const historyBefore = await app.inject({ method: 'GET', url: `/api/activities/${primary.id}/history`, headers: { 'x-test-user': 'a' } });
  assert.equal(historyBefore.statusCode, 200);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const oldSnapshotResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'a' }, payload: { reportId: 'crm_portfolio', filters: { from: today, to: today, kind: 'individual' } } });
  assert.equal(oldSnapshotResponse.statusCode, 201, oldSnapshotResponse.body);
  const oldSnapshot = oldSnapshotResponse.json();

  const directoryResponse = await app.inject({ method: 'GET', url: '/api/manager/kams', headers: { 'x-test-user': 'manager' } });
  assert.equal(directoryResponse.statusCode, 200, directoryResponse.body);
  const directorySubs = directoryResponse.json().map((kam: { sub: string }) => kam.sub);
  assert.ok(directorySubs.includes(kamA.sub) && directorySubs.includes(kamB.sub), 'The assignable directory includes both test KAMs; the shared local directory may contain other provisioned KAMs.');
  assert.ok(directorySubs.includes(overlayRevokedKamSub), 'A Keycloak-enabled KAM with no explicit CRM policy is assignable.');
  assert.equal(new Set(directorySubs).size, directorySubs.length, 'The assignable directory contains no duplicate users.');
  assert.equal((await app.inject({ method: 'GET', url: '/api/manager/kams', headers: { 'x-test-user': 'admin' } })).statusCode, 403, 'Technical admin alone cannot reassign activities.');
  assert.equal((await app.inject({ method: 'GET', url: '/api/manager/kams', headers: { 'x-test-user': 'a' } })).statusCode, 403, 'A KAM cannot read the reassignment target list.');
  assert.equal((await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/preview`, headers: { 'x-test-user': 'admin' }, payload: { targetKamSub: kamB.sub, expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0 } })).statusCode, 403, 'Technical admin alone cannot preview an assignment change.');
  const arbitraryTarget = await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: { targetKamSub: 'attacker-controlled-sub', expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0 } });
  assert.equal(arbitraryTarget.statusCode, 400, 'A client cannot invent a target identity.');
  const overlayPreview = await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: { targetKamSub: overlayRevokedKamSub, expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0 } });
  assert.equal(overlayPreview.statusCode, 200, overlayPreview.body);
  const policyWriter = await pool.connect();
  let revokedTargetConfirmPromise: Promise<any> | undefined;
  try {
    await policyWriter.query('BEGIN');
    await policyWriter.query("SELECT pg_advisory_xact_lock(hashtext('crm-access-policy'))");
    await policyWriter.query(`INSERT INTO known_crm_users(user_sub,display_name,realm_roles,provision_source,disabled_at,disabled_by_sub,disabled_reason)
      VALUES($1,'A10 revoked but Keycloak-enabled KAM',ARRAY['kam']::text[],'integration-test',now(),$2,'integration test revocation')`, [overlayRevokedKamSub, manager.sub]);
    revokedTargetConfirmPromise = app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/confirm`, headers: { 'x-test-user': 'manager' }, payload: { previewToken: overlayPreview.json().previewToken } });
    let confirmWaiting = false;
    const waitDeadline = Date.now() + 3000;
    while (!confirmWaiting && Date.now() < waitDeadline) {
      const waiting = await pool.query(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%pg_advisory_xact_lock_shared%'
      ) AS waiting`);
      confirmWaiting = waiting.rows[0]?.waiting === true;
      if (!confirmWaiting) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(confirmWaiting, true, 'Confirmation waits while an absent target policy row is materialized and revoked.');
  } finally {
    await policyWriter.query('COMMIT');
    policyWriter.release();
  }
  assert.ok(revokedTargetConfirmPromise);
  const directoryAfterRevocation = await app.inject({ method: 'GET', url: '/api/manager/kams', headers: { 'x-test-user': 'manager' } });
  assert.ok(!directoryAfterRevocation.json().some((kam: { sub: string }) => kam.sub === overlayRevokedKamSub), 'An explicitly revoked CRM user is omitted while its Keycloak provision remains enabled.');
  const revokedTargetPreview = await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: { targetKamSub: overlayRevokedKamSub, expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0 } });
  assert.equal(revokedTargetPreview.statusCode, 400);
  assert.equal(revokedTargetPreview.json().code, 'invalid_target_kam');
  const revokedTargetConfirm = await revokedTargetConfirmPromise!;
  assert.equal(revokedTargetConfirm.statusCode, 409);
  assert.equal(revokedTargetConfirm.json().code, 'target_kam_unavailable');
  assert.equal((await pool.query('SELECT enabled FROM kam_directory WHERE user_sub=$1', [overlayRevokedKamSub])).rows[0].enabled, true,
    'CRM revocation does not overwrite Keycloak provisioning state.');
  const forgedName = await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: { targetKamSub: kamB.sub, targetKamName: 'Spoofed name', expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0 } });
  assert.equal(forgedName.statusCode, 200, forgedName.body);
  assert.equal(forgedName.json().targetOwner.name, kamB.name, 'Any client-supplied display name is ignored in favor of the provisioned directory.');

  const previewBody = { targetKamSub: kamB.sub, expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0 };
  const previewA = await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: previewBody });
  const previewB = await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: previewBody });
  assert.equal(previewA.statusCode, 200, previewA.body);
  assert.equal(previewB.statusCode, 200, previewB.body);
  const crossManagerConfirmation = await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/confirm`, headers: { 'x-test-user': 'manager-other' }, payload: { previewToken: previewA.json().previewToken } });
  assert.equal(crossManagerConfirmation.statusCode, 409, 'A preview token is bound to the manager who created it.');
  assert.equal(previewA.json().impact.taskCount, 2);
  assert.equal(previewA.json().impact.openTaskCount, 1);
  assert.equal(previewA.json().impact.openTasksWillTransfer, true);
  assert.equal(previewA.json().impact.completedTaskAttributionWillRemain, true);
  assert.equal(previewA.json().impact.createdAt, stageAndDatesBefore.created_at.toISOString());
  const confirms = await Promise.all([previewA.json(), previewB.json()].map((preview) => app.inject({
    method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/confirm`, headers: { 'x-test-user': 'manager' }, payload: { previewToken: preview.previewToken },
  })));
  assert.deepEqual(confirms.map((response) => response.statusCode).sort(), [200, 409], 'Concurrent confirmations serialize; only one can consume a current preview.');
  const confirmed = confirms.find((response) => response.statusCode === 200)!;
  const consumedPreview = confirms[0].statusCode === 200 ? previewA.json().previewToken : previewB.json().previewToken;
  assert.equal(confirmed.json().owner.sub, kamB.sub);
  assert.equal(confirmed.json().openTasksReassigned, 1);
  assert.equal(confirmed.json().completedTasksPreserved, 1);
  const replayedConfirmation = await app.inject({ method: 'POST', url: `/api/manager/activities/${primary.id}/reassignment/confirm`, headers: { 'x-test-user': 'manager' }, payload: { previewToken: consumedPreview } });
  assert.equal(replayedConfirmation.statusCode, 409, 'A consumed preview token cannot be replayed.');

  const oldRead = await app.inject({ method: 'GET', url: `/api/activities/${primary.id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(oldRead.statusCode, 404, 'The former KAM loses card access immediately.');
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${primary.id}/history`, headers: { 'x-test-user': 'a' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${primary.id}/documents/${document.id}`, headers: { 'x-test-user': 'a' } })).statusCode, 404, 'The former KAM cannot download the activity file.');
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/snapshots/${oldSnapshot.snapshotId}`, headers: { 'x-test-user': 'a' } })).statusCode, 403, 'A saved report is rechecked against current ownership.');

  const newRead = await app.inject({ method: 'GET', url: `/api/activities/${primary.id}`, headers: { 'x-test-user': 'b' } });
  assert.equal(newRead.statusCode, 200, newRead.body);
  assert.equal(newRead.json().ownerSub, kamB.sub);
  assert.equal(newRead.json().assignmentRevision, 1);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${primary.id}/documents/${document.id}`, headers: { 'x-test-user': 'b' } })).statusCode, 200, 'The new KAM can download the activity file.');
  const newTaskRows = await pool.query(`SELECT id,title,due_at,status,owner_sub,owner_name,created_at,completed_at
    FROM tasks WHERE activity_id=$1 ORDER BY id`, [primary.id]);
  const beforeById = new Map((taskRowsBefore.rows as any[]).map((task) => [task.id, task]));
  for (const current of newTaskRows.rows as any[]) {
    const original = beforeById.get(current.id)!;
    assert.equal(current.title, original.title);
    assert.equal(current.due_at.toISOString(), original.due_at.toISOString());
    assert.equal(current.status, original.status);
    assert.equal(current.created_at.toISOString(), original.created_at.toISOString());
    if (current.status === 'open') {
      assert.equal(current.owner_sub, kamB.sub);
      assert.equal(current.owner_name, kamB.name);
      assert.equal(current.completed_at, null);
    } else {
      assert.equal(current.owner_sub, kamA.sub, 'Completed task attribution stays with the original KAM.');
      assert.equal(current.owner_name, kamA.name);
    }
  }
  assert.ok(newTaskRows.rows.some((task: any) => task.id === openTask.id));
  assert.ok(newTaskRows.rows.some((task: any) => task.id === completedTask.id));
  const stageAndDatesAfter = (await pool.query('SELECT stage_key,awaiting_reply,closed,created_at FROM activities WHERE id=$1', [primary.id])).rows[0];
  assert.deepEqual(stageAndDatesAfter, stageAndDatesBefore, 'Stage, outcome, closed state, and activity creation date survive reassignment.');
  const allEvents = await app.inject({ method: 'GET', url: `/api/activities/${primary.id}/history`, headers: { 'x-test-user': 'b' } });
  assert.equal(allEvents.statusCode, 200, allEvents.body);
  assert.ok(historyBefore.json().every((event: any) => allEvents.json().some((current: any) => current.id === event.id)), 'Every pre-transfer history event remains available to the new KAM.');
  assert.equal(allEvents.json().filter((event: any) => event.eventType === 'owner_reassigned').length, 1, 'Exactly one assignment audit event is appended.');
  const audit = allEvents.json().find((event: any) => event.eventType === 'owner_reassigned');
  assert.equal(audit.actorName, manager.name);
  assert.equal(audit.details.previousOwnerSub, kamA.sub);
  assert.equal(audit.details.ownerSub, kamB.sub);
  assert.equal(audit.details.openTasksReassigned, 1);
  assert.equal(audit.details.completedTasksPreserved, 1);
  assert.ok(allEvents.json().some((event: any) => event.eventType === 'outcome_recorded'));

  const otherAfter = (await pool.query('SELECT owner_sub,owner_name,stage_key,assignment_revision,created_at FROM activities WHERE id=$1', [other.id])).rows[0];
  assert.deepEqual(otherAfter, otherBefore, 'The separate activity is unchanged.');
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${other.id}`, headers: { 'x-test-user': 'b' } })).statusCode, 404);

  const oldFreshReport = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'a' }, payload: { reportId: 'crm_portfolio', filters: { from: today, to: today, kind: 'individual' } } });
  assert.equal(oldFreshReport.statusCode, 201, oldFreshReport.body);
  const oldFreshReportRows = await pool.query('SELECT count(*)::integer AS count FROM report_snapshot_rows WHERE snapshot_id=$1::uuid AND activity_id=$2::uuid', [oldFreshReport.json().snapshotId, primary.id]);
  assert.equal(oldFreshReportRows.rows[0].count, 0, 'Fresh reports for the former KAM exclude the transferred activity.');
  const newSnapshotResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'b' }, payload: { reportId: 'crm_portfolio', filters: { from: today, to: today, kind: 'individual' } } });
  assert.equal(newSnapshotResponse.statusCode, 201, newSnapshotResponse.body);
  const newSnapshot = newSnapshotResponse.json();
  const newSnapshotRows = await pool.query('SELECT count(*)::integer AS count FROM report_snapshot_rows WHERE snapshot_id=$1::uuid AND activity_id=$2::uuid', [newSnapshot.snapshotId, primary.id]);
  assert.equal(newSnapshotRows.rows[0].count, 1, 'The new KAM can include the activity in a fresh report.');

  const disabledTargetPreview = await app.inject({ method: 'POST', url: `/api/manager/activities/${other.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: {
    targetKamSub: kamB.sub, expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0,
  } });
  assert.equal(disabledTargetPreview.statusCode, 200, disabledTargetPreview.body);
  await pool.query('UPDATE kam_directory SET enabled=FALSE WHERE user_sub=$1', [kamB.sub]);
  try {
    const disabledTargetConfirm = await app.inject({ method: 'POST', url: `/api/manager/activities/${other.id}/reassignment/confirm`, headers: { 'x-test-user': 'manager' }, payload: { previewToken: disabledTargetPreview.json().previewToken } });
    assert.equal(disabledTargetConfirm.statusCode, 409, disabledTargetConfirm.body);
    assert.equal(disabledTargetConfirm.json().code, 'target_kam_unavailable', 'A KAM disabled after preview cannot receive the activity.');
  } finally { await pool.query('UPDATE kam_directory SET enabled=TRUE WHERE user_sub=$1', [kamB.sub]); }

  const expiredPreview = await app.inject({ method: 'POST', url: `/api/manager/activities/${other.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: {
    targetKamSub: kamB.sub, expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0,
  } });
  assert.equal(expiredPreview.statusCode, 200, expiredPreview.body);
  await pool.query('UPDATE activity_reassignment_previews SET expires_at=now()-interval \'1 second\' WHERE id=$1', [expiredPreview.json().previewToken]);
  const expiredConfirm = await app.inject({ method: 'POST', url: `/api/manager/activities/${other.id}/reassignment/confirm`, headers: { 'x-test-user': 'manager' }, payload: { previewToken: expiredPreview.json().previewToken } });
  assert.equal(expiredConfirm.statusCode, 409, expiredConfirm.body);

  const lmsRaceActivity = await createAuditedExternalActivityFixture(kamA, {
    title: `${marker} — гонка переназначения и отправки в LMS`, personName: `${marker} слушатель LMS`,
    source: 'M05–M08 controlled race', reference: `M05-${randomUUID()}`,
  });
  activityIds.push(lmsRaceActivity.id);
  personIds.push(lmsRaceActivity.personId);
  const lmsRacePreview = await app.inject({ method: 'POST', url: `/api/manager/activities/${lmsRaceActivity.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: {
    targetKamSub: kamB.sub, expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0,
  } });
  assert.equal(lmsRacePreview.statusCode, 200, lmsRacePreview.body);
  const lmsRaceJobId = randomUUID(); const lmsRaceCorrelationId = randomUUID();
  await pool.query(`INSERT INTO exchange_jobs(id,direction,system,operation,activity_id,actor_sub,scope_key,correlation_id,idempotency_key,status,payload)
    VALUES($1,'crm_to_lms','lms','prepare_access',$2,$3,$7,$4,$5,'queued',$6::jsonb)`, [
    lmsRaceJobId, lmsRaceActivity.id, kamA.sub, lmsRaceCorrelationId, `race-${randomUUID()}`,
    JSON.stringify({ activityReference: lmsRaceActivity.id, requestedAction: 'prepare_access' }), lmsRaceActivity.id,
  ]);
  exchangeJobIds.push(lmsRaceJobId);
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [lmsRaceActivity.id]);
    const transfer = app.inject({ method: 'POST', url: `/api/manager/activities/${lmsRaceActivity.id}/reassignment/confirm`, headers: { 'x-test-user': 'manager' }, payload: { previewToken: lmsRacePreview.json().previewToken } });
    const waitFor = async (sqlText: string, values: unknown[] = []) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query(sqlText, values);
        if (Number(result.rows[0]?.count ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const state = await pool.query(`SELECT pid,wait_event_type,wait_event,left(query,500) AS query FROM pg_stat_activity WHERE datname=current_database() AND state='active'`);
      throw new Error(`Timed out waiting for a controlled PostgreSQL lock state: ${JSON.stringify(state.rows)}`);
    };
    await waitFor(`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%FOR UPDATE OF a%'`);
    const oldOwnerDispatch = app.inject({ method: 'POST', url: `/api/exchanges/${lmsRaceJobId}/retry`, headers: { 'x-test-user': 'a' } });
    await waitFor(`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%a.kind,a.closed,a.stage_key%' AND query ILIKE '%FOR UPDATE OF a%'`);
    await blocker.query('COMMIT');
    const [transferResult, dispatchResult] = await Promise.all([transfer, oldOwnerDispatch]);
    assert.equal(transferResult.statusCode, 200, transferResult.body);
    assert.equal(dispatchResult.statusCode, 404, 'An old KAM request queued before reassignment is denied by the final locked owner check.');
    assert.equal(lmsDispatches, 0, 'No request reaches LMS after ownership changes before the claim commits.');
  } catch (error) {
    await blocker.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { blocker.release(); }
  const lmsRaceOwner = await pool.query('SELECT owner_sub,assignment_revision FROM activities WHERE id=$1', [lmsRaceActivity.id]);
  assert.equal(lmsRaceOwner.rows[0].owner_sub, kamB.sub);
  assert.equal(lmsRaceOwner.rows[0].assignment_revision, 1);

  const raceActivityResponse = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'individual', title: `${marker} — гонка переноса и завершения`, personName: `${marker} гонка`,
  } });
  assert.equal(raceActivityResponse.statusCode, 201, raceActivityResponse.body);
  const raceActivity = raceActivityResponse.json(); activityIds.push(raceActivity.id);
  const raceDetails = await app.inject({ method: 'GET', url: `/api/activities/${raceActivity.id}`, headers: { 'x-test-user': 'a' } });
  assert.equal(raceDetails.statusCode, 200);
  personIds.push(raceDetails.json().personId);
  const raceTaskResponse = await app.inject({ method: 'POST', url: `/api/activities/${raceActivity.id}/tasks`, headers: { 'x-test-user': 'a' }, payload: {
    title: `${marker} completion race task`, dueAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
  } });
  assert.equal(raceTaskResponse.statusCode, 201, raceTaskResponse.body);
  const raceTask = raceTaskResponse.json();
  const racePreviewResponse = await app.inject({ method: 'POST', url: `/api/manager/activities/${raceActivity.id}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: {
    targetKamSub: kamB.sub, expectedOwnerSub: kamA.sub, expectedAssignmentRevision: 0,
  } });
  assert.equal(racePreviewResponse.statusCode, 200, racePreviewResponse.body);
  const [raceConfirm, raceComplete] = await Promise.all([
    app.inject({ method: 'POST', url: `/api/manager/activities/${raceActivity.id}/reassignment/confirm`, headers: { 'x-test-user': 'manager' }, payload: { previewToken: racePreviewResponse.json().previewToken } }),
    app.inject({ method: 'POST', url: `/api/activities/${raceActivity.id}/tasks/${raceTask.id}/complete`, headers: { 'x-test-user': 'a' } }),
  ]);
  const raceActivityRow = (await pool.query('SELECT owner_sub,assignment_revision FROM activities WHERE id=$1', [raceActivity.id])).rows[0];
  const raceTaskRow = (await pool.query('SELECT title,due_at,status,owner_sub,owner_name,completed_at FROM tasks WHERE id=$1', [raceTask.id])).rows[0];
  if (raceConfirm.statusCode === 200) {
    assert.equal(raceComplete.statusCode, 404, 'After a committed transfer, the old KAM cannot complete the now-out-of-scope task.');
    assert.equal(raceActivityRow.owner_sub, kamB.sub);
    assert.equal(raceActivityRow.assignment_revision, 1);
    assert.equal(raceTaskRow.status, 'open');
    assert.equal(raceTaskRow.owner_sub, kamB.sub);
    assert.equal(raceTaskRow.owner_name, kamB.name);
    assert.equal(raceTaskRow.completed_at, null);
  } else {
    assert.equal(raceConfirm.statusCode, 409, raceConfirm.body);
    assert.equal(raceComplete.statusCode, 200, raceComplete.body);
    assert.equal(raceActivityRow.owner_sub, kamA.sub);
    assert.equal(raceActivityRow.assignment_revision, 0);
    assert.equal(raceTaskRow.status, 'done');
    assert.equal(raceTaskRow.owner_sub, kamA.sub);
    assert.equal(raceTaskRow.owner_name, kamA.name);
    assert.ok(raceTaskRow.completed_at);
  }
  assert.equal(raceTaskRow.title, `${marker} completion race task`);
  assert.equal(raceTaskRow.due_at.toISOString(), raceTask.dueAt);

  const protectedPersonId = randomUUID(); const protectedActivityId = randomUUID();
  await pool.query('INSERT INTO people(id,full_name,import_owner_sub) VALUES($1,$2,$3)', [protectedPersonId, `${marker} imported person`, manager.sub]);
  await pool.query(`INSERT INTO activities(id,kind,title,person_id,stage_key,owner_sub,owner_name,import_owner_only)
    VALUES($1,'individual',$2,$3,'request',$4,$5,TRUE)`, [protectedActivityId, `${marker} protected import`, protectedPersonId, manager.sub, manager.name]);
  activityIds.push(protectedActivityId); personIds.push(protectedPersonId);
  const protectedPreview = await app.inject({ method: 'POST', url: `/api/manager/activities/${protectedActivityId}/reassignment/preview`, headers: { 'x-test-user': 'manager' }, payload: { targetKamSub: kamB.sub, expectedOwnerSub: manager.sub, expectedAssignmentRevision: 0 } });
  assert.equal(protectedPreview.statusCode, 200, protectedPreview.body);
  assert.equal(protectedPreview.json().canConfirm, false);
  assert.equal(protectedPreview.json().previewToken, null);
  assert.equal(protectedPreview.json().blockers[0].code, 'import_owner_only');
  const protectedOwner = await pool.query('SELECT owner_sub FROM activities WHERE id=$1', [protectedActivityId]);
  assert.equal(protectedOwner.rows[0].owner_sub, manager.sub, 'A personal imported identity remains with its importing owner.');
});

test('contact import external-key updates reject a revoked individual-kind scope without changing PII', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const actor: Actor = { sub: `astra-p1-import-${suffix}`, name: 'Astra P1 import owner', roles: ['kam'] };
  const restrictedActor: Actor = { ...actor, allowedKinds: ['corporate'] };
  const imports = new PostgresImportService();
  const source = `Astra P1 contact source ${suffix}`;
  const externalKey = `astra-contact-${suffix}`;
  const activityId = randomUUID();
  const jobIds: string[] = [];
  const makeWorkbook = (fullName: string, email: string, phone: string) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['External ID', 'Full Name', 'Email', 'Phone'],
      [externalKey, fullName, email, phone],
    ]), 'Contacts');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };
  const mapping = { '0': 'externalKey', '1': 'fullName', '2': 'email', '3': 'phone' };
  const preview = async (job: { id: string; revision: number }) => imports.preview(actor, job.id, {
    revision: job.revision, selectedSheet: 'Contacts', headerRow: 1, mapping,
  });
  context.after(async () => {
    if (jobIds.length) {
      await pool.query('DELETE FROM import_provenance WHERE job_id=ANY($1::uuid[])', [jobIds]);
      await pool.query('DELETE FROM import_jobs WHERE id=ANY($1::uuid[])', [jobIds]);
    }
    await pool.query('DELETE FROM import_identities WHERE owner_sub=$1 AND source_system=$2', [actor.sub, source]);
    await pool.query('DELETE FROM activities WHERE id=$1', [activityId]);
    await pool.query('DELETE FROM people WHERE import_owner_sub=$1 AND import_source=$2', [actor.sub, source]);
  });

  const initialJob = await imports.upload(actor, 'contact.xlsx', 'contacts', source,
    makeWorkbook('Исходное имя', `astra.${suffix}@example.test`, `+7 900 ${suffix.slice(0, 6)}`));
  jobIds.push(initialJob.id);
  const initialPreview = await preview(initialJob);
  assert.equal((initialPreview.preview as { status: string }[])[0].status, 'valid');
  await imports.confirm(actor, initialJob.id, {
    revision: initialPreview.revision as number, idempotencyKey: `astra-initial-${suffix}`, rowNumbers: [2], reviewedRows: [],
  });
  const original = (await pool.query(`SELECT p.id,p.full_name,p.email,p.phone,p.import_payload_hash
    FROM people p WHERE p.import_owner_sub=$1 AND p.import_source=$2`, [actor.sub, source])).rows[0];
  assert.ok(original, 'The initial external-key import creates its contact.');
  await pool.query(`INSERT INTO activities(id,kind,title,person_id,stage_key,owner_sub,owner_name,import_owner_only)
    VALUES($1,'individual',$2,$3,'lms_handoff',$4,$5,TRUE)`, [activityId, `Astra P1 private application ${suffix}`, original.id, actor.sub, actor.name]);

  const updateJob = await imports.upload(actor, 'contact-update.xlsx', 'contacts', source,
    makeWorkbook('Изменённое имя', `changed.${suffix}@example.test`, '+7 901 123 45 67'));
  jobIds.push(updateJob.id);
  const updatePreview = await preview(updateJob);
  assert.equal((updatePreview.preview as { status: string }[])[0].status, 'changed_requires_review');

  const hiddenPreview = await imports.get(restrictedActor, updateJob.id);
  assert.equal((hiddenPreview.preview as { status: string }[])[0].status, 'blocked',
    'A saved external-identity preview is redacted after its individual-kind scope is revoked.');
  await assert.rejects(imports.confirm(restrictedActor, updateJob.id, {
    revision: updatePreview.revision as number, idempotencyKey: `astra-revoked-${suffix}`, rowNumbers: [2], reviewedRows: [2],
  }), (error: unknown) => error instanceof DomainError && error.statusCode === 409 && error.code === 'import_contact_scope_conflict',
  'A stale external-key contact update fails with 409 after its linked individual process leaves the actor scope.');

  const after = (await pool.query('SELECT full_name,email,phone,import_payload_hash FROM people WHERE id=$1', [original.id])).rows[0];
  assert.deepEqual(after, {
    full_name: original.full_name,
    email: original.email,
    phone: original.phone,
    import_payload_hash: original.import_payload_hash,
  }, 'A revoked contact update preserves every PII field and the source hash.');
});

test('PostgreSQL activity creation requires scoped visibility of linked contacts and compares organization UUIDs case-insensitively', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const actor: Actor = { ...kamA, sub: `b13-scope-kam-${suffix}`, allowedKinds: ['corporate'] };
  const repo = new PostgresRepository();
  const organizationId = randomUUID();
  const payerOrganizationId = randomUUID();
  const hiddenLinkedPersonId = randomUUID();
  const hiddenActivityId = randomUUID();
  const visibleActivityId = randomUUID();
  const standalonePersonId = randomUUID();
  const activityIds: string[] = [hiddenActivityId, visibleActivityId];
  const personIds = [hiddenLinkedPersonId, standalonePersonId];
  const organizationIds = [organizationId, payerOrganizationId];
  await pool.query(`INSERT INTO organizations(id,name,segment) VALUES
    ($1,$2,'company'),($3,$4,'company')`, [organizationId, `B13 organization ${suffix}`, payerOrganizationId, `B13 payer ${suffix}`]);
  await pool.query(`INSERT INTO people(id,full_name,import_owner_sub) VALUES
    ($1,$2,$3),($4,$5,$3)`, [hiddenLinkedPersonId, `B13 linked contact ${suffix}`, actor.sub, standalonePersonId, `B13 standalone contact ${suffix}`]);
  await pool.query(`INSERT INTO activities(id,kind,title,person_id,stage_key,owner_sub,owner_name,import_owner_only)
    VALUES($1,'individual',$2,$3,'request',$4,$5,TRUE)`, [hiddenActivityId, `B13 hidden link ${suffix}`, hiddenLinkedPersonId, actor.sub, actor.name]);
  context.after(async () => {
    await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [organizationIds]);
    await pool.query('DELETE FROM people WHERE id=ANY($1::uuid[])', [personIds]);
  });

  const hiddenLinkAttempt = repo.createActivity(actor, {
    kind: 'corporate', title: `B13 must not relink hidden contact ${suffix}`, personId: hiddenLinkedPersonId,
    organizationId, payerOrganizationId,
  });
  await assert.rejects(hiddenLinkAttempt,
    (error: unknown) => error instanceof DomainError && error.code === 'person_not_found',
    'An imported contact with only a linked individual activity is hidden from the corporate-only scope.');

  await pool.query(`INSERT INTO activities(id,kind,title,organization_id,payer_organization_id,person_id,stage_key,owner_sub,owner_name)
    VALUES($1,'corporate',$2,$3,$4,$5,'qualification',$6,$7)`, [visibleActivityId, `B13 visible link ${suffix}`, organizationId, payerOrganizationId, hiddenLinkedPersonId, actor.sub, actor.name]);
  const uppercaseOrganizationScope = {
    ...actor,
    allowedOrganizationIds: [organizationId.toUpperCase(), payerOrganizationId.toUpperCase()],
  };
  const visibleLinkedCreate = await repo.createActivity(uppercaseOrganizationScope, {
    kind: 'corporate', title: `B13 visible contact link ${suffix}`, personId: hiddenLinkedPersonId,
    organizationId, payerOrganizationId,
  });
  activityIds.push(visibleLinkedCreate.id);

  const standaloneImportedCreate = await repo.createActivity(uppercaseOrganizationScope, {
    kind: 'corporate', title: `B13 standalone owner contact ${suffix}`, personId: standalonePersonId,
    organizationId, payerOrganizationId,
  });
  activityIds.push(standaloneImportedCreate.id);
});

test('PostgreSQL activity details can be corrected atomically with scope, revision, and history checks', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const app = buildApp({ repository: new PostgresRepository(), authenticate });
  await app.ready();
  let activityId: string | undefined;
  let organizationId: string | undefined;
  let personId: string | undefined;
  const privateManagerPersonId = randomUUID();
  const productIds = [randomUUID(), randomUUID()];
  context.after(async () => {
    await app.close();
    if (activityId) await pool.query('DELETE FROM activities WHERE id=$1', [activityId]);
    if (personId) await pool.query('DELETE FROM people WHERE id=$1', [personId]);
    await pool.query('DELETE FROM people WHERE id=$1', [privateManagerPersonId]);
    await pool.query('DELETE FROM products WHERE id=ANY($1::uuid[])', [productIds]);
    if (organizationId) await pool.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
  });

  const created = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'corporate', title: `A20 correctable activity ${suffix}`, organizationName: `A20 organization ${suffix}`,
  } });
  assert.equal(created.statusCode, 201, created.body);
  activityId = created.json().id;
  const before = await app.inject({ method: 'GET', url: `/api/activities/${activityId}`, headers: { 'x-test-user': 'a' } });
  assert.equal(before.statusCode, 200, before.body);
  organizationId = before.json().organizationId;
  assert.equal(before.json().revision, 0);
  assert.deepEqual(before.json().productIds, []);
  assert.equal(before.json().personId, null);
  const initialStage = before.json().stageKey;

  await pool.query('INSERT INTO people(id,full_name,email,import_owner_sub) VALUES($1,$2,$3,$4)',
    [privateManagerPersonId, `A20 manager-private ${suffix}`, `private-${suffix}@example.test`, manager.sub]);
  const crossOwner = await app.inject({ method: 'PUT', url: `/api/activities/${activityId}/details`, headers: { 'x-test-user': 'manager' }, payload: {
    personId: privateManagerPersonId, productIds: [], priority: 3, expectedRevision: 0,
  } });
  assert.equal(crossOwner.statusCode, 409, crossOwner.body);
  assert.equal(crossOwner.json().code, 'import_contact_owner_conflict');
  const afterRejectedLink = await pool.query('SELECT person_id,import_owner_only,details_revision FROM activities WHERE id=$1', [activityId]);
  assert.deepEqual(afterRejectedLink.rows[0], { person_id: null, import_owner_only: false, details_revision: 0 });

  await pool.query('INSERT INTO products(id,name) VALUES($1,$2),($3,$4)', [productIds[0], `A20 product 1 ${suffix}`, productIds[1], `A20 product 2 ${suffix}`]);
  const editPath = `/api/activities/${activityId}/details`;
  const payload = { newPerson: { fullName: `A20 contact ${suffix}`, email: `a20-${suffix}@example.test`, phone: '+70000000000' }, productIds, priority: 1, expectedRevision: 0 };
  const saved = await app.inject({ method: 'PUT', url: editPath, headers: { 'x-test-user': 'a' }, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  personId = saved.json().personId;
  assert.equal(saved.json().revision, 1);
  assert.equal(saved.json().personId, personId);
  assert.deepEqual(saved.json().productIds, [...productIds].sort());
  assert.equal(saved.json().priority, 1);
  assert.equal(saved.json().stageKey, initialStage);

  const after = await app.inject({ method: 'GET', url: `/api/activities/${activityId}`, headers: { 'x-test-user': 'a' } });
  assert.equal(after.json().revision, 1);
  assert.deepEqual(after.json().productIds, [...productIds].sort());
  assert.equal(after.json().personId, personId);
  assert.equal(after.json().personName, payload.newPerson.fullName);
  assert.equal(after.json().email, payload.newPerson.email);
  assert.equal(after.json().phone, payload.newPerson.phone);
  assert.equal(after.json().priority, 1);
  assert.equal(after.json().stageKey, initialStage, 'editing basic details must not move the workflow stage');
  const persisted = await pool.query(`SELECT a.person_id, a.priority, a.details_revision, a.stage_key,
      a.import_owner_only, array_agg(ap.product_id::text ORDER BY ap.product_id) FILTER (WHERE ap.product_id IS NOT NULL) AS product_ids
    FROM activities a LEFT JOIN activity_products ap ON ap.activity_id=a.id WHERE a.id=$1 GROUP BY a.id`, [activityId]);
  assert.deepEqual(persisted.rows[0], {
    person_id: personId, priority: 1, details_revision: 1, stage_key: initialStage,
    import_owner_only: false, product_ids: [...productIds].sort(),
  });
  const savedPerson = await pool.query('SELECT full_name, email, phone, import_owner_sub FROM people WHERE id=$1', [personId]);
  assert.deepEqual(savedPerson.rows[0], { full_name: payload.newPerson.fullName, email: payload.newPerson.email, phone: payload.newPerson.phone, import_owner_sub: null });
  const matchingCrmUser = await pool.query('SELECT count(*)::integer AS count FROM known_crm_users WHERE user_sub=$1', [personId]);
  assert.equal(matchingCrmUser.rows[0].count, 0, 'creating a Person does not create a CRM user account');
  const history = await app.inject({ method: 'GET', url: `/api/activities/${activityId}/history`, headers: { 'x-test-user': 'a' } });
  const editEvent = history.json().find((event: { eventType: string }) => event.eventType === 'activity_details_updated');
  assert.ok(editEvent);
  assert.equal(editEvent.details.revision, 1);
  assert.equal(editEvent.details.contactCreated, true);
  assert.deepEqual(editEvent.details.changes.personId, { from: null, to: personId });
  assert.deepEqual(editEvent.details.changes.productIds.from, []);
  assert.deepEqual(editEvent.details.changes.productIds.to, [...productIds].sort());
  assert.deepEqual(editEvent.details.changes.priority, { from: 3, to: 1 });

  const stale = await app.inject({ method: 'PUT', url: editPath, headers: { 'x-test-user': 'a' }, payload: { ...payload, priority: 2 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'activity_revision_conflict');
  const hidden = await app.inject({ method: 'PUT', url: editPath, headers: { 'x-test-user': 'b' }, payload: { ...payload, expectedRevision: 1 } });
  assert.equal(hidden.statusCode, 404);
  await pool.query('UPDATE activities SET closed=TRUE WHERE id=$1', [activityId]);
  const closed = await app.inject({ method: 'PUT', url: editPath, headers: { 'x-test-user': 'a' }, payload: { ...payload, expectedRevision: 1, priority: 2 } });
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().code, 'activity_closed');
  const final = await pool.query('SELECT priority, details_revision, stage_key FROM activities WHERE id=$1', [activityId]);
  assert.deepEqual(final.rows[0], { priority: 1, details_revision: 1, stage_key: initialStage });
});

test('PostgreSQL learning programs keep independent priorities and scope linked demand counts', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const programName = `Q&A program ${suffix}`;
  const app = buildApp({ repository: new PostgresRepository(), authenticate });
  await app.ready();
  let programId: string | undefined;
  const activityIds: string[] = [];
  const organizationNames = [`Program demand A org ${suffix}`, `Program demand B org ${suffix}`];
  context.after(async () => {
    await app.close();
    if (activityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    await pool.query('DELETE FROM organizations WHERE name=ANY($1::text[])', [organizationNames]);
    if (programId) await pool.query('DELETE FROM learning_programs WHERE id=$1', [programId]);
  });

  const deniedCreate = await app.inject({ method: 'POST', url: '/api/programs', headers: { 'x-test-user': 'a' }, payload: { name: programName } });
  assert.equal(deniedCreate.statusCode, 403);
  const createdProgram = await app.inject({ method: 'POST', url: '/api/programs', headers: { 'x-test-user': 'manager' }, payload: { name: programName } });
  assert.equal(createdProgram.statusCode, 201, createdProgram.body);
  programId = createdProgram.json().id;
  assert.equal(createdProgram.json().priority, 3);
  const duplicateCase = await app.inject({ method: 'POST', url: '/api/programs', headers: { 'x-test-user': 'manager' }, payload: { name: programName.toLowerCase() } });
  assert.equal(duplicateCase.statusCode, 409);
  assert.equal(duplicateCase.json().code, 'program_name_conflict');

  const invalidTitle = `Unknown program ${suffix}`;
  const invalidCreate = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'a' }, payload: {
    kind: 'corporate', title: invalidTitle, organizationName: `${invalidTitle} org`, programIds: [randomUUID()],
  } });
  assert.equal(invalidCreate.statusCode, 404);
  assert.equal(invalidCreate.json().code, 'program_not_found');
  const invalidRows = await pool.query('SELECT count(*)::integer AS count FROM activities WHERE title=$1', [invalidTitle]);
  assert.equal(invalidRows.rows[0].count, 0, 'unknown program does not create an activity');
  const invalidOrganizations = await pool.query('SELECT count(*)::integer AS count FROM organizations WHERE name=$1', [`${invalidTitle} org`]);
  assert.equal(invalidOrganizations.rows[0].count, 0, 'unknown program rolls back the new organization too');

  const createLinkedActivity = async (user: 'a' | 'b', title: string, linkOnCreate = false) => {
    const created = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': user }, payload: { kind: 'corporate', title: `${title} ${suffix}`, organizationName: `${title} org ${suffix}`, ...(linkOnCreate ? { programIds: [programId] } : {}) } });
    assert.equal(created.statusCode, 201, created.body);
    const activityId = created.json().id as string;
    activityIds.push(activityId);
    if (linkOnCreate) assert.deepEqual(created.json().programIds, [programId]);
    else {
      const linked = await app.inject({ method: 'PUT', url: `/api/activities/${activityId}/details`, headers: { 'x-test-user': user }, payload: {
        personId: null, productIds: [], programIds: [programId], priority: 3, expectedRevision: 0,
      } });
      assert.equal(linked.statusCode, 200, linked.body);
      assert.deepEqual(linked.json().programIds, [programId]);
    }
    return activityId;
  };
  const kamAActivity = await createLinkedActivity('a', 'Program demand A', true);
  const kamBActivity = await createLinkedActivity('b', 'Program demand B');

  const kamAList = await app.inject({ method: 'GET', url: '/api/programs', headers: { 'x-test-user': 'a' } });
  const kamBList = await app.inject({ method: 'GET', url: '/api/programs', headers: { 'x-test-user': 'b' } });
  const managerList = await app.inject({ method: 'GET', url: '/api/programs', headers: { 'x-test-user': 'manager' } });
  const adminList = await app.inject({ method: 'GET', url: '/api/programs', headers: { 'x-test-user': 'admin' } });
  assert.equal(kamAList.json().items.find((program: { id: string }) => program.id === programId).demandCount, 1);
  assert.equal(kamBList.json().items.find((program: { id: string }) => program.id === programId).demandCount, 1);
  assert.equal(managerList.json().items.find((program: { id: string }) => program.id === programId).demandCount, 2);
  assert.equal(adminList.json().items.find((program: { id: string }) => program.id === programId).demandCount, 0,
    'technical admin access does not grant business analytics');

  const deniedPriority = await app.inject({ method: 'PUT', url: `/api/programs/${programId}/priority`, headers: { 'x-test-user': 'a' }, payload: { priority: 1, expectedRevision: 0 } });
  assert.equal(deniedPriority.statusCode, 403);
  const priorityChange = await app.inject({ method: 'PUT', url: `/api/programs/${programId}/priority`, headers: { 'x-test-user': 'manager' }, payload: { priority: 1, expectedRevision: 0 } });
  assert.equal(priorityChange.statusCode, 200, priorityChange.body);
  assert.equal(priorityChange.json().revision, 1);
  const stalePriority = await app.inject({ method: 'PUT', url: `/api/programs/${programId}/priority`, headers: { 'x-test-user': 'manager' }, payload: { priority: 5, expectedRevision: 0 } });
  assert.equal(stalePriority.statusCode, 409);
  assert.equal(stalePriority.json().code, 'program_revision_conflict');

  const activityView = await app.inject({ method: 'GET', url: `/api/activities/${kamAActivity}`, headers: { 'x-test-user': 'a' } });
  assert.equal(activityView.json().programNames[0], programName);
  const linkRows = await pool.query('SELECT count(*)::integer AS count FROM activity_programs WHERE program_id=$1', [programId]);
  assert.equal(linkRows.rows[0].count, 2);
  const demandForPeer = await app.inject({ method: 'GET', url: `/api/activities/${kamBActivity}`, headers: { 'x-test-user': 'a' } });
  assert.equal(demandForPeer.statusCode, 404);
});

test('PostgreSQL report snapshots retain stable program links independently of current catalog state', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const activityId = randomUUID();
  const organizationId = randomUUID();
  const productId = randomUUID();
  const originalProgramId = randomUUID();
  const replacementProgramId = randomUUID();
  const service = new ReportService();
  let snapshotId: string | undefined;
  const extraSnapshotIds: string[] = [];
  context.after(async () => {
    if (snapshotId) await pool.query('DELETE FROM report_jobs WHERE id=$1::uuid', [snapshotId]);
    if (extraSnapshotIds.length) await pool.query('DELETE FROM report_jobs WHERE id=ANY($1::uuid[])', [extraSnapshotIds]);
    await pool.query('DELETE FROM activities WHERE id=$1::uuid', [activityId]);
    await pool.query('DELETE FROM organizations WHERE id=$1::uuid', [organizationId]);
    await pool.query('DELETE FROM products WHERE id=$1::uuid', [productId]);
    await pool.query('DELETE FROM learning_programs WHERE id=ANY($1::uuid[])', [[originalProgramId, replacementProgramId]]);
  });

  await pool.query('INSERT INTO organizations(id,name,segment) VALUES($1,$2,\'university\')', [organizationId, `Program report org ${suffix}`]);
  await pool.query('INSERT INTO products(id,name) VALUES($1,$2)', [productId, `Report product ${suffix}`]);
  await pool.query('INSERT INTO learning_programs(id,name) VALUES($1,$2),($3,$4)', [originalProgramId, `Program at snapshot ${suffix}`, replacementProgramId, `Program after snapshot ${suffix}`]);
  await pool.query(`INSERT INTO activities(id,kind,title,organization_id,stage_key,owner_sub,owner_name)
    VALUES($1,'university',$2,$3,'contact',$4,$5)`, [activityId, `Program report activity ${suffix}`, organizationId, manager.sub, manager.name]);
  await pool.query('INSERT INTO activity_products(activity_id,product_id) VALUES($1,$2)', [activityId, productId]);
  await pool.query('INSERT INTO activity_programs(activity_id,program_id) VALUES($1,$2)', [activityId, originalProgramId]);

  const snapshot = await service.createSnapshot(manager, { reportId: 'crm_portfolio', filters: { ownerSub: manager.sub, includeClosed: true } });
  snapshotId = snapshot.snapshotId;
  assert.equal(snapshot.rows.length, 1);
  assert.deepEqual(snapshot.rows[0]?.productLinks, [{ id: productId, name: `Report product ${suffix}` }]);
  assert.deepEqual(snapshot.rows[0]?.programLinks, [{ id: originalProgramId, name: `Program at snapshot ${suffix}` }]);
  assert.deepEqual(snapshot.rows[0]?.programNames, [`Program at snapshot ${suffix}`]);

  const filtered = await service.createSnapshot(manager, { reportId: 'demand_learning', filters: { ownerSub: manager.sub, programId: originalProgramId, includeClosed: true } });
  extraSnapshotIds.push(filtered.snapshotId);
  assert.deepEqual(filtered.rows.map((row) => row.activityId), [activityId]);
  assert.ok(filtered.notes.some((note) => note.includes('не распределяются между ними')));
  const noProgramMatch = await service.createSnapshot(manager, { reportId: 'crm_portfolio', filters: { ownerSub: manager.sub, programId: replacementProgramId, includeClosed: true } });
  extraSnapshotIds.push(noProgramMatch.snapshotId);
  assert.equal(noProgramMatch.rowCount, 0);
  const outsideKamScope = await service.createSnapshot(kamA, { reportId: 'crm_portfolio', filters: { programId: originalProgramId, includeClosed: true } });
  extraSnapshotIds.push(outsideKamScope.snapshotId);
  assert.equal(outsideKamScope.rowCount, 0);

  await pool.query('UPDATE learning_programs SET name=$2 WHERE id=$1', [originalProgramId, `Renamed after snapshot ${suffix}`]);
  await pool.query('DELETE FROM activity_programs WHERE activity_id=$1 AND program_id=$2', [activityId, originalProgramId]);
  await pool.query('INSERT INTO activity_programs(activity_id,program_id) VALUES($1,$2)', [activityId, replacementProgramId]);
  const reopenedSnapshot = await service.getSnapshot(manager, snapshotId);
  assert.deepEqual(reopenedSnapshot.rows[0]?.productLinks, [{ id: productId, name: `Report product ${suffix}` }]);
  assert.deepEqual(reopenedSnapshot.rows[0]?.programLinks, [{ id: originalProgramId, name: `Program at snapshot ${suffix}` }],
    'A saved report row keeps the catalog name and link captured at snapshot time.');
  assert.deepEqual(reopenedSnapshot.rows[0]?.programNames, [`Program at snapshot ${suffix}`]);
  const stored = await pool.query<{ row_data: Record<string, unknown> }>('SELECT row_data FROM report_snapshot_rows WHERE snapshot_id=$1::uuid AND activity_id=$2::uuid', [snapshotId, activityId]);
  assert.deepEqual(stored.rows[0]?.row_data.programLinks, [{ id: originalProgramId, name: `Program at snapshot ${suffix}` }]);
});

test('A24 manual priority changes leave demand and learning reports unchanged within the author scope', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const author: Actor = { sub: `a24-report-author-${suffix}`, name: 'A24 report author', roles: ['kam'] };
  const peer: Actor = { sub: `a24-report-peer-${suffix}`, name: 'A24 report peer', roles: ['kam'] };
  const testAuthenticate: Authenticator = async (request) => request.headers['x-test-user'] === 'author' ? author : peer;
  const app = buildApp({ repository: new PostgresRepository(), authenticate: testAuthenticate });
  await app.ready();
  const activityIds: string[] = [];
  const personIds: string[] = [];
  const organizationIds: string[] = [];
  const productId = randomUUID();
  context.after(async () => {
    await app.close();
    await pool.query('DELETE FROM report_jobs WHERE actor_sub=ANY($1::text[])', [[author.sub, peer.sub]]);
    if (activityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    if (personIds.length) await pool.query('DELETE FROM people WHERE id=ANY($1::uuid[])', [personIds]);
    if (organizationIds.length) await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [organizationIds]);
    await pool.query('DELETE FROM products WHERE id=$1::uuid', [productId]);
  });

  await pool.query('INSERT INTO products(id,name) VALUES($1,$2)', [productId, `A24 product ${suffix}`]);
  const corporate = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'author' }, payload: {
    kind: 'corporate', title: `A24 demand ${suffix}`, organizationName: `A24 organization ${suffix}`, productIds: [productId], priority: 3,
  } });
  assert.equal(corporate.statusCode, 201, corporate.body);
  activityIds.push(corporate.json().id);
  organizationIds.push(corporate.json().organizationId);
  const corporateWithoutPlan = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'author' }, payload: {
    kind: 'corporate', title: `A24 demand without plan ${suffix}`, organizationName: `A24 organization without plan ${suffix}`,
  } });
  assert.equal(corporateWithoutPlan.statusCode, 201, corporateWithoutPlan.body);
  activityIds.push(corporateWithoutPlan.json().id);
  organizationIds.push(corporateWithoutPlan.json().organizationId);
  const learner = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': 'author' }, payload: {
    kind: 'individual', title: `A24 learning ${suffix}`, personName: `A24 learner ${suffix}`, productIds: [productId], priority: 3,
  } });
  assert.equal(learner.statusCode, 201, learner.body);
  activityIds.push(learner.json().id);
  personIds.push(learner.json().personId);

  const emptyJson = JSON.stringify({});
  await pool.query(`INSERT INTO corporate_activity_plans(activity_id,program_mode,requested_places,brief,methodologist,proposed,agreed,approval,revision,actor_sub,actor_name)
    VALUES($1::uuid,'new',27,$2::jsonb,$2::jsonb,$2::jsonb,$2::jsonb,$2::jsonb,1,$3,$4)`, [corporate.json().id, emptyJson, author.sub, author.name]);
  await pool.query(`INSERT INTO individual_learning_facts(id,activity_id,fact_kind,source,occurred_at,reference) VALUES
    (gen_random_uuid(),$1::uuid,'enrollment','A24 LMS',now(),$2),
    (gen_random_uuid(),$1::uuid,'learning_started','A24 LMS',now(),$3),
    (gen_random_uuid(),$1::uuid,'learning_completed','A24 LMS',now(),$4)`, [learner.json().id, `enrollment-${suffix}`, `started-${suffix}`, `completed-${suffix}`]);

  const createDemandReport = (user: string) => app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': user }, payload: {
    reportId: 'demand_learning', filters: { includeClosed: true },
  } });
  const beforeResponse = await createDemandReport('author');
  assert.equal(beforeResponse.statusCode, 201, beforeResponse.body);
  const before = beforeResponse.json();
  assert.equal(before.rowCount, 3, 'The author slice contains only the two demand fixtures and one learning fixture.');
  assert.ok(before.rows.every((row: { ownerSub: string }) => row.ownerSub === author.sub));
  const metricValues = (snapshot: any) => snapshot.metrics.map((item: { key: string; value: number | null }) => ({ key: item.key, value: item.value }));
  const chartValues = (snapshot: any) => snapshot.charts.map((chart: { id: string; series: { label: string; value: number; filter?: unknown }[] }) => ({
    id: chart.id, series: chart.series.map((series) => ({ label: series.label, value: series.value, filter: series.filter })),
  }));
  assert.deepEqual(metricValues(before), [
    { key: 'corporateActivities', value: 2 }, { key: 'requestedPlaces', value: 27 },
    { key: 'enrollmentFacts', value: 1 }, { key: 'learningStartedFacts', value: 1 }, { key: 'learningCompletedFacts', value: 1 },
    { key: 'incomingInquiries', value: null }, { key: 'learningApplications', value: null },
    { key: 'uniqueLearners', value: null }, { key: 'concurrentStreams', value: null },
  ]);
  const knownPlaces = before.metrics.find((item: { key: string }) => item.key === 'requestedPlaces');
  assert.equal(knownPlaces.label, 'Заявленные места (известная часть)');
  assert.match(knownPlaces.completeness, /1 из 2/);
  assert.match(knownPlaces.completeness, /известную часть/);
  assert.match(before.metrics.find((item: { key: string }) => item.key === 'uniqueLearners').completeness, /стабильного идентификатора обучающегося/);
  assert.match(before.metrics.find((item: { key: string }) => item.key === 'concurrentStreams').completeness, /периодов начала и окончания/);
  const beforeProductChart = before.charts.find((chart: { id: string }) => chart.id === 'product-activity-links');
  assert.equal(beforeProductChart.series.find((series: { filter?: { productId?: string } }) => series.filter?.productId === productId).value, 2);
  const beforePlacesChart = before.charts.find((chart: { id: string }) => chart.id === 'product-demand-places');
  assert.equal(beforePlacesChart.series.find((series: { filter?: { productId?: string } }) => series.filter?.productId === productId).value, 27);
  assert.deepEqual(before.charts.find((chart: { id: string }) => chart.id === 'learning-events').series.map((series: { value: number }) => series.value), [1, 1, 1]);
  const snapshotAuthor = await pool.query('SELECT actor_sub AS "actorSub",actor_name AS "actorName" FROM report_jobs WHERE id=$1::uuid', [before.snapshotId]);
  assert.deepEqual(snapshotAuthor.rows[0], { actorSub: author.sub, actorName: author.name });
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/snapshots/${before.snapshotId}`, headers: { 'x-test-user': 'peer' } })).statusCode, 404,
    'A peer cannot read the author’s snapshot.');

  const priorityUpdate = await app.inject({ method: 'PUT', url: `/api/activities/${corporate.json().id}/details`, headers: { 'x-test-user': 'author' }, payload: {
    personId: null, productIds: [productId], priority: 1, expectedRevision: 0,
  } });
  assert.equal(priorityUpdate.statusCode, 200, priorityUpdate.body);
  assert.equal(priorityUpdate.json().priority, 1);
  const persisted = await pool.query('SELECT owner_sub AS "ownerSub",owner_name AS "ownerName",priority FROM activities WHERE id=$1::uuid', [corporate.json().id]);
  assert.deepEqual(persisted.rows[0], { ownerSub: author.sub, ownerName: author.name, priority: 1 });
  const priorityEvent = await pool.query(`SELECT actor_sub AS "actorSub",actor_name AS "actorName",details->'changes'->'priority' AS priority
    FROM activity_events WHERE activity_id=$1::uuid AND event_type='activity_details_updated' ORDER BY created_at DESC LIMIT 1`, [corporate.json().id]);
  assert.deepEqual(priorityEvent.rows[0], { actorSub: author.sub, actorName: author.name, priority: { from: 3, to: 1 } });

  const afterResponse = await createDemandReport('author');
  assert.equal(afterResponse.statusCode, 201, afterResponse.body);
  const after = afterResponse.json();
  assert.equal(after.rowCount, before.rowCount);
  assert.deepEqual(after.rows.map((row: { activityId: string }) => row.activityId).sort(), before.rows.map((row: { activityId: string }) => row.activityId).sort());
  assert.ok(after.rows.every((row: { ownerSub: string }) => row.ownerSub === author.sub), 'Priority editing preserves report row ownership.');
  assert.deepEqual(metricValues(after), metricValues(before), 'Demand and learning metrics do not depend on manual priority.');
  assert.deepEqual(chartValues(after), chartValues(before), 'Demand and learning chart series do not depend on manual priority.');
  const afterSnapshotAuthor = await pool.query('SELECT actor_sub AS "actorSub",actor_name AS "actorName" FROM report_jobs WHERE id=$1::uuid', [after.snapshotId]);
  assert.deepEqual(afterSnapshotAuthor.rows[0], { actorSub: author.sub, actorName: author.name });
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/snapshots/${after.snapshotId}`, headers: { 'x-test-user': 'peer' } })).statusCode, 404,
    'Priority editing does not widen access to the author’s new snapshot.');
  const peerReport = await createDemandReport('peer');
  assert.equal(peerReport.statusCode, 201, peerReport.body);
  assert.equal(peerReport.json().rowCount, 0, 'The peer’s current scope still excludes the author’s activities.');
});

test('A40 PostgreSQL demand-learning oracle separates CRM activities, requested places, and LMS events in stored exports', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const author: Actor = { sub: `a40-report-author-${suffix}`, name: 'A40 report author', roles: ['kam'] };
  const peer: Actor = { sub: `a40-report-peer-${suffix}`, name: 'A40 report peer', roles: ['kam'] };
  const testAuthenticate: Authenticator = async (request) => request.headers['x-test-user'] === 'author' ? author : peer;
  const app = buildApp({ repository: new PostgresRepository(), authenticate: testAuthenticate });
  await app.ready();
  const activityIds: string[] = [];
  const personIds: string[] = [];
  const organizationIds: string[] = [];
  const productIds = [randomUUID(), randomUUID()];
  const actorSubs = [author.sub, peer.sub];
  context.after(async () => {
    await app.close();
    const files = await pool.query('SELECT file_key AS "fileKey" FROM report_jobs WHERE actor_sub=ANY($1::text[]) AND file_key IS NOT NULL', [actorSubs]);
    await Promise.all((files.rows as { fileKey: string }[]).map(({ fileKey }) => removePrivateReport(fileKey)));
    await pool.query('DELETE FROM report_jobs WHERE actor_sub=ANY($1::text[])', [actorSubs]);
    await pool.query('DELETE FROM exchange_jobs WHERE actor_sub=ANY($1::text[])', [actorSubs]);
    if (activityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    if (personIds.length) await pool.query('DELETE FROM people WHERE id=ANY($1::uuid[])', [personIds]);
    if (organizationIds.length) await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [organizationIds]);
    await pool.query('DELETE FROM products WHERE id=ANY($1::uuid[])', [productIds]);
  });

  const productNames = [`A40 product one ${suffix}`, `A40 product two ${suffix}`];
  await pool.query('INSERT INTO products(id,name) VALUES($1::uuid,$3),($2::uuid,$4)', [productIds[0], productIds[1], productNames[0], productNames[1]]);
  const createActivity = async (user: 'author' | 'peer', payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/api/activities', headers: { 'x-test-user': user }, payload });
    assert.equal(response.statusCode, 201, response.body);
    const activity = response.json();
    activityIds.push(activity.id);
    if (activity.organizationId) organizationIds.push(activity.organizationId);
    if (activity.personId) personIds.push(activity.personId);
    return activity;
  };
  const recordedCorporate = await createActivity('author', {
    kind: 'corporate', title: `A40 recorded demand ${suffix}`, organizationName: `A40 recorded organization ${suffix}`,
    productIds, priority: 3,
  });
  const documentId = randomUUID();
  const contractLicenseId = randomUUID();
  await pool.query(`INSERT INTO activity_documents(id,activity_id,object_key,original_name,extension,media_type,size_bytes,sha256,uploaded_by_sub,uploaded_by_name)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,'pdf','application/pdf',1,$5,$6,$7)`,
  [documentId, recordedCorporate.id, randomUUID(), `A40 document ${suffix}.pdf`, '0'.repeat(64), author.sub, author.name]);
  await pool.query(`INSERT INTO activity_contract_licenses(id,activity_id,title,document_id,revision,actor_sub,actor_name)
    VALUES($1::uuid,$2::uuid,$3,$4::uuid,1,$5,$6)`,
  [contractLicenseId, recordedCorporate.id, `A40 contract ${suffix}`, documentId, author.sub, author.name]);
  const unknownCorporate = await createActivity('author', {
    kind: 'corporate', title: `A40 unknown demand ${suffix}`, organizationName: `A40 unknown organization ${suffix}`,
    productIds: [productIds[1]], priority: 3,
  });
  const learner = await createActivity('author', {
    kind: 'individual', title: `A40 learning ${suffix}`, personName: `A40 learner ${suffix}`, priority: 3,
  });
  const outOfScopeCorporate = await createActivity('peer', {
    kind: 'corporate', title: `A40 peer demand ${suffix}`, organizationName: `A40 peer organization ${suffix}`,
    productIds: [productIds[0]], priority: 3,
  });
  const fixtureOrganizations = await pool.query('SELECT id,organization_id AS "organizationId" FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
  const organizationByActivity = new Map((fixtureOrganizations.rows as { id: string; organizationId: string | null }[]).map((row) => [row.id, row.organizationId]));
  organizationIds.push(...new Set([...organizationByActivity.values()].filter((id): id is string => id !== null)));

  const emptyJson = JSON.stringify({});
  await pool.query(`INSERT INTO corporate_activity_plans(activity_id,program_mode,requested_places,brief,methodologist,proposed,agreed,approval,revision,actor_sub,actor_name)
    VALUES($1::uuid,'new',30,$2::jsonb,$2::jsonb,$2::jsonb,$2::jsonb,$2::jsonb,1,$3,$4),
          ($5::uuid,'new',777,$2::jsonb,$2::jsonb,$2::jsonb,$2::jsonb,$2::jsonb,1,$6,$7)`,
  [recordedCorporate.id, emptyJson, author.sub, author.name, outOfScopeCorporate.id, peer.sub, peer.name]);
  const occurrences = {
    enrollmentEarlier: '2026-08-03T10:00:00.000Z',
    started: '2026-08-04T12:30:00.000Z',
    enrollmentLater: '2026-08-05T16:45:00.000Z',
  };
  await pool.query(`INSERT INTO individual_learning_facts(id,activity_id,fact_kind,source,occurred_at,reference) VALUES
    (gen_random_uuid(),$1::uuid,'enrollment','A40 LMS',$2::timestamptz,$3),
    (gen_random_uuid(),$1::uuid,'learning_started','A40 LMS',$4::timestamptz,$5),
    (gen_random_uuid(),$1::uuid,'enrollment','A40 LMS',$6::timestamptz,$7)`,
  [learner.id, occurrences.enrollmentEarlier, `a40-enrollment-one-${suffix}`, occurrences.started, `a40-started-${suffix}`, occurrences.enrollmentLater, `a40-enrollment-two-${suffix}`]);

  const addAcceptedReceipt = async (eventId: string, factKind: string, factReference: string, occurredAt: string) => {
    const jobId = randomUUID(); const exchangeEventId = randomUUID(); const correlationId = randomUUID();
    await pool.query(`INSERT INTO exchange_jobs(id,direction,system,operation,activity_id,actor_sub,scope_key,correlation_id,idempotency_key,external_event_id,status,payload)
      VALUES($1,'lms_to_crm','lms','receive_learning_fact',$2::uuid,$3,$4,$5,$6,$7,'performed','{}'::jsonb)`,
    [jobId, learner.id, author.sub, `a40-event-${eventId}`, correlationId, `a40-idem-${eventId}`, eventId]);
    const event = await pool.query(`INSERT INTO exchange_events(id,job_id,source_system,direction,event_id,correlation_id,event_type,occurred_at,payload,received_at)
      VALUES($1,$2,'lms','lms_to_crm',$3,$4,'learning.fact',$5::timestamptz,$6::jsonb,now()-interval '10 minutes') RETURNING received_at`,
    [exchangeEventId, jobId, eventId, correlationId, occurredAt, JSON.stringify({ factKind, reference: factReference })]);
    const linked = await pool.query('UPDATE individual_learning_facts SET exchange_event_id=$2::uuid WHERE activity_id=$1::uuid AND reference=$3', [learner.id, exchangeEventId, factReference]);
    assert.equal(linked.rowCount, 1, 'Each accepted event is linked to exactly one learning projection fact.');
    return { eventId: exchangeEventId, receivedAt: new Date(event.rows[0].received_at).toISOString() };
  };
  const firstEnrollmentReceipt = await addAcceptedReceipt(`a40-enrollment-${suffix}`, 'enrollment', `a40-enrollment-two-${suffix}`, occurrences.enrollmentLater);
  const firstStartedReceipt = await addAcceptedReceipt(`a40-started-${suffix}`, 'learning_started', `a40-started-${suffix}`, occurrences.started);
  const legacyFacts = await pool.query(`SELECT count(*)::integer AS count FROM individual_learning_facts
    WHERE activity_id=$1::uuid AND exchange_event_id IS NULL`, [learner.id]);
  assert.equal(legacyFacts.rows[0].count, 1, 'The one remaining direct enrollment fact stays explicitly unlinked.');
  const linkedFacts = await pool.query(`SELECT reference,exchange_event_id AS "exchangeEventId" FROM individual_learning_facts
    WHERE activity_id=$1::uuid AND exchange_event_id IS NOT NULL ORDER BY reference`, [learner.id]);
  assert.deepEqual(linkedFacts.rows, [
    { reference: `a40-enrollment-two-${suffix}`, exchangeEventId: firstEnrollmentReceipt.eventId },
    { reference: `a40-started-${suffix}`, exchangeEventId: firstStartedReceipt.eventId },
  ].sort((left, right) => left.reference.localeCompare(right.reference)));

  const response = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'author' }, payload: {
    reportId: 'demand_learning', filters: { includeClosed: true },
  } });
  assert.equal(response.statusCode, 201, response.body);
  const snapshot = response.json();
  assert.equal(snapshot.dataProfile, 'synthetic_demo');
  assert.equal(snapshot.rowCount, 3, 'Only the author’s two corporate activities and individual activity enter this slice.');
  assert.deepEqual(snapshot.rows.map((row: { activityId: string }) => row.activityId).sort(), [recordedCorporate.id, unknownCorporate.id, learner.id].sort());
  assert.equal(snapshot.rows.some((row: { activityId: string }) => row.activityId === outOfScopeCorporate.id), false, 'Peer-owned source rows stay outside the author’s scope.');

  const metric = (key: string) => {
    const found = snapshot.metrics.find((item: { key: string }) => item.key === key);
    assert.ok(found, `Metric ${key} is present.`);
    return found;
  };
  const totalLearningEvents = metric('enrollmentFacts').value + metric('learningStartedFacts').value + metric('learningCompletedFacts').value;
  assert.equal(metric('corporateActivities').value, 2);
  assert.equal(metric('requestedPlaces').value, 30);
  assert.equal(totalLearningEvents, 3);
  assert.notEqual(metric('corporateActivities').value, metric('requestedPlaces').value);
  assert.notEqual(metric('requestedPlaces').value, totalLearningEvents);
  assert.equal(metric('enrollmentFacts').value, 2);
  assert.equal(metric('learningStartedFacts').value, 1);
  assert.equal(metric('learningCompletedFacts').value, 0);
  assert.equal(metric('requestedPlaces').label, 'Заявленные места (известная часть)');
  assert.match(metric('requestedPlaces').completeness, /Записано для 1 из 2 корпоративных активностей/);
  assert.match(metric('requestedPlaces').completeness, /известную часть/);

  for (const key of ['corporateActivities', 'requestedPlaces']) {
    assert.equal(metric(key).timeScope, 'selected_activity_creation_period');
    assert.equal(metric(key).grouping, 'activity');
  }
  const expectedFactTimes = {
    enrollmentFacts: occurrences.enrollmentLater,
    learningStartedFacts: occurrences.started,
    learningCompletedFacts: null,
  };
  for (const [key, lastOccurredAt] of Object.entries(expectedFactTimes)) {
    assert.equal(metric(key).timeScope, 'selected_activities_all_available_fact_times');
    assert.equal(metric(key).grouping, 'learning_fact_event');
    assert.equal(metric(key).lastFactOccurredAt, lastOccurredAt);
    const expectedReceipt = key === 'learningStartedFacts' ? firstStartedReceipt.receivedAt : null;
    assert.equal(metric(key).sourceReceivedAt, expectedReceipt, 'Receipt time comes from exchange_events.received_at only with complete per-kind fact coverage.');
  }
  assert.notEqual(metric('learningStartedFacts').sourceReceivedAt, metric('learningStartedFacts').lastFactOccurredAt,
    'The CRM receipt timestamp remains distinct from the LMS event occurrence timestamp.');
  assert.equal(metric('enrollmentFacts').sourceReceivedAt, null,
    'One accepted enrollment event cannot claim the receipt time for a second legacy enrollment fact.');
  for (const key of ['incomingInquiries', 'learningApplications', 'uniqueLearners', 'concurrentStreams']) {
    assert.equal(metric(key).value, null);
    assert.equal(metric(key).timeScope, 'not_calculated');
    assert.equal(metric(key).grouping, 'not_calculated');
  }

  const rowFor = (id: string) => {
    const found = snapshot.rows.find((row: { activityId: string }) => row.activityId === id);
    assert.ok(found, `Source activity ${id} is present.`);
    return found;
  };
  const recordedRow = rowFor(recordedCorporate.id);
  const unknownRow = rowFor(unknownCorporate.id);
  const learningRow = rowFor(learner.id);
  assert.equal(recordedRow.requestedPlaces, 30);
  assert.equal(recordedRow.requestedPlacesRecorded, true);
  assert.deepEqual(recordedRow.productLinks.map((product: { id: string }) => product.id).sort(), [...productIds].sort());
  assert.equal(unknownRow.requestedPlaces, null);
  assert.equal(unknownRow.requestedPlacesRecorded, false);
  assert.deepEqual([learningRow.enrollmentFactCount, learningRow.learningStartedFactCount, learningRow.learningCompletedFactCount], [2, 1, 0]);
  assert.equal(learningRow.lastLearningFactAt, occurrences.enrollmentLater);

  // A chart click starts a fresh server snapshot with the clicked series filter
  // added to the original slice. Verify each nonzero point against its own rows.
  const chartIds = ['product-activity-links', 'product-demand-places', 'learning-events'] as const;
  const learningCountKey = {
    enrollment: 'enrollmentFactCount',
    learning_started: 'learningStartedFactCount',
    learning_completed: 'learningCompletedFactCount',
  } as const;
  let checkedDrilldown = false;
  const checkedSeriesByChart = new Set<string>();
  for (const chartId of chartIds) {
    const sourceChart = snapshot.charts.find((item: { id: string }) => item.id === chartId);
    assert.ok(sourceChart, `Chart ${chartId} is present for drilldown.`);
    for (const series of sourceChart.series as { value: number; filter?: Record<string, string | boolean> }[]) {
      if (series.value === 0) continue;
      checkedSeriesByChart.add(chartId);
      assert.ok(series.filter, `Nonzero ${chartId} series has a server filter.`);
      const filters = { includeClosed: true, ...series.filter };
      const sourceRows = snapshot.rows.filter((row: any) => {
        if (chartId === 'product-activity-links') return row.productLinks.some((product: { id: string }) => product.id === filters.productId);
        if (chartId === 'product-demand-places') return row.kind === 'corporate' && row.requestedPlacesRecorded && row.productLinks.some((product: { id: string }) => product.id === filters.productId);
        const factKind = filters.learningFactKind as keyof typeof learningCountKey;
        return (row[learningCountKey[factKind]] ?? 0) > 0;
      });
      const drilldownResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'author' }, payload: {
        reportId: 'demand_learning', filters,
      } });
      assert.equal(drilldownResponse.statusCode, 201, drilldownResponse.body);
      const drilldown = drilldownResponse.json();
      assert.deepEqual(drilldown.rows.map((row: { activityId: string }) => row.activityId).sort(),
        sourceRows.map((row: { activityId: string }) => row.activityId).sort(), `${chartId} click returns exactly the matching source activities.`);
      let clickedValue: number;
      if (chartId === 'product-activity-links') {
        clickedValue = new Set(drilldown.rows.map((row: { activityId: string }) => row.activityId)).size;
      } else if (chartId === 'product-demand-places') {
        clickedValue = drilldown.rows.reduce((sum: number, row: { requestedPlaces: number | null }) => sum + (row.requestedPlaces ?? 0), 0);
      } else {
        const factKind = filters.learningFactKind as keyof typeof learningCountKey;
        const countKey = learningCountKey[factKind];
        clickedValue = drilldown.rows.reduce((sum: number, row: Record<string, number | null>) => sum + (row[countKey] ?? 0), 0);
      }
      assert.equal(clickedValue, series.value, `${chartId} point equals its relevant activity, requested-place, or fact-event count.`);
      assert.equal(drilldown.rows.some((row: { activityId: string }) => row.activityId === outOfScopeCorporate.id), false,
        'A click drilldown stays within the author’s activity scope.');
      if (!checkedDrilldown) {
        assert.equal((await app.inject({ method: 'GET', url: `/api/reports/snapshots/${drilldown.snapshotId}`, headers: { 'x-test-user': 'peer' } })).statusCode, 404,
          'A peer cannot read the saved result of a chart click.');
        checkedDrilldown = true;
      }
    }
  }
  assert.deepEqual([...checkedSeriesByChart].sort(), [...chartIds].sort(), 'Every chart family has a nonzero series checked through a server drilldown.');

  const secondStartedReference = `a40-started-later-${suffix}`;
  const laterStartedOccurrence = '2026-08-06T16:00:00.000Z';
  await pool.query(`INSERT INTO individual_learning_facts(id,activity_id,fact_kind,source,occurred_at,reference)
    VALUES(gen_random_uuid(),$1::uuid,'learning_started','A40 LMS',$2::timestamptz,$3)`, [learner.id, laterStartedOccurrence, secondStartedReference]);
  const laterStartedReceipt = await addAcceptedReceipt(`a40-started-later-${suffix}`, 'learning_started', secondStartedReference, laterStartedOccurrence);
  const oldSnapshotResponse = await app.inject({ method: 'GET', url: `/api/reports/snapshots/${snapshot.snapshotId}`, headers: { 'x-test-user': 'author' } });
  assert.equal(oldSnapshotResponse.statusCode, 200, oldSnapshotResponse.body);
  const oldStarted = oldSnapshotResponse.json().metrics.find((item: { key: string }) => item.key === 'learningStartedFacts');
  assert.equal(oldStarted.value, 1, 'A later LMS import does not update an existing snapshot count.');
  assert.equal(oldStarted.sourceReceivedAt, firstStartedReceipt.receivedAt, 'A later LMS receipt does not change the saved snapshot timestamp.');
  const newSnapshotResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: { 'x-test-user': 'author' }, payload: {
    reportId: 'demand_learning', filters: { includeClosed: true },
  } });
  assert.equal(newSnapshotResponse.statusCode, 201, newSnapshotResponse.body);
  const newStarted = newSnapshotResponse.json().metrics.find((item: { key: string }) => item.key === 'learningStartedFacts');
  assert.equal(newStarted.value, 2);
  assert.equal(newStarted.sourceReceivedAt, laterStartedReceipt.receivedAt, 'A new snapshot records the latest receipt across all linked facts of that kind.');

  const chart = (id: string) => {
    const found = snapshot.charts.find((item: { id: string }) => item.id === id);
    assert.ok(found, `Chart ${id} is present.`);
    return found;
  };
  const productActivityChart = chart('product-activity-links');
  const productActivitySeries = new Map(productActivityChart.series.map((series: { filter: { productId: string }; value: number }) => [series.filter.productId, series.value]));
  for (const productId of productIds) {
    const sourceActivityCount = snapshot.rows.filter((row: { productLinks: { id: string }[] }) => row.productLinks.some((product) => product.id === productId)).length;
    assert.equal(productActivitySeries.get(productId), sourceActivityCount, 'Each activity link chart series matches unique source activity rows.');
  }
  const placesChart = chart('product-demand-places');
  assert.match(placesChart.unit, /по продуктам не суммируется/);
  const placesByProduct = new Map(placesChart.series.map((series: { filter: { productId: string }; value: number }) => [series.filter.productId, series.value]));
  assert.deepEqual([...placesByProduct.entries()].sort(), productIds.map((id) => [id, 30]).sort(([left], [right]) => String(left).localeCompare(String(right))));
  assert.equal([...placesByProduct.values()].reduce((sum: number, value: number) => sum + value, 0), 60,
    'Both product series repeat the one source activity value; the total requestedPlaces metric remains 30.');
  const expectedPlacesByProduct = new Map(productIds.map((id) => [id, snapshot.rows
    .filter((row: { kind: string; requestedPlacesRecorded: boolean; productLinks: { id: string }[] }) => row.kind === 'corporate' && row.requestedPlacesRecorded && row.productLinks.some((product) => product.id === id))
    .reduce((sum: number, row: { requestedPlaces: number | null }) => sum + (row.requestedPlaces ?? 0), 0)]));
  for (const [productId, value] of placesByProduct) assert.equal(value, expectedPlacesByProduct.get(productId));
  const learningChart = chart('learning-events');
  assert.deepEqual(learningChart.series.map((series: { filter: { learningFactKind: string }; value: number }) => [series.filter.learningFactKind, series.value]), [
    ['enrollment', 2], ['learning_started', 1], ['learning_completed', 0],
  ]);
  assert.equal(learningChart.series.reduce((sum: number, series: { value: number }) => sum + series.value, 0), totalLearningEvents,
    'Learning chart event counts match the per-activity facts in the stored slice.');

  async function exportStored(format: 'json' | 'xlsx'): Promise<Buffer> {
    const created = await app.inject({ method: 'POST', url: '/api/reports/exports', headers: { 'x-test-user': 'author' }, payload: { snapshotId: snapshot.snapshotId, format } });
    assert.equal(created.statusCode, 202, created.body);
    const exportId = created.json().id as string;
    let status: any;
    const deadline = Date.now() + 20_000;
    do {
      const poll = await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}`, headers: { 'x-test-user': 'author' } });
      assert.equal(poll.statusCode, 200, poll.body);
      status = poll.json();
      if (status.status === 'completed' || status.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(status.status, 'completed', status.errorMessage);
    const file = await app.inject({ method: 'GET', url: `/api/reports/exports/${exportId}/file`, headers: { 'x-test-user': 'author' } });
    assert.equal(file.statusCode, 200, file.body);
    assert.ok(file.rawPayload.length > 0);
    return file.rawPayload;
  }

  const storedJson = JSON.parse((await exportStored('json')).toString('utf8'));
  assert.deepEqual(storedJson.metrics, snapshot.metrics, 'Stored JSON preserves report metrics and their limits.');
  assert.deepEqual(storedJson.charts, snapshot.charts, 'Stored JSON preserves declared chart units and series filters.');
  assert.deepEqual(storedJson.rows.map((row: { activityId: string }) => row.activityId).sort(), snapshot.rows.map((row: { activityId: string }) => row.activityId).sort());
  assert.deepEqual(storedJson.rows.find((row: { activityId: string }) => row.activityId === recordedCorporate.id).productLinks.map((product: { id: string }) => product.id).sort(), [...productIds].sort());
  const linkedRow = storedJson.rows.find((row: { activityId: string }) => row.activityId === recordedCorporate.id);
  assert.equal(linkedRow.organizationId, organizationByActivity.get(recordedCorporate.id));
  assert.equal(linkedRow.programMode, 'new');
  assert.deepEqual(linkedRow.documentRefs, [{ id: documentId, name: `A40 document ${suffix}.pdf` }]);
  assert.deepEqual(linkedRow.contractLicenseRefs, [{ id: contractLicenseId, title: `A40 contract ${suffix}`, documentId }]);
  assert.equal(JSON.stringify(linkedRow).includes('objectKey'), false, 'The private storage key is not an export reference.');
  assert.equal(storedJson.rows.find((row: { activityId: string }) => row.activityId === learner.id).enrollmentFactCount, 2);

  const workbook = XLSX.read(await exportStored('xlsx'), { type: 'buffer', cellDates: true });
  const dataRows = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(workbook.Sheets['Данные']!, { header: 1, defval: null });
  assert.equal(dataRows.length, 5, 'The stored data sheet contains its profile, headings, and all three source activities.');
  assert.deepEqual(dataRows[1], ['ID активности', 'Тип', 'Активность', 'Стадия', 'Ответственный', 'Организация', 'Человек', 'Источник заявки', 'Создана', 'Изменена', 'Закрыта', 'Продукты', 'Учебные программы', 'Заявлено мест', 'Места указаны', 'Факты зачисления LMS', 'Факты начала LMS', 'Факты завершения LMS', 'Источник учебных фактов', 'Последний факт LMS']);
  const dataById = new Map(dataRows.slice(2).map((row) => [row[0], row]));
  assert.deepEqual([...dataById.keys()].sort(), [recordedCorporate.id, unknownCorporate.id, learner.id].sort());
  assert.equal(dataById.get(recordedCorporate.id)![12], '');
  assert.equal(dataById.get(recordedCorporate.id)![13], 30);
  assert.equal(dataById.get(recordedCorporate.id)![14], true);
  assert.equal(dataById.get(unknownCorporate.id)![13], '');
  assert.equal(dataById.get(unknownCorporate.id)![14], false);
  assert.deepEqual([dataById.get(learner.id)![15], dataById.get(learner.id)![16], dataById.get(learner.id)![17]], [2, 1, 0]);
  const metricRows = XLSX.utils.sheet_to_json<(string | number | Date)[]>(workbook.Sheets['Показатели']!, { header: 1 });
  const metricRow = (label: string) => {
    const found = metricRows.find((row) => row[0] === label);
    assert.ok(found, `Stored workbook includes metric ${label}.`);
    return found;
  };
  assert.equal(metricRow(metric('corporateActivities').label)[1], 2);
  assert.equal(metricRow(metric('requestedPlaces').label)[1], 30);
  assert.equal(metricRow(metric('enrollmentFacts').label)[1], 2);
  assert.equal(metricRow(metric('learningStartedFacts').label)[1], 1);
  assert.equal(metricRow(metric('learningCompletedFacts').label)[1], 0);
  const exportedEnrollment = metricRow(metric('enrollmentFacts').label);
  assert.equal(exportedEnrollment[6], 'Все доступные времена фактов по активностям среза');
  assert.equal(exportedEnrollment[7], 'Событие учебного факта');
  assert.equal((exportedEnrollment[8] as Date).toISOString(), occurrences.enrollmentLater);
  assert.equal(exportedEnrollment[9], 'Не подтверждено для всех событий');
  for (const key of ['incomingInquiries', 'learningApplications', 'uniqueLearners', 'concurrentStreams']) {
    const exported = metricRow(metric(key).label);
    assert.equal(exported[1], 'Недостаточно данных');
    assert.equal(exported[6], 'Не рассчитывается');
    assert.equal(exported[7], 'Не рассчитывается');
  }
});

test('PostgreSQL import summary excludes applied review rows and application product changes advance details revision', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const source = `A30 import regression ${suffix}`;
  const contactKeys = [`contact-${suffix}-1`, `contact-${suffix}-2`];
  const applicationKey = `application-${suffix}`;
  const products = [{ id: randomUUID(), name: `A30 old product ${suffix}` }, { id: randomUUID(), name: `A30 new product ${suffix}` }];
  const imports = new PostgresImportService();
  const app = buildApp({ repository: new PostgresRepository(), authenticate });
  const adminActor: Actor = { sub: `a30-admin-${suffix}`, name: 'A30 import summary admin', roles: ['admin'] };
  const jobIds: string[] = [];
  let activityId: string | undefined;
  await pool.query('INSERT INTO products(id,name) VALUES($1,$2),($3,$4)', [products[0].id, products[0].name, products[1].id, products[1].name]);
  await app.ready();
  context.after(async () => {
    await app.close();
    if (jobIds.length) {
      await pool.query('DELETE FROM import_provenance WHERE job_id=ANY($1::uuid[])', [jobIds]);
      await pool.query('DELETE FROM import_jobs WHERE id=ANY($1::uuid[])', [jobIds]);
    }
    await pool.query('DELETE FROM import_identities WHERE source_system=$1', [source]);
    if (activityId) await pool.query('DELETE FROM activities WHERE id=$1', [activityId]);
    await pool.query('DELETE FROM people WHERE import_owner_sub=$1 AND import_source=$2', [kamA.sub, source]);
    await pool.query('DELETE FROM products WHERE id=ANY($1::uuid[])', [products.map((product) => product.id)]);
  });

  const makeWorkbook = (rows: unknown[][]) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'A30');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };
  const uploadContacts = async (filename: string, rows: unknown[][]) => {
    const job = await imports.upload(kamA, filename, 'contacts', source, makeWorkbook(rows));
    jobIds.push(job.id);
    const preview = await imports.preview(kamA, job.id, { revision: job.revision, selectedSheet: 'A30', headerRow: 1, mapping: { '0': 'externalKey', '1': 'fullName' } });
    return { id: job.id, revision: preview.revision as number, preview: preview.preview as { status: string }[] };
  };
  const uploadApplication = async (filename: string, phone: string, productName: string) => {
    const bytes = Buffer.from(JSON.stringify({ applications: [{
      applicationId: applicationKey,
      applicant: { fullName: `A30 applicant ${suffix}`, email: `a30-${suffix}@example.test`, phone },
      productName,
    }] }));
    const job = await imports.upload(kamA, filename, 'individual_applications', source, bytes);
    jobIds.push(job.id);
    const preview = await imports.preview(kamA, job.id, { revision: job.revision, selectedSheet: 'applications', headerRow: 1,
      mapping: { '0': 'externalKey', '1': 'fullName', '2': 'email', '3': 'phone', '4': 'productName' } });
    return { id: job.id, revision: preview.revision as number, preview: preview.preview as { status: string }[] };
  };
  const appliedResolutionCount = async () => (await imports.adminSummary(adminActor)).counts.previewRowsRequiringResolution;
  const recentResolutionCount = async (jobId: string) => {
    const job = (await imports.adminSummary(adminActor)).recentJobs.find((item) => item.id === jobId);
    assert.ok(job, 'The test job is included in the bounded recent-jobs summary.');
    return job.previewRowsRequiringResolution;
  };
  const baselineResolutions = await appliedResolutionCount();

  const initialContacts = await uploadContacts('a30-contacts.xlsx', [
    ['External ID', 'Full Name'], [contactKeys[0], `Initial contact one ${suffix}`], [contactKeys[1], `Initial contact two ${suffix}`],
  ]);
  await imports.confirm(kamA, initialContacts.id, {
    revision: initialContacts.revision, idempotencyKey: `a30-contact-seed-${suffix}`, rowNumbers: [2, 3], reviewedRows: [],
  });
  const changedContacts = await uploadContacts('a30-contact-updates.xlsx', [
    ['External ID', 'Full Name'], [contactKeys[0], `Updated contact one ${suffix}`], [contactKeys[1], `Updated contact two ${suffix}`],
  ]);
  assert.deepEqual(changedContacts.preview.map((row) => row.status), ['changed_requires_review', 'changed_requires_review']);
  assert.equal(await appliedResolutionCount(), baselineResolutions + 2);
  await imports.confirm(kamA, changedContacts.id, {
    revision: changedContacts.revision, idempotencyKey: `a30-contact-first-${suffix}`, rowNumbers: [2], reviewedRows: [2],
  });
  assert.equal(await recentResolutionCount(changedContacts.id), 1, 'The processed review row no longer counts, while the partial row remains unresolved.');
  assert.equal(await appliedResolutionCount(), baselineResolutions + 1);
  await imports.confirm(kamA, changedContacts.id, {
    revision: changedContacts.revision, idempotencyKey: `a30-contact-second-${suffix}`, rowNumbers: [3], reviewedRows: [3],
  });
  assert.equal(await recentResolutionCount(changedContacts.id), 0);
  assert.equal(await appliedResolutionCount(), baselineResolutions);

  const initialApplication = await uploadApplication('a30-application.json', '+7 900 001 01 01', products[0].name);
  assert.equal(initialApplication.preview[0].status, 'valid');
  await imports.confirm(kamA, initialApplication.id, {
    revision: initialApplication.revision, idempotencyKey: `a30-app-seed-${suffix}`, rowNumbers: [2], reviewedRows: [],
  });
  const foundActivity = await pool.query(`SELECT a.id,a.person_id,a.details_revision,ap.product_id::text AS product_id
    FROM activities a JOIN activity_products ap ON ap.activity_id=a.id
    WHERE a.owner_sub=$1 AND a.origin_source=$2 AND a.origin_reference=$3`, [kamA.sub, source, applicationKey]);
  assert.equal(foundActivity.rowCount, 1);
  activityId = foundActivity.rows[0].id;
  assert.equal(foundActivity.rows[0].product_id, products[0].id);
  assert.equal(foundActivity.rows[0].details_revision, 0);
  const oldCard = await app.inject({ method: 'GET', url: `/api/activities/${activityId}`, headers: { 'x-test-user': 'a' } });
  assert.equal(oldCard.statusCode, 200, oldCard.body);
  assert.equal(oldCard.json().revision, 0);

  const changedApplicant = await uploadApplication('a30-applicant-update.json', '+7 900 001 02 02', products[0].name);
  assert.equal(changedApplicant.preview[0].status, 'changed_requires_review');
  await imports.confirm(kamA, changedApplicant.id, {
    revision: changedApplicant.revision, idempotencyKey: `a30-applicant-update-${suffix}`, rowNumbers: [2], reviewedRows: [2],
  });
  assert.equal((await pool.query('SELECT details_revision FROM activities WHERE id=$1', [activityId])).rows[0].details_revision, 0,
    'Updating applicant contact data while keeping the same linked product does not advance activity-details revision.');

  const changedProduct = await uploadApplication('a30-product-update.json', '+7 900 001 02 02', products[1].name);
  assert.equal(changedProduct.preview[0].status, 'changed_requires_review');
  await imports.confirm(kamA, changedProduct.id, {
    revision: changedProduct.revision, idempotencyKey: `a30-product-update-${suffix}`, rowNumbers: [2], reviewedRows: [2],
  });
  const afterProductChange = await pool.query(`SELECT a.details_revision,ap.product_id::text AS product_id
    FROM activities a JOIN activity_products ap ON ap.activity_id=a.id WHERE a.id=$1`, [activityId]);
  assert.deepEqual(afterProductChange.rows[0], { details_revision: 1, product_id: products[1].id },
    'A product-link change and its revision are committed together.');
  const staleDetailsUpdate = await app.inject({ method: 'PUT', url: `/api/activities/${activityId}/details`, headers: { 'x-test-user': 'a' }, payload: {
    personId: foundActivity.rows[0].person_id, productIds: [products[0].id], priority: oldCard.json().priority, expectedRevision: oldCard.json().revision,
  } });
  assert.equal(staleDetailsUpdate.statusCode, 409, staleDetailsUpdate.body);
  assert.equal(staleDetailsUpdate.json().code, 'activity_revision_conflict');
  await imports.confirm(kamA, changedProduct.id, {
    revision: changedProduct.revision, idempotencyKey: `a30-product-retry-${suffix}`, rowNumbers: [2], reviewedRows: [2],
  });
  assert.equal((await pool.query('SELECT details_revision FROM activities WHERE id=$1', [activityId])).rows[0].details_revision, 1,
    'A repeated application of the same imported row leaves the revision unchanged.');
});

test('A119 product imports block new hidden links while preserving or removing existing links', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const actor: Actor = { sub: `a119-import-${suffix}`, name: 'A119 import owner', roles: ['kam'] };
  const source = `A119 hidden product import ${suffix}`;
  const vendorKey = `vendor-${suffix}`;
  const applicationKey = `application-${suffix}`;
  const product = { id: randomUUID(), name: `A119 linked product ${suffix}` };
  const imports = new PostgresImportService();
  const jobIds: string[] = [];
  let vendorId: string | undefined;
  let activityId: string | undefined;
  let personId: string | undefined;
  await pool.query('INSERT INTO products(id,name,catalog_visible) VALUES($1,$2,true)', [product.id, product.name]);
  context.after(async () => {
    if (jobIds.length) {
      await pool.query('DELETE FROM import_provenance WHERE job_id=ANY($1::uuid[])', [jobIds]);
      await pool.query('DELETE FROM import_jobs WHERE id=ANY($1::uuid[])', [jobIds]);
    }
    await pool.query('DELETE FROM import_identities WHERE owner_sub=$1 AND source_system=$2', [actor.sub, source]);
    if (activityId) await pool.query('DELETE FROM activities WHERE id=$1', [activityId]);
    if (personId) await pool.query('DELETE FROM people WHERE id=$1', [personId]);
    if (vendorId) {
      await pool.query('DELETE FROM vendor_products WHERE vendor_id=$1', [vendorId]);
      await pool.query('DELETE FROM vendors WHERE id=$1', [vendorId]);
    }
    await pool.query('DELETE FROM products WHERE id=$1', [product.id]);
  });

  const makeVendorJob = async (key: string, name: string, productNames: string, filename: string) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['External ID', 'Vendor name', 'Products'], [key, name, productNames]]), 'A119');
    const job = await imports.upload(actor, filename, 'vendors', source, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    jobIds.push(job.id);
    const preview = await imports.preview(actor, job.id, { revision: job.revision, selectedSheet: 'A119', headerRow: 1, mapping: { '0': 'externalKey', '1': 'name', '2': 'productNames' } });
    return { id: job.id, revision: preview.revision as number, row: (preview.preview as { status: string; errors: string[] }[])[0] };
  };
  const makeApplicationJob = async (fullName: string, phone: string, productName: string, filename: string) => {
    const bytes = Buffer.from(JSON.stringify({ applications: [{ applicationId: applicationKey,
      applicant: { fullName, email: `a119-${suffix}@example.test`, phone }, productName }] }));
    const job = await imports.upload(actor, filename, 'individual_applications', source, bytes);
    jobIds.push(job.id);
    const preview = await imports.preview(actor, job.id, { revision: job.revision, selectedSheet: 'applications', headerRow: 1,
      mapping: { '0': 'externalKey', '1': 'fullName', '2': 'email', '3': 'phone', '4': 'productName' } });
    return { id: job.id, revision: preview.revision as number, row: (preview.preview as { status: string; errors: string[] }[])[0] };
  };
  const confirm = (job: { id: string; revision: number }, key: string, reviewedRows: number[] = []) => imports.confirm(actor, job.id, {
    revision: job.revision, idempotencyKey: `${key}-${suffix}`, rowNumbers: [2], reviewedRows,
  });

  const vendorSeed = await makeVendorJob(vendorKey, `A119 vendor ${suffix}`, product.name, 'a119-vendor-seed.xlsx');
  assert.equal(vendorSeed.row.status, 'valid');
  assert.equal((await confirm(vendorSeed, 'vendor-seed')).rowResults[0].status, 'created');
  vendorId = (await pool.query('SELECT id FROM vendors WHERE owner_sub=$1 AND import_external_key=$2', [actor.sub, vendorKey])).rows[0].id;
  await pool.query('UPDATE products SET catalog_visible=false WHERE id=$1', [product.id]);
  const vendorPreserve = await makeVendorJob(vendorKey, `A119 vendor updated ${suffix}`, product.name, 'a119-vendor-preserve.xlsx');
  assert.equal(vendorPreserve.row.status, 'changed_requires_review', 'An already linked hidden product can remain linked during an approved update.');
  assert.equal((await confirm(vendorPreserve, 'vendor-preserve', [2])).rowResults[0].status, 'updated');
  assert.equal((await pool.query('SELECT 1 FROM vendor_products WHERE vendor_id=$1 AND product_id=$2', [vendorId, product.id])).rowCount, 1);
  const vendorRemove = await makeVendorJob(vendorKey, `A119 vendor updated ${suffix}`, '', 'a119-vendor-remove.xlsx');
  assert.equal(vendorRemove.row.status, 'changed_requires_review');
  assert.equal((await confirm(vendorRemove, 'vendor-remove', [2])).rowResults[0].status, 'updated');
  assert.equal((await pool.query('SELECT 1 FROM vendor_products WHERE vendor_id=$1 AND product_id=$2', [vendorId, product.id])).rowCount, 0,
    'An explicitly confirmed update can remove the prior hidden link.');
  const vendorReadd = await makeVendorJob(vendorKey, `A119 vendor updated ${suffix}`, product.name, 'a119-vendor-readd.xlsx');
  assert.equal(vendorReadd.row.status, 'invalid');
  assert.match(vendorReadd.row.errors.join(' '), /Скрытый продукт/);
  assert.equal((await confirm(vendorReadd, 'vendor-readd')).rowResults[0].status, 'skipped');
  const newVendor = await makeVendorJob(`new-${suffix}`, `A119 new vendor ${suffix}`, product.name, 'a119-vendor-hidden-new.xlsx');
  assert.equal(newVendor.row.status, 'invalid');
  assert.equal((await confirm(newVendor, 'vendor-hidden-new')).rowResults[0].status, 'skipped');
  assert.equal((await pool.query('SELECT id FROM vendors WHERE owner_sub=$1 AND import_external_key=$2', [actor.sub, `new-${suffix}`])).rowCount, 0);

  await pool.query('UPDATE products SET catalog_visible=true WHERE id=$1', [product.id]);
  const vendorStaleVisibility = await makeVendorJob(`stale-${suffix}`, `A119 stale vendor ${suffix}`, product.name, 'a119-vendor-stale-visibility.xlsx');
  assert.equal(vendorStaleVisibility.row.status, 'valid');
  await pool.query('UPDATE products SET catalog_visible=false WHERE id=$1', [product.id]);
  assert.equal((await confirm(vendorStaleVisibility, 'vendor-stale-visibility')).rowResults[0].status, 'conflict',
    'Confirmation rechecks product visibility after preview.');
  assert.equal((await pool.query('SELECT id FROM vendors WHERE owner_sub=$1 AND import_external_key=$2', [actor.sub, `stale-${suffix}`])).rowCount, 0);

  await pool.query('UPDATE products SET catalog_visible=true WHERE id=$1', [product.id]);
  const applicationSeed = await makeApplicationJob(`A119 applicant ${suffix}`, '+7 900 119 00 01', product.name, 'a119-application-seed.json');
  assert.equal(applicationSeed.row.status, 'valid');
  assert.equal((await confirm(applicationSeed, 'application-seed')).rowResults[0].status, 'created');
  const application = (await pool.query(`SELECT a.id,a.person_id FROM activities a WHERE a.owner_sub=$1 AND a.origin_source=$2 AND a.origin_reference=$3`,
    [actor.sub, source, applicationKey])).rows[0];
  activityId = application.id; personId = application.person_id;
  await pool.query('UPDATE products SET catalog_visible=false WHERE id=$1', [product.id]);
  const applicationPreserve = await makeApplicationJob(`A119 applicant updated ${suffix}`, '+7 900 119 00 02', product.name, 'a119-application-preserve.json');
  assert.equal(applicationPreserve.row.status, 'changed_requires_review', 'An existing application can retain its hidden product link.');
  assert.equal((await confirm(applicationPreserve, 'application-preserve', [2])).rowResults[0].status, 'updated');
  assert.equal((await pool.query('SELECT 1 FROM activity_products WHERE activity_id=$1 AND product_id=$2', [activityId, product.id])).rowCount, 1);

  const applicationRemove = await makeApplicationJob(`A119 applicant updated ${suffix}`, '+7 900 119 00 02', '', 'a119-application-remove.json');
  assert.equal(applicationRemove.row.status, 'changed_requires_review');
  assert.equal((await confirm(applicationRemove, 'application-remove', [2])).rowResults[0].status, 'updated');
  assert.equal((await pool.query('SELECT 1 FROM activity_products WHERE activity_id=$1 AND product_id=$2', [activityId, product.id])).rowCount, 0);
  const applicationReadd = await makeApplicationJob(`A119 must stay unchanged ${suffix}`, '+7 900 119 00 03', product.name, 'a119-application-readd.json');
  assert.equal(applicationReadd.row.status, 'invalid');
  assert.match(applicationReadd.row.errors.join(' '), /Скрытый продукт/);
  assert.equal((await confirm(applicationReadd, 'application-readd')).rowResults[0].status, 'skipped');
  const unchangedPerson = (await pool.query('SELECT full_name,phone FROM people WHERE id=$1', [personId])).rows[0];
  assert.deepEqual(unchangedPerson, { full_name: `A119 applicant updated ${suffix}`, phone: '+7 900 119 00 02' },
    'A rejected hidden product does not change applicant personal data.');

  await pool.query('UPDATE products SET catalog_visible=true WHERE id=$1', [product.id]);
  const applicationStaleVisibility = await makeApplicationJob(`A119 stale applicant ${suffix}`, '+7 900 119 00 04', product.name, 'a119-application-stale-visibility.json');
  assert.equal(applicationStaleVisibility.row.status, 'changed_requires_review');
  await pool.query('UPDATE products SET catalog_visible=false WHERE id=$1', [product.id]);
  assert.equal((await confirm(applicationStaleVisibility, 'application-stale-visibility', [2])).rowResults[0].status, 'conflict');
  assert.deepEqual((await pool.query('SELECT full_name,phone FROM people WHERE id=$1', [personId])).rows[0], unchangedPerson,
    'A visibility change between preview and confirmation rolls back applicant personal data.');
  assert.equal((await pool.query('SELECT 1 FROM activity_products WHERE activity_id=$1 AND product_id=$2', [activityId, product.id])).rowCount, 0);
});

test('A43 university reports count independent activities despite shared organization, products, and contract contexts', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const actor: Actor = { sub: `a43-university-kam-${suffix}`, name: 'A43 university KAM', roles: ['kam'] };
  const peer: Actor = { sub: `a43-university-peer-${suffix}`, name: 'A43 university peer', roles: ['kam'] };
  const testAuthenticate: Authenticator = async (request) => {
    if (request.headers['x-test-user'] === 'a43') return actor;
    if (request.headers['x-test-user'] === 'peer') return peer;
    throw new DomainError(401, 'unauthorized', 'Войдите в рабочее пространство.');
  };
  const app = buildApp({ repository: new PostgresRepository(), authenticate: testAuthenticate });
  await app.ready();
  const headers = { 'x-test-user': 'a43' };
  const activityIds: string[] = [];
  let organizationId: string | undefined;
  const productIds = [randomUUID(), randomUUID()];
  context.after(async () => {
    await app.close();
    await pool.query('DELETE FROM report_jobs WHERE actor_sub=$1', [actor.sub]);
    if (activityIds.length) await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [activityIds]);
    if (organizationId) await pool.query('DELETE FROM organizations WHERE id=$1::uuid', [organizationId]);
    await pool.query('DELETE FROM products WHERE id=ANY($1::uuid[])', [productIds]);
    await pool.query('DELETE FROM known_crm_users WHERE user_sub=ANY($1::text[])', [[actor.sub, peer.sub]]);
  });

  await pool.query('INSERT INTO products(id,name) VALUES($1::uuid,$3),($2::uuid,$4)', [
    productIds[0], productIds[1], `A43 product 1 ${suffix}`, `A43 product 2 ${suffix}`,
  ]);
  const first = await app.inject({ method: 'POST', url: '/api/activities', headers, payload: {
    kind: 'university', title: `A43 agreement activity ${suffix}`, organizationName: `A43 university ${suffix}`, productIds,
  } });
  assert.equal(first.statusCode, 201, first.body);
  const firstId = first.json().id as string;
  activityIds.push(firstId);
  const firstCard = await app.inject({ method: 'GET', url: `/api/activities/${firstId}`, headers });
  assert.equal(firstCard.statusCode, 200, firstCard.body);
  organizationId = firstCard.json().organizationId;

  const createInOrganization = async (title: string, linkedProducts: string[] = []) => {
    const response = await app.inject({ method: 'POST', url: '/api/activities', headers, payload: {
      kind: 'university', title: `${title} ${suffix}`, organizationId, productIds: linkedProducts,
    } });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().id as string;
    activityIds.push(id);
    return id;
  };
  const secondId = await createInOrganization('A43 early activity', [productIds[0]]);
  const thirdId = await createInOrganization('A43 later activity');
  const ids = [firstId, secondId, thirdId];

  const contractContexts = [
    { title: 'A43 signed agreement', contractReference: `A43-${suffix}-01`, contractStatus: 'signed', licenseExpiryPrecision: 'exact_date', licenseExpiresOn: '2031-12-31', licenseExpiresYear: null, documentId: null, note: 'Signed context.' },
    { title: 'A43 draft license', contractReference: `A43-${suffix}-02`, contractStatus: 'draft', licenseExpiryPrecision: 'year', licenseExpiresOn: null, licenseExpiresYear: 2033, documentId: null, note: 'Draft context.' },
  ];
  for (const contract of contractContexts) {
    const response = await app.inject({ method: 'POST', url: `/api/activities/${firstId}/contract-licenses`, headers, payload: contract });
    assert.equal(response.statusCode, 201, response.body);
  }
  const firstContexts = await app.inject({ method: 'GET', url: `/api/activities/${firstId}/contract-licenses`, headers });
  assert.equal(firstContexts.statusCode, 200, firstContexts.body);
  assert.equal(firstContexts.json().length, 2, 'Two independent contract/license records belong to one activity.');
  const earlyContexts = await app.inject({ method: 'GET', url: `/api/activities/${secondId}/contract-licenses`, headers });
  assert.equal(earlyContexts.statusCode, 200, earlyContexts.body);
  assert.deepEqual(earlyContexts.json(), [], 'An early activity in the same organization may have no contract context.');

  const transition = async (activityId: string, targetStage: string) => {
    const card = await app.inject({ method: 'GET', url: `/api/activities/${activityId}`, headers });
    assert.equal(card.statusCode, 200, card.body);
    const changed = await app.inject({ method: 'POST', url: `/api/activities/${activityId}/transition`, headers, payload: {
      targetStage, expectedStageKey: card.json().stageKey, expectedWorkflowRevision: card.json().workflowRevision,
    } });
    assert.equal(changed.statusCode, 200, changed.body);
  };
  await transition(secondId, 'meeting');
  await transition(thirdId, 'meeting');
  await transition(thirdId, 'documents');
  const stepCases = [
    { id: firstId, status: 'documented', note: 'A43 confirmed contact.' },
    { id: secondId, status: 'waiting', note: 'A43 waiting for reply.' },
    { id: thirdId, status: 'in_progress', note: 'A43 documents in progress.' },
  ];
  for (const step of stepCases) {
    const response = await app.inject({ method: 'PUT', url: `/api/activities/${step.id}/university-steps/U01`, headers, payload: {
      status: step.status, note: step.note, expectedRevision: 0,
    } });
    assert.equal(response.statusCode, 200, response.body);
  }
  const outcomes = ['connected', 'awaiting_reply', 'no_answer'];
  for (const [index, outcome] of outcomes.entries()) {
    const response = await app.inject({ method: 'POST', url: `/api/activities/${ids[index]}/outcomes`, headers, payload: {
      outcome, note: `A43 distinct history ${index + 1}.`,
    } });
    assert.equal(response.statusCode, 201, response.body);
  }
  const cards = await Promise.all(ids.map((id) => app.inject({ method: 'GET', url: `/api/activities/${id}`, headers })));
  assert.deepEqual(cards.map((response) => response.json().stageKey), ['contact', 'meeting', 'documents']);
  assert.deepEqual(cards.map((response) => response.json().awaitingReply), [false, true, false]);
  const stepViews = await Promise.all(ids.map((id) => app.inject({ method: 'GET', url: `/api/activities/${id}/university-steps`, headers })));
  assert.deepEqual(stepViews.map((response) => response.json().steps.find((step: { stepId: string }) => step.stepId === 'U01').status), ['documented', 'waiting', 'in_progress']);
  for (const [index, id] of ids.entries()) {
    const history = await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers });
    assert.equal(history.statusCode, 200, history.body);
    assert.ok(history.json().some((event: { eventType: string; details: { outcome?: string } }) => event.eventType === 'outcome_recorded' && event.details.outcome === outcomes[index]));
  }

  const portfolioResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers, payload: {
    reportId: 'crm_portfolio', filters: { kind: 'university', includeClosed: true },
  } });
  assert.equal(portfolioResponse.statusCode, 201, portfolioResponse.body);
  const portfolio = portfolioResponse.json();
  assert.equal(portfolio.rowCount, 3, 'Report rows count activities, not the shared organization, products, or contract contexts.');
  assert.equal(portfolio.metrics.find((metric: { key: string }) => metric.key === 'activities').value, 3);
  assert.equal(portfolio.chart.series.find((item: { filter?: { kind?: string } }) => item.filter?.kind === 'university').value, 3);
  assert.deepEqual(new Set(portfolio.rows.map((row: { activityId: string }) => row.activityId)), new Set(ids));
  assert.equal(portfolio.rows.filter((row: { organizationName: string }) => row.organizationName === `A43 university ${suffix}`).length, 3);
  assert.deepEqual(portfolio.rows.find((row: { activityId: string }) => row.activityId === firstId).productLinks.map((product: { id: string }) => product.id).sort(), [...productIds].sort());
  assert.equal(portfolio.rows.find((row: { activityId: string }) => row.activityId === secondId).productLinks.length, 1);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${firstId}`, headers: { 'x-test-user': 'peer' } })).statusCode, 404,
    'A peer KAM cannot read the fixture activity owned by this KAM.');
  assert.equal((await app.inject({ method: 'GET', url: `/api/reports/snapshots/${portfolio.snapshotId}`, headers: { 'x-test-user': 'peer' } })).statusCode, 404,
    'A peer KAM cannot read the private report snapshot.');

  const demandResponse = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers, payload: {
    reportId: 'demand_learning', filters: { kind: 'university', includeClosed: true },
  } });
  assert.equal(demandResponse.statusCode, 201, demandResponse.body);
  const demand = demandResponse.json();
  assert.equal(demand.rowCount, 3);
  const linkedActivities = demand.charts.find((chart: { id: string }) => chart.id === 'product-activity-links');
  assert.deepEqual(productIds.map((id) => linkedActivities.series.find((series: { filter?: { productId?: string } }) => series.filter?.productId === id)?.value), [2, 1],
    'Product chart values count unique activities with independent stage, state, and history.');
});
