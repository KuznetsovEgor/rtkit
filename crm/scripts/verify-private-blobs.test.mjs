import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SafeInspectionError, validateMetadataSnapshot, verifyPrivateBlobConsistency } from './verify-private-blobs.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const tempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'crm-private-blob-check-'));
  const documentRoot = path.join(root, 'documents');
  const reportRoot = path.join(root, 'reports');
  await mkdir(documentRoot, { mode: 0o700 });
  await mkdir(reportRoot, { mode: 0o700 });
  await chmod(documentRoot, 0o700);
  await chmod(reportRoot, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, documentRoot, reportRoot };
}

async function writeBlob(root, key, bytes, mode = 0o600) {
  const filePath = path.join(root, `${key}.blob`);
  await writeFile(filePath, bytes, { mode });
  await chmod(filePath, mode);
  return filePath;
}

test('reports an aggregate-only clean match for document and report blobs', async (t) => {
  const roots = await fixture(t);
  const documentBytes = Buffer.from('synthetic private document');
  const reportBytes = Buffer.from('synthetic private report');
  const documentKey = randomUUID();
  const reportKey = randomUUID();
  await writeBlob(roots.documentRoot, documentKey, documentBytes);
  await writeBlob(roots.reportRoot, reportKey, reportBytes);

  const result = await verifyPrivateBlobConsistency({
    schemaVersion: 1,
    documents: [{ key: documentKey, sizeBytes: documentBytes.length, sha256: digest(documentBytes) }],
    reports: [{ key: reportKey, sizeBytes: reportBytes.length, sha256: digest(reportBytes) }],
  }, roots);

  assert.equal(result.ok, true);
  assert.equal(result.documents.blobCount, 1);
  assert.equal(result.reports.blobCount, 1);
  assert.equal(result.documents.checksumMismatchCount, 0);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
  assert.equal(JSON.stringify(result).includes(documentKey), false);
});

test('counts missing, orphaned, size-mismatched, and checksum-mismatched files', async (t) => {
  const roots = await fixture(t);
  const sizeKey = randomUUID();
  const missingKey = randomUUID();
  const orphanKey = randomUUID();
  const checksumKey = randomUUID();
  const sizeBytes = Buffer.from('short');
  const reportBytes = Buffer.from('same length');
  await writeBlob(roots.documentRoot, sizeKey, sizeBytes);
  await writeBlob(roots.documentRoot, orphanKey, Buffer.from('orphan payload'));
  await writeBlob(roots.reportRoot, checksumKey, reportBytes);

  const result = await verifyPrivateBlobConsistency({
    schemaVersion: 1,
    documents: [
      { key: sizeKey, sizeBytes: sizeBytes.length + 1, sha256: digest(sizeBytes) },
      { key: missingKey, sizeBytes: 4, sha256: digest(Buffer.from('none')) },
    ],
    reports: [{ key: checksumKey, sizeBytes: reportBytes.length, sha256: digest(Buffer.from('other value')) }],
  }, roots);

  assert.equal(result.ok, false);
  assert.equal(result.documents.missingBlobCount, 1);
  assert.equal(result.documents.orphanBlobCount, 1);
  assert.equal(result.documents.sizeMismatchCount, 1);
  assert.equal(result.reports.checksumMismatchCount, 1);
});

test('does not follow a symlink named like an expected blob', async (t) => {
  const roots = await fixture(t);
  const key = randomUUID();
  const outside = path.join(roots.root, 'outside-secret.txt');
  await writeFile(outside, 'synthetic secret content', { mode: 0o600 });
  await symlink(outside, path.join(roots.documentRoot, `${key}.blob`));

  const result = await verifyPrivateBlobConsistency({
    schemaVersion: 1,
    documents: [{ key, sizeBytes: Buffer.byteLength('synthetic secret content'), sha256: digest(Buffer.from('synthetic secret content')) }],
    reports: [],
  }, roots);

  assert.equal(result.documents.missingBlobCount, 1);
  assert.equal(result.documents.unsafeEntryCount, 1);
  assert.equal(result.documents.blobCount, 0);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('flags unsafe storage permissions and does not hash files in a public directory', async (t) => {
  const roots = await fixture(t);
  const key = randomUUID();
  const bytes = Buffer.from('private bytes');
  await writeBlob(roots.documentRoot, key, bytes);
  await chmod(roots.documentRoot, 0o755);

  const result = await verifyPrivateBlobConsistency({
    schemaVersion: 1,
    documents: [{ key, sizeBytes: bytes.length, sha256: digest(Buffer.from('different bytes')) }],
    reports: [],
  }, roots);

  assert.equal(result.documents.unsafePermissionCount, 1);
  assert.equal(result.documents.checksumMismatchCount, 0);
  assert.equal(result.ok, false);
});

test('flags world-readable blob files without hashing them', async (t) => {
  const roots = await fixture(t);
  const key = randomUUID();
  const bytes = Buffer.from('private bytes');
  await writeBlob(roots.documentRoot, key, bytes, 0o644);

  const result = await verifyPrivateBlobConsistency({
    schemaVersion: 1,
    documents: [{ key, sizeBytes: bytes.length, sha256: digest(Buffer.from('different bytes')) }],
    reports: [],
  }, roots);

  assert.equal(result.documents.unsafePermissionCount, 1);
  assert.equal(result.documents.checksumMismatchCount, 0);
  assert.equal(result.ok, false);
});

test('counts malformed .blob names without opening them or printing their names', async (t) => {
  const roots = await fixture(t);
  await writeFile(path.join(roots.documentRoot, 'unexpected-private-name.blob'), 'synthetic private content', { mode: 0o600 });

  const result = await verifyPrivateBlobConsistency({ schemaVersion: 1, documents: [], reports: [] }, roots);

  assert.equal(result.documents.invalidBlobNameCount, 1);
  assert.equal(JSON.stringify(result).includes('unexpected-private-name'), false);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});

test('rejects symlink roots, overlapping roots, duplicate keys, and metadata with extra fields', async (t) => {
  const roots = await fixture(t);
  const linkedRoot = path.join(roots.root, 'documents-link');
  await symlink(roots.documentRoot, linkedRoot);

  await assert.rejects(
    verifyPrivateBlobConsistency({ schemaVersion: 1, documents: [], reports: [] }, { ...roots, documentRoot: linkedRoot }),
    SafeInspectionError,
  );
  await assert.rejects(
    verifyPrivateBlobConsistency({ schemaVersion: 1, documents: [], reports: [] }, { ...roots, reportRoot: roots.documentRoot }),
    SafeInspectionError,
  );
  assert.throws(() => validateMetadataSnapshot({
    schemaVersion: 1,
    documents: [{ key: randomUUID(), sizeBytes: 1, sha256: digest(Buffer.from('x')) }, { key: randomUUID(), sizeBytes: 1, sha256: digest(Buffer.from('x')) }],
    reports: [],
    personName: 'synthetic PII field',
  }), SafeInspectionError);

  const duplicateKey = randomUUID();
  assert.throws(() => validateMetadataSnapshot({
    schemaVersion: 1,
    documents: [
      { key: duplicateKey, sizeBytes: 1, sha256: digest(Buffer.from('x')) },
      { key: duplicateKey, sizeBytes: 1, sha256: digest(Buffer.from('x')) },
    ],
    reports: [],
  }), SafeInspectionError);
});
