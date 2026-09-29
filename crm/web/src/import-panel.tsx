import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { formatRussianCount } from './russian-count';

type Api = <T,>(path: string, init?: RequestInit) => Promise<T>;
type Target = 'contacts' | 'vendors' | 'individual_applications';
type SheetPreview = { name: string; rowCount: number; firstRow: number; samples: string[][] };
type Candidate = { entityId: string; name: string; email?: string | null; phone?: string | null; reasons: string[] };
type PreviewRow = {
  rowNumber: number; sourceValues: (string | null)[]; values: Record<string, string | null>; status: string;
  errors: string[]; warnings: string[]; matches: Candidate[]; externalKey: string | null;
};
type ImportResultRow = { rowNumber: number; status: string; reason?: string };
type ImportResult = { rowResults: ImportResultRow[]; counts: Record<string, number>; createdAt: string };
type ImportJob = {
  id: string; revision: number; target: Target; sourceSystem: string; fileName: string; fileFormat: string; status: string;
  selectedSheet: string | null; headerRow: number | null; rawHeadings: string[]; mapping: Record<string, string | null>;
  sheets: SheetPreview[]; preview: PreviewRow[]; result: ImportResult | null; expiresAt: string;
};
type ImportConfirmation = { revision: number; idempotencyKey: string; rowNumbers: number[]; reviewedRows: number[] };
type ImportDraft = {
  jobId: string; scope: string; selectedSheetIndex: number; headerRow: number; mapping: Record<string, string | null>; mappingTouched: boolean;
  selectedRows: number[]; reviewedRows: number[]; confirmation: ImportConfirmation | null;
  pendingOperation: 'preview' | 'confirm' | null;
};
type StoredImportDraft = {
  version: 1; scope: string; jobId: string; selectedSheetIndex: number; headerRow: number;
  mapping: Record<string, string | null>; mappingTouched: boolean; selectedRows: number[]; reviewedRows: number[];
};

const importDraftStorageKey = 'lct-import-draft-v1';
const importScopeStorageKey = 'lct-import-scope-v1';
const importSheetLimit = 100;
const importRowLimit = 2000;

// The server owns uploaded content, preview data, and results. The browser keeps only a job
// reference and small, validated controls so navigation and same-tab reload can resume the job.
let activeImportDraft: ImportDraft | null = null;
const importJobListeners = new Set<() => void>();

function fingerprintScope(scope: string) {
  // The auth scope is already held by the app. Keep only a short fingerprint in the import draft.
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < scope.length; index += 1) {
    first = Math.imul(first ^ scope.charCodeAt(index), 16777619);
    second = Math.imul(second ^ scope.charCodeAt(index), 3266489917);
  }
  return `v1-${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

function validRowNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= importRowLimit && value.every((row) => Number.isSafeInteger(row) && row > 0);
}

function sanitizeMapping(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
  return Object.fromEntries(entries.flatMap(([index, field]) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(index) || Number(index) >= 100) return [];
    if (field !== null && !(typeof field === 'string' && Object.values(fieldsByTarget).some((fields) => fields.includes(field)))) return [];
    return [[index, field as string | null]];
  }));
}

function hasStoredImportDraft(scope: string) {
  try {
    const value = JSON.parse(sessionStorage.getItem(importDraftStorageKey) ?? 'null') as Partial<StoredImportDraft> | null;
    return value?.version === 1 && value.scope === scope && typeof value.jobId === 'string';
  } catch { return false; }
}

function readStoredImportDraft(scope: string): ImportDraft | null {
  try {
    const raw = sessionStorage.getItem(importDraftStorageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredImportDraft>;
    if (value.version !== 1 || value.scope !== scope || typeof value.jobId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.jobId) ||
      !Number.isInteger(value.selectedSheetIndex) || value.selectedSheetIndex! < 0 || value.selectedSheetIndex! >= importSheetLimit ||
      !Number.isInteger(value.headerRow) || value.headerRow! < 1 || value.headerRow! > 2002 ||
      typeof value.mappingTouched !== 'boolean' || !validRowNumbers(value.selectedRows) || !validRowNumbers(value.reviewedRows)) {
      sessionStorage.removeItem(importDraftStorageKey);
      return null;
    }
    return {
      jobId: value.jobId, scope, selectedSheetIndex: value.selectedSheetIndex!, headerRow: value.headerRow!,
      mapping: sanitizeMapping(value.mapping), mappingTouched: value.mappingTouched,
      selectedRows: value.selectedRows, reviewedRows: value.reviewedRows, confirmation: null, pendingOperation: null,
    };
  } catch {
    return null;
  }
}

function persistImportDraft() {
  const draft = activeImportDraft;
  if (!draft) return;
  const stored: StoredImportDraft = {
    version: 1, scope: draft.scope, jobId: draft.jobId,
    selectedSheetIndex: Math.max(0, Math.min(importSheetLimit - 1, Math.trunc(draft.selectedSheetIndex))),
    headerRow: Math.max(1, Math.min(2002, Math.trunc(draft.headerRow))),
    mapping: sanitizeMapping(draft.mapping), mappingTouched: draft.mappingTouched,
    selectedRows: validRowNumbers(draft.selectedRows) ? draft.selectedRows : [],
    reviewedRows: validRowNumbers(draft.reviewedRows) ? draft.reviewedRows : [],
  };
  try { sessionStorage.setItem(importDraftStorageKey, JSON.stringify(stored)); } catch { /* Resume remains available from module memory until navigation. */ }
}

function getImportDraft(scope: string): ImportDraft | null {
  if (activeImportDraft && activeImportDraft.scope !== scope) activeImportDraft = null;
  if (activeImportDraft) return activeImportDraft;
  activeImportDraft = readStoredImportDraft(scope);
  return activeImportDraft;
}

function updateImportDraft(jobId: string, patch: Partial<Omit<ImportDraft, 'jobId' | 'scope'>>) {
  if (activeImportDraft?.jobId === jobId) {
    activeImportDraft = { ...activeImportDraft, ...patch };
    persistImportDraft();
  }
}

function clearImportDraft(jobId?: string) {
  if (!jobId || activeImportDraft?.jobId === jobId) {
    activeImportDraft = null;
    try {
      const stored = sessionStorage.getItem(importDraftStorageKey);
      if (!jobId || !stored || (JSON.parse(stored) as Partial<StoredImportDraft>).jobId === jobId) sessionStorage.removeItem(importDraftStorageKey);
    } catch { try { sessionStorage.removeItem(importDraftStorageKey); } catch { /* Storage may be unavailable. */ } }
  }
}

export function clearStoredImportDraft() {
  clearImportDraft();
  try { sessionStorage.removeItem(importScopeStorageKey); } catch { /* Storage may be unavailable. */ }
  notifyImportJobSettled();
}

export function prepareImportSession(scopeValue: string) {
  const scope = fingerprintScope(scopeValue);
  try {
    const previousScope = sessionStorage.getItem(importScopeStorageKey);
    const storedDraft = readStoredImportDraft(scope);
    if ((previousScope && previousScope !== scope) || (!storedDraft && sessionStorage.getItem(importDraftStorageKey))) clearImportDraft();
    sessionStorage.setItem(importScopeStorageKey, scope);
  } catch { /* Storage may be unavailable; scoped GET still enforces server access. */ }
}

function notifyImportJobSettled() {
  importJobListeners.forEach((listener) => listener());
}

function sameRowNumbers(left: number[], right: number[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

const targetLabels: Record<Target, string> = { contacts: 'Люди и контакты', vendors: 'Поставщики и продукты', individual_applications: 'Индивидуальные заявки' };
const fieldLabels: Record<string, string> = {
  externalKey: 'Внешний ключ', fullName: 'Имя и фамилия', email: 'Электронная почта', phone: 'Телефон', organizationName: 'Организация в источнике',
  name: 'Название поставщика', productNames: 'Связанные продукты', productName: 'Продукт заявки',
};
const sourceDefaults: Record<Target, string> = { contacts: 'User Uploads', vendors: 'Vendors', individual_applications: 'External Applications' };
const fieldsByTarget: Record<Target, string[]> = {
  contacts: ['externalKey','fullName','email','phone','organizationName'],
  vendors: ['externalKey','name','productNames'],
  individual_applications: ['externalKey','fullName','email','phone','productName'],
};
const headerAliases: Record<string, string[]> = {
  externalKey: ['external id','external key','external_key','user id','user_id','vendor id','vendor_id','application id','application_id','id','внешний id','идентификатор','ключ'],
  fullName: ['full name','fullname','name','applicant.fullname','applicant.name','фио','имя','физлицо'],
  email: ['email','e-mail','applicant.email','почта','электронная почта'],
  phone: ['phone','phone number','applicant.phone','телефон','мобильный'],
  organizationName: ['organization','organization name','company','company name','организация','компания'],
  name: ['vendor','vendor name','supplier','supplier name','name','название поставщика','поставщик'],
  productNames: ['products','product names','productnames','products.name','продукты','программы','продукты поставщика'],
  productName: ['product','product name','program','program name','course','продукт','программа','курс'],
};

function guessMapping(target: Target, headings: string[]) {
  const result: Record<string, string | null> = {};
  const used = new Set<string>();
  headings.forEach((heading, index) => {
    const normalized = heading.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
    const match = fieldsByTarget[target].find((field) => !used.has(field) && headerAliases[field]?.includes(normalized));
    result[String(index)] = match ?? null;
    if (match) used.add(match);
  });
  return result;
}

function statusLabel(status: string) {
  return ({ valid: 'Готово к импорту', invalid: 'Ошибка в данных', unchanged: 'Без изменений', changed_requires_review: 'Изменение требует проверки', possible_duplicate: 'Возможное совпадение', blocked: 'Недоступно', duplicate_in_file: 'Повтор в файле', skipped_null: 'Пустая запись пропущена', created: 'Создано', updated: 'Обновлено', skipped: 'Пропущено', conflict: 'Конфликт', failed: 'Ошибка' } as Record<string, string>)[status] ?? status;
}

export function ImportPanel({ api, onCompleted, scope }: { api: Api; onCompleted: () => void; scope: string }) {
  const scopedKey = fingerprintScope(scope);
  const [target, setTarget] = useState<Target>('contacts');
  const [source, setSource] = useState(sourceDefaults.contacts);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [headerRow, setHeaderRow] = useState(1);
  const [headerHeadings, setHeaderHeadings] = useState<string[]>([]);
  const [headerLoading, setHeaderLoading] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [reviewedRows, setReviewedRows] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState(() => activeImportDraft?.scope === scopedKey || hasStoredImportDraft(scopedKey));
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [resumeRevision, setResumeRevision] = useState(0);

  const fields = fieldsByTarget[target];
  const sheet = job?.sheets.find((item) => item.name === selectedSheet) ?? job?.sheets[0];
  const headings = job?.rawHeadings.length ? job.rawHeadings : headerHeadings.length ? headerHeadings : sheet?.samples[0] ?? [];
  const reviewEligible = useMemo(() => job?.preview.filter((row) => ['valid','unchanged','possible_duplicate','changed_requires_review'].includes(row.status)) ?? [], [job]);

  useEffect(() => {
    const listener = () => setResumeRevision((revision) => revision + 1);
    importJobListeners.add(listener);
    return () => { importJobListeners.delete(listener); };
  }, []);

  useEffect(() => {
    const draft = getImportDraft(scopedKey);
    if (!draft) { setRestoring(false); setLoading(false); return; }
    let cancelled = false;
    setRestoring(true);
    setRestoreFailed(false);
    setLoading(draft.pendingOperation !== null);
    api<ImportJob>(`/api/imports/${draft.jobId}`).then((response) => {
      if (cancelled || activeImportDraft?.jobId !== draft.jobId) return;
      const firstSheet = response.sheets[0];
      const serverSheetIndex = response.sheets.findIndex((item) => item.name === response.selectedSheet);
      const restoredSheetIndex = response.status === 'uploaded'
        ? Math.min(draft.selectedSheetIndex, Math.max(0, response.sheets.length - 1))
        : serverSheetIndex >= 0 ? serverSheetIndex : Math.min(draft.selectedSheetIndex, Math.max(0, response.sheets.length - 1));
      const restoredSheet = response.status === 'uploaded'
        ? response.sheets[restoredSheetIndex]?.name ?? firstSheet?.name ?? ''
        : response.selectedSheet ?? response.sheets[restoredSheetIndex]?.name ?? firstSheet?.name ?? '';
      const restoredHeaderRow = response.status === 'uploaded'
        ? draft.headerRow || response.sheets[restoredSheetIndex]?.firstRow || 1
        : response.headerRow ?? draft.headerRow;
      const allowedFields = new Set(fieldsByTarget[response.target]);
      const savedMapping = Object.fromEntries(Object.entries(draft.mapping).filter(([, field]) => field === null || allowedFields.has(field)));
      const restoredMapping = response.status === 'uploaded' && Object.keys(savedMapping).length
        ? savedMapping
        : response.mapping;
      const eligibleRows = response.status === 'preview_ready' ? response.preview.filter((row) => ['valid','unchanged','possible_duplicate','changed_requires_review'].includes(row.status)) : [];
      const eligibleRowNumbers = new Set(eligibleRows.map((row) => row.rowNumber));
      const reviewableRowNumbers = new Set(eligibleRows.filter((row) => ['possible_duplicate','changed_requires_review'].includes(row.status)).map((row) => row.rowNumber));
      setJob(response);
      setError('');
      setTarget(response.target);
      setSource(response.sourceSystem);
      setSelectedSheet(restoredSheet);
      setHeaderRow(restoredHeaderRow);
      setHeaderHeadings(response.rawHeadings.length ? response.rawHeadings : response.sheets.find((item) => item.name === restoredSheet)?.samples[0] ?? []);
      setMapping(restoredMapping);
      const restoredRows = draft.selectedRows.filter((rowNumber) => eligibleRowNumbers.has(rowNumber));
      const restoredReviews = draft.reviewedRows.filter((rowNumber) => reviewableRowNumbers.has(rowNumber));
      setSelectedRows(restoredRows);
      setReviewedRows(restoredReviews);
      updateImportDraft(draft.jobId, {
        selectedSheetIndex: restoredSheetIndex,
        headerRow: restoredHeaderRow,
        mapping: restoredMapping,
        selectedRows: restoredRows,
        reviewedRows: restoredReviews,
      });
    }).catch((reason) => {
      if (cancelled) return;
      setJob(null);
      const status = (reason as Error & { status?: number; code?: string })?.status;
      if (status === 403 || status === 404 || status === 410) {
        clearImportDraft(draft.jobId);
        setRestoreFailed(false);
        setError(status === 403
          ? 'Сохранённый импорт недоступен в текущей области доступа. Выберите файл для нового импорта.'
          : status === 410
            ? (reason instanceof Error ? reason.message : 'Срок хранения предпросмотра истёк; загрузите файл заново.')
            : 'Сохранённый импорт больше не найден. Выберите файл для нового импорта.');
      } else {
        setRestoreFailed(true);
        setError(reason instanceof Error ? reason.message : 'Не удалось восстановить импорт. Попробуйте ещё раз.');
      }
    }).finally(() => {
      if (!cancelled) {
        setRestoring(false);
        setLoading(Boolean(activeImportDraft?.pendingOperation));
      }
    });
    return () => { cancelled = true; };
  }, [api, resumeRevision, scopedKey]);

  useEffect(() => {
    if (!job || job.status !== 'uploaded' || !selectedSheet) return;
    let cancelled = false;
    const query = new URLSearchParams({ sheet: selectedSheet, row: String(headerRow) });
    setHeaderLoading(true);
    api<{ values: string[] }>(`/api/imports/${job.id}/header?${query}`).then((response) => {
      if (cancelled) return;
      setHeaderHeadings(response.values);
      if (activeImportDraft?.jobId === job.id && activeImportDraft.mappingTouched) return;
      const nextMapping = guessMapping(job.target, response.values);
      setMapping(nextMapping);
      updateImportDraft(job.id, { mapping: nextMapping });
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Не удалось прочитать строку заголовков.');
    }).finally(() => { if (!cancelled) setHeaderLoading(false); });
    return () => { cancelled = true; };
  }, [api, job?.id, job?.status, job?.target, selectedSheet, headerRow]);

  function chooseTarget(next: Target) {
    clearImportDraft();
    setTarget(next); setSource(sourceDefaults[next]); setFile(null); setJob(null); setHeaderHeadings([]); setError('');
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    clearImportDraft();
    setFile(event.target.files?.[0] ?? null); setJob(null); setHeaderHeadings([]); setError(''); setSelectedRows([]); setReviewedRows([]);
  }

  async function upload() {
    if (!file) { setError('Сначала выберите файл.'); return; }
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ filename: file.name, target, source });
      const response = await api<Omit<ImportJob, 'status' | 'selectedSheet' | 'headerRow' | 'rawHeadings' | 'mapping' | 'preview' | 'result'>>(`/api/imports?${query}`, { method: 'POST', body: file, headers: { 'content-type': 'application/vnd.lct.import' } });
      activeImportDraft = {
        jobId: response.id, scope: scopedKey, selectedSheetIndex: 0, headerRow: response.sheets[0]?.firstRow ?? 1,
        mapping: guessMapping(target, response.sheets[0]?.samples[0] ?? []), mappingTouched: false,
        selectedRows: [], reviewedRows: [], confirmation: null, pendingOperation: null,
      };
      persistImportDraft();
      setJob({ ...response, status: 'uploaded', selectedSheet: response.sheets[0]?.name ?? '', headerRow: null, rawHeadings: [], mapping: {}, preview: [], result: null });
      setSelectedSheet(response.sheets[0]?.name ?? ''); setHeaderRow(response.sheets[0]?.firstRow ?? 1); setSelectedRows([]); setReviewedRows([]);
      setHeaderHeadings(response.sheets[0]?.samples[0] ?? []);
      setMapping(guessMapping(target, response.sheets[0]?.samples[0] ?? []));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось прочитать файл.'); }
    finally { setLoading(false); }
  }

  async function makePreview() {
    if (!job) return;
    updateImportDraft(job.id, { pendingOperation: 'preview' });
    setLoading(true); setError('');
    try {
      const response = await api<ImportJob>(`/api/imports/${job.id}/preview`, { method: 'PUT', body: JSON.stringify({ revision: job.revision, selectedSheet, headerRow, mapping }) });
      setJob(response);
      const nextSelectedRows = response.preview.filter((row) => ['valid','unchanged'].includes(row.status)).map((row) => row.rowNumber);
      setSelectedRows(nextSelectedRows);
      setReviewedRows([]);
      updateImportDraft(job.id, {
        selectedSheetIndex: Math.max(0, job.sheets.findIndex((item) => item.name === selectedSheet)),
        headerRow, mapping, mappingTouched: false, selectedRows: nextSelectedRows, reviewedRows: [], confirmation: null,
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось проверить строки.'); }
    finally { updateImportDraft(job.id, { pendingOperation: null }); setLoading(false); notifyImportJobSettled(); }
  }

  function toggleRow(rowNumber: number, checked: boolean) {
    const nextRows = checked ? [...new Set([...selectedRows,rowNumber])] : selectedRows.filter((value) => value !== rowNumber);
    setSelectedRows(nextRows);
    if (job) updateImportDraft(job.id, { selectedRows: nextRows });
  }
  function toggleReviewed(rowNumber: number, checked: boolean) {
    const nextReviewedRows = checked ? [...new Set([...reviewedRows,rowNumber])] : reviewedRows.filter((value) => value !== rowNumber);
    const nextSelectedRows = checked ? [...new Set([...selectedRows,rowNumber])] : selectedRows.filter((value) => value !== rowNumber);
    setReviewedRows(nextReviewedRows);
    setSelectedRows(nextSelectedRows);
    if (job) updateImportDraft(job.id, { reviewedRows: nextReviewedRows, selectedRows: nextSelectedRows });
  }

  async function confirmRows(rowNumbers: number[], reviewed: number[]) {
    if (!job || !rowNumbers.length) return;
    const existingConfirmation = activeImportDraft?.jobId === job.id ? activeImportDraft.confirmation : null;
    const confirmation = existingConfirmation?.revision === job.revision &&
      sameRowNumbers(existingConfirmation.rowNumbers, rowNumbers) && sameRowNumbers(existingConfirmation.reviewedRows, reviewed)
      ? existingConfirmation
      : { revision: job.revision, idempotencyKey: crypto.randomUUID(), rowNumbers: [...rowNumbers], reviewedRows: [...reviewed] };
    updateImportDraft(job.id, { confirmation, pendingOperation: 'confirm' });
    setLoading(true); setError('');
    try {
      const result = await api<ImportResult>(`/api/imports/${job.id}/confirm`, { method: 'POST', body: JSON.stringify({ revision: confirmation.revision, idempotencyKey: confirmation.idempotencyKey, rowNumbers: confirmation.rowNumbers, reviewedRows: confirmation.reviewedRows }) });
      setJob((current) => current ? { ...current, status: 'completed', result } : current);
      updateImportDraft(job.id, { confirmation: null });
      onCompleted();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось подтвердить импорт.'); }
    finally { updateImportDraft(job.id, { pendingOperation: null }); setLoading(false); notifyImportJobSettled(); }
  }

  async function retryRows() {
    const retryable = job?.result?.rowResults.filter((row) => row.status === 'failed').map((row) => row.rowNumber) ?? [];
    const reviewable = job?.preview.filter((row) => retryable.includes(row.rowNumber) && ['possible_duplicate','changed_requires_review'].includes(row.status)).map((row) => row.rowNumber) ?? [];
    await confirmRows(retryable, reviewable);
  }

  async function cancel() {
    if (!job) return;
    setLoading(true); setError('');
    try { await api<void>(`/api/imports/${job.id}`, { method: 'DELETE' }); clearImportDraft(job.id); setJob(null); setFile(null); setSelectedRows([]); setReviewedRows([]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось закрыть предпросмотр.'); }
    finally { setLoading(false); }
  }

  return <div className="import-page">
    <div className="page-heading import-heading">
      <div><div className="eyebrow">ДАННЫЕ · ИМПОРТ</div><h1>Импорт контактов, поставщиков и заявок</h1><p>Файл сначала проверяется и показывается вам. CRM изменится только после отдельного подтверждения.</p></div>
      {job && <span className={`import-state ${job.status}`}>{job.status === 'completed' ? 'Результат сохранён' : `Предпросмотр до ${new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(new Date(job.expiresAt))}`}</span>}
    </div>

    {error && <div className="alert error" role="alert"><span>!</span>{error}{restoreFailed && <button onClick={() => { setRestoreFailed(false); setRestoring(true); setResumeRevision((revision) => revision + 1); }}>Повторить восстановление</button>}<button onClick={() => setError('')}>Закрыть</button></div>}

    {restoring && !job && <section className="panel import-panel"><p className="import-note">Восстанавливаем сохранённый импорт…</p></section>}

    {!job && !restoring && <section className="panel import-panel">
      <div className="section-top"><div><div className="eyebrow">ШАГ 1 · ФАЙЛ</div><h2>Выберите тип данных</h2></div><span className="import-step">До 5 МБ</span></div>
      <div className="import-form-grid">
        <label className="field"><span>Что загружаем</span><select value={target} onChange={(event) => chooseTarget(event.target.value as Target)}>{Object.entries(targetLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>Название внешнего источника</span><input value={source} maxLength={80} onChange={(event) => setSource(event.target.value)} /></label>
      </div>
      <label className="field import-file-field"><span>Файл {target === 'individual_applications' ? 'JSON или CSV' : 'XLS, XLSX или CSV'}</span><input type="file" accept={target === 'individual_applications' ? '.json,.csv,application/json,text/csv' : '.xls,.xlsx,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'} onChange={chooseFile} /><small>{file ? `${file.name} · ${(file.size / 1024).toFixed(0)} КБ` : target === 'individual_applications' ? 'JSON-массив заявок или CSV UTF-8 со стабильным внешним ключом заявки.' : 'Excel или CSV UTF-8; сначала сопоставьте поля и проверьте строки.'}</small></label>
      {target === 'individual_applications' && <p className="import-boundary">Это только запись входящей заявки. Состояние оплаты неизвестно, платежи не переносятся, зачисление или учебная запись автоматически не создаются.</p>}
      <div className="import-actions"><button className="primary" disabled={!file || loading || !source.trim()} onClick={() => void upload()}>{loading ? 'Проверяем файл…' : 'Загрузить для предпросмотра'}</button></div>
    </section>}

    {job && <>
      <section className="panel import-panel">
        <div className="section-top"><div><div className="eyebrow">{job.status === 'completed' ? 'ЗАВЕРШЕНО' : job.status === 'uploaded' ? 'ШАГ 2 · СОПОСТАВЛЕНИЕ' : 'ШАГ 3 · ПРЕДПРОСМОТР'}</div><h2>{targetLabels[job.target]}</h2></div><span className="import-step">{job.fileName} · ревизия {job.revision}</span></div>
        {job.status === 'uploaded' && <>
          <p className="import-note">Выберите лист и строку заголовков. Исходные названия колонок сохраняются; порядок колонок может быть любым.</p>
          <div className="import-form-grid">
            {job.fileFormat !== 'json' && <label className="field"><span>Лист книги</span><select value={selectedSheet} onChange={(event) => { const name = event.target.value; const nextSheetIndex = job.sheets.findIndex((item) => item.name === name); const nextSheet = job.sheets[nextSheetIndex]; const nextHeaderRow = nextSheet?.firstRow ?? 1; setSelectedSheet(name); setHeaderRow(nextHeaderRow); updateImportDraft(job.id, { selectedSheetIndex: Math.max(0, nextSheetIndex), headerRow: nextHeaderRow, mappingTouched: false }); }}>{job.sheets.map((item) => <option key={item.name} value={item.name}>{item.name} · строки до {item.rowCount}</option>)}</select></label>}
            {job.fileFormat !== 'json' && <label className="field"><span>Строка с заголовками</span><input type="number" min={sheet?.firstRow ?? 1} max={Math.min(sheet?.rowCount ?? 2002, 2002)} value={headerRow} onChange={(event) => { const nextHeaderRow = Math.max(sheet?.firstRow ?? 1, Number(event.target.value)); setHeaderRow(nextHeaderRow); updateImportDraft(job.id, { selectedSheetIndex: Math.max(0, job.sheets.findIndex((item) => item.name === selectedSheet)), headerRow: nextHeaderRow, mappingTouched: false }); }} /></label>}
          </div>
          {job.fileFormat === 'json' && <p className="import-note">Имена JSON-полей собраны автоматически; `null`-записи будут пропущены с предупреждением.</p>}
          {headerLoading && <p className="import-note">Читаем строку заголовков…</p>}
          <div className="import-mapping" role="group" aria-label="Сопоставить колонки">
            {headings.map((heading, index) => <label className="import-map-row" key={`${index}:${heading}`}><span><b>{heading || `Колонка ${index + 1} · без заголовка`}</b><small>Источник · {index + 1}</small></span><select value={mapping[String(index)] ?? ''} onChange={(event) => { const nextMapping = { ...mapping, [String(index)]: event.target.value || null }; setMapping(nextMapping); updateImportDraft(job.id, { mapping: nextMapping, mappingTouched: true }); }}><option value="">Не импортировать</option>{fields.map((field) => <option key={field} value={field}>{fieldLabels[field]}</option>)}</select></label>)}
          </div>
          <div className="import-actions"><button className="secondary" disabled={loading || headerLoading} onClick={() => void cancel()}>Отменить загрузку</button><button className="primary" disabled={loading || headerLoading || !headings.length} onClick={() => void makePreview()}>{loading ? 'Проверяем строки…' : 'Проверить и показать строки'}</button></div>
        </>}

        {job.status === 'preview_ready' && <>
          <p className="import-note">Проверено {job.preview.length} непустых строк. Возможные совпадения не объединяются: отметьте только те записи, которые действительно нужно сохранить. Обновление меняет сопоставленные поля; несопоставленные поля сохраняются, а пустая сопоставленная ячейка очищает поле.</p>
          {job.target === 'individual_applications' && <p className="import-boundary">Оплата в CRM остаётся неизвестной. Импорт создаёт индивидуальную активность на передаче в LMS, без зачисления и учебных фактов.</p>}
          <ImportRows rows={job.preview} headings={job.rawHeadings} selectedRows={selectedRows} reviewedRows={reviewedRows} onSelected={toggleRow} onReviewed={toggleReviewed} />
          <div className="import-actions"><button className="secondary" disabled={loading} onClick={() => void cancel()}>Отменить импорт</button><button className="primary" disabled={loading || !selectedRows.length} onClick={() => void confirmRows(job.preview.filter((row) => selectedRows.includes(row.rowNumber)).map((row) => row.rowNumber), reviewedRows)}>{loading ? 'Сохраняем…' : `Подтвердить ${formatRussianCount(selectedRows.length, 'строку', 'строки', 'строк')}`}</button></div>
        </>}

        {job.status === 'completed' && job.result && <>
          <div className="import-result-counts">{Object.entries(job.result.counts).map(([status,count]) => <div key={status}><strong>{count}</strong><span>{statusLabel(status)}</span></div>)}</div>
          <ImportRows rows={job.preview} headings={job.rawHeadings} selectedRows={[]} reviewedRows={[]} results={job.result.rowResults} />
          {job.result.rowResults.some((row) => row.status === 'failed') && <div className="import-actions"><button className="secondary" disabled={loading} onClick={() => void retryRows()}>{loading ? 'Повторяем…' : 'Повторить строки с ошибкой'}</button></div>}
          {job.result.rowResults.some((row) => row.status === 'conflict') && <p className="import-row-warning">Строки с конфликтом требуют нового файла и нового предпросмотра.</p>}
          <p className="import-note">Отмена не удаляет уже сохранённые записи. Для исправления данных загрузите файл заново и проверьте новую ревизию.</p>
        </>}
      </section>
    </>}
  </div>;
}

function ImportRows({ rows, headings, selectedRows, reviewedRows, results, onSelected, onReviewed }: {
  rows: PreviewRow[]; headings: string[]; selectedRows: number[]; reviewedRows: number[]; results?: ImportResultRow[];
  onSelected?: (rowNumber: number, checked: boolean) => void; onReviewed?: (rowNumber: number, checked: boolean) => void;
}) {
  const resultByRow = new Map(results?.map((result) => [result.rowNumber, result]) ?? []);
  return <div className="import-rows">
    {rows.map((row) => {
      const result = resultByRow.get(row.rowNumber);
      const problem = row.errors.join(' ') || row.matches.map((match) => `${match.reasons.join(', ')}: ${match.name}${match.email ? ` · ${match.email}` : ''}`).join('; ');
      const warning = row.warnings.join(' ');
      const checked = selectedRows.includes(row.rowNumber);
      return <article className={`import-row ${result?.status ?? row.status}`} key={row.rowNumber}>
        <div className="import-row-head"><strong>Строка {row.rowNumber}</strong><span className={`import-status ${result?.status ?? row.status}`}>{statusLabel(result?.status ?? row.status)}</span></div>
        <dl className="import-source-values">{headings.map((heading,index) => {
          const value = row.sourceValues[index];
          if (value === null || value === '') return null;
          return <div key={`${index}:${heading}`}><dt>{heading || `Колонка ${index + 1}`}</dt><dd>{value}</dd></div>;
        })}</dl>
      {(problem || warning || result?.reason) && <p className={problem || result?.status === 'conflict' || result?.status === 'failed' ? 'import-row-message' : 'import-row-warning'}>{result?.reason || problem || warning}</p>}
        {!result && <>
          {row.status === 'valid' && <label className="import-row-choice"><input type="checkbox" checked={checked} onChange={(event) => onSelected?.(row.rowNumber,event.target.checked)} />Загрузить эту строку</label>}
          {row.status === 'possible_duplicate' && <label className="import-row-choice"><input type="checkbox" checked={reviewedRows.includes(row.rowNumber)} onChange={(event) => onReviewed?.(row.rowNumber,event.target.checked)} />Импортировать как отдельную запись, не объединять</label>}
          {row.status === 'changed_requires_review' && <label className="import-row-choice"><input type="checkbox" checked={reviewedRows.includes(row.rowNumber)} onChange={(event) => onReviewed?.(row.rowNumber,event.target.checked)} />Сохранить это изменение после проверки</label>}
          {row.status === 'unchanged' && <p className="import-row-warning">Значения совпадают с последним импортом по внешнему ключу.</p>}
        </>}
      </article>;
    })}
  </div>;
}
