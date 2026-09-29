import { buildApp } from './app.js';
import { closeRepository, PostgresRepository } from './postgres-repository.js';
import { PostgresImportService, purgeExpiredImportPreviews, scheduleImportPreviewCleanup } from './import-service.js';
import { PostgresExchangeService } from './exchange-service.js';
import { purgeExpiredReportJobs, recoverPendingReportExportsOnStartup } from './report-service.js';
import { PostgresAccessPolicyService } from './access-policy-service.js';
import { assertDemoDatabaseMarker } from './db/connection.js';
import { createPublicDemoInquiry } from './public-demo-intake.js';

const imports = new PostgresImportService();
const repository = new PostgresRepository();
const exchanges = new PostgresExchangeService(repository, {
  cmsUrl: process.env.CRM_EXCHANGE_CMS_URL ?? 'http://127.0.0.1:3101',
  lmsUrl: process.env.CRM_EXCHANGE_LMS_URL ?? 'http://127.0.0.1:3102',
});
const accessPolicy = new PostgresAccessPolicyService();
const app = buildApp({ repository, imports, exchanges, accessPolicy, publicDemoIntake: { enabled: process.env.PUBLIC_DEMO_INTAKE_ENABLED === '1', submit: createPublicDemoInquiry } });
const port = Number(process.env.API_PORT ?? 3001);
let importCleanup: ReturnType<typeof setInterval> | undefined;
let reportCleanup: ReturnType<typeof setInterval> | undefined;
try {
  await assertDemoDatabaseMarker();
  await purgeExpiredImportPreviews();
  importCleanup = scheduleImportPreviewCleanup((error) => app.log.error(error, 'Import preview cleanup failed.'));
  await recoverPendingReportExportsOnStartup({ onError: (error) => app.log.error({ err: error }, 'Report export recovery failed; startup will retry.') });
  await purgeExpiredReportJobs({ onError: (error) => app.log.error(error, 'Report cleanup did not remove a private file. It remains queued for retry.') });
  reportCleanup = setInterval(() => { void purgeExpiredReportJobs({ onError: (error) => app.log.error(error, 'Report cleanup did not remove a private file. It remains queued for retry.') }).catch((error) => app.log.error(error, 'Report expiry cleanup failed.')); }, 60 * 60 * 1000);
  reportCleanup.unref();
  await app.listen({ host: process.env.API_HOST ?? '127.0.0.1', port });
} catch (error) {
  app.log.error(error);
  if (importCleanup) clearInterval(importCleanup);
  if (reportCleanup) clearInterval(reportCleanup);
  await closeRepository();
  process.exit(1);
}

const shutdown = async () => {
  if (importCleanup) clearInterval(importCleanup);
  if (reportCleanup) clearInterval(reportCleanup);
  await app.close();
  await closeRepository();
};
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
