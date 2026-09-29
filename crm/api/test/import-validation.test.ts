import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMappedImportRow } from '../src/import-service.js';

test('contact row reports a single useful error for a missing name', () => {
  assert.deepEqual(validateMappedImportRow('contacts', { fullName: null, email: 'bad-email' }), [
    'Не указано имя контакта.',
    'Проверьте адрес email.',
  ]);
});

test('individual application row reports a single useful error for a missing applicant name', () => {
  assert.deepEqual(validateMappedImportRow('individual_applications', { fullName: null, externalKey: 'QA-IMPORT-INVALID' }), [
    'Не указано имя заявителя.',
  ]);
});

test('vendor row still reports its required name error', () => {
  assert.deepEqual(validateMappedImportRow('vendors', { name: null }), [
    'Не указано название поставщика.',
  ]);
});
