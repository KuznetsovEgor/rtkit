import type { FastifyInstance } from 'fastify';
import { DomainError, type Actor } from './domain.js';
import { PostgresExchangeService } from './exchange-service.js';

const adminOnly = (actor: Actor) => {
  if (!actor.roles.includes('admin')) throw new DomainError(403, 'forbidden', 'Для управления обменом нужна роль администратора.');
};
const uuid = { type: 'string', format: 'uuid' };

export function registerExchangeRoutes(app: FastifyInstance, exchanges: PostgresExchangeService) {
  app.get('/api/cms-mock/intake', async (request) => exchanges.cmsIntake(request.actor as Actor));
  app.post<{ Params: { id: string } }>('/api/cms-mock/intake/:id/claim', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } },
  }, async (request) => exchanges.claimCmsIntake(request.actor as Actor, request.params.id));
  app.get<{ Params: { id: string } }>('/api/activities/:id/exchanges', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } },
  }, async (request) => exchanges.listForActivity(request.actor as Actor, request.params.id));
  app.post<{ Params: { id: string }; Body: { idempotencyKey: string } }>('/api/activities/:id/exchanges/lms-requests', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuid } },
      body: { type: 'object', additionalProperties: false, required: ['idempotencyKey'], properties: { idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 } } },
    },
  }, async (request, reply) => reply.code(201).send(await exchanges.requestLms(request.actor as Actor, request.params.id, request.body.idempotencyKey)));
  app.post<{ Params: { id: string } }>('/api/exchanges/:id/retry', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } },
  }, async (request) => exchanges.retry(request.actor as Actor, request.params.id));
  app.get('/api/admin/exchanges', async (request) => exchanges.monitor(request.actor as Actor));
  app.post('/api/admin/exchanges/cms/pull', async (request) => { adminOnly(request.actor as Actor); return exchanges.pullCms(request.actor as Actor); });
  app.post('/api/admin/exchanges/lms/pull', async (request) => { adminOnly(request.actor as Actor); return exchanges.pullLms(request.actor as Actor); });
  app.post<{ Params: { system: string }; Body: { mode: string } }>('/api/admin/exchanges/mocks/:system/fail-next', {
    schema: {
      params: { type: 'object', required: ['system'], properties: { system: { type: 'string', enum: ['cms', 'lms'] } } },
      body: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { type: 'string', enum: ['http_error', 'reject_next'] } } },
    },
  }, async (request) => {
    adminOnly(request.actor as Actor);
    return exchanges.setFailure(request.actor as Actor, request.params.system as 'cms' | 'lms', request.body.mode as 'http_error' | 'reject_next');
  });
  app.post<{ Params: { id: string }; Body: { outcome: 'perform' | 'reject'; factKind: 'enrollment' | 'learning_started' | 'learning_completed' } }>('/api/admin/exchanges/lms/:id/outcome', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuid } },
      body: { type: 'object', additionalProperties: false, required: ['outcome'], properties: {
        outcome: { type: 'string', enum: ['perform', 'reject'] }, factKind: { type: 'string', enum: ['enrollment', 'learning_started', 'learning_completed'] },
      } },
    },
  }, async (request) => {
    adminOnly(request.actor as Actor);
    return exchanges.setLmsOutcome(request.actor as Actor, request.params.id, request.body.outcome, request.body.factKind ?? 'enrollment');
  });
}
