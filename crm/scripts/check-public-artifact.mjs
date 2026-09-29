#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicHttpsOrigin } from './public-origin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = publicHttpsOrigin(process.env.VITE_API_URL, 'VITE_API_URL');
const auth = publicHttpsOrigin(process.env.VITE_KEYCLOAK_URL, 'VITE_KEYCLOAK_URL');
const assets = path.join(root, 'dist/assets');
const filenames = (await readdir(assets)).filter((name) => name.endsWith('.js'));
if (filenames.length === 0) throw new Error('No frontend JavaScript found in dist/assets.');
const bundle = (await Promise.all(filenames.map((name) => readFile(path.join(assets, name), 'utf8')))).join('\n');
for (const [label, value] of [['API', api], ['Keycloak', auth]]) {
  if (!bundle.includes(value)) throw new Error(`${label} public origin is missing from the built frontend.`);
}
for (const value of ['http://localhost:18080', 'http://localhost:3001', 'http://127.0.0.1:18080', 'http://127.0.0.1:3001']) {
  if (bundle.includes(value)) throw new Error(`Local service origin leaked into the public frontend: ${value}`);
}
const intakeConfig = await readFile(path.join(root, 'dist/request/config.js'), 'utf8').catch(() => '');
if (!intakeConfig.includes(api)) throw new Error('Configured API origin is missing from the generated public intake config.');
for (const filename of ['index.html', 'request.css', 'request.js']) {
  const content = await readFile(path.join(root, 'dist/request', filename), 'utf8').catch(() => '');
  if (!content) throw new Error(`Public intake page asset is missing: ${filename}.`);
}
const cat = await readFile(path.join(root, 'dist/request/cat-mascot.png')).catch(() => null);
if (!cat || cat.length < 1024) throw new Error('Public intake cat mascot is missing or empty.');
for (const value of ['http://localhost:3001', 'http://127.0.0.1:3001']) {
  if (intakeConfig.includes(value)) throw new Error(`Local API origin leaked into the public intake config: ${value}`);
}
console.log('Public frontend artifact contains the configured API and Keycloak origins without local service origins.');
