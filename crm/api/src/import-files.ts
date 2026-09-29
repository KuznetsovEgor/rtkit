import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as XLSX from 'xlsx';
import { DomainError } from './domain.js';

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_COLUMNS = 100;
const MAX_IMPORT_SHEETS = 12;
const MAX_XLSX_INFLATED_BYTES = 24 * 1024 * 1024;
const storageDirectory = resolve(process.env.CRM_IMPORT_STORAGE ?? './.local-storage/imports');

export type ImportedCell = { value: string | null; unsafe: 'formula' | 'link' | null };
export type ImportedSheet = { name: string; rows: ImportedCell[][]; rowOffset?: number; skippedRows?: number[] };
export type ImportPayload = { sheets: ImportedSheet[] };

function invalidFile(message = 'Файл повреждён или его формат не поддерживается.') {
  return new DomainError(400, 'invalid_import_file', message);
}

function filePath(key: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw new Error('Invalid import file key.');
  const path = resolve(storageDirectory, `${key}.tmp`);
  const rel = relative(storageDirectory, path);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Invalid import file path.');
  return path;
}

async function ensurePrivateDirectory() {
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(storageDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Import storage must be a real directory.');
  await chmod(storageDirectory, 0o700);
}

export async function writePrivateImportFile(bytes: Buffer) {
  await ensurePrivateDirectory();
  const key = randomUUID();
  const destination = filePath(key);
  const temporary = `${destination}.${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    return key;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readPrivateImportFile(key: string, expectedSize: number) {
  await ensurePrivateDirectory();
  const path = filePath(key);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize || stat.size > MAX_IMPORT_FILE_BYTES) throw new Error('Invalid private import file.');
  return readFile(path);
}

export async function removePrivateImportFile(key: string) {
  await unlink(filePath(key)).catch(() => undefined);
}

function validateZipContainer(bytes: Buffer) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw invalidFile();
  const lower = Math.max(0, bytes.length - 22 - 0xffff);
  const marker = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = bytes.lastIndexOf(marker);
  if (eocd < lower || eocd + 22 > bytes.length) throw invalidFile();
  const disk = bytes.readUInt16LE(eocd + 4); const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskCount = bytes.readUInt16LE(eocd + 8); const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12); const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk || centralDisk || diskCount !== count || count > 500 || count === 0xffff || centralSize === 0xffffffff ||
    centralOffset === 0xffffffff || eocd + 22 + commentLength !== bytes.length || centralOffset + centralSize > eocd) throw invalidFile();
  const names = new Set<string>(); let offset = centralOffset; let inflated = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalidFile();
    const flags = bytes.readUInt16LE(offset + 8); const compressed = bytes.readUInt32LE(offset + 20); const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28); const extraLength = bytes.readUInt16LE(offset + 30); const noteLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38); const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString('utf8'); const next = offset + 46 + nameLength + extraLength + noteLength;
    const mode = externalAttributes >>> 16;
    if (next > eocd || !name || names.has(name) || (flags & 0x41) !== 0 || name.startsWith('/') || name.split('/').includes('..') ||
      (mode & 0xf000) === 0xa000 || expanded === 0xffffffff || compressed === 0xffffffff || (compressed === 0 && expanded > 0) ||
      (compressed > 0 && expanded / compressed > 150)) throw invalidFile();
    names.add(name); inflated += expanded;
    if (inflated > MAX_XLSX_INFLATED_BYTES) throw invalidFile('Внутренний объём таблицы слишком велик для безопасной проверки.');
    offset = next;
  }
  if (offset !== centralOffset + centralSize || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml') ||
    ![...names].some((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) throw invalidFile();
}

function cellText(value: unknown, formatted?: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return typeof formatted === 'string' ? formatted : String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function parseSpreadsheet(bytes: Buffer): ImportPayload {
  const workbook = XLSX.read(bytes, {
    type: 'buffer', cellFormula: true, cellText: true, cellHTML: false,
    cellStyles: false, cellNF: false, bookVBA: false, bookFiles: false, bookProps: false,
    sheetRows: MAX_IMPORT_ROWS + 2, WTF: false,
  });
  if (!workbook.SheetNames.length || workbook.SheetNames.length > MAX_IMPORT_SHEETS) throw invalidFile('В книге должно быть от 1 до 12 листов.');
  const sheets: ImportedSheet[] = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const reference = sheet?.['!ref'];
    if (!reference) return { name, rows: [] };
    let range: XLSX.Range;
    let fullRange: XLSX.Range;
    try {
      range = XLSX.utils.decode_range(reference);
      // `sheetRows` intentionally bounds what SheetJS materializes. When it clips
      // a larger source sheet, `!fullref` retains the original dimensions.
      fullRange = XLSX.utils.decode_range(sheet['!fullref'] ?? reference);
    } catch { throw invalidFile(); }
    const totalRows = fullRange.e.r - fullRange.s.r + 1; const totalColumns = fullRange.e.c - fullRange.s.c + 1;
    if (totalRows > MAX_IMPORT_ROWS + 1 || fullRange.e.r + 1 > MAX_IMPORT_ROWS + 2 || totalColumns > MAX_IMPORT_COLUMNS) throw invalidFile('В одном листе допускается не более 2 000 строк данных и 100 колонок.');
    const rows: ImportedCell[][] = [];
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      const values: ImportedCell[] = [];
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
        const unsafe = cell?.f ? 'formula' : cell?.l ? 'link' : null;
        // SheetJS reads stored cell values only. Formula and hyperlink cells are discarded here;
        // formulas are never evaluated and link targets are never opened or imported.
        values.push({ value: unsafe ? null : cellText(cell?.v, cell?.w), unsafe });
      }
      rows.push(values);
    }
    return { name, rows, rowOffset: range.s.r };
  });
  return { sheets };
}

function parseCsv(bytes: Buffer): ImportPayload {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw invalidFile('CSV должен быть в кодировке UTF-8.'); }
  if (!text.length) throw invalidFile('CSV не содержит строк.');

  const rows: ImportedCell[][] = [];
  let row: ImportedCell[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let atFieldStart = true;
  let sawRecordContent = false;
  const pushField = () => {
    if (row.length >= MAX_IMPORT_COLUMNS) throw invalidFile('В CSV допускается не более 100 колонок.');
    row.push({ value: field === '' ? null : field, unsafe: null });
    field = '';
    atFieldStart = true;
    afterQuote = false;
  };
  const pushRow = () => {
    pushField();
    if (rows.length >= MAX_IMPORT_ROWS + 1) throw invalidFile('В CSV допускается не более 2 000 строк данных.');
    rows.push(row);
    row = [];
    sawRecordContent = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; afterQuote = true; }
      } else field += character;
      continue;
    }

    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') throw invalidFile('CSV содержит символы после закрывающей кавычки.');
    if (character === '"') {
      if (!atFieldStart) throw invalidFile('CSV содержит кавычку внутри незаключённого в кавычки поля.');
      quoted = true;
      atFieldStart = false;
      sawRecordContent = true;
    } else if (character === ',') {
      pushField();
      sawRecordContent = true;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      field += character;
      atFieldStart = false;
      sawRecordContent = true;
    }
  }
  if (quoted) throw invalidFile('CSV содержит незакрытое поле в кавычках.');
  if (sawRecordContent || row.length > 0 || field.length > 0 || afterQuote) pushRow();
  if (!rows.length) throw invalidFile('CSV не содержит строк.');
  if (rows.some((record) => record.length > MAX_IMPORT_COLUMNS)) throw invalidFile('В CSV допускается не более 100 колонок.');
  return { sheets: [{ name: 'CSV', rows }] };
}

function flattenObject(value: unknown, prefix = '', depth = 0): Record<string, ImportedCell> {
  const result: Record<string, ImportedCell> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return result;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child) && depth < 4) Object.assign(result, flattenObject(child, path, depth + 1));
    else if (Array.isArray(child)) result[path] = { value: child.map((item) => item === null ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item)).join('; '), unsafe: null };
    else result[path] = { value: cellText(child), unsafe: null };
  }
  return result;
}

function parseJson(bytes: Buffer): ImportPayload {
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { throw invalidFile('JSON должен быть в кодировке UTF-8.'); }
  let parsed: unknown;
  try { parsed = JSON.parse(decoded); } catch { throw invalidFile('JSON содержит синтаксическую ошибку.'); }
  const rootValue: unknown = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).applications)
    ? (parsed as Record<string, unknown>).applications : null;
  if (!Array.isArray(rootValue) || !rootValue.length || rootValue.length > MAX_IMPORT_ROWS ||
    !rootValue.some((item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)) ||
    rootValue.some((item: unknown) => item !== null && (typeof item !== 'object' || Array.isArray(item)))) {
    throw invalidFile('Ожидается JSON-массив заявок или объект с массивом applications (до 2 000 записей).');
  }
  const root = rootValue as unknown[];
  const flatRows = root.map((item) => item === null ? {} : flattenObject(item));
  const names = [...new Set(flatRows.flatMap((row) => Object.keys(row)))];
  if (names.length > MAX_IMPORT_COLUMNS) throw invalidFile('В заявке допускается не более 100 полей.');
  const skippedRows = root.flatMap((item, index) => item === null ? [index + 2] : []);
  return { sheets: [{ name: 'applications', rowOffset: 0, skippedRows, rows: [names.map((name) => ({ value: name, unsafe: null })), ...flatRows.map((row) => names.map((name) => row[name] ?? { value: null, unsafe: null }))] }] };
}

export function validateImportFilename(value: unknown) {
  if (typeof value !== 'string' || value.length < 5 || value.length > 180 || value !== value.split(/[\\/]/).at(-1) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError(400, 'invalid_import_filename', 'Укажите простое имя файла без пути.');
  }
  const extension = value.split('.').at(-1)?.toLowerCase();
  if (!extension || !['xls', 'xlsx', 'json', 'csv'].includes(extension)) throw new DomainError(400, 'unsupported_import_format', 'Поддерживаются настоящие XLS, XLSX, JSON и UTF-8 CSV-файлы.');
  return { name: value, extension: extension as 'xls' | 'xlsx' | 'json' | 'csv' };
}

export function parseImportBuffer(bytes: Buffer, extension: 'xls' | 'xlsx' | 'json' | 'csv', target: string): ImportPayload {
  if (!bytes.length || bytes.length > MAX_IMPORT_FILE_BYTES) throw new DomainError(413, 'import_file_too_large', 'Файл импорта должен быть не пустым и не больше 5 МБ.');
  if (target === 'individual_applications' && !['json', 'csv'].includes(extension)) throw new DomainError(400, 'import_format_for_target', 'Внешние индивидуальные заявки принимаются как JSON или CSV со стабильным внешним ID.');
  if (target !== 'individual_applications' && extension === 'json') throw new DomainError(400, 'import_format_for_target', 'Контакты и поставщики принимаются как таблица XLS, XLSX или CSV.');
  if (extension === 'xls' && !bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) throw invalidFile();
  if (extension === 'xlsx') validateZipContainer(bytes);
  try {
    const parsed = extension === 'json' ? parseJson(bytes) : extension === 'csv' ? parseCsv(bytes) : parseSpreadsheet(bytes);
    if (!parsed.sheets.length || parsed.sheets.some((sheet) => sheet.rows.length > MAX_IMPORT_ROWS + 1)) throw invalidFile('В таблице больше 2 000 строк данных.');
    return parsed;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw invalidFile();
  }
}
