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
// Validate the files the page actually loads, including the current mascot.
const intakeHtml = await readFile(path.join(root, 'dist/request/index.html'), 'utf8');
const requestDirectory = path.join(root, 'dist/request');
for (const [, url] of intakeHtml.matchAll(/(?:src|href)=["'](\/request\/[^"']+)["']/g)) {
  const filename = path.resolve(root, 'dist', `.${url}`);
  if (!filename.startsWith(`${requestDirectory}${path.sep}`)) throw new Error('Invalid public intake asset path.');
  const content = await readFile(filename).catch(() => null);
  if (!content?.length) throw new Error(`Referenced public intake asset is missing or empty: ${url}`);
}
for (const value of ['http://localhost:3001', 'http://127.0.0.1:3001']) {
  if (intakeConfig.includes(value)) throw new Error(`Local API origin leaked into the public intake config: ${value}`);
}
console.log('Public frontend artifact contains the configured API and Keycloak origins without local service origins.');
