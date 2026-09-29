import pg from 'pg';

const password = process.env.POSTGRES_PASSWORD;
if (!password) throw new Error('Local PostgreSQL password is missing.');
const connectionString = `postgres://lctcrm:${encodeURIComponent(password)}@127.0.0.1:54329/postgres`;
const client = new pg.Client({ connectionString });
await client.connect();
try {
  const found = await client.query("SELECT 1 FROM pg_database WHERE datname='lctcrm_integration'");
  if (!found.rowCount) await client.query('CREATE DATABASE lctcrm_integration');
} finally {
  await client.end();
}
console.log('Separate local integration-test database is ready.');
