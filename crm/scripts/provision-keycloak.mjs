import pg from 'pg';

const base = process.env.KEYCLOAK_URL ?? 'http://localhost:18080';
const adminUser = process.env.KC_ADMIN_USER;
const adminPassword = process.env.KC_ADMIN_PASSWORD;
if (!adminUser || !adminPassword) throw new Error('Local Keycloak administrator credentials are missing.');
if (!process.env.DATABASE_URL) throw new Error('CRM database connection is missing; run this through ./run-local.sh.');

async function waitUntilReady() {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${base}/realms/lct/.well-known/openid-configuration`);
      if (response.ok) return;
    } catch { /* Keycloak is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('Keycloak did not become ready within two minutes.');
}

async function request(path, token, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Keycloak admin request failed (${response.status} ${path}).`);
  }
  return response;
}

await waitUntilReady();
const tokenResponse = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUser, password: adminPassword }),
});
if (!tokenResponse.ok) throw new Error('Could not sign in to the local Keycloak admin realm.');
const { access_token: token } = await tokenResponse.json();

const users = [
  { id: '10000000-0000-4000-8000-000000000001', username: 'kam.anna', firstName: 'Анна', lastName: 'Орлова', email: 'anna.kam@local.test', role: 'kam', password: process.env.KAM_ANNA_PASSWORD },
  { id: '10000000-0000-4000-8000-000000000002', username: 'kam.dmitry', firstName: 'Дмитрий', lastName: 'Соколов', email: 'dmitry.kam@local.test', role: 'kam', password: process.env.KAM_DMITRY_PASSWORD },
  { id: '10000000-0000-4000-8000-000000000003', username: 'manager', firstName: 'Елена', lastName: 'Руководитель', email: 'manager@local.test', role: 'manager', password: process.env.MANAGER_PASSWORD },
  { id: '10000000-0000-4000-8000-000000000004', username: 'admin', firstName: 'Алексей', lastName: 'Администратор', email: 'admin@local.test', role: 'admin', password: process.env.LOCAL_ADMIN_PASSWORD },
];

const provisionedUsers = [];
for (const user of users) {
  if (!user.password) throw new Error(`Missing local password for ${user.username}.`);
  const lookup = async () => {
    const response = await request(`/admin/realms/lct/users?username=${encodeURIComponent(user.username)}&exact=true`, token);
    const matches = await response.json();
    return matches.find((item) => item.username === user.username);
  };
  let existing = await lookup();
  if (!existing) {
    await request('/admin/realms/lct/users', token, {
      method: 'POST',
      body: JSON.stringify({ username: user.username, firstName: user.firstName, lastName: user.lastName, email: user.email, enabled: true, emailVerified: true }),
    });
    existing = await lookup();
  }
  if (!existing?.id) throw new Error(`Keycloak did not return the local account ${user.username}.`);
  await request(`/admin/realms/lct/users/${existing.id}/reset-password`, token, {
    method: 'PUT', body: JSON.stringify({ type: 'password', value: user.password, temporary: false }),
  });
  const roleResponse = await request(`/admin/realms/lct/roles/${user.role}`, token);
  const role = await roleResponse.json();
  await request(`/admin/realms/lct/users/${existing.id}/role-mappings/realm`, token, { method: 'POST', body: JSON.stringify([role]) });
  provisionedUsers.push({ sub: existing.id, name: `${user.firstName} ${user.lastName}`, role: user.role, enabled: existing.enabled === true });
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  // Keep the lock hierarchy used by CRM revocation and reassignment: global
  // policy gate, known-user rows, then the KAM directory.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('crm-access-policy'))");
  for (const user of provisionedUsers) {
    await client.query(`INSERT INTO known_crm_users(user_sub,display_name,realm_roles,provision_source,last_seen_at)
      VALUES($1,$2,ARRAY[$3]::text[],'local-keycloak-provisioning',now())
      ON CONFLICT(user_sub) DO UPDATE SET display_name=EXCLUDED.display_name,
        realm_roles=EXCLUDED.realm_roles, provision_source=EXCLUDED.provision_source`, [user.sub, user.name, user.role]);
  }
  await client.query(`UPDATE kam_directory SET enabled=FALSE, updated_at=now()
    WHERE provision_source='local-keycloak-provisioning'`);
  for (const user of provisionedUsers.filter((entry) => entry.role === 'kam')) {
    await client.query(`INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source,updated_at)
      VALUES($1,$2,$3,'local-keycloak-provisioning',now())
      ON CONFLICT(user_sub) DO UPDATE SET display_name=EXCLUDED.display_name, enabled=EXCLUDED.enabled,
        provision_source=EXCLUDED.provision_source, updated_at=EXCLUDED.updated_at`, [user.sub, user.name, user.enabled]);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
console.log('Local Keycloak realm and four test-account records are synchronized; disabled accounts remain disabled. Passwords remain in the ignored .env.local file.');
