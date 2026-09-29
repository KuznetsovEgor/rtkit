import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;
const syntheticDemoDatabase = 'lctcrm_demo';
const syntheticDemoMarker = 'lct CRM synthetic_demo isolated database v1';
const syntheticDemoSentinelActivityId = 'a3000000-0000-4000-8000-000000000001';

export function assertDemoDatabaseTarget(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error('CRM_DEMO_MODE requires DATABASE_URL for the isolated local demo database.');

  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error('CRM_DEMO_MODE requires a valid PostgreSQL DATABASE_URL.');
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !loopbackHosts.has(target.hostname) || databaseName !== syntheticDemoDatabase) {
    throw new Error(`CRM_DEMO_MODE is restricted to a loopback PostgreSQL connection for ${syntheticDemoDatabase}.`);
  }
}

if (process.env.CRM_DEMO_MODE === '1') assertDemoDatabaseTarget(process.env.DATABASE_URL);

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export async function assertDemoDatabaseMarker() {
  if (process.env.CRM_DEMO_MODE !== '1') return;
  const result = await pool.query<{ database_name: string; marker: string | null; seeded: boolean }>(
    `SELECT current_database() AS database_name,
      shobj_description(oid, 'pg_database') AS marker,
      EXISTS (SELECT 1 FROM activities WHERE id = $1::uuid) AS seeded
     FROM pg_database WHERE datname = current_database()`,
    [syntheticDemoSentinelActivityId],
  );
  const target = result.rows[0];
  if (target?.database_name !== syntheticDemoDatabase || target.marker !== syntheticDemoMarker || target.seeded !== true) {
    throw new Error(`CRM_DEMO_MODE requires the seeded ${syntheticDemoDatabase} database marker and fixture.`);
  }
}
