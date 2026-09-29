import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import { registerImportRoutes } from '../src/import-api.js';
import { pool } from '../src/db/connection.js';
import type { Actor } from '../src/domain.js';
import { PostgresImportService } from '../src/import-service.js';

test('admin import summary is read-only, bounded, and exposes only sanitized job metadata', async () => {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const role = request.headers['x-test-role'];
    const roles = role === 'admin' || role === 'manager' ? [String(role)] : ['kam'];
    request.actor = { sub: 'secret-actor-sub', name: 'Sensitive Actor Name', email: 'sensitive@example.test', roles } satisfies Actor;
  });
  registerImportRoutes(app, new PostgresImportService());

  const statements: string[] = [];
  const originalQuery = pool.query;
  pool.query = (async (sql: string) => {
    statements.push(sql);
    if (sql.includes('GROUP BY status')) return { rows: [
      { status: 'uploaded', count: 4 }, { status: 'preview_ready', count: 2 },
      { status: 'completed', count: 3 }, { status: 'expired', count: 1 },
    ] } as never;
    if (sql.includes('GROUP BY target')) return { rows: [
      { target: 'contacts', count: 5 }, { target: 'vendors', count: 3 }, { target: 'individual_applications', count: 2 },
    ] } as never;
    if (sql.includes('SELECT count(*)::int AS count FROM import_jobs j')) return { rows: [{ count: 7 }] } as never;
    return { rows: [{
      id: 'e21ce4b8-d155-4fac-9803-0e042c5a0baf', target: 'contacts', status: 'preview_ready',
      created_at: '2026-09-28T08:00:00.000Z', expires_at: '2026-09-29T08:00:00.000Z',
      preview_rows_requiring_resolution: 2,
      file_name: 'private.xlsx', source_system: 'private source', actor_name: 'Sensitive Actor Name', actor_sub: 'secret-actor-sub',
      payload: { raw: 'private row' }, mapping: { 1: 'email' },
    }] } as never;
  }) as typeof pool.query;

  try {
    for (const role of ['kam', 'manager']) {
      const denied = await app.inject({ method: 'GET', url: '/api/admin/imports/summary', headers: { 'x-test-role': role } });
      assert.equal(denied.statusCode, 403, `${role} must not read the administrative import summary`);
    }
    assert.equal(statements.length, 0, 'denied roles must not trigger database reads');

    const response = await app.inject({ method: 'GET', url: '/api/admin/imports/summary', headers: { 'x-test-role': 'admin' } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body, {
      counts: {
        byStatus: { uploaded: 4, preview_ready: 2, completed: 3, expired: 1 },
        byTarget: { contacts: 5, vendors: 3, individual_applications: 2 },
        previewRowsRequiringResolution: 7,
      },
      recentJobs: [{
        id: 'e21ce4b8-d155-4fac-9803-0e042c5a0baf', target: 'contacts', status: 'preview_ready',
        created_at: '2026-09-28T08:00:00.000Z', expires_at: '2026-09-29T08:00:00.000Z',
        previewRowsRequiringResolution: 2,
      }],
    });
    assert.ok(statements.some((sql) => /LIMIT 20\s*$/.test(sql.trim())), 'recent jobs must be capped at 20');
    const resolutionQueries = statements.filter((sql) => sql.includes("'possible_duplicate','changed_requires_review'"));
    assert.equal(resolutionQueries.length, 2, 'the aggregate and recent-job counts use the same unresolved-row rule');
    for (const sql of resolutionQueries) {
      assert.match(sql, /NOT EXISTS\s*\(SELECT 1 FROM import_applied_rows/i,
        'rows already recorded as applied are excluded from review counts');
    }
    for (const sql of statements) {
      assert.match(sql.trim(), /^SELECT\b/i, 'the admin summary must only read import data');
      assert.doesNotMatch(sql, /\b(payload|file_name|source_system|actor_name|actor_sub|mapping|raw_headings)\b/i,
        'summary SQL must not select sensitive import details');
    }
    assert.doesNotMatch(response.body, /private\.xlsx|private source|Sensitive Actor Name|secret-actor-sub|private row|email/);
  } finally {
    pool.query = originalQuery;
    await app.close();
  }
});
