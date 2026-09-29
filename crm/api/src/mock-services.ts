import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type FailureMode = 'http_error' | 'reject_next' | null;
type CmsEvent = {
  eventId: string; correlationId: string; eventType: 'inquiry.submitted'; occurredAt: string;
  lead: { kind: 'individual' | 'corporate'; title: string; personName: string; organizationName?: string; externalReference: string };
};
type LmsRequest = { correlationId: string; idempotencyKey: string; activityReference: string; operation: 'prepare_access' };
type LmsEvent = { eventId: string; correlationId: string; eventType: 'learning.fact'; occurredAt: string; activityReference: string; factKind: 'enrollment' | 'learning_started' | 'learning_completed'; reference: string };

function send(reply: ServerResponse, status: number, body: unknown) {
  reply.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  reply.end(JSON.stringify(body));
}
async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
  catch { return null; }
}
function takeFailure(mode: { value: FailureMode }) {
  const current = mode.value;
  mode.value = null;
  return current;
}
function routeRequest(server: Server, handler: (request: IncomingMessage, reply: ServerResponse) => void | Promise<void>) {
  server.on('request', (request, reply) => {
    void Promise.resolve(handler(request, reply)).catch(() => {
      if (!reply.headersSent) send(reply, 500, { code: 'mock_internal_error', message: 'Local mock service error.' });
      else reply.destroy();
    });
  });
}
export type RunningMock = { url: string; close: () => Promise<void> };
type MockOptions = { statePath?: string };
function statePath(service: 'cms' | 'lms', explicit?: string) {
  return explicit ?? resolve(process.env.CRM_MOCK_STATE_DIR ?? 'api/.mock-state', `${service}.json`);
}
function loadState<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}
function saveState(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}
function asRunning(server: Server, port: number): Promise<RunningMock> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Local mock did not bind a TCP port.'));
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

export function startCmsMock(port = Number(process.env.CMS_MOCK_PORT ?? 3101), options: MockOptions = {}): Promise<RunningMock> {
  const path = statePath('cms', options.statePath);
  const sample: CmsEvent = {
    eventId: 'cms-demo-inquiry-001', correlationId: '579b1f78-80a0-46d0-a0aa-f455b4420db7',
    eventType: 'inquiry.submitted', occurredAt: '2026-09-27T09:00:00.000Z',
    lead: { kind: 'individual', title: 'Запрос с сайта', personName: 'Анна Сергеева', externalReference: 'CMS-REQ-001' },
  };
  const restored = loadState<{ failure: FailureMode; statuses: [string, Record<string, unknown>][]; acknowledgements: [string, Record<string, unknown>][] }>(path, { failure: null, statuses: [], acknowledgements: [] });
  const fail = { value: restored.failure };
  const statuses = new Map(restored.statuses);
  const acknowledgements = new Map(restored.acknowledgements);
  const persist = () => saveState(path, { failure: fail.value, statuses: [...statuses], acknowledgements: [...acknowledgements] });
  const server = createServer();
  routeRequest(server, async (request, reply) => {
    const url = new URL(request.url ?? '/', 'http://cms-mock.local');
    if (url.pathname === '/health' && request.method === 'GET') return send(reply, 200, { service: 'CMS mock', mode: 'mock', status: 'ok' });
    if (url.pathname === '/status' && request.method === 'GET') return send(reply, 200, { service: 'CMS mock', mode: 'mock', status: 'ok', eventCount: 1, updatedStatusCount: statuses.size });
    if (url.pathname === '/control/fail-next' && request.method === 'POST') {
      const body = await readJson(request);
      if (body?.mode !== 'http_error' && body?.mode !== 'reject_next') return send(reply, 400, { code: 'invalid_mode' });
      fail.value = body.mode;
      persist();
      return send(reply, 202, { mode: 'mock', nextOperation: body.mode });
    }
    if (url.pathname === '/events' && request.method === 'GET') {
      if (fail.value === 'http_error') {
        takeFailure(fail);
        persist();
        return send(reply, 503, { code: 'mock_unavailable', message: 'Configured one-shot CMS mock failure.' });
      }
      return send(reply, 200, { mode: 'mock', events: [sample] });
    }
    const eventMatch = url.pathname.match(/^\/events\/([^/]+)\/(status|ack)$/);
    if (eventMatch && request.method === 'POST') {
      const eventId = decodeURIComponent(eventMatch[1]);
      if (eventId !== sample.eventId) return send(reply, 404, { code: 'unknown_event' });
      const mode = takeFailure(fail);
      if (mode) persist();
      if (mode === 'http_error') return send(reply, 503, { code: 'mock_unavailable', message: 'Configured one-shot CMS mock failure.' });
      if (mode === 'reject_next') return send(reply, 200, { status: 'rejected', reason: 'Configured one-shot CMS mock rejection.' });
      const body = await readJson(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !idempotencyKey || body?.status !== 'received') return send(reply, 400, { code: 'invalid_ack' });
      const prior = acknowledgements.get(idempotencyKey);
      if (prior) return send(reply, 200, { ...prior, duplicate: true });
      const response = { status: 'accepted', eventId, activityReference: body.activityReference, receivedAt: new Date().toISOString() };
      acknowledgements.set(idempotencyKey, response);
      statuses.set(eventId, response);
      persist();
      return send(reply, 200, response);
    }
    if (eventMatch && request.method === 'GET') {
      const eventId = decodeURIComponent(eventMatch[1]);
      if (eventId !== sample.eventId) return send(reply, 404, { code: 'unknown_event' });
      return send(reply, 200, { event: sample, crmStatus: statuses.get(eventId) ?? null });
    }
    return send(reply, 404, { code: 'not_found' });
  });
  return asRunning(server, port);
}

export function startLmsMock(port = Number(process.env.LMS_MOCK_PORT ?? 3102), options: MockOptions = {}): Promise<RunningMock> {
  const path = statePath('lms', options.statePath);
  const restored = loadState<{ failure: FailureMode; requests: [string, LmsRequest & { status: 'accepted' | 'performed' | 'rejected' }][]; events: [string, LmsEvent][]; acknowledgements: string[] }>(path, { failure: null, requests: [], events: [], acknowledgements: [] });
  const fail = { value: restored.failure };
  const requests = new Map(restored.requests);
  const events = new Map(restored.events);
  const eventAcknowledgements = new Set(restored.acknowledgements);
  const persist = () => saveState(path, { failure: fail.value, requests: [...requests], events: [...events], acknowledgements: [...eventAcknowledgements] });
  const server = createServer();
  routeRequest(server, async (request, reply) => {
    const url = new URL(request.url ?? '/', 'http://lms-mock.local');
    if (url.pathname === '/health' && request.method === 'GET') return send(reply, 200, { service: 'LMS mock', mode: 'mock', status: 'ok' });
    if (url.pathname === '/status' && request.method === 'GET') return send(reply, 200, { service: 'LMS mock', mode: 'mock', status: 'ok', requestCount: requests.size, eventCount: events.size });
    if (url.pathname === '/control/fail-next' && request.method === 'POST') {
      const body = await readJson(request);
      if (body?.mode !== 'http_error' && body?.mode !== 'reject_next') return send(reply, 400, { code: 'invalid_mode' });
      fail.value = body.mode;
      persist();
      return send(reply, 202, { mode: 'mock', nextOperation: body.mode });
    }
    if (url.pathname === '/requests' && request.method === 'POST') {
      const mode = takeFailure(fail);
      if (mode) persist();
      if (mode === 'http_error') return send(reply, 503, { code: 'mock_unavailable', message: 'Configured one-shot LMS mock failure.' });
      const body = await readJson(request);
      if (body?.operation !== 'prepare_access' || typeof body.correlationId !== 'string' || typeof body.idempotencyKey !== 'string' || typeof body.activityReference !== 'string') return send(reply, 400, { code: 'invalid_request' });
      if (mode === 'reject_next') return send(reply, 200, { status: 'rejected', reason: 'Configured one-shot LMS mock rejection.' });
      const scopedKey = `${body.activityReference}:${body.idempotencyKey}`;
      const prior = requests.get(scopedKey);
      if (prior) return send(reply, 200, { status: prior.status, correlationId: prior.correlationId, duplicate: true });
      const stored = body as LmsRequest;
      requests.set(scopedKey, { ...stored, status: 'accepted' });
      persist();
      return send(reply, 202, { status: 'accepted', correlationId: stored.correlationId, acceptedAt: new Date().toISOString() });
    }
    if (url.pathname === '/events' && request.method === 'GET') {
      if (fail.value === 'http_error') {
        takeFailure(fail);
        persist();
        return send(reply, 503, { code: 'mock_unavailable', message: 'Configured one-shot LMS mock failure.' });
      }
      return send(reply, 200, { mode: 'mock', events: [...events.values()] });
    }
    const controlMatch = url.pathname.match(/^\/control\/requests\/([^/]+)\/(perform|reject)$/);
    if (controlMatch && request.method === 'POST') {
      const correlationId = decodeURIComponent(controlMatch[1]);
      const item = [...requests.values()].find((entry) => entry.correlationId === correlationId);
      if (!item) return send(reply, 404, { code: 'unknown_request' });
      const mode = takeFailure(fail);
      if (mode) persist();
      if (mode === 'http_error') return send(reply, 503, { code: 'mock_unavailable', message: 'Configured one-shot LMS mock failure.' });
      if (controlMatch[2] === 'reject') {
        if (item.status === 'performed') return send(reply, 409, { code: 'already_performed', message: 'A performed LMS request cannot be rejected.' });
        item.status = 'rejected';
        persist();
        return send(reply, 200, { status: 'rejected', correlationId });
      }
      if (mode === 'reject_next') {
        item.status = 'rejected';
        persist();
        return send(reply, 200, { status: 'rejected', correlationId, reason: 'Configured one-shot LMS mock rejection.' });
      }
      const body = await readJson(request);
      const kinds = ['enrollment', 'learning_started', 'learning_completed'];
      const factKind = typeof body?.factKind === 'string' && kinds.includes(body.factKind) ? body.factKind as LmsEvent['factKind'] : 'enrollment';
      const eventId = `lms-fact-${item.correlationId}-${factKind}`;
      const event = events.get(eventId) ?? {
        eventId, correlationId: item.correlationId, eventType: 'learning.fact' as const, occurredAt: new Date().toISOString(),
        activityReference: item.activityReference, factKind, reference: `LMS-MOCK-${item.correlationId.slice(0, 8)}`,
      };
      events.set(eventId, event);
      item.status = 'performed';
      persist();
      return send(reply, 200, { status: 'performed', eventId, factKind, occurredAt: event.occurredAt, mode: 'mock' });
    }
    const ackMatch = url.pathname.match(/^\/events\/([^/]+)\/ack$/);
    if (ackMatch && request.method === 'POST') {
      const eventId = decodeURIComponent(ackMatch[1]);
      const event = events.get(eventId);
      if (!event) return send(reply, 404, { code: 'unknown_event' });
      const duplicate = eventAcknowledgements.has(eventId);
      eventAcknowledgements.add(eventId);
      persist();
      return send(reply, 200, { status: 'accepted', eventId, duplicate });
    }
    return send(reply, 404, { code: 'not_found' });
  });
  return asRunning(server, port);
}
