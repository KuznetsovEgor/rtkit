import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { DomainError } from './domain.js';

export const MAX_ACTIVITY_DOCUMENT_BYTES = 20 * 1024 * 1024;

const formats = {
  png: { mediaType: 'image/png', family: 'png' },
  jpg: { mediaType: 'image/jpeg', family: 'jpeg' },
  jpeg: { mediaType: 'image/jpeg', family: 'jpeg' },
  pdf: { mediaType: 'application/pdf', family: 'pdf' },
  zip: { mediaType: 'application/zip', family: 'zip' },
  gz: { mediaType: 'application/gzip', family: 'gzip' },
  gzip: { mediaType: 'application/gzip', family: 'gzip' },
  rar: { mediaType: 'application/vnd.rar', family: 'rar' },
  doc: { mediaType: 'application/msword', family: 'ole' },
  docx: { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', family: 'docx' },
  xls: { mediaType: 'application/vnd.ms-excel', family: 'ole' },
  xlsx: { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', family: 'xlsx' },
} as const;

export type ActivityDocumentExtension = keyof typeof formats;
export type ValidatedDocument = {
  name: string;
  extension: ActivityDocumentExtension;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
};

function invalidDocument(message = 'Имя, формат или содержимое файла не поддерживается.') {
  return new DomainError(400, 'invalid_document', message);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(bytes: Buffer): Map<string, Buffer> | null {
  if (bytes.length < 22) return null;
  const hasLocalFile = bytes.subarray(0, 4).toString('hex') === '504b0304';
  const isEmptyZip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (!hasLocalFile && !isEmptyZip) return null;
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = bytes.lastIndexOf(signature);
  if (eocd < minEocd || eocd + 22 > bytes.length) return null;
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff || eocd + 22 + commentLength !== bytes.length ||
      centralOffset + centralSize > eocd) return null;

  const entries = new Map<string, Buffer>();
  const localRanges: { start: number; end: number }[] = [];
  let totalInflated = 0;
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) return null;
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (next > eocd || nameLength === 0 || diskStart !== 0 || (flags & 0x41) !== 0 || ![0, 8].includes(compression) ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
        uncompressedSize > MAX_ACTIVITY_DOCUMENT_BYTES - totalInflated || localOffset + 30 > centralOffset) return null;
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const decodedName = name.toString('utf8');
    if (entries.has(decodedName)) return null;
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) return null;
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localCompression = bytes.readUInt16LE(localOffset + 8);
    const localChecksum = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (localFlags !== flags || localCompression !== compression || localNameLength !== nameLength ||
        !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(name) || dataEnd > centralOffset) return null;
    const hasDescriptor = (flags & 0x08) !== 0;
    if (hasDescriptor) {
      let descriptor = dataEnd;
      if (descriptor + 4 <= centralOffset && bytes.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > centralOffset || bytes.readUInt32LE(descriptor) !== checksum ||
          bytes.readUInt32LE(descriptor + 4) !== compressedSize || bytes.readUInt32LE(descriptor + 8) !== uncompressedSize) return null;
      localRanges.push({ start: localOffset, end: descriptor + 12 });
    } else {
      if (localChecksum !== checksum || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) return null;
      localRanges.push({ start: localOffset, end: dataEnd });
    }
    const compressed = bytes.subarray(dataOffset, dataEnd);
    let contents: Buffer;
    try {
      contents = compression === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, MAX_ACTIVITY_DOCUMENT_BYTES - totalInflated) });
    } catch {
      return null;
    }
    if (contents.length !== uncompressedSize || crc32(contents) !== checksum) return null;
    totalInflated += contents.length;
    entries.set(decodedName, contents);
    offset = next;
  }
  if (offset !== centralOffset + centralSize) return null;
  localRanges.sort((left, right) => left.start - right.start);
  for (let i = 1; i < localRanges.length; i += 1) if (localRanges[i - 1].end > localRanges[i].start) return null;
  return entries;
}

function hasValidGzipContainer(bytes: Buffer): boolean {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || (bytes[3] & 0xe0) !== 0) return false;
  try {
    // gunzipSync validates the DEFLATE stream, CRC32, and ISIZE trailer in memory.
    gunzipSync(bytes, { maxOutputLength: MAX_ACTIVITY_DOCUMENT_BYTES });
    return true;
  } catch {
    return false;
  }
}

function hasValidRarHeader(bytes: Buffer): boolean {
  const v4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
  const v5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
  if (bytes.subarray(0, 7).equals(v4)) {
    if (bytes.length < 14 || bytes[9] !== 0x73) return false;
    const headerSize = bytes.readUInt16LE(12);
    return headerSize >= 7 && 7 + headerSize <= bytes.length;
  }
  if (!bytes.subarray(0, 8).equals(v5) || bytes.length < 12) return false;
  // RAR5 begins with a CRC32 followed by a variable-length header type, flags, and size.
  let offset = 12;
  const readVint = (): number | null => {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 5 && offset < bytes.length; i += 1) {
      const byte = bytes[offset++];
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value >>> 0;
      shift += 7;
    }
    return null;
  };
  const headerType = readVint();
  const flags = readVint();
  const headerSize = readVint();
  return headerType === 1 && flags !== null && headerSize !== null && headerSize > 0 && offset + headerSize <= bytes.length;
}

function hasValidOleHeader(bytes: Buffer): boolean {
  const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(signature)) return false;
  return bytes.readUInt16LE(28) === 0xfffe && [9, 12].includes(bytes.readUInt16LE(30));
}

type XmlAttribute = { name: string; local: string; namespace: string; value: string };
type XmlElement = { name: string; local: string; namespace: string; attributes: XmlAttribute[]; children: XmlElement[] };

const packageContentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const wordProcessingNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function xmlNamePattern() { return /^[A-Za-z_][A-Za-z0-9_.:-]*$/; }

function validXmlCharacters(value: string): boolean {
  for (const character of value) {
    const codepoint = character.codePointAt(0)!;
    if (!(codepoint === 0x09 || codepoint === 0x0a || codepoint === 0x0d ||
          (codepoint >= 0x20 && codepoint <= 0xd7ff) || (codepoint >= 0xe000 && codepoint <= 0xfffd) ||
          (codepoint >= 0x10000 && codepoint <= 0x10ffff))) return false;
  }
  return true;
}

function decodeXmlValue(value: string): string | null {
  if (!validXmlCharacters(value) || value.includes('<') || /&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);)/.test(value)) return null;
  const decoded = value.replace(/&(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&apos;') return "'";
    if (entity === '&quot;') return '"';
    const codepoint = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10);
    if (!Number.isInteger(codepoint) || codepoint === 0 || codepoint > 0x10ffff || (codepoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codepoint))) return '\u0000';
    return String.fromCodePoint(codepoint);
  });
  return decoded.includes('\u0000') ? null : decoded;
}

function parseXmlAttributes(value: string): { name: string; value: string }[] | null {
  const attributes: { name: string; value: string }[] = [];
  const names = new Set<string>();
  let rest = value;
  while (rest.length) {
    const whitespace = rest.match(/^\s+/)?.[0].length ?? 0;
    if (attributes.length && whitespace === 0) return null;
    rest = rest.slice(whitespace);
    if (!rest.length) break;
    const name = rest.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/)?.[1];
    if (!name || !xmlNamePattern().test(name) || names.has(name)) return null;
    names.add(name);
    rest = rest.slice(name.length).replace(/^\s+/, '');
    if (!rest.startsWith('=')) return null;
    rest = rest.slice(1).replace(/^\s+/, '');
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") return null;
    const close = rest.indexOf(quote, 1);
    if (close < 0) return null;
    const decoded = decodeXmlValue(rest.slice(1, close));
    if (decoded === null) return null;
    attributes.push({ name, value: decoded });
    rest = rest.slice(close + 1);
  }
  return attributes;
}

function findXmlTagEnd(xml: string, start: number): number {
  let quote = '';
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function parseXmlPart(bytes: Buffer): XmlElement | null {
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  const initialNamespaces = new Map([['', ''], ['xml', 'http://www.w3.org/XML/1998/namespace']]);
  const stack: { name: string; namespaces: Map<string, string>; element: XmlElement }[] = [];
  let root: XmlElement | null = null;
  let cursor = 0;
  let count = 0;
  let sawXmlDeclaration = false;
  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const end = xml.indexOf('<', cursor);
      const text = xml.slice(cursor, end < 0 ? xml.length : end);
      if (!stack.length && text.trim()) return null;
      if (decodeXmlValue(text) === null) return null;
      cursor = end < 0 ? xml.length : end;
      continue;
    }
    if (xml.startsWith('<!--', cursor)) {
      const end = xml.indexOf('-->', cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes('--') || !validXmlCharacters(xml.slice(cursor + 4, end))) return null;
      cursor = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor + 9);
      if (end < 0 || !stack.length || !validXmlCharacters(xml.slice(cursor + 9, end))) return null;
      cursor = end + 3; continue;
    }
    if (xml.startsWith('<?', cursor)) {
      const end = xml.indexOf('?>', cursor + 2);
      if (end < 0) return null;
      const instruction = xml.slice(cursor + 2, end).trim();
      if (!validXmlCharacters(instruction)) return null;
      if (/^xml(?:\s|$)/i.test(instruction)) {
        if (sawXmlDeclaration || root || !/^xml(?:\s|$)/.test(instruction)) return null;
        sawXmlDeclaration = true;
      }
      cursor = end + 2; continue;
    }
    if (xml.startsWith('<!', cursor)) return null; // DTDs and custom entity declarations are not accepted.
    const end = findXmlTagEnd(xml, cursor + 1);
    if (end < 0) return null;
    const token = xml.slice(cursor + 1, end);
    if (token.startsWith('/')) {
      const closingName = token.slice(1).trim();
      if (!xmlNamePattern().test(closingName) || stack.at(-1)?.name !== closingName) return null;
      stack.pop(); cursor = end + 1; continue;
    }
    const selfClosing = /\/\s*$/.test(token);
    const opening = selfClosing ? token.replace(/\/\s*$/, '') : token;
    const name = opening.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/)?.[1];
    if (!name || !xmlNamePattern().test(name)) return null;
    const rawAttributes = parseXmlAttributes(opening.slice(name.length));
    if (!rawAttributes) return null;
    const namespaces = new Map(stack.at(-1)?.namespaces ?? initialNamespaces);
    for (const attribute of rawAttributes) {
      if (attribute.name === 'xmlns') namespaces.set('', attribute.value);
      else if (attribute.name.startsWith('xmlns:')) namespaces.set(attribute.name.slice(6), attribute.value);
    }
    const colon = name.indexOf(':');
    const prefix = colon < 0 ? '' : name.slice(0, colon);
    const local = colon < 0 ? name : name.slice(colon + 1);
    const namespace = namespaces.get(prefix);
    if (namespace === undefined || !local) return null;
    const attributes: XmlAttribute[] = [];
    const expandedNames = new Set<string>();
    for (const attribute of rawAttributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
        attributes.push({ ...attribute, local: attribute.name === 'xmlns' ? 'xmlns' : attribute.name.slice(6), namespace: 'http://www.w3.org/2000/xmlns/' });
      } else {
        const attributeColon = attribute.name.indexOf(':');
        const attributePrefix = attributeColon < 0 ? '' : attribute.name.slice(0, attributeColon);
        const attributeLocal = attributeColon < 0 ? attribute.name : attribute.name.slice(attributeColon + 1);
        const attributeNamespace = attributePrefix ? namespaces.get(attributePrefix) : '';
        const expandedName = `${attributeNamespace ?? ''}\u0000${attributeLocal}`;
        if (attributeNamespace === undefined || expandedNames.has(expandedName)) return null;
        expandedNames.add(expandedName);
        attributes.push({ ...attribute, local: attributeLocal, namespace: attributeNamespace });
      }
    }
    if (!stack.length && root) return null;
    if (stack.length >= 128 || ++count > 100000) return null;
    const element: XmlElement = { name, local, namespace, attributes, children: [] };
    if (stack.length) stack.at(-1)!.element.children.push(element);
    else root = element;
    if (!selfClosing) stack.push({ name, namespaces, element });
    cursor = end + 1;
  }
  return root && stack.length === 0 ? root : null;
}

function xmlAttribute(element: XmlElement, local: string, namespace = ''): string | null {
  return element.attributes.find((attribute) => attribute.local === local && attribute.namespace === namespace)?.value ?? null;
}

function hasChild(element: XmlElement, local: string, namespace: string): boolean {
  return element.children.some((child) => child.local === local && child.namespace === namespace);
}

type PackageRelationship = { id: string; type: string; target: string; targetMode: string | null };

function parseRelationships(bytes: Buffer): PackageRelationship[] | null {
  const root = parseXmlPart(bytes);
  if (!root || root.local !== 'Relationships' || root.namespace !== packageRelationships) return null;
  const ids = new Set<string>();
  const relationships: PackageRelationship[] = [];
  for (const child of root.children) {
    if (child.local !== 'Relationship' || child.namespace !== packageRelationships) return null;
    const id = xmlAttribute(child, 'Id'); const type = xmlAttribute(child, 'Type');
    const target = xmlAttribute(child, 'Target'); const targetMode = xmlAttribute(child, 'TargetMode');
    if (!id || !type || !target || ids.has(id) || (targetMode !== null && targetMode !== 'Internal')) return null;
    ids.add(id); relationships.push({ id, type, target, targetMode });
  }
  return relationships;
}

function resolvePackageTarget(target: string, sourceDirectory = ''): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return null; }
  if (!decoded || decoded.includes('\\') || /[?#\u0000-\u001f\u007f]/.test(decoded) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) || decoded.startsWith('//')) return null;
  const segments = decoded.startsWith('/') ? [] : sourceDirectory ? sourceDirectory.split('/') : [];
  for (const segment of decoded.replace(/^\//, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!segments.length) return null; segments.pop(); }
    else segments.push(segment);
  }
  return segments.join('/') || null;
}

function validContentTypes(bytes: Buffer, entries: Map<string, Buffer>, mainPath: string, mainType: string): boolean {
  const root = parseXmlPart(bytes);
  if (!root || root.local !== 'Types' || root.namespace !== packageContentTypes) return false;
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const child of root.children) {
    if (child.namespace !== packageContentTypes) return false;
    const contentType = xmlAttribute(child, 'ContentType');
    if (!contentType || /macroenabled|vbaproject/i.test(contentType)) return false;
    if (child.local === 'Default') {
      const extension = xmlAttribute(child, 'Extension')?.toLowerCase();
      if (!extension || !/^[a-z0-9]+$/.test(extension) || defaults.has(extension)) return false;
      defaults.set(extension, contentType);
      continue;
    }
    if (child.local !== 'Override') return false;
    const partName = xmlAttribute(child, 'PartName');
    if (!partName?.startsWith('/') || partName.startsWith('//') || /[%?#\\]/.test(partName)) return false;
    const path = partName.slice(1);
    if (!path || path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
        !entries.has(path) || overrides.has(path)) return false;
    overrides.set(path, contentType);
  }
  if (defaults.get('rels') !== 'application/vnd.openxmlformats-package.relationships+xml' ||
      overrides.get(mainPath) !== mainType) return false;
  for (const name of entries.keys()) {
    if (name === '[Content_Types].xml' || name.endsWith('/')) continue;
    const path = overrides.has(name) ? name : null;
    const extension = name.slice(name.lastIndexOf('/') + 1).match(/\.([^.]+)$/)?.[1]?.toLowerCase();
    const covered = (path && overrides.has(path)) || (extension && defaults.has(extension));
    if (!covered) return false;
  }
  return true;
}

function relationshipsCoverPackageParts(entries: Map<string, Buffer>): boolean {
  for (const [relationshipPart, bytes] of entries) {
    if (!relationshipPart.endsWith('.rels')) continue;
    let sourceDirectory: string;
    if (relationshipPart === '_rels/.rels') {
      sourceDirectory = '';
    } else {
      const match = relationshipPart.match(/^(.*\/)?_rels\/([^/]+)\.rels$/);
      if (!match) return false;
      const sourcePart = `${match[1] ?? ''}${match[2]}`;
      if (!entries.has(sourcePart)) return false;
      sourceDirectory = (match[1] ?? '').replace(/\/$/, '');
    }
    const relationships = parseRelationships(bytes);
    if (!relationships) return false;
    for (const relationship of relationships) {
      const target = resolvePackageTarget(relationship.target, sourceDirectory);
      if (!target || !entries.has(target)) return false;
    }
  }
  return true;
}

function isValidOoxml(entries: Map<string, Buffer>, kind: 'docx' | 'xlsx'): boolean {
  if (entries.has('word/vbaProject.bin') || entries.has('xl/vbaProject.bin')) return false;
  for (const name of entries.keys()) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((segment) => segment === '..' || segment === '.')) return false;
  }
  const mainPath = kind === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
  const expectedMainType = kind === 'docx'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  const contentTypes = entries.get('[Content_Types].xml');
  const packageRelsBytes = entries.get('_rels/.rels');
  if (!contentTypes || !packageRelsBytes || !entries.has(mainPath) ||
      !validContentTypes(contentTypes, entries, mainPath, expectedMainType) || !relationshipsCoverPackageParts(entries)) return false;
  const packageRels = parseRelationships(packageRelsBytes);
  if (!packageRels) return false;
  const officeDocumentRels = packageRels.filter((relationship) => relationship.type === `${officeRelationships}/officeDocument`);
  if (officeDocumentRels.length !== 1 || resolvePackageTarget(officeDocumentRels[0].target) !== mainPath) return false;
  const mainXml = parseXmlPart(entries.get(mainPath)!);
  if (!mainXml) return false;
  if (kind === 'docx') {
    return mainXml.local === 'document' && mainXml.namespace === wordProcessingNamespace && hasChild(mainXml, 'body', wordProcessingNamespace);
  }
  if (mainXml.local !== 'workbook' || mainXml.namespace !== spreadsheetNamespace) return false;
  const sheetNodes = mainXml.children.find((child) => child.local === 'sheets' && child.namespace === spreadsheetNamespace)?.children
    .filter((child) => child.local === 'sheet' && child.namespace === spreadsheetNamespace) ?? [];
  if (!sheetNodes.length) return false;
  const workbookRelsBytes = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbookRelsBytes) return false;
  const workbookRels = parseRelationships(workbookRelsBytes);
  if (!workbookRels) return false;
  const sheetRelationshipIds = new Set(sheetNodes.map((sheet) => xmlAttribute(sheet, 'id', officeRelationships)).filter((id): id is string => !!id));
  if (sheetRelationshipIds.size !== sheetNodes.length) return false;
  return [...sheetRelationshipIds].every((id) => {
    const relationship = workbookRels.find((entry) => entry.id === id);
    if (!relationship || !relationship.type.endsWith('/worksheet')) return false;
    const target = resolvePackageTarget(relationship.target, 'xl');
    if (!target) return false;
    const worksheetBytes = entries.get(target);
    if (!worksheetBytes) return false;
    const worksheet = parseXmlPart(worksheetBytes);
    return !!worksheet && worksheet.local === 'worksheet' && worksheet.namespace === spreadsheetNamespace && hasChild(worksheet, 'sheetData', spreadsheetNamespace);
  });
}

function matchesContainer(family: (typeof formats)[ActivityDocumentExtension]['family'], bytes: Buffer): boolean {
  switch (family) {
    case 'png': {
      if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
      let offset = 8;
      let chunkIndex = 0;
      let hasImageData = false;
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const end = offset + 12 + length;
        if (end > bytes.length || (chunkIndex === 0 && (type !== 'IHDR' || length !== 13))) return false;
        if (type === 'IHDR' && (bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0)) return false;
        if (type === 'IDAT') hasImageData = true;
        if (type === 'IEND') return length === 0 && hasImageData && end === bytes.length;
        offset = end;
        chunkIndex += 1;
      }
      return false;
    }
    case 'jpeg':
      return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    case 'pdf':
      return bytes.length >= 12 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) && bytes.lastIndexOf(Buffer.from('%%EOF')) >= Math.max(5, bytes.length - 1024);
    case 'zip':
      return zipEntries(bytes) !== null;
    case 'docx': {
      const entries = zipEntries(bytes);
      return !!entries && isValidOoxml(entries, 'docx');
    }
    case 'xlsx': {
      const entries = zipEntries(bytes);
      return !!entries && isValidOoxml(entries, 'xlsx');
    }
    case 'gzip':
      return hasValidGzipContainer(bytes);
    case 'rar':
      return hasValidRarHeader(bytes);
    case 'ole':
      return hasValidOleHeader(bytes);
  }
}

export function validateActivityDocument(name: unknown, value: unknown): { file: ValidatedDocument; bytes: Buffer } {
  if (typeof name !== 'string' || name.length < 1 || name.length > 180 || name !== name.trim() ||
      /[\\/\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw invalidDocument('Укажите простое имя файла длиной до 180 символов без путей и управляющих знаков.');
  }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase() as ActivityDocumentExtension;
  const format = formats[extension];
  if (!format) throw invalidDocument('Поддерживаются PNG, JPEG, PDF, ZIP, GZIP, RAR, DOC, DOCX, XLS и XLSX.');
  if (!Buffer.isBuffer(value) || value.length < 1) throw invalidDocument('Файл пуст или не передан.');
  if (value.length > MAX_ACTIVITY_DOCUMENT_BYTES) throw new DomainError(413, 'document_too_large', 'Размер файла не должен превышать 20 МБ.');
  if (!matchesContainer(format.family, value)) throw invalidDocument('Содержимое файла не соответствует расширению или повреждено.');
  return {
    file: { name, extension, mediaType: format.mediaType, sizeBytes: value.length, sha256: createHash('sha256').update(value).digest('hex') },
    bytes: value,
  };
}

const storageDirectory = resolve(process.env.CRM_DOCUMENT_STORAGE ?? './.local-storage/documents');

async function ensurePrivateDirectory() {
  await mkdir(dirname(storageDirectory), { recursive: true, mode: 0o700 });
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(storageDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Document storage directory must be a real directory.');
  await chmod(storageDirectory, 0o700);
}

function storagePath(key: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new DomainError(410, 'document_unavailable', 'Файл недоступен.');
  }
  const path = resolve(storageDirectory, `${key}.blob`);
  const rel = relative(storageDirectory, path);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new DomainError(410, 'document_unavailable', 'Файл недоступен.');
  return path;
}

export async function writePrivateDocument(key: string, bytes: Buffer) {
  await ensurePrivateDirectory();
  const destination = storagePath(key);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function removePrivateDocument(key: string) {
  await unlink(storagePath(key)).catch(() => undefined);
}

export async function readPrivateDocument(key: string, expectedSize: number, expectedSha256: string): Promise<Buffer> {
  try {
    await ensurePrivateDirectory();
    const path = storagePath(key);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize || stat.size > MAX_ACTIVITY_DOCUMENT_BYTES) throw new Error('Invalid private object.');
    const bytes = await readFile(path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== expectedSize || digest !== expectedSha256) throw new Error('Private object integrity check failed.');
    return bytes;
  } catch {
    throw new DomainError(410, 'document_unavailable', 'Файл недоступен или повреждён.');
  }
}
