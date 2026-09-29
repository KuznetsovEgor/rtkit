import type { FastifyInstance } from 'fastify';
import { assertActivityKindAllowed, assertAdmin, DomainError, type Actor } from './domain.js';
import { MAX_IMPORT_FILE_BYTES } from './import-files.js';
import {
  importSchemas, validateImportConfirmationInput, validateImportPreviewInput, type ImportService,
} from './import-service.js';

export function registerImportRoutes(app: FastifyInstance, service: ImportService) {
  app.addContentTypeParser('application/vnd.lct.import', { parseAs: 'buffer', bodyLimit: MAX_IMPORT_FILE_BYTES }, (_request, body, done) => done(null, body));
  app.get('/api/admin/imports/summary', async (request) => {
    const actor = request.actor as Actor;
    assertAdmin(actor);
    return service.adminSummary(actor);
  });
  app.post<{ Querystring: { filename: string; target: string; source: string } }>('/api/imports', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['filename','target','source'], properties: {
      filename: { type: 'string', minLength: 5, maxLength: 180 }, target: { type: 'string', enum: [...importSchemas.targets] }, source: { type: 'string', minLength: 1, maxLength: 80 },
    } } },
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw new DomainError(400, 'import_file_required', 'Передайте тело файла как application/vnd.lct.import.');
    const actor = request.actor as Actor;
    if (request.query.target === 'individual_applications') assertActivityKindAllowed(actor, 'individual');
    const result = await service.upload(actor, request.query.filename, request.query.target, request.query.source, request.body);
    return reply.code(201).send(result);
  });
  app.get<{ Params: { id: string } }>('/api/imports/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (request) =>
    service.get(request.actor as Actor, request.params.id));
  app.get<{ Params: { id: string }; Querystring: { sheet: string; row: number } }>('/api/imports/:id/header', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', additionalProperties: false, required: ['sheet','row'], properties: { sheet: { type: 'string', minLength: 1, maxLength: 120 }, row: { type: 'integer', minimum: 1 } } },
    },
  }, async (request) => service.getHeader(request.actor as Actor, request.params.id, request.query.sheet, request.query.row));
  app.delete<{ Params: { id: string } }>('/api/imports/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => {
    await service.cancel(request.actor as Actor, request.params.id);
    return reply.code(204).send();
  });
  app.put<{ Params: { id: string } }>('/api/imports/:id/preview', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request) => {
    validateImportPreviewInput(request.body);
    return service.preview(request.actor as Actor, request.params.id, request.body);
  });
  app.post<{ Params: { id: string } }>('/api/imports/:id/confirm', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: importSchemas.confirmationSchema },
  }, async (request, reply) => {
    validateImportConfirmationInput(request.body);
    return reply.code(200).send(await service.confirm(request.actor as Actor, request.params.id, request.body));
  });
  app.get<{ Querystring: { query?: string } }>('/api/contacts', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 100 } } } },
  }, async (request) => service.listContacts(request.actor as Actor, request.query.query ?? ''));
  app.get('/api/vendors', async (request) => service.listVendors(request.actor as Actor));
}
