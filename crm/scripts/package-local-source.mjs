#!/usr/bin/env node
import { readdir, stat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const crmRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.dirname(crmRoot);
const archive = path.join(crmRoot, 'delivery', 'RTK_CRM_source_local_20260928.zip');
const roots = [
  '.gitignore', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'index.html', 'run-local.sh',
  'api/tsconfig.json', 'api/src', 'api/assets', 'api/migrations', 'api/test',
  'web/src', 'web/public', 'web/vite.config.ts',
  'infra/docker-compose.yml', 'infra/postgres-init.sql', 'infra/keycloak/lct-realm.json', 'infra/keycloak/themes/rtk-crm',
  'scripts', 'docs',
];

async function filesWithin(relative) {
  const absolute = path.join(crmRoot, relative);
  const info = await stat(absolute);
  if (info.isFile()) return [relative];
  if (!info.isDirectory()) throw new Error(`Unsupported source item: ${relative}`);
  const result = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    result.push(...await filesWithin(path.join(relative, entry.name)));
  }
  return result;
}

const files = (await Promise.all(roots.map(filesWithin))).flat().sort();
if (!files.length || files.some((name) => name.includes('\n') || name.includes('\r'))) throw new Error('Invalid archive input.');
await mkdir(path.dirname(archive), { recursive: true });
await rm(archive, { force: true });
const zip = spawn('zip', ['-q', '-X', archive, '-@'], { cwd: projectRoot, stdio: ['pipe', 'inherit', 'inherit'] });
zip.stdin.end(files.map((name) => `crm/${name}`).join('\n') + '\n');
const status = await new Promise((resolve, reject) => { zip.once('error', reject); zip.once('close', resolve); });
if (status !== 0) throw new Error(`zip exited with status ${status}`);
console.log(`Prepared local source archive with ${files.length} files.`);
