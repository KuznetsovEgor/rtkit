#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_BASE = 'http://127.0.0.1:3003';
const KEYCLOAK_BASE = 'http://localhost:18080';
const CMS_BASE = 'http://127.0.0.1:3103';
const LMS_BASE = 'http://127.0.0.1:3104';
const EXPECTED_ISSUER = `${KEYCLOAK_BASE}/realms/lct`;
const SENTINEL_ACTIVITY_ID = 'a3000000-0000-4000-8000-000000000001';
const SENTINEL_TITLE = 'Полярный маяк — встреча о цифровых навыках';
const ACTIVITY_TITLE = 'СИНТЕТИЧЕСКИЕ ДАННЫЕ · LMS mock — учебная проекция';
const PERSON_NAME = 'Синтетический участник LMS mock (демо)';
const ACTIVITY_SEARCH = PERSON_NAME;
const IDEMPOTENCY_KEY = 'synthetic-demo-lms-projection-v1';
const FACT_KINDS = Object.freeze(['enrollment', 'learning_started']);
const STAGE_PATH = Object.freeze({ request: 'consultation', consultation: 'conditions', conditions: 'lms_handoff' });
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) return { dryRun: true };
  if (args.length === 1 && args[0] === '--apply-local-demo') return { apply: true };
  throw new Error('Use --dry-run (default), --apply-local-demo, or --help. Endpoint and database overrides are not supported.');
}

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function assertLoopbackEndpoint(value, expectedPort) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Local demo endpoints must be valid loopback HTTP URLs.'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || Number(url.port) !== expectedPort || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Local demo endpoint must use loopback HTTP on port ${expectedPort}.`);
  }
  return url;
}

export function assertSyntheticActivity(activity, actorSub) {
  if (!activity || activity.kind !== 'individual' || activity.title !== ACTIVITY_TITLE || activity.personName !== PERSON_NAME
    || activity.origin !== 'manual' || activity.routeVersion !== 'v2' || activity.closed !== false
    || activity.ownerSub !== actorSub || typeof activity.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activity.id)) {
    throw new Error('The synthetic LMS activity is missing, changed, closed, or outside the signed-in QA KAM scope.');
  }
  return activity;
}

export function validateMockEvents(events, { activityId, correlationId }) {
  if (!Array.isArray(events)) throw new Error('The local LMS mock returned an invalid events list.');
  const seenKinds = new Set();
  const prefix = `lms-fact-${correlationId}-`;
  for (const event of events) {
    if (!event || event.eventType !== 'learning.fact' || event.correlationId !== correlationId
      || event.activityReference !== activityId || !FACT_KINDS.includes(event.factKind)
      || event.eventId !== `${prefix}${event.factKind}` || !/^LMS-MOCK-[A-Za-z0-9-]+$/.test(event.reference ?? '')
      || !Number.isFinite(Date.parse(event.occurredAt)) || seenKinds.has(event.factKind)) {
      throw new Error('The local LMS mock contains events outside this synthetic demo projection; no LMS pull was sent.');
    }
    seenKinds.add(event.factKind);
  }
  return { eventCount: events.length, factKinds: [...seenKinds].sort() };
}

export function validateProjectedFacts(facts, correlationId) {
  if (!Array.isArray(facts)) throw new Error('The CRM API returned an invalid read-only learning projection.');
  const expectedReference = `LMS-MOCK-${correlationId.slice(0, 8)}`;
  const seenKinds = new Set();
  for (const fact of facts) {
    if (!fact || !FACT_KINDS.includes(fact.factKind) || fact.source !== 'LMS mock'
      || fact.reference !== expectedReference || !Number.isFinite(Date.parse(fact.occurredAt)) || seenKinds.has(fact.factKind)) {
      throw new Error('The CRM learning projection contains facts outside this synthetic LMS mock scenario.');
    }
    seenKinds.add(fact.factKind);
  }
  return { factCount: facts.length, factKinds: [...seenKinds].sort() };
}

function help() {
  console.log(`Populate the isolated local lctcrm_demo with two synthetic LMS mock facts.

Preview (default):
  node scripts/populate-demo-lms-projection.mjs --dry-run

Apply through the CRM API and local Keycloak/LMS mock:
  node scripts/populate-demo-lms-projection.mjs --apply-local-demo

The script is fixed to API 127.0.0.1:3003, Keycloak localhost:18080,
and the demo CMS/LMS mocks 127.0.0.1:3103/3104. It reads the existing
kam.anna and admin passwords from .env.local, creates one clearly synthetic
individual activity through the CRM API, and requests enrollment plus learning_started.
It does not create payment or completion data. Repeated runs reuse the activity
and LMS request idempotency key; the mock event IDs and CRM pull are deduplicated.
`);
}

async function readLocalCredentials() {
  let values;
  try { values = parseEnv(await readFile(path.join(ROOT, '.env.local'), 'utf8')); }
  catch { throw new Error('crm/.env.local is required. Start the ordinary local stand once to create the QA passwords.'); }
  if (!values.KAM_ANNA_PASSWORD || !values.LOCAL_ADMIN_PASSWORD) {
    throw new Error('The existing local KAM/admin passwords are missing from .env.local.');
  }
  return { kamPassword: values.KAM_ANNA_PASSWORD, adminPassword: values.LOCAL_ADMIN_PASSWORD };
}

async function localFetch(url, init = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Refusing to contact a non-loopback endpoint.');
  }
  return fetch(parsed, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
}

async function jsonResponse(response, label) {
  const value = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== 'object') {
    throw new Error(`${label} did not return the expected local JSON response (HTTP ${response.status}).`);
  }
  return value;
}

async function checkHealth(base, port, pathPart, expectedService) {
  assertLoopbackEndpoint(base, port);
  const response = await localFetch(`${base}${pathPart}`);
  const body = await jsonResponse(response, expectedService);
  if (body.status !== 'ok' || (expectedService && body.service !== expectedService) || (expectedService !== 'crm-api' && body.mode !== 'mock')) {
    throw new Error(`${expectedService ?? 'Local service'} health check did not identify the expected service.`);
  }
  return body;
}

function decodeClaims(token) {
  try {
    const segment = token.split('.')[1];
    if (!segment) throw new Error('missing payload');
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Local Keycloak returned an invalid access token.');
  }
}

async function login(username, password, requiredRole) {
  const response = await localFetch(`${KEYCLOAK_BASE}/realms/lct/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'lct-web', username, password }),
  });
  const result = await jsonResponse(response, 'Local Keycloak login');
  if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('Local Keycloak returned no access token.');
  const claims = decodeClaims(result.access_token);
  const roles = claims.realm_access?.roles;
  if (claims.azp !== 'lct-web' || typeof claims.sub !== 'string' || !claims.sub
    || !Number.isFinite(Number(claims.exp)) || Number(claims.exp) * 1000 <= Date.now()
    || !Array.isArray(roles) || !roles.includes(requiredRole)) {
    throw new Error(`The existing local ${requiredRole} account did not receive its expected CRM role.`);
  }
  return { token: result.access_token, sub: claims.sub };
}

async function requestApi(pathPart, { token, method = 'GET', body } = {}) {
  const headers = { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await localFetch(`${API_BASE}${pathPart}`, init);
  const value = await response.json().catch(() => null);
  if (!response.ok || value === null) {
    throw new Error(`Demo CRM API ${method} ${pathPart} failed (HTTP ${response.status}).`);
  }
  return value;
}

async function requestMockEvents() {
  const response = await localFetch(`${LMS_BASE}/events`);
  const value = await jsonResponse(response, 'Local LMS mock events');
  return value.events;
}

async function checkDemoServices() {
  const apiHealth = await checkHealth(API_BASE, 3003, '/health', 'crm-api');
  await checkHealth(CMS_BASE, 3103, '/health', 'CMS mock');
  await checkHealth(LMS_BASE, 3104, '/health', 'LMS mock');
  const discoveryResponse = await localFetch(`${KEYCLOAK_BASE}/realms/lct/.well-known/openid-configuration`);
  const discovery = await jsonResponse(discoveryResponse, 'Local Keycloak discovery');
  if (discovery.issuer !== EXPECTED_ISSUER || discovery.token_endpoint !== `${EXPECTED_ISSUER}/protocol/openid-connect/token`
    || discovery.jwks_uri !== `${EXPECTED_ISSUER}/protocol/openid-connect/certs`) {
    throw new Error('Local Keycloak discovery does not match the fixed demo login realm.');
  }
  // API startup checks the database marker; this seeded, fixed demo fixture also
  // distinguishes the port-3003 demo API from the ordinary CRM API.
  return apiHealth;
}

async function findOrCreateSyntheticActivity(kam) {
  const query = new URLSearchParams({ segment: 'individual', collection: 'all', q: ACTIVITY_SEARCH, limit: '100' });
  let page = await requestApi(`/api/activities?${query}`, { token: kam.token });
  if (!Array.isArray(page.items) || page.total > page.items.length) throw new Error('Demo CRM API returned an incomplete activity search.');
  let matches = page.items.filter((item) => item.personName === PERSON_NAME || item.title === ACTIVITY_TITLE);
  if (matches.length > 1) throw new Error('Multiple matching synthetic LMS activities exist; refusing to create or change another one.');
  if (matches.length === 0) {
    const existingMockEvents = await requestMockEvents();
    if (!Array.isArray(existingMockEvents) || existingMockEvents.length !== 0) {
      throw new Error('The local LMS mock already has events; no synthetic CRM activity was created.');
    }
    const created = await requestApi('/api/activities', {
      token: kam.token, method: 'POST',
      body: { kind: 'individual', title: ACTIVITY_TITLE, personName: PERSON_NAME, priority: 3 },
    });
    if (typeof created?.id !== 'string') throw new Error('Demo CRM API did not confirm creation of the synthetic LMS activity.');
  }
  // Re-read by the synthetic contact marker to recover safely if a prior run
  // stopped after the POST was committed but before its response arrived.
  page = await requestApi(`/api/activities?${query}`, { token: kam.token });
  if (!Array.isArray(page.items) || page.total > page.items.length) throw new Error('Demo CRM API returned an incomplete activity search.');
  matches = page.items.filter((item) => item.personName === PERSON_NAME || item.title === ACTIVITY_TITLE);
  if (matches.length !== 1 || matches[0].title !== ACTIVITY_TITLE || matches[0].personName !== PERSON_NAME) {
    throw new Error('The synthetic LMS activity could not be uniquely recovered through the CRM API.');
  }
  const activity = await requestApi(`/api/activities/${encodeURIComponent(matches[0].id)}`, { token: kam.token });
  return assertSyntheticActivity(activity, kam.sub);
}

async function advanceToLmsHandoff(kam, initial) {
  let activity = initial;
  for (let count = 0; activity.stageKey !== 'lms_handoff' && count < Object.keys(STAGE_PATH).length; count += 1) {
    const next = STAGE_PATH[activity.stageKey];
    if (!next || !Array.isArray(activity.allowedNext) || !activity.allowedNext.includes(next)) {
      throw new Error('The synthetic LMS activity is outside the expected server-advertised individual workflow path.');
    }
    await requestApi(`/api/activities/${encodeURIComponent(activity.id)}/transition`, {
      token: kam.token, method: 'POST',
      body: { targetStage: next, expectedStageKey: activity.stageKey, expectedWorkflowRevision: activity.workflowRevision ?? null },
    });
    activity = await requestApi(`/api/activities/${encodeURIComponent(activity.id)}`, { token: kam.token });
    assertSyntheticActivity(activity, kam.sub);
  }
  if (activity.stageKey !== 'lms_handoff') throw new Error('The synthetic LMS activity did not reach lms_handoff within the expected route.');
  return activity;
}

async function findOutboundJob(kam, activityId) {
  const jobs = await requestApi(`/api/activities/${encodeURIComponent(activityId)}/exchanges`, { token: kam.token });
  if (!Array.isArray(jobs)) throw new Error('Demo CRM API returned an invalid exchange list.');
  const matches = jobs.filter((job) => job.direction === 'crm_to_lms' && job.system === 'lms'
    && job.operation === 'prepare_access' && job.activityId === activityId && job.idempotencyKey === IDEMPOTENCY_KEY);
  if (matches.length > 1) throw new Error('Multiple stable synthetic LMS requests exist; refusing to continue.');
  return matches[0] ?? null;
}

async function ensureAcceptedLmsRequest(kam, activityId) {
  const prior = await findOutboundJob(kam, activityId);
  const priorEvents = await requestMockEvents();
  if (prior) validateMockEvents(priorEvents, { activityId, correlationId: prior.correlationId });
  else if (!Array.isArray(priorEvents) || priorEvents.length !== 0) {
    throw new Error('The local LMS mock already has unrelated events; no new LMS request was sent.');
  }
  await requestApi(`/api/activities/${encodeURIComponent(activityId)}/exchanges/lms-requests`, {
    token: kam.token, method: 'POST', body: { idempotencyKey: IDEMPOTENCY_KEY },
  });
  let job = await findOutboundJob(kam, activityId);
  if (!job) throw new Error('The stable synthetic LMS request was not found in the activity exchange history.');
  if (job.status === 'queued' || job.status === 'retryable_error') {
    await requestApi(`/api/exchanges/${encodeURIComponent(job.id)}/retry`, { token: kam.token, method: 'POST' });
    job = await findOutboundJob(kam, activityId);
    if (!job) throw new Error('The stable synthetic LMS request disappeared from the activity exchange history.');
  }
  if (!['accepted', 'performed'].includes(job.status)) throw new Error(`The local LMS request is not accepted (status: ${String(job.status)}).`);
  return job;
}

async function ensureAdminMockAccess(admin) {
  const monitor = await requestApi('/api/admin/exchanges', { token: admin.token });
  for (const name of ['cms', 'lms']) {
    if (monitor?.services?.[name]?.mode !== 'mock' || monitor.services[name].status !== 'ok') {
      throw new Error(`The demo API is not connected to its local ${name.toUpperCase()} mock.`);
    }
  }
}

async function runApply() {
  // Assert every pinned endpoint before loading credentials or opening a connection.
  assertLoopbackEndpoint(API_BASE, 3003);
  assertLoopbackEndpoint(KEYCLOAK_BASE, 18080);
  assertLoopbackEndpoint(CMS_BASE, 3103);
  assertLoopbackEndpoint(LMS_BASE, 3104);
  await checkDemoServices();
  const credentials = await readLocalCredentials();
  const [kam, admin] = await Promise.all([
    login('kam.anna', credentials.kamPassword, 'kam'),
    login('admin', credentials.adminPassword, 'admin'),
  ]);
  await ensureAdminMockAccess(admin);

  const sentinel = await requestApi(`/api/activities/${SENTINEL_ACTIVITY_ID}`, { token: kam.token });
  if (sentinel?.id !== SENTINEL_ACTIVITY_ID || sentinel.kind !== 'university' || sentinel.title !== SENTINEL_TITLE) {
    throw new Error('The demo API did not return the fixed seeded fixture; database marker verification could not be inferred.');
  }

  let activity = await findOrCreateSyntheticActivity(kam);
  activity = await advanceToLmsHandoff(kam, activity);
  const outbound = await ensureAcceptedLmsRequest(kam, activity.id);

  validateMockEvents(await requestMockEvents(), { activityId: activity.id, correlationId: outbound.correlationId });
  for (const factKind of FACT_KINDS) {
    await requestApi(`/api/admin/exchanges/lms/${encodeURIComponent(outbound.id)}/outcome`, {
      token: admin.token, method: 'POST', body: { outcome: 'perform', factKind },
    });
  }
  const mockEventState = validateMockEvents(await requestMockEvents(), { activityId: activity.id, correlationId: outbound.correlationId });
  if (mockEventState.eventCount !== FACT_KINDS.length || FACT_KINDS.some((kind) => !mockEventState.factKinds.includes(kind))) {
    throw new Error('The local LMS mock did not return the two expected synthetic learning events.');
  }

  let facts = await requestApi(`/api/activities/${encodeURIComponent(activity.id)}/learning-facts`, { token: kam.token });
  let projected = validateProjectedFacts(facts, outbound.correlationId);
  if (projected.factCount < FACT_KINDS.length) {
    const pull = await requestApi('/api/admin/exchanges/lms/pull', { token: admin.token, method: 'POST' });
    if (pull?.status !== 'accepted' || pull?.summary?.rejected !== 0 || pull?.summary?.deferred !== 0) {
      throw new Error('The demo CRM API did not accept the LMS mock pull cleanly.');
    }
    facts = await requestApi(`/api/activities/${encodeURIComponent(activity.id)}/learning-facts`, { token: kam.token });
    projected = validateProjectedFacts(facts, outbound.correlationId);
  }
  const projectedKinds = projected.factKinds;
  if (projected.factCount !== FACT_KINDS.length || projectedKinds.join(',') !== [...FACT_KINDS].sort().join(',')) {
    throw new Error('The read-only CRM learning projection does not contain exactly the two permitted LMS mock facts.');
  }

  console.log(`Demo LMS projection ready: 1 clearly synthetic individual activity, ${facts.length} read-only LMS mock facts (${projectedKinds.join(', ')}).`);
  console.log('No payment or learning completion was created. Re-running reuses the stable activity and LMS idempotency key.');
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) return help();
  if (options.dryRun) {
    console.log('Dry run: no local services or credentials were read.');
    console.log(`Would use ${API_BASE}, ${KEYCLOAK_BASE}, ${CMS_BASE}, and ${LMS_BASE}.`);
    console.log(`Would create/reuse one synthetic individual activity and request only: ${FACT_KINDS.join(', ')}.`);
    return;
  }
  await runApply();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Local synthetic LMS projection failed.');
    process.exitCode = 1;
  });
}
