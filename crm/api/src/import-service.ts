import { createHash, randomUUID } from 'node:crypto';
import { pool } from './db/connection.js';
import { assertActivityKindAllowed, assertAdmin, assertBusinessAccess, DomainError, type ActivityKind, type Actor } from './domain.js';
import {
  MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, parseImportBuffer, readPrivateImportFile,
  removePrivateImportFile, validateImportFilename, writePrivateImportFile,
  type ImportedCell, type ImportPayload,
} from './import-files.js';

export type ImportTarget = 'contacts' | 'vendors' | 'individual_applications';
export type ImportMapping = Record<string, string | null>;
type MappedValues = Record<string, string | null>;
type MatchCandidate = { entityId: string; name: string; email?: string | null; phone?: string | null; reasons: string[] };
type PreviewRow = {
  rowNumber: number; sourceValues: (string | null)[]; values: MappedValues; externalKey: string | null; payloadHash: string;
  status: 'valid' | 'invalid' | 'unchanged' | 'changed_requires_review' | 'possible_duplicate' | 'blocked' | 'duplicate_in_file' | 'skipped_null';
  errors: string[]; warnings: string[]; matches: MatchCandidate[]; baseHash: string | null; entityId: string | null;
  unsafeColumns?: number[]; keyError?: string;
};
type ImportJob = {
  id: string; actorSub: string; actorName: string; target: ImportTarget; sourceSystem: string; fileName: string;
  fileFormat: 'xls' | 'xlsx' | 'json' | 'csv'; payload: ImportPayload; selectedSheet: string | null; headerRow: number | null;
  rawHeadings: string[]; mapping: ImportMapping; preview: PreviewRow[]; result: unknown; status: string; revision: number;
  expiresAt: Date;
};
type ImportConfirmationRequest = { revision: number; idempotencyKey: string; rowNumbers: number[]; reviewedRows: number[] };

export type ImportUploadResult = {
  id: string; revision: number; target: ImportTarget; sourceSystem: string; fileName: string; fileFormat: string;
  sheets: { name: string; rowCount: number; firstRow: number; samples: string[][] }[]; createdAt: string; expiresAt: string;
};

export type ImportAdminSummary = {
  counts: {
    byStatus: Record<'uploaded' | 'preview_ready' | 'completed' | 'expired', number>;
    byTarget: Record<ImportTarget, number>;
    previewRowsRequiringResolution: number;
  };
  recentJobs: {
    id: string; target: ImportTarget; status: 'uploaded' | 'preview_ready' | 'completed' | 'expired';
    created_at: string; expires_at: string; previewRowsRequiringResolution: number;
  }[];
};

export interface ImportService {
  adminSummary(actor: Actor): Promise<ImportAdminSummary>;
  upload(actor: Actor, filename: unknown, target: unknown, source: unknown, bytes: Buffer): Promise<ImportUploadResult>;
  get(actor: Actor, id: string): Promise<Record<string, unknown>>;
  getHeader(actor: Actor, id: string, sheetName: string, rowNumber: number): Promise<{ sheet: string; row: number; values: string[] }>;
  preview(actor: Actor, id: string, input: { revision: number; selectedSheet: string; headerRow: number; mapping: ImportMapping }): Promise<Record<string, unknown>>;
  confirm(actor: Actor, id: string, input: ImportConfirmationRequest): Promise<Record<string, unknown>>;
  cancel(actor: Actor, id: string): Promise<void>;
  listContacts(actor: Actor, query: string): Promise<Record<string, unknown>[]>;
  listVendors(actor: Actor): Promise<Record<string, unknown>[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const targetFields: Record<ImportTarget, string[]> = {
  contacts: ['externalKey', 'fullName', 'email', 'phone', 'organizationName'],
  vendors: ['externalKey', 'name', 'productNames'],
  individual_applications: ['externalKey', 'fullName', 'email', 'phone', 'productName'],
};
const allActivityKinds: ActivityKind[] = ['university', 'corporate', 'individual'];
const contactPersonKindScope = `((p.import_owner_sub = $1 AND ('individual' = ANY($2::text[]) OR NOT EXISTS (
  SELECT 1 FROM activities private_app WHERE private_app.person_id = p.id AND private_app.import_owner_only = TRUE AND private_app.kind = 'individual'
))) OR EXISTS (
  SELECT 1 FROM activities scoped WHERE scoped.owner_sub = $1 AND scoped.person_id = p.id AND scoped.kind = ANY($2::text[])
))`;
const contactPersonScope = `${contactPersonKindScope} AND ($3::uuid[] IS NULL OR NOT EXISTS (
  SELECT 1 FROM activities org_scoped WHERE org_scoped.person_id = p.id AND (
    (org_scoped.organization_id IS NOT NULL AND NOT (org_scoped.organization_id = ANY($3::uuid[]))) OR
    (org_scoped.payer_organization_id IS NOT NULL AND NOT (org_scoped.payer_organization_id = ANY($3::uuid[])))
  )
))`;

function assertImportTargetScope(actor: Actor, target: ImportTarget) {
  if (target === 'individual_applications') assertActivityKindAllowed(actor, 'individual');
}

const rawCell = (row: ImportedCell[], index: number) => row[index]?.value ?? null;
const cleanHeading = (cell: ImportedCell | undefined) => cell?.value ?? '';
const normalizeName = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
const normalizePhone = (value: string) => value.replace(/\D/g, '');
const hashValue = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isTarget = (value: unknown): value is ImportTarget => value === 'contacts' || value === 'vendors' || value === 'individual_applications';
const safeSourceName = (value: unknown) => {
  if (typeof value !== 'string') throw new DomainError(400, 'invalid_import_source', 'Укажите короткое название внешнего источника.');
  const source = value.trim();
  if (!source || source.length > 80 || /[\u0000-\u001f\u007f]|https?:\/\/|@/.test(source)) throw new DomainError(400, 'invalid_import_source', 'Название источника должно содержать до 80 символов и не быть ссылкой или контактом.');
  return source;
};

function personImportError(field: string, value: string | null) {
  if (!value?.trim()) return field === 'fullName' ? 'Не указано имя.' : null;
  if (field === 'fullName' && (value.trim().length > 180 || /[\u0000-\u001f\u007f]/.test(value))) return 'Имя длиннее 180 символов или содержит недопустимые символы.';
  if (field === 'email' && (value.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))) return 'Проверьте адрес email.';
  if (field === 'phone' && (value.length > 64 || /[\u0000-\u001f\u007f]/.test(value))) return 'Телефон длиннее 64 символов или содержит недопустимые символы.';
  if (field === 'organizationName' && (value.length > 180 || /[\u0000-\u001f\u007f]/.test(value))) return 'Название организации длиннее 180 символов или содержит недопустимые символы.';
  return null;
}

function validateExternalKey(value: string | null) {
  if (!value?.trim()) return { key: null, error: null };
  const key = value.trim();
  if (key.length > 120 || /[\u0000-\u001f\u007f]|@|https?:\/\//i.test(key)) return { key: null, error: 'Внешний ключ должен быть непрозрачным идентификатором длиной до 120 символов.' };
  return { key, error: null };
}

function rowEmpty(row: ImportedCell[]) { return row.every((cell) => !cell.value?.trim() && !cell.unsafe); }

function mapRow(source: ImportedCell[], mapping: ImportMapping): MappedValues {
  const values: MappedValues = {};
  for (const [column, targetField] of Object.entries(mapping)) {
    if (!targetField) continue;
    const index = Number(column);
    if (source[index]?.unsafe) { values[targetField] = null; continue; }
    values[targetField] = rawCell(source, index);
  }
  return values;
}

function canonicalHash(target: ImportTarget, values: MappedValues, externalKey: string | null) {
  const payload: Record<string, string | null> = {};
  for (const key of [...targetFields[target]].filter((field) => field !== 'externalKey').sort()) payload[key] = values[key] ?? null;
  return hashValue({ target, externalKey, values: payload });
}

function rowFingerprint(target: ImportTarget, values: MappedValues) {
  const normalized: Record<string, string | null> = {};
  for (const field of [...targetFields[target]].filter((name) => name !== 'externalKey').sort()) {
    const value = values[field]?.trim() ?? '';
    if (!value) { normalized[field] = null; continue; }
    if (field === 'email') normalized[field] = value.toLocaleLowerCase('en-US');
    else if (field === 'phone') normalized[field] = normalizePhone(value);
    else if (field === 'productNames') normalized[field] = [...new Set(value.split(/[;\n]/).map(normalizeName).filter(Boolean))].sort().join(';');
    else normalized[field] = normalizeName(value);
  }
  return hashValue({ target, values: normalized });
}

function rowsFrom(job: ImportJob, sheetName: string, headerRow: number, mapping: ImportMapping) {
  const sheet = job.payload.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw new DomainError(400, 'import_sheet_not_found', 'Выберите лист из загруженной книги.');
  if (job.fileFormat === 'json' && headerRow !== 1) throw new DomainError(400, 'invalid_header_row', 'Для JSON используется строка полей, собранная из ключей записей.');
  const rowOffset = sheet.rowOffset ?? 0;
  if (!Number.isInteger(headerRow) || headerRow < rowOffset + 1 || headerRow > rowOffset + sheet.rows.length) throw new DomainError(400, 'invalid_header_row', 'Укажите существующую строку заголовков.');
  const headerCells = sheet.rows[headerRow - rowOffset - 1] ?? [];
  const headings = headerCells.map(cleanHeading);
  if (!headings.some((heading) => heading.trim())) throw new DomainError(400, 'empty_import_headings', 'В выбранной строке нет заголовков колонок.');
  if (headings.length > 100) throw new DomainError(400, 'too_many_import_columns', 'В таблице допускается не более 100 колонок.');
  const validKeys = new Set(Object.keys(mapping));
  if (Object.keys(mapping).some((key) => !/^\d{1,3}$/.test(key) || Number(key) >= headings.length || !validKeys.has(key))) {
    throw new DomainError(400, 'invalid_column_mapping', 'Сопоставление содержит отсутствующую колонку.');
  }
  const selectedFields = Object.values(mapping).filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (selectedFields.some((field) => !targetFields[job.target].includes(field)) || new Set(selectedFields).size !== selectedFields.length) {
    throw new DomainError(400, 'invalid_column_mapping', 'Каждое поле CRM можно сопоставить не более чем с одной колонкой.');
  }
  if (!selectedFields.includes(job.target === 'vendors' ? 'name' : 'fullName')) throw new DomainError(400, 'required_column_unmapped', 'Сопоставьте колонку с именем контакта или поставщика.');
  if (job.target === 'individual_applications' && !selectedFields.includes('externalKey')) throw new DomainError(400, 'application_key_unmapped', 'Для внешней заявки требуется сопоставить внешний ID приложения.');
  const skippedRows = new Set(sheet.skippedRows ?? []);
  const nonEmpty = sheet.rows.flatMap((row, index) => {
    const rowNumber = rowOffset + index + 1;
    return rowNumber > headerRow && (!rowEmpty(row) || skippedRows.has(rowNumber)) ? [{ row, rowNumber }] : [];
  });
  if (nonEmpty.length > MAX_IMPORT_ROWS) throw new DomainError(400, 'too_many_import_rows', 'В одном импорте допускается не более 2 000 непустых строк данных.');
  return { headings, rows: nonEmpty.map(({ row, rowNumber }) => ({
    rowNumber,
    sourceValues: headings.map((_heading, columnIndex) => rawCell(row, columnIndex)),
    unsafeColumns: row.flatMap((cell, columnIndex) => cell.unsafe ? [columnIndex] : []),
    values: mapRow(row, mapping),
    skipWarning: skippedRows.has(rowNumber) ? 'Запись JSON имеет значение null; она пропущена без записи в CRM.' : undefined,
  })) };
}

function rowsFromSheetPayload(job: ImportJob, sheetName: string, headerRow: number, mapping: ImportMapping) {
  const mapped = rowsFrom(job, sheetName, headerRow, mapping);
  const preview: (Omit<PreviewRow, 'status' | 'errors' | 'warnings' | 'matches' | 'baseHash' | 'entityId' | 'skipWarning'> & { unsafeColumns: number[]; skipWarning?: string })[] = [];
  for (let i = 0; i < mapped.rows.length; i += 1) {
    const values = mapped.rows[i].values;
    const keyValue = values.externalKey ?? null;
    const { key: externalKey, error: keyError } = validateExternalKey(keyValue);
    const payloadHash = canonicalHash(job.target, values, externalKey);
    preview.push({ ...mapped.rows[i], externalKey, payloadHash });
    if (keyError) preview.at(-1)!.keyError = keyError;
    // Keep headings exactly as the source presents them; mapping is indexed so duplicate labels stay distinct.
  }
  return { headings: mapped.headings, rows: preview };
}

function mapContactMatches(row: { full_name: string; email: string | null; phone: string | null; id: string }, values: MappedValues): MatchCandidate {
  const reasons: string[] = [];
  if (values.email?.trim() && row.email && row.email.trim().toLocaleLowerCase('en-US') === values.email.trim().toLocaleLowerCase('en-US')) reasons.push('Совпадает email');
  if (values.phone && row.phone && normalizePhone(row.phone) && normalizePhone(row.phone) === normalizePhone(values.phone)) reasons.push('Совпадает телефон');
  if (values.fullName && normalizeName(row.full_name) === normalizeName(values.fullName)) reasons.push('Совпадает имя');
  return { entityId: row.id, name: row.full_name, email: row.email, phone: row.phone, reasons };
}

async function possiblePeople(actor: Actor, values: MappedValues) {
  const clauses: string[] = []; const params: unknown[] = [actor.sub, actor.allowedKinds ?? allActivityKinds, actor.allowedOrganizationIds ?? null];
  if (values.email?.trim()) { params.push(values.email.trim().toLocaleLowerCase('en-US')); clauses.push(`lower(trim(coalesce(p.email,''))) = $${params.length}`); }
  if (values.phone && normalizePhone(values.phone)) { params.push(normalizePhone(values.phone)); clauses.push(`regexp_replace(coalesce(p.phone,''),'\\D','','g') = $${params.length}`); }
  if (values.fullName?.trim()) { params.push(normalizeName(values.fullName)); clauses.push(`lower(regexp_replace(trim(p.full_name),'\\s+',' ','g')) = $${params.length}`); }
  if (!clauses.length) return [];
  const result = await pool.query(`SELECT DISTINCT p.id, p.full_name, p.email, p.phone FROM people p
    WHERE ${contactPersonScope}
      AND (${clauses.join(' OR ')}) ORDER BY p.full_name, p.id LIMIT 3`, params);
  return result.rows.map((row: { id: string; full_name: string; email: string | null; phone: string | null }) => mapContactMatches(row, values));
}

async function visiblePersonIds(actor: Actor, entityIds: string[]) {
  if (!entityIds.length) return new Set<string>();
  const result = await pool.query(`SELECT p.id FROM people p WHERE p.id=ANY($4::uuid[]) AND ${contactPersonScope}`,
    [actor.sub, actor.allowedKinds ?? allActivityKinds, actor.allowedOrganizationIds ?? null, entityIds]);
  return new Set((result.rows as { id: string }[]).map((row) => row.id));
}

async function visiblePersonKinds(actor: Actor, entityIds: string[]) {
  if (!entityIds.length) return new Set<string>();
  const result = await pool.query(`SELECT p.id FROM people p WHERE p.id=ANY($3::uuid[]) AND ${contactPersonKindScope}`,
    [actor.sub, actor.allowedKinds ?? allActivityKinds, entityIds]);
  return new Set((result.rows as { id: string }[]).map((row) => row.id));
}

async function checkProduct(values: MappedValues) {
  if (!values.productName?.trim()) return null;
  const found = await pool.query('SELECT id FROM products WHERE lower(trim(name))=lower(trim($1)) LIMIT 1', [values.productName]);
  return found.rowCount ? null : `В каталоге нет продукта «${values.productName.slice(0, 80)}». Сопоставьте его отдельно перед загрузкой заявки.`;
}

async function checkApplicationProductVisibility(values: MappedValues, existingActivityId: string | null) {
  const name = values.productName?.trim();
  if (!name) return null;
  const product = await pool.query('SELECT id,catalog_visible FROM products WHERE lower(trim(name))=lower(trim($1)) ORDER BY id LIMIT 1', [name]);
  if (!product.rowCount || product.rows[0].catalog_visible) return null;
  if (existingActivityId) {
    const linked = await pool.query('SELECT 1 FROM activity_products WHERE activity_id=$1 AND product_id=$2', [existingActivityId, product.rows[0].id]);
    if (linked.rowCount) return null;
  }
  return `Скрытый продукт «${name.slice(0, 80)}» нельзя добавить к заявке. Сделайте его видимым в каталоге или удалите из строки.`;
}

async function checkVendorProductVisibility(values: MappedValues, existingVendorId: string | null) {
  const names = [...new Set((values.productNames ?? '').split(/[;\n]/).map((value) => value.trim()).filter(Boolean))];
  const errors: string[] = [];
  for (const name of names) {
    const product = await pool.query('SELECT id,catalog_visible FROM products WHERE lower(trim(name))=lower(trim($1)) ORDER BY id LIMIT 1', [name]);
    if (!product.rowCount || product.rows[0].catalog_visible) continue;
    const linked = existingVendorId
      ? await pool.query('SELECT 1 FROM vendor_products WHERE vendor_id=$1 AND product_id=$2', [existingVendorId, product.rows[0].id])
      : { rowCount: 0 };
    if (!linked.rowCount) errors.push(`Скрытый продукт «${name.slice(0, 80)}» нельзя добавить поставщику. Сделайте его видимым в каталоге или удалите из строки.`);
  }
  return errors;
}

function validateMapped(target: ImportTarget, values: MappedValues, keyError: string | undefined) {
  const errors: string[] = [];
  const identityError = keyError ? keyError : null;
  if (identityError) errors.push(identityError);
  if (target === 'vendors') {
    if (!values.name?.trim()) errors.push('Не указано название поставщика.');
    else if (values.name.trim().length > 180 || /[\u0000-\u001f\u007f]/.test(values.name)) errors.push('Название поставщика длиннее 180 символов или содержит недопустимые символы.');
    if ((values.productNames?.length ?? 0) > 2000) errors.push('Список продуктов слишком длинный.');
  } else {
    if (!values.fullName?.trim()) errors.push(target === 'individual_applications' ? 'Не указано имя заявителя.' : 'Не указано имя контакта.');
    for (const field of ['fullName', 'email', 'phone', 'organizationName']) {
      const error = personImportError(field, values[field] ?? null);
      if (error) errors.push(error);
    }
    if (target === 'individual_applications' && !values.externalKey?.trim()) errors.push('Для внешней заявки нужен стабильный внешний ID.');
  }
  return errors;
}

function jobDto(row: any): ImportJob {
  return {
    id: row.id, actorSub: row.actor_sub, actorName: row.actor_name, target: row.target, sourceSystem: row.source_system,
    fileName: row.file_name, fileFormat: row.file_format, payload: row.payload, selectedSheet: row.selected_sheet,
    headerRow: row.header_row === null ? null : Number(row.header_row), rawHeadings: row.raw_headings ?? [], mapping: row.mapping ?? {},
    preview: row.preview ?? [], result: row.result ?? null, status: row.status, revision: Number(row.revision), expiresAt: new Date(row.expires_at),
  };
}

async function purgeExpired() {
  await pool.query(`UPDATE import_jobs SET status='expired', file_name='expired', payload='{"sheets":[]}'::jsonb,
      raw_headings='[]'::jsonb, mapping='{}'::jsonb, preview='[]'::jsonb, result=NULL
    WHERE status <> 'expired' AND expires_at <= statement_timestamp()`);
  await pool.query('DELETE FROM import_jobs WHERE status=\'expired\' AND expires_at < statement_timestamp() - interval \'7 days\'');
}

export async function purgeExpiredImportPreviews() { return purgeExpired(); }

export function scheduleImportPreviewCleanup(onError: (error: unknown) => void, intervalMs = 60 * 60 * 1000) {
  const timer = setInterval(() => { void purgeExpiredImportPreviews().catch(onError); }, intervalMs);
  timer.unref();
  return timer;
}

function publicRow(row: PreviewRow) {
  return {
    rowNumber: row.rowNumber, sourceValues: row.sourceValues, values: row.values, status: row.status,
    errors: row.errors, warnings: row.warnings, matches: row.matches, externalKey: row.externalKey,
  };
}

export class PostgresImportService implements ImportService {
  async adminSummary(actor: Actor): Promise<ImportAdminSummary> {
    assertAdmin(actor);
    const [statuses, targets, resolutions, recent] = await Promise.all([
      pool.query('SELECT status, count(*)::int AS count FROM import_jobs GROUP BY status'),
      pool.query('SELECT target, count(*)::int AS count FROM import_jobs GROUP BY target'),
      pool.query(`SELECT count(*)::int AS count FROM import_jobs j
        CROSS JOIN LATERAL jsonb_array_elements(j.preview) AS preview_row
        WHERE preview_row->>'status' IN ('possible_duplicate','changed_requires_review')
          AND NOT EXISTS (SELECT 1 FROM import_applied_rows applied
            WHERE applied.job_id=j.id AND applied.row_number=(preview_row->>'rowNumber')::integer)`),
      pool.query(`SELECT id, target, status, created_at, expires_at,
        (SELECT count(*)::int FROM jsonb_array_elements(j.preview) AS preview_row
          WHERE preview_row->>'status' IN ('possible_duplicate','changed_requires_review')
            AND NOT EXISTS (SELECT 1 FROM import_applied_rows applied
              WHERE applied.job_id=j.id AND applied.row_number=(preview_row->>'rowNumber')::integer)) AS preview_rows_requiring_resolution
        FROM import_jobs j ORDER BY created_at DESC, id DESC LIMIT 20`),
    ]);

    const byStatus: ImportAdminSummary['counts']['byStatus'] = {
      uploaded: 0, preview_ready: 0, completed: 0, expired: 0,
    };
    for (const row of statuses.rows as { status: keyof typeof byStatus; count: number | string }[]) {
      if (row.status in byStatus) byStatus[row.status] = Number(row.count);
    }
    const byTarget: ImportAdminSummary['counts']['byTarget'] = {
      contacts: 0, vendors: 0, individual_applications: 0,
    };
    for (const row of targets.rows as { target: keyof typeof byTarget; count: number | string }[]) {
      if (row.target in byTarget) byTarget[row.target] = Number(row.count);
    }

    return {
      counts: { byStatus, byTarget, previewRowsRequiringResolution: Number(resolutions.rows[0]?.count ?? 0) },
      recentJobs: (recent.rows as {
        id: string; target: ImportTarget; status: ImportAdminSummary['recentJobs'][number]['status'];
        created_at: Date | string; expires_at: Date | string; preview_rows_requiring_resolution: number | string;
      }[]).map((row) => ({
        id: row.id, target: row.target, status: row.status,
        created_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString(),
        previewRowsRequiringResolution: Number(row.preview_rows_requiring_resolution),
      })),
    };
  }

  async upload(actor: Actor, filenameValue: unknown, targetValue: unknown, sourceValue: unknown, bytes: Buffer): Promise<ImportUploadResult> {
    assertBusinessAccess(actor);
    await purgeExpired();
    const { name: fileName, extension } = validateImportFilename(filenameValue);
    if (!isTarget(targetValue)) throw new DomainError(400, 'invalid_import_target', 'Выберите один из трёх поддерживаемых типов импорта.');
    assertImportTargetScope(actor, targetValue);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMPORT_FILE_BYTES) throw new DomainError(413, 'import_file_too_large', 'Файл импорта должен быть не пустым и не больше 5 МБ.');
    const sourceSystem = safeSourceName(sourceValue);
    const key = await writePrivateImportFile(bytes);
    let payload: ImportPayload;
    try { payload = parseImportBuffer(await readPrivateImportFile(key, bytes.length), extension, targetValue); }
    finally { await removePrivateImportFile(key); }
    const id = randomUUID(); const expiresAt = new Date(Date.now() + DAY_MS);
    const databaseFileName = `import-${id}.${extension}`;
    const inserted = await pool.query(`INSERT INTO import_jobs(id,actor_sub,actor_name,target,source_system,file_name,file_format,payload,status,revision,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'uploaded',1,$9) RETURNING created_at`, [
      id, actor.sub, actor.name, targetValue, sourceSystem, databaseFileName, extension, JSON.stringify(payload), expiresAt,
    ]);
    const createdAt = new Date(inserted.rows[0].created_at).toISOString();
    return {
      id, revision: 1, target: targetValue, sourceSystem, fileName, fileFormat: extension,
    sheets: payload.sheets.map((sheet) => ({ name: sheet.name, rowCount: Math.max(0, (sheet.rowOffset ?? 0) + sheet.rows.length - (extension === 'json' ? 1 : 0)), firstRow: (sheet.rowOffset ?? 0) + 1, samples: sheet.rows.slice(0, 6).map((row) => row.map((cell) => cell.value ?? '')) })),
      createdAt, expiresAt: expiresAt.toISOString(),
    };
  }

  async get(actor: Actor, id: string) {
    assertBusinessAccess(actor);
    await purgeExpired();
    const result = await pool.query('SELECT * FROM import_jobs WHERE id=$1 AND actor_sub=$2 LIMIT 1', [id, actor.sub]);
    const row = result.rows[0];
    if (!row) throw new DomainError(404, 'import_not_found', 'Импорт не найден или недоступен.');
    if (row.status === 'expired') throw new DomainError(410, 'import_expired', 'Срок хранения предпросмотра истёк; загрузите файл заново.');
    const job = jobDto(row);
    assertImportTargetScope(actor, job.target);
    if (job.target === 'contacts' && job.preview.some((previewRow) => previewRow.matches.length || previewRow.entityId)) {
      const savedIds = [...new Set(job.preview.flatMap((previewRow) => [
        ...previewRow.matches.map((match) => match.entityId),
        ...(previewRow.entityId ? [previewRow.entityId] : []),
      ]))];
      const visibleIds = await visiblePersonIds(actor, savedIds);
      const scopedJob = { ...job, preview: job.preview.map((previewRow) => {
        const matches = previewRow.matches.filter((match) => visibleIds.has(match.entityId));
        if (previewRow.entityId && !visibleIds.has(previewRow.entityId)) {
          return { ...previewRow, matches: [], status: 'blocked' as const,
            errors: [...previewRow.errors, 'Контакт больше не входит в вашу область доступа.'] };
        }
        return { ...previewRow, matches, status: previewRow.status === 'possible_duplicate' && matches.length === 0 ? 'valid' as const : previewRow.status };
      }) };
      return this.toPublic(scopedJob);
    }
    return this.toPublic(job);
  }

  async getHeader(actor: Actor, id: string, sheetName: string, rowNumber: number) {
    assertBusinessAccess(actor);
    await purgeExpired();
    const result = await pool.query('SELECT * FROM import_jobs WHERE id=$1 AND actor_sub=$2 LIMIT 1', [id, actor.sub]);
    const row = result.rows[0];
    if (!row) throw new DomainError(404, 'import_not_found', 'Импорт не найден или недоступен.');
    const job = jobDto(row);
    assertImportTargetScope(actor, job.target);
    if (job.status === 'expired' || job.expiresAt.getTime() <= Date.now()) throw new DomainError(410, 'import_expired', 'Срок хранения предпросмотра истёк; загрузите файл заново.');
    const selected = job.payload.sheets.find((item) => item.name === sheetName);
    if (!selected) throw new DomainError(404, 'import_sheet_not_found', 'Выберите лист из загруженной книги.');
    const rowOffset = selected.rowOffset ?? 0;
    if (!Number.isInteger(rowNumber) || rowNumber < rowOffset + 1 || rowNumber > rowOffset + selected.rows.length) throw new DomainError(400, 'invalid_header_row', 'Укажите существующую строку заголовков.');
    return { sheet: selected.name, row: rowNumber, values: (selected.rows[rowNumber - rowOffset - 1] ?? []).map(cleanHeading) };
  }

  private toPublic(job: ImportJob) {
    return {
      id: job.id, revision: job.revision, target: job.target, sourceSystem: job.sourceSystem, fileName: job.fileName,
      fileFormat: job.fileFormat, status: job.status, selectedSheet: job.selectedSheet, headerRow: job.headerRow,
      rawHeadings: job.rawHeadings, mapping: job.mapping, expiresAt: job.expiresAt.toISOString(),
      sheets: job.payload.sheets.map((sheet) => ({ name: sheet.name, rowCount: Math.max(0, (sheet.rowOffset ?? 0) + sheet.rows.length - (job.fileFormat === 'json' ? 1 : 0)), firstRow: (sheet.rowOffset ?? 0) + 1, samples: sheet.rows.slice(0, 6).map((row) => row.map((cell) => cell.value ?? '')) })),
      preview: job.preview.map(publicRow), result: job.result,
    };
  }

  async preview(actor: Actor, id: string, input: { revision: number; selectedSheet: string; headerRow: number; mapping: ImportMapping }) {
    assertBusinessAccess(actor);
    await purgeExpired();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM import_jobs WHERE id=$1 AND actor_sub=$2 FOR UPDATE', [id, actor.sub]);
      if (!result.rowCount) throw new DomainError(404, 'import_not_found', 'Импорт не найден или недоступен.');
      const job = jobDto(result.rows[0]);
      assertImportTargetScope(actor, job.target);
      if (job.status === 'expired' || job.expiresAt.getTime() <= Date.now()) throw new DomainError(410, 'import_expired', 'Срок хранения предпросмотра истёк; загрузите файл заново.');
      if (job.revision !== input.revision) throw new DomainError(409, 'import_revision_conflict', 'Файл или сопоставление уже изменились. Обновите предпросмотр.');
      if (job.status === 'completed') throw new DomainError(409, 'import_already_confirmed', 'Этот предпросмотр уже подтверждён. Создайте новый предпросмотр для повторной загрузки.');
      const { headings, rows } = rowsFromSheetPayload(job, input.selectedSheet, input.headerRow, input.mapping);
      const seenKeys = new Set<string>(); const seenUnkeyedPayloads = new Set<string>();
      const preview: PreviewRow[] = [];
      for (const row of rows) {
        const errors = row.skipWarning ? [] : validateMapped(job.target, row.values, (row as any).keyError);
        if (!row.skipWarning && job.target === 'individual_applications') {
          const productError = await checkProduct(row.values);
          if (productError) errors.push(productError);
        }
        const warnings = row.unsafeColumns.map((_column: number) => 'В этой строке формула или ссылка не переносится в CRM.');
        if (row.skipWarning) warnings.push(row.skipWarning);
        if (!row.skipWarning && job.target === 'contacts' && !row.externalKey) warnings.push('Без внешнего ключа повторная загрузка может создать отдельную запись. Сверьте возможные совпадения.');
        if (!row.skipWarning && job.target === 'vendors' && !row.externalKey) warnings.push('Без внешнего ключа повторная загрузка может создать отдельного поставщика. Сверьте возможные совпадения.');
        let status: PreviewRow['status'] = row.skipWarning ? 'skipped_null' : errors.length ? 'invalid' : 'valid';
        let baseHash: string | null = null; let entityId: string | null = null; let matches: MatchCandidate[] = [];
        if (!row.skipWarning && !errors.length && row.externalKey) {
          const identity = await client.query('SELECT owner_sub,entity_id,payload_hash FROM import_identities WHERE target=$1 AND source_system=$2 AND external_key=$3', [job.target, job.sourceSystem, row.externalKey]);
          const existing = identity.rows[0];
          if (existing && existing.owner_sub !== actor.sub) {
            status = 'blocked'; errors.push('Этот внешний ключ уже используется другой областью доступа.');
          } else if (existing) {
            entityId = existing.entity_id; baseHash = existing.payload_hash;
            if (job.target === 'contacts') {
              const visible = await client.query(`SELECT p.id FROM people p WHERE p.id=$4 AND ${contactPersonScope}`,
                [actor.sub, actor.allowedKinds ?? allActivityKinds, actor.allowedOrganizationIds ?? null, entityId]);
              if (!visible.rowCount) {
                status = 'blocked'; errors.push('Контакт больше не входит в вашу область доступа.');
              } else if (baseHash === row.payloadHash) status = 'unchanged';
              else status = 'changed_requires_review';
            } else if (baseHash === row.payloadHash) status = 'unchanged';
            else status = 'changed_requires_review';
          }
        }
        if (!row.skipWarning && !errors.length && status !== 'blocked' && job.target === 'individual_applications') {
          const productError = await checkApplicationProductVisibility(row.values, entityId);
          if (productError) { errors.push(productError); status = 'invalid'; }
        }
        if (!row.skipWarning && !errors.length && status !== 'blocked' && job.target === 'vendors' && Object.values(input.mapping).includes('productNames')) {
          const productErrors = await checkVendorProductVisibility(row.values, entityId);
          if (productErrors.length) { errors.push(...productErrors); status = 'invalid'; }
        }
        if (!row.skipWarning && !errors.length && status === 'valid' && job.target !== 'vendors') {
          matches = await possiblePeople(actor, row.values);
          if (matches.length) status = 'possible_duplicate';
        } else if (!row.skipWarning && !errors.length && status === 'valid' && job.target === 'vendors') {
          const candidate = await pool.query('SELECT id,name FROM vendors WHERE owner_sub=$1 AND lower(trim(name))=lower(trim($2)) ORDER BY id LIMIT 3', [actor.sub, row.values.name]);
          if (candidate.rowCount) {
            matches = candidate.rows.map((item: { id: string; name: string }) => ({ entityId: item.id, name: item.name, reasons: ['Совпадает название поставщика'] }));
            status = 'possible_duplicate';
          }
        }
        if (!row.skipWarning && row.externalKey) {
          if (seenKeys.has(row.externalKey)) { status = 'duplicate_in_file'; errors.push('В этом файле внешний ключ повторяется; оставлена только первая строка.'); }
          else seenKeys.add(row.externalKey);
        } else if (!row.skipWarning && !errors.length) {
          const fingerprint = rowFingerprint(job.target, row.values);
          if (seenUnkeyedPayloads.has(fingerprint)) { status = 'duplicate_in_file'; errors.push('Такая же запись без внешнего ключа уже есть в этом файле; оставлена только первая строка.'); }
          else seenUnkeyedPayloads.add(fingerprint);
        }
        preview.push({ rowNumber: row.rowNumber, sourceValues: row.sourceValues, values: row.values, externalKey: row.externalKey,
          payloadHash: row.payloadHash, status, errors, warnings, matches, baseHash, entityId });
      }
      const nextRevision = job.revision + 1;
      await client.query(`UPDATE import_jobs SET status='preview_ready', revision=$2, selected_sheet=$3, header_row=$4,
        raw_headings=$5::jsonb, mapping=$6::jsonb, preview=$7::jsonb, result=NULL WHERE id=$1`, [
        id, nextRevision, input.selectedSheet, input.headerRow, JSON.stringify(headings), JSON.stringify(input.mapping), JSON.stringify(preview),
      ]);
      await client.query('COMMIT');
      return this.toPublic({ ...job, status: 'preview_ready', revision: nextRevision, selectedSheet: input.selectedSheet, headerRow: input.headerRow, rawHeadings: headings, mapping: input.mapping, preview, result: null });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async confirm(actor: Actor, id: string, input: ImportConfirmationRequest) {
    assertBusinessAccess(actor);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const jobResult = await client.query('SELECT * FROM import_jobs WHERE id=$1 AND actor_sub=$2 FOR UPDATE', [id, actor.sub]);
      if (!jobResult.rowCount) throw new DomainError(404, 'import_not_found', 'Импорт не найден или недоступен.');
      const job = jobDto(jobResult.rows[0]);
      assertImportTargetScope(actor, job.target);
      if (job.status === 'expired' || job.expiresAt.getTime() <= Date.now()) throw new DomainError(410, 'import_expired', 'Срок хранения предпросмотра истёк; загрузите файл заново.');
      if (job.status !== 'preview_ready' && job.status !== 'completed') throw new DomainError(409, 'import_preview_required', 'Сначала проверьте строки и сопоставление.');
      if (job.revision !== input.revision) throw new DomainError(409, 'import_revision_conflict', 'Предпросмотр изменился. Обновите строки перед подтверждением.');
      if (job.target === 'contacts') {
        const savedMatchIds = [...new Set(job.preview.flatMap((previewRow) => previewRow.matches.map((match) => match.entityId)))];
        const visibleMatchIds = await visiblePersonIds(actor, savedMatchIds);
        if (savedMatchIds.some((entityId) => !visibleMatchIds.has(entityId))) {
          throw new DomainError(409, 'import_scope_changed', 'Область доступа изменилась с момента предпросмотра. Обновите предпросмотр строк.');
        }
        const savedIdentityIds = [...new Set(job.preview.flatMap((previewRow) => previewRow.entityId ? [previewRow.entityId] : []))];
        const visibleIdentityKinds = await visiblePersonKinds(actor, savedIdentityIds);
        if (savedIdentityIds.some((entityId) => !visibleIdentityKinds.has(entityId))) {
          throw new DomainError(409, 'import_contact_scope_conflict', 'Контакт больше не входит в вашу область доступа.');
        }
      }
      const requestHash = hashValue({ revision: input.revision, rowNumbers: [...input.rowNumbers].sort((a,b) => a-b), reviewedRows: [...input.reviewedRows].sort((a,b) => a-b) });
      const idempotency = await client.query('SELECT request_hash,result FROM import_confirmations WHERE job_id=$1 AND idempotency_key=$2', [id, input.idempotencyKey]);
      if (idempotency.rowCount) {
        if (idempotency.rows[0].request_hash !== requestHash) throw new DomainError(409, 'idempotency_key_reused', 'Этот ключ повтора уже связан с другим подтверждением.');
        await client.query('COMMIT');
        return idempotency.rows[0].result;
      }
      const selected = new Set(input.rowNumbers); const reviewed = new Set(input.reviewedRows);
      if ([...selected, ...reviewed].some((rowNumber) => !Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 10000000) ||
        new Set(input.rowNumbers).size !== input.rowNumbers.length || new Set(input.reviewedRows).size !== input.reviewedRows.length ||
        [...reviewed].some((rowNumber) => !selected.has(rowNumber))) throw new DomainError(400, 'invalid_import_rows', 'Список строк подтверждения некорректен.');
      const confirmationId = randomUUID(); const byRow = new Map(job.preview.map((row) => [row.rowNumber, row]));
      const rowResults: { rowNumber: number; status: string; entityId?: string; reason?: string }[] = job.preview
        .filter((row) => row.status === 'skipped_null')
        .map((row) => ({ rowNumber: row.rowNumber, status: 'skipped', reason: row.warnings[0] ?? 'Запись JSON имеет значение null; она пропущена.' }));
      for (const rowNumber of input.rowNumbers) {
        const row = byRow.get(rowNumber);
        if (!row) throw new DomainError(400, 'invalid_import_rows', 'Строка отсутствует в сохранённом предпросмотре.');
        if (row.status === 'skipped_null') continue;
        if (row.status === 'invalid' || row.status === 'blocked' || row.status === 'duplicate_in_file') {
          rowResults.push({ rowNumber, status: 'skipped', reason: row.warnings[0] ?? row.errors[0] ?? 'Строка не прошла проверку.' }); continue;
        }
        if ((row.status === 'changed_requires_review' || row.status === 'possible_duplicate') && !reviewed.has(rowNumber)) {
          rowResults.push({ rowNumber, status: 'skipped', reason: row.status === 'possible_duplicate' ? 'Не подтверждено создание отдельной записи при возможном совпадении.' : 'Изменение существующего источника не было отдельно проверено.' }); continue;
        }
        const previous = await client.query('SELECT payload_hash,entity_id,action FROM import_applied_rows WHERE job_id=$1 AND row_number=$2', [id, rowNumber]);
        if (previous.rowCount) {
          if (previous.rows[0].payload_hash !== row.payloadHash) {
            rowResults.push({ rowNumber, status: 'conflict', reason: 'Данные строки изменились после предыдущей обработки; создайте новый предпросмотр.' });
          } else {
            rowResults.push({ rowNumber, status: 'unchanged', entityId: previous.rows[0].entity_id, reason: 'Эта строка уже обработана.' });
          }
          continue;
        }
        await client.query('SAVEPOINT import_row');
        try {
          const applied = await this.applyRow(client, actor, job, row, confirmationId);
          await client.query('INSERT INTO import_applied_rows(job_id,row_number,payload_hash,entity_id,action) VALUES($1,$2,$3,$4,$5)', [id, rowNumber, row.payloadHash, applied.entityId, applied.action]);
          await client.query('RELEASE SAVEPOINT import_row');
          rowResults.push({ rowNumber, status: applied.action, entityId: applied.entityId, reason: applied.reason });
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT import_row'); await client.query('RELEASE SAVEPOINT import_row');
          if (error instanceof DomainError && error.code === 'import_contact_scope_conflict') throw error;
          const status = error instanceof DomainError && error.statusCode === 409 ? 'conflict' : 'failed';
          rowResults.push({ rowNumber, status, reason: error instanceof DomainError ? error.message : 'Строку не удалось сохранить; её можно повторить.' });
        }
      }
      const cumulativeRows = new Map<number, (typeof rowResults)[number]>((Array.isArray((job.result as any)?.rowResults) ? (job.result as any).rowResults : []).map((item: (typeof rowResults)[number]) => [item.rowNumber, item]));
      for (const item of rowResults) cumulativeRows.set(item.rowNumber, item);
      const allRowResults = [...cumulativeRows.values()].sort((left, right) => left.rowNumber - right.rowNumber);
      const counts = allRowResults.reduce((result: Record<string, number>, item) => { result[item.status] = (result[item.status] ?? 0) + 1; return result; }, {});
      const result = { id, revision: job.revision, confirmationId, createdAt: new Date().toISOString(), rowResults: allRowResults, counts };
      await client.query('INSERT INTO import_confirmations(id,job_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)', [confirmationId, id, input.idempotencyKey, requestHash, JSON.stringify(result)]);
      await client.query(`UPDATE import_jobs SET status='completed',result=$2::jsonb WHERE id=$1`, [id, JSON.stringify(result)]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async cancel(actor: Actor, id: string) {
    assertBusinessAccess(actor);
    await purgeExpired();
    const result = await pool.query('SELECT status,target FROM import_jobs WHERE id=$1 AND actor_sub=$2', [id, actor.sub]);
    if (!result.rowCount) throw new DomainError(404, 'import_not_found', 'Импорт не найден или недоступен.');
    assertImportTargetScope(actor, result.rows[0].target as ImportTarget);
    if (result.rows[0].status === 'expired') throw new DomainError(410, 'import_expired', 'Предпросмотр уже истёк.');
    if (result.rows[0].status === 'completed') throw new DomainError(409, 'import_already_confirmed', 'Подтверждённый импорт нельзя отменить.');
    await pool.query('DELETE FROM import_jobs WHERE id=$1 AND actor_sub=$2 AND status IN (\'uploaded\',\'preview_ready\')', [id, actor.sub]);
  }

  private async applyRow(client: any, actor: Actor, job: ImportJob, row: PreviewRow, confirmationId: string): Promise<{ entityId: string; action: 'created' | 'updated' | 'unchanged'; reason: string }> {
    assertImportTargetScope(actor, job.target);
    if (row.externalKey) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([job.target, job.sourceSystem, row.externalKey])]);
    }
    const identityResult = row.externalKey ? await client.query('SELECT id,owner_sub,entity_id,payload_hash FROM import_identities WHERE target=$1 AND source_system=$2 AND external_key=$3 FOR UPDATE', [job.target, job.sourceSystem, row.externalKey]) : { rowCount: 0, rows: [] };
    const identity = identityResult.rows[0];
    if (identity && identity.owner_sub !== actor.sub) throw new DomainError(409, 'import_identity_scope_conflict', 'Внешний ключ уже принадлежит другой области доступа.');
    if (!identity && row.baseHash) throw new DomainError(409, 'import_source_removed', 'Запись внешнего источника больше не найдена. Создайте новый предпросмотр.');
    if (identity && identity.payload_hash !== row.baseHash && identity.payload_hash !== row.payloadHash) throw new DomainError(409, 'import_source_changed', 'Источник изменился после предпросмотра. Загрузите обновлённый файл и проверьте изменения заново.');
    if (identity) await this.assertExistingEntityScope(client, actor, job.target, identity.entity_id);
    if (identity && identity.payload_hash === row.payloadHash) {
      const entityId = identity.entity_id;
      await this.writeProvenance(client, job, row, actor, confirmationId, entityId, 'unchanged');
      return { entityId, action: 'unchanged', reason: 'Внешние данные не изменились.' };
    }
    let entityId: string; let action: 'created' | 'updated';
    if (job.target === 'contacts') ({ entityId, action } = await this.applyContact(client, actor, job, row, identity));
    else if (job.target === 'vendors') ({ entityId, action } = await this.applyVendor(client, actor, job, row, identity));
    else ({ entityId, action } = await this.applyApplication(client, actor, job, row, identity));
    if (row.externalKey) {
      if (identity) await client.query('UPDATE import_identities SET payload_hash=$2,updated_at=now() WHERE id=$1', [identity.id, row.payloadHash]);
      else await client.query(`INSERT INTO import_identities(id,target,source_system,external_key,owner_sub,entity_id,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), job.target, job.sourceSystem, row.externalKey, actor.sub, entityId, row.payloadHash]);
    }
    await this.writeProvenance(client, job, row, actor, confirmationId, entityId, action);
    return { entityId, action, reason: action === 'created' ? 'Запись создана.' : 'Проверенное изменение сохранено.' };
  }

  private async assertExistingEntityScope(client: any, actor: Actor, target: ImportTarget, entityId: string) {
    if (target === 'contacts') {
      const lockedPerson = await client.query('SELECT id FROM people WHERE id=$1 FOR UPDATE', [entityId]);
      if (!lockedPerson.rowCount) throw new DomainError(409, 'import_contact_scope_conflict', 'Контакт больше не входит в вашу область доступа.');
      const linkedActivities = await client.query('SELECT organization_id,payer_organization_id FROM activities WHERE person_id=$1 FOR UPDATE', [entityId]);
      const visible = await client.query(`SELECT p.id FROM people p WHERE p.id=$3 AND ${contactPersonKindScope}`,
        [actor.sub, actor.allowedKinds ?? allActivityKinds, entityId]);
      if (!visible.rowCount) throw new DomainError(409, 'import_contact_scope_conflict', 'Контакт больше не входит в вашу область доступа.');
      for (const activity of linkedActivities.rows as { organization_id: string | null; payer_organization_id: string | null }[]) {
        this.assertLinkedOrganizationScope(actor, activity.organization_id, activity.payer_organization_id);
      }
      return;
    }
    if (target === 'individual_applications') {
      const activity = await client.query(`SELECT id,organization_id,payer_organization_id FROM activities
        WHERE id=$1 AND owner_sub=$2 AND import_owner_only=TRUE AND kind='individual' FOR UPDATE`, [entityId, actor.sub]);
      if (!activity.rowCount) throw new DomainError(409, 'import_application_scope_conflict', 'Заявка больше не принадлежит вашей области доступа.');
      this.assertLinkedOrganizationScope(actor, activity.rows[0].organization_id, activity.rows[0].payer_organization_id);
    }
  }

  private assertLinkedOrganizationScope(actor: Actor, organizationId: string | null, payerOrganizationId: string | null) {
    const allowed = actor.allowedOrganizationIds;
    if (allowed == null || ((!organizationId || allowed.includes(organizationId)) && (!payerOrganizationId || allowed.includes(payerOrganizationId)))) return;
    throw new DomainError(409, 'import_entity_scope_conflict', 'Связанная с записью организация больше не входит в вашу область доступа.');
  }

  private async applyContact(client: any, actor: Actor, job: ImportJob, row: PreviewRow, identity: any) {
    if (identity) {
      const dbFields: Record<string, string> = { fullName: 'full_name', email: 'email', phone: 'phone', organizationName: 'organization_name' };
      const mappedFields = new Set(Object.values(job.mapping).filter((field): field is string => typeof field === 'string' && field.length > 0));
      const values: unknown[] = [identity.entity_id]; const assignments = [] as string[];
      for (const [field, column] of Object.entries(dbFields)) if (mappedFields.has(field)) {
        const raw = row.values[field] ?? null;
        const value = field === 'fullName' ? raw!.trim() : raw?.trim() ? raw : null;
        values.push(value); assignments.push(`${column}=$${values.length}`);
      }
      values.push(row.payloadHash); assignments.push(`import_payload_hash=$${values.length}`);
      await client.query(`UPDATE people SET ${assignments.join(',')} WHERE id=$1`, values);
      return { entityId: identity.entity_id, action: 'updated' as const };
    }
    const id = randomUUID();
    await client.query(`INSERT INTO people(id,full_name,email,phone,organization_name,import_owner_sub,import_source,import_external_key,import_payload_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, row.values.fullName!.trim(), row.values.email ?? null, row.values.phone ?? null, row.values.organizationName ?? null, actor.sub, job.sourceSystem, row.externalKey, row.payloadHash]);
    return { entityId: id, action: 'created' as const };
  }

  private async applyVendor(client: any, actor: Actor, job: ImportJob, row: PreviewRow, identity: any) {
    let id: string;
    if (identity) {
      const visible = await client.query('SELECT id FROM vendors WHERE id=$1 AND owner_sub=$2 FOR UPDATE', [identity.entity_id, actor.sub]);
      if (!visible.rowCount) throw new DomainError(409, 'import_vendor_scope_conflict', 'Поставщик больше не принадлежит вашей области доступа.');
      id = identity.entity_id;
      await client.query('UPDATE vendors SET name=$2,import_source=$3,import_external_key=$4,import_payload_hash=$5,updated_at=now() WHERE id=$1', [id, row.values.name!.trim(), job.sourceSystem, row.externalKey, row.payloadHash]);
    } else {
      id = randomUUID();
      await client.query('INSERT INTO vendors(id,name,owner_sub,import_source,import_external_key,import_payload_hash) VALUES($1,$2,$3,$4,$5,$6)', [id, row.values.name!.trim(), actor.sub, job.sourceSystem, row.externalKey, row.payloadHash]);
    }
    if (Object.values(job.mapping).includes('productNames')) {
      const prior = identity
        ? await client.query('SELECT product_id::text AS id FROM vendor_products WHERE vendor_id=$1 FOR UPDATE', [id])
        : { rows: [] as { id: string }[] };
      const priorIds = new Set((prior.rows as { id: string }[]).map((product) => product.id));
      const names = [...new Set((row.values.productNames ?? '').split(/[;\n]/).map((value) => value.trim()).filter(Boolean))];
      const desiredIds: string[] = [];
      for (const name of names) {
        let matched = await client.query('SELECT id::text AS id,catalog_visible FROM products WHERE lower(trim(name))=lower(trim($1)) ORDER BY id LIMIT 1 FOR SHARE', [name]);
        let product = matched.rows[0] as { id: string; catalog_visible: boolean } | undefined;
        if (!product) {
          const inserted = await client.query('INSERT INTO products(id,name) VALUES($1,$2) ON CONFLICT(name) DO NOTHING RETURNING id::text AS id,catalog_visible', [randomUUID(), name]);
          product = inserted.rows[0] as { id: string; catalog_visible: boolean } | undefined;
          if (!product) {
            matched = await client.query('SELECT id::text AS id,catalog_visible FROM products WHERE lower(trim(name))=lower(trim($1)) ORDER BY id LIMIT 1 FOR SHARE', [name]);
            product = matched.rows[0] as { id: string; catalog_visible: boolean } | undefined;
          }
        }
        if (!product) continue;
        if (!product.catalog_visible && !priorIds.has(product.id)) {
          throw new DomainError(409, 'import_product_changed', `Скрытый продукт «${name.slice(0, 80)}» нельзя добавить поставщику.`);
        }
        desiredIds.push(product.id);
      }
      await client.query('DELETE FROM vendor_products WHERE vendor_id=$1 AND NOT (product_id=ANY($2::uuid[]))', [id, desiredIds]);
      for (const productId of desiredIds) if (!priorIds.has(productId)) {
        await client.query('INSERT INTO vendor_products(vendor_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, productId]);
      }
    }
    return { entityId: id, action: identity ? 'updated' as const : 'created' as const };
  }

  private async applyApplication(client: any, actor: Actor, job: ImportJob, row: PreviewRow, identity: any) {
    let id: string;
    let personId: string;
    let action: 'created' | 'updated';
    if (identity) {
      const activity = await client.query(`SELECT id,person_id FROM activities WHERE id=$1 AND owner_sub=$2 AND import_owner_only=TRUE AND kind='individual' FOR UPDATE`, [identity.entity_id, actor.sub]);
      if (!activity.rowCount) throw new DomainError(409, 'import_application_scope_conflict', 'Заявка больше не принадлежит вашей области доступа.');
      id = identity.entity_id; personId = activity.rows[0].person_id;
      const dbFields: Record<string, string> = { fullName: 'full_name', email: 'email', phone: 'phone' };
      const mappedFields = new Set(Object.values(job.mapping).filter((field): field is string => typeof field === 'string' && field.length > 0));
      const values: unknown[] = [personId]; const assignments = [] as string[];
      for (const [field, column] of Object.entries(dbFields)) if (mappedFields.has(field)) {
        const raw = row.values[field] ?? null;
        const value = field === 'fullName' ? raw!.trim() : raw?.trim() ? raw : null;
        values.push(value); assignments.push(`${column}=$${values.length}`);
      }
      values.push(row.payloadHash); assignments.push(`import_payload_hash=$${values.length}`);
      values.push(actor.sub); await client.query(`UPDATE people SET ${assignments.join(',')} WHERE id=$1 AND import_owner_sub=$${values.length}`, values);
      let titleProduct = row.values.productName?.trim() ?? null;
      let productsChanged = false;
      if (mappedFields.has('productName')) {
        const priorProducts = await client.query('SELECT product_id::text AS id FROM activity_products WHERE activity_id=$1 ORDER BY product_id FOR UPDATE', [id]);
        let nextProductId: string | null = null;
        if (titleProduct) {
          const product = await client.query('SELECT id::text AS id,catalog_visible FROM products WHERE lower(trim(name))=lower(trim($1)) ORDER BY id LIMIT 1 FOR SHARE', [titleProduct]);
          if (!product.rowCount) throw new DomainError(409, 'import_product_changed', 'Связанный продукт больше не найден в каталоге.');
          const priorProductIds = priorProducts.rows.map((product: { id: string }) => product.id);
          if (!product.rows[0].catalog_visible && !priorProductIds.includes(product.rows[0].id)) {
            throw new DomainError(409, 'import_product_changed', `Скрытый продукт «${titleProduct.slice(0, 80)}» нельзя добавить к заявке.`);
          }
          nextProductId = product.rows[0].id;
        }
        const priorProductIds = priorProducts.rows.map((product: { id: string }) => product.id);
        const nextProductIds = nextProductId ? [nextProductId] : [];
        productsChanged = priorProductIds.length !== nextProductIds.length || priorProductIds.some((productId: string, index: number) => productId !== nextProductIds[index]);
        if (productsChanged) {
          await client.query('DELETE FROM activity_products WHERE activity_id=$1', [id]);
          if (nextProductId) await client.query('INSERT INTO activity_products(activity_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, nextProductId]);
        }
      } else titleProduct = (await client.query(`SELECT p.name FROM activity_products ap JOIN products p ON p.id=ap.product_id WHERE ap.activity_id=$1 ORDER BY p.name LIMIT 1`, [id])).rows[0]?.name ?? null;
      await client.query(`UPDATE activities SET title=$2,updated_at=now(),origin_reference=$3,
        details_revision=details_revision + CASE WHEN $4 THEN 1 ELSE 0 END WHERE id=$1`,
      [id, this.applicationTitle({ ...row.values, productName: titleProduct }), row.externalKey, productsChanged]);
      action = 'updated';
    } else {
      id = randomUUID(); personId = randomUUID();
      await client.query(`INSERT INTO people(id,full_name,email,phone,import_owner_sub,import_source,import_external_key,import_payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [personId, row.values.fullName!.trim(), row.values.email ?? null, row.values.phone ?? null, actor.sub, job.sourceSystem, row.externalKey, row.payloadHash]);
      await client.query(`INSERT INTO activities(id,kind,title,origin,origin_source,origin_reference,route_version,import_owner_only,person_id,stage_key,owner_sub,owner_name)
        VALUES($1,'individual',$2,'external_ready',$3,$4,'v2',TRUE,$5,'lms_handoff',$6,$7)`, [id, this.applicationTitle(row.values), job.sourceSystem, row.externalKey, personId, actor.sub, actor.name]);
      action = 'created';
    }
    if (row.values.productName?.trim() && action === 'created') {
      const product = await client.query('SELECT id,catalog_visible FROM products WHERE lower(trim(name))=lower(trim($1)) ORDER BY id LIMIT 1 FOR SHARE', [row.values.productName]);
      if (!product.rowCount) throw new DomainError(409, 'import_product_changed', 'Связанный продукт больше не найден в каталоге.');
      if (!product.rows[0].catalog_visible) throw new DomainError(409, 'import_product_changed', `Скрытый продукт «${row.values.productName.slice(0, 80)}» нельзя добавить к заявке.`);
      await client.query('INSERT INTO activity_products(activity_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, product.rows[0].id]);
    }
    await client.query(`INSERT INTO activity_events(id,activity_id,event_type,summary,details,actor_sub,actor_name)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [randomUUID(), id, action === 'created' ? 'external_application_imported' : 'external_application_import_updated',
      action === 'created' ? 'Внешняя заявка импортирована как индивидуальная CRM-активность.' : 'Данные внешней заявки обновлены после проверки.',
      JSON.stringify({ source: job.sourceSystem, externalKey: row.externalKey, importJobId: job.id, sourceRow: row.rowNumber, payloadHash: row.payloadHash, paymentStatus: 'unknown', enrollmentCreated: false }), actor.sub, actor.name]);
    return { entityId: id, action };
  }

  private applicationTitle(values: MappedValues) {
    const name = values.fullName?.trim() ?? 'Заявитель';
    const product = values.productName?.trim();
    return (product ? `${name} — ${product}` : `${name} — внешняя заявка`).slice(0, 180);
  }

  private async writeProvenance(client: any, job: ImportJob, row: PreviewRow, actor: Actor, confirmationId: string, entityId: string, action: string) {
    await client.query(`INSERT INTO import_provenance(id,job_id,confirmation_id,target,entity_id,source_system,external_key,file_name,
      source_row_number,raw_headings,mapping,payload_hash,action,actor_sub,actor_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)`, [
      randomUUID(), job.id, confirmationId, job.target, entityId, job.sourceSystem, row.externalKey,
      `${job.target}-${job.id}.${job.fileFormat}`, row.rowNumber, JSON.stringify(job.rawHeadings), JSON.stringify(job.mapping), row.payloadHash,
      action, actor.sub, actor.name,
    ]);
  }

  async listContacts(actor: Actor, queryValue: string) {
    assertBusinessAccess(actor);
    const query = queryValue.trim().slice(0, 100);
      const result = await pool.query(`SELECT DISTINCT p.id,p.full_name AS "fullName",p.email,p.phone,p.organization_name AS "organizationName"
      FROM people p WHERE ${contactPersonScope}
      AND ($4='' OR p.full_name ILIKE '%' || $4 || '%') ORDER BY p.full_name,p.id LIMIT 100`, [actor.sub, actor.allowedKinds ?? allActivityKinds, actor.allowedOrganizationIds ?? null, query]);
    return result.rows;
  }

  async listVendors(actor: Actor) {
    assertBusinessAccess(actor);
    const result = await pool.query(`SELECT v.id,v.name,coalesce(json_agg(json_build_object('id',p.id,'name',p.name) ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL),'[]'::json) AS products
      FROM vendors v LEFT JOIN vendor_products vp ON vp.vendor_id=v.id LEFT JOIN products p ON p.id=vp.product_id
      WHERE v.owner_sub=$1 GROUP BY v.id ORDER BY v.name,v.id LIMIT 500`, [actor.sub]);
    return result.rows;
  }
}

export const importSchemas = {
  targets: ['contacts','vendors','individual_applications'] as const,
  confirmationSchema: { type: 'object', additionalProperties: false, required: ['revision','idempotencyKey','rowNumbers','reviewedRows'], properties: {
    revision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
    rowNumbers: { type: 'array', maxItems: MAX_IMPORT_ROWS, items: { type: 'integer', minimum: 1 } },
    reviewedRows: { type: 'array', maxItems: MAX_IMPORT_ROWS, items: { type: 'integer', minimum: 1 } },
  } },
};

export function validateImportPreviewInput(input: unknown): asserts input is { revision: number; selectedSheet: string; headerRow: number; mapping: ImportMapping } {
  if (!input || typeof input !== 'object') throw new DomainError(400, 'invalid_import_preview', 'Проверьте строку заголовков и сопоставление колонок.');
  const candidate = input as Record<string, unknown>;
  if (!Number.isInteger(candidate.revision) || !Number.isInteger(candidate.headerRow) || typeof candidate.selectedSheet !== 'string' ||
    !candidate.selectedSheet || candidate.selectedSheet.length > 120 || !candidate.mapping || typeof candidate.mapping !== 'object' || Array.isArray(candidate.mapping)) {
    throw new DomainError(400, 'invalid_import_preview', 'Проверьте лист, строку заголовков и сопоставление колонок.');
  }
  const mapping = candidate.mapping as Record<string, unknown>;
  if (Object.keys(mapping).length > 100 || Object.values(mapping).some((value) => value !== null && typeof value !== 'string')) throw new DomainError(400, 'invalid_column_mapping', 'Сопоставление колонок некорректно.');
}

export function validateImportConfirmationInput(input: unknown): asserts input is ImportConfirmationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError(400, 'invalid_import_confirmation', 'Проверьте подтверждение предпросмотра.');
  const candidate = input as Record<string, unknown>;
  if (!Number.isInteger(candidate.revision) || typeof candidate.idempotencyKey !== 'string' || candidate.idempotencyKey.length < 8 || candidate.idempotencyKey.length > 128 ||
    !Array.isArray(candidate.rowNumbers) || candidate.rowNumbers.length > MAX_IMPORT_ROWS || !candidate.rowNumbers.every(Number.isInteger) ||
    !Array.isArray(candidate.reviewedRows) || candidate.reviewedRows.length > MAX_IMPORT_ROWS || !candidate.reviewedRows.every(Number.isInteger)) {
    throw new DomainError(400, 'invalid_import_confirmation', 'Проверьте подтверждение предпросмотра.');
  }
}

export function importTargetFields(target: ImportTarget) { return [...targetFields[target]]; }
