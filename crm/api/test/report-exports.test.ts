import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import { parseImportBuffer } from '../src/import-files.js';
import { pool } from '../src/db/connection.js';
import { renderReportFile, renderChartPng, renderChartSvg, spreadsheetCell } from '../src/report-exports.js';
import { renderReportFileInWorker } from '../src/report-renderer.js';
import { REPORT_EXPORT_COLUMNS } from '../src/report-columns.js';
import { dispatchPendingReportExports, mapReportRow, MAX_REPORT_EXPORT_LIST_LIMIT, MAX_REPORT_SOURCE_BYTES, XLS_MAX_DATA_ROWS, recoverPendingReportExportsOnStartup, runReportExportJob, validateReportExportColumns, validateReportExportListLimit, validateReportExportSize, validateReportExportSourceSize, type ReportSnapshot } from '../src/report-service.js';

const sample: ReportSnapshot = {
  snapshotId: '11111111-1111-4111-8111-111111111111', reportId: 'demand_learning', dataProfile: 'synthetic_demo', title: 'Спрос и факты обучения', asOf: '2026-09-27T10:30:00.000Z',
  filters: { from: '2026-09-01', to: '2026-09-30', includeClosed: true }, rowCount: 1, page: 1, pageSize: 25,
  rows: [{ activityId: '22222222-2222-4222-8222-222222222222', kind: 'corporate', kindLabel: 'Компания', title: 'Курс “Данные”', stageKey: 'qualification', stageLabel: 'Потребность компании', ownerSub: 'kam-1', ownerName: 'Ирина Климова', organizationName: 'ООО «Пример»', organizationId: '33333333-3333-4333-8333-333333333333', personName: null, origin: 'manual', originSource: null, originReference: null, originLabel: 'Активность CRM', createdAt: '2026-09-12T09:15:00.000Z', updatedAt: '2026-09-13T09:15:00.000Z', closed: false, awaitingReply: false, nextTaskDueAt: null, productNames: ['Аналитика'], productLinks: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Аналитика' }], programLinks: [{ id: '77777777-7777-4777-8777-777777777777', name: 'Программа анализа данных' }], programNames: ['Программа анализа данных'], programMode: 'adapted', documentRefs: [{ id: '55555555-5555-4555-8555-555555555555', name: 'Договор.pdf' }], contractLicenseRefs: [{ id: '66666666-6666-4666-8666-666666666666', title: 'Договор', documentId: '55555555-5555-4555-8555-555555555555' }], requestedPlaces: 24, requestedPlacesRecorded: true, enrollmentFactCount: 1, learningStartedFactCount: 1, learningCompletedFactCount: 0, learningFactsSource: 'LMS mock', lastLearningFactAt: '2026-09-14T09:15:00.000Z' }],
  metrics: [{ key: 'requestedPlaces', label: 'Заявленные места', value: 24, unit: 'мест', definition: 'План компании', source: 'CRM', completeness: 'Указано', timeScope: 'selected_activity_creation_period', grouping: 'activity', lastFactOccurredAt: null, sourceReceivedAt: null }],
  chart: { id: 'learning-events', title: 'Записанные факты обучения', unit: 'событий', series: [{ label: 'Зачисление', value: 1 }, { label: 'Начали', value: 1 }, { label: 'Завершили', value: 0 }] },
  charts: [{ id: 'learning-events', title: 'Записанные факты обучения', unit: 'событий', series: [{ label: 'Зачисление', value: 1 }, { label: 'Начали', value: 1 }, { label: 'Завершили', value: 0 }] }],
  sources: ['CRM', 'LMS mock'], notes: ['Заявленные места не равны людям.'],
};

test('report formats are binary/readable and preserve Cyrillic, dates, numbers and empty cells', async () => {
  const xlsx = await renderReportFile(sample, 'xlsx');
  assert.deepEqual(xlsx.bytes.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const workbook = XLSX.read(xlsx.bytes, { type: 'buffer', cellDates: true });
  const data = XLSX.utils.sheet_to_json<(string | number | Date)[]>(workbook.Sheets['Данные']!, { header: 1, defval: null });
  assert.equal(workbook.Sheets['Данные']!['A1']!.v, 'Отчёт: Спрос и факты обучения');
  assert.equal(data.length, 3);
  assert.equal(data[2][2], 'Курс “Данные”');
  assert.equal(data[2][12], 'Программа анализа данных');
  assert.equal(data[2][13], 24);
  assert.ok(data[2][8] instanceof Date);
  assert.equal(data[2][6], '');

  const xls = await renderReportFile(sample, 'xls');
  assert.deepEqual(xls.bytes.subarray(0, 8), Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  const legacyBook = XLSX.read(xls.bytes, { type: 'buffer' });
  assert.equal(legacyBook.SheetNames[0], 'Данные');
  assert.equal(legacyBook.Sheets['Данные']!['A1']!.v, 'Отчёт: Спрос и факты обучения');

  const json = await renderReportFile(sample, 'json');
  assert.equal(JSON.parse(json.bytes.toString('utf8')).rows[0].title, 'Курс “Данные”');
  assert.equal(JSON.parse(json.bytes.toString('utf8')).rows[0].requestedPlaces, 24);
  assert.equal(JSON.parse(json.bytes.toString('utf8')).rows[0].ownerSub, 'kam-1', 'The default JSON retains its original complete snapshot row.');
  assert.equal(JSON.parse(json.bytes.toString('utf8')).rows[0].organizationId, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(JSON.parse(json.bytes.toString('utf8')).rows[0].documentRefs, [{ id: '55555555-5555-4555-8555-555555555555', name: 'Договор.pdf' }]);
  assert.deepEqual(JSON.parse(json.bytes.toString('utf8')).rows[0].productLinks, [{ id: '44444444-4444-4444-8444-444444444444', name: 'Аналитика' }]);
  assert.deepEqual(JSON.parse(json.bytes.toString('utf8')).rows[0].programLinks, [{ id: '77777777-7777-4777-8777-777777777777', name: 'Программа анализа данных' }]);
  assert.equal(JSON.parse(json.bytes.toString('utf8')).rows[0].contractLicenseRefs[0].documentId, '55555555-5555-4555-8555-555555555555');
  assert.equal(JSON.parse(json.bytes.toString('utf8')).rows[0].programMode, 'adapted');
  assert.equal(JSON.parse(json.bytes.toString('utf8')).dataProfile, 'synthetic_demo');

  const csv = await renderReportFile(sample, 'csv');
  assert.equal(csv.mediaType, 'text/csv; charset=utf-8');
  assert.equal(csv.extension, 'csv');
  assert.ok(csv.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'CSV is UTF-8 with a BOM for spreadsheet applications.');
  const csvRows = parseImportBuffer(csv.bytes, 'csv', 'contacts').sheets[0].rows.map((row) => row.map((cell) => cell.value));
  assert.equal(csvRows.length, 2, 'CSV contains the header and every row in the snapshot.');
  assert.deepEqual(csvRows[0].slice(0, 3), ['ID активности', 'Тип', 'Активность']);
  assert.deepEqual(csvRows[1].slice(0, 3), [sample.rows[0].activityId, 'Компания', 'Курс “Данные”']);
  assert.equal(csvRows[0][12], 'Учебные программы');
  assert.equal(csvRows[1][12], 'Программа анализа данных');

  const pdf = await renderReportFile(sample, 'pdf');
  assert.equal(pdf.bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.bytes.includes(Buffer.from('%%EOF')));
  assert.equal(pdf.bytes.includes(Buffer.from('synthetic_demo')), false);
  const chartPdf = await renderReportFile(sample, 'chart-pdf');
  assert.equal(chartPdf.bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(chartPdf.bytes.includes(Buffer.from('synthetic_demo')), false);
  const png = await renderReportFile(sample, 'png');
  assert.deepEqual(png.bytes.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  assert.equal((await sharp(png.bytes).metadata()).format, 'png');
  assert.match(renderChartSvg(sample), /срез на 27\.09\.2026/);
});

test('legacy report rows without program associations normalize to an empty stable link list', () => {
  const oldRow = structuredClone(sample.rows[0]);
  delete (oldRow as Partial<typeof oldRow>).programLinks;
  assert.deepEqual(mapReportRow(oldRow).programLinks, []);
  assert.deepEqual(mapReportRow(oldRow).programNames, []);
  assert.deepEqual(mapReportRow(sample.rows[0]).programNames, ['Программа анализа данных']);
});

test('a program-filtered workbook names the filter and explains activity-level learning facts', async () => {
  const filtered: ReportSnapshot = {
    ...sample,
    filters: { ...sample.filters, programId: sample.rows[0].programLinks[0].id },
    notes: [...sample.notes, 'Фильтр по программе выбирает связанные активности CRM. Заявленные места и факты LMS относятся к активности целиком; при нескольких программах они не распределяются между ними.'],
  };
  const workbook = XLSX.read((await renderReportFile(filtered, 'xlsx')).bytes, { type: 'buffer' });
  assert.match(String(workbook.Sheets['Данные']!['A1']!.v), /Учебная программа: Программа анализа данных/);
  const metricRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets['Показатели']!, { header: 1 });
  const note = metricRows.find((row) => row[0] === 'Примечание к фильтру');
  assert.match(note?.[1] ?? '', /не распределяются между ними/);
});

test('selected organization is retained in snapshot JSON and visible export labels', async () => {
  const organizationId = '550e8400-e29b-41d4-a716-446655440000';
  const filtered: ReportSnapshot = {
    ...sample,
    filters: { ...sample.filters, organizationId, organizationName: 'ООО «Пример»' },
  };

  const json = JSON.parse((await renderReportFile(filtered, 'json')).bytes.toString('utf8'));
  assert.equal(json.filters.organizationId, organizationId);
  assert.equal(json.filters.organizationName, 'ООО «Пример»');

  for (const format of ['xls', 'xlsx'] as const) {
    const workbook = XLSX.read((await renderReportFile(filtered, format)).bytes, { type: 'buffer' });
    assert.equal(workbook.Sheets['Данные']!['A1']!.v, 'Отчёт: Спрос и факты обучения · Организация: ООО «Пример»');
    assert.equal(workbook.Sheets['Показатели']!['A1']!.v, 'Отчёт: Спрос и факты обучения · Организация: ООО «Пример»');
  }
  assert.match(renderChartSvg(filtered), /Организация: ООО «Пример»/);
});

test('selected columns shape real XLS/XLSX and JSON rows while report metrics and source snapshot stay complete', async () => {
  const selected = ['title', 'ownerName'] as const;
  const originalRows = structuredClone(sample.rows);
  for (const format of ['xls', 'xlsx'] as const) {
    const file = await renderReportFile(sample, format, selected);
    const expectedMagic = format === 'xls'
      ? Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])
      : Buffer.from([0x50,0x4b,0x03,0x04]);
    assert.deepEqual(file.bytes.subarray(0, expectedMagic.length), expectedMagic, `${format} is a real binary workbook`);
    const workbook = XLSX.read(file.bytes, { type: 'buffer' });
    const exportedRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets['Данные']!, { header: 1, defval: null });
    assert.deepEqual(exportedRows[1], ['Активность', 'Ответственный']);
    assert.deepEqual(exportedRows[2], ['Курс “Данные”', 'Ирина Климова']);
    const metrics = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets['Показатели']!, { header: 1 });
    assert.equal(metrics.length, 3, 'The complete metrics worksheet is independent of source-column selection.');
  }
  const json = JSON.parse((await renderReportFile(sample, 'json', selected)).bytes.toString('utf8'));
  assert.deepEqual(json.rows[0], { title: 'Курс “Данные”', ownerName: 'Ирина Климова' });
  assert.equal(Object.hasOwn(json.rows[0], 'programLinks'), false, 'Selected-column JSON omits relationship metadata outside the selection.');
  assert.equal(json.metrics[0].value, 24);
  const csvRows = parseImportBuffer((await renderReportFile(sample, 'csv', selected)).bytes, 'csv', 'contacts').sheets[0].rows;
  assert.deepEqual(csvRows[0].map((cell) => cell.value), ['Активность', 'Ответственный']);
  assert.deepEqual(csvRows[1].map((cell) => cell.value), ['Курс “Данные”', 'Ирина Климова']);
  assert.deepEqual(sample.rows, originalRows, 'Formatting never narrows or mutates the saved source snapshot.');
  assert.equal(validateReportExportColumns(undefined).length, REPORT_EXPORT_COLUMNS.length, 'Omitted selections preserve the complete default.');
});

test('JSON and XLSX expose metric period, counted entity, and fact occurrence without implying receipt time', async () => {
  const occurredAt = '2026-09-14T09:15:00.000Z';
  const snapshot: ReportSnapshot = {
    ...sample,
    metrics: [...sample.metrics, {
      key: 'enrollmentFacts', label: 'Факты зачисления', value: 1, unit: 'событий', definition: 'Число учебных событий.', source: 'Проекция LMS', completeness: 'Полнота синхронизации неизвестна.',
      timeScope: 'selected_activities_all_available_fact_times', grouping: 'learning_fact_event', lastFactOccurredAt: occurredAt, sourceReceivedAt: null,
    }],
  };

  const json = JSON.parse((await renderReportFile(snapshot, 'json')).bytes.toString('utf8'));
  const exportedFact = json.metrics.find((metric: { key: string }) => metric.key === 'enrollmentFacts');
  assert.equal(exportedFact.timeScope, 'selected_activities_all_available_fact_times');
  assert.equal(exportedFact.grouping, 'learning_fact_event');
  assert.equal(exportedFact.lastFactOccurredAt, occurredAt);
  assert.equal(exportedFact.sourceReceivedAt, null, 'Source receipt time is explicitly unknown.');
  assert.equal('freshAt' in exportedFact, false);

  const workbook = XLSX.read((await renderReportFile(snapshot, 'xlsx')).bytes, { type: 'buffer', cellDates: true });
  const rows = XLSX.utils.sheet_to_json<(string | number | Date)[]>(workbook.Sheets['Показатели']!, { header: 1 });
  const fact = rows.find((row) => row[0] === 'Факты зачисления')!;
  assert.equal(fact[6], 'Все доступные времена фактов по активностям среза');
  assert.equal(fact[7], 'Событие учебного факта');
  assert.equal((fact[8] as Date).toISOString(), occurredAt);
  assert.equal(fact[9], 'Не подтверждено для всех событий');
});

test('exports preserve null source-unit metrics and their completeness reasons', async () => {
  const inquiryReason = 'Недостаточно данных: срез содержит CRM-активности, а не полный перечень входящих обращений из источников в пределах доступа пользователя.';
  const applicationReason = 'Недостаточно данных: срез содержит CRM-активности и факты обучения, а не полный перечень заявок на обучение из источников в пределах доступа пользователя.';
  const snapshot: ReportSnapshot = {
    ...sample,
    metrics: [
      ...sample.metrics,
      { key: 'incomingInquiries', label: 'Входящие обращения из источников', value: null, unit: 'обращений из источников', definition: 'Число обращений, зарегистрированных в исходных системах.', source: 'Исходные системы обращений', completeness: inquiryReason, timeScope: 'not_calculated', grouping: 'not_calculated', lastFactOccurredAt: null, sourceReceivedAt: null },
      { key: 'learningApplications', label: 'Заявки на обучение', value: null, unit: 'заявок на обучение', definition: 'Число заявок, зарегистрированных в исходных системах.', source: 'Исходные системы заявок на обучение', completeness: applicationReason, timeScope: 'not_calculated', grouping: 'not_calculated', lastFactOccurredAt: null, sourceReceivedAt: null },
    ],
  };

  const json = JSON.parse((await renderReportFile(snapshot, 'json')).bytes.toString('utf8'));
  for (const [index, reason] of [[1, inquiryReason], [2, applicationReason]] as const) {
    assert.equal(json.metrics[index].value, null);
    assert.equal(json.metrics[index].completeness, reason);
  }

  const workbook = XLSX.read((await renderReportFile(snapshot, 'xlsx')).bytes, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['Показатели']!, { header: 1 });
  const inquiry = rows.find((row) => row[0] === 'Входящие обращения из источников')!;
  const application = rows.find((row) => row[0] === 'Заявки на обучение')!;
  assert.equal(inquiry[1], 'Недостаточно данных');
  assert.equal(inquiry[2], 'обращений из источников');
  assert.equal(inquiry[5], inquiryReason);
  assert.equal(inquiry[6], 'Не рассчитывается');
  assert.equal(application[1], 'Недостаточно данных');
  assert.equal(application[2], 'заявок на обучение');
  assert.equal(application[5], applicationReason);
});

test('legacy XLS row ceiling fails explicitly before a partial workbook can be created', () => {
  assert.doesNotThrow(() => validateReportExportSize('xls', XLS_MAX_DATA_ROWS));
  assert.throws(() => validateReportExportSize('xls', XLS_MAX_DATA_ROWS + 1), /Формат XLS поддерживает не более/);
  assert.doesNotThrow(() => validateReportExportSize('xlsx', XLS_MAX_DATA_ROWS + 1));
});

test('durable export history defaults to a bounded list and rejects invalid limits', () => {
  assert.equal(validateReportExportListLimit(undefined), MAX_REPORT_EXPORT_LIST_LIMIT);
  assert.equal(validateReportExportListLimit('8'), 8);
  assert.equal(validateReportExportListLimit(MAX_REPORT_EXPORT_LIST_LIMIT), MAX_REPORT_EXPORT_LIST_LIMIT);
  for (const invalid of [0, 21, '1.5', '-1', 'nope']) {
    assert.throws(() => validateReportExportListLimit(invalid), /Число выгрузок должно быть от 1 до 20/);
  }
});

test('row-based exports reject excessive stored source bytes explicitly while chart exports stay small', () => {
  assert.doesNotThrow(() => validateReportExportSourceSize('xlsx', MAX_REPORT_SOURCE_BYTES));
  assert.throws(() => validateReportExportSourceSize('json', MAX_REPORT_SOURCE_BYTES + 1), /ограничение составляет/);
  assert.throws(() => validateReportExportSourceSize('csv', MAX_REPORT_SOURCE_BYTES + 1), /ограничение составляет/);
  assert.doesNotThrow(() => validateReportExportSourceSize('png', MAX_REPORT_SOURCE_BYTES * 2));
});

test('formula-like text is escaped while normal labels, negative numbers and empty values remain usable', () => {
  assert.equal(spreadsheetCell('=HYPERLINK("https://bad")'), '\'=HYPERLINK("https://bad")');
  assert.equal(spreadsheetCell('  +cmd'), "'  +cmd");
  assert.equal(spreadsheetCell('ООО «Плюс»'), 'ООО «Плюс»');
  assert.equal(spreadsheetCell(-12), -12);
  assert.equal(spreadsheetCell(null), '');
});

test('spreadsheet writers persist user formula-like values as text', async () => {
  const injectionSnapshot: ReportSnapshot = { ...sample, rows: sample.rows.map((row) => ({ ...row, title: ' =HYPERLINK("https://bad")' })) };
  for (const format of ['xls', 'xlsx'] as const) {
    const file = await renderReportFile(injectionSnapshot, format);
    const book = XLSX.read(file.bytes, { type: 'buffer' });
    const parsed = XLSX.utils.sheet_to_json<(string | number | null)[]>(book.Sheets['Данные']!, { header: 1, defval: null });
    assert.equal(parsed[2][2], "' =HYPERLINK(\"https://bad\")");
  }
  const csv = await renderReportFile(injectionSnapshot, 'csv');
  const csvRows = parseImportBuffer(csv.bytes, 'csv', 'contacts').sheets[0].rows;
  assert.equal(csvRows[1][2].value, "' =HYPERLINK(\"https://bad\")");

  const hostileTextSnapshot: ReportSnapshot = { ...sample, rows: sample.rows.map((row) => ({ ...row, title: '=HYPERLINK("https://bad", "x"),\r\nследующая строка' })) };
  const escapedCsv = await renderReportFile(hostileTextSnapshot, 'csv');
  const escapedRows = parseImportBuffer(escapedCsv.bytes, 'csv', 'contacts').sheets[0].rows;
  assert.equal(escapedRows[1][2].value, "'=HYPERLINK(\"https://bad\", \"x\"),\r\nследующая строка", 'Formula text is neutralized and RFC quotes preserve commas and embedded newlines.');
});

test('empty report still produces valid JSON, XLSX, PDF, PNG and chart PDF', async () => {
  const empty: ReportSnapshot = { ...sample, rows: [], chart: { ...sample.chart, series: [] }, charts: sample.charts.map((chart) => ({ ...chart, series: [] })), metrics: [{ ...sample.metrics[0], value: null, completeness: 'Недостаточно данных' }] };
  assert.equal(JSON.parse((await renderReportFile(empty, 'json')).bytes.toString('utf8')).rows.length, 0);
  for (const format of ['xls', 'xlsx'] as const) {
    const book = await renderReportFile(empty, format);
    const workbook = XLSX.read(book.bytes, { type: 'buffer' });
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['Данные']!, { header: 1 }).length, 2);
    const metricRows = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['Показатели']!, { header: 1 });
    assert.equal(metricRows[2][1], 'Недостаточно данных', `${format} displays an explicit value for an unknown metric.`);
  }
  const emptyJson = JSON.parse((await renderReportFile(empty, 'json')).bytes.toString('utf8'));
  assert.equal(emptyJson.metrics[0].value, null, 'JSON preserves the machine-readable null value.');
  assert.equal(emptyJson.metrics[0].completeness, 'Недостаточно данных');
  const emptyCsvRows = parseImportBuffer((await renderReportFile(empty, 'csv')).bytes, 'csv', 'contacts').sheets[0].rows;
  assert.equal(emptyCsvRows.length, 1, 'An empty CSV snapshot retains its column header.');
  assert.equal((await renderReportFile(empty, 'pdf')).bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await renderReportFile(empty, 'chart-pdf')).bytes.subarray(0, 5).toString(), '%PDF-');
  const png = await renderChartPng(empty);
  assert.equal((await sharp(png).metadata()).width, 1000);
});

test('large XLSX export runs off the API event loop', async () => {
  const sourceRow = sample.rows[0];
  const largeSnapshot: ReportSnapshot = {
    ...sample,
    rowCount: 6_000,
    rows: Array.from({ length: 6_000 }, (_, index) => ({
      ...sourceRow,
      activityId: `activity-${index}`,
      title: `Синтетическая активность ${index} · проверка длительного рендера отчёта`,
      organizationName: `Организация ${index} · пример для выгрузки`,
    })),
  };
  let eventLoopTurns = 0;
  const heartbeat = setInterval(() => { eventLoopTurns += 1; }, 0);
  try {
    const file = await renderReportFileInWorker(largeSnapshot, 'xlsx');
    assert.deepEqual(file.bytes.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // Count actual event-loop opportunities instead of relying on a timing threshold.
    assert.ok(eventLoopTurns > 1, `expected API event loop turns during render, got ${eventLoopTurns}`);
  } finally {
    clearInterval(heartbeat);
  }
});

test('export worker retries a failed status update only for its stopped job', async () => {
  const mutablePool = pool as unknown as { query: (...args: any[]) => Promise<any> };
  const originalQuery = mutablePool.query;
  const errors: { phase: string; error: unknown }[] = [];
  const onError = (phase: string, error: unknown) => errors.push({ phase, error });
  const noRecoveryTimer = () => {};

  try {
    mutablePool.query = async () => { throw new Error('injected claim database failure'); };
    await assert.doesNotReject(runReportExportJob('11111111-1111-4111-8111-111111111111', { onError, scheduleRecovery: noRecoveryTimer }));
    assert.equal(errors.at(-1)?.phase, 'claim');
    assert.match(String(errors.at(-1)?.error), /injected claim database failure/);

    const stoppedId = '22222222-2222-4222-8222-222222222222';
    let jobStatus = 'queued';
    let failedUpdateAttempts = 0;
    const repairIds: string[] = [];
    mutablePool.query = async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes("SET status='running'")) {
        jobStatus = 'running';
        return { rowCount: 1, rows: [{ payload: sample, format: 'pdf', fileKey: '33333333-3333-4333-8333-333333333333', reportId: sample.reportId }] };
      }
      if (sql.includes("SET status='failed'") && sql.includes('WHERE id=$1') && sql.includes("status='running'")) {
        repairIds.push(String(parameters[0]));
        failedUpdateAttempts += 1;
        if (failedUpdateAttempts === 1) throw new Error('injected failure-status database failure');
        jobStatus = 'failed';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("status='queued' AND expires_at<=now()")) return { rowCount: 0, rows: [] };
      if (sql.startsWith('SELECT id FROM report_jobs')) return { rowCount: 0, rows: [] };
      throw new Error(`unexpected query in fault injection: ${sql}`);
    };
    await assert.doesNotReject(runReportExportJob(stoppedId, {
      render: async () => { throw new Error('injected renderer failure'); },
      remove: async () => {},
      onError,
      scheduleRecovery: noRecoveryTimer,
    }));
    assert.equal(jobStatus, 'running', 'The worker has stopped, but the transient failed-status update left the row running.');
    assert.ok(errors.some(({ phase, error }) => phase === 'process' && String(error).includes('injected renderer failure')));
    assert.ok(errors.some(({ phase, error }) => phase === 'fail_update' && String(error).includes('injected failure-status database failure')));
    const statements: string[] = [];
    const recoveryQuery = mutablePool.query;
    mutablePool.query = async (sql: string, parameters: unknown[] = []) => {
      statements.push(sql);
      return recoveryQuery(sql, parameters);
    };
    await dispatchPendingReportExports({ onError, scheduleRecovery: noRecoveryTimer });
    assert.equal(jobStatus, 'failed', 'The address-specific retry repairs the stopped export.');
    assert.deepEqual(repairIds, [stoppedId, stoppedId], 'Only this known stopped job is retried by ID.');
    assert.ok(statements.every((sql) => !sql.includes("SET status='queued'") && !sql.includes("status='running' AND expires_at>now()")), 'Runtime recovery does not requeue other running jobs.');
  } finally { mutablePool.query = originalQuery; }
});

test('startup report recovery retries its reset before dispatching jobs', async () => {
  const mutablePool = pool as unknown as { query: (...args: any[]) => Promise<any> };
  const originalQuery = mutablePool.query;
  const statements: string[] = [];
  const errors: { phase: string; error: unknown }[] = [];
  let initialRecoveryFailures = 1;
  try {
    mutablePool.query = async (sql: string) => {
      statements.push(sql);
      if (sql.includes("status='running' AND expires_at<=now()") && initialRecoveryFailures > 0) {
        initialRecoveryFailures -= 1;
        throw new Error('injected startup recovery database failure');
      }
      return { rowCount: 0, rows: [] };
    };
    await recoverPendingReportExportsOnStartup({
      onError: (phase, error) => errors.push({ phase, error }),
      wait: async () => {},
    });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].phase, 'recovery');
    assert.match(String(errors[0].error), /injected startup recovery database failure/);
    assert.equal(statements.filter((sql) => sql.includes("status='running' AND expires_at<=now()")).length, 2, 'Startup repeats the failed recovery operation.');
    const runningReset = statements.findIndex((sql) => sql.includes("SET status='queued'") && sql.includes("status='running' AND expires_at>now()"));
    const pendingDispatch = statements.findIndex((sql) => sql.startsWith('SELECT id FROM report_jobs'));
    assert.ok(runningReset > 0 && pendingDispatch > runningReset, 'Queued work is dispatched only after startup recovery succeeds.');
  } finally { mutablePool.query = originalQuery; }
});

test('runtime export recovery dispatches queued jobs without requeueing a live render', async () => {
  const mutablePool = pool as unknown as { query: (...args: any[]) => Promise<any> };
  const originalQuery = mutablePool.query;
  const statements: string[] = [];
  try {
    mutablePool.query = async (sql: string) => {
      statements.push(sql);
      return { rowCount: 0, rows: [] };
    };
    await dispatchPendingReportExports({ scheduleRecovery: () => {} });
    assert.ok(statements.some((sql) => sql.includes("status='queued'")), 'Runtime retry discovers queued work.');
    assert.ok(statements.every((sql) => !sql.includes("SET status='queued'") && !sql.includes("status='running'")), 'Runtime retry never resets a running job that may still own its file key.');
  } finally { mutablePool.query = originalQuery; }
});

test('export render failure removes a partial file and persists failed status', async () => {
  const mutablePool = pool as unknown as { query: (...args: any[]) => Promise<any> };
  const originalQuery = mutablePool.query;
  const errors: { phase: string; error: unknown }[] = [];
  const removed: string[] = [];
  const sqlCalls: string[] = [];
  const fileKey = '33333333-3333-4333-8333-333333333333';
  try {
    mutablePool.query = async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("SET status='running'")) {
        return { rowCount: 1, rows: [{ payload: sample, format: 'xlsx', fileKey, reportId: sample.reportId }] };
      }
      if (sql.includes("SET status='failed'")) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected query in fault injection: ${sql}`);
    };
    await runReportExportJob('22222222-2222-4222-8222-222222222222', {
      render: async () => { throw new Error('synthetic worker render failure'); },
      remove: async (key) => { removed.push(key); },
      onError: (phase, error) => errors.push({ phase, error }),
      scheduleRecovery: () => {},
    });

    assert.deepEqual(removed, [fileKey]);
    assert.ok(sqlCalls.some((sql) => sql.includes("SET status='failed'")));
    assert.ok(errors.some(({ phase, error }) => phase === 'process' && String(error).includes('synthetic worker render failure')));
  } finally {
    mutablePool.query = originalQuery;
  }
});
