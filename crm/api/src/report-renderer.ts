import { Worker } from 'node:worker_threads';
import type { ExportFormat, ReportSnapshot, ReportSnapshotPayload } from './report-service.js';
import type { ReportExportColumnKey } from './report-columns.js';

type WorkerResponse =
  | { ok: true; file: { bytes: Uint8Array; mediaType: string; extension: string } }
  | { ok: false; error: { name: string; message: string; stack?: string } };

/** Render an export away from the API event loop. The durable job remains in report_jobs. */
export function renderReportFileInWorker(snapshot: ReportSnapshotPayload & { rows?: ReportSnapshot['rows'] }, format: ExportFormat, columns?: readonly ReportExportColumnKey[], sourceSnapshotId?: string): Promise<{ bytes: Buffer; mediaType: string; extension: string }> {
  const sourceMode = import.meta.url.endsWith('.ts');
  const workerUrl = new URL(`./report-render-worker.${sourceMode ? 'ts' : 'js'}`, import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: { snapshot, format, columns, sourceSnapshotId },
    // Keep a single unusually large report from consuming an unbounded V8 heap.
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
    // tsx is needed only when tests/dev run directly from TypeScript sources.
    execArgv: sourceMode ? ['--import', 'tsx'] : [],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, file?: WorkerResponse & { ok: true }) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else if (file?.ok) {
        const { bytes } = file.file;
        // The worker transferred this ArrayBuffer, so create a Buffer view without a
        // large synchronous copy on the API thread.
        resolve({ ...file.file, bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
      }
      else reject(new Error('Report render worker exited without a result.'));
    };

    worker.once('message', (response: WorkerResponse) => {
      if (response?.ok) finish(undefined, response);
      else {
        const error = new Error(response?.error?.message ?? 'Report render worker failed.');
        error.name = response?.error?.name ?? 'Error';
        if (response?.error?.stack) error.stack = response.error.stack;
        finish(error);
      }
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(new Error(`Report render worker exited with code ${code}.`));
      else if (!settled) finish();
    });
  });
}
