const base = process.env.KEYCLOAK_URL ?? 'http://localhost:18080';
const username = process.env.KC_ADMIN_USER;
const password = process.env.KC_ADMIN_PASSWORD;
const requestedWebOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

if (!username || !password) throw new Error('Local Keycloak administrator credentials are missing.');
const webUrl = new URL(requestedWebOrigin);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(webUrl.hostname);
if (!['http:', 'https:'].includes(webUrl.protocol) || (webUrl.protocol === 'http:' && !loopback) ||
  webUrl.username || webUrl.password || webUrl.pathname !== '/' || webUrl.search || webUrl.hash) {
  throw new Error('WEB_ORIGIN must be one HTTPS origin, or an HTTP loopback origin for the local stand.');
}
const webOrigin = webUrl.origin;

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

await waitUntilReady();
const signIn = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username, password }),
});
if (!signIn.ok) throw new Error(`Keycloak administrator sign-in failed (${signIn.status}).`);
const { access_token: token } = await signIn.json();
const realmUrl = `${base}/admin/realms/lct`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const currentResponse = await fetch(realmUrl, { headers });
if (!currentResponse.ok) throw new Error(`Could not read the local realm (${currentResponse.status}).`);
const current = await currentResponse.json();
const desired = {
  loginTheme: 'rtk-crm',
  displayName: 'РТК CRM',
  displayNameHtml: 'РТК CRM',
  internationalizationEnabled: true,
  supportedLocales: ['ru'],
  defaultLocale: 'ru',
};
const needsUpdate = Object.entries(desired).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value));
if (needsUpdate) {
  const response = await fetch(realmUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(desired),
  });
  if (!response.ok) throw new Error(`Could not configure the local login theme (${response.status}).`);
}
const verifyResponse = await fetch(realmUrl, { headers });
if (!verifyResponse.ok) throw new Error(`Could not verify the local login theme (${verifyResponse.status}).`);
const actual = await verifyResponse.json();
if (Object.entries(desired).some(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value))) {
  throw new Error('The local login theme configuration did not persist.');
}
const clientsUrl = `${realmUrl}/clients?clientId=lct-web`;
const clientsResponse = await fetch(clientsUrl, { headers });
if (!clientsResponse.ok) throw new Error(`Could not read the CRM login client (${clientsResponse.status}).`);
const clients = await clientsResponse.json();
const client = clients.find((item) => item.clientId === 'lct-web');
if (!client?.id) throw new Error('The CRM login client lct-web is missing.');
const clientUrl = `${realmUrl}/clients/${client.id}`;
const clientResponse = await fetch(clientUrl, { headers });
if (!clientResponse.ok) throw new Error(`Could not read the CRM login client details (${clientResponse.status}).`);
const currentClient = await clientResponse.json();
const redirectUris = [`${webOrigin}/*`];
const webOrigins = [webOrigin];
if (JSON.stringify(currentClient.redirectUris) !== JSON.stringify(redirectUris) || JSON.stringify(currentClient.webOrigins) !== JSON.stringify(webOrigins)) {
  const updated = await fetch(clientUrl, { method: 'PUT', headers, body: JSON.stringify({ ...currentClient, redirectUris, webOrigins }) });
  if (!updated.ok) throw new Error(`Could not configure the CRM login redirect (${updated.status}).`);
}
const verifiedClientResponse = await fetch(clientUrl, { headers });
if (!verifiedClientResponse.ok) throw new Error(`Could not verify the CRM login redirect (${verifiedClientResponse.status}).`);
const verifiedClient = await verifiedClientResponse.json();
if (JSON.stringify(verifiedClient.redirectUris) !== JSON.stringify(redirectUris) || JSON.stringify(verifiedClient.webOrigins) !== JSON.stringify(webOrigins)) {
  throw new Error('The CRM login redirect configuration did not persist.');
}
console.log('Local Keycloak login theme, Russian locale, and CRM redirect origin are configured.');
