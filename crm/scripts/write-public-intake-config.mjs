import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const configured = process.env.VITE_API_URL ?? 'http://localhost:3001';
const api = new URL(configured);
if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash) {
  throw new Error('VITE_API_URL for the public intake page must be an HTTP(S) origin without credentials, query, or fragment.');
}
const target = resolve(process.argv[2] ?? 'dist/request/config.js');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `window.RTK_DEMO_CONFIG=Object.freeze({apiBase:${JSON.stringify(api.origin)}});\n`, { mode: 0o644 });
console.log(`Wrote public demo API origin to ${target}.`);
