import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  assertActivityKindAllowed, assertAdmin, assertBusinessAccess, assertCanCreate, assertManager, DomainError, type ActivityContractLicenseFields, type ActivityContractLicenseInput, type ActivityDetailsUpdate, type ActivityKind, type Actor, type ActivityReassignmentPreviewInput, type CorporatePlanInput, type CrmRepository, type GuidanceArticleContent, type GuidanceEditorialRecord, type GuidanceFeedback, type GuidanceFeedbackAction, type NewActivity, type NewTask,
  type Outcome, type UniversityCorrectionReturn, type UniversityStepUpdate, type UniversityWorkflowApply, type UniversityWorkflowChange, validateActivityContractLicense, validateActivityDetailsUpdate, validateCorporatePlan, validateNewActivity, validateTask,
} from './domain.js';
import { findStageArticle, guidanceMetadata, guidanceSnapshotMatches, guidanceStageSnapshot, makeContextualTip, stageArticles, type StageArticle, type StageGuidanceEntry, type GuidanceTask, validateGuidanceArticleContent } from './guidance.js';
import { MAX_ACTIVITY_DOCUMENT_BYTES, readPrivateDocument, removePrivateDocument, validateActivityDocument, writePrivateDocument } from './document-files.js';
import { registerImportRoutes } from './import-api.js';
import type { ImportService } from './import-service.js';
import { registerExchangeRoutes } from './exchange-api.js';
import type { PostgresExchangeService } from './exchange-service.js';
import { registerReportRoutes, reportOpenApiPaths } from './report-api.js';
import type { AccessPolicyService } from './access-policy-service.js';
import { type PublicDemoInquiry, validatePublicDemoInquiry } from './public-demo-intake.js';

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor }
}

export type Authenticator = (request: FastifyRequest) => Promise<Actor>;
export interface AppOptions { repository: CrmRepository; imports?: ImportService; exchanges?: PostgresExchangeService; accessPolicy?: AccessPolicyService; authenticate?: Authenticator; publicDemoIntake?: { enabled: boolean; submit: (input: PublicDemoInquiry, idempotencyKey: string) => Promise<{ duplicate: boolean }> } }

const issuer = process.env.OIDC_ISSUER ?? 'http://localhost:18080/realms/lct';
const jwksUrl = process.env.OIDC_JWKS_URL ?? 'http://localhost:18080/realms/lct/protocol/openid-connect/certs';
const clientId = process.env.OIDC_CLIENT_ID ?? 'lct-web';
const jwks = createRemoteJWKSet(new URL(jwksUrl));

export async function verifyAccessToken(token: string, keys: Parameters<typeof jwtVerify>[1], expectedIssuer: string, expectedClientId: string): Promise<Actor> {
  const { payload } = await jwtVerify(token, keys, { issuer: expectedIssuer, audience: expectedClientId });
  if (payload.azp !== expectedClientId || typeof payload.sub !== 'string') throw new Error('invalid client');
  const realmRoles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
  const roles = Array.isArray(realmRoles) ? realmRoles.filter((role): role is string => typeof role === 'string') : [];
  const name = typeof payload.name === 'string' ? payload.name
    : typeof payload.preferred_username === 'string' ? payload.preferred_username : 'Пользователь';
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  return { sub: payload.sub, name, email, roles };
}

async function authenticateBearer(request: FastifyRequest): Promise<Actor> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new DomainError(401, 'unauthorized', 'Войдите в рабочее пространство.');
  try {
    return await verifyAccessToken(header.slice(7), jwks, issuer, clientId);
  } catch {
    throw new DomainError(401, 'unauthorized', 'Сеанс входа истёк или недействителен. Войдите снова.');
  }
}

const roleSet = ['kam', 'manager', 'admin'];
const hasWorkspaceRole = (actor: Actor) => actor.roles.some((role) => roleSet.includes(role));
const assertProgramAccess = (actor: Actor) => {
  if (!actor.roles.some((role) => role === 'kam' || role === 'manager' || role === 'admin')) throw new DomainError(403, 'forbidden', 'Для каталога программ нужна роль КАМ, руководителя или администратора.');
};
const assertProgramManagement = (actor: Actor) => {
  if (!actor.roles.some((role) => role === 'manager' || role === 'admin')) throw new DomainError(403, 'forbidden', 'Изменять каталог программ может руководитель или администратор.');
};
const businessRoutePrefixes = ['/api/activities', '/api/feed', '/api/notifications', '/api/catalog', '/api/contacts', '/api/vendors', '/api/imports', '/api/reports', '/api/guidance', '/api/cms-mock/intake'];
const requiresBusinessRole = (url: string) => {
  const path = url.split('?', 1)[0];
  return businessRoutePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) || path === '/api/manager/overview';
};
const redactWorkflowPreview = (actor: Actor, preview: Record<string, any>) => actor.roles.includes('manager') ? preview : {
  ...preview,
  impactedActivities: Array.isArray(preview.impactedActivities)
    ? preview.impactedActivities.map((activity: Record<string, unknown>) => ({ ...activity, title: null, ownerName: null }))
    : preview.impactedActivities,
};
const redactWorkflowApplyResult = (actor: Actor, result: Record<string, any>) => actor.roles.includes('manager') ? result : {
  ...result,
  changedActivities: Array.isArray(result.changedActivities)
    ? result.changedActivities.map((activity: Record<string, unknown>) => ({ ...activity, title: null }))
    : result.changedActivities,
};
const uuidSchema = { type: 'string', format: 'uuid' };
const workflowStageDraftSchema = {
  type: 'object', additionalProperties: false, required: ['key', 'label', 'ordinal', 'terminal'],
  properties: {
    key: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' }, label: { type: 'string', minLength: 1, maxLength: 120 },
    ordinal: { type: 'integer', minimum: 1, maximum: 40 }, terminal: { type: 'boolean' },
  },
};
const workflowTransitionDraftSchema = {
  type: 'object', additionalProperties: false, required: ['from', 'to'],
  properties: { from: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' }, to: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' } },
};
const universityWorkflowChangeBodySchema = {
  type: 'object', additionalProperties: false, required: ['expectedRevision', 'stages', 'transitions', 'mappings'],
  properties: {
    expectedRevision: { type: 'integer', minimum: 1 },
    stages: { type: 'array', minItems: 2, maxItems: 40, items: workflowStageDraftSchema },
    transitions: { type: 'array', maxItems: 160, items: workflowTransitionDraftSchema },
    mappings: { type: 'object', maxProperties: 40, propertyNames: { pattern: '^[a-z][a-z0-9_]{0,79}$' }, additionalProperties: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' } },
  },
};
const universityWorkflowApplyBodySchema = {
  ...universityWorkflowChangeBodySchema,
  required: [...universityWorkflowChangeBodySchema.required, 'previewToken'],
  properties: { ...universityWorkflowChangeBodySchema.properties, previewToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
};
const activityReassignmentPreviewInputSchema = {
  type: 'object', additionalProperties: false,
  required: ['targetKamSub', 'expectedOwnerSub', 'expectedAssignmentRevision'],
  properties: {
    targetKamSub: { type: 'string', minLength: 1, maxLength: 255 },
    expectedOwnerSub: { type: 'string', minLength: 1, maxLength: 255 },
    expectedAssignmentRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
  },
};
const activityReassignmentConfirmInputSchema = {
  type: 'object', additionalProperties: false, required: ['previewToken'],
  properties: { previewToken: uuidSchema },
};
const guidanceMetadataSchema = {
  type: 'object', required: ['source', 'version', 'reviewDate', 'projectStatus', 'statusLabel'],
  properties: {
    source: { type: 'string' }, version: { type: 'string' }, reviewDate: { type: 'string', format: 'date' },
    projectStatus: { type: 'string', enum: ['provisional'] }, statusLabel: { type: 'string' },
  },
};
const guidanceArticleSchema = {
  type: 'object', required: ['title', 'summary', 'focus', 'checks', 'boundary', 'draftMessage'],
  properties: {
    title: { type: 'string' }, summary: { type: 'string' }, focus: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } }, boundary: { type: 'string' }, draftMessage: { type: 'string' },
  },
};
const guidanceArticleContentSchema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'summary', 'focus', 'checks', 'boundary', 'draftMessage', 'recommendationWhenNoOpenTask'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 }, summary: { type: 'string', minLength: 1, maxLength: 500 },
    focus: { type: 'string', minLength: 1, maxLength: 500 }, checks: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 300 } },
    boundary: { type: 'string', minLength: 1, maxLength: 500 }, draftMessage: { type: 'string', minLength: 1, maxLength: 1000 },
    recommendationWhenNoOpenTask: { type: 'string', minLength: 1, maxLength: 300 },
  },
};
const guidanceDraftBodySchema = {
  type: 'object', additionalProperties: false, required: ['expectedRevision', 'article'],
  properties: { expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 }, article: guidanceArticleContentSchema },
};
const guidancePublishBodySchema = {
  type: 'object', additionalProperties: false, required: ['expectedDraftRevision'],
  properties: { expectedDraftRevision: { type: 'integer', minimum: 1, maximum: 2147483646 } },
};
const contextualTipSchema = {
  type: 'object', required: ['recommendationKey', 'recommendation', 'whyNow'],
  properties: { recommendationKey: { type: 'string' }, recommendation: { type: 'string' }, whyNow: { type: 'string' } },
};
const guidanceFeedbackSchema = {
  type: 'object', required: ['action', 'reason', 'deferredUntil', 'updatedAt', 'active'],
  properties: {
    action: { type: 'string', enum: ['defer', 'reject'] }, reason: { type: ['string', 'null'] },
    deferredUntil: { type: ['string', 'null'], format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }, active: { type: 'boolean' },
  },
};
const managerOverviewSchema = {
  type: 'object', required: ['asOf', 'metrics', 'byOwner', 'topProducts', 'pipeline', 'definitions'],
  properties: {
    asOf: { type: 'string', format: 'date-time' },
    metrics: {
      type: 'object', required: ['totalOpen', 'byKind', 'overdue', 'awaitingReply', 'noNextStep'],
      properties: {
        totalOpen: { type: 'integer', minimum: 0 },
        byKind: { type: 'object', required: ['university', 'corporate', 'individual'], properties: {
          university: { type: 'integer', minimum: 0 }, corporate: { type: 'integer', minimum: 0 }, individual: { type: 'integer', minimum: 0 },
        } },
        overdue: { type: 'integer', minimum: 0 }, awaitingReply: { type: 'integer', minimum: 0 }, noNextStep: { type: 'integer', minimum: 0 },
      },
    },
    byOwner: { type: 'array', items: { type: 'object', required: ['ownerSub', 'ownerName', 'open', 'overdue'], properties: {
      ownerSub: { type: 'string' }, ownerName: { type: 'string' }, open: { type: 'integer', minimum: 0 }, overdue: { type: 'integer', minimum: 0 },
    } } },
    topProducts: { type: 'array', items: { type: 'object', required: ['id', 'name', 'activityCount'], properties: {
      id: uuidSchema, name: { type: 'string' }, activityCount: { type: 'integer', minimum: 1 },
    } } },
    pipeline: { type: 'array', items: { type: 'object', required: ['kind', 'routeVersion', 'routeLabel', 'stages'], properties: {
      kind: { type: 'string', enum: ['university', 'corporate', 'individual'] }, routeVersion: { type: 'string', enum: ['current', 'legacy', 'v2'] }, routeLabel: { type: 'string' },
      stages: { type: 'array', items: { type: 'object', required: ['key', 'label', 'stageKeys', 'count', 'oldestUpdatedAt'], properties: {
        key: { type: 'string' }, label: { type: 'string' }, stageKeys: { type: 'array', items: { type: 'string' } }, count: { type: 'integer', minimum: 0 }, oldestUpdatedAt: { type: ['string', 'null'], format: 'date-time' },
      } } },
    } } },
    definitions: { type: 'object', required: ['totalOpen', 'byKind', 'overdue', 'awaitingReply', 'noNextStep', 'byOwner', 'topProducts', 'pipeline'], properties: {
      totalOpen: { type: 'string' }, byKind: { type: 'string' }, overdue: { type: 'string' }, awaitingReply: { type: 'string' },
      noNextStep: { type: 'string' }, byOwner: { type: 'string' }, topProducts: { type: 'string' }, pipeline: { type: 'string' },
    } },
  },
};
const activityPageSchema = {
  type: 'object', required: ['items', 'total', 'offset', 'limit'],
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    total: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
};
const universityStepUpdateSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'note', 'expectedRevision'],
  properties: {
    status: { type: 'string', enum: ['in_progress', 'waiting', 'documented', 'not_applicable'] },
    note: { type: 'string', maxLength: 1000 }, evidenceReference: { type: ['string', 'null'], maxLength: 500 },
    evidenceSource: { type: ['string', 'null'], maxLength: 160 }, expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
  },
};
const universityCorrectionReturnSchema = {
  type: 'object', additionalProperties: false, required: ['expectedU04Revision', 'expectedU05Revision', 'note'],
  properties: {
    expectedU04Revision: { type: 'integer', minimum: 0, maximum: 2147483646 }, expectedU05Revision: { type: 'integer', minimum: 0, maximum: 2147483646 },
    note: { type: 'string', maxLength: 1000 }, evidenceReference: { type: ['string', 'null'], maxLength: 500 },
    evidenceSource: { type: ['string', 'null'], maxLength: 160 },
  },
};
const corporatePlanInputSchema = {
  type: 'object', additionalProperties: false,
  required: ['expectedRevision', 'programMode', 'requestedPlaces', 'brief', 'methodologist', 'proposed', 'agreed', 'approval'],
  properties: {
    expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
    programMode: { type: 'string', enum: ['standard', 'adapted', 'new', 'undecided'] },
    requestedPlaces: { type: ['integer', 'null'], minimum: 0, maximum: 1000000 },
    brief: { type: 'object', additionalProperties: false, required: ['expectedOutcome', 'audience', 'entryLevel', 'deliveryFormat', 'volume', 'technologyContext'], properties: {
      expectedOutcome: { type: ['string', 'null'], maxLength: 1000 }, audience: { type: ['string', 'null'], maxLength: 500 },
      entryLevel: { type: ['string', 'null'], maxLength: 500 }, deliveryFormat: { type: ['string', 'null'], maxLength: 300 },
      volume: { type: ['string', 'null'], maxLength: 300 }, technologyContext: { type: ['string', 'null'], maxLength: 500 },
    } },
    methodologist: { type: 'object', additionalProperties: false, required: ['name', 'feasibility', 'note'], properties: {
      name: { type: ['string', 'null'], maxLength: 180 }, feasibility: { type: 'string', enum: ['unassessed', 'feasible', 'feasible_with_changes', 'not_feasible'] }, note: { type: ['string', 'null'], maxLength: 2000 },
    } },
    proposed: { type: 'object', additionalProperties: false, required: ['scope', 'startDate', 'endDate', 'acceptanceCriteria'], properties: {
      scope: { type: ['string', 'null'], maxLength: 2000 }, startDate: { type: ['string', 'null'], format: 'date' }, endDate: { type: ['string', 'null'], format: 'date' }, acceptanceCriteria: { type: ['string', 'null'], maxLength: 1500 },
    } },
    agreed: { type: 'object', additionalProperties: false, required: ['scope', 'startDate', 'endDate', 'acceptanceCriteria'], properties: {
      scope: { type: ['string', 'null'], maxLength: 2000 }, startDate: { type: ['string', 'null'], format: 'date' }, endDate: { type: ['string', 'null'], format: 'date' }, acceptanceCriteria: { type: ['string', 'null'], maxLength: 1500 },
    } },
    approval: { type: 'object', additionalProperties: false, required: ['status', 'evidenceReference', 'evidenceSource', 'note'], properties: {
      status: { type: 'string', enum: ['not_recorded', 'pending', 'approved', 'rejected'] }, evidenceReference: { type: ['string', 'null'], maxLength: 500 },
      evidenceSource: { type: ['string', 'null'], maxLength: 160 }, note: { type: ['string', 'null'], maxLength: 2000 },
    } },
  },
};
const activityContractLicenseFieldsSchema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'contractReference', 'contractStatus', 'licenseExpiryPrecision', 'licenseExpiresOn', 'licenseExpiresYear', 'documentId', 'note'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 160 }, contractReference: { type: ['string', 'null'], maxLength: 180 },
    contractStatus: { type: ['string', 'null'], enum: ['draft', 'signed', 'ended', 'unknown', null] },
    licenseExpiryPrecision: { type: ['string', 'null'], enum: ['exact_date', 'year', 'unknown', null] },
    licenseExpiresOn: { type: ['string', 'null'], format: 'date' }, licenseExpiresYear: { type: ['integer', 'null'], minimum: 1900, maximum: 9999 },
    documentId: { type: ['string', 'null'], format: 'uuid' }, note: { type: ['string', 'null'], maxLength: 1500 },
  },
};
const activityContractLicenseInputSchema = {
  ...activityContractLicenseFieldsSchema,
  required: [...activityContractLicenseFieldsSchema.required, 'expectedRevision'],
  properties: { ...activityContractLicenseFieldsSchema.properties, expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 } },
};
const activityContractLicenseResponseSchema = {
  ...activityContractLicenseFieldsSchema,
  required: [...activityContractLicenseFieldsSchema.required, 'id', 'activityId', 'documentName', 'revision', 'updatedAt', 'updatedBy', 'readOnly'],
  properties: { ...activityContractLicenseFieldsSchema.properties, id: uuidSchema, activityId: uuidSchema, documentName: { type: ['string', 'null'] }, revision: { type: 'integer', minimum: 1 }, updatedAt: { type: 'string', format: 'date-time' }, updatedBy: { type: 'string' }, readOnly: { type: 'boolean' } },
};
const { expectedRevision: _expectedRevision, ...corporatePlanResponseProperties } = corporatePlanInputSchema.properties;
const corporatePlanSchema = {
  ...corporatePlanInputSchema,
  required: ['revision', 'programMode', 'requestedPlaces', 'brief', 'methodologist', 'proposed', 'agreed', 'approval', 'updatedAt', 'updatedBy', 'readOnly'],
  properties: { ...corporatePlanResponseProperties, revision: { type: 'integer', minimum: 0 }, updatedAt: { type: ['string', 'null'], format: 'date-time' }, updatedBy: { type: ['string', 'null'] }, readOnly: { type: 'boolean' } },
};
const activityDocumentSchema = {
  type: 'object', required: ['id', 'activityId', 'name', 'extension', 'mediaType', 'sizeBytes', 'sha256', 'uploadedAt', 'uploadedByName'],
  properties: {
    id: uuidSchema, activityId: uuidSchema, name: { type: 'string' }, extension: { type: 'string' }, mediaType: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 1, maximum: MAX_ACTIVITY_DOCUMENT_BYTES }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    uploadedAt: { type: 'string', format: 'date-time' }, uploadedByName: { type: 'string' },
  },
};
const publicArticle = (entry: ReturnType<typeof findStageArticle>): StageArticle | null => entry && ({
  title: entry.title, summary: entry.summary, focus: entry.focus, checks: entry.checks, boundary: entry.boundary, draftMessage: entry.draftMessage,
});
const publicFeedback = (feedback: GuidanceFeedback | null) => feedback && ({
  ...feedback,
  active: feedback.action === 'reject' || Boolean(feedback.deferredUntil && Date.parse(feedback.deferredUntil) > Date.now()),
});

const fullArticle = (entry: StageGuidanceEntry | GuidanceArticleContent): GuidanceArticleContent => ({
  title: entry.title, summary: entry.summary, focus: entry.focus, checks: [...entry.checks], boundary: entry.boundary,
  draftMessage: entry.draftMessage, recommendationWhenNoOpenTask: entry.recommendationWhenNoOpenTask,
});

function resolveStageArticle(stage: Record<string, any>, record: GuidanceEditorialRecord | undefined, fallback: StageGuidanceEntry | null) {
  if (record?.publishedArticle) {
    if (!guidanceSnapshotMatches(record.publishedStageSnapshot, stage)) return { article: null, state: 'stale' as const };
    return { article: record.publishedArticle as StageGuidanceEntry, state: 'published' as const };
  }
  if (record && !guidanceSnapshotMatches(record.seedStageSnapshot, stage)) return { article: null, state: 'stale' as const };
  if (fallback && (!record ? fallback.title === stage.label : true)) {
    return { article: fallback, state: record?.draftArticle ? 'draft' as const : 'seed' as const };
  }
  if (fallback) return { article: null, state: 'stale' as const };
  return { article: null, state: 'missing' as const };
}

async function currentActivityGuidance(repository: CrmRepository, actor: Actor, id: string) {
  const activity = await repository.getActivity(actor, id);
  if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
  const catalog = await repository.getGuidanceCatalog();
  const workflow = catalog.workflow;
  const stage = workflow.find((candidate) => candidate.kind === activity.kind && candidate.key === activity.stageKey) as
    { kind: string; key: string; label: string; terminal: boolean } | undefined;
  const record = catalog.articles.find((row) => row.kind === stage?.kind && row.stageKey === stage?.key);
  const resolved = stage && resolveStageArticle(stage, record, findStageArticle(stage.kind, stage.key));
  const entry = resolved?.article ?? null;
  if (!stage || !entry) throw new DomainError(409, 'guidance_unavailable', 'Для текущей стадии пока нет актуальной проектной инструкции.');
  const tasks = Array.isArray(activity.tasks) ? activity.tasks as GuidanceTask[] : [];
  return {
    kind: stage.kind, stageKey: stage.key, stageLabel: stage.label, metadata: guidanceMetadata,
    article: publicArticle(entry)!, tip: makeContextualTip(stage, tasks, entry, stage.kind, stage.key),
  };
}

async function guidanceHandbookResponse(repository: CrmRepository, actor: Actor) {
  const catalog = await repository.getGuidanceCatalog();
  const workflow = catalog.workflow as Record<string, any>[];
  const records = catalog.articles;
  const byId = new Map(records.map((record) => [`${record.kind}:${record.stageKey}`, record]));
  const stagesById = new Map(workflow.map((stage) => [`${stage.kind}:${stage.key}`, stage]));
  const ids = new Set<string>([...byId.keys(), ...stagesById.keys()]);
  for (const [kind, articles] of Object.entries(stageArticles)) for (const stageKey of Object.keys(articles)) ids.add(`${kind}:${stageKey}`);
  const canReviewDrafts = actor.roles.includes('manager') || actor.roles.includes('admin');
  const items = [...ids].map((id) => {
    const [kind, stageKey] = id.split(':');
    const record = byId.get(id);
    const stage = stagesById.get(id);
    const fallback = findStageArticle(kind, stageKey);
    const resolved = stage ? resolveStageArticle(stage, record, fallback) : { article: null, state: 'stale' as const };
    const initialDraft = record?.draftArticle ?? record?.publishedArticle ?? (fallback ? fullArticle(fallback) : null);
    return {
      id, kind, stageKey, stageLabel: stage?.label ?? fallback?.title ?? stageKey, stageOrdinal: stage?.ordinal ?? null, current: Boolean(stage), state: resolved.state,
      staleReason: stage ? (resolved.state === 'stale' ? 'stage_changed' : null) : 'stage_deleted',
      article: stage && resolved.article ? fullArticle(resolved.article) : null,
      ...(canReviewDrafts ? { draftArticle: initialDraft, draftRevision: record?.draftRevision ?? 0,
        publishedRevision: record?.publishedRevision ?? null, publishedAt: record?.publishedAt ?? null, publishedByName: record?.publishedByName ?? null,
        draftStageCurrent: Boolean(stage && (!record?.draftStageSnapshot || guidanceSnapshotMatches(record.draftStageSnapshot, stage))) } : {}),
    };
  });
  items.sort((left, right) => left.kind.localeCompare(right.kind) || (left.stageOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.stageOrdinal ?? Number.MAX_SAFE_INTEGER) || left.stageLabel.localeCompare(right.stageLabel, 'ru') || left.stageKey.localeCompare(right.stageKey));
  return { metadata: guidanceMetadata, items };
}
const openApi = {
  openapi: '3.1.0',
  info: { title: 'RTK CRM B12 API', version: '0.12.0', description: 'Локальный CRM-срез с явно маркированными HTTP mock-сервисами CMS и LMS. Все API операции защищены Keycloak OIDC.' },
  servers: [{ url: '/', description: 'Текущий адрес CRM API' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      NewActivity: { type: 'object', additionalProperties: false, required: ['kind', 'title'], properties: { kind: { enum: ['university', 'individual', 'corporate'] }, title: { type: 'string' }, origin: { type: 'string', enum: ['manual'], default: 'manual', description: 'Обычный POST создаёт только ручные активности. Готовые внешние заявки создаются после проверки через импорт.' }, originSource: { type: 'string', maxLength: 160, description: 'Не принимается при POST /api/activities; происхождение фиксируется только импортом.' }, originReference: { type: 'string', maxLength: 240, description: 'Не принимается при POST /api/activities; внешний ключ сохраняется только импортом.' }, organizationId: { type: 'string', format: 'uuid' }, organizationName: { type: 'string' }, personId: { type: 'string', format: 'uuid' }, personName: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, payerOrganizationId: { type: 'string', format: 'uuid' }, payerOrganizationName: { type: 'string' }, productIds: { type: 'array', items: { type: 'string', format: 'uuid' } }, programIds: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', format: 'uuid' }, description: 'Независимые учебные программы, выбранные при создании.' }, priority: { type: 'integer', minimum: 1, maximum: 5 } }, not: { anyOf: [{ required: ['originSource'] }, { required: ['originReference'] }] } },
      ActivityDetailsUpdate: { type: 'object', additionalProperties: false, required: ['productIds', 'priority', 'expectedRevision'], oneOf: [{ required: ['personId'], not: { required: ['newPerson'] } }, { required: ['newPerson'], not: { required: ['personId'] } }], properties: { personId: { type: ['string', 'null'], format: 'uuid' }, newPerson: { type: 'object', additionalProperties: false, required: ['fullName'], properties: { fullName: { type: 'string', minLength: 1, maxLength: 180 }, email: { type: 'string', maxLength: 254 }, phone: { type: 'string', maxLength: 64 } } }, productIds: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', format: 'uuid' } }, programIds: { type: 'array', maxItems: 50, uniqueItems: true, items: uuidSchema, description: 'Опционально заменяет независимые learning-program associations этой активности.' }, priority: { type: 'integer', minimum: 1, maximum: 5 }, expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 } }, description: 'Контакт и продукты заменяются целиком. Если передан programIds, связи с учебными программами также заменяются целиком. Стадия и организации не меняются.' },
      ActivityRouteState: { type: 'object', required: ['routeVersion', 'workflowRevision', 'allowedNext'], properties: { routeVersion: { type: 'string', enum: ['legacy', 'v2'], description: 'Серверная версия маршрута, не выбирается клиентом.' }, workflowRevision: { type: ['integer', 'null'], minimum: 1, description: 'Ревизия общей схемы, заполнена для вузовской активности.' }, allowedNext: { type: 'array', items: { type: 'string' }, description: 'Переходы, разрешённые для текущей стадии и версии маршрута этой активности.' } } },
      IndividualLearningFact: { type: 'object', required: ['id', 'factKind', 'source', 'occurredAt', 'reference'], properties: { id: uuidSchema, factKind: { type: 'string', enum: ['enrollment', 'learning_started', 'learning_completed'] }, source: { type: 'string' }, occurredAt: { type: 'string', format: 'date-time' }, reference: { type: 'string' } }, description: 'Read-only LMS projection. CRM stores no lesson, score, certificate, or copied learner progress.' },
      NewTask: { type: 'object', required: ['title', 'dueAt'], properties: { title: { type: 'string' }, dueAt: { type: 'string', format: 'date-time' } } },
      ActivityFeedItem: { type: 'object', required: ['id', 'activityId', 'activityTitle', 'kind', 'eventType', 'summary', 'actorSub', 'actorName', 'createdAt'], properties: {
        id: uuidSchema, activityId: uuidSchema, activityTitle: { type: 'string' }, kind: { type: 'string', enum: ['university', 'individual', 'corporate'] },
        eventType: { type: 'string' }, summary: { type: 'string' }, actorSub: { type: 'string' }, actorName: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' }, taskId: { type: 'string', format: 'uuid' }, text: { type: 'string', maxLength: 2000, description: 'Полный текст события task_updated.' },
      } },
      ActivityFeedPage: { type: 'object', required: ['items', 'nextCursor'], properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/ActivityFeedItem' } }, nextCursor: { type: ['string', 'null'] },
      } },
      ActivityNotification: { type: 'object', required: ['id', 'activityId', 'activityTitle', 'taskId', 'eventType', 'summary', 'actorName', 'createdAt', 'readAt'], properties: {
        id: uuidSchema, activityId: uuidSchema, activityTitle: { type: 'string' }, taskId: uuidSchema, eventType: { type: 'string' },
        summary: { type: 'string' }, text: { type: 'string', maxLength: 2000, description: 'Полный текст события task_updated.' }, actorName: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, readAt: { type: ['string', 'null'], format: 'date-time' },
      } },
      ActivityNotificationPage: { type: 'object', required: ['items', 'nextCursor', 'unreadCount'], properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/ActivityNotification' } }, nextCursor: { type: ['string', 'null'] }, unreadCount: { type: 'integer', minimum: 0 },
      } },
      TaskSubscription: { type: 'object', required: ['subscribed'], properties: { subscribed: { type: 'boolean' } } },
      TaskUpdate: { type: 'object', required: ['id', 'activityId', 'taskId', 'eventType', 'summary', 'actorSub', 'actorName', 'createdAt'], properties: {
        id: uuidSchema, activityId: uuidSchema, taskId: uuidSchema, eventType: { type: 'string', const: 'task_updated' }, summary: { type: 'string' }, text: { type: 'string', maxLength: 2000 },
        actorSub: { type: 'string' }, actorName: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
      } },
      AssignableKam: { type: 'object', additionalProperties: false, required: ['sub', 'name'], properties: { sub: { type: 'string' }, name: { type: 'string' } } },
      ActivityReassignmentPreviewInput: activityReassignmentPreviewInputSchema,
      ActivityReassignmentConfirmInput: activityReassignmentConfirmInputSchema,
      ActivityReassignmentPreview: { type: 'object', required: ['activityId','title','kind','currentOwner','targetOwner','assignmentRevision','updatedAt','canConfirm','previewToken','blockers','impact'], properties: {
        activityId: uuidSchema, title: { type: 'string' }, kind: { type: 'string', enum: ['university','individual','corporate'] },
        currentOwner: { $ref: '#/components/schemas/AssignableKam' }, targetOwner: { $ref: '#/components/schemas/AssignableKam' },
        assignmentRevision: { type: 'integer', minimum: 0 }, updatedAt: { type: 'string', format: 'date-time' },
        canConfirm: { type: 'boolean' }, previewToken: { type: ['string','null'], format: 'uuid' },
        blockers: { type: 'array', items: { type: 'object', required: ['code','message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } },
        impact: { type: 'object', required: ['stageKey','stageLabel','closed','awaitingReply','createdAt','historyEventCount','taskCount','openTaskCount','nextOpenTaskDueAt','openTasksWillTransfer','completedTaskAttributionWillRemain'], properties: {
          stageKey: { type: 'string' }, stageLabel: { type: 'string' }, closed: { type: 'boolean' }, awaitingReply: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' }, historyEventCount: { type: 'integer' }, taskCount: { type: 'integer' }, openTaskCount: { type: 'integer' },
          nextOpenTaskDueAt: { type: ['string','null'], format: 'date-time' }, openTasksWillTransfer: { type: 'boolean' }, completedTaskAttributionWillRemain: { type: 'boolean' },
        } },
      } },
      ActivityReassignmentResult: { type: 'object', required: ['activityId','previousOwner','owner','assignmentRevision','updatedAt','openTasksReassigned','completedTasksPreserved','eventId'], properties: {
        activityId: uuidSchema, previousOwner: { $ref: '#/components/schemas/AssignableKam' }, owner: { $ref: '#/components/schemas/AssignableKam' },
        assignmentRevision: { type: 'integer', minimum: 1 }, updatedAt: { type: 'string', format: 'date-time' },
        openTasksReassigned: { type: 'integer' }, completedTasksPreserved: { type: 'integer' }, eventId: uuidSchema,
      } },
      Outcome: { type: 'object', required: ['outcome', 'note'], properties: { outcome: { enum: ['connected', 'no_answer', 'meeting_booked', 'awaiting_reply', 'not_interested', 'other', 'cancelled', 'refused'] }, note: { type: 'string', description: 'Причина обязательна для отмены и отказа.' } } },
      StageTransition: { type: 'object', additionalProperties: false, required: ['targetStage', 'expectedStageKey', 'expectedWorkflowRevision'], properties: {
        targetStage: { type: 'string' }, expectedStageKey: { type: 'string' }, expectedWorkflowRevision: { type: ['integer', 'null'], minimum: 1 },
      } },
      WorkflowStageDraft: workflowStageDraftSchema,
      WorkflowTransitionDraft: workflowTransitionDraftSchema,
      UniversityWorkflowConfiguration: { type: 'object', required: ['kind', 'revision', 'stages', 'transitions'], properties: {
        kind: { type: 'string', const: 'university' }, revision: { type: 'integer', minimum: 1 },
        stages: { type: 'array', items: { $ref: '#/components/schemas/WorkflowStageDraft' } },
        transitions: { type: 'array', items: { $ref: '#/components/schemas/WorkflowTransitionDraft' } },
      } },
      UniversityWorkflowChangeInput: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'stages', 'transitions', 'mappings'], properties: {
        expectedRevision: { type: 'integer', minimum: 1 }, stages: { type: 'array', minItems: 2, maxItems: 40, items: { $ref: '#/components/schemas/WorkflowStageDraft' } },
        transitions: { type: 'array', maxItems: 160, items: { $ref: '#/components/schemas/WorkflowTransitionDraft' } },
        mappings: { type: 'object', maxProperties: 40, additionalProperties: { type: 'string' }, description: 'Явное соответствие каждого удаляемого stage key с сохранённым непосредственным соседом.' },
      } },
      UniversityWorkflowApplyInput: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'stages', 'transitions', 'mappings', 'previewToken'], properties: {
        expectedRevision: { type: 'integer', minimum: 1 }, stages: { type: 'array', minItems: 2, maxItems: 40, items: { $ref: '#/components/schemas/WorkflowStageDraft' } },
        transitions: { type: 'array', maxItems: 160, items: { $ref: '#/components/schemas/WorkflowTransitionDraft' } },
        mappings: { type: 'object', maxProperties: 40, additionalProperties: { type: 'string' } }, previewToken: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      } },
      UniversityWorkflowActivityImpact: { type: 'object', required: ['id', 'title', 'ownerName', 'stageKey', 'stageLabel', 'targetStageKey', 'targetStageLabel', 'closed', 'changeRequired'], properties: {
        id: uuidSchema, title: { type: ['string','null'] }, ownerName: { type: ['string','null'] }, stageKey: { type: 'string' }, stageLabel: { type: 'string' },
        targetStageKey: { type: ['string', 'null'] }, targetStageLabel: { type: ['string', 'null'] }, closed: { type: 'boolean' }, changeRequired: { type: 'boolean' },
      } },
      UniversityWorkflowPreview: { type: 'object', required: ['kind', 'revision', 'previewToken', 'canApply', 'stages', 'transitions', 'mappings', 'validReplacementKeys', 'impactedActivities', 'counts', 'blockers'], properties: {
        kind: { type: 'string', const: 'university' }, revision: { type: 'integer' }, previewToken: { type: 'string' }, canApply: { type: 'boolean' },
        stages: { type: 'array', items: { $ref: '#/components/schemas/WorkflowStageDraft' } }, transitions: { type: 'array', items: { $ref: '#/components/schemas/WorkflowTransitionDraft' } },
        mappings: { type: 'object', additionalProperties: { type: 'string' } }, validReplacementKeys: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
        impactedActivities: { type: 'array', items: { $ref: '#/components/schemas/UniversityWorkflowActivityImpact' } },
        counts: { type: 'object', required: ['total', 'open', 'closed', 'changedOpen', 'changedClosed'], properties: {
          total: { type: 'integer' }, open: { type: 'integer' }, closed: { type: 'integer' }, changedOpen: { type: 'integer' }, changedClosed: { type: 'integer' },
        } }, blockers: { type: 'array', items: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, stageKey: { type: 'string' }, activityId: uuidSchema, targetStageKey: { type: 'string' }, validReplacementKeys: { type: 'array', items: { type: 'string' } } } } },
      } },
      UniversityWorkflowApplyResult: { type: 'object', required: ['kind', 'revision', 'migratedCount', 'preservedClosedCount', 'changedActivities'], properties: {
        kind: { type: 'string', const: 'university' }, revision: { type: 'integer' }, migratedCount: { type: 'integer', minimum: 0 }, preservedClosedCount: { type: 'integer', minimum: 0 },
        changedActivities: { type: 'array', items: { type: 'object', required: ['id', 'title', 'stageKey', 'stageLabel', 'closed'], properties: { id: uuidSchema, title: { type: ['string','null'] }, stageKey: { type: 'string' }, stageLabel: { type: 'string' }, closed: { type: 'boolean' } } } },
      } },
      GuidanceMetadata: guidanceMetadataSchema,
      GuidanceArticle: guidanceArticleSchema,
      GuidanceTip: contextualTipSchema,
      GuidanceFeedback: guidanceFeedbackSchema,
      ManagerOverview: managerOverviewSchema,
      ActivityPage: activityPageSchema,
      UniversityStepUpdate: universityStepUpdateSchema,
      UniversityCorrectionReturn: universityCorrectionReturnSchema,
      CorporatePlan: corporatePlanSchema,
      CorporatePlanInput: corporatePlanInputSchema,
      ActivityDocument: activityDocumentSchema,
      ActivityContractLicense: activityContractLicenseResponseSchema,
      ActivityContractLicenseInput: activityContractLicenseInputSchema,
      UniversityStep: {
        type: 'object', required: ['stepId', 'label', 'description', 'groupKey', 'groupLabel', 'ordinal', 'optional', 'status', 'note', 'evidenceReference', 'evidenceSource', 'actorSub', 'actorName', 'updatedAt', 'revision'],
        properties: {
          stepId: { type: 'string', pattern: '^U(0[1-9]|1[0-3])$' }, label: { type: 'string' }, description: { type: 'string' },
          groupKey: { type: 'string' }, groupLabel: { type: 'string' }, ordinal: { type: 'integer' }, optional: { type: 'boolean' },
          status: { type: 'string', enum: ['unrecorded', 'in_progress', 'waiting', 'documented', 'not_applicable'], description: 'documented означает только запись координации в CRM, не подтверждение внешнего, юридического или учебного факта.' }, note: { type: 'string' },
          evidenceReference: { type: ['string', 'null'] }, evidenceSource: { type: ['string', 'null'] }, actorSub: { type: ['string', 'null'] }, actorName: { type: ['string', 'null'] },
          updatedAt: { type: ['string', 'null'], format: 'date-time' }, revision: { type: 'integer', minimum: 0 },
        },
      },
      UniversitySteps: {
        type: 'object', required: ['steps', 'overview', 'readOnly'],
        properties: {
          steps: { type: 'array', minItems: 13, maxItems: 13, items: { $ref: '#/components/schemas/UniversityStep' } },
          overview: { type: 'object', required: ['statusCounts', 'openTaskCount', 'openTasks', 'latestEvent'], properties: {
            statusCounts: { type: 'object', required: ['unrecorded', 'in_progress', 'waiting', 'documented', 'not_applicable'], properties: {
              unrecorded: { type: 'integer', minimum: 0 }, in_progress: { type: 'integer', minimum: 0 }, waiting: { type: 'integer', minimum: 0 }, documented: { type: 'integer', minimum: 0 }, not_applicable: { type: 'integer', minimum: 0 },
            } },
            openTaskCount: { type: 'integer', minimum: 0 }, openTasks: { type: 'array', items: { type: 'object', required: ['id', 'title', 'dueAt', 'ownerName'], properties: { id: uuidSchema, title: { type: 'string' }, dueAt: { type: 'string', format: 'date-time' }, ownerName: { type: 'string' } } } },
            latestEvent: { oneOf: [{ type: 'object', required: ['id', 'eventType', 'summary', 'actorName', 'createdAt'], properties: { id: uuidSchema, eventType: { type: 'string' }, summary: { type: 'string' }, actorName: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } } }, { type: 'null' }] },
          } },
          readOnly: { type: 'boolean' },
        },
      },
      StageGuidance: {
        type: 'object', required: ['kind', 'stageKey', 'stageLabel', 'metadata', 'article'],
        properties: {
          kind: { type: 'string', enum: ['university', 'individual', 'corporate'] }, stageKey: { type: 'string' },
          stageLabel: { type: 'string' }, metadata: { $ref: '#/components/schemas/GuidanceMetadata' },
          article: { $ref: '#/components/schemas/GuidanceArticle' },
        },
      },
      ActivityGuidance: {
        type: 'object', required: ['kind', 'stageKey', 'stageLabel', 'metadata', 'article', 'tip', 'feedback'],
        properties: {
          kind: { type: 'string', enum: ['university', 'individual', 'corporate'] }, stageKey: { type: 'string' },
          stageLabel: { type: 'string' }, metadata: { $ref: '#/components/schemas/GuidanceMetadata' },
          article: { $ref: '#/components/schemas/GuidanceArticle' }, tip: { $ref: '#/components/schemas/GuidanceTip' },
          feedback: { oneOf: [{ $ref: '#/components/schemas/GuidanceFeedback' }, { type: 'null' }] },
        },
      },
      ImportTarget: { type: 'string', enum: ['contacts', 'vendors', 'individual_applications'], description: 'contacts: User Uploads; vendors: Vendors + product associations; individual_applications: JSON or CSV applications. External application payment remains unknown and no enrollment is created.' },
      ImportColumnMapping: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'Ключ — индекс исходной колонки; значение — поле целевой записи или null.' },
      ImportUploadResponse: { type: 'object', required: ['id','revision','target','sourceSystem','fileName','fileFormat','sheets','createdAt','expiresAt'], properties: {
        id: uuidSchema, revision: { type: 'integer', minimum: 1 }, target: { $ref: '#/components/schemas/ImportTarget' }, sourceSystem: { type: 'string' },
        fileName: { type: 'string' }, fileFormat: { type: 'string', enum: ['xls','xlsx','json','csv'] }, createdAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' },
        sheets: { type: 'array', items: { type: 'object', required: ['name','rowCount','firstRow','samples'], properties: { name: { type: 'string' }, rowCount: { type: 'integer', minimum: 0 }, firstRow: { type: 'integer', minimum: 1 }, samples: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } },
      } },
      ImportHeaderResponse: { type: 'object', required: ['sheet','row','values'], properties: { sheet: { type: 'string' }, row: { type: 'integer', minimum: 1 }, values: { type: 'array', items: { type: 'string' } } } },
      ImportPreviewRow: { type: 'object', required: ['rowNumber','sourceValues','values','status','errors','warnings','matches','externalKey'], properties: {
        rowNumber: { type: 'integer', minimum: 1 }, sourceValues: { type: 'array', items: { type: ['string','null'] } }, values: { type: 'object', additionalProperties: { type: ['string','null'] } },
        status: { type: 'string', enum: ['valid','invalid','unchanged','changed_requires_review','possible_duplicate','blocked','duplicate_in_file','skipped_null'] },
        errors: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } },
        matches: { type: 'array', items: { type: 'object', required: ['entityId','name','reasons'], properties: { entityId: uuidSchema, name: { type: 'string' }, email: { type: ['string','null'] }, phone: { type: ['string','null'] }, reasons: { type: 'array', items: { type: 'string' } } } } },
        externalKey: { type: ['string','null'] },
      } },
      ImportJobResponse: { type: 'object', required: ['id','revision','target','sourceSystem','fileName','fileFormat','status','selectedSheet','headerRow','rawHeadings','mapping','expiresAt','sheets','preview','result'], properties: {
        id: uuidSchema, revision: { type: 'integer', minimum: 1 }, target: { $ref: '#/components/schemas/ImportTarget' }, sourceSystem: { type: 'string' }, fileName: { type: 'string' }, fileFormat: { type: 'string' },
        status: { type: 'string', enum: ['uploaded','preview_ready','completed','expired'] }, selectedSheet: { type: ['string','null'] }, headerRow: { type: ['integer','null'] },
        rawHeadings: { type: 'array', items: { type: 'string' } }, mapping: { $ref: '#/components/schemas/ImportColumnMapping' }, expiresAt: { type: 'string', format: 'date-time' },
        sheets: { type: 'array', items: { type: 'object', required: ['name','rowCount','firstRow','samples'], properties: { name: { type: 'string' }, rowCount: { type: 'integer', minimum: 0 }, firstRow: { type: 'integer', minimum: 1 }, samples: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } },
        preview: { type: 'array', items: { $ref: '#/components/schemas/ImportPreviewRow' } },
        result: { oneOf: [{ $ref: '#/components/schemas/ImportConfirmationResult' }, { type: 'null' }] },
      } },
      ImportPreviewInput: { type: 'object', additionalProperties: false, required: ['revision','selectedSheet','headerRow','mapping'], properties: {
        revision: { type: 'integer', minimum: 1 }, selectedSheet: { type: 'string', maxLength: 120 }, headerRow: { type: 'integer', minimum: 1 }, mapping: { $ref: '#/components/schemas/ImportColumnMapping' },
      } },
      ImportConfirmationInput: { type: 'object', additionalProperties: false, required: ['revision','idempotencyKey','rowNumbers','reviewedRows'], properties: {
        revision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
        rowNumbers: { type: 'array', maxItems: 2000, items: { type: 'integer', minimum: 1 } }, reviewedRows: { type: 'array', maxItems: 2000, items: { type: 'integer', minimum: 1 }, description: 'Строки с возможным совпадением или изменением источника, отдельно проверенные пользователем.' },
      } },
      ImportRowResult: { type: 'object', required: ['rowNumber','status'], properties: {
        rowNumber: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['created','updated','unchanged','skipped','conflict','failed'] },
        entityId: { type: 'string', format: 'uuid' }, reason: { type: 'string' },
      } },
      ImportConfirmationResult: { type: 'object', required: ['id','revision','confirmationId','createdAt','rowResults','counts'], properties: {
        id: uuidSchema, revision: { type: 'integer' }, confirmationId: uuidSchema, createdAt: { type: 'string', format: 'date-time' },
        rowResults: { type: 'array', items: { $ref: '#/components/schemas/ImportRowResult' } }, counts: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      } },
      ExchangeJob: { type: 'object', required: ['id','direction','system','operation','activityId','correlationId','idempotencyKey','status','attemptCount','payload','createdAt','updatedAt'], properties: {
        id: uuidSchema, direction: { type: 'string', enum: ['cms_to_crm','crm_to_cms','crm_to_lms','lms_to_crm'] }, system: { type: 'string', enum: ['cms','lms'] }, operation: { type: 'string' },
        activityId: { type: ['string','null'], format: 'uuid' }, correlationId: uuidSchema, idempotencyKey: { type: 'string' }, externalEventId: { type: ['string','null'] },
        status: { type: 'string', enum: ['queued','sent','accepted','performed','rejected','retryable_error'] }, attemptCount: { type: 'integer', minimum: 0, maximum: 3 },
        payload: { type: 'object' }, response: { type: ['object','null'] }, lastError: { type: ['string','null'] }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
      } },
      TechnicalExchangeJob: { type: 'object', required: ['id','direction','system','operation','status','attemptCount','createdAt','updatedAt','activityLinked','error','canRetry'], properties: {
        id: uuidSchema, direction: { type: 'string', enum: ['cms_to_crm','crm_to_cms','crm_to_lms','lms_to_crm'] }, system: { type: 'string', enum: ['cms','lms'] }, operation: { type: 'string' },
        status: { type: 'string', enum: ['queued','sent','accepted','performed','rejected','retryable_error'] }, attemptCount: { type: 'integer', minimum: 0, maximum: 3 },
        createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }, activityLinked: { type: 'boolean' }, error: { type: 'boolean' }, canRetry: { type: 'boolean' }, summary: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      } },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/api/feed': { get: {
      summary: 'Общая лента событий в текущей области доступа',
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
        { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 512 } },
        { name: 'actorSub', in: 'query', description: 'Только руководитель; КАМ всегда видит собственные события.', schema: { type: 'string', maxLength: 255 } },
      ],
      responses: { '200': { description: 'События в обратном порядке времени с курсором следующей страницы', content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityFeedPage' } } } }, '400': { description: 'Некорректные параметры страницы' }, '403': { description: 'КАМ не может фильтровать ленту по автору' } },
    } },
    '/api/notifications': { get: {
      summary: 'Уведомления по отслеживаемым действиям в текущей области доступа',
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
        { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 512 } },
      ],
      responses: { '200': { description: 'Страница уведомлений и число непрочитанных в текущей области', content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityNotificationPage' } } } }, '400': { description: 'Некорректные параметры страницы' } },
    } },
    '/api/notifications/{id}/read': { post: {
      summary: 'Отметить доступное уведомление прочитанным',
      parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }],
      responses: { '200': { description: 'Идентификатор и время чтения', content: { 'application/json': { schema: { type: 'object', required: ['id', 'readAt'], properties: { id: uuidSchema, readAt: { type: 'string', format: 'date-time' } } } } } }, '404': { description: 'Уведомление недоступно' } },
    } },
    '/api/activities': {
      get: { summary: 'Рабочая очередь с точным числом результатов и страницами', parameters: [
        { name: 'segment', in: 'query', schema: { enum: ['all', 'university', 'company', 'individual'] } },
        { name: 'collection', in: 'query', description: 'Для today используется календарный день Europe/Moscow.', schema: { enum: ['today', 'overdue', 'awaiting_reply', 'no_next_step', 'all'] } },
        { name: 'ownerSub', in: 'query', description: 'Только руководитель', schema: { type: 'string' } },
        { name: 'productId', in: 'query', schema: uuidSchema },
        { name: 'q', in: 'query', description: 'Поиск по названию активности, организации и контакту', schema: { type: 'string', maxLength: 120 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      ], responses: { '200': { description: 'Страница записей и точное число всех соответствующих записей', content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityPage' } } } }, '403': { description: 'Для бизнес-данных нужна роль КАМ или руководителя' } } },
      post: { summary: 'Создать ручную активность', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewActivity' } } } }, responses: { '201': { description: 'Создана ручная активность на начальной стадии серверного маршрута' }, '400': { description: 'Внешний origin или метаданные доступны только через проверенный импорт' } } },
    },
    '/api/programs': {
      get: { summary: 'Каталог учебных программ с видимым числом связанных активностей', responses: { '200': { description: 'Список каталога; demandCount ограничен областью доступа пользователя' }, '403': { description: 'Нужна роль КАМ, руководителя или администратора' } } },
      post: { summary: 'Добавить программу в независимый каталог обучения', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 180 } } } } } }, responses: { '201': { description: 'Программа создана' }, '409': { description: 'Название уже используется' } } },
    },
    '/api/programs/{id}/priority': { put: { summary: 'Изменить ручной приоритет программы с проверкой ревизии', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['priority','expectedRevision'], properties: { priority: { type: 'integer', minimum: 1, maximum: 5 }, expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 } } } } } }, responses: { '200': { description: 'Приоритет сохранён' }, '404': { description: 'Программа не найдена' }, '409': { description: 'Ревизия каталога устарела' } } } },
    '/api/catalog': { get: { summary: 'Доступные организации и общий каталог продуктов', responses: { '200': { description: 'Каталог, ограниченный областью КАМ или команды' }, '403': { description: 'Нужна бизнес-роль КАМ или руководителя' } } } },
    '/api/manager/overview': { get: { summary: 'Срез портфеля открытых активностей команды', description: 'Только для руководителя; техническая роль администратора сама по себе не открывает бизнес-аналитику. Показатели описывают CRM-активности и задачи, не продажи, обучение или платежи.', responses: {
      '200': { description: 'Метрики открытых CRM-активностей на дату asOf', content: { 'application/json': { schema: { $ref: '#/components/schemas/ManagerOverview' } } } },
      '401': { description: 'Требуется действующий вход' }, '403': { description: 'Нужна роль руководителя' },
    } } },
    '/api/activities/{id}': { get: { summary: 'Карточка активности с проверкой области КАМ', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Карточка содержит ревизию основных сведений, ссылки на продукты и учебные программы, серверный routeVersion, workflowRevision и allowedNext', content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/ActivityRouteState' }], description: 'Полная карточка активности; routeVersion, workflowRevision, revision, productIds, programIds, programNames и allowedNext входят в остальные поля карточки.' } } } }, '404': { description: 'Не найдена или недоступна' } } } },
    '/api/activities/{id}/details': { put: { summary: 'Изменить контакт, продукты, опциональные учебные программы и приоритет активности без смены стадии', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityDetailsUpdate' } } } }, responses: { '200': { description: 'Сведения сохранены; при newPerson контакт создан как запись Person, revision увеличена' }, '400': { description: 'Некорректные сведения, одновременно заданы personId и newPerson либо нельзя очистить обязательный контакт физлица' }, '404': { description: 'Активность, контакт, продукт или учебная программа не найдены либо недоступны' }, '409': { description: 'Сведения уже изменились или активность закрыта' } } } },
    '/api/guidance/{kind}/{stageKey}': {
      get: {
        summary: 'Инструкция для существующей стадии рабочего процесса',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['university', 'individual', 'corporate'] } },
          { name: 'stageKey', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Проектная инструкция для актуальной стадии', content: { 'application/json': { schema: { $ref: '#/components/schemas/StageGuidance' } } } },
          '400': { description: 'Некорректный тип или параметр пути' }, '404': { description: 'Тип или стадия отсутствует в текущем workflow' }, '409': { description: 'Для текущей стадии пока нет актуальной инструкции' },
        },
      },
    },
    '/api/guidance/handbook': {
      get: {
        summary: 'Поиск по единому справочнику инструкций для всех типов стадий',
        responses: {
          '200': { description: 'Локальные инструкции с отметкой актуальности относительно текущих схем' },
          '403': { description: 'Нужна роль КАМ или руководителя' },
        },
      },
    },
    '/api/admin/guidance/handbook': {
      get: { summary: 'Редакционный справочник для публикации администратором', responses: { '200': { description: 'Инструкции, ревизии черновиков и состояние привязок' }, '403': { description: 'Нужна роль администратора' } } },
    },
    '/api/guidance/{kind}/{stageKey}/draft': {
      put: {
        summary: 'Сохранить редакционный черновик инструкции руководителем',
        parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['university', 'individual', 'corporate'] } }, { name: 'stageKey', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: guidanceDraftBodySchema } } },
        responses: { '200': { description: 'Черновик сохранён с новой ревизией' }, '403': { description: 'Нужна роль руководителя' }, '409': { description: 'Стадия или ревизия черновика изменилась' } },
      },
    },
    '/api/admin/guidance/{kind}/{stageKey}/publish': {
      post: {
        summary: 'Привязать и опубликовать черновик для текущего ключа стадии',
        parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['university', 'individual', 'corporate'] } }, { name: 'stageKey', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: guidancePublishBodySchema } } },
        responses: { '200': { description: 'Текущая ревизия черновика опубликована для текущей схемы' }, '403': { description: 'Нужна роль администратора' }, '409': { description: 'Черновик отсутствует, изменился или стадия удалена' } },
      },
    },
    '/api/activities/{id}/guidance': {
      get: {
        summary: 'Инструкция и одна контекстная рекомендация для активности',
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }],
        responses: {
          '200': { description: 'Инструкция и ровно одна рекомендация с основанием', content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityGuidance' } } } },
          '404': { description: 'Активность не найдена или недоступна' }, '409': { description: 'Стадия активности отсутствует в текущем workflow или справочнике' },
        },
      },
    },
    '/api/activities/{id}/guidance/feedback': {
      post: {
        summary: 'Отложить или отклонить текущую рекомендацию только для текущего пользователя',
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', additionalProperties: false, required: ['recommendationKey', 'action'],
          properties: { recommendationKey: { type: 'string', minLength: 1, maxLength: 160 }, action: { type: 'string', enum: ['defer', 'reject'] }, reason: { type: 'string', maxLength: 1000 } },
        } } } },
        responses: {
          '200': { description: 'Личное решение сохранено на сервере' }, '400': { description: 'Для отклонения укажите причину' },
          '404': { description: 'Активность недоступна или рекомендация устарела' }, '409': { description: 'Закрытая активность доступна только для чтения' },
        },
      },
    },
    '/api/activities/{id}/tasks': { post: { summary: 'Поставить действие со сроком', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewTask' } } } }, responses: { '201': { description: 'Действие создано' } } } },
    '/api/activities/{id}/tasks/{taskId}/subscription': {
      get: { summary: 'Проверить подписку текущего пользователя на действие', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'taskId', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Состояние подписки', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskSubscription' } } } }, '404': { description: 'Активность или действие недоступно' } } },
      put: { summary: 'Подписаться на обновления действия', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'taskId', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Состояние подписки', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskSubscription' } } } }, '404': { description: 'Активность или действие недоступно' }, '409': { description: 'Активность закрыта' } } },
      delete: { summary: 'Отписаться от обновлений действия, в том числе закрытого', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'taskId', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Состояние подписки', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskSubscription' } } } }, '404': { description: 'Активность или действие недоступно' } } },
    },
    '/api/activities/{id}/tasks/{taskId}/updates': { post: { summary: 'Добавить текстовое обновление действия', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'taskId', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } } } } } }, responses: { '201': { description: 'Событие истории создано; подписчики кроме автора получили уведомления', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskUpdate' } } } }, '400': { description: 'Текст некорректен' }, '404': { description: 'Активность или действие недоступно' }, '409': { description: 'Активность закрыта' } } } },
    '/api/activities/{id}/tasks/{taskId}/complete': { post: { summary: 'Выполнить задачу, не меняя стадию', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'taskId', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Задача отмечена выполненной' }, '404': { description: 'Задача недоступна' } } } },
    '/api/activities/{id}/outcomes': { post: { summary: 'Записать итог контакта без смены стадии', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Outcome' } } } }, responses: { '201': { description: 'Итог добавлен в историю' } } } },
    '/api/activities/{id}/transition': { post: { summary: 'Выполнить разрешённый переход с проверкой прочитанной стадии и ревизии схемы', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StageTransition' } } } }, responses: { '200': { description: 'Переход выполнен' }, '409': { description: 'Прочитанная стадия или схема уже изменилась; обновите карточку' } } } },
    '/api/activities/{id}/history': { get: { summary: 'История активности', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'События в обратном порядке времени' } } } },
    '/api/activities/{id}/documents': {
      get: { summary: 'Список вложений с проверкой области активности', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Метаданные доступных документов', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ActivityDocument' } } } } }, '404': { description: 'Активность не найдена или недоступна' } } },
      post: { summary: 'Загрузить вложение в закрытое локальное хранилище', description: 'До 20 MiB. Поддерживаются PNG, JPEG, PDF, ZIP, GZIP, RAR, DOC, DOCX, XLS и XLSX. Сервер сверяет расширение с сигнатурой/структурой контейнера. Архивы не распаковываются. Требуется доступ к активности; загрузка в закрытую активность запрещена.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'filename', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 180 } }], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { '201': { description: 'Метаданные сохранённого документа', content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityDocument' } } } }, '400': { description: 'Имя, расширение или содержимое не поддерживается' }, '404': { description: 'Активность не найдена или недоступна' }, '409': { description: 'Закрытую активность можно только просматривать' }, '413': { description: 'Файл превышает 20 MiB' } } },
    },
    '/api/activities/{id}/documents/{documentId}': { get: { summary: 'Скачать вложение с повторной проверкой прав и аудитом', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'documentId', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Файл как безопасное вложение (application/octet-stream)', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }, headers: { 'Content-Disposition': { schema: { type: 'string' } }, 'X-Content-Type-Options': { schema: { type: 'string', enum: ['nosniff'] } } } }, '404': { description: 'Документ не найден или недоступен по текущей области КАМ' }, '410': { description: 'Локальный объект отсутствует или повреждён' } } } },
    '/api/activities/{id}/learning-facts': { get: { summary: 'Разрешённая read-only проекция фактов обучения из LMS', description: 'Для индивидуального процесса возвращает только тип факта, источник, время факта и ссылочный ключ. CRM не ведёт учебную ведомость; этот API не создаёт и не меняет факты.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Проекция в порядке времени', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/IndividualLearningFact' } } } } }, '404': { description: 'Активность не найдена или недоступна' }, '409': { description: 'Проекция доступна только для индивидуального процесса' } } } },
    '/api/activities/{id}/corporate-plan': {
      get: { summary: 'Получить компактный план корпоративной программы', description: 'Для активности без плана возвращается revision 0 и programMode undecided. requestedPlaces — заявленные места, не зачисления LMS. Доступ ограничен областью активности; закрытая запись доступна только для чтения.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'План и версия', content: { 'application/json': { schema: { $ref: '#/components/schemas/CorporatePlan' } } } }, '404': { description: 'Активность не найдена или недоступна' }, '409': { description: 'План доступен только для корпоративной активности' } } },
      put: { summary: 'Сохранить план корпоративной программы с optimistic revision', description: 'Полная замена плана и снимка аудита атомарны. Для одобрения или отказа нужны источник и ссылка/позиция evidence; это запись CRM, не юридическое подтверждение. Стадия активности не меняется.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CorporatePlanInput' } } } }, responses: { '200': { description: 'Новая версия плана' }, '400': { description: 'Некорректный план или отсутствует evidence для согласования' }, '403': { description: 'Нужна роль КАМ, руководителя или администратора' }, '404': { description: 'Активность не найдена или недоступна' }, '409': { description: 'Конфликт версии, закрытая активность или неверный тип активности' } } },
    },
    '/api/activities/{id}/contract-licenses': {
      get: { summary: 'Договоры и лицензии, связанные с одной активностью', description: 'У активности может быть ноль или несколько записей; ранняя активность не требует договора. Срок лицензии хранится с заявленной точностью: точная дата, только год, неизвестен или не указан. Запись не выдаёт доступ к продукту.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Записи по активности', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ActivityContractLicense' } } } } }, '404': { description: 'Активность не найдена или недоступна' } } },
      post: { summary: 'Добавить контекст договора или лицензии к активности', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityContractLicenseInput' } } } }, responses: { '201': { description: 'Запись создана' }, '400': { description: 'Некорректные поля или документ не относится к этой активности' }, '403': { description: 'Нужна роль КАМ, руководителя или администратора' }, '404': { description: 'Активность не найдена или недоступна' }, '409': { description: 'Закрытая активность доступна только для чтения' } } },
    },
    '/api/activities/{id}/contract-licenses/{recordId}': {
      put: { summary: 'Обновить договор или лицензию с проверкой версии', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'recordId', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityContractLicenseInput' } } } }, responses: { '200': { description: 'Запись обновлена и добавлена в историю' }, '409': { description: 'Конфликт версии или закрытая активность' } } },
      delete: { summary: 'Удалить запись договора или лицензии с проверкой версии; событие останется в истории', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }, { name: 'recordId', in: 'path', required: true, schema: uuidSchema }, { name: 'expectedRevision', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '204': { description: 'Запись удалена' }, '409': { description: 'Конфликт версии или закрытая активность' } } },
    },
    '/api/activities/{id}/university-steps': {
      get: { summary: 'Пункты партнёрства в вузовской активности и сквозной обзор U14', description: 'Возвращает пункты U01–U13, их отдельные состояния и U14 из открытых задач, последнего события и счётчиков состояний. Для старых записей отсутствие строки означает unrecorded.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Состояния пунктов и обзор', content: { 'application/json': { schema: { $ref: '#/components/schemas/UniversitySteps' } } } }, '404': { description: 'Активность не найдена или недоступна' }, '409': { description: 'Пункты применимы только к вузу' } } },
    },
    '/api/activities/{id}/university-steps/{stepId}': {
      put: {
        summary: 'Обновить состояние пункта партнёрства с проверкой версии',
        description: 'U05 нельзя переводить в активные или зафиксированные состояния этим методом; возврат оформляется отдельным атомарным действием. Для U04, U06–U07 и U09–U13 состояние documented требует ссылки/позиции и источника; для остальных требуется заметка или ссылка.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: uuidSchema },
          { name: 'stepId', in: 'path', required: true, schema: { type: 'string', pattern: '^U(0[1-9]|1[0-3])$' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UniversityStepUpdate' } } } },
        responses: { '200': { description: 'Пункт сохранён; добавлено событие истории' }, '404': { description: 'Активность или пункт не найдены' }, '409': { description: 'Конфликт версии или закрытая активность' } },
      },
    },
    '/api/activities/{id}/university-steps/correction-return': {
      post: {
        summary: 'Записать применимый возврат документов U05 и открыть U04 заново',
        description: 'Атомарно фиксирует корректировку U05 и переводит U04 в in_progress, сохраняя заметку и источник предыдущей передачи в U04. Это не меняет макроэтап активности.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UniversityCorrectionReturn' } } } },
        responses: { '200': { description: 'U05 записан, U04 снова в работе' }, '409': { description: 'Конфликт версии, закрытая активность или возврат неприменим' } },
      },
    },
    '/api/workflow': { get: { summary: 'Стадии и переходы по версии маршрута', description: 'allowedNextByRoute разделяет переходы legacy и v2. Для текущей активности используйте allowedNext из GET /api/activities/{id}.', responses: { '200': { description: 'Стадии и два индивидуальных маршрутных графа' } } } },
    '/api/admin/workflow/university': { get: {
      summary: 'Прочитать общую текущую схему вузов', description: 'Только администратор. Одна изменяемая схема применяется ко всем вузам; revision используется для защиты от конкурентных изменений.',
      responses: { '200': { description: 'Версия, стадии и переходы общей схемы', content: { 'application/json': { schema: { $ref: '#/components/schemas/UniversityWorkflowConfiguration' } } } }, '403': { description: 'Нужна роль администратора' } },
    } },
    '/api/admin/workflow/university/preview': { post: {
      summary: 'Предпросмотр глобального изменения схемы вузов', description: 'Показывает все вузовские активности, в том числе закрытые. Для каждой удаляемой стадии нужно явное сопоставление с сохранённым соседом. Предпросмотр ничего не изменяет. Технический администратор без роли руководителя видит opaque ID и стадии, а названия активностей и владельцев получает только при совмещении роли руководителя.',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UniversityWorkflowChangeInput' } } } },
      responses: { '200': { description: 'Затронутые ID и стадии, счётчики, допустимые замены и блокировки; названия зависят от наличия бизнес-роли руководителя', content: { 'application/json': { schema: { $ref: '#/components/schemas/UniversityWorkflowPreview' } } } }, '400': { description: 'Некорректный граф или поля запроса' }, '403': { description: 'Нужна роль администратора' }, '409': { description: 'Версия схемы устарела' } },
    } },
    '/api/admin/workflow/university/apply': { post: {
      summary: 'Атомарно применить предпросмотр схемы вузов', description: 'Требуются ожидаемая версия и previewToken последнего предпросмотра. Стадии всех затронутых вузовских активностей и схема меняются одной транзакцией. Закрытость и существующие события истории сохраняются; добавляется событие переноса. Другие типы активностей не меняются.',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UniversityWorkflowApplyInput' } } } },
      responses: { '200': { description: 'Новая версия общей схемы и перенесённые активности', content: { 'application/json': { schema: { $ref: '#/components/schemas/UniversityWorkflowApplyResult' } } } }, '400': { description: 'Некорректный граф или отсутствует токен предпросмотра' }, '403': { description: 'Нужна роль администратора' }, '409': { description: 'Конфликт версии, устаревший предпросмотр или блокировка' } },
    } },
    '/api/admin/imports/summary': { get: {
      summary: 'Сводка импорта для администратора',
      description: 'Только чтение: количества заданий и строк, требующих разбора, плюс не более 20 последних заданий без имён, содержимого файлов и контактных данных. Подтверждение импорта остаётся у бизнес-роли владельца загрузки.',
      responses: { '200': { description: 'Обезличенная сводка импорта' }, '403': { description: 'Нужна роль администратора' } },
    } },
    '/api/imports': { post: {
      summary: 'Загрузить файл в приватное временное хранилище и создать черновик импорта',
      description: 'До 5 MiB. Поддерживаются XLS/XLSX и CSV UTF-8 для контактов и поставщиков, JSON или CSV UTF-8 для индивидуальных заявок. CSV-заявкам нужен стабильный внешний ключ. Файл хранится приватно только на время разбора; данные предпросмотра доступны только загрузившему пользователю 24 часа. Формулы и ссылки не исполняются и не импортируются.',
      parameters: [
        { name: 'filename', in: 'query', required: true, schema: { type: 'string', minLength: 5, maxLength: 180 } },
        { name: 'target', in: 'query', required: true, schema: { $ref: '#/components/schemas/ImportTarget' } },
        { name: 'source', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 80 } },
      ],
      requestBody: { required: true, content: { 'application/vnd.lct.import': { schema: { type: 'string', format: 'binary' } } } },
      responses: { '201': { description: 'Черновик с листами и образцами; строки заголовков доступны отдельным запросом', content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportUploadResponse' } } } }, '400': { description: 'Неверный формат, повреждённый файл или неподдерживаемая цель' }, '401': { description: 'Требуется вход в CRM' }, '403': { description: 'Нужна роль участника CRM' }, '413': { description: 'Файл больше 5 MiB' } },
    } },
    '/api/imports/{id}': {
      get: { summary: 'Получить импорт только для его автора', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Листы, исходные заголовки, сопоставление, проверка строк и последний результат', content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportJobResponse' } } } }, '404': { description: 'Не найден или принадлежит другой области' }, '410': { description: 'Срок хранения предпросмотра истёк' } } },
      delete: { summary: 'Удалить неподтверждённый предпросмотр', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '204': { description: 'Черновик удалён, бизнес-данные не изменялись' }, '404': { description: 'Не найден или принадлежит другой области' }, '409': { description: 'Подтверждённый импорт нельзя отменить' } } },
    },
    '/api/imports/{id}/header': { get: {
      summary: 'Прочитать строку для выбора заголовков листа', description: 'Возвращает только указанную строку из предпросмотра, чтобы выбрать заголовок в любой из первых 2 002 строк листа. Доступно только автору импорта.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: uuidSchema },
        { name: 'sheet', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } },
        { name: 'row', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } },
      ],
      responses: { '200': { description: 'Номер строки и значения ячеек', content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportHeaderResponse' } } } }, '400': { description: 'Номер строки вне выбранного листа' }, '404': { description: 'Импорт или лист не найден либо недоступен' }, '410': { description: 'Предпросмотр истёк' } },
    } },
    '/api/imports/{id}/preview': { put: {
      summary: 'Проверить строку заголовков и сопоставление без бизнес-записи', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportPreviewInput' } } } },
      responses: { '200': { description: 'Проверка строк, причин возможных совпадений и текущей ревизии предпросмотра', content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportJobResponse' } } } }, '400': { description: 'Невалидное сопоставление или строка заголовков' }, '404': { description: 'Не найден или недоступен' }, '409': { description: 'Ревизия изменилась или черновик уже подтверждён' }, '410': { description: 'Предпросмотр истёк' } },
    } },
    '/api/imports/{id}/confirm': { post: {
      summary: 'Явно подтвердить строки сохранённого предпросмотра', description: 'Ревизия должна точно совпадать. Повтор с тем же idempotencyKey возвращает сохранённый результат. Строки с возможным совпадением создаются отдельно только после отметки reviewedRows; обновление существующего внешнего ключа требует этой же явной проверки. Ошибки фиксируются построчно.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportConfirmationInput' } } } },
      responses: { '200': { description: 'Построчные created/updated/unchanged/skipped/conflict/failed результаты', content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportConfirmationResult' } } } }, '400': { description: 'Некорректные номера строк или ключ повтора' }, '404': { description: 'Не найден или недоступен' }, '409': { description: 'Ревизия предпросмотра изменилась' }, '410': { description: 'Предпросмотр истёк' } },
    } },
    '/api/contacts': { get: { summary: 'Поиск контактов в собственной области пользователя', description: 'Бизнес-данные доступны КАМ и руководителю; техническая роль администратора сама по себе не открывает контакты.', parameters: [{ name: 'query', in: 'query', schema: { type: 'string', maxLength: 100 } }], responses: { '200': { description: 'До 100 контактов текущей области' }, '401': { description: 'Требуется вход' }, '403': { description: 'Нужна роль КАМ или руководителя' } } } },
    '/api/public-demo/inquiries': { post: { summary: 'Создать синтетическую входящую заявку с публичной demo-страницы', description: 'Открыт только при включённом PUBLIC_DEMO_INTAKE_ENABLED. Создаёт university, corporate или individual CRM-активность для демо-КАМ в той же транзакции, где сохраняет ключ идемпотентности. Публичная CMS/LMS интеграция не выполняется; использовать только вымышленные данные.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['kind','name','email','note','honeypot','idempotencyKey'], properties: { kind: { type: 'string', enum: ['individual','university','corporate'] }, name: { type: 'string', minLength: 2, maxLength: 120 }, email: { type: 'string', format: 'email', maxLength: 254 }, phone: { type: 'string', maxLength: 40 }, organization: { type: 'string', maxLength: 160, description: 'Обязательна для university и corporate.' }, note: { type: 'string', minLength: 8, maxLength: 1200 }, honeypot: { type: 'string', maxLength: 200 }, idempotencyKey: uuidSchema } } } } }, responses: { '202': { description: 'Заявка создана или совпала с уже сохранённой демо-заявкой' }, '400': { description: 'Ошибка валидации' }, '404': { description: 'Демо-маршрут выключен' }, '429': { description: 'Превышен лимит отправок' }, '503': { description: 'Демо-КАМ или маршрут заявок пока не настроен' } } } },
    '/api/vendors': { get: { summary: 'Поставщики текущей области пользователя', description: 'Поставщик — отдельная сущность и не становится клиентской организацией. Доступ ограничен загрузившим пользователем.', responses: { '200': { description: 'Поставщики и связанные продукты' }, '401': { description: 'Требуется вход' } } } },
    '/api/activities/{id}/exchanges': { get: { summary: 'Обмены только в области доступной активности', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Задания CMS/LMS этой активности', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ExchangeJob' } } } } }, '404': { description: 'Активность не найдена или недоступна' } } } },
    '/api/cms-mock/intake': { get: { summary: 'Общая очередь синтетических CMS обращений, ожидающих КАМ', description: 'Возвращает только краткую карточку обращения без контактов. После атомарного захвата доступ к активности и обменам остаётся у назначенного КАМ.', responses: { '200': { description: 'До 100 не назначенных CMS mock обращений' }, '403': { description: 'Недоступно текущей роли' } } } },
    '/api/cms-mock/intake/{id}/claim': { post: { summary: 'Назначить CMS mock обращение текущему КАМ', description: 'Первый успешный захват назначает владельца и создаёт событие истории. Следующая попытка получает 409.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Назначенная КАМ активность' }, '403': { description: 'Назначать может КАМ' }, '409': { description: 'Обращение уже назначено' } } } },
    '/api/activities/{id}/exchanges/lms-requests': { post: { summary: 'Отправить запрос подготовки доступа в LMS mock', description: 'Доступно для открытой индивидуальной активности на стадии lms_handoff. Возвращает sent, accepted, rejected или retryable_error; отправка и принятие не создают зачисление.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['idempotencyKey'], properties: { idempotencyKey: { type: 'string', maxLength: 160 } } } } } }, responses: { '201': { description: 'Сохранённое задание и ответ mock-сервиса', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExchangeJob' } } } }, '404': { description: 'Активность недоступна' }, '409': { description: 'Неверная стадия или тип активности' } } } },
    '/api/exchanges/{id}/retry': { post: { summary: 'Повторить неудачное задание, если оно доступно текущей роли', description: 'Задание подготовки доступа и отправка статуса требуют доступа к связанной активности. Администратор может повторить только пакетное чтение CMS/LMS; технический монитор передаёт canRetry для компактных заданий.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], responses: { '200': { description: 'Состояние повторённого задания' }, '404': { description: 'Нет прав на связанное задание' }, '409': { description: 'Задание нельзя повторить или предел попыток исчерпан' } } } },
    '/api/admin/exchanges': { get: { summary: 'Очередь обменов и состояние локальных mock-сервисов', description: 'Только администратор. Для администратора без роли руководителя возвращаются технические состояния без activityId, владельцев, корреляционных идентификаторов и содержимого событий. Администратор с ролью руководителя получает детали только для активностей из его бизнес-области; остальные задания остаются компактными.', responses: { '200': { description: 'Не более 200 последних заданий и безопасный health CMS/LMS mock', content: { 'application/json': { schema: { type: 'object', required: ['mode','services','jobs','retryLimit'], properties: { mode: { type: 'string', const: 'mock' }, services: { type: 'object' }, jobs: { type: 'array', items: { oneOf: [{ $ref: '#/components/schemas/TechnicalExchangeJob' }, { $ref: '#/components/schemas/ExchangeJob' }] } }, retryLimit: { type: 'integer' } } } } } }, '403': { description: 'Нужна роль администратора' } } } },
    '/api/admin/exchanges/cms/pull': { post: { summary: 'Прочитать входящие обращения из CMS mock', description: 'Создаёт активности из синтетического входящего события; возвращаемый CMS статус остаётся отдельной CRM → CMS отправкой и меняется только после ответа mock. Поскольку один pull агрегирует несколько активностей, ответ всегда содержит только безопасные счётчики и статусы, в том числе для роли руководителя.', responses: { '200': { description: 'Результат получения и обработки обращений' }, '403': { description: 'Нужна роль администратора' } } } },
    '/api/admin/exchanges/lms/pull': { post: { summary: 'Прочитать события из LMS mock', description: 'Добавляет факты в индивидуальную read-only проекцию только из входящих LMS событий. Не создаёт учебные события по команде CRM. Поскольку один pull агрегирует несколько активностей, ответ всегда содержит только безопасные счётчики и статусы, в том числе для роли руководителя.', responses: { '200': { description: 'Результат получения LMS событий' }, '403': { description: 'Нужна роль администратора' } } } },
    '/api/admin/exchanges/mocks/{system}/fail-next': { post: { summary: 'Настроить воспроизводимое однократное состояние отказа mock', parameters: [{ name: 'system', in: 'path', required: true, schema: { type: 'string', enum: ['cms','lms'] } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['mode'], properties: { mode: { enum: ['http_error','reject_next'] } } } } } }, responses: { '202': { description: 'Следующая операция mock настроена' }, '403': { description: 'Нужна роль администратора' } } } },
    '/api/admin/exchanges/lms/{id}/outcome': { post: { summary: 'Выполнить запрос в LMS mock и получить его событие обратно', description: 'Только демонстрационный control-plane. perform создаёт событие в LMS mock, отдельный pull переносит read-only факт в CRM. CRM не пишет значение в проекцию напрямую.', parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['outcome'], properties: { outcome: { enum: ['perform','reject'] }, factKind: { enum: ['enrollment','learning_started','learning_completed'] } } } } } }, responses: { '200': { description: 'Ответ LMS mock' }, '403': { description: 'Нужна роль администратора' }, '409': { description: 'Исходящий запрос ещё не принят mock' } } } },
  },
};

Object.assign(openApi.paths, {
  '/api/manager/kams': {
    get: {
      summary: 'Получить действующих КАМ для назначения активности',
      description: 'Только руководитель. Список берётся из локальной таблицы, которую синхронизирует доверенная процедура provisioning Keycloak; sub и имя из запроса клиента не принимаются.',
      responses: {
        '200': { description: 'Действующие КАМ', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AssignableKam' } } } } },
        '403': { description: 'Нужна роль руководителя' },
      },
    },
  },
  '/api/manager/activities/{id}/reassignment/preview': {
    post: {
      summary: 'Предварительно посмотреть перенос активности к другому КАМ',
      description: 'Только руководитель. Открытые задачи переходят новому КАМ с теми же сроками; завершённые сохраняют прежнюю атрибуцию. Личный импорт владельца переназначить нельзя.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityReassignmentPreviewInput' } } } },
      responses: {
        '200': { description: 'План переноса и одноразовый токен подтверждения', content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityReassignmentPreview' } } } },
        '400': { description: 'Целевой КАМ отсутствует в доверенном списке' }, '403': { description: 'Нужна роль руководителя' },
        '404': { description: 'Активность отсутствует или недоступна' }, '409': { description: 'Карточка изменилась с момента её чтения' },
      },
    },
  },
  '/api/manager/activities/{id}/reassignment/confirm': {
    post: {
      summary: 'Подтвердить перенос активности',
      description: 'Одноразовый 10-минутный токен связан с текущим руководителем и активностью. Проверяется актуальная версия карточки. Ответственный, открытые задачи и событие аудита сохраняются одной транзакцией.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: uuidSchema }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityReassignmentConfirmInput' } } } },
      responses: {
        '200': { description: 'Перенос завершён и записан в историю', content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivityReassignmentResult' } } } },
        '403': { description: 'Нужна роль руководителя' }, '404': { description: 'Активность отсутствует или недоступна' },
        '409': { description: 'Предпросмотр истёк, повторён или карточка изменилась' },
      },
    },
  },
});

Object.assign(openApi.paths, reportOpenApiPaths);

Object.assign(openApi.components.schemas, {
  AccessPolicyUser: { type: 'object', required: ['sub','name','roles','enabled','allowedKinds','allowedOrganizationIds','scopeRevision','lastSeenAt','updatedAt','updatedBySub','reason'], properties: {
    sub: { type: 'string' }, name: { type: 'string' }, roles: { type: 'array', items: { type: 'string' }, description: 'Последние наблюдавшиеся роли из подписанного Keycloak JWT; не используются для выдачи прав.' },
    enabled: { type: 'boolean' }, allowedKinds: { type: ['array','null'], uniqueItems: true, items: { type: 'string', enum: ['university','corporate','individual'] }, description: 'Null означает доступ ко всем типам активности.' },
    allowedOrganizationIds: { type: ['array','null'], uniqueItems: true, maxItems: 5000, items: { type: 'string', format: 'uuid' }, description: 'Null означает доступ ко всем организациям.' },
    scopeRevision: { type: 'integer', minimum: 0 }, lastSeenAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
    updatedBySub: { type: ['string','null'] }, reason: { type: ['string','null'] },
  } },
  AccessPolicyUserList: { type: 'object', required: ['users'], properties: { users: { type: 'array', items: { $ref: '#/components/schemas/AccessPolicyUser' } } } },
  AccessPolicyChangeInput: { type: 'object', additionalProperties: false, required: ['enabled','reason'], properties: {
    enabled: { type: 'boolean' }, reason: { type: 'string', minLength: 1, maxLength: 500 },
  } },
  AccessPolicyScopeChangeInput: { type: 'object', additionalProperties: false, required: ['allowedKinds','expectedRevision','reason'], properties: {
    allowedKinds: { type: ['array','null'], uniqueItems: true, maxItems: 3, items: { type: 'string', enum: ['university','corporate','individual'] } },
    expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 }, reason: { type: 'string', minLength: 1, maxLength: 500 },
  } },
  AccessPolicyOrganizationScopeChangeInput: { type: 'object', additionalProperties: false, required: ['allowedOrganizationIds','expectedRevision','reason'], properties: {
    allowedOrganizationIds: { type: ['array','null'], uniqueItems: true, maxItems: 5000, items: { type: 'string', format: 'uuid' } },
    expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 }, reason: { type: 'string', minLength: 1, maxLength: 500 },
  } },
  AccessPolicyOrganizationList: { type: 'object', required: ['organizations'], properties: { organizations: { type: 'array', maxItems: 100, items: { type: 'object', required: ['id','name','segment'], properties: { id: uuidSchema, name: { type: 'string' }, segment: { type: 'string' } } } } } },
});
Object.assign(openApi.paths, {
  '/api/admin/access/users': { get: {
    summary: 'Получить известных локальных пользователей и состояние доступа CRM',
    description: 'Только администратор. Состояние access overlay может только отключить пользователя; его текущие права по-прежнему определяются подписанным Keycloak JWT.',
    responses: { '200': { description: 'Известные пользователи CRM', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessPolicyUserList' } } } }, '403': { description: 'Нужна роль администратора' }, '503': { description: 'Политика доступа недоступна' } },
  } },
  '/api/admin/access/users/{sub}': { put: {
    summary: 'Включить или отключить доступ пользователя к CRM',
    description: 'Только администратор. Отключение немедленно блокирует следующие API-запросы пользователя, даже если его JWT ещё действует. Нельзя отключить себя или последнего известного администратора; изменения аудируются.',
    parameters: [{ name: 'sub', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } }],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessPolicyChangeInput' } } } },
    responses: { '200': { description: 'Новое состояние доступа', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessPolicyUser' } } } }, '403': { description: 'Нужна роль администратора' }, '404': { description: 'Пользователь не известен локальному CRM' }, '409': { description: 'Запрещено отключить себя или последнего администратора' }, '503': { description: 'Политика доступа недоступна' } },
  } },
  '/api/admin/access/users/{sub}/scope': { put: {
    summary: 'Изменить доступ пользователя к типам активности',
    description: 'Только администратор. Null разрешает все типы. Область сужает доступ, который уже разрешён ролью КАМ или руководителя. Изменение требует текущую ревизию и основание, сохраняется в аудите.',
    parameters: [{ name: 'sub', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } }],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessPolicyScopeChangeInput' } } } },
    responses: { '200': { description: 'Новое состояние области и следующая ревизия', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessPolicyUser' } } } }, '403': { description: 'Нужна роль администратора' }, '404': { description: 'Пользователь не известен локальному CRM' }, '409': { description: 'Ревизия области доступа устарела' }, '503': { description: 'Политика доступа недоступна' } },
  } },
  '/api/admin/access/users/{sub}/organizations': { put: {
    summary: 'Изменить доступ пользователя к организациям',
    description: 'Только администратор. Null разрешает все организации; пустой список разрешает только активности без основной организации и плательщика. Для активности с двумя организациями обе должны входить в список. Изменение использует общую ревизию области доступа и сохраняется в аудите.',
    parameters: [{ name: 'sub', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } }],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessPolicyOrganizationScopeChangeInput' } } } },
    responses: { '200': { description: 'Новое состояние области и следующая ревизия', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessPolicyUser' } } } }, '400': { description: 'Некорректный список UUID, ревизия или основание' }, '403': { description: 'Нужна роль администратора' }, '404': { description: 'Пользователь не известен локальному CRM' }, '409': { description: 'Ревизия области доступа устарела' } },
  } },
  '/api/admin/access/organizations': { get: {
    summary: 'Найти организации для настройки областей доступа',
    description: 'Только администратор. Возвращает не более 100 совпадений и только UUID, название и сегмент организации.',
    parameters: [{ name: 'search', in: 'query', required: false, schema: { type: 'string', maxLength: 120 } }],
    responses: { '200': { description: 'Ограниченный каталог организаций', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessPolicyOrganizationList' } } } }, '403': { description: 'Нужна роль администратора' } },
  } },
});

export function buildApp({ repository, imports, exchanges, accessPolicy, publicDemoIntake, authenticate = authenticateBearer }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' || process.env.LOG_API === '1', trustProxy: process.env.TRUST_PROXY === '1' });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_ACTIVITY_DOCUMENT_BYTES }, (_request, body, done) => done(null, body));
  app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: false,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error && typeof error === 'object' && 'validation' in error && error.validation) return reply.code(400).send({ code: 'invalid_request', message: 'Проверьте заполнение полей.' });
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) return reply.code(413).send({ code: 'document_too_large', message: 'Размер файла не должен превышать 20 МБ.' });
    app.log.error(error);
    return reply.code(500).send({ code: 'internal_error', message: 'Не удалось выполнить действие. Попробуйте ещё раз.' });
  });

  app.addHook('onRequest', async (request) => {
    if (request.url === '/health' || request.url === '/openapi.json' || request.url === '/docs') return;
    if (request.method === 'POST' && request.routeOptions.url === '/api/public-demo/inquiries') return;
    request.actor = await authenticate(request);
    if (!hasWorkspaceRole(request.actor)) throw new DomainError(403, 'forbidden', 'У пользователя нет роли CRM.');
    if (accessPolicy) request.actor = await accessPolicy.observeAndAssertEnabled(request.actor);
    // Fastify has already matched and decoded the URL before onRequest. Authorize the
    // registered route path rather than the raw request target so percent-encoded
    // static segments (for example, /api/%63ontacts) cannot bypass this check.
    if (requiresBusinessRole(request.routeOptions.url ?? request.url)) assertBusinessAccess(request.actor);
  });

  app.get('/health', async () => ({ status: 'ok', service: 'crm-api' }));
  app.get('/openapi.json', async () => openApi);
  app.get('/docs', async (_request, reply) => reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>RTK CRM API</title><body style="font:16px system-ui;max-width:760px;margin:48px auto;padding:0 20px;color:#24212b"><h1>RTK CRM API</h1><p>Контракт OpenAPI 3.1. CMS и LMS представлены локальными демонстрационными сервисами.</p><p><a href="/openapi.json">Открыть контракт API</a></p><p>Базовый адрес API — адрес этой страницы.</p></body></html>`));

  const publicIntakeWindows = new Map<string, { start: number; count: number }>();
  app.post<{ Body: Record<string, unknown> }>('/api/public-demo/inquiries', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['kind', 'name', 'email', 'note', 'honeypot', 'idempotencyKey'], properties: {
      kind: { type: 'string', enum: ['individual', 'university', 'corporate'] },
      name: { type: 'string', minLength: 2, maxLength: 120 }, email: { type: 'string', minLength: 3, maxLength: 254 },
      phone: { type: 'string', maxLength: 40 }, organization: { type: 'string', maxLength: 160 }, note: { type: 'string', maxLength: 1200 },
      honeypot: { type: 'string', maxLength: 200 }, idempotencyKey: { type: 'string', format: 'uuid' },
    } } },
    preValidation: async (request, reply) => {
      if (!publicDemoIntake?.enabled) return;
      const now = Date.now();
      for (const [key, value] of publicIntakeWindows) if (now - value.start >= 15 * 60_000) publicIntakeWindows.delete(key);
      const source = request.ip || 'unknown';
      const window = publicIntakeWindows.get(source) ?? { start: now, count: 0 };
      if (window.count >= 5) return reply.code(429).send({ code: 'rate_limited', message: 'Слишком много отправок. Попробуйте позже.' });
      window.count += 1; publicIntakeWindows.set(source, window);
      if (publicIntakeWindows.size > 5000) publicIntakeWindows.delete(publicIntakeWindows.keys().next().value!);
    },
  }, async (request, reply) => {
    if (!publicDemoIntake?.enabled) throw new DomainError(404, 'not_found', 'Маршрут не найден.');
    const body = request.body;
    // A filled honeypot is acknowledged without creating a CRM object.
    if (typeof body.honeypot === 'string' && body.honeypot.length > 0) return reply.code(202).send({ accepted: true, duplicate: false });
    const input = validatePublicDemoInquiry(body);
    const result = await publicDemoIntake.submit(input, body.idempotencyKey as string);
    return reply.code(202).send({ accepted: true, duplicate: result.duplicate });
  });

  app.get('/api/workflow', async () => repository.getWorkflow());
  app.get<{ Querystring: { limit?: number; cursor?: string; actorSub?: string } }>('/api/feed', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 512 }, actorSub: { type: 'string', minLength: 1, maxLength: 255 },
    } } },
  }, async (request) => repository.activityFeed(request.actor!, { limit: request.query.limit ?? 30, cursor: request.query.cursor, actorSub: request.query.actorSub }));
  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/notifications', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 512 },
    } } },
  }, async (request) => repository.notifications(request.actor!, { limit: request.query.limit ?? 30, cursor: request.query.cursor }));
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } },
  }, async (request) => repository.markNotificationRead(request.actor!, request.params.id));
  app.get('/api/admin/access/users', async (request) => {
    assertAdmin(request.actor!);
    if (!accessPolicy) throw new DomainError(503, 'access_policy_unavailable', 'Политика доступа недоступна.');
    return { users: await accessPolicy.listKnownUsers() };
  });
  app.get<{ Querystring: { search?: string } }>('/api/admin/access/organizations', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { search: { type: 'string', maxLength: 120 } } } },
  }, async (request) => {
    assertAdmin(request.actor!);
    if (!accessPolicy) throw new DomainError(503, 'access_policy_unavailable', 'Политика доступа недоступна.');
    return { organizations: await accessPolicy.listOrganizations(request.query.search ?? '') };
  });
  app.put<{ Params: { sub: string }; Body: { enabled: boolean; reason: string } }>('/api/admin/access/users/:sub', {
    schema: {
      params: { type: 'object', required: ['sub'], properties: { sub: { type: 'string', minLength: 1, maxLength: 255 } } },
      body: { type: 'object', additionalProperties: false, required: ['enabled', 'reason'], properties: {
        enabled: { type: 'boolean' }, reason: { type: 'string', minLength: 1, maxLength: 500 },
      } },
    },
  }, async (request) => {
    assertAdmin(request.actor!);
    if (!accessPolicy) throw new DomainError(503, 'access_policy_unavailable', 'Политика доступа недоступна.');
    const reason = request.body.reason.trim();
    if (!reason) throw new DomainError(400, 'invalid_request', 'Укажите основание изменения доступа.');
    return accessPolicy.setEnabled(request.actor!, request.params.sub, request.body.enabled, reason);
  });
  app.put<{ Params: { sub: string }; Body: { allowedKinds: ActivityKind[] | null; expectedRevision: number; reason: string } }>('/api/admin/access/users/:sub/scope', {
    schema: {
      params: { type: 'object', required: ['sub'], properties: { sub: { type: 'string', minLength: 1, maxLength: 255 } } },
      body: { type: 'object', additionalProperties: false, required: ['allowedKinds', 'expectedRevision', 'reason'], properties: {
        allowedKinds: { type: ['array','null'], uniqueItems: true, maxItems: 3, items: { type: 'string', enum: ['university','corporate','individual'] } },
        expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 }, reason: { type: 'string', minLength: 1, maxLength: 500 },
      } },
    },
  }, async (request) => {
    assertAdmin(request.actor!);
    if (!accessPolicy) throw new DomainError(503, 'access_policy_unavailable', 'Политика доступа недоступна.');
    const reason = request.body.reason.trim();
    if (!reason) throw new DomainError(400, 'invalid_request', 'Укажите основание изменения области доступа.');
    return accessPolicy.setAllowedKinds(request.actor!, request.params.sub, request.body.allowedKinds, request.body.expectedRevision, reason);
  });
  app.put<{ Params: { sub: string }; Body: { allowedOrganizationIds: string[] | null; expectedRevision: number; reason: string } }>('/api/admin/access/users/:sub/organizations', {
    schema: {
      params: { type: 'object', required: ['sub'], properties: { sub: { type: 'string', minLength: 1, maxLength: 255 } } },
      body: { type: 'object', additionalProperties: false, required: ['allowedOrganizationIds', 'expectedRevision', 'reason'], properties: {
        allowedOrganizationIds: { type: ['array','null'], uniqueItems: true, maxItems: 5000, items: { type: 'string', format: 'uuid' } },
        expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 }, reason: { type: 'string', minLength: 1, maxLength: 500 },
      } },
    },
  }, async (request) => {
    assertAdmin(request.actor!);
    if (!accessPolicy) throw new DomainError(503, 'access_policy_unavailable', 'Политика доступа недоступна.');
    const reason = request.body.reason.trim();
    if (!reason) throw new DomainError(400, 'invalid_request', 'Укажите основание изменения области доступа.');
    return accessPolicy.setAllowedOrganizations(request.actor!, request.params.sub, request.body.allowedOrganizationIds, request.body.expectedRevision, reason);
  });
  app.get('/api/admin/workflow/university', async (request) => {
    assertAdmin(request.actor!);
    return repository.getUniversityWorkflowAdmin(request.actor!);
  });
  app.post<{ Body: UniversityWorkflowChange }>('/api/admin/workflow/university/preview', {
    schema: { body: universityWorkflowChangeBodySchema },
  }, async (request) => {
    assertAdmin(request.actor!);
    return redactWorkflowPreview(request.actor!, await repository.previewUniversityWorkflow(request.actor!, request.body));
  });
  app.post<{ Body: UniversityWorkflowApply }>('/api/admin/workflow/university/apply', {
    schema: { body: universityWorkflowApplyBodySchema },
  }, async (request) => {
    assertAdmin(request.actor!);
    return redactWorkflowApplyResult(request.actor!, await repository.applyUniversityWorkflow(request.actor!, request.body));
  });
  app.get('/api/manager/overview', async (request) => {
    assertManager(request.actor!);
    return repository.managerOverview(request.actor!);
  });
  app.get('/api/manager/kams', async (request) => {
    assertManager(request.actor!);
    return repository.listAssignableKams(request.actor!);
  });
  app.post<{ Params: { id: string }; Body: ActivityReassignmentPreviewInput }>('/api/manager/activities/:id/reassignment/preview', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuidSchema } },
      body: activityReassignmentPreviewInputSchema,
    },
  }, async (request) => {
    assertManager(request.actor!);
    return repository.previewActivityReassignment(request.actor!, request.params.id, request.body);
  });
  app.post<{ Params: { id: string }; Body: { previewToken: string } }>('/api/manager/activities/:id/reassignment/confirm', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuidSchema } },
      body: activityReassignmentConfirmInputSchema,
    },
  }, async (request) => {
    assertManager(request.actor!);
    return repository.confirmActivityReassignment(request.actor!, request.params.id, request.body.previewToken);
  });
  app.get('/api/guidance/handbook', async (request) => guidanceHandbookResponse(repository, request.actor!));
  app.get('/api/admin/guidance/handbook', async (request) => {
    assertAdmin(request.actor!);
    return guidanceHandbookResponse(repository, request.actor!);
  });
  app.put<{ Params: { kind: ActivityKind; stageKey: string }; Body: { expectedRevision: number; article: GuidanceArticleContent } }>('/api/guidance/:kind/:stageKey/draft', {
    schema: {
      params: { type: 'object', required: ['kind', 'stageKey'], properties: { kind: { type: 'string', enum: ['university', 'individual', 'corporate'] }, stageKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' } } },
      body: guidanceDraftBodySchema,
    },
  }, async (request) => {
    if (!request.actor!.roles.includes('manager')) throw new DomainError(403, 'forbidden', 'Для редактирования инструкции нужна роль руководителя.');
    const article = validateGuidanceArticleContent(request.body.article);
    return repository.saveGuidanceDraft(request.actor!, request.params.kind, request.params.stageKey, article, request.body.expectedRevision);
  });
  app.post<{ Params: { kind: ActivityKind; stageKey: string }; Body: { expectedDraftRevision: number } }>('/api/admin/guidance/:kind/:stageKey/publish', {
    schema: {
      params: { type: 'object', required: ['kind', 'stageKey'], properties: { kind: { type: 'string', enum: ['university', 'individual', 'corporate'] }, stageKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' } } },
      body: guidancePublishBodySchema,
    },
  }, async (request) => repository.publishGuidanceArticle(request.actor!, request.params.kind, request.params.stageKey, request.body.expectedDraftRevision));
  app.get<{ Params: { kind: string; stageKey: string } }>('/api/guidance/:kind/:stageKey', {
    schema: { params: { type: 'object', required: ['kind', 'stageKey'], properties: {
      kind: { type: 'string', enum: ['university', 'individual', 'corporate'] }, stageKey: { type: 'string', minLength: 1, maxLength: 80 },
    } } },
  }, async (request) => {
    const catalog = await repository.getGuidanceCatalog();
    const workflow = catalog.workflow;
    const stage = workflow.find((candidate) => candidate.kind === request.params.kind && candidate.key === request.params.stageKey) as
      Record<string, any> | undefined;
    if (!stage) throw new DomainError(404, 'stage_not_found', 'Стадия отсутствует в текущем рабочем процессе.');
    const record = catalog.articles.find((candidate) => candidate.kind === stage.kind && candidate.stageKey === stage.key);
    const article = resolveStageArticle(stage, record, findStageArticle(stage.kind, stage.key)).article;
    if (!article) throw new DomainError(409, 'guidance_unavailable', 'Для этой стадии пока нет актуальной проектной инструкции.');
    return { kind: stage.kind, stageKey: stage.key, stageLabel: stage.label, metadata: guidanceMetadata, article: publicArticle(article) };
  });
  app.get('/api/catalog', async (request) => repository.catalog(request.actor!));
  app.get('/api/programs', async (request) => {
    assertProgramAccess(request.actor!);
    return { items: await repository.listLearningPrograms(request.actor!) };
  });
  app.post<{ Body: { name: string } }>('/api/programs', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 180 } } } },
  }, async (request, reply) => {
    assertProgramManagement(request.actor!);
    return reply.code(201).send(await repository.createLearningProgram(request.actor!, request.body.name));
  });
  app.put<{ Params: { id: string }; Body: { priority: number; expectedRevision: number } }>('/api/programs/:id/priority', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuidSchema } },
      body: { type: 'object', additionalProperties: false, required: ['priority', 'expectedRevision'], properties: {
        priority: { type: 'integer', minimum: 1, maximum: 5 }, expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
      } },
    },
  }, async (request) => {
    assertProgramManagement(request.actor!);
    return repository.updateLearningProgramPriority(request.actor!, request.params.id, request.body.priority, request.body.expectedRevision);
  });
  app.get<{ Querystring: { segment?: string; collection?: string; ownerSub?: string; productId?: string; stageKeys?: string; routeVersion?: string; q?: string; offset?: number; limit?: number } }>('/api/activities', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      segment: { type: 'string', enum: ['all', 'university', 'company', 'individual'] },
      collection: { type: 'string', enum: ['today', 'overdue', 'awaiting_reply', 'no_next_step', 'all'] },
      ownerSub: { type: 'string', minLength: 1, maxLength: 255 }, productId: uuidSchema,
      stageKeys: { type: 'string', maxLength: 500 }, routeVersion: { type: 'string', enum: ['legacy', 'v2'] },
      q: { type: 'string', maxLength: 120 },
      offset: { type: 'integer', minimum: 0, maximum: 10000000 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } } },
  }, async (request) => {
    const query = request.query;
    const segment = query.segment ?? 'all';
    const collection = query.collection ?? 'all';
    if (!['all', 'university', 'company', 'individual'].includes(segment)) throw new DomainError(400, 'invalid_segment', 'Неизвестный сегмент.');
    if (!['today', 'overdue', 'awaiting_reply', 'no_next_step', 'all'].includes(collection)) throw new DomainError(400, 'invalid_collection', 'Неизвестная рабочая подборка.');
    if (query.ownerSub && !request.actor!.roles.includes('manager')) {
      throw new DomainError(403, 'forbidden', 'Фильтр по ответственному доступен только руководителю.');
    }
    const stageKeys = query.stageKeys?.split(',').filter(Boolean);
    if (stageKeys && (!stageKeys.length || stageKeys.length > 12 || stageKeys.some((key) => !/^[a-z0-9_]{1,80}$/.test(key)))) {
      throw new DomainError(400, 'invalid_stage_filter', 'Фильтр этапа некорректен.');
    }
    if (query.routeVersion && segment !== 'individual') throw new DomainError(400, 'invalid_route_version', 'Версия маршрута доступна только для процесса физлиц.');
    return repository.listActivities(request.actor!, {
      segment: segment as any, collection: collection as any, ownerSub: query.ownerSub, productId: query.productId, stageKeys, routeVersion: query.routeVersion as 'legacy' | 'v2' | undefined, search: query.q?.trim(),
      offset: Number(query.offset ?? 0), limit: Number(query.limit ?? 50),
    });
  });
  app.post<{ Body: NewActivity }>('/api/activities', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['kind', 'title'], properties: {
      kind: { type: 'string', enum: ['university', 'individual', 'corporate'] }, title: { type: 'string', minLength: 1, maxLength: 180 },
      origin: { type: 'string', enum: ['manual'] }, originSource: { type: 'string', maxLength: 160 }, originReference: { type: 'string', maxLength: 240 },
      organizationId: uuidSchema, organizationName: { type: 'string', minLength: 1, maxLength: 180 }, personId: uuidSchema,
      personName: { type: 'string', minLength: 1, maxLength: 180 }, email: { type: 'string', maxLength: 254 }, phone: { type: 'string', maxLength: 64 },
      payerOrganizationId: uuidSchema, payerOrganizationName: { type: 'string', minLength: 1, maxLength: 180 },
      productIds: { type: 'array', items: uuidSchema, maxItems: 20 }, programIds: { type: 'array', items: uuidSchema, maxItems: 50, uniqueItems: true }, priority: { type: 'integer', minimum: 1, maximum: 5 },
    } } },
  }, async (request, reply) => {
    assertCanCreate(request.actor!);
    validateNewActivity(request.body);
    assertActivityKindAllowed(request.actor!, request.body.kind);
    return reply.code(201).send(await repository.createActivity(request.actor!, request.body));
  });
  app.get<{ Params: { id: string } }>('/api/activities/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } } }, async (request) => {
    const activity = await repository.getActivity(request.actor!, request.params.id);
    if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    return activity;
  });
  app.put<{ Params: { id: string }; Body: ActivityDetailsUpdate }>('/api/activities/:id/details', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuidSchema } },
      body: { type: 'object', additionalProperties: false, required: ['productIds', 'priority', 'expectedRevision'], oneOf: [
        { required: ['personId'], not: { required: ['newPerson'] } },
        { required: ['newPerson'], not: { required: ['personId'] } },
      ], properties: {
        personId: { anyOf: [uuidSchema, { type: 'null' }] },
        newPerson: { type: 'object', additionalProperties: false, required: ['fullName'], properties: {
          fullName: { type: 'string', minLength: 1, maxLength: 180 }, email: { type: 'string', maxLength: 254 }, phone: { type: 'string', maxLength: 64 },
        } },
        productIds: { type: 'array', maxItems: 20, uniqueItems: true, items: uuidSchema },
        programIds: { type: 'array', maxItems: 50, uniqueItems: true, items: uuidSchema },
        priority: { type: 'integer', minimum: 1, maximum: 5 }, expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
      } },
    },
  }, async (request) => {
    assertCanCreate(request.actor!);
    validateActivityDetailsUpdate(request.body);
    return repository.updateActivityDetails(request.actor!, request.params.id, request.body);
  });
  app.get<{ Params: { id: string } }>('/api/activities/:id/guidance', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } } }, async (request) => {
    const response = await currentActivityGuidance(repository, request.actor!, request.params.id);
    const feedback = await repository.getGuidanceFeedback(request.actor!, request.params.id, response.tip.recommendationKey);
    return { ...response, feedback: publicFeedback(feedback) };
  });
  app.post<{ Params: { id: string }; Body: { recommendationKey: string; action: GuidanceFeedbackAction; reason?: string } }>('/api/activities/:id/guidance/feedback', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuidSchema } },
      body: { type: 'object', additionalProperties: false, required: ['recommendationKey', 'action'], properties: {
        recommendationKey: { type: 'string', minLength: 1, maxLength: 160 }, action: { type: 'string', enum: ['defer', 'reject'] }, reason: { type: 'string', maxLength: 1000 },
      } },
    },
  }, async (request) => {
    assertCanCreate(request.actor!);
    const current = await currentActivityGuidance(repository, request.actor!, request.params.id);
    if (request.body.recommendationKey !== current.tip.recommendationKey) throw new DomainError(404, 'guidance_recommendation_stale', 'Рекомендация уже изменилась. Обновите карточку.');
    const reason = request.body.reason?.trim() ?? '';
    if (request.body.action === 'reject' && (!reason || reason.length > 1000)) throw new DomainError(400, 'guidance_rejection_reason_required', 'Укажите причину отклонения рекомендации.');
    const feedback = await repository.saveGuidanceFeedback(request.actor!, request.params.id, current.tip.recommendationKey, request.body.action, request.body.action === 'reject' ? reason : null);
    return publicFeedback(feedback);
  });
  app.post<{ Params: { id: string }; Body: NewTask }>('/api/activities/:id/tasks', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['title', 'dueAt'], properties: { title: { type: 'string', minLength: 1, maxLength: 180 }, dueAt: { type: 'string', format: 'date-time' } } } },
  }, async (request, reply) => {
    assertCanCreate(request.actor!);
    validateTask(request.body);
    return reply.code(201).send(await repository.createTask(request.actor!, request.params.id, request.body));
  });
  app.get<{ Params: { id: string; taskId: string } }>('/api/activities/:id/tasks/:taskId/subscription', {
    schema: { params: { type: 'object', required: ['id', 'taskId'], properties: { id: uuidSchema, taskId: uuidSchema } } },
  }, async (request) => repository.taskSubscription(request.actor!, request.params.id, request.params.taskId));
  app.put<{ Params: { id: string; taskId: string } }>('/api/activities/:id/tasks/:taskId/subscription', {
    schema: { params: { type: 'object', required: ['id', 'taskId'], properties: { id: uuidSchema, taskId: uuidSchema } } },
  }, async (request) => {
    assertCanCreate(request.actor!);
    return repository.setTaskSubscription(request.actor!, request.params.id, request.params.taskId, true);
  });
  app.delete<{ Params: { id: string; taskId: string } }>('/api/activities/:id/tasks/:taskId/subscription', {
    schema: { params: { type: 'object', required: ['id', 'taskId'], properties: { id: uuidSchema, taskId: uuidSchema } } },
  }, async (request) => {
    assertCanCreate(request.actor!);
    return repository.setTaskSubscription(request.actor!, request.params.id, request.params.taskId, false);
  });
  app.post<{ Params: { id: string; taskId: string }; Body: { text: string } }>('/api/activities/:id/tasks/:taskId/updates', {
    schema: {
      params: { type: 'object', required: ['id', 'taskId'], properties: { id: uuidSchema, taskId: uuidSchema } },
      body: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } } },
    },
  }, async (request, reply) => {
    assertCanCreate(request.actor!);
    return reply.code(201).send(await repository.createTaskUpdate(request.actor!, request.params.id, request.params.taskId, request.body.text));
  });
  app.post<{ Params: { id: string }; Body: { outcome: Outcome; note: string } }>('/api/activities/:id/outcomes', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['outcome', 'note'], properties: { outcome: { type: 'string', enum: ['connected', 'no_answer', 'meeting_booked', 'awaiting_reply', 'not_interested', 'other', 'cancelled', 'refused'] }, note: { type: 'string', maxLength: 3000 } } } },
  }, async (request, reply) => {
    assertCanCreate(request.actor!);
    return reply.code(201).send(await repository.recordOutcome(request.actor!, request.params.id, request.body.outcome, request.body.note));
  });
  app.post<{ Params: { id: string }; Body: { targetStage: string; expectedStageKey: string; expectedWorkflowRevision: number | null } }>('/api/activities/:id/transition', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } }, body: { type: 'object', additionalProperties: false, required: ['targetStage', 'expectedStageKey', 'expectedWorkflowRevision'], properties: {
      targetStage: { type: 'string', minLength: 1, maxLength: 80 }, expectedStageKey: { type: 'string', minLength: 1, maxLength: 80 }, expectedWorkflowRevision: { type: ['integer', 'null'], minimum: 1 },
    } } },
  }, async (request) => {
    assertCanCreate(request.actor!);
    return repository.transition(request.actor!, request.params.id, request.body.targetStage, request.body.expectedStageKey, request.body.expectedWorkflowRevision);
  });
  app.post<{ Params: { id: string; taskId: string } }>('/api/activities/:id/tasks/:taskId/complete', {
    schema: { params: { type: 'object', required: ['id', 'taskId'], properties: { id: uuidSchema, taskId: uuidSchema } } },
  }, async (request) => {
    assertCanCreate(request.actor!);
    return repository.completeTask(request.actor!, request.params.id, request.params.taskId);
  });
  app.get<{ Params: { id: string } }>('/api/activities/:id/history', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } } }, async (request) => {
    const history = await repository.history(request.actor!, request.params.id);
    if (!history) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    return history;
  });
  app.get<{ Params: { id: string } }>('/api/activities/:id/documents', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } },
  }, async (request) => {
    const documents = await repository.listActivityDocuments(request.actor!, request.params.id);
    if (!documents) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    return documents;
  });
  app.post<{ Params: { id: string }; Querystring: { filename: string }; Body: Buffer }>('/api/activities/:id/documents', {
    bodyLimit: MAX_ACTIVITY_DOCUMENT_BYTES,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuidSchema } },
      querystring: { type: 'object', additionalProperties: false, required: ['filename'], properties: { filename: { type: 'string', minLength: 1, maxLength: 180 } } },
    },
  }, async (request, reply) => {
    assertCanCreate(request.actor!);
    const { file, bytes } = validateActivityDocument(request.query.filename, request.body);
    const id = randomUUID();
    await writePrivateDocument(id, bytes);
    try {
      const document = await repository.addActivityDocument(request.actor!, { id, activityId: request.params.id, objectKey: id, ...file });
      return reply.code(201).send(document);
    } catch (error) {
      await removePrivateDocument(id);
      throw error;
    }
  });
  app.get<{ Params: { id: string; documentId: string } }>('/api/activities/:id/documents/:documentId', {
    exposeHeadRoute: false,
    schema: { params: { type: 'object', required: ['id', 'documentId'], properties: { id: uuidSchema, documentId: uuidSchema } } },
  }, async (request, reply) => {
    const document = await repository.getActivityDocumentForDownload(request.actor!, request.params.id, request.params.documentId);
    if (!document) throw new DomainError(404, 'document_not_found', 'Документ не найден.');
    const bytes = await readPrivateDocument(document.objectKey, document.sizeBytes, document.sha256);
    if (!await repository.recordActivityDocumentDownload(request.actor!, request.params.id, document.id)) {
      throw new DomainError(404, 'document_not_found', 'Документ не найден.');
    }
    const fallbackName = document.name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 180) || `document.${document.extension}`;
    const encodedName = encodeURIComponent(document.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(bytes.length))
      .header('Content-Disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', 'sandbox')
      .header('Cache-Control', 'private, no-store')
      .send(bytes);
  });
  app.get<{ Params: { id: string } }>('/api/activities/:id/learning-facts', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } } }, async (request) => {
    const facts = await repository.individualLearningFacts(request.actor!, request.params.id);
    if (!facts) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    return facts;
  });
  app.get<{ Params: { id: string } }>('/api/activities/:id/corporate-plan', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } } }, async (request) => {
    const plan = await repository.corporatePlan(request.actor!, request.params.id);
    if (!plan) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    return plan;
  });
  app.put<{ Params: { id: string }; Body: CorporatePlanInput }>('/api/activities/:id/corporate-plan', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } }, body: corporatePlanInputSchema },
  }, async (request) => {
    assertCanCreate(request.actor!);
    validateCorporatePlan(request.body);
    return repository.updateCorporatePlan(request.actor!, request.params.id, request.body);
  });
  app.get<{ Params: { id: string } }>('/api/activities/:id/contract-licenses', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } } }, async (request) => {
    const records = await repository.listActivityContractLicenses(request.actor!, request.params.id);
    if (!records) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    return records;
  });
  app.post<{ Params: { id: string }; Body: ActivityContractLicenseFields }>('/api/activities/:id/contract-licenses', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } }, body: activityContractLicenseFieldsSchema },
  }, async (request, reply) => {
    assertCanCreate(request.actor!);
    validateActivityContractLicense(request.body);
    return reply.code(201).send(await repository.addActivityContractLicense(request.actor!, request.params.id, request.body));
  });
  app.put<{ Params: { id: string; recordId: string }; Body: ActivityContractLicenseInput }>('/api/activities/:id/contract-licenses/:recordId', {
    schema: { params: { type: 'object', required: ['id', 'recordId'], properties: { id: uuidSchema, recordId: uuidSchema } }, body: activityContractLicenseInputSchema },
  }, async (request) => {
    assertCanCreate(request.actor!);
    validateActivityContractLicense(request.body);
    if (!Number.isInteger(request.body.expectedRevision) || request.body.expectedRevision < 1 || request.body.expectedRevision > 2147483646) throw new DomainError(400, 'invalid_revision', 'Некорректная версия договора или лицензии.');
    return repository.updateActivityContractLicense(request.actor!, request.params.id, request.params.recordId, request.body);
  });
  app.delete<{ Params: { id: string; recordId: string }; Querystring: { expectedRevision: number } }>('/api/activities/:id/contract-licenses/:recordId', {
    schema: { params: { type: 'object', required: ['id', 'recordId'], properties: { id: uuidSchema, recordId: uuidSchema } }, querystring: { type: 'object', additionalProperties: false, required: ['expectedRevision'], properties: { expectedRevision: { type: 'integer', minimum: 1, maximum: 2147483646 } } } },
  }, async (request, reply) => {
    assertCanCreate(request.actor!);
    await repository.deleteActivityContractLicense(request.actor!, request.params.id, request.params.recordId, request.query.expectedRevision);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/activities/:id/university-steps', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } } } }, async (request) => {
    const result = await repository.universitySteps(request.actor!, request.params.id);
    if (!result) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    return result;
  });
  app.put<{ Params: { id: string; stepId: string }; Body: UniversityStepUpdate }>('/api/activities/:id/university-steps/:stepId', {
    schema: {
      params: { type: 'object', required: ['id', 'stepId'], properties: { id: uuidSchema, stepId: { type: 'string', pattern: '^U(0[1-9]|1[0-3])$' } } },
      body: universityStepUpdateSchema,
    },
  }, async (request) => {
    assertCanCreate(request.actor!);
    return repository.updateUniversityStep(request.actor!, request.params.id, request.params.stepId, request.body);
  });
  app.post<{ Params: { id: string }; Body: UniversityCorrectionReturn }>('/api/activities/:id/university-steps/correction-return', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuidSchema } }, body: universityCorrectionReturnSchema },
  }, async (request) => {
    assertCanCreate(request.actor!);
    return repository.universityCorrectionReturn(request.actor!, request.params.id, request.body);
  });
  if (imports) registerImportRoutes(app, imports);
  if (exchanges) registerExchangeRoutes(app, exchanges);
  registerReportRoutes(app);
  return app;
}
