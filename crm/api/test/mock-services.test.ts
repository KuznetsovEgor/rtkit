import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startCmsMock, startLmsMock } from '../src/mock-services.js';

const json = async (response: Response) => response.json() as Promise<Record<string, any>>;

test('local CMS and LMS mock state survives restart and LMS returns separate learning facts', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'crm-b09-mocks-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cmsState = join(directory, 'cms.json');
  const lmsState = join(directory, 'lms.json');

  let cms = await startCmsMock(0, { statePath: cmsState });
  const cmsEventId = 'cms-demo-inquiry-001';
  const cmsAck = await fetch(`${cms.url}/events/${cmsEventId}/ack`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'test-cms-ack-1' },
    body: JSON.stringify({ status: 'received', activityReference: 'activity-test-1' }),
  });
  assert.equal(cmsAck.status, 200);
  await cms.close();
  cms = await startCmsMock(0, { statePath: cmsState });
  const cmsTruth = await json(await fetch(`${cms.url}/events/${cmsEventId}/status`));
  assert.equal(cmsTruth.crmStatus.activityReference, 'activity-test-1');
  const duplicateAck = await json(await fetch(`${cms.url}/events/${cmsEventId}/ack`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'test-cms-ack-1' },
    body: JSON.stringify({ status: 'received', activityReference: 'activity-test-1' }),
  }));
  assert.equal(duplicateAck.duplicate, true);
  await cms.close();
  assert.ok((await readFile(cmsState, 'utf8')).includes('activity-test-1'));

  let lms = await startLmsMock(0, { statePath: lmsState });
  const correlationId = '579b1f78-80a0-46d0-a0aa-f455b4420db8';
  const activityReference = '8a4be8aa-1eb9-4fd0-9f3f-7e11e6211234';
  const request = await fetch(`${lms.url}/requests`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'prepare_access', correlationId, idempotencyKey: `${activityReference}:same-key`, activityReference }),
  });
  assert.equal((await json(request)).status, 'accepted');
  for (const factKind of ['enrollment', 'learning_completed']) {
    const performed = await fetch(`${lms.url}/control/requests/${correlationId}/perform`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ factKind }),
    });
    assert.equal((await json(performed)).status, 'performed');
  }
  await lms.close();
  lms = await startLmsMock(0, { statePath: lmsState });
  const lmsEvents = await json(await fetch(`${lms.url}/events`));
  assert.deepEqual((lmsEvents.events as Array<{ factKind: string }>).map((event) => event.factKind).sort(), ['enrollment', 'learning_completed']);
  const lmsStatus = await json(await fetch(`${lms.url}/status`));
  assert.equal(lmsStatus.requestCount, 1);
  assert.equal(lmsStatus.eventCount, 2);
  await lms.close();
});
