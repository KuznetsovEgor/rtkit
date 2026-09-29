import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';
import { renderReportFile } from './report-exports.js';
import { mapReportRow, type ExportFormat, type ReportRow, type ReportSnapshot, type ReportSnapshotPayload, validateReportExportSourceSize } from './report-service.js';
import type { ReportExportColumnKey } from './report-columns.js';

type RenderInput = { snapshot: ReportSnapshotPayload & { rows?: ReportRow[] }; format: ExportFormat; columns?: ReportExportColumnKey[]; sourceSnapshotId?: string };
const port = parentPort;
if (!port) throw new Error('Report render worker requires a parent thread.');

const { snapshot, format, columns, sourceSnapshotId } = workerData as RenderInput;
try {
  let completeSnapshot: ReportSnapshot = { ...snapshot, rows: snapshot.rows ?? [] };
  const needsSourceRows = ['xls', 'xlsx', 'csv', 'pdf', 'json'].includes(format);
  if (needsSourceRows && snapshot.rowCount > 0 && !sourceSnapshotId && (snapshot.rows?.length ?? 0) !== snapshot.rowCount) throw new Error('The export has no complete source snapshot.');
  if (sourceSnapshotId && needsSourceRows) {
    const { Pool } = pg;
    const database = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const size = await database.query('SELECT COALESCE(sum(octet_length(row_data::text)),0)::bigint AS bytes FROM report_snapshot_rows WHERE snapshot_id=$1::uuid', [sourceSnapshotId]);
      validateReportExportSourceSize(format, Number(size.rows[0]?.bytes ?? 0));
      const rows = await database.query('SELECT row_data AS "rowData" FROM report_snapshot_rows WHERE snapshot_id=$1::uuid ORDER BY row_number ASC', [sourceSnapshotId]);
      if (rows.rowCount !== snapshot.rowCount) throw new Error('Stored report row count does not match the export snapshot.');
      completeSnapshot = { ...snapshot, rows: rows.rows.map((row) => mapReportRow(row.rowData as Record<string, unknown>)) };
    } finally { await database.end(); }
  }
  const file = await renderReportFile(completeSnapshot, format, columns);
  // Use a dedicated transferable buffer, avoiding a second copy on postMessage.
  const bytes = Uint8Array.from(file.bytes);
  port.postMessage({ ok: true, file: { ...file, bytes } }, [bytes.buffer as ArrayBuffer]);
} catch (error) {
  const value = error instanceof Error ? error : new Error(String(error));
  port.postMessage({ ok: false, error: { name: value.name, message: value.message, stack: value.stack } });
} finally {
  port.close();
}
