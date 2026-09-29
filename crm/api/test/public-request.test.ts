import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../web/public/request/request.js', import.meta.url), 'utf8');
type Payload = Record<string, string>;
type Response = { ok: boolean; status: number; json: () => Promise<unknown> };
type Fetch = (url: string, init: { body: string; signal?: AbortSignal }) => Promise<Response>;
const accepted = (duplicate = false): Response => ({ ok: true, status: 202, json: async () => ({ accepted: true, duplicate }) });

// Execute the actual standalone browser script with a small DOM boundary. No server
// or public data is involved; the transport and clock are controlled by each test.
function browser(fetch: Fetch) {
  const element = (value = '') => ({
    value, hidden: false, disabled: false, required: false, validity: { valid: true },
    textContent: '', innerHTML: 'Отправить заявку', dataset: {} as Record<string, string>,
    listeners: new Map<string, (event: { preventDefault: () => void }) => unknown>(),
    addEventListener(name: string, handler: (event: { preventDefault: () => void }) => unknown) { this.listeners.set(name, handler); },
    setAttribute() {}, removeAttribute() {}, focus() {}, classList: { toggle() {} },
  });
  const fields = {
    kind: element('university'), name: element('Тестовый заявитель'), email: element('person@example.test'),
    phone: element(''), organization: element('Тестовый университет'), note: element('Обсудить учебную программу'), website: element(''),
  };
  const form = { ...element(), elements: fields, reset() {} };
  const success = { ...element(), hidden: true };
  const button = element();
  const error = element();
  const mark = element();
  const organization = { ...element(), firstChild: element(), querySelector: () => mark };
  const nodes: Record<string, unknown> = {
    '#inquiry-form': form, '.organization-field': organization, '#success-card': success,
    '#form-error': error, '#submit-button': button, '#another-request': element(), '#success-copy': element(),
  };
  const tabs = ['university', 'corporate', 'individual'].map(kind => ({ ...element(), dataset: { tabKind: kind } }));
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule = (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; };
  const cancel = (id: number) => timers.delete(id);
  runInNewContext(source, {
    document: { querySelector: (selector: string) => nodes[selector], querySelectorAll: () => tabs },
    window: { RTK_DEMO_CONFIG: { apiBase: 'https://api.example.test' }, setTimeout: schedule, clearTimeout: cancel },
    location: { hostname: 'example.test', protocol: 'https:' },
    crypto: { randomUUID }, AbortController, fetch,
    setTimeout: schedule, clearTimeout: cancel,
    FormData: class { get(name: keyof typeof fields) { return fields[name].value; } },
  });
  return {
    fields, form, success, button, error,
    submit: () => Promise.resolve(form.listeners.get('submit')!({ preventDefault() {} })),
    elapse(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    pendingTimers: () => timers.size,
  };
}

test('edited inquiry after a lost response is a new submission, not a false duplicate', async () => {
  const saved = new Map<string, Payload>();
  let calls = 0;
  const page = browser(async (_url, { body }) => {
    const payload = JSON.parse(body) as Payload;
    const duplicate = saved.has(payload.idempotencyKey);
    if (!duplicate) saved.set(payload.idempotencyKey, payload);
    if (++calls === 1) throw new TypeError('Response was lost after the server committed');
    return accepted(duplicate);
  });
  await page.submit();
  assert.equal(saved.size, 1);
  assert.equal(page.form.hidden, false);
  page.fields.note.value = 'Другая программа для отдельного обращения';
  await page.submit();
  assert.equal(saved.size, 2, 'the changed inquiry must not disappear behind the first idempotency key');
  assert.equal([...saved.values()][1].note, page.fields.note.value);
  assert.equal(page.success.hidden, false);
});

test('unchanged inquiry reuses its key after a lost response', async () => {
  const requests: Payload[] = [];
  const page = browser(async (_url, { body }) => {
    requests.push(JSON.parse(body));
    if (requests.length === 1) throw new TypeError('Connection lost');
    return accepted(true);
  });
  await page.submit();
  await page.submit();
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(page.success.hidden, false);
});

test('stalled submission times out, preserves input and can retry without creating a duplicate', async () => {
  const requests: Payload[] = [];
  let aborted = false;
  const page = browser(async (_url, { body, signal }) => {
    requests.push(JSON.parse(body));
    if (requests.length > 1) return accepted(true);
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('Request timed out'));
    }, { once: true }));
  });
  const pending = page.submit();
  assert.equal(page.button.disabled, true);
  page.elapse(15_000);
  await setImmediate();
  assert.equal(aborted, true, 'the request must have a finite deadline');
  await pending;
  assert.equal(page.button.disabled, false);
  assert.equal(page.form.hidden, false);
  assert.equal(page.success.hidden, true);
  assert.equal(page.fields.note.value, 'Обсудить учебную программу');
  assert.ok(page.error.textContent.length > 0);
  await page.submit();
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(page.success.hidden, false);
  assert.equal(page.pendingTimers(), 0);
});

test('a completed submission leaves no deadline timer', async () => {
  const page = browser(async () => accepted());
  await page.submit();
  assert.equal(page.button.disabled, false);
  assert.equal(page.success.hidden, false);
  assert.equal(page.pendingTimers(), 0);
});

test('deadline also covers a stalled response body without displaying success', async () => {
  const page = browser(async (_url, { signal }) => ({
    ok: true, status: 202,
    json: () => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Body interrupted')), { once: true })),
  }));
  const pending = page.submit();
  await setImmediate();
  page.elapse(15_000);
  await pending;
  assert.equal(page.success.hidden, true);
  assert.equal(page.form.hidden, false);
  assert.equal(page.button.disabled, false);
  assert.ok(page.error.textContent.length > 0);
  assert.equal(page.pendingTimers(), 0);
});

test('another submit while waiting does not start a competing request', async () => {
  let calls = 0;
  let finish!: (response: Response) => void;
  const page = browser(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = page.submit();
  await page.submit();
  assert.equal(calls, 1);
  finish(accepted());
  await pending;
  assert.equal(page.success.hidden, false);
});
