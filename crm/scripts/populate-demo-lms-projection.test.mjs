import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertLoopbackEndpoint, assertSyntheticActivity, parseArgs, parseEnv, validateMockEvents, validateProjectedFacts,
} from './populate-demo-lms-projection.mjs';

test('the projection runner is dry-run by default and only applies with the fixed demo flag', () => {
  assert.deepEqual(parseArgs([]), { dryRun: true });
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseArgs(['--apply-local-demo']), { apply: true });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs(['--apply-local-demo', '--api=http://example.test']), /overrides are not supported/);
  assert.throws(() => parseArgs(['--force']), /overrides are not supported/);
});

test('endpoint guard accepts only pinned loopback HTTP ports', () => {
  assert.equal(assertLoopbackEndpoint('http://127.0.0.1:3003', 3003).hostname, '127.0.0.1');
  assert.equal(assertLoopbackEndpoint('http://localhost:18080', 18080).port, '18080');
  for (const [url, port] of [
    ['https://127.0.0.1:3003', 3003],
    ['http://demo.example.net:3003', 3003],
    ['http://localhost.attacker.test:18080', 18080],
    ['http://127.0.0.1:3001', 3003],
    ['http://user:secret@127.0.0.1:3003', 3003],
    ['http://127.0.0.1:3003/api', 3003],
  ]) assert.throws(() => assertLoopbackEndpoint(url, port), /loopback HTTP/);
});

test('the env parser reads only local QA credential values without modifying them', () => {
  assert.deepEqual(parseEnv('KAM_ANNA_PASSWORD="kam-secret"\nLOCAL_ADMIN_PASSWORD=admin-secret\n# ignored'), {
    KAM_ANNA_PASSWORD: 'kam-secret', LOCAL_ADMIN_PASSWORD: 'admin-secret',
  });
});

test('synthetic activity reuse requires the exact fixture identity, route, state, and KAM owner', () => {
  const activity = {
    id: 'f1234567-1234-4123-8123-123456789abc', kind: 'individual',
    title: 'СИНТЕТИЧЕСКИЕ ДАННЫЕ · LMS mock — учебная проекция',
    personName: 'Синтетический участник LMS mock (демо)', origin: 'manual',
    routeVersion: 'v2', ownerSub: 'local-kam-subject', closed: false,
  };
  assert.equal(assertSyntheticActivity(activity, 'local-kam-subject'), activity);
  for (const change of [
    { ownerSub: 'someone-else' }, { closed: true }, { kind: 'corporate' },
    { title: 'edited by a user' }, { origin: 'external_ready' },
  ]) assert.throws(() => assertSyntheticActivity({ ...activity, ...change }, 'local-kam-subject'), /synthetic LMS activity/);
});

test('mock event validation permits only the two stable synthetic learning events', () => {
  const events = ['enrollment', 'learning_started'].map((factKind) => ({
    eventId: `lms-fact-12345678-1234-4123-8123-123456789abc-${factKind}`,
    correlationId: '12345678-1234-4123-8123-123456789abc', eventType: 'learning.fact',
    occurredAt: '2026-09-29T10:00:00.000Z', activityReference: 'f1234567-1234-4123-8123-123456789abc',
    factKind, reference: 'LMS-MOCK-12345678',
  }));
  assert.deepEqual(validateMockEvents(events, {
    activityId: 'f1234567-1234-4123-8123-123456789abc', correlationId: '12345678-1234-4123-8123-123456789abc',
  }), { eventCount: 2, factKinds: ['enrollment', 'learning_started'] });
  for (const unexpected of [
    { ...events[0], factKind: 'learning_completed', eventId: 'lms-fact-12345678-1234-4123-8123-123456789abc-learning_completed' },
    { ...events[0], activityReference: 'another-activity' },
    { ...events[0], eventType: 'payment.received' },
    { ...events[0], reference: 'PERSON@example.test' },
    { ...events[0], eventId: 'foreign-event' },
  ]) assert.throws(() => validateMockEvents([unexpected], {
    activityId: 'f1234567-1234-4123-8123-123456789abc', correlationId: '12345678-1234-4123-8123-123456789abc',
  }), /outside this synthetic demo projection/);
  assert.throws(() => validateMockEvents([events[0], events[0]], {
    activityId: 'f1234567-1234-4123-8123-123456789abc', correlationId: '12345678-1234-4123-8123-123456789abc',
  }), /outside this synthetic demo projection/);
});

test('projection verification is idempotent and rejects completion or unrelated source facts', () => {
  const correlationId = '12345678-1234-4123-8123-123456789abc';
  const facts = ['enrollment', 'learning_started'].map((factKind) => ({
    factKind, source: 'LMS mock', occurredAt: '2026-09-29T10:00:00.000Z', reference: 'LMS-MOCK-12345678',
  }));
  assert.deepEqual(validateProjectedFacts([], correlationId), { factCount: 0, factKinds: [] });
  assert.deepEqual(validateProjectedFacts(facts, correlationId), {
    factCount: 2, factKinds: ['enrollment', 'learning_started'],
  });
  for (const unexpected of [
    { ...facts[0], factKind: 'learning_completed' },
    { ...facts[0], source: 'unverified source' },
    { ...facts[0], reference: 'LMS-MOCK-other' },
    { ...facts[0], occurredAt: 'not a date' },
  ]) assert.throws(() => validateProjectedFacts([unexpected], correlationId), /outside this synthetic LMS mock scenario/);
  assert.throws(() => validateProjectedFacts([facts[0], facts[0]], correlationId), /outside this synthetic LMS mock scenario/);
});

test('the runner uses only CRM and local mock HTTP routes, without direct database writes', async () => {
  const source = await readFile(new URL('./populate-demo-lms-projection.mjs', import.meta.url), 'utf8');
  assert.match(source, /\/api\/activities\/\$\{encodeURIComponent\(activityId\)\}\/exchanges\/lms-requests/);
  assert.match(source, /\/api\/admin\/exchanges\/lms\/\$\{encodeURIComponent\(outbound\.id\)\}\/outcome/);
  assert.match(source, /\/api\/admin\/exchanges\/lms\/pull/);
  assert.match(source, /\/api\/activities\/\$\{encodeURIComponent\(activity\.id\)\}\/learning-facts/);
  assert.doesNotMatch(source, /from ['"]pg['"]|DATABASE_URL|pool\.query|INSERT\s+INTO/i);
  assert.match(source, /synthetic-demo-lms-projection-v1/);
  assert.match(source, /Object\.freeze\(\['enrollment', 'learning_started'\]\)/);
});
