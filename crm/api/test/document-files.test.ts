import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { DomainError } from '../src/domain.js';
import { MAX_ACTIVITY_DOCUMENT_BYTES, validateActivityDocument } from '../src/document-files.js';

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, Buffer> = {}, deflated = false) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  for (const [entryName, contents] of Object.entries(entries)) {
    const name = Buffer.from(entryName);
    const checksum = crc32(contents);
    const compressed = deflated ? deflateRawSync(contents) : contents;
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflated ? 8 : 0, 8); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(name.length, 26);
    name.copy(local, 30); compressed.copy(local, 30 + name.length);
    locals.push(local);

    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(deflated ? 8 : 0, 10);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(contents.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(localOffset, 42); name.copy(record, 46);
    central.push(record);
    localOffset += local.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const pdf = Buffer.from('%PDF-1.7\n%%EOF\n');
const rar4 = Buffer.alloc(14);
Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]).copy(rar4); rar4[9] = 0x73; rar4.writeUInt16LE(7, 12);
const rar5 = Buffer.alloc(16);
Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]).copy(rar5); rar5.set([1, 0, 1, 0], 12);
const ole = Buffer.alloc(512);
Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole); ole.writeUInt16LE(0xfffe, 28); ole.writeUInt16LE(9, 30);
const docxParts = {
  '[Content_Types].xml': Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>'),
};
const docx = zip(docxParts, true);
const xlsx = zip({
  '[Content_Types].xml': Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
  '_rels/.rels': Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
  'xl/workbook.xml': Buffer.from('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'),
}, true);

test('accepts every contracted extension only with its signature or container structure', () => {
  const cases: [string, Buffer][] = [
    ['diagram.png', png], ['photo.jpeg', jpeg], ['report.pdf', pdf], ['empty.zip', zip()],
    ['archive.gz', gzipSync(Buffer.from('not extracted'))], ['archive.gzip', gzipSync(Buffer.from('alternate suffix'))], ['archive.rar', rar4], ['archive.rar', rar5],
    ['letter.doc', ole], ['book.xls', ole],
    ['agreement.docx', docx], ['plan.xlsx', xlsx],
  ];
  for (const [name, bytes] of cases) {
    const result = validateActivityDocument(name, bytes);
    assert.equal(result.file.sizeBytes, bytes.length, name);
    assert.equal(result.bytes, bytes, name);
  }
});

test('rejects unsafe names, unsupported extensions, corrupt containers and oversized uploads', () => {
  const placeholderDocx = zip({ '[Content_Types].xml': Buffer.from('<Types/>'), 'word/document.xml': Buffer.from('<document/>') });
  const placeholderXlsx = zip({ '[Content_Types].xml': Buffer.from('<Types/>'), 'xl/workbook.xml': Buffer.from('<workbook/>') });
  const corruptDocx = Buffer.from(docx); corruptDocx[30 + Buffer.byteLength('[Content_Types].xml')] ^= 0x40;
  const badRelationshipDocx = zip({
    '[Content_Types].xml': Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/missing.xml"/></Relationships>'),
    'word/document.xml': Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'),
  });
  const validGzip = gzipSync(Buffer.from('small gzip member'));
  const badGzipCrc = Buffer.from(validGzip); badGzipCrc[badGzipCrc.length - 8] ^= 0x01;
  const badGzipTrailer = Buffer.from([0x1f, 0x8b, 0x08, 0x00, ...new Array(15).fill(0)]);
  const corruptZip = zip({ 'notes.txt': Buffer.from('archive payload') });
  corruptZip[30 + Buffer.byteLength('notes.txt')] ^= 0x20;
  const badPathDocx = zip({ ...docxParts, '../escaped.xml': Buffer.from('<x/>') });
  const expandedZip = zip({ 'large.txt': Buffer.alloc(MAX_ACTIVITY_DOCUMENT_BYTES + 1, 0x41) }, true);
  const invalidCases: [string, Buffer][] = [
    ['../report.png', png], ['report.txt', png], ['report.pdf', png], ['report.docx', zip({ 'word/document.xml': Buffer.from('<document/>') })],
    ['report.png', Buffer.alloc(0)], ['report.png', Buffer.alloc(MAX_ACTIVITY_DOCUMENT_BYTES + 1)],
    ['placeholder.docx', placeholderDocx], ['placeholder.xlsx', placeholderXlsx], ['corrupt.docx', corruptDocx], ['broken-links.docx', badRelationshipDocx],
    ['traversal.docx', badPathDocx], ['corrupt.zip', corruptZip], ['expanded.zip', expandedZip], ['corrupt.gz', badGzipCrc], ['truncated.gz', badGzipTrailer],
  ];
  for (const [name, bytes] of invalidCases) {
    assert.throws(() => validateActivityDocument(name, bytes), (error: unknown) => error instanceof DomainError && [400, 413].includes(error.statusCode), name);
  }
});
