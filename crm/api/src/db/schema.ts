import {
  bigint, boolean, date, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  segment: text('segment').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const people = pgTable('people', {
  id: uuid('id').primaryKey(),
  fullName: text('full_name').notNull(),
  email: text('email'),
  phone: text('phone'),
  importOwnerSub: text('import_owner_sub'),
  organizationName: text('organization_name'),
  importSource: text('import_source'),
  importExternalKey: text('import_external_key'),
  importPayloadHash: text('import_payload_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull().unique(),
  catalogVisible: boolean('catalog_visible').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const learningPrograms = pgTable('learning_programs', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull().unique(),
  priority: smallint('priority').notNull().default(3),
  revision: integer('revision').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowStages = pgTable('workflow_stages', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  key: text('stage_key').notNull(),
  label: text('label').notNull(),
  ordinal: smallint('ordinal').notNull(),
  terminal: boolean('terminal').notNull().default(false),
});

export const workflowTransitions = pgTable('workflow_transitions', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  routeVersion: text('route_version').notNull().default('legacy'),
  fromKey: text('from_key').notNull(),
  toKey: text('to_key').notNull(),
});

export const workflowConfigRevisions = pgTable('workflow_config_revisions', {
  kind: text('kind').primaryKey(),
  revision: integer('revision').notNull(),
  updatedBySub: text('updated_by_sub'),
  updatedByName: text('updated_by_name'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const activities = pgTable('activities', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  origin: text('origin').notNull().default('manual'),
  originSource: text('origin_source'),
  originReference: text('origin_reference'),
  importOwnerOnly: boolean('import_owner_only').notNull().default(false),
  routeVersion: text('route_version').notNull().default('legacy'),
  organizationId: uuid('organization_id').references(() => organizations.id),
  personId: uuid('person_id').references(() => people.id),
  payerOrganizationId: uuid('payer_organization_id').references(() => organizations.id),
  stageKey: text('stage_key').notNull(),
  ownerSub: text('owner_sub').notNull(),
  ownerName: text('owner_name').notNull(),
  assignmentRevision: integer('assignment_revision').notNull().default(0),
  detailsRevision: integer('details_revision').notNull().default(0),
  priority: smallint('priority').notNull().default(3),
  awaitingReply: boolean('awaiting_reply').notNull().default(false),
  closed: boolean('closed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  ownerSub: text('owner_sub').notNull(),
  importSource: text('import_source'),
  importExternalKey: text('import_external_key'),
  importPayloadHash: text('import_payload_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const vendorProducts = pgTable('vendor_products', {
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
}, (table) => [primaryKey({ columns: [table.vendorId, table.productId] })]);

export const importJobs = pgTable('import_jobs', {
  id: uuid('id').primaryKey(),
  actorSub: text('actor_sub').notNull(),
  actorName: text('actor_name').notNull(),
  target: text('target').notNull(),
  sourceSystem: text('source_system').notNull(),
  fileName: text('file_name').notNull(),
  fileFormat: text('file_format').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  selectedSheet: text('selected_sheet'),
  headerRow: integer('header_row'),
  rawHeadings: jsonb('raw_headings').$type<string[]>().notNull().default([]),
  mapping: jsonb('mapping').$type<Record<string, string | null>>().notNull().default({}),
  preview: jsonb('preview').$type<Record<string, unknown>[]>().notNull().default([]),
  result: jsonb('result').$type<Record<string, unknown> | null>(),
  status: text('status').notNull(),
  revision: integer('revision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const importIdentities = pgTable('import_identities', {
  id: uuid('id').primaryKey(),
  target: text('target').notNull(),
  sourceSystem: text('source_system').notNull(),
  externalKey: text('external_key').notNull(),
  ownerSub: text('owner_sub').notNull(),
  entityId: uuid('entity_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('import_identities_natural_key').on(table.target, table.sourceSystem, table.externalKey)]);

export const importConfirmations = pgTable('import_confirmations', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id').notNull().references(() => importJobs.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('import_confirmations_idempotency').on(table.jobId, table.idempotencyKey)]);

export const importAppliedRows = pgTable('import_applied_rows', {
  jobId: uuid('job_id').notNull().references(() => importJobs.id, { onDelete: 'cascade' }),
  rowNumber: integer('row_number').notNull(),
  payloadHash: text('payload_hash').notNull(),
  entityId: uuid('entity_id').notNull(),
  action: text('action').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.jobId, table.rowNumber] })]);

export const importProvenance = pgTable('import_provenance', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id').notNull(),
  confirmationId: uuid('confirmation_id').notNull(),
  target: text('target').notNull(),
  entityId: uuid('entity_id').notNull(),
  sourceSystem: text('source_system').notNull(),
  externalKey: text('external_key'),
  fileName: text('file_name').notNull(),
  sourceRowNumber: integer('source_row_number').notNull(),
  rawHeadings: jsonb('raw_headings').$type<string[]>().notNull(),
  mapping: jsonb('mapping').$type<Record<string, string | null>>().notNull(),
  payloadHash: text('payload_hash').notNull(),
  action: text('action').notNull(),
  actorSub: text('actor_sub').notNull(),
  actorName: text('actor_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const activityProducts = pgTable('activity_products', {
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
}, (table) => [primaryKey({ columns: [table.activityId, table.productId] })]);

export const activityPrograms = pgTable('activity_programs', {
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  programId: uuid('program_id').notNull().references(() => learningPrograms.id, { onDelete: 'restrict' }),
}, (table) => [primaryKey({ columns: [table.activityId, table.programId] })]);

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('open'),
  ownerSub: text('owner_sub').notNull(),
  ownerName: text('owner_name').notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const guidanceFeedback = pgTable('guidance_feedback', {
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  actorSub: text('actor_sub').notNull(),
  recommendationKey: text('recommendation_key').notNull(),
  action: text('action').notNull(),
  reason: text('reason'),
  deferredUntil: timestamp('deferred_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.activityId, table.actorSub, table.recommendationKey] })]);

export const activityContractLicenses = pgTable('activity_contract_licenses', {
  id: uuid('id').primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  contractReference: text('contract_reference'),
  contractStatus: text('contract_status'),
  licenseExpiryPrecision: text('license_expiry_precision'),
  licenseExpiresOn: date('license_expires_on', { mode: 'string' }),
  licenseExpiresYear: integer('license_expires_year'),
  documentId: uuid('document_id'),
  note: text('note'),
  revision: integer('revision').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  actorSub: text('actor_sub').notNull(),
  actorName: text('actor_name').notNull(),
});

export const activityEvents = pgTable('activity_events', {
  id: uuid('id').primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  summary: text('summary').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  actorSub: text('actor_sub').notNull(),
  actorName: text('actor_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const taskSubscriptions = pgTable('task_subscriptions', {
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  subscriberSub: text('subscriber_sub').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.taskId, table.subscriberSub] })]);

export const activityNotifications = pgTable('activity_notifications', {
  id: uuid('id').primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull().references(() => activityEvents.id, { onDelete: 'cascade' }),
  recipientSub: text('recipient_sub').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, (table) => [uniqueIndex('activity_notifications_event_recipient_uq').on(table.eventId, table.recipientSub)]);

export const activityDocuments = pgTable('activity_documents', {
  id: uuid('id').primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  objectKey: uuid('object_key').notNull().unique(),
  originalName: text('original_name').notNull(),
  extension: text('extension').notNull(),
  mediaType: text('media_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  uploadedBySub: text('uploaded_by_sub').notNull(),
  uploadedByName: text('uploaded_by_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const universityStepDefinitions = pgTable('university_step_definitions', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  groupKey: text('group_key').notNull(),
  groupLabel: text('group_label').notNull(),
  ordinal: smallint('ordinal').notNull().unique(),
  optional: boolean('optional').notNull().default(false),
});

export const activityUniversitySteps = pgTable('activity_university_steps', {
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  stepId: text('step_id').notNull().references(() => universityStepDefinitions.id),
  status: text('status').notNull(),
  note: text('note').notNull().default(''),
  evidenceReference: text('evidence_reference'),
  evidenceSource: text('evidence_source'),
  actorSub: text('actor_sub').notNull(),
  actorName: text('actor_name').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  revision: integer('revision').notNull(),
}, (table) => [primaryKey({ columns: [table.activityId, table.stepId] })]);

// Read-only CRM projection. The LMS remains authoritative; this table stores
// only the fact kind and the source, occurrence time, and reference.
export const individualLearningFacts = pgTable('individual_learning_facts', {
  id: uuid('id').primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
  exchangeEventId: uuid('exchange_event_id').references(() => exchangeEvents.id, { onDelete: 'set null' }),
  factKind: text('fact_kind').notNull(),
  source: text('source').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  reference: text('reference').notNull(),
}, (table) => [uniqueIndex('individual_learning_facts_exchange_event_id_key').on(table.exchangeEventId)]);

// Exchange jobs and events are CRM's durable record of the local CMS/LMS demo contract.
// They retain references and protocol metadata; the LMS remains authoritative for learning facts.
export const exchangeJobs = pgTable('exchange_jobs', {
  id: uuid('id').primaryKey(),
  direction: text('direction').notNull(),
  system: text('system').notNull(),
  operation: text('operation').notNull(),
  activityId: uuid('activity_id').references(() => activities.id, { onDelete: 'set null' }),
  actorSub: text('actor_sub').notNull(),
  scopeKey: text('scope_key').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  externalEventId: text('external_event_id'),
  status: text('status').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  response: jsonb('response').$type<Record<string, unknown> | null>(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('exchange_jobs_direction_idempotency_idx').on(table.direction, table.scopeKey, table.idempotencyKey)]);

export const exchangeEvents = pgTable('exchange_events', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id').notNull().references(() => exchangeJobs.id, { onDelete: 'cascade' }),
  sourceSystem: text('source_system').notNull(),
  direction: text('direction').notNull(),
  eventId: text('event_id').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  eventType: text('event_type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('exchange_events_source_event_idx').on(table.sourceSystem, table.eventId)]);

// Corporate scope tracking only. LMS enrollment and learner records stay external.
export const corporateActivityPlans = pgTable('corporate_activity_plans', {
  activityId: uuid('activity_id').primaryKey().references(() => activities.id, { onDelete: 'cascade' }),
  programMode: text('program_mode').notNull(),
  requestedPlaces: integer('requested_places'),
  brief: jsonb('brief').$type<Record<string, string | null>>().notNull(),
  methodologist: jsonb('methodologist').$type<Record<string, string | null>>().notNull(),
  proposed: jsonb('proposed').$type<Record<string, string | null>>().notNull(),
  agreed: jsonb('agreed').$type<Record<string, string | null>>().notNull(),
  approval: jsonb('approval').$type<Record<string, string | null>>().notNull(),
  revision: integer('revision').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  actorSub: text('actor_sub').notNull(),
  actorName: text('actor_name').notNull(),
});

// Report snapshots and their background exports are private to their creator.
// Snapshot rows are retained so chart, drilldown, and generated files share one as-of slice.
export const reportJobs = pgTable('report_jobs', {
  id: uuid('id').primaryKey(),
  jobType: text('job_type').notNull(),
  reportId: text('report_id').notNull(),
  actorSub: text('actor_sub').notNull(),
  actorName: text('actor_name').notNull(),
  parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  format: text('format'),
  fileKey: uuid('file_key').unique(),
  fileName: text('file_name'),
  mediaType: text('media_type'),
  fileSize: bigint('file_size', { mode: 'number' }),
  fileSha256: text('file_sha256'),
  rowCount: integer('row_count').notNull(),
  status: text('status').notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
