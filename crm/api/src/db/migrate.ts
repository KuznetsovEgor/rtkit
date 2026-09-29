import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './connection.js';

const migrations = [
  { name: '0001_b01.sql', path: fileURLToPath(new URL('../../migrations/0001_b01.sql', import.meta.url)) },
  { name: '0002_b03_open_tasks_index.sql', path: fileURLToPath(new URL('../../migrations/0002_b03_open_tasks_index.sql', import.meta.url)) },
  { name: '0003_b04_university_steps.sql', path: fileURLToPath(new URL('../../migrations/0003_b04_university_steps.sql', import.meta.url)) },
  { name: '0004_b05_individual_learning.sql', path: fileURLToPath(new URL('../../migrations/0004_b05_individual_learning.sql', import.meta.url)) },
  { name: '0005_b05_restore_individual_legacy_order.sql', path: fileURLToPath(new URL('../../migrations/0005_b05_restore_individual_legacy_order.sql', import.meta.url)) },
  { name: '0006_b05_versioned_individual_routes.sql', path: fileURLToPath(new URL('../../migrations/0006_b05_versioned_individual_routes.sql', import.meta.url)) },
  { name: '0007_b05_tag_preversion_individual_rows.sql', path: fileURLToPath(new URL('../../migrations/0007_b05_tag_preversion_individual_rows.sql', import.meta.url)) },
  { name: '0008_b06_corporate_plans.sql', path: fileURLToPath(new URL('../../migrations/0008_b06_corporate_plans.sql', import.meta.url)) },
  { name: '0009_b07_activity_documents.sql', path: fileURLToPath(new URL('../../migrations/0009_b07_activity_documents.sql', import.meta.url)) },
  { name: '0010_b08_imports.sql', path: fileURLToPath(new URL('../../migrations/0010_b08_imports.sql', import.meta.url)) },
  { name: '0011_b09_external_exchange.sql', path: fileURLToPath(new URL('../../migrations/0011_b09_external_exchange.sql', import.meta.url)) },
  { name: '0012_b09_cms_external_reference_unique.sql', path: fileURLToPath(new URL('../../migrations/0012_b09_cms_external_reference_unique.sql', import.meta.url)) },
  { name: '0013_b10_reports.sql', path: fileURLToPath(new URL('../../migrations/0013_b10_reports.sql', import.meta.url)) },
  { name: '0014_b12_report_snapshot_rows.sql', path: fileURLToPath(new URL('../../migrations/0014_b12_report_snapshot_rows.sql', import.meta.url)) },
  { name: '0015_b12_compact_legacy_report_payloads.sql', path: fileURLToPath(new URL('../../migrations/0015_b12_compact_legacy_report_payloads.sql', import.meta.url)) },
  { name: '0016_a07_university_workflow_admin.sql', path: fileURLToPath(new URL('../../migrations/0016_a07_university_workflow_admin.sql', import.meta.url)) },
  { name: '0017_m05_m08_activity_reassignment.sql', path: fileURLToPath(new URL('../../migrations/0017_m05_m08_activity_reassignment.sql', import.meta.url)) },
  { name: '0018_a10_access_revocation_overlay.sql', path: fileURLToPath(new URL('../../migrations/0018_a10_access_revocation_overlay.sql', import.meta.url)) },
  { name: '0019_a11_activity_segment_scope.sql', path: fileURLToPath(new URL('../../migrations/0019_a11_activity_segment_scope.sql', import.meta.url)) },
  { name: '0020_a12_organization_scope.sql', path: fileURLToPath(new URL('../../migrations/0020_a12_organization_scope.sql', import.meta.url)) },
  { name: '0021_a17_guidance_feedback.sql', path: fileURLToPath(new URL('../../migrations/0021_a17_guidance_feedback.sql', import.meta.url)) },
  { name: '0022_a17_activity_contract_licenses.sql', path: fileURLToPath(new URL('../../migrations/0022_a17_activity_contract_licenses.sql', import.meta.url)) },
  { name: '0023_a17_guidance_editorial.sql', path: fileURLToPath(new URL('../../migrations/0023_a17_guidance_editorial.sql', import.meta.url)) },
  { name: '0024_a20_activity_details_revision.sql', path: fileURLToPath(new URL('../../migrations/0024_a20_activity_details_revision.sql', import.meta.url)) },
  { name: '0025_a41_learning_fact_exchange_receipts.sql', path: fileURLToPath(new URL('../../migrations/0025_a41_learning_fact_exchange_receipts.sql', import.meta.url)) },
  { name: '0026_activity_feed_subscriptions_notifications.sql', path: fileURLToPath(new URL('../../migrations/0026_activity_feed_subscriptions_notifications.sql', import.meta.url)) },
  { name: '0027_csv_import_export.sql', path: fileURLToPath(new URL('../../migrations/0027_csv_import_export.sql', import.meta.url)) },
  { name: '0028_learning_program_catalog.sql', path: fileURLToPath(new URL('../../migrations/0028_learning_program_catalog.sql', import.meta.url)) },
  { name: '0029_catalog_curation.sql', path: fileURLToPath(new URL('../../migrations/0029_catalog_curation.sql', import.meta.url)) },
  { name: '0030_education_product_catalog.sql', path: fileURLToPath(new URL('../../migrations/0030_education_product_catalog.sql', import.meta.url)) },
  { name: '0031_vendor_sample_product.sql', path: fileURLToPath(new URL('../../migrations/0031_vendor_sample_product.sql', import.meta.url)) },
  { name: '0032_public_demo_intakes.sql', path: fileURLToPath(new URL('../../migrations/0032_public_demo_intakes.sql', import.meta.url)) },
  { name: '0033_activity_assignment_notifications.sql', path: fileURLToPath(new URL('../../migrations/0033_activity_assignment_notifications.sql', import.meta.url)) },
];
const client = await pool.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const pending: string[] = [];
  for (const migration of migrations) {
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [migration.name]);
    if (applied.rowCount) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(migration.path, 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [migration.name]);
      await client.query('COMMIT');
      pending.push(migration.name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log(pending.length ? `Applied database migration(s): ${pending.join(', ')}.` : 'Database schema is current.');
} finally {
  client.release();
  await pool.end();
}
