#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicHttpsOrigin } from './public-origin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const webOrigin = publicHttpsOrigin(process.env.WEB_ORIGIN, 'WEB_ORIGIN');
const authOrigin = publicHttpsOrigin(process.env.KEYCLOAK_PUBLIC_ORIGIN, 'KEYCLOAK_PUBLIC_ORIGIN');
if (webOrigin === authOrigin) throw new Error('Web and Keycloak require distinct hostnames in this deployment profile.');
const source = JSON.parse(await readFile(path.join(root, 'infra/keycloak/lct-realm.json'), 'utf8'));
const client = source.clients?.find((entry) => entry.clientId === 'lct-web');
if (!client) throw new Error('The lct-web client is missing from the realm source.');
source.sslRequired = 'all';
source.users = [];
client.directAccessGrantsEnabled = false;
client.redirectUris = [`${webOrigin}/*`];
client.webOrigins = [webOrigin];
client.name = 'RTK CRM web';
const output = path.resolve(process.env.PUBLIC_REALM_OUTPUT ?? path.join(root, '.local-storage/public-realm/lct-realm.json'));
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
await chmod(output, 0o600);
console.log('Prepared a separate HTTPS-only realm configuration. No server was changed.');
