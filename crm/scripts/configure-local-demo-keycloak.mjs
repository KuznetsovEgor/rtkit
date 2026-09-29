const base = new URL('http://localhost:18080');
const adminUser = process.env.KC_ADMIN_USER;
const adminPassword = process.env.KC_ADMIN_PASSWORD;
const webOrigin = 'http://localhost:5174';
const redirectUri = `${webOrigin}/*`;

if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('The demo redirect helper only supports the local Keycloak instance.');
}
if (!adminUser || !adminPassword) throw new Error('Local Keycloak administrator credentials are missing.');

async function request(path, token, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Local Keycloak request failed (${response.status} ${path}).`);
  return response;
}

const signIn = await fetch(new URL('/realms/master/protocol/openid-connect/token', base), {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUser, password: adminPassword }),
});
if (!signIn.ok) throw new Error(`Local Keycloak administrator sign-in failed (${signIn.status}).`);
const { access_token: token } = await signIn.json();
const clientsResponse = await request('/admin/realms/lct/clients?clientId=lct-web', token);
const clients = await clientsResponse.json();
const client = clients.find((item) => item.clientId === 'lct-web');
if (!client?.id) throw new Error('The local CRM login client lct-web is missing.');

const clientPath = `/admin/realms/lct/clients/${encodeURIComponent(client.id)}`;
const currentResponse = await request(clientPath, token);
const current = await currentResponse.json();
const redirectUris = [...new Set([...(current.redirectUris ?? []), redirectUri])];
const webOrigins = [...new Set([...(current.webOrigins ?? []), webOrigin])];
if (redirectUris.length !== (current.redirectUris ?? []).length || webOrigins.length !== (current.webOrigins ?? []).length) {
  const updated = await fetch(new URL(clientPath, base), {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...current, redirectUris, webOrigins }),
  });
  if (!updated.ok) throw new Error(`Could not add the demo redirect to local Keycloak (${updated.status}).`);
}

const verifyResponse = await request(clientPath, token);
const verified = await verifyResponse.json();
if (!verified.redirectUris?.includes(redirectUri) || !verified.webOrigins?.includes(webOrigin)) {
  throw new Error('The demo redirect configuration did not persist in local Keycloak.');
}
console.log('Local Keycloak client lct-web accepts http://localhost:5174 and keeps its existing redirect origins.');
