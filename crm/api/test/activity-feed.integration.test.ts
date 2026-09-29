import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { buildApp, type Authenticator } from '../src/app.js';
import { closeRepository, PostgresRepository } from '../src/postgres-repository.js';
import { pool } from '../src/db/connection.js';
import { DomainError, type Actor } from '../src/domain.js';

const runIntegration = process.env.CRM_INTEGRATION === '1';
after(async () => { if (runIntegration) await closeRepository(); });

test('PostgreSQL activity feed, task subscriptions, notifications, and reassignment access', { skip: !runIntegration }, async (context) => {
  const suffix = randomUUID();
  const kamA: Actor = { sub: `feed-kam-a-${suffix}`, name: 'Feed KAM A', roles: ['kam'] };
  const kamB: Actor = { sub: `feed-kam-b-${suffix}`, name: 'Feed KAM B', roles: ['kam'] };
  const manager: Actor = { sub: `feed-manager-${suffix}`, name: 'Feed manager', roles: ['manager'] };
  const users: Record<string, Actor> = { a: kamA, b: kamB, manager };
  const authenticate: Authenticator = async (request: FastifyRequest) => {
    const actor = users[String(request.headers['x-test-user'])];
    if (!actor) throw new DomainError(401, 'unauthorized', 'Sign in.');
    return actor;
  };
  const app = buildApp({ repository: new PostgresRepository(), authenticate });
  await app.ready();

  const activityA = randomUUID();
  const activityB = randomUUID();
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const taskA = randomUUID();
  context.after(async () => {
    await app.close();
    await pool.query('DELETE FROM activities WHERE id=ANY($1::uuid[])', [[activityA, activityB]]);
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[organizationA, organizationB]]);
  });

  await pool.query(`INSERT INTO organizations(id,name,segment) VALUES($1,'Feed organization A','university'),($2,'Feed organization B','university')`, [organizationA, organizationB]);
  await pool.query(`INSERT INTO activities(id,kind,title,organization_id,stage_key,owner_sub,owner_name)
    VALUES($1,'university','Feed fixture A',$2,'contact',$3,$4),($5,'university','Feed fixture B',$6,'contact',$7,$8)`, [activityA, organizationA, kamA.sub, kamA.name, activityB, organizationB, kamB.sub, kamB.name]);
  await pool.query(`INSERT INTO activity_events(id,activity_id,event_type,summary,details,actor_sub,actor_name)
    VALUES($1,$2,'fixture','A authored event','{}'::jsonb,$3,$4),
      ($5,$2,'fixture','Other author event','{}'::jsonb,$6,$7),
      ($8,$9,'fixture','Other activity event','{}'::jsonb,$6,$7)`, [randomUUID(), activityA, kamA.sub, kamA.name, randomUUID(), kamB.sub, kamB.name, randomUUID(), activityB]);
  await pool.query(`INSERT INTO tasks(id,activity_id,title,due_at,owner_sub,owner_name)
    VALUES($1,$2,'Track next step',now()+interval '1 day',$3,$4)`, [taskA, activityA, kamA.sub, kamA.name]);

  const feedA = await app.inject({ method: 'GET', url: '/api/feed', headers: { 'x-test-user': 'a' } });
  assert.equal(feedA.statusCode, 200, feedA.body);
  assert.equal(feedA.json().items.length, 1);
  assert.equal(feedA.json().items[0].summary, 'A authored event');
  assert.equal(feedA.json().items[0].activityId, activityA);
  const forbiddenFilter = await app.inject({ method: 'GET', url: `/api/feed?actorSub=${encodeURIComponent(kamB.sub)}`, headers: { 'x-test-user': 'a' } });
  assert.equal(forbiddenFilter.statusCode, 403);
  assert.equal(forbiddenFilter.json().code, 'feed_actor_forbidden');

  const managerPage = await app.inject({ method: 'GET', url: '/api/feed?limit=2', headers: { 'x-test-user': 'manager' } });
  assert.equal(managerPage.statusCode, 200, managerPage.body);
  assert.equal(managerPage.json().items.length, 2);
  assert.ok(managerPage.json().nextCursor);
  const managerNext = await app.inject({ method: 'GET', url: `/api/feed?limit=2&cursor=${encodeURIComponent(managerPage.json().nextCursor)}`, headers: { 'x-test-user': 'manager' } });
  assert.equal(managerNext.statusCode, 200, managerNext.body);
  assert.ok(managerNext.json().items.length >= 1 && managerNext.json().items.length <= 2);
  assert.equal(new Set([...managerPage.json().items, ...managerNext.json().items].map((item: { id: string }) => item.id)).size,
    managerPage.json().items.length + managerNext.json().items.length, 'cursor pages do not repeat events');
  const kamFiltered = await app.inject({ method: 'GET', url: `/api/feed?actorSub=${encodeURIComponent(kamA.sub)}`, headers: { 'x-test-user': 'manager' } });
  assert.deepEqual(kamFiltered.json().items.map((item: { summary: string }) => item.summary), ['A authored event']);
  const otherKamFiltered = await app.inject({ method: 'GET', url: `/api/feed?actorSub=${encodeURIComponent(kamB.sub)}`, headers: { 'x-test-user': 'manager' } });
  assert.deepEqual(new Set(otherKamFiltered.json().items.map((item: { summary: string }) => item.summary)), new Set(['Other author event', 'Other activity event']));

  const subscribeA = await app.inject({ method: 'PUT', url: `/api/activities/${activityA}/tasks/${taskA}/subscription`, headers: { 'x-test-user': 'a' } });
  assert.equal(subscribeA.statusCode, 200, subscribeA.body);
  assert.deepEqual(subscribeA.json(), { subscribed: true });
  const subscriptionRead = await app.inject({ method: 'GET', url: `/api/activities/${activityA}/tasks/${taskA}/subscription`, headers: { 'x-test-user': 'a' } });
  assert.deepEqual(subscriptionRead.json(), { subscribed: true });
  const managerSubscribe = await app.inject({ method: 'PUT', url: `/api/activities/${activityA}/tasks/${taskA}/subscription`, headers: { 'x-test-user': 'manager' } });
  assert.equal(managerSubscribe.statusCode, 200, managerSubscribe.body);
  const deniedSubscribe = await app.inject({ method: 'PUT', url: `/api/activities/${activityA}/tasks/${taskA}/subscription`, headers: { 'x-test-user': 'b' } });
  assert.equal(deniedSubscribe.statusCode, 404);

  const update = await app.inject({ method: 'POST', url: `/api/activities/${activityA}/tasks/${taskA}/updates`, headers: { 'x-test-user': 'a' }, payload: { text: 'Customer confirmed the next step.' } });
  assert.equal(update.statusCode, 201, update.body);
  assert.equal(update.json().eventType, 'task_updated');
  assert.equal(update.json().summary, 'Обновление по действию «Track next step»');
  assert.equal(update.json().text, 'Customer confirmed the next step.');
  const authorNotifications = await app.inject({ method: 'GET', url: '/api/notifications', headers: { 'x-test-user': 'a' } });
  assert.equal(authorNotifications.statusCode, 200, authorNotifications.body);
  assert.equal(authorNotifications.json().unreadCount, 0, 'the author is excluded even when subscribed');
  assert.deepEqual(authorNotifications.json().items, []);
  const managerNotifications = await app.inject({ method: 'GET', url: '/api/notifications', headers: { 'x-test-user': 'manager' } });
  assert.equal(managerNotifications.json().unreadCount, 1);
  assert.equal(managerNotifications.json().items[0].eventType, 'task_updated');
  assert.equal(managerNotifications.json().items[0].text, 'Customer confirmed the next step.');
  const managerNotificationId = managerNotifications.json().items[0].id as string;
  const markedRead = await app.inject({ method: 'POST', url: `/api/notifications/${managerNotificationId}/read`, headers: { 'x-test-user': 'manager' } });
  assert.equal(markedRead.statusCode, 200, markedRead.body);
  assert.ok(markedRead.json().readAt);
  const readAgain = await app.inject({ method: 'POST', url: `/api/notifications/${managerNotificationId}/read`, headers: { 'x-test-user': 'manager' } });
  assert.equal(readAgain.json().readAt, markedRead.json().readAt, 'reading is idempotent');
  const afterRead = await app.inject({ method: 'GET', url: '/api/notifications', headers: { 'x-test-user': 'manager' } });
  assert.equal(afterRead.json().unreadCount, 0);
  assert.ok(afterRead.json().items[0].readAt);

  const completed = await app.inject({ method: 'POST', url: `/api/activities/${activityA}/tasks/${taskA}/complete`, headers: { 'x-test-user': 'a' } });
  assert.equal(completed.statusCode, 200, completed.body);
  const completionNotifications = await app.inject({ method: 'GET', url: '/api/notifications', headers: { 'x-test-user': 'manager' } });
  assert.equal(completionNotifications.json().unreadCount, 1);
  assert.equal(completionNotifications.json().items[0].eventType, 'task_completed');
  const completionAuthorNotifications = await app.inject({ method: 'GET', url: '/api/notifications', headers: { 'x-test-user': 'a' } });
  assert.equal(completionAuthorNotifications.json().unreadCount, 0, 'a completion does not notify its author');
  assert.deepEqual(completionAuthorNotifications.json().items, []);

  const reassigned = await pool.query('UPDATE activities SET owner_sub=$2,owner_name=$3,assignment_revision=assignment_revision+1 WHERE id=$1', [activityA, kamB.sub, kamB.name]);
  assert.equal(reassigned.rowCount, 1);
  const updateAfterReassignment = await app.inject({ method: 'POST', url: `/api/activities/${activityA}/tasks/${taskA}/updates`, headers: { 'x-test-user': 'b' }, payload: { text: 'Update after reassignment.' } });
  assert.equal(updateAfterReassignment.statusCode, 201, updateAfterReassignment.body);
  const newOwnerFeed = await app.inject({ method: 'GET', url: '/api/feed', headers: { 'x-test-user': 'b' } });
  assert.equal(newOwnerFeed.json().items.find((item: { eventType: string }) => item.eventType === 'task_updated')?.text, 'Update after reassignment.');
  const inaccessibleNotifications = await app.inject({ method: 'GET', url: '/api/notifications', headers: { 'x-test-user': 'a' } });
  assert.equal(inaccessibleNotifications.statusCode, 200);
  assert.deepEqual(inaccessibleNotifications.json().items, [], 'reassignment removes old owner notification visibility');
  const revokedNotification = await pool.query(`SELECT n.id FROM activity_notifications n JOIN activity_events e ON e.id=n.event_id
    WHERE n.activity_id=$1 AND n.recipient_sub=$2 AND e.details->>'text'='Update after reassignment.'`, [activityA, kamA.sub]);
  assert.equal(revokedNotification.rowCount, 1);
  const deniedRead = await app.inject({ method: 'POST', url: `/api/notifications/${revokedNotification.rows[0]!.id}/read`, headers: { 'x-test-user': 'a' } });
  assert.equal(deniedRead.statusCode, 404);
  assert.equal(deniedRead.json().code, 'notification_not_found');

  await pool.query('UPDATE activities SET closed=TRUE WHERE id=$1', [activityA]);
  const subscribeClosed = await app.inject({ method: 'PUT', url: `/api/activities/${activityA}/tasks/${taskA}/subscription`, headers: { 'x-test-user': 'b' } });
  assert.equal(subscribeClosed.statusCode, 409);
  const unsubscribe = await app.inject({ method: 'DELETE', url: `/api/activities/${activityA}/tasks/${taskA}/subscription`, headers: { 'x-test-user': 'b' } });
  assert.equal(unsubscribe.statusCode, 200, unsubscribe.body);
  assert.deepEqual(unsubscribe.json(), { subscribed: false });
});
