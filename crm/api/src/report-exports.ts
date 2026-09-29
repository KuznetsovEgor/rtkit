import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import type { ExportFormat, ReportSnapshot } from './report-service.js';
import { REPORT_EXPORT_COLUMNS, type ReportExportColumnKey } from './report-columns.js';

// PDFKit uses one embedded font for the whole line: the Cyrillic-only web
// subset drops Latin IDs, digits and punctuation from exported reports.
const fontPath = fileURLToPath(new URL('../assets/manrope-pdf.ttf', import.meta.url));
const defaultColumnKeys = REPORT_EXPORT_COLUMNS.map((column) => column.key);
const metricTimeScopeLabels = {
  selected_activity_creation_period: 'Даты создания активностей среза',
  selected_activities_all_available_fact_times: 'Все доступные времена фактов по активностям среза',
  not_calculated: 'Не рассчитывается',
} as const;
const metricGroupingLabels = {
  activity: 'Активность CRM',
  learning_fact_event: 'Событие учебного факта',
  not_calculated: 'Не рассчитывается',
} as const;
const unknownReceiptLabel = (grouping: ReportSnapshot['metrics'][number]['grouping']) =>
  grouping === 'learning_fact_event' ? 'Не подтверждено для всех событий' : 'Не фиксируется';

function metricUnit(value: number | null, unit: string) {
  if (value === null) return unit;
  const lastTwo = Math.abs(Math.trunc(value)) % 100;
  const last = Math.abs(Math.trunc(value)) % 10;
  const form = lastTwo >= 11 && lastTwo <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2;
  const forms: Record<string, [string, string, string]> = {
    'активностей': ['активность', 'активности', 'активностей'],
    'активностей CRM': ['активность CRM', 'активности CRM', 'активностей CRM'],
    'мест': ['место', 'места', 'мест'],
    'событий': ['событие', 'события', 'событий'],
  };
  return forms[unit]?.[form] ?? unit;
}

function resolveColumns(selected?: readonly ReportExportColumnKey[]) {
  if (selected === undefined) return REPORT_EXPORT_COLUMNS;
  const byKey = new Map(REPORT_EXPORT_COLUMNS.map((column) => [column.key, column]));
  const resolved = selected.map((key) => byKey.get(key));
  if (!selected.length || resolved.some((column) => !column)) throw new Error('Invalid report export columns.');
  return resolved as typeof REPORT_EXPORT_COLUMNS[number][];
}

function isDefaultColumnSet(selected: readonly ReportExportColumnKey[]) {
  return selected.length === defaultColumnKeys.length && selected.every((key, index) => key === defaultColumnKeys[index]);
}

function organizationFilterLabel(snapshot: ReportSnapshot): string {
  return snapshot.filters.organizationId
    ? `Организация: ${snapshot.filters.organizationName ?? snapshot.filters.organizationId}`
    : '';
}

function programFilterLabel(snapshot: ReportSnapshot): string {
  const id = snapshot.filters.programId;
  if (!id) return '';
  const name = snapshot.rows.flatMap((row) => row.programLinks).find((program) => program.id === id)?.name;
  return `Учебная программа: ${name ?? id}`;
}

function programFilterNote(snapshot: ReportSnapshot): string {
  return snapshot.filters.programId
    ? snapshot.notes.find((note) => note.startsWith('Фильтр по программе')) ?? ''
    : '';
}

function safeSpreadsheetText(value: string): string {
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else if (typeof value === 'string') text = safeSpreadsheetText(value);
  else text = safeSpreadsheetText(Array.isArray(value) ? value.join(', ') : JSON.stringify(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvReport(snapshot: ReportSnapshot, columns: readonly typeof REPORT_EXPORT_COLUMNS[number][]): Buffer {
  const records = [
    columns.map((column) => column.label),
    ...snapshot.rows.map((row) => columns.map((column) => csvCell(row[column.key]))),
  ];
  const body = records.map((record) => record.join(',')).join('\r\n');
  // The UTF-8 BOM lets spreadsheet applications detect Cyrillic reliably.
  return Buffer.from(`\uFEFF${body}\r\n`, 'utf8');
}

export function spreadsheetCell(value: unknown, date = false): unknown {
  if (value === null || value === undefined) return '';
  if (date && typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value);
  if (typeof value === 'string') return safeSpreadsheetText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return value;
  return safeSpreadsheetText(Array.isArray(value) ? value.join(', ') : JSON.stringify(value));
}

function worksheet(snapshot: ReportSnapshot, columns: readonly typeof REPORT_EXPORT_COLUMNS[number][]) {
  const organizationLabel = organizationFilterLabel(snapshot);
  const programLabel = programFilterLabel(snapshot);
  const rows: unknown[][] = [[`Отчёт: ${snapshot.title}${organizationLabel ? ` · ${organizationLabel}` : ''}${programLabel ? ` · ${programLabel}` : ''}`], columns.map((column) => column.label)];
  for (const row of snapshot.rows) rows.push(columns.map((column) => spreadsheetCell(row[column.key as keyof typeof row], 'date' in column && column.date)));
  const data = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  data['!cols'] = columns.map((column) => ({ wch: Math.min(48, Math.max(column.label.length + 2, column.key === 'activityId' ? 38 : 14)) }));
  for (const address of Object.keys(data)) {
    if (address.startsWith('!')) continue;
    const cell = data[address] as XLSX.CellObject;
    if (cell.t === 'd') cell.z = 'yyyy-mm-dd hh:mm';
  }
  return data;
}

function metricsWorksheet(snapshot: ReportSnapshot) {
  const organizationLabel = organizationFilterLabel(snapshot);
  const programLabel = programFilterLabel(snapshot);
  const rows: unknown[][] = [[`Отчёт: ${snapshot.title}${organizationLabel ? ` · ${organizationLabel}` : ''}${programLabel ? ` · ${programLabel}` : ''}`], ['Показатель', 'Значение', 'Единица', 'Определение', 'Источник', 'Полнота', 'Период показателя', 'Группировка', 'Последний факт произошёл', 'Получено из источника']];
  for (const metric of snapshot.metrics) {
    rows.push([metric.label, metric.value === null ? 'Недостаточно данных' : metric.value, metricUnit(metric.value, metric.unit), metric.definition, metric.source, metric.completeness, metricTimeScopeLabels[metric.timeScope], metricGroupingLabels[metric.grouping], spreadsheetCell(metric.lastFactOccurredAt, true), metric.sourceReceivedAt ? spreadsheetCell(metric.sourceReceivedAt, true) : unknownReceiptLabel(metric.grouping)]);
  }
  if (programFilterNote(snapshot)) rows.push(['Примечание к фильтру', programFilterNote(snapshot)]);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 34 }, { wch: 18 }, { wch: 24 }, { wch: 60 }, { wch: 36 }, { wch: 64 }, { wch: 48 }, { wch: 28 }, { wch: 28 }, { wch: 28 }];
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue;
    const cell = sheet[address] as XLSX.CellObject;
    if (typeof cell.v === 'string') cell.v = safeSpreadsheetText(cell.v);
    if (cell.t === 'd') cell.z = 'yyyy-mm-dd hh:mm';
  }
  return sheet;
}

function escapeXml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

export function renderChartSvg(snapshot: ReportSnapshot): string {
  const items = snapshot.chart.series;
  const width = 1000;
  const height = Math.max(300, 142 + items.length * 64);
  const max = Math.max(1, ...items.map((item) => item.value));
  const rowMarkup = items.map((item, index) => {
    const y = 116 + index * 64;
    const length = Math.max(item.value > 0 ? 3 : 0, 630 * item.value / max);
    return `<text x="38" y="${y + 20}" class="label">${escapeXml(item.label)}</text><rect x="300" y="${y}" width="630" height="30" rx="7" fill="#edf1f8"/><rect x="300" y="${y}" width="${length}" height="30" rx="7" fill="#455fc7"/><text x="${Math.min(948, 310 + length)}" y="${y + 21}" class="value">${escapeXml(item.value.toLocaleString('ru-RU'))}</text>`;
  }).join('');
  const empty = items.length ? '' : '<text x="38" y="140" class="empty">Нет записей по выбранным фильтрам</text>';
  const organizationLabel = organizationFilterLabel(snapshot);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><style>text{font-family:Manrope,Arial,sans-serif}.title{font-size:26px;font-weight:700;fill:#222634}.unit{font-size:14px;fill:#637087}.label{font-size:16px;fill:#30394b}.value{font-size:15px;font-weight:700;fill:#30394b}.empty{font-size:18px;fill:#637087}</style><text x="38" y="48" class="title">${escapeXml(snapshot.chart.title)}</text><text x="38" y="76" class="unit">${escapeXml(snapshot.chart.unit)} · срез на ${escapeXml(new Date(snapshot.asOf).toLocaleString('ru-RU'))}${organizationLabel ? ` · ${escapeXml(organizationLabel)}` : ''}</text>${rowMarkup}${empty}</svg>`;
}

export async function renderChartPng(snapshot: ReportSnapshot): Promise<Buffer> {
  return sharp(Buffer.from(renderChartSvg(snapshot), 'utf8')).png().toBuffer();
}

function pdfBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Producer: 'LCT CRM reports', Subject: 'Отчёт CRM' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { doc.font(fontPath); draw(doc); doc.end(); } catch (error) { reject(error); }
  });
}

function labelForKind(kind: string): string {
  return kind === 'university' ? 'Вуз' : kind === 'corporate' ? 'Компания' : 'Физлицо';
}

function addPageTitle(doc: PDFKit.PDFDocument, title: string, subtitle: string) {
  doc.fontSize(17).fillColor('#222634').text(title, { continued: false });
  doc.moveDown(0.3).fontSize(8).fillColor('#637087').text(subtitle, { lineGap: 2 });
  doc.moveDown(0.5);
}

function pdfColumnValue(value: unknown, date: boolean): string {
  if (value === null || value === undefined) return 'Не указано';
  if (date && typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Нет';
  return String(value);
}

async function reportPdf(snapshot: ReportSnapshot, columns: readonly typeof REPORT_EXPORT_COLUMNS[number][]): Promise<Buffer> {
  return pdfBuffer((doc) => {
    const organizationLabel = organizationFilterLabel(snapshot);
    const programLabel = programFilterLabel(snapshot);
    const filterText = `Период по дате создания активности: ${snapshot.filters.from ?? 'без начала'} — ${snapshot.filters.to ?? 'по текущую дату'}; тип: ${snapshot.filters.kind ? labelForKind(snapshot.filters.kind) : 'все'}${organizationLabel ? `; ${organizationLabel.toLocaleLowerCase('ru-RU')}` : ''}${programLabel ? `; ${programLabel}` : ''}; срез: ${new Date(snapshot.asOf).toLocaleString('ru-RU')}`;
    addPageTitle(doc, snapshot.title, filterText);
    if (programFilterNote(snapshot)) doc.fontSize(7).fillColor('#637087').text(programFilterNote(snapshot), { width: 760, lineGap: 1 }).moveDown(0.3);
    doc.fontSize(8).fillColor('#30394b').text('Показатели', { continued: false });
    for (const metric of snapshot.metrics) {
      const value = metric.value === null ? 'Недостаточно данных' : `${metric.value.toLocaleString('ru-RU')} ${metricUnit(metric.value, metric.unit)}`;
      const lastFact = metric.lastFactOccurredAt ? ` Последний факт произошёл: ${new Date(metric.lastFactOccurredAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}.` : '';
      const line = `${metric.label}: ${value} — ${metric.definition} Источник: ${metric.source}. ${metric.completeness} Период показателя: ${metricTimeScopeLabels[metric.timeScope]}. Группировка: ${metricGroupingLabels[metric.grouping]}.${lastFact} Время получения из источника: ${metric.sourceReceivedAt ? new Date(metric.sourceReceivedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : unknownReceiptLabel(metric.grouping).toLocaleLowerCase('ru-RU')}.`;
      doc.moveDown(0.2).fontSize(7).text(line, { width: 760, lineGap: 1 });
    }
    doc.moveDown(0.6).fontSize(9).fillColor('#222634').text(`Исходные записи · ${snapshot.rows.length.toLocaleString('ru-RU')} ${metricUnit(snapshot.rows.length, 'активностей')}`, { continued: false });
    doc.moveDown(0.3);
    if (snapshot.rows.length === 0) doc.fontSize(8).fillColor('#637087').text('Нет записей по выбранным фильтрам.');
    for (const row of snapshot.rows) {
      const parts: string[] = [];
      for (let index = 0; index < columns.length; index += 3) {
        parts.push(columns.slice(index, index + 3).map((column) => `${column.label}: ${pdfColumnValue(row[column.key], 'date' in column && column.date === true)}`).join(' · '));
      }
      const block = parts.join('\n');
      const height = doc.heightOfString(block, { width: 755, lineGap: 1 }) + 10;
      if (doc.y + height > doc.page.height - 74) doc.addPage();
      doc.fontSize(7).fillColor('#30394b').text(block, { width: 755, lineGap: 1 });
      doc.moveDown(0.32).strokeColor('#e4e8ef').moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).stroke();
      doc.moveDown(0.32);
    }
    doc.moveDown(0.5).fontSize(7).fillColor('#637087').text(`Источники: ${snapshot.sources.join('; ')}. Месячная динамика, выручка и конверсия не рассчитываются без подтверждённых фактов и периодов.`);
    const pages = doc.bufferedPageRange().count;
    for (let page = 0; page < pages; page++) {
      doc.switchToPage(page);
      if (page > 0) {
        const context = `${snapshot.title}${programLabel ? ` · ${programLabel} · показатели всей активности` : ''}`;
        doc.fontSize(7).fillColor('#637087').text(context, 36, 16, { width: 760, lineBreak: false });
      }
      doc.fontSize(7).fillColor('#637087').text(`Страница ${page + 1} / ${pages}`, 36, 543, { width: 760, align: 'right', lineBreak: false });
    }
  });
}

async function chartPdf(snapshot: ReportSnapshot): Promise<Buffer> {
  const png = await renderChartPng(snapshot);
  return pdfBuffer((doc) => {
    const organizationLabel = organizationFilterLabel(snapshot);
    addPageTitle(doc, snapshot.chart.title, `${snapshot.chart.unit} · срез на ${new Date(snapshot.asOf).toLocaleString('ru-RU')}${organizationLabel ? ` · ${organizationLabel.toLocaleLowerCase('ru-RU')}` : ''}`);
    doc.image(png, 36, 105, { fit: [760, 470], align: 'center' });
    doc.fontSize(7).fillColor('#637087').text(`Числа показаны как ${snapshot.chart.unit}. Табличная альтернатива включена в JSON/XLS/XLSX отчёт.`, 36, 575, { width: 760 });
  });
}

export async function renderReportFile(snapshot: ReportSnapshot, format: ExportFormat, selectedColumnKeys?: readonly ReportExportColumnKey[]): Promise<{ bytes: Buffer; mediaType: string; extension: string }> {
  const columns = resolveColumns(selectedColumnKeys);
  if (format === 'json') {
    const data = isDefaultColumnSet(columns.map((column) => column.key))
      ? snapshot
      : { ...snapshot, rows: snapshot.rows.map((row) => Object.fromEntries(columns.map((column) => [column.key, row[column.key]]))) };
    return { bytes: Buffer.from(JSON.stringify(data, null, 2), 'utf8'), mediaType: 'application/json; charset=utf-8', extension: 'json' };
  }
  if (format === 'csv') {
    return { bytes: csvReport(snapshot, columns), mediaType: 'text/csv; charset=utf-8', extension: 'csv' };
  }
  if (format === 'xlsx' || format === 'xls') {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, worksheet(snapshot, columns), 'Данные');
    XLSX.utils.book_append_sheet(book, metricsWorksheet(snapshot), 'Показатели');
    const bytes = XLSX.write(book, { type: 'buffer', bookType: format, cellDates: true, compression: true }) as Buffer;
    return { bytes, mediaType: format === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: format };
  }
  if (format === 'pdf') return { bytes: await reportPdf(snapshot, columns), mediaType: 'application/pdf', extension: 'pdf' };
  if (format === 'png') return { bytes: await renderChartPng(snapshot), mediaType: 'image/png', extension: 'png' };
  if (format === 'chart-pdf') return { bytes: await chartPdf(snapshot), mediaType: 'application/pdf', extension: 'pdf' };
  throw new Error('Unsupported report export format.');
}
