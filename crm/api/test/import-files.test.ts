import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseImportBuffer, validateImportFilename } from '../src/import-files.js';
import { DomainError } from '../src/domain.js';

function spreadsheet(bookType: 'xlsx' | 'biff8', rows: unknown[][]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'User Uploads');
  return XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer;
}

test('parses genuine XLSX and legacy XLS workbooks while retaining raw headings and phone strings', () => {
  for (const [format, bookType] of [['xlsx', 'xlsx'], ['xls', 'biff8']] as const) {
    const bytes = spreadsheet(bookType, [['External ID','Full Name','Email','Phone'], ['u-17','Ada Lovelace','Ada@Example.test','+7 000 123']]);
    const parsed = parseImportBuffer(bytes, format, 'contacts');
    assert.equal(parsed.sheets[0].name, 'User Uploads');
    assert.deepEqual(parsed.sheets[0].rows[0].map((cell) => cell.value), ['External ID','Full Name','Email','Phone']);
    assert.equal(parsed.sheets[0].rows[1][2].value, 'Ada@Example.test');
    assert.equal(parsed.sheets[0].rows[1][3].value, '+7 000 123');
  }
});

test('formula and hyperlink cells become empty values without evaluating formulas or resolving links', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Full Name','Email','Phone','Website'], ['Person',null,'+7 123',null]]);
  sheet.B2 = { t: 'n', f: 'HYPERLINK("https://invalid.example","x")', v: 1, l: { Target: 'https://invalid.example' } } as XLSX.CellObject;
  sheet.D2 = { t: 's', v: 'Home', l: { Target: 'javascript:alert(1)' } } as XLSX.CellObject;
  XLSX.utils.book_append_sheet(workbook, sheet, 'Contacts');
  const parsed = parseImportBuffer(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'xlsx', 'contacts');
  assert.equal(parsed.sheets[0].rows[1][1].value, null);
  assert.equal(parsed.sheets[0].rows[1][1].unsafe, 'formula');
  assert.equal(parsed.sheets[0].rows[1][2].value, '+7 123');
  assert.equal(parsed.sheets[0].rows[1][3].value, null);
  assert.equal(parsed.sheets[0].rows[1][3].unsafe, 'link');
});

test('reads the defined external applications JSON without executing script-like text', () => {
  const bytes = Buffer.from(JSON.stringify({ applications: [{ applicationId: 'app-7', applicant: { fullName: '<script>text</script>', email: 'A@Example.test', phone: '+7 01' }, productName: 'Python' }] }));
  const parsed = parseImportBuffer(bytes, 'json', 'individual_applications');
  assert.deepEqual(parsed.sheets[0].rows[0].map((cell) => cell.value), ['applicationId','applicant.fullName','applicant.email','applicant.phone','productName']);
  assert.equal(parsed.sheets[0].rows[1][1].value, '<script>text</script>');
});

test('parses UTF-8 CSV including BOM, Cyrillic, RFC 4180 quotes, commas, and embedded newlines', () => {
  const bytes = Buffer.from('\uFEFFExternal ID,Имя,Примечание\r\napp-1,"Иван, ""Иваныч""","первая строка\r\nвторая строка"\r\napp-2,Мария,"кавычки ""внутри"""\r\n');
  const parsed = parseImportBuffer(bytes, 'csv', 'individual_applications');
  assert.equal(parsed.sheets[0].name, 'CSV');
  assert.deepEqual(parsed.sheets[0].rows.map((row) => row.map((cell) => cell.value)), [
    ['External ID', 'Имя', 'Примечание'],
    ['app-1', 'Иван, "Иваныч"', 'первая строка\r\nвторая строка'],
    ['app-2', 'Мария', 'кавычки "внутри"'],
  ]);
});

test('CSV text beginning with formula characters remains literal source data for validation and later safe export', () => {
  const parsed = parseImportBuffer(Buffer.from('Name,Email\r\n=1+1,person@example.test\r\n'), 'csv', 'contacts');
  assert.equal(parsed.sheets[0].rows[1][0].value, '=1+1');
  assert.equal(parsed.sheets[0].rows[1][0].unsafe, null, 'CSV is text; import never executes or silently deletes formula-like values.');
});

test('skips null application entries with their original row numbers and retains following objects', () => {
  const applications = [null, ...Array.from({ length: 5 }, (_value, index) => ({
    applicationId: `app-${index + 1}`, applicant: { fullName: `Applicant ${index + 1}`, email: `Person${index + 1}@Example.test` },
  }))];
  const parsed = parseImportBuffer(Buffer.from(JSON.stringify(applications)), 'json', 'individual_applications');
  assert.deepEqual(parsed.sheets[0].skippedRows, [2]);
  assert.equal(parsed.sheets[0].rows.length, 7, 'Header, null row and all five application rows are retained.');
  assert.equal(parsed.sheets[0].rows[2][0].value, 'app-1');
  assert.equal(parsed.sheets[0].rows[6][0].value, 'app-5');
});

test('rejects format spoofing, malformed JSON and target/format mismatches', () => {
  assert.throws(() => validateImportFilename('../contacts.xlsx'), DomainError);
  assert.equal(validateImportFilename('contacts.CSV').extension, 'csv');
  assert.throws(() => parseImportBuffer(Buffer.from('not a spreadsheet'), 'xlsx', 'contacts'), DomainError);
  assert.throws(() => parseImportBuffer(Buffer.from('{'), 'json', 'individual_applications'), DomainError);
  assert.throws(() => parseImportBuffer(Buffer.from('[]'), 'json', 'contacts'), DomainError);
  assert.throws(() => parseImportBuffer(Buffer.from('Name\r\n"unterminated'), 'csv', 'contacts'), /незакрытое поле/);
  assert.throws(() => parseImportBuffer(Buffer.from('Name\r\n"closed"tail'), 'csv', 'contacts'), /после закрывающей кавычки/);
  assert.throws(() => parseImportBuffer(Buffer.from([0xff, 0xfe]), 'csv', 'contacts'), /UTF-8/);
  assert.throws(() => parseImportBuffer(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), 'csv', 'contacts'), /не больше 5 МБ/);
  assert.throws(() => parseImportBuffer(Buffer.from(`Name\r\n${Array.from({ length: 2_001 }, (_value, index) => `Person ${index}`).join('\r\n')}`), 'csv', 'contacts'), /2 000 строк данных/);
  assert.throws(() => parseImportBuffer(Buffer.from(`${Array.from({ length: 101 }, (_value, index) => `h${index}`).join(',')}\r\n`), 'csv', 'contacts'), /100 колонок/);
});

test('rejects oversized spreadsheets even when the parser caps materialized rows', () => {
  const rows: string[][] = [['Name']];
  for (let index = 0; index < 2_001; index += 1) rows.push([`Person ${index}`]);
  const bytes = spreadsheet('xlsx', rows);
  assert.throws(() => parseImportBuffer(bytes, 'xlsx', 'contacts'), DomainError);
});

test('preserves physical row offsets when the first used header is after blank rows', () => {
  const sheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(sheet, [['External ID','Full Name']], { origin: 'A7' });
  XLSX.utils.sheet_add_aoa(sheet, [['person-7','Late Header']], { origin: 'A8' });
  sheet['!ref'] = 'A7:B8';
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, 'User Uploads');
  const parsed = parseImportBuffer(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'xlsx', 'contacts');
  assert.equal(parsed.sheets[0].rowOffset, 6);
  assert.equal(parsed.sheets[0].rows[0][0].value, 'External ID');
  assert.equal(parsed.sheets[0].rows[1][1].value, 'Late Header');
});
