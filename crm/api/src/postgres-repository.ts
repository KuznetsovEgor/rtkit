import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, pool } from './db/connection.js';
import { assertHonestCompletion } from './completion-rules.js';
import { activityContractLicenses, activityDocuments, activityEvents, activityNotifications, activityProducts, activityPrograms, activities, corporateActivityPlans, individualLearningFacts as learningFacts, learningPrograms, organizations, people, products, taskSubscriptions, tasks, workflowConfigRevisions, workflowStages, workflowTransitions } from './db/schema.js';
import { type ActivityContractLicense, type ActivityContractLicenseFields, type ActivityContractLicenseInput, type ActivityDetailsUpdate, type ActivityDocument, type ActivityFilters, type ActivityPage, type ActivityKind, type Actor, type AssignableKam, type ActivityReassignmentPreview, type ActivityReassignmentPreviewInput, type ActivityReassignmentResult, type CorporatePlan, type CorporatePlanInput, type CrmRepository, type GuidanceArticleContent, type GuidanceCatalogSnapshot, type GuidanceEditorialRecord, type GuidanceFeedback, type GuidanceFeedbackAction, type GuidanceStageSnapshot, type LearningProgram, type ManagerOverview, type NewActivity, type NewActivityDocument, type NewTask, type Outcome, type StoredActivityDocument, type UniversityCorrectionReturn, type UniversityStepUpdate, type UniversityWorkflowApply, type UniversityWorkflowChange, DomainError, hasTeamBusinessScope, hasBusinessAccess, assertActivityKindAllowed, assertAdmin, assertBusinessAccess, assertManager, validateActivityContractLicense, validateManualActivityOrigin } from './domain.js';
import { normalizeUniversityWorkflowChange, previewUniversityWorkflow, type UniversityWorkflowState } from './university-workflow.js';
import { guidanceSnapshotMatches, guidanceStageSnapshot, validateGuidanceArticleContent } from './guidance.js';

type QueryRows = { rows: Record<string, any>[] };
const rowsOf = (result: unknown) => (result as QueryRows).rows;
const top = <T>(rows: T[]) => rows[0] ?? null;
type PageCursor = { createdAt: string; id: string };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
function decodePageCursor(value: string | undefined): PageCursor | null {
  if (value === undefined) return null;
  try {
    if (!value || value.length > 512) throw new Error('bad cursor size');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PageCursor>;
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt)) || !uuidPattern.test(parsed.id ?? '')) throw new Error('bad cursor fields');
    return { createdAt: parsed.createdAt, id: parsed.id! };
  } catch {
    throw new DomainError(400, 'invalid_cursor', 'Параметр страницы некорректен. Обновите список.');
  }
}
function pageLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new DomainError(400, 'invalid_limit', 'Размер страницы должен быть от 1 до 100.');
  return value;
}
async function notifyTaskSubscribers(tx: any, input: { activityId: string; taskId: string; eventId: string; actorSub: string }) {
  const recipients = rowsOf(await tx.execute(sql`SELECT subscriber_sub AS "subscriberSub" FROM task_subscriptions
    WHERE activity_id=${input.activityId} AND task_id=${input.taskId} AND subscriber_sub <> ${input.actorSub}`));
  for (const recipient of recipients) {
    await tx.insert(activityNotifications).values({
      id: randomUUID(), activityId: input.activityId, taskId: input.taskId,
      eventId: input.eventId, recipientSub: recipient.subscriberSub,
    }).onConflictDoNothing();
  }
}
const guidanceRecordOf = (row: Record<string, any>): GuidanceEditorialRecord => ({
  kind: row.kind, stageKey: row.stageKey, seedStageSnapshot: row.seedStageSnapshot,
  draftArticle: row.draftArticle, draftRevision: Number(row.draftRevision), draftStageSnapshot: row.draftStageSnapshot,
  publishedArticle: row.publishedArticle, publishedRevision: row.publishedRevision == null ? null : Number(row.publishedRevision),
  publishedStageSnapshot: row.publishedStageSnapshot,
  publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null, publishedByName: row.publishedByName,
  updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date(0).toISOString(),
});
const allowedKindPredicate = (actor: Actor, activityAlias: 'a' | 'linked' = 'a') => actor.allowedKinds == null ? sql`TRUE`
  : actor.allowedKinds.length === 0 ? sql`FALSE`
    : activityAlias === 'a'
      ? sql`a.kind IN (${sql.join(actor.allowedKinds.map((kind) => sql`${kind}`), sql`, `)})`
      : sql`linked.kind IN (${sql.join(actor.allowedKinds.map((kind) => sql`${kind}`), sql`, `)})`;
const allowedOrganizationPredicate = (actor: Actor, activityAlias: 'a' | 'linked' = 'a') => {
  if (actor.allowedOrganizationIds == null) return sql`TRUE`;
  const allowedIds = sql.join(actor.allowedOrganizationIds.map((id) => sql`${id}::uuid`), sql`, `);
  if (activityAlias === 'a') return actor.allowedOrganizationIds.length === 0
    ? sql`a.organization_id IS NULL AND a.payer_organization_id IS NULL`
    : sql`(a.organization_id IS NULL OR a.organization_id IN (${allowedIds}))
      AND (a.payer_organization_id IS NULL OR a.payer_organization_id IN (${allowedIds}))`;
  return actor.allowedOrganizationIds.length === 0
    ? sql`linked.organization_id IS NULL AND linked.payer_organization_id IS NULL`
    : sql`(linked.organization_id IS NULL OR linked.organization_id IN (${allowedIds}))
      AND (linked.payer_organization_id IS NULL OR linked.payer_organization_id IN (${allowedIds}))`;
};
const includesOrganizationId = (allowed: string[] | null | undefined, id: string | null | undefined) =>
  id == null || allowed == null || allowed.some((allowedId) => allowedId.toLowerCase() === id.toLowerCase());
const allowsOrganizations = (allowed: string[] | null | undefined, primary: string | null | undefined, payer: string | null | undefined) =>
  allowed == null || [primary, payer].every((id) => includesOrganizationId(allowed, id));
const canSee = (actor: Actor, activityAlias: 'a' | 'linked' = 'a') => {
  if (!hasBusinessAccess(actor)) return sql`FALSE`;
  const roleScope = hasTeamBusinessScope(actor)
    ? activityAlias === 'a'
      ? sql`(a.import_owner_only = FALSE OR a.owner_sub = ${actor.sub})`
      : sql`(linked.import_owner_only = FALSE OR linked.owner_sub = ${actor.sub})`
    : activityAlias === 'a' ? sql`a.owner_sub = ${actor.sub}` : sql`linked.owner_sub = ${actor.sub}`;
  return sql`(${roleScope} AND ${allowedKindPredicate(actor, activityAlias)} AND ${allowedOrganizationPredicate(actor, activityAlias)})`;
};
const canSeeProgramDemand = (actor: Actor) => {
  const roleScope = actor.roles.includes('manager')
    ? sql`(a.import_owner_only = FALSE OR a.owner_sub = ${actor.sub})`
    : actor.roles.includes('kam') ? sql`a.owner_sub = ${actor.sub}` : sql`FALSE`;
  return sql`(${roleScope} AND ${allowedKindPredicate(actor)} AND ${allowedOrganizationPredicate(actor)})`;
};
const assertProgramRole = (actor: Actor) => {
  if (!actor.roles.some((role) => role === 'kam' || role === 'manager' || role === 'admin')) throw new DomainError(403, 'forbidden', 'Для каталога программ нужна роль КАМ, руководителя или администратора.');
};
const assertProgramManagement = (actor: Actor) => {
  if (!actor.roles.some((role) => role === 'manager' || role === 'admin')) throw new DomainError(403, 'forbidden', 'Изменять каталог программ может руководитель или администратор.');
};
const visiblePersonPredicate = (actor: Actor) => {
  if (actor.allowedKinds != null || actor.allowedOrganizationIds != null) {
    return sql`(
      (people.import_owner_sub = ${actor.sub} AND NOT EXISTS (
        SELECT 1 FROM activities linked WHERE linked.person_id = people.id
      )) OR EXISTS (
        SELECT 1 FROM activities linked WHERE linked.person_id = people.id AND ${canSee(actor, 'linked')}
      )
    )`;
  }
  return hasTeamBusinessScope(actor)
    ? sql`(people.import_owner_sub IS NULL OR people.import_owner_sub = ${actor.sub})`
    : sql`(people.import_owner_sub = ${actor.sub} OR EXISTS (
      SELECT 1 FROM activities assigned WHERE assigned.owner_sub = ${actor.sub} AND assigned.person_id = people.id
    ))`;
};
const outcomeLabels: Record<Outcome, string> = {
  connected: 'Связались', no_answer: 'Не ответил', meeting_booked: 'Договорились о встрече',
  awaiting_reply: 'Ожидаю ответ', not_interested: 'Не актуально', other: 'Другое',
  cancelled: 'Отменено', refused: 'Отказ',
};
const stepStatusLabels = { in_progress: 'в работе', waiting: 'ожидание', documented: 'зафиксировано в CRM', not_applicable: 'не применяется' };
const stepsRequiringReferenceAndSource = ['U04', 'U06', 'U07', 'U09', 'U10', 'U11', 'U12', 'U13'];

const emptyCorporateData = {
  programMode: 'undecided' as const,
  requestedPlaces: null,
  brief: { expectedOutcome: null, audience: null, entryLevel: null, deliveryFormat: null, volume: null, technologyContext: null },
  methodologist: { name: null, feasibility: 'unassessed' as const, note: null },
  proposed: { scope: null, startDate: null, endDate: null, acceptanceCriteria: null },
  agreed: { scope: null, startDate: null, endDate: null, acceptanceCriteria: null },
  approval: { status: 'not_recorded' as const, evidenceReference: null, evidenceSource: null, note: null },
};

function corporatePlanDto(row: any | null, closed: boolean): CorporatePlan {
  const value = row ?? emptyCorporateData;
  return {
    programMode: value.programMode, requestedPlaces: value.requestedPlaces,
    brief: value.brief, methodologist: value.methodologist, proposed: value.proposed,
    agreed: value.agreed, approval: value.approval, revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    updatedBy: row?.actorName ?? null, readOnly: closed,
  };
}

function activityContractLicenseDto(row: any, closed: boolean): ActivityContractLicense {
  const expiry = row.licenseExpiresOn;
  return {
    id: row.id, activityId: row.activityId, title: row.title, contractReference: row.contractReference,
    contractStatus: row.contractStatus, licenseExpiryPrecision: row.licenseExpiryPrecision,
    licenseExpiresOn: expiry instanceof Date ? expiry.toISOString().slice(0, 10) : expiry,
    licenseExpiresYear: row.licenseExpiresYear, documentId: row.documentId, documentName: row.documentName,
    note: row.note, revision: Number(row.revision), updatedAt: new Date(row.updatedAt).toISOString(),
    updatedBy: row.updatedBy, readOnly: closed,
  };
}
const activityContractLicenseSnapshot = (value: ActivityContractLicenseFields & { id: string; revision: number; documentName?: string | null }) => ({
  id: value.id, title: value.title, contractReference: value.contractReference, contractStatus: value.contractStatus,
  licenseExpiryPrecision: value.licenseExpiryPrecision, licenseExpiresOn: value.licenseExpiresOn,
  licenseExpiresYear: value.licenseExpiresYear, documentId: value.documentId, documentName: value.documentName ?? null,
  note: value.note, revision: value.revision,
});

export class PostgresRepository implements CrmRepository {
  async listLearningPrograms(actor: Actor): Promise<LearningProgram[]> {
    assertProgramRole(actor);
    const result = await db.execute(sql`
      SELECT p.id::text AS id,p.name,p.priority,p.revision,
        count(DISTINCT a.id)::integer AS "demandCount"
      FROM learning_programs p
      LEFT JOIN activity_programs ap ON ap.program_id=p.id
      LEFT JOIN activities a ON a.id=ap.activity_id AND ${canSeeProgramDemand(actor)}
      GROUP BY p.id,p.name,p.priority,p.revision
      ORDER BY p.priority ASC,p.name ASC,p.id ASC
    `);
    return rowsOf(result).map((row) => ({ id: String(row.id), name: String(row.name), priority: Number(row.priority), revision: Number(row.revision), demandCount: Number(row.demandCount) }));
  }

  async createLearningProgram(actor: Actor, name: string): Promise<LearningProgram> {
    assertProgramManagement(actor);
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 180 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new DomainError(400, 'invalid_program_name', 'Название программы обязательно и должно быть не длиннее 180 символов.');
    }
    try {
      const [created] = await db.insert(learningPrograms).values({ id: randomUUID(), name: normalized }).returning({ id: learningPrograms.id, name: learningPrograms.name, priority: learningPrograms.priority, revision: learningPrograms.revision });
      return { ...created, priority: Number(created.priority), revision: Number(created.revision), demandCount: 0 };
    } catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth += 1) {
        if ((cause as { code?: string }).code === '23505') throw new DomainError(409, 'program_name_conflict', 'Программа с таким названием уже есть в каталоге.');
        cause = (cause as { cause?: unknown }).cause;
      }
      throw error;
    }
  }

  async updateLearningProgramPriority(actor: Actor, id: string, priority: number, expectedRevision: number): Promise<LearningProgram> {
    assertProgramManagement(actor);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5 || !Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 2147483646) {
      throw new DomainError(400, 'invalid_program_priority', 'Приоритет должен быть от 1 до 5, а ревизия — целым неотрицательным числом.');
    }
    const updated = await db.transaction(async (tx) => {
      const currentResult = await tx.execute(sql`SELECT revision FROM learning_programs WHERE id=${id}::uuid FOR UPDATE`);
      const current = top(rowsOf(currentResult));
      if (!current) throw new DomainError(404, 'program_not_found', 'Программа не найдена.');
      if (Number(current.revision) !== expectedRevision) throw new DomainError(409, 'program_revision_conflict', 'Приоритет программы уже изменился. Обновите список.');
      const result = await tx.execute(sql`UPDATE learning_programs SET priority=${priority},revision=revision+1,updated_at=now() WHERE id=${id}::uuid RETURNING id::text AS id,name,priority,revision`);
      return top(rowsOf(result));
    });
    if (!updated) throw new DomainError(404, 'program_not_found', 'Программа не найдена.');
    const demandResult = await db.execute(sql`SELECT count(DISTINCT a.id)::integer AS count FROM activity_programs ap JOIN activities a ON a.id=ap.activity_id WHERE ap.program_id=${id}::uuid AND ${canSeeProgramDemand(actor)}`);
    return { id: String(updated.id), name: String(updated.name), priority: Number(updated.priority), revision: Number(updated.revision), demandCount: Number(top(rowsOf(demandResult))?.count ?? 0) };
  }

  async managerOverview(actor: Actor): Promise<ManagerOverview> {
    assertManager(actor);
    const result = await db.execute(sql`
      WITH snapshot AS (
        SELECT statement_timestamp() AS as_of
      ), open_activities AS (
        SELECT a.id, a.kind, a.owner_sub, a.owner_name, a.awaiting_reply, a.updated_at,
          next_task.due_at AS next_task_due_at
        FROM activities a
        LEFT JOIN LATERAL (
          SELECT t.due_at
          FROM tasks t
          WHERE t.activity_id = a.id AND t.status = 'open'
          ORDER BY t.due_at ASC, t.created_at ASC, t.id ASC
          LIMIT 1
        ) next_task ON TRUE
        WHERE a.closed = FALSE AND (a.import_owner_only = FALSE OR a.owner_sub = ${actor.sub})
          AND ${allowedKindPredicate(actor)} AND ${allowedOrganizationPredicate(actor)}
      ), summary AS (
        SELECT json_build_object(
          'totalOpen', count(*),
          'byKind', json_build_object(
            'university', count(*) FILTER (WHERE oa.kind = 'university'),
            'corporate', count(*) FILTER (WHERE oa.kind = 'corporate'),
            'individual', count(*) FILTER (WHERE oa.kind = 'individual')
          ),
          'overdue', count(*) FILTER (WHERE oa.next_task_due_at < (SELECT as_of FROM snapshot)),
          'awaitingReply', count(*) FILTER (WHERE oa.awaiting_reply = TRUE),
          'noNextStep', count(*) FILTER (WHERE oa.next_task_due_at IS NULL)
        ) AS metrics
        FROM open_activities oa
      ), owner_counts AS (
        SELECT oa.owner_sub, count(*) AS open_count,
          count(*) FILTER (WHERE oa.next_task_due_at < (SELECT as_of FROM snapshot)) AS overdue_count
        FROM open_activities oa
        GROUP BY oa.owner_sub
      ), owner_labels AS (
        SELECT DISTINCT ON (owner_sub) owner_sub, owner_name
        FROM open_activities
        ORDER BY owner_sub, updated_at DESC, id ASC
      ), owner_rows AS (
        SELECT owner_counts.owner_sub, owner_labels.owner_name, owner_counts.open_count, owner_counts.overdue_count
        FROM owner_counts JOIN owner_labels USING (owner_sub)
      ), owners AS (
        SELECT COALESCE(json_agg(json_build_object(
          'ownerSub', owner_sub, 'ownerName', owner_name, 'open', open_count, 'overdue', overdue_count
        ) ORDER BY open_count DESC, owner_name ASC, owner_sub ASC), '[]'::json) AS rows
        FROM owner_rows
      ), product_rows AS (
        SELECT pr.id, pr.name, count(DISTINCT ap.activity_id) AS activity_count
        FROM open_activities oa
        JOIN activity_products ap ON ap.activity_id = oa.id
        JOIN products pr ON pr.id = ap.product_id
        GROUP BY pr.id, pr.name
      ), top_products AS (
        SELECT COALESCE(json_agg(json_build_object(
          'id', id, 'name', name, 'activityCount', activity_count
        ) ORDER BY activity_count DESC, name ASC, id ASC), '[]'::json) AS rows
        FROM product_rows
      ), route_stages AS (
        SELECT kind, stage_key, label, ordinal, 'current'::text AS route_version
        FROM workflow_stages WHERE kind IN ('university', 'corporate')
        UNION ALL
        SELECT kind, stage_key, label, ordinal, 'legacy'::text AS route_version
        FROM workflow_stages WHERE kind = 'individual' AND stage_key = ANY(ARRAY['request','consultation','enrollment','learning','closed']::text[])
        UNION ALL
        SELECT kind, stage_key, label, ordinal, 'v2'::text AS route_version
        FROM workflow_stages WHERE kind = 'individual' AND stage_key = ANY(ARRAY['request','consultation','conditions','lms_handoff','exceptions','result']::text[])
      ), pipeline_rows AS (
        SELECT rs.kind, rs.route_version, rs.stage_key AS key, rs.label, rs.ordinal,
          count(DISTINCT a.id)::integer AS activity_count, min(a.updated_at) AS oldest_updated_at
        FROM route_stages rs
        LEFT JOIN activities a ON a.kind=rs.kind AND a.stage_key=rs.stage_key
          AND (rs.route_version='current' OR a.route_version=rs.route_version)
          AND a.closed=FALSE AND (a.import_owner_only=FALSE OR a.owner_sub=${actor.sub})
          AND ${allowedKindPredicate(actor)} AND ${allowedOrganizationPredicate(actor)}
        GROUP BY rs.kind, rs.route_version, rs.stage_key, rs.label, rs.ordinal
      ), pipeline AS (
        SELECT COALESCE(json_agg(json_build_object(
          'kind', kind, 'routeVersion', route_version, 'key', key, 'label', label,
          'count', activity_count, 'oldestUpdatedAt', oldest_updated_at
        ) ORDER BY CASE kind WHEN 'university' THEN 1 WHEN 'corporate' THEN 2 ELSE 3 END,
          route_version, ordinal, key), '[]'::json) AS rows FROM pipeline_rows
      )
      SELECT snapshot.as_of AS "asOf", summary.metrics, owners.rows AS "byOwner", top_products.rows AS "topProducts", pipeline.rows AS pipeline
      FROM snapshot CROSS JOIN summary CROSS JOIN owners CROSS JOIN top_products CROSS JOIN pipeline
    `);
    const row = top(rowsOf(result));
    if (!row) throw new Error('Manager overview query returned no row');
    const definitions = {
      totalOpen: 'Открытые активности CRM; каждая активность считается один раз.',
      byKind: 'Открытые активности по типу: вуз, компания или физлицо.',
      overdue: 'Открытые активности, у которых ближайшая открытая задача уже просрочена на момент среза. Активность считается один раз.',
      awaitingReply: 'Открытые активности с зафиксированным исходом «Ожидаю ответ».',
      noNextStep: 'Открытые активности без открытых задач.',
      byOwner: 'Число открытых активностей и просроченных активностей по ответственному КАМ.',
      topProducts: 'Продукты, связанные с открытыми активностями, по числу уникальных активностей; одна активность учитывается один раз для продукта.',
      pipeline: 'Открытые активности по текущей стадии. Старейшая дата — минимальная дата последнего изменения; у физлиц legacy и v2 показаны отдельными маршрутами.',
    };
    const pipelineRows = (row.pipeline ?? []) as { kind: ActivityKind; routeVersion: 'legacy' | 'v2' | 'current'; key: string; label: string; count: number; oldestUpdatedAt: string | Date | null }[];
    const pipeline = new Map<string, ManagerOverview['pipeline'][number]>();
    for (const item of pipelineRows) {
      const routeVersion = item.kind === 'individual' ? item.routeVersion as 'legacy' | 'v2' : 'current';
      const routeLabel = item.kind === 'individual' ? routeVersion === 'v2' ? 'Заявки по новой схеме' : 'Заявки до обновления маршрута' : 'Текущий маршрут';
      let macro = { key: item.key, label: item.label };
      if (item.kind === 'individual') {
        if (item.key === 'request') macro = { key: 'request', label: 'Заявка' };
        else if (item.key === 'consultation') macro = { key: 'consultation', label: 'Консультация' };
        else if (routeVersion === 'legacy' && ['enrollment', 'learning'].includes(item.key)) macro = { key: 'learning', label: 'Обучение' };
        else if (routeVersion === 'v2' && item.key === 'conditions') macro = { key: 'conditions', label: 'Условия' };
        else if (routeVersion === 'v2' && ['lms_handoff', 'exceptions'].includes(item.key)) macro = { key: 'handoff', label: 'Передача и сопровождение' };
        else if (['closed', 'result'].includes(item.key)) macro = { key: item.key, label: 'Итог' };
      }
      const laneKey = `${item.kind}:${routeVersion}`;
      let lane = pipeline.get(laneKey);
      if (!lane) { lane = { kind: item.kind, routeVersion, routeLabel, stages: [] }; pipeline.set(laneKey, lane); }
      let stage = lane.stages.find((entry) => entry.key === macro.key);
      if (!stage) { stage = { key: macro.key, label: macro.label, stageKeys: [], count: 0, oldestUpdatedAt: null }; lane.stages.push(stage); }
      stage.stageKeys.push(item.key);
      stage.count += Number(item.count ?? 0);
      const oldest = item.oldestUpdatedAt ? new Date(item.oldestUpdatedAt).toISOString() : null;
      if (oldest && (!stage.oldestUpdatedAt || oldest < stage.oldestUpdatedAt)) stage.oldestUpdatedAt = oldest;
    }
    return {
      asOf: row.asOf instanceof Date ? row.asOf.toISOString() : new Date(row.asOf).toISOString(),
      metrics: row.metrics,
      byOwner: row.byOwner,
      topProducts: row.topProducts,
      pipeline: [...pipeline.values()],
      definitions,
    };
  }

  async listAssignableKams(actor: Actor): Promise<AssignableKam[]> {
    assertManager(actor);
    const result = await db.execute(sql`
      SELECT kd.user_sub AS sub, kd.display_name AS name
      FROM kam_directory kd
      LEFT JOIN known_crm_users policy ON policy.user_sub=kd.user_sub
      WHERE kd.enabled=TRUE AND kd.provision_source IN ('local-keycloak-provisioning', 'public-demo-provisioning') AND policy.disabled_at IS NULL
      ORDER BY kd.display_name, kd.user_sub
    `);
    return rowsOf(result).map((row) => ({ sub: String(row.sub), name: String(row.name) }));
  }

  async previewActivityReassignment(actor: Actor, activityId: string, input: ActivityReassignmentPreviewInput): Promise<ActivityReassignmentPreview> {
    assertManager(actor);
    if (!Number.isInteger(input.expectedAssignmentRevision) || input.expectedAssignmentRevision < 0) {
      throw new DomainError(400, 'invalid_assignment_revision', 'Версия назначения активности некорректна.');
    }
    const targetResult = await db.execute(sql`
      SELECT kd.user_sub AS sub, kd.display_name AS name, policy.allowed_kinds AS "allowedKinds",
        policy.allowed_organization_ids AS "allowedOrganizationIds"
      FROM kam_directory kd
      LEFT JOIN known_crm_users policy ON policy.user_sub=kd.user_sub
      WHERE kd.user_sub=${input.targetKamSub} AND kd.enabled=TRUE
        AND kd.provision_source IN ('local-keycloak-provisioning', 'public-demo-provisioning') AND policy.disabled_at IS NULL
      LIMIT 1
    `);
    const targetRow = top(rowsOf(targetResult));
    if (!targetRow) throw new DomainError(400, 'invalid_target_kam', 'Выберите КАМ из списка действующих пользователей CRM.');
    const result = await db.execute(sql`
      SELECT a.id, a.title, a.kind, a.organization_id AS "organizationId", a.payer_organization_id AS "payerOrganizationId",
        a.stage_key AS "stageKey", ws.label AS "stageLabel", a.owner_sub AS "ownerSub",
        a.owner_name AS "ownerName", a.assignment_revision AS "assignmentRevision", a.updated_at AS "updatedAt",
        a.updated_at::text AS "updatedAtExact",
        a.created_at AS "createdAt", a.closed, a.awaiting_reply AS "awaitingReply",
        (a.import_owner_only OR p.import_owner_sub IS NOT NULL) AS "protectedImportOwner",
        (SELECT count(*)::integer FROM activity_events e WHERE e.activity_id=a.id) AS "historyEventCount",
        (SELECT count(*)::integer FROM tasks t WHERE t.activity_id=a.id) AS "taskCount",
        (SELECT count(*)::integer FROM tasks t WHERE t.activity_id=a.id AND t.status='open') AS "openTaskCount",
        (SELECT min(t.due_at) FROM tasks t WHERE t.activity_id=a.id AND t.status='open') AS "nextOpenTaskDueAt"
      FROM activities a
      LEFT JOIN people p ON p.id=a.person_id
      JOIN workflow_stages ws ON ws.kind=a.kind AND ws.stage_key=a.stage_key
      WHERE a.id=${activityId} AND ${canSee(actor)}
      LIMIT 1
    `);
    const row = top(rowsOf(result));
    if (!row) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (Array.isArray(targetRow.allowedKinds) && !targetRow.allowedKinds.includes(String(row.kind))) {
      throw new DomainError(409, 'target_kam_segment_restricted', 'Выбранный КАМ не имеет доступа к типу этой активности. Выберите другого КАМ.');
    }
    if (!allowsOrganizations(targetRow.allowedOrganizationIds, row.organizationId, row.payerOrganizationId)) {
      throw new DomainError(409, 'target_kam_organization_restricted', 'Выбранный КАМ не имеет доступа к организации или плательщику этой активности. Выберите другого КАМ.');
    }
    if (String(row.ownerSub) !== input.expectedOwnerSub || Number(row.assignmentRevision) !== input.expectedAssignmentRevision) {
      throw new DomainError(409, 'activity_changed', 'Активность уже изменилась. Обновите карточку и повторите предварительный просмотр.');
    }

    const blockers: { code: string; message: string }[] = [];
    if (row.protectedImportOwner) blockers.push({ code: 'import_owner_only', message: 'Эта активность связана с личной импортированной записью и остаётся в области исходного КАМ.' });
    if (String(row.ownerSub) === String(targetRow.sub)) blockers.push({ code: 'already_assigned', message: 'Активность уже назначена этому КАМ.' });
    const canConfirm = blockers.length === 0;
    const previewToken = canConfirm ? randomUUID() : null;
    const updatedAt = new Date(row.updatedAt).toISOString();
    if (previewToken) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE expires_at <= now()`);
        await tx.execute(sql`
          INSERT INTO activity_reassignment_previews(
            id,manager_sub,activity_id,target_owner_sub,expected_owner_sub,expected_assignment_revision,expected_updated_at,expires_at
          ) VALUES(${previewToken},${actor.sub},${activityId},${String(targetRow.sub)},${String(row.ownerSub)},
            ${Number(row.assignmentRevision)},${String(row.updatedAtExact)},now()+interval '10 minutes')
        `);
      });
    }
    return {
      activityId: String(row.id), title: String(row.title), kind: row.kind,
      currentOwner: { sub: String(row.ownerSub), name: String(row.ownerName) },
      targetOwner: { sub: String(targetRow.sub), name: String(targetRow.name) },
      assignmentRevision: Number(row.assignmentRevision), updatedAt, canConfirm, previewToken, blockers,
      impact: {
        stageKey: String(row.stageKey), stageLabel: String(row.stageLabel), closed: Boolean(row.closed),
        awaitingReply: Boolean(row.awaitingReply), createdAt: new Date(row.createdAt).toISOString(),
        historyEventCount: Number(row.historyEventCount), taskCount: Number(row.taskCount), openTaskCount: Number(row.openTaskCount),
        nextOpenTaskDueAt: row.nextOpenTaskDueAt ? new Date(row.nextOpenTaskDueAt).toISOString() : null,
        openTasksWillTransfer: true, completedTaskAttributionWillRemain: true,
      },
    };
  }

  async confirmActivityReassignment(actor: Actor, activityId: string, previewToken: string): Promise<ActivityReassignmentResult> {
    assertManager(actor);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previewToken)) {
      throw new DomainError(400, 'invalid_reassignment_preview', 'Предварительный просмотр истёк или недействителен.');
    }
    const result = await db.transaction(async (tx) => {
      const previewResult = await tx.execute(sql`
        SELECT id,activity_id AS "activityId",target_owner_sub AS "targetOwnerSub",expected_owner_sub AS "expectedOwnerSub",
          expected_assignment_revision AS "expectedAssignmentRevision",expected_updated_at::text AS "expectedUpdatedAt"
        FROM activity_reassignment_previews
        WHERE id=${previewToken} AND manager_sub=${actor.sub} AND activity_id=${activityId} AND expires_at>now()
        FOR UPDATE
      `);
      const preview = top(rowsOf(previewResult));
      if (!preview) return { error: { status: 409, code: 'reassignment_preview_expired', message: 'Предварительный просмотр истёк или уже использован. Создайте новый.' } } as const;
      const activityResult = await tx.execute(sql`
        SELECT a.id,a.kind,a.owner_sub AS "ownerSub",a.owner_name AS "ownerName",a.assignment_revision AS "assignmentRevision",
          a.updated_at AS "updatedAt",(a.updated_at=CAST(${String(preview.expectedUpdatedAt)} AS timestamptz)) AS "updatedAtMatches",
          a.import_owner_only AS "importOwnerOnly",p.import_owner_sub AS "importPersonOwnerSub",
          a.organization_id AS "organizationId",a.payer_organization_id AS "payerOrganizationId"
        FROM activities a LEFT JOIN people p ON p.id=a.person_id
        WHERE a.id=${String(preview.activityId)} AND ${canSee(actor)}
        FOR UPDATE OF a
      `);
      const activity = top(rowsOf(activityResult));
      if (!activity) {
        await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE id=${previewToken}`);
        return { error: { status: 404, code: 'activity_not_found', message: 'Активность не найдена.' } } as const;
      }
      if (String(activity.ownerSub) !== String(preview.expectedOwnerSub)
        || Number(activity.assignmentRevision) !== Number(preview.expectedAssignmentRevision)
        || !activity.updatedAtMatches) {
        await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE id=${previewToken}`);
        return { error: { status: 409, code: 'activity_changed', message: 'Активность изменилась после предварительного просмотра. Обновите карточку и просмотрите назначение заново.' } } as const;
      }
      if (activity.importOwnerOnly || activity.importPersonOwnerSub) {
        await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE id=${previewToken}`);
        return { error: { status: 409, code: 'import_owner_only', message: 'Эта активность связана с личной импортированной записью и остаётся в области исходного КАМ.' } } as const;
      }
      // Share the access-policy gate with revocation/provisioning so an absent
      // (permissive-by-default) row cannot be created or disabled mid-confirmation.
      // This lock is taken before the known-user and KAM-directory row locks below.
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext('crm-access-policy'))`);
      // Lock an existing access-policy row so a concurrent disable serializes
      // with confirmation. A missing overlay row remains permissive by default.
      const policyResult = await tx.execute(sql`
        SELECT disabled_at,allowed_kinds,allowed_organization_ids FROM known_crm_users WHERE user_sub=${String(preview.targetOwnerSub)} FOR SHARE
      `);
      const targetPolicy = top(rowsOf(policyResult));
      if (targetPolicy?.disabled_at) {
        await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE id=${previewToken}`);
        return { error: { status: 409, code: 'target_kam_unavailable', message: 'Выбранный КАМ больше не доступен. Создайте новый предварительный просмотр.' } } as const;
      }
      const targetResult = await tx.execute(sql`
        SELECT kd.user_sub AS sub,kd.display_name AS name
        FROM kam_directory kd
        LEFT JOIN known_crm_users policy ON policy.user_sub=kd.user_sub
        WHERE kd.user_sub=${String(preview.targetOwnerSub)} AND kd.enabled=TRUE
          AND kd.provision_source IN ('local-keycloak-provisioning', 'public-demo-provisioning') AND policy.disabled_at IS NULL
        FOR SHARE OF kd
      `);
      const target = top(rowsOf(targetResult));
      if (!target) {
        await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE id=${previewToken}`);
        return { error: { status: 409, code: 'target_kam_unavailable', message: 'Выбранный КАМ больше не доступен. Создайте новый предварительный просмотр.' } } as const;
      }
      if (Array.isArray(targetPolicy?.allowed_kinds) && !targetPolicy.allowed_kinds.includes(String(activity.kind))) {
        await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE id=${previewToken}`);
        return { error: { status: 409, code: 'target_kam_segment_restricted', message: 'Выбранный КАМ больше не имеет доступа к типу этой активности. Создайте новый предварительный просмотр.' } } as const;
      }
      if (!allowsOrganizations(targetPolicy?.allowed_organization_ids, activity.organizationId, activity.payerOrganizationId)) {
        await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE id=${previewToken}`);
        return { error: { status: 409, code: 'target_kam_organization_restricted', message: 'Выбранный КАМ больше не имеет доступа к организации или плательщику этой активности. Создайте новый предварительный просмотр.' } } as const;
      }
      const now = new Date();
      const openTasks = await tx.execute(sql`
        UPDATE tasks SET owner_sub=${String(target.sub)},owner_name=${String(target.name)}
        WHERE activity_id=${String(activity.id)} AND status='open'
        RETURNING id
      `);
      const completedTasks = await tx.execute(sql`SELECT count(*)::integer AS count FROM tasks WHERE activity_id=${String(activity.id)} AND status='done'`);
      const newRevision = Number(activity.assignmentRevision) + 1;
      await tx.execute(sql`
        UPDATE activities SET owner_sub=${String(target.sub)},owner_name=${String(target.name)},
          assignment_revision=${newRevision},updated_at=${now}
        WHERE id=${String(activity.id)}
      `);
      const eventId = randomUUID();
      await tx.insert(activityEvents).values({
        id: eventId, activityId: String(activity.id), eventType: 'owner_reassigned',
        summary: `Ответственный КАМ изменён: ${String(activity.ownerName)} → ${String(target.name)}`,
        details: {
          previousOwnerSub: String(activity.ownerSub), previousOwnerName: String(activity.ownerName),
          ownerSub: String(target.sub), ownerName: String(target.name), assignmentRevision: newRevision,
          openTasksReassigned: rowsOf(openTasks).length, completedTasksPreserved: Number(top(rowsOf(completedTasks))?.count ?? 0),
          taskDatesAndHistoryPreserved: true,
        },
        actorSub: actor.sub, actorName: actor.name, createdAt: now,
      });
      await tx.insert(activityNotifications).values({
        id: randomUUID(), activityId: String(activity.id), eventId,
        recipientSub: String(target.sub), createdAt: now,
      });
      await tx.execute(sql`DELETE FROM activity_reassignment_previews WHERE id=${previewToken}`);
      return {
        value: {
          activityId: String(activity.id),
          previousOwner: { sub: String(activity.ownerSub), name: String(activity.ownerName) },
          owner: { sub: String(target.sub), name: String(target.name) }, assignmentRevision: newRevision,
          updatedAt: now.toISOString(), openTasksReassigned: rowsOf(openTasks).length,
          completedTasksPreserved: Number(top(rowsOf(completedTasks))?.count ?? 0), eventId,
        } satisfies ActivityReassignmentResult,
      } as const;
    });
    if ('error' in result && result.error) throw new DomainError(result.error.status, result.error.code, result.error.message);
    if (!('value' in result)) throw new Error('Activity reassignment completed without a result.');
    return result.value;
  }

  async listActivities(actor: Actor, filters: ActivityFilters): Promise<ActivityPage> {
    const segment = filters.segment === 'university' ? sql`a.kind = 'university'`
      : filters.segment === 'company' ? sql`a.kind = 'corporate'`
        : filters.segment === 'individual' ? sql`a.kind = 'individual'` : sql`TRUE`;
    const collection = filters.collection === 'today' ? sql`
        nt.due_at >= (date_trunc('day', statement_timestamp() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')
        AND nt.due_at < ((date_trunc('day', statement_timestamp() AT TIME ZONE 'Europe/Moscow') + interval '1 day') AT TIME ZONE 'Europe/Moscow')`
      : filters.collection === 'overdue' ? sql`nt.due_at < statement_timestamp()`
        : filters.collection === 'awaiting_reply' ? sql`a.awaiting_reply = TRUE`
          : filters.collection === 'no_next_step' ? sql`nt.id IS NULL` : sql`TRUE`;
    const owner = filters.ownerSub ? sql`a.owner_sub = ${filters.ownerSub}` : sql`TRUE`;
    const product = filters.productId ? sql`EXISTS (
      SELECT 1 FROM activity_products filter_ap WHERE filter_ap.activity_id = a.id AND filter_ap.product_id = ${filters.productId}
    )` : sql`TRUE`;
    const stageKeys = filters.stageKeys?.length ? sql`a.stage_key IN (${sql.join(filters.stageKeys.map((stageKey) => sql`${stageKey}`), sql`, `)})` : sql`TRUE`;
    const routeVersion = filters.routeVersion ? sql`a.route_version = ${filters.routeVersion}` : sql`TRUE`;
    const searchTerm = filters.search?.trim().slice(0, 120) ?? '';
    const search = searchTerm ? sql`(
      position(lower(${searchTerm}) in lower(a.title)) > 0
      OR position(lower(${searchTerm}) in lower(o.name)) > 0
      OR position(lower(${searchTerm}) in lower(p.full_name)) > 0
    )` : sql`TRUE`;
    const result = await db.execute(sql`
      WITH matched AS (
        SELECT a.id, a.kind, a.title, a.origin, a.origin_source AS "originSource", a.origin_reference AS "originReference",
          CASE WHEN a.origin='cms_mock' THEN 'Тестовая среда CMS'
            WHEN a.origin='external_ready' THEN COALESCE(a.origin_source, 'Внешний заказ')
            WHEN EXISTS (SELECT 1 FROM public_demo_intakes pdi WHERE pdi.activity_id=a.id) THEN 'Заявка с сайта'
            ELSE 'Ручная заявка' END AS "originLabel",
          a.route_version AS "routeVersion", a.stage_key AS "stageKey", ws.label AS "stageLabel",
          a.owner_sub AS "ownerSub", a.owner_name AS "ownerName", a.priority, a.awaiting_reply AS "awaitingReply",
          a.created_at AS "createdAt", a.updated_at AS "updatedAt",
          COALESCE((SELECT array_agg(target.label ORDER BY target.ordinal, target.stage_key)
            FROM workflow_transitions wt JOIN workflow_stages target ON target.kind=wt.kind AND target.stage_key=wt.to_key
            WHERE wt.kind=a.kind AND wt.from_key=a.stage_key AND (wt.route_version=a.route_version OR (a.kind<>'individual' AND wt.route_version='legacy'))), ARRAY[]::text[]) AS "allowedNextLabels",
          o.name AS "organizationName", p.full_name AS "personName",
          nt.id AS "nextTaskId", nt.title AS "nextTaskTitle", nt.due_at AS "nextTaskDueAt", nt.status AS "nextTaskStatus"
        FROM activities a
        LEFT JOIN organizations o ON o.id = a.organization_id
        LEFT JOIN people p ON p.id = a.person_id
        JOIN workflow_stages ws ON ws.kind = a.kind AND ws.stage_key = a.stage_key
        LEFT JOIN LATERAL (
          SELECT t.id, t.title, t.due_at, t.status FROM tasks t
          WHERE t.activity_id = a.id AND t.status = 'open' ORDER BY t.due_at ASC, t.created_at ASC, t.id ASC LIMIT 1
        ) nt ON TRUE
        WHERE ${canSee(actor)} AND a.closed = FALSE AND ${segment} AND ${collection} AND ${owner} AND ${product} AND ${stageKeys} AND ${routeVersion} AND ${search}
      ), page AS (
        SELECT matched.*,
          COALESCE((SELECT array_agg(pr.name ORDER BY pr.name) FROM activity_products ap JOIN products pr ON pr.id = ap.product_id WHERE ap.activity_id = matched.id), ARRAY[]::text[]) AS "productNames"
        FROM matched
        ORDER BY matched.priority ASC, matched."nextTaskDueAt" ASC NULLS LAST, matched."updatedAt" DESC, matched.id ASC
        LIMIT ${filters.limit} OFFSET ${filters.offset}
      )
      SELECT (SELECT count(*)::integer FROM matched) AS total,
        COALESCE((SELECT json_agg(page ORDER BY page.priority ASC, page."nextTaskDueAt" ASC NULLS LAST, page."updatedAt" DESC, page.id ASC) FROM page), '[]'::json) AS items
    `);
    const row = top(rowsOf(result));
    return { items: row?.items ?? [], total: Number(row?.total ?? 0), offset: filters.offset, limit: filters.limit };
  }

  async getActivity(actor: Actor, id: string) {
    const result = await db.execute(sql`
      SELECT a.id, a.kind, a.title, a.origin, a.origin_source AS "originSource", a.origin_reference AS "originReference",
        CASE WHEN a.origin='cms_mock' THEN 'Тестовая среда CMS'
          WHEN a.origin='external_ready' THEN COALESCE(a.origin_source, 'Внешний заказ')
          WHEN EXISTS (SELECT 1 FROM public_demo_intakes pdi WHERE pdi.activity_id=a.id) THEN 'Заявка с сайта'
          ELSE 'Ручная заявка' END AS "originLabel",
        a.route_version AS "routeVersion", a.organization_id AS "organizationId", a.person_id AS "personId",
        a.payer_organization_id AS "payerOrganizationId", a.stage_key AS "stageKey", ws.label AS "stageLabel",
        (SELECT revision FROM workflow_config_revisions WHERE kind = a.kind) AS "workflowRevision",
        a.owner_sub AS "ownerSub", a.owner_name AS "ownerName", a.assignment_revision AS "assignmentRevision", a.details_revision AS revision, a.priority, a.awaiting_reply AS "awaitingReply",
        a.closed, a.created_at AS "createdAt", a.updated_at AS "updatedAt",
        o.name AS "organizationName", o.segment AS "organizationSegment", p.full_name AS "personName", p.email, p.phone,
        payer.name AS "payerOrganizationName",
        COALESCE((SELECT array_agg(wt.to_key ORDER BY target.ordinal, target.stage_key)
          FROM workflow_transitions wt
          JOIN workflow_stages target ON target.kind = wt.kind AND target.stage_key = wt.to_key
          WHERE wt.kind = a.kind AND wt.route_version = a.route_version AND wt.from_key = a.stage_key), ARRAY[]::text[]) AS "allowedNext",
        COALESCE((SELECT array_agg(pr.name ORDER BY pr.name) FROM activity_products ap JOIN products pr ON pr.id = ap.product_id WHERE ap.activity_id = a.id), ARRAY[]::text[]) AS "productNames",
        COALESCE((SELECT json_agg(json_build_object('id',pr.id,'name',pr.name,'catalogVisible',pr.catalog_visible) ORDER BY pr.name,pr.id) FROM activity_products ap JOIN products pr ON pr.id=ap.product_id WHERE ap.activity_id=a.id), '[]'::json) AS "productLinks",
        COALESCE((SELECT array_agg(ap.product_id::text ORDER BY ap.product_id) FROM activity_products ap WHERE ap.activity_id = a.id), ARRAY[]::text[]) AS "productIds",
        COALESCE((SELECT array_agg(lp.name ORDER BY lp.name) FROM activity_programs apr JOIN learning_programs lp ON lp.id=apr.program_id WHERE apr.activity_id=a.id), ARRAY[]::text[]) AS "programNames",
        COALESCE((SELECT array_agg(apr.program_id::text ORDER BY apr.program_id) FROM activity_programs apr WHERE apr.activity_id=a.id), ARRAY[]::text[]) AS "programIds",
        COALESCE((SELECT json_agg(json_build_object('id',t.id,'title',t.title,'dueAt',t.due_at,'status',t.status,'ownerName',t.owner_name) ORDER BY t.due_at ASC) FROM tasks t WHERE t.activity_id = a.id), '[]'::json) AS tasks
      FROM activities a
      LEFT JOIN organizations o ON o.id = a.organization_id
      LEFT JOIN people p ON p.id = a.person_id
      LEFT JOIN organizations payer ON payer.id = a.payer_organization_id
      JOIN workflow_stages ws ON ws.kind = a.kind AND ws.stage_key = a.stage_key
      WHERE a.id = ${id} AND ${canSee(actor)} LIMIT 1`);
    return top(rowsOf(result));
  }

  async createActivity(actor: Actor, input: NewActivity) {
    validateManualActivityOrigin(input);
    assertBusinessAccess(actor);
    assertActivityKindAllowed(actor, input.kind);
    if (actor.allowedOrganizationIds != null) {
      if (input.organizationName?.trim() || input.payerOrganizationName?.trim()) {
        throw new DomainError(403, 'organization_scope_forbidden', 'Нельзя создавать организации в ограниченной области доступа. Выберите разрешённую организацию.');
      }
      if (!includesOrganizationId(actor.allowedOrganizationIds, input.organizationId)
        || !includesOrganizationId(actor.allowedOrganizationIds, input.payerOrganizationId)) {
        throw new DomainError(403, 'organization_scope_forbidden', 'Активность может ссылаться только на разрешённые организации и компании-плательщики.');
      }
    }
    const id = randomUUID();
    const origin = 'manual';
    const routeVersion = input.kind === 'individual' ? 'v2' : 'legacy';
    const initialStageRows = await db.select().from(workflowStages).where(eq(workflowStages.kind, input.kind)).orderBy(asc(workflowStages.ordinal)).limit(1);
    let initialStage = initialStageRows[0];
    if (!initialStage) throw new DomainError(500, 'workflow_missing', 'Для типа активности не настроены стадии.');
    if (initialStage.terminal) throw new DomainError(409, 'workflow_initial_stage_terminal', 'Начальная стадия не может быть завершающей. Исправьте схему и повторите действие.');
    return db.transaction(async (tx) => {
      if (input.kind === 'university') {
        const revisionLock = await tx.execute(sql`SELECT revision FROM workflow_config_revisions WHERE kind = 'university' FOR SHARE`);
        if (!top(rowsOf(revisionLock))) throw new DomainError(500, 'workflow_revision_missing', 'Не найдена версия общей схемы вузов. Примените миграции базы данных.');
        const currentInitialStage = await tx.select().from(workflowStages).where(eq(workflowStages.kind, input.kind)).orderBy(asc(workflowStages.ordinal)).limit(1);
        initialStage = currentInitialStage[0];
        if (!initialStage) throw new DomainError(409, 'workflow_missing', 'Для типа активности не настроены стадии. Обновите маршрут и повторите действие.');
        if (initialStage.terminal) throw new DomainError(409, 'workflow_initial_stage_terminal', 'Начальная стадия не может быть завершающей. Обновите маршрут и повторите действие.');
      }
      let organizationId = input.organizationId;
      if (input.organizationName?.trim()) {
        const segment = input.kind === 'university' ? 'university' : 'company';
        const result = await tx.insert(organizations).values({ id: randomUUID(), name: input.organizationName.trim(), segment }).returning({ id: organizations.id });
        organizationId = result[0].id;
      }
      let personId = input.personId;
      let importedPersonOwnerOnly = false;
      if (input.personName?.trim()) {
        const result = await tx.insert(people).values({ id: randomUUID(), fullName: input.personName.trim(), email: input.email?.trim() || null, phone: input.phone?.trim() || null }).returning({ id: people.id });
        personId = result[0].id;
      }
      if (input.personId) {
        const visible = visiblePersonPredicate(actor);
        const person = await tx.execute(sql`SELECT id, import_owner_sub AS "importOwnerSub" FROM people WHERE id = ${input.personId} AND ${visible} LIMIT 1`);
        const personRow = top(rowsOf(person));
        if (!personRow) throw new DomainError(404, 'person_not_found', 'Контактное лицо не найдено или недоступно.');
        importedPersonOwnerOnly = personRow.importOwnerSub !== null;
      }
      let payerOrganizationId = input.payerOrganizationId;
      if (input.payerOrganizationName?.trim()) {
        const result = await tx.insert(organizations).values({ id: randomUUID(), name: input.payerOrganizationName.trim(), segment: 'company' }).returning({ id: organizations.id });
        payerOrganizationId = result[0].id;
      }
      if (input.organizationId) {
        const visible = hasTeamBusinessScope(actor) ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM activities assigned WHERE assigned.owner_sub = ${actor.sub} AND (assigned.organization_id = organizations.id OR assigned.payer_organization_id = organizations.id))`;
        const org = await tx.execute(sql`SELECT id FROM organizations WHERE id = ${input.organizationId} AND ${visible} LIMIT 1`);
        const row = top(rowsOf(org));
        if (!row) throw new DomainError(404, 'organization_not_found', 'Организация не найдена или недоступна.');
      }
      if (input.payerOrganizationId) {
        const visible = hasTeamBusinessScope(actor) ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM activities assigned WHERE assigned.owner_sub = ${actor.sub} AND (assigned.organization_id = organizations.id OR assigned.payer_organization_id = organizations.id))`;
        const payer = await tx.execute(sql`SELECT id FROM organizations WHERE id = ${input.payerOrganizationId} AND ${visible} LIMIT 1`);
        const row = top(rowsOf(payer));
        if (!row) throw new DomainError(404, 'organization_not_found', 'Организация-плательщик не найдена или недоступна.');
      }
      const programIds = input.programIds ?? [];
      if (programIds.length) {
        const requestedIds = sql.join(programIds.map((programId) => sql`${programId}::uuid`), sql`, `);
        const found = await tx.execute(sql`SELECT id FROM learning_programs WHERE id IN (${requestedIds})`);
        if (rowsOf(found).length !== programIds.length) throw new DomainError(404, 'program_not_found', 'Одна или несколько учебных программ не найдены. Обновите список.');
      }
      const productIds = input.productIds ?? [];
      if (productIds.length) {
        const requestedIds = sql.join(productIds.map((productId) => sql`${productId}::uuid`), sql`, `);
        const available = await tx.execute(sql`SELECT id FROM products WHERE id IN (${requestedIds}) AND catalog_visible=true`);
        if (rowsOf(available).length !== productIds.length) throw new DomainError(404, 'product_not_found', 'Один или несколько продуктов недоступны в каталоге. Обновите список.');
      }
      const activity = await tx.insert(activities).values({
        id, kind: input.kind, title: input.title.trim(), organizationId: organizationId ?? null,
        personId: personId ?? null, payerOrganizationId: payerOrganizationId ?? null,
        importOwnerOnly: importedPersonOwnerOnly,
        origin, originSource: null, originReference: null,
        routeVersion,
        stageKey: initialStage.key, ownerSub: actor.sub, ownerName: actor.name,
        priority: input.priority ?? 3,
      }).returning({ id: activities.id });
      if (productIds.length) await tx.insert(activityProducts).values(productIds.map((productId) => ({ activityId: id, productId })));
      if (programIds.length) await tx.insert(activityPrograms).values(programIds.map((programId) => ({ activityId: id, programId })));
      await tx.insert(activityEvents).values({ id: randomUUID(), activityId: id, eventType: 'created', summary: 'Создана активность', details: { kind: input.kind, origin, routeVersion, initialStage: initialStage.key, productIds, programIds }, actorSub: actor.sub, actorName: actor.name });
      return { id: activity[0].id, kind: input.kind, title: input.title.trim(), origin, originSource: null, originReference: null, routeVersion, stageKey: initialStage.key, stageLabel: initialStage.label, ownerName: actor.name, programIds };
    });
  }

  async updateActivityDetails(actor: Actor, activityId: string, input: ActivityDetailsUpdate) {
    assertBusinessAccess(actor);
    return db.transaction(async (tx) => {
      const scope = await tx.execute(sql`
        SELECT a.id, a.kind, a.closed, a.stage_key AS "stageKey", a.owner_sub AS "ownerSub", a.import_owner_only AS "importOwnerOnly",
          a.person_id AS "personId", a.priority, a.details_revision AS revision, a.updated_at AS "updatedAt"
        FROM activities a WHERE a.id=${activityId} AND ${canSee(actor)} FOR UPDATE
      `);
      const activity = top(rowsOf(scope));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      assertActivityKindAllowed(actor, activity.kind);
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённую активность можно только просматривать.');
      if (Number(activity.revision) !== input.expectedRevision) throw new DomainError(409, 'activity_revision_conflict', 'Основные сведения активности уже изменились. Обновите карточку.');
      const hasPersonId = Object.hasOwn(input, 'personId');
      const hasNewPerson = Object.hasOwn(input, 'newPerson');
      if (hasPersonId === hasNewPerson) throw new DomainError(400, 'activity_contact_selection_invalid', 'Выберите существующий контакт, очистите его или укажите данные нового контакта.');

      let nextPersonId: string | null = input.personId ?? null;
      let importedContact = false;
      const newPersonCreated = hasNewPerson;
      if (hasNewPerson) {
        const contact = input.newPerson;
        if (!contact || !contact.fullName?.trim() || contact.fullName.trim().length > 180 || /[\u0000-\u001f\u007f]/.test(contact.fullName)) {
          throw new DomainError(400, 'invalid_activity_contact', 'Укажите имя нового контакта (до 180 символов).');
        }
        const createdPerson = await tx.insert(people).values({
          id: randomUUID(), fullName: contact.fullName.trim(), email: contact.email?.trim() || null, phone: contact.phone?.trim() || null,
        }).returning({ id: people.id });
        nextPersonId = createdPerson[0].id;
      }
      if (activity.kind === 'individual' && nextPersonId === null) {
        throw new DomainError(400, 'person_required', 'Для активности физлица контакт обязателен.');
      }

      if (!newPersonCreated && nextPersonId !== null) {
        const visible = visiblePersonPredicate(actor);
        const personResult = await tx.execute(sql`
          SELECT id, import_owner_sub AS "importOwnerSub" FROM people
          WHERE id=${nextPersonId} AND ${visible} LIMIT 1
        `);
        const person = top(rowsOf(personResult));
        if (!person) throw new DomainError(404, 'person_not_found', 'Контактное лицо не найдено или недоступно.');
        if (person.importOwnerSub !== null && person.importOwnerSub !== activity.ownerSub) {
          throw new DomainError(409, 'import_contact_owner_conflict', 'Личный импортированный контакт можно связать только с собственной активностью.');
        }
        importedContact = person.importOwnerSub !== null;
      }

      const productIds = [...input.productIds].sort();
      const priorProductsResult = await tx.execute(sql`
        SELECT product_id::text AS id FROM activity_products WHERE activity_id=${activityId} ORDER BY product_id
      `);
      const priorProductIds = rowsOf(priorProductsResult).map((row) => row.id as string);
      if (productIds.length) {
        const requestedIds = sql.join(productIds.map((productId) => sql`${productId}::uuid`), sql`, `);
        const existingIds = sql.join(priorProductIds.map((productId) => sql`${productId}::uuid`), sql`, `);
        const productResult = await tx.execute(sql`SELECT id::text AS id FROM products WHERE id IN (${requestedIds}) AND (catalog_visible=true${priorProductIds.length ? sql` OR id IN (${existingIds})` : sql``})`);
        if (rowsOf(productResult).length !== productIds.length) throw new DomainError(404, 'product_not_found', 'Один или несколько продуктов не найдены.');
      }
      const priorProgramsResult = await tx.execute(sql`SELECT program_id::text AS id FROM activity_programs WHERE activity_id=${activityId} ORDER BY program_id`);
      const priorProgramIds = rowsOf(priorProgramsResult).map((row) => row.id as string);
      const programIds = input.programIds === undefined ? priorProgramIds : [...input.programIds].sort();
      if (input.programIds !== undefined && programIds.length) {
        const requestedIds = sql.join(programIds.map((programId) => sql`${programId}::uuid`), sql`, `);
        const programResult = await tx.execute(sql`SELECT id::text AS id FROM learning_programs WHERE id IN (${requestedIds})`);
        if (rowsOf(programResult).length !== programIds.length) throw new DomainError(404, 'program_not_found', 'Одна или несколько программ не найдены.');
      }
      const programsChanged = priorProgramIds.length !== programIds.length || priorProgramIds.some((id, index) => id !== programIds[index]);
      const personIdChanged = activity.personId !== nextPersonId;
      const priorityChanged = Number(activity.priority) !== input.priority;
      const productsChanged = priorProductIds.length !== productIds.length || priorProductIds.some((id, index) => id !== productIds[index]);
      if (!personIdChanged && !priorityChanged && !productsChanged && !programsChanged) {
        return {
          id: activityId, personId: activity.personId, productIds: priorProductIds, programIds: priorProgramIds,
          priority: Number(activity.priority), revision: Number(activity.revision),
          stageKey: activity.stageKey, updatedAt: new Date(activity.updatedAt).toISOString(),
        };
      }

      const nextRevision = Number(activity.revision) + 1;
      const now = new Date();
      const updated = await tx.update(activities).set({
        personId: nextPersonId,
        importOwnerOnly: activity.importOwnerOnly || importedContact,
        priority: input.priority,
        detailsRevision: nextRevision,
        updatedAt: now,
      }).where(eq(activities.id, activityId)).returning({ updatedAt: activities.updatedAt });
      await tx.delete(activityProducts).where(eq(activityProducts.activityId, activityId));
      if (productIds.length) await tx.insert(activityProducts).values(productIds.map((productId) => ({ activityId, productId })));
      if (programsChanged) {
        await tx.delete(activityPrograms).where(eq(activityPrograms.activityId, activityId));
        if (programIds.length) await tx.insert(activityPrograms).values(programIds.map((programId) => ({ activityId, programId })));
      }

      const changes = {
        ...(personIdChanged ? { personId: { from: activity.personId, to: nextPersonId } } : {}),
        ...(productsChanged ? { productIds: { from: priorProductIds, to: productIds } } : {}),
        ...(programsChanged ? { programIds: { from: priorProgramIds, to: programIds } } : {}),
        ...(priorityChanged ? { priority: { from: Number(activity.priority), to: input.priority } } : {}),
      };
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId, eventType: 'activity_details_updated',
        summary: 'Обновлены основные сведения активности',
        details: { revision: nextRevision, ...(newPersonCreated ? { contactCreated: true } : {}), changes }, actorSub: actor.sub, actorName: actor.name,
      });
      return {
        id: activityId, personId: nextPersonId, productIds, programIds, priority: input.priority,
        revision: nextRevision, stageKey: activity.stageKey,
        updatedAt: new Date(updated[0].updatedAt).toISOString(),
      };
    });
  }

  async getWorkflow() {
    const stages = await db.select().from(workflowStages).orderBy(asc(workflowStages.kind), asc(workflowStages.ordinal));
    const transitions = await db.select().from(workflowTransitions);
    return stages.map((stage) => {
      const outgoing = transitions.filter((transition) => transition.kind === stage.kind && transition.fromKey === stage.key);
      return {
        ...stage,
        allowedNext: [...new Set(outgoing.map((transition) => transition.toKey))],
        allowedNextByRoute: {
          legacy: outgoing.filter((transition) => transition.routeVersion === 'legacy').map((transition) => transition.toKey),
          v2: outgoing.filter((transition) => transition.routeVersion === 'v2').map((transition) => transition.toKey),
        },
      };
    });
  }

  private async readUniversityWorkflowState(executor: { execute(query: any): Promise<unknown> }, lockActivities = false, includeActivities = true): Promise<UniversityWorkflowState> {
    const revisionResult = await executor.execute(sql`SELECT revision FROM workflow_config_revisions WHERE kind = 'university'`);
    const revisionRow = top(rowsOf(revisionResult));
    if (!revisionRow) throw new DomainError(500, 'workflow_revision_missing', 'Не найдена версия общей схемы вузов. Примените миграции базы данных.');
    const stageResult = await executor.execute(sql`
      SELECT stage_key AS key, label, ordinal, terminal FROM workflow_stages
      WHERE kind = 'university' ORDER BY ordinal, stage_key`);
    const transitionResult = await executor.execute(sql`
      SELECT DISTINCT from_key AS "from", to_key AS "to" FROM workflow_transitions
      WHERE kind = 'university' ORDER BY from_key, to_key`);
    const activityResult = !includeActivities ? { rows: [] }
      : lockActivities ? await executor.execute(sql`
        SELECT a.id, a.title, a.owner_sub AS "ownerSub", a.owner_name AS "ownerName", a.import_owner_only AS "importOwnerOnly",
          a.organization_id AS "organizationId", a.payer_organization_id AS "payerOrganizationId", a.stage_key AS "stageKey", ws.label AS "stageLabel", a.closed
        FROM activities a JOIN workflow_stages ws ON ws.kind = a.kind AND ws.stage_key = a.stage_key
        WHERE a.kind = 'university' ORDER BY a.id FOR UPDATE OF a`)
      : await executor.execute(sql`
        SELECT a.id, a.title, a.owner_sub AS "ownerSub", a.owner_name AS "ownerName", a.import_owner_only AS "importOwnerOnly",
          a.organization_id AS "organizationId", a.payer_organization_id AS "payerOrganizationId", a.stage_key AS "stageKey", ws.label AS "stageLabel", a.closed
        FROM activities a JOIN workflow_stages ws ON ws.kind = a.kind AND ws.stage_key = a.stage_key
        WHERE a.kind = 'university' ORDER BY a.id`);
    return {
      revision: Number(revisionRow.revision),
      stages: rowsOf(stageResult).map((stage) => ({ key: stage.key, label: stage.label, ordinal: Number(stage.ordinal), terminal: stage.terminal })),
      transitions: rowsOf(transitionResult).map((edge) => ({ from: edge.from, to: edge.to })),
      activities: rowsOf(activityResult).map((activity) => ({
        id: activity.id, title: activity.title, ownerSub: activity.ownerSub, ownerName: activity.ownerName, importOwnerOnly: activity.importOwnerOnly,
        organizationId: activity.organizationId, payerOrganizationId: activity.payerOrganizationId, stageKey: activity.stageKey, stageLabel: activity.stageLabel, closed: activity.closed,
      })) as UniversityWorkflowState['activities'],
    };
  }

  async getUniversityWorkflowAdmin(actor: Actor) {
    assertAdmin(actor);
    const state = await this.readUniversityWorkflowState(db, false, false);
    return { kind: 'university', revision: state.revision, stages: state.stages, transitions: state.transitions };
  }

  async previewUniversityWorkflow(actor: Actor, input: UniversityWorkflowChange) {
    assertAdmin(actor);
    const state = await this.readUniversityWorkflowState(db);
    const preview = previewUniversityWorkflow(state, input);
    const visible = new Set(state.activities.filter((activity) => this.workflowActivityVisible(actor, activity)).map((activity) => activity.id));
    return {
      ...preview,
      impactedActivities: preview.impactedActivities.map(({ ownerSub: _ownerSub, importOwnerOnly: _importOwnerOnly, ...activity }) =>
        visible.has(activity.id) ? activity : { ...activity, title: null, ownerName: null }),
    };
  }

  private workflowActivityVisible(actor: Actor, activity: UniversityWorkflowState['activities'][number]) {
    const roleVisible = hasTeamBusinessScope(actor) ? (!activity.importOwnerOnly || activity.ownerSub === actor.sub) : activity.ownerSub === actor.sub;
    return roleVisible && (actor.allowedKinds == null || actor.allowedKinds.includes('university'))
      && allowsOrganizations(actor.allowedOrganizationIds, activity.organizationId, activity.payerOrganizationId);
  }

  async applyUniversityWorkflow(actor: Actor, rawInput: UniversityWorkflowApply) {
    assertAdmin(actor);
    if (!/^[a-f0-9]{64}$/.test(rawInput.previewToken)) throw new DomainError(400, 'invalid_workflow_preview_token', 'Создайте предпросмотр перед применением схемы.');
    const input = normalizeUniversityWorkflowChange(rawInput);
    return db.transaction(async (tx) => {
      const revisionResult = await tx.execute(sql`SELECT revision FROM workflow_config_revisions WHERE kind = 'university' FOR UPDATE`);
      const revisionRow = top(rowsOf(revisionResult));
      if (!revisionRow) throw new DomainError(500, 'workflow_revision_missing', 'Не найдена версия общей схемы вузов. Примените миграции базы данных.');
      if (Number(revisionRow.revision) !== input.expectedRevision) throw new DomainError(409, 'workflow_revision_conflict', 'Схема уже изменилась. Обновите её и создайте новый предпросмотр.');

      const state = await this.readUniversityWorkflowState(tx, true);
      const preview = previewUniversityWorkflow(state, input);
      if (preview.previewToken !== rawInput.previewToken) throw new DomainError(409, 'workflow_preview_stale', 'После предпросмотра изменились схема или вузовские активности. Создайте новый предпросмотр.');
      if (!preview.canApply) throw new DomainError(409, 'workflow_preview_blocked', 'Предпросмотр содержит блокировки. Исправьте сопоставление или схему и создайте новый предпросмотр.');

      const currentKeys = new Set(state.stages.map((stage) => stage.key));
      const targetStageByKey = new Map(input.stages.map((stage) => [stage.key, stage]));
      const now = new Date();
      const changedActivities = (preview.impactedActivities as Record<string, any>[]).filter((activity) => activity.changeRequired);

      // Move ordinals into a private range first so swaps/reordering never collide with the unique index.
      await tx.execute(sql`
        WITH ordered AS (
          SELECT id, row_number() OVER (ORDER BY stage_key) AS row_number
          FROM workflow_stages WHERE kind = 'university'
        )
        UPDATE workflow_stages AS stage SET ordinal = (-30000 + ordered.row_number)::smallint
        FROM ordered WHERE stage.id = ordered.id`);

      for (const [index, stage] of input.stages.entries()) {
        if (!currentKeys.has(stage.key)) {
          await tx.insert(workflowStages).values({
            id: randomUUID(), kind: 'university', key: stage.key, label: stage.label,
            ordinal: -31000 - index, terminal: stage.terminal,
          });
        }
      }

      await tx.execute(sql`DELETE FROM workflow_transitions WHERE kind = 'university'`);
      for (const activity of changedActivities) {
        const targetKey = activity.targetStageKey as string;
        const target = targetStageByKey.get(targetKey)!;
        await tx.update(activities).set({ stageKey: targetKey, updatedAt: now }).where(eq(activities.id, activity.id as string));
        await tx.insert(activityEvents).values({
          id: randomUUID(), activityId: activity.id as string, eventType: 'workflow_stage_migrated',
          summary: `Стадия перенесена: ${activity.stageLabel} → ${target.label}`,
          details: {
            fromKey: activity.stageKey, fromLabel: activity.stageLabel,
            toKey: target.key, toLabel: target.label, workflowRevision: input.expectedRevision + 1,
            closedPreserved: activity.closed,
          },
          actorSub: actor.sub, actorName: actor.name,
        });
      }

      const nextKeys = new Set(input.stages.map((stage) => stage.key));
      for (const oldStage of state.stages) {
        if (!nextKeys.has(oldStage.key)) {
          await tx.delete(workflowStages).where(and(eq(workflowStages.kind, 'university'), eq(workflowStages.key, oldStage.key)));
        }
      }
      for (const stage of input.stages) {
        await tx.update(workflowStages).set({ label: stage.label, ordinal: stage.ordinal, terminal: stage.terminal })
          .where(and(eq(workflowStages.kind, 'university'), eq(workflowStages.key, stage.key)));
      }
      for (const edge of input.transitions) {
        await tx.insert(workflowTransitions).values({ id: randomUUID(), kind: 'university', routeVersion: 'legacy', fromKey: edge.from, toKey: edge.to });
      }
      const updatedRevision = input.expectedRevision + 1;
      await tx.update(workflowConfigRevisions).set({ revision: updatedRevision, updatedBySub: actor.sub, updatedByName: actor.name, updatedAt: now })
        .where(eq(workflowConfigRevisions.kind, 'university'));

      const visible = new Set(state.activities.filter((activity) => this.workflowActivityVisible(actor, activity)).map((activity) => activity.id));
      return {
        kind: 'university', revision: updatedRevision, migratedCount: changedActivities.length,
        preservedClosedCount: changedActivities.filter((activity) => activity.closed).length,
        changedActivities: changedActivities.map((activity) => ({
          id: activity.id, title: visible.has(activity.id) ? activity.title : null, stageKey: activity.targetStageKey,
          stageLabel: activity.targetStageLabel, closed: activity.closed,
        })),
      };
    });
  }

  async createTask(actor: Actor, activityId: string, input: NewTask) {
    return db.transaction(async (tx) => {
      const activityResult = await tx.execute(sql`SELECT a.id, a.closed FROM activities a WHERE a.id = ${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(activityResult));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённая активность доступна только для чтения.');
      const id = randomUUID();
      const dueAt = new Date(input.dueAt);
      const task = await tx.insert(tasks).values({ id, activityId, title: input.title.trim(), dueAt, ownerSub: actor.sub, ownerName: actor.name }).returning();
      await tx.update(activities).set({ updatedAt: new Date() }).where(eq(activities.id, activityId));
      await tx.insert(activityEvents).values({ id: randomUUID(), activityId, eventType: 'task_created', summary: `Поставлено действие: ${input.title.trim()}`, details: { taskId: id, dueAt: dueAt.toISOString() }, actorSub: actor.sub, actorName: actor.name });
      return task[0];
    });
  }

  async activityFeed(actor: Actor, input: { limit: number; cursor?: string; actorSub?: string }) {
    const limit = pageLimit(input.limit);
    const cursor = decodePageCursor(input.cursor);
    const isManager = hasTeamBusinessScope(actor);
    if (!isManager && input.actorSub !== undefined && input.actorSub !== actor.sub) {
      throw new DomainError(403, 'feed_actor_forbidden', 'Можно просматривать только события, созданные вами.');
    }
    const authorSub = isManager ? input.actorSub : actor.sub;
    const authorFilter = authorSub === undefined ? sql`TRUE` : sql`e.actor_sub=${authorSub}`;
    const cursorFilter = cursor ? sql`(e.created_at, e.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql`TRUE`;
    const result = await db.execute(sql`
      SELECT e.id, a.id AS "activityId", a.title AS "activityTitle", a.kind,
        e.event_type AS "eventType", e.summary, e.actor_sub AS "actorSub", e.actor_name AS "actorName",
        e.created_at AS "createdAt", e.created_at::text AS "cursorCreatedAt", e.details->>'taskId' AS "taskId",
        CASE WHEN e.event_type='task_updated' THEN e.details->>'text' END AS text
      FROM activity_events e JOIN activities a ON a.id=e.activity_id
      WHERE ${canSee(actor)} AND ${authorFilter} AND ${cursorFilter}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit + 1}
    `);
    const rows = rowsOf(result);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id, activityId: row.activityId, activityTitle: row.activityTitle, kind: row.kind,
        eventType: row.eventType, summary: row.summary, actorSub: row.actorSub, actorName: row.actorName,
        ...(row.text != null ? { text: row.text } : {}),
        createdAt: new Date(row.createdAt).toISOString(), ...(row.taskId ? { taskId: row.taskId } : {}),
      })),
      nextCursor: hasMore && page.length ? encodePageCursor({ createdAt: page[page.length - 1]!.cursorCreatedAt, id: page[page.length - 1]!.id }) : null,
    };
  }

  async taskSubscription(actor: Actor, activityId: string, taskId: string): Promise<{ subscribed: boolean }> {
    const result = await db.execute(sql`
      SELECT EXISTS(SELECT 1 FROM task_subscriptions s WHERE s.activity_id=a.id AND s.task_id=t.id AND s.subscriber_sub=${actor.sub}) AS subscribed
      FROM activities a JOIN tasks t ON t.activity_id=a.id
      WHERE a.id=${activityId} AND t.id=${taskId} AND ${canSee(actor)} LIMIT 1
    `);
    const row = top(rowsOf(result));
    if (!row) throw new DomainError(404, 'task_not_found', 'Действие не найдено.');
    return { subscribed: row.subscribed === true };
  }

  async setTaskSubscription(actor: Actor, activityId: string, taskId: string, subscribed: boolean): Promise<{ subscribed: boolean }> {
    return db.transaction(async (tx) => {
      const activity = top(rowsOf(await tx.execute(sql`SELECT a.id, a.closed FROM activities a WHERE a.id=${activityId} AND ${canSee(actor)} FOR UPDATE`)));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      const task = top(rowsOf(await tx.execute(sql`SELECT t.id FROM tasks t WHERE t.id=${taskId} AND t.activity_id=${activityId} FOR UPDATE`)));
      if (!task) throw new DomainError(404, 'task_not_found', 'Действие не найдено.');
      if (activity.closed && subscribed) throw new DomainError(409, 'activity_closed', 'Завершённую активность можно только просматривать.');
      if (subscribed) {
        await tx.insert(taskSubscriptions).values({ activityId, taskId, subscriberSub: actor.sub }).onConflictDoNothing();
      } else {
        await tx.delete(taskSubscriptions).where(and(eq(taskSubscriptions.activityId, activityId), eq(taskSubscriptions.taskId, taskId), eq(taskSubscriptions.subscriberSub, actor.sub)));
      }
      return { subscribed };
    });
  }

  async createTaskUpdate(actor: Actor, activityId: string, taskId: string, rawText: string): Promise<Record<string, unknown>> {
    const text = rawText.trim();
    if (!text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new DomainError(400, 'invalid_task_update', 'Текст обновления должен содержать от 1 до 2000 допустимых символов.');
    }
    return db.transaction(async (tx) => {
      const activity = top(rowsOf(await tx.execute(sql`SELECT a.id, a.closed FROM activities a WHERE a.id=${activityId} AND ${canSee(actor)} FOR UPDATE`)));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённую активность можно только просматривать.');
      const task = top(rowsOf(await tx.execute(sql`SELECT t.id, t.title, t.status FROM tasks t WHERE t.id=${taskId} AND t.activity_id=${activityId} FOR UPDATE`)));
      if (!task) throw new DomainError(404, 'task_not_found', 'Действие не найдено.');
      const eventId = randomUUID();
      const summary = `Обновление по действию «${String(task.title).slice(0, 180)}»`;
      const now = new Date();
      await tx.insert(activityEvents).values({ id: eventId, activityId, eventType: 'task_updated', summary, details: { taskId, text }, actorSub: actor.sub, actorName: actor.name });
      await tx.update(activities).set({ updatedAt: now }).where(eq(activities.id, activityId));
      await notifyTaskSubscribers(tx, { activityId, taskId, eventId, actorSub: actor.sub });
      return { id: eventId, activityId, taskId, eventType: 'task_updated', summary, text, actorSub: actor.sub, actorName: actor.name, createdAt: now.toISOString() };
    });
  }

  async notifications(actor: Actor, input: { limit: number; cursor?: string }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null; unreadCount: number }> {
    const limit = pageLimit(input.limit);
    const cursor = decodePageCursor(input.cursor);
    const cursorFilter = cursor ? sql`(n.created_at, n.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql`TRUE`;
    return db.transaction(async (tx) => {
      const unreadResult = await tx.execute(sql`
        SELECT count(*)::integer AS count FROM activity_notifications n JOIN activities a ON a.id=n.activity_id
        WHERE n.recipient_sub=${actor.sub} AND n.read_at IS NULL AND ${canSee(actor)}
      `);
      const unreadCount = Number(top(rowsOf(unreadResult))?.count ?? 0);
      const result = await tx.execute(sql`
        SELECT n.id, a.id AS "activityId", a.title AS "activityTitle", n.task_id AS "taskId",
          e.event_type AS "eventType", e.summary, e.actor_name AS "actorName",
          CASE WHEN e.event_type='task_updated' THEN e.details->>'text' END AS text,
          n.created_at AS "createdAt", n.created_at::text AS "cursorCreatedAt", n.read_at AS "readAt"
        FROM activity_notifications n JOIN activities a ON a.id=n.activity_id
        JOIN activity_events e ON e.id=n.event_id
        WHERE n.recipient_sub=${actor.sub} AND ${canSee(actor)} AND ${cursorFilter}
        ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit + 1}
      `);
      const rows = rowsOf(result);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => ({
          id: row.id, activityId: row.activityId, activityTitle: row.activityTitle, taskId: row.taskId,
          eventType: row.eventType, summary: row.summary, actorName: row.actorName,
          ...(row.text != null ? { text: row.text } : {}),
          createdAt: new Date(row.createdAt).toISOString(), readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
        })),
        nextCursor: hasMore && page.length ? encodePageCursor({ createdAt: String(page[page.length - 1]!.cursorCreatedAt), id: String(page[page.length - 1]!.id) }) : null,
        unreadCount,
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async markNotificationRead(actor: Actor, notificationId: string): Promise<{ id: string; readAt: string }> {
    return db.transaction(async (tx) => {
      const row = top(rowsOf(await tx.execute(sql`
        SELECT n.id, n.read_at AS "readAt" FROM activity_notifications n JOIN activities a ON a.id=n.activity_id
        WHERE n.id=${notificationId} AND n.recipient_sub=${actor.sub} AND ${canSee(actor)} FOR UPDATE OF n, a
      `)));
      if (!row) throw new DomainError(404, 'notification_not_found', 'Уведомление не найдено.');
      const readAt = row.readAt ? new Date(row.readAt) : new Date();
      if (!row.readAt) await tx.update(activityNotifications).set({ readAt }).where(eq(activityNotifications.id, notificationId));
      return { id: row.id, readAt: readAt.toISOString() };
    });
  }

  async getGuidanceFeedback(actor: Actor, activityId: string, recommendationKey: string): Promise<GuidanceFeedback | null> {
    const result = await db.execute(sql`
      SELECT f.action, f.reason, f.deferred_until AS "deferredUntil", f.updated_at AS "updatedAt"
      FROM guidance_feedback f JOIN activities a ON a.id = f.activity_id
      WHERE f.activity_id = ${activityId} AND f.actor_sub = ${actor.sub}
        AND f.recommendation_key = ${recommendationKey} AND ${canSee(actor)}
    `);
    const row = top(rowsOf(result));
    if (!row) return null;
    return {
      action: row.action,
      reason: row.reason,
      deferredUntil: row.deferredUntil ? new Date(row.deferredUntil).toISOString() : null,
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  async saveGuidanceFeedback(actor: Actor, activityId: string, recommendationKey: string, action: GuidanceFeedbackAction, reason: string | null): Promise<GuidanceFeedback> {
    return db.transaction(async (tx) => {
      const activityResult = await tx.execute(sql`SELECT a.id, a.closed FROM activities a WHERE a.id = ${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(activityResult));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённую активность можно только просматривать.');
      const now = new Date();
      const deferredUntil = action === 'defer' ? new Date(now.valueOf() + 24 * 60 * 60 * 1000) : null;
      const result = await tx.execute(sql`
        INSERT INTO guidance_feedback(activity_id, actor_sub, recommendation_key, action, reason, deferred_until, updated_at)
        VALUES (${activityId}, ${actor.sub}, ${recommendationKey}, ${action}, ${reason}, ${deferredUntil}, ${now})
        ON CONFLICT (activity_id, actor_sub, recommendation_key) DO UPDATE SET
          action = EXCLUDED.action, reason = EXCLUDED.reason,
          deferred_until = EXCLUDED.deferred_until, updated_at = EXCLUDED.updated_at
        RETURNING action, reason, deferred_until AS "deferredUntil", updated_at AS "updatedAt"
      `);
      const row = top(rowsOf(result));
      if (!row) throw new Error('Guidance feedback upsert returned no row');
      return {
        action: row.action,
        reason: row.reason,
        deferredUntil: row.deferredUntil ? new Date(row.deferredUntil).toISOString() : null,
        updatedAt: new Date(row.updatedAt).toISOString(),
      };
    });
  }

  private async lockGuidanceStageSnapshot(executor: { execute(query: any): Promise<unknown> }, kind: string, stageKey: string): Promise<GuidanceStageSnapshot> {
    // University workflow edits serialize on this row, so publication cannot
    // bind against a half-applied stage graph.
    if (kind === 'university') {
      const revision = top(rowsOf(await executor.execute(sql`SELECT revision FROM workflow_config_revisions WHERE kind = 'university' FOR SHARE`)));
      if (!revision) throw new DomainError(500, 'workflow_revision_missing', 'Не найдена версия общей схемы вузов. Примените миграции базы данных.');
    }
    const stage = top(rowsOf(await executor.execute(sql`
      SELECT stage_key AS key, label, ordinal, terminal FROM workflow_stages
      WHERE kind = ${kind} AND stage_key = ${stageKey} FOR SHARE`)));
    if (!stage) throw new DomainError(409, 'guidance_stage_stale', 'Стадия отсутствует в текущей схеме. Обновите справочник перед сохранением.');
    const edges = rowsOf(await executor.execute(sql`
      SELECT DISTINCT route_version AS "routeVersion", to_key AS "toKey" FROM workflow_transitions
      WHERE kind = ${kind} AND from_key = ${stageKey} ORDER BY route_version, to_key`));
    const allowedNextByRoute = {
      legacy: edges.filter((edge) => edge.routeVersion === 'legacy').map((edge) => edge.toKey),
      v2: edges.filter((edge) => edge.routeVersion === 'v2').map((edge) => edge.toKey),
    };
    return guidanceStageSnapshot({ ...stage, allowedNext: edges.map((edge) => edge.toKey), allowedNextByRoute });
  }

  async getGuidanceCatalog(): Promise<GuidanceCatalogSnapshot> {
    return db.transaction(async (tx) => {
      const stages = rowsOf(await tx.execute(sql`SELECT kind, stage_key AS key, label, ordinal, terminal FROM workflow_stages ORDER BY kind, ordinal, stage_key`));
      const transitions = rowsOf(await tx.execute(sql`SELECT kind, route_version AS "routeVersion", from_key AS "fromKey", to_key AS "toKey" FROM workflow_transitions ORDER BY kind, from_key, route_version, to_key`));
      const articleRows = rowsOf(await tx.execute(sql`
        SELECT kind, stage_key AS "stageKey", seed_stage_snapshot AS "seedStageSnapshot",
          draft_article AS "draftArticle", draft_revision AS "draftRevision", draft_stage_snapshot AS "draftStageSnapshot",
          published_article AS "publishedArticle", published_revision AS "publishedRevision",
          published_stage_snapshot AS "publishedStageSnapshot", published_at AS "publishedAt",
          published_by_name AS "publishedByName", updated_at AS "updatedAt"
        FROM stage_guidance_articles ORDER BY kind, stage_key`));
      const workflow = stages.map((stage) => {
        const outgoing = transitions.filter((transition) => transition.kind === stage.kind && transition.fromKey === stage.key);
        return {
          ...stage,
          allowedNext: [...new Set(outgoing.map((transition) => transition.toKey))],
          allowedNextByRoute: {
            legacy: [...new Set(outgoing.filter((transition) => transition.routeVersion === 'legacy').map((transition) => transition.toKey))],
            v2: [...new Set(outgoing.filter((transition) => transition.routeVersion === 'v2').map((transition) => transition.toKey))],
          },
        };
      });
      return { workflow, articles: articleRows.map(guidanceRecordOf) };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async saveGuidanceDraft(actor: Actor, kind: ActivityKind, stageKey: string, rawArticle: GuidanceArticleContent, expectedRevision: number): Promise<GuidanceEditorialRecord> {
    if (!actor.roles.includes('manager')) throw new DomainError(403, 'forbidden', 'Для редактирования инструкции нужна роль руководителя.');
    const article = validateGuidanceArticleContent(rawArticle);
    return db.transaction(async (tx) => {
      const snapshot = await this.lockGuidanceStageSnapshot(tx, kind, stageKey);
      const existingResult = await tx.execute(sql`SELECT draft_revision AS "draftRevision" FROM stage_guidance_articles WHERE kind = ${kind} AND stage_key = ${stageKey} FOR UPDATE`);
      const existing = top(rowsOf(existingResult));
      const currentRevision = existing ? Number(existing.draftRevision) : 0;
      if (currentRevision !== expectedRevision) throw new DomainError(409, 'guidance_draft_conflict', 'Черновик уже изменился. Обновите его и повторите сохранение.');
      const nextRevision = currentRevision + 1;
      const result = await tx.execute(sql`
        INSERT INTO stage_guidance_articles(kind, stage_key, seed_stage_snapshot, draft_article, draft_revision,
          draft_stage_snapshot, updated_at, updated_by_sub, updated_by_name)
        VALUES (${kind}, ${stageKey}, ${JSON.stringify(snapshot)}::jsonb, ${JSON.stringify(article)}::jsonb, ${nextRevision},
          ${JSON.stringify(snapshot)}::jsonb, now(), ${actor.sub}, ${actor.name})
        ON CONFLICT (kind, stage_key) DO UPDATE SET
          draft_article = EXCLUDED.draft_article, draft_revision = stage_guidance_articles.draft_revision + 1,
          draft_stage_snapshot = EXCLUDED.draft_stage_snapshot, updated_at = now(),
          updated_by_sub = EXCLUDED.updated_by_sub, updated_by_name = EXCLUDED.updated_by_name
        WHERE stage_guidance_articles.draft_revision = ${expectedRevision}
        RETURNING kind, stage_key AS "stageKey", seed_stage_snapshot AS "seedStageSnapshot",
          draft_article AS "draftArticle", draft_revision AS "draftRevision", draft_stage_snapshot AS "draftStageSnapshot",
          published_article AS "publishedArticle", published_revision AS "publishedRevision",
          published_stage_snapshot AS "publishedStageSnapshot", published_at AS "publishedAt",
          published_by_name AS "publishedByName", updated_at AS "updatedAt"`);
      const row = top(rowsOf(result));
      if (!row) throw new DomainError(409, 'guidance_draft_conflict', 'Черновик уже изменился. Обновите его и повторите сохранение.');
      await tx.execute(sql`INSERT INTO stage_guidance_article_events(id, kind, stage_key, action, revision, article, stage_snapshot, actor_sub, actor_name)
        VALUES (${randomUUID()}, ${kind}, ${stageKey}, 'draft_saved', ${nextRevision}, ${JSON.stringify(article)}::jsonb,
          ${JSON.stringify(snapshot)}::jsonb, ${actor.sub}, ${actor.name})`);
      return guidanceRecordOf(row);
    });
  }

  async publishGuidanceArticle(actor: Actor, kind: ActivityKind, stageKey: string, expectedDraftRevision: number): Promise<GuidanceEditorialRecord> {
    if (!actor.roles.includes('admin')) throw new DomainError(403, 'forbidden', 'Для публикации инструкции нужна роль администратора.');
    return db.transaction(async (tx) => {
      const snapshot = await this.lockGuidanceStageSnapshot(tx, kind, stageKey);
      const existing = top(rowsOf(await tx.execute(sql`
        SELECT draft_article AS "draftArticle", draft_revision AS "draftRevision", draft_stage_snapshot AS "draftStageSnapshot"
        FROM stage_guidance_articles WHERE kind = ${kind} AND stage_key = ${stageKey} FOR UPDATE`)));
      if (!existing?.draftArticle || Number(existing.draftRevision) < 1) throw new DomainError(409, 'guidance_draft_missing', 'Сначала сохраните черновик инструкции.');
      if (Number(existing.draftRevision) !== expectedDraftRevision) throw new DomainError(409, 'guidance_draft_conflict', 'Черновик уже изменился. Обновите его перед публикацией.');
      if (!guidanceSnapshotMatches(existing.draftStageSnapshot, snapshot)) throw new DomainError(409, 'guidance_stage_stale', 'Схема изменилась после сохранения черновика. Руководитель должен проверить и повторно сохранить инструкцию.');
      const now = new Date();
      const result = await tx.execute(sql`
        UPDATE stage_guidance_articles SET published_article = draft_article, published_revision = draft_revision,
          published_stage_snapshot = ${JSON.stringify(snapshot)}::jsonb, published_at = ${now},
          published_by_sub = ${actor.sub}, published_by_name = ${actor.name}, updated_at = ${now},
          updated_by_sub = ${actor.sub}, updated_by_name = ${actor.name}
        WHERE kind = ${kind} AND stage_key = ${stageKey} AND draft_revision = ${expectedDraftRevision}
        RETURNING kind, stage_key AS "stageKey", seed_stage_snapshot AS "seedStageSnapshot",
          draft_article AS "draftArticle", draft_revision AS "draftRevision", draft_stage_snapshot AS "draftStageSnapshot",
          published_article AS "publishedArticle", published_revision AS "publishedRevision",
          published_stage_snapshot AS "publishedStageSnapshot", published_at AS "publishedAt",
          published_by_name AS "publishedByName", updated_at AS "updatedAt"`);
      const row = top(rowsOf(result));
      if (!row) throw new DomainError(409, 'guidance_draft_conflict', 'Черновик уже изменился. Обновите его перед публикацией.');
      await tx.execute(sql`INSERT INTO stage_guidance_article_events(id, kind, stage_key, action, revision, article, stage_snapshot, actor_sub, actor_name)
        VALUES (${randomUUID()}, ${kind}, ${stageKey}, 'published', ${expectedDraftRevision}, ${JSON.stringify(row.draftArticle)}::jsonb,
          ${JSON.stringify(snapshot)}::jsonb, ${actor.sub}, ${actor.name})`);
      return guidanceRecordOf(row);
    });
  }

  async completeTask(actor: Actor, activityId: string, taskId: string) {
    return db.transaction(async (tx) => {
      // All task writers lock the activity first, matching reassignment's activity-then-task order.
      const activityResult = await tx.execute(sql`SELECT a.id, a.closed FROM activities a WHERE a.id = ${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(activityResult));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённая активность доступна только для чтения.');
      const result = await tx.execute(sql`
        SELECT t.id, t.status, t.title FROM tasks t JOIN activities a ON a.id=t.activity_id
        WHERE t.id=${taskId} AND t.activity_id=${activityId} AND ${canSee(actor)} FOR UPDATE OF t`);
      const task = top(rowsOf(result));
      if (!task) throw new DomainError(404, 'task_not_found', 'Действие не найдено.');
      if (task.status !== 'open') throw new DomainError(409, 'task_already_done', 'Действие уже выполнено.');
      const now = new Date();
      await tx.update(tasks).set({ status: 'done', completedAt: now }).where(eq(tasks.id, taskId));
      await tx.update(activities).set({ updatedAt: now }).where(eq(activities.id, activityId));
      const eventId = randomUUID();
      await tx.insert(activityEvents).values({ id: eventId, activityId, eventType: 'task_completed', summary: `Выполнено действие: ${task.title}`, details: { taskId }, actorSub: actor.sub, actorName: actor.name });
      await notifyTaskSubscribers(tx, { activityId, taskId, eventId, actorSub: actor.sub });
      return { id: taskId, status: 'done', title: task.title, completedAt: now.toISOString() };
    });
  }

  async recordOutcome(actor: Actor, activityId: string, outcome: Outcome, note: string) {
    return db.transaction(async (tx) => {
      const result = await tx.execute(sql`SELECT a.id, a.stage_key AS "stageKey", a.kind, a.closed FROM activities a WHERE a.id=${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(result));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённая активность доступна только для чтения.');
      if (['cancelled', 'refused'].includes(outcome) && !note.trim()) throw new DomainError(400, 'closure_outcome_reason_required', 'Для отмены или отказа укажите причину.');
      const closureOutcome = ['cancelled', 'refused'].includes(outcome);
      await tx.insert(activityEvents).values({ id: randomUUID(), activityId, eventType: closureOutcome ? 'closure_outcome_recorded' : 'outcome_recorded', summary: `${closureOutcome ? 'Итог завершения' : 'Итог контакта'}: ${outcomeLabels[outcome]}`, details: { outcome, note: note.trim(), ...(closureOutcome ? { stageKey: activity.stageKey } : {}) }, actorSub: actor.sub, actorName: actor.name });
      await tx.update(activities).set({ awaitingReply: outcome === 'awaiting_reply', updatedAt: new Date() }).where(eq(activities.id, activityId));
      return { outcome, note: note.trim(), recordedAt: new Date().toISOString() };
    });
  }

  async transition(actor: Actor, activityId: string, targetStage: string, expectedStageKey: string, expectedWorkflowRevision: number | null) {
    return db.transaction(async (tx) => {
      const workflowRevisionResult = await tx.execute(sql`SELECT revision FROM workflow_config_revisions WHERE kind = 'university' AND EXISTS (
        SELECT 1 FROM activities WHERE id = ${activityId} AND kind = 'university'
      ) FOR SHARE`);
      const workflowRevision = top(rowsOf(workflowRevisionResult));
      const result = await tx.execute(sql`SELECT a.id,a.kind,a.route_version AS "routeVersion",a.stage_key AS "stageKey",a.closed FROM activities a WHERE a.id=${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(result));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённая активность больше не открывается.');
      if (activity.stageKey !== expectedStageKey) throw new DomainError(409, 'transition_stage_conflict', 'Стадия активности уже изменилась. Обновите карточку и выберите переход заново.');
      if (activity.kind === 'university') {
        if (expectedWorkflowRevision === null || !workflowRevision) throw new DomainError(409, 'workflow_revision_required', 'Обновите карточку, чтобы получить актуальную версию маршрута.');
        if (Number(workflowRevision.revision) !== expectedWorkflowRevision) throw new DomainError(409, 'workflow_revision_conflict', 'Общая схема вузов изменилась. Обновите карточку и выберите переход заново.');
      }
      const allowed = await tx.select({ id: workflowTransitions.id }).from(workflowTransitions).where(and(
        eq(workflowTransitions.kind, activity.kind), eq(workflowTransitions.routeVersion, activity.routeVersion), eq(workflowTransitions.fromKey, activity.stageKey), eq(workflowTransitions.toKey, targetStage),
      )).limit(1);
      if (!allowed[0]) throw new DomainError(409, 'transition_not_allowed', 'Этот переход не разрешён текущей схемой.');
      const target = await tx.select({ key: workflowStages.key, label: workflowStages.label, terminal: workflowStages.terminal }).from(workflowStages).where(and(eq(workflowStages.kind, activity.kind), eq(workflowStages.key, targetStage))).limit(1);
      if (!target[0]) throw new DomainError(409, 'transition_not_allowed', 'Целевая стадия отсутствует в схеме.');
      if (activity.kind === 'corporate' && targetStage === 'closed' || activity.kind === 'individual' && activity.routeVersion === 'v2' && targetStage === 'result') {
        const closureEvent = await tx.execute(sql`SELECT 1 FROM activity_events
          WHERE activity_id=${activityId} AND event_type='closure_outcome_recorded'
            AND details->>'stageKey'=${activity.stageKey}
          LIMIT 1`);
        const completedLearning = activity.kind === 'individual' && activity.routeVersion === 'v2'
          ? await tx.select({ id: learningFacts.id }).from(learningFacts).where(and(eq(learningFacts.activityId, activityId), eq(learningFacts.factKind, 'learning_completed'))).limit(1)
          : [];
        const plans = activity.kind === 'corporate'
          ? await tx.select().from(corporateActivityPlans).where(eq(corporateActivityPlans.activityId, activityId)).limit(1)
          : [];
        const plan = plans[0] ? corporatePlanDto(plans[0], false) : null;
        assertHonestCompletion({
          activityKind: activity.kind,
          routeVersion: activity.routeVersion,
          fromStage: activity.stageKey,
          targetStage,
          hasCurrentStageClosureOutcome: rowsOf(closureEvent).length > 0,
          hasLearningCompletedFact: completedLearning.length > 0,
          corporatePlan: plan,
        });
      }
      const now = new Date();
      await tx.update(activities).set({ stageKey: targetStage, closed: target[0].terminal, updatedAt: now }).where(eq(activities.id, activityId));
      await tx.insert(activityEvents).values({ id: randomUUID(), activityId, eventType: 'stage_changed', summary: `Стадия изменена: ${target[0].label}`, details: { from: activity.stageKey, to: targetStage }, actorSub: actor.sub, actorName: actor.name });
      return { id: activityId, from: activity.stageKey, stageKey: targetStage, stageLabel: target[0].label, closed: target[0].terminal };
    });
  }

  async history(actor: Actor, activityId: string) {
    const result = await db.execute(sql`
      SELECT e.id, e.event_type AS "eventType", e.summary, e.details,
        e.actor_sub AS "actorSub", e.actor_name AS "actorName", e.created_at AS "createdAt"
      FROM activities a LEFT JOIN activity_events e ON e.activity_id=a.id
      WHERE a.id=${activityId} AND ${canSee(actor)}
      ORDER BY e.created_at DESC NULLS LAST, e.id DESC
    `);
    const rows = rowsOf(result);
    return rows.length ? rows.filter((row) => row.id !== null) : null;
  }

  async listActivityDocuments(actor: Actor, activityId: string): Promise<ActivityDocument[] | null> {
    const result = await db.execute(sql`
      SELECT d.id, d.activity_id AS "activityId", d.original_name AS name, d.extension, d.media_type AS "mediaType",
        d.size_bytes AS "sizeBytes", d.sha256, d.created_at AS "uploadedAt", d.uploaded_by_name AS "uploadedByName"
      FROM activities a LEFT JOIN activity_documents d ON d.activity_id=a.id
      WHERE a.id=${activityId} AND ${canSee(actor)} ORDER BY d.created_at DESC, d.id DESC
    `);
    const rows = rowsOf(result);
    if (!rows.length) return null;
    return rows.filter((document) => document.id !== null).map((document) => ({ ...document, uploadedAt: new Date(document.uploadedAt).toISOString(), sizeBytes: Number(document.sizeBytes) })) as ActivityDocument[];
  }

  async addActivityDocument(actor: Actor, input: NewActivityDocument): Promise<ActivityDocument> {
    return db.transaction(async (tx) => {
      const scope = await tx.execute(sql`SELECT a.id, a.closed FROM activities a WHERE a.id=${input.activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(scope));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'В закрытую активность нельзя добавлять документы.');
      await tx.insert(activityDocuments).values({
        id: input.id, activityId: input.activityId, objectKey: input.objectKey, originalName: input.name,
        extension: input.extension, mediaType: input.mediaType, sizeBytes: input.sizeBytes,
        sha256: input.sha256, uploadedBySub: actor.sub, uploadedByName: actor.name,
      });
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId: input.activityId, eventType: 'document_uploaded',
        summary: `Добавлен документ: ${input.name}`,
        details: { documentId: input.id, fileName: input.name, extension: input.extension, sizeBytes: input.sizeBytes },
        actorSub: actor.sub, actorName: actor.name,
      });
      const result = await tx.execute(sql`
        SELECT id, activity_id AS "activityId", original_name AS name, extension, media_type AS "mediaType",
          size_bytes AS "sizeBytes", sha256, created_at AS "uploadedAt", uploaded_by_name AS "uploadedByName"
        FROM activity_documents WHERE id=${input.id}
      `);
      const document = top(rowsOf(result));
      if (!document) throw new Error('Inserted activity document was not returned.');
      return { ...document, uploadedAt: new Date(document.uploadedAt).toISOString(), sizeBytes: Number(document.sizeBytes) } as ActivityDocument;
    });
  }

  async getActivityDocumentForDownload(actor: Actor, activityId: string, documentId: string): Promise<StoredActivityDocument | null> {
    const result = await db.execute(sql`
      SELECT d.id, d.activity_id AS "activityId", d.object_key AS "objectKey", d.original_name AS name,
        d.extension, d.media_type AS "mediaType", d.size_bytes AS "sizeBytes", d.sha256,
        d.created_at AS "uploadedAt", d.uploaded_by_name AS "uploadedByName"
      FROM activity_documents d JOIN activities a ON a.id=d.activity_id
      WHERE a.id=${activityId} AND d.id=${documentId} AND ${canSee(actor)} LIMIT 1
    `);
    const document = top(rowsOf(result));
    if (!document) return null;
    return { ...document, uploadedAt: new Date(document.uploadedAt).toISOString(), sizeBytes: Number(document.sizeBytes) } as StoredActivityDocument;
  }

  async recordActivityDocumentDownload(actor: Actor, activityId: string, documentId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT d.original_name AS name FROM activity_documents d JOIN activities a ON a.id=d.activity_id
        WHERE a.id=${activityId} AND d.id=${documentId} AND ${canSee(actor)} FOR SHARE OF a
      `);
      const document = top(rowsOf(result));
      if (!document) return false;
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId, eventType: 'document_downloaded', summary: `Скачан документ: ${document.name}`,
        details: { documentId, fileName: document.name }, actorSub: actor.sub, actorName: actor.name,
      });
      return true;
    });
  }

  async individualLearningFacts(actor: Actor, activityId: string) {
    const activityResult = await db.execute(sql`SELECT a.id, a.kind FROM activities a WHERE a.id = ${activityId} AND ${canSee(actor)} LIMIT 1`);
    const activity = top(rowsOf(activityResult));
    if (!activity) return null;
    if (activity.kind !== 'individual') throw new DomainError(409, 'learning_facts_not_applicable', 'Учебная проекция доступна только для индивидуального обучения.');
    const result = await db.select({
      id: learningFacts.id, factKind: learningFacts.factKind, source: learningFacts.source,
      occurredAt: learningFacts.occurredAt, reference: learningFacts.reference,
    }).from(learningFacts).where(eq(learningFacts.activityId, activityId)).orderBy(asc(learningFacts.occurredAt), asc(learningFacts.id));
    return result.map((fact) => ({ ...fact, occurredAt: fact.occurredAt.toISOString() }));
  }

  async corporatePlan(actor: Actor, activityId: string) {
    const scope = await db.execute(sql`SELECT a.id, a.kind, a.closed FROM activities a WHERE a.id = ${activityId} AND ${canSee(actor)} LIMIT 1`);
    const activity = top(rowsOf(scope));
    if (!activity) return null;
    if (activity.kind !== 'corporate') throw new DomainError(409, 'corporate_plan_not_applicable', 'План программы доступен только для корпоративных активностей.');
    const rows = await db.select().from(corporateActivityPlans).where(eq(corporateActivityPlans.activityId, activityId)).limit(1);
    return corporatePlanDto(rows[0] ?? null, activity.closed);
  }

  async updateCorporatePlan(actor: Actor, activityId: string, input: CorporatePlanInput) {
    return db.transaction(async (tx) => {
      // Serializing on the activity row makes revision 0 safe for two first saves too.
      const scope = await tx.execute(sql`SELECT a.id, a.kind, a.closed FROM activities a WHERE a.id = ${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(scope));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.kind !== 'corporate') throw new DomainError(409, 'corporate_plan_not_applicable', 'План программы доступен только для корпоративных активностей.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Закрытую активность можно только просматривать.');
      const found = await tx.select().from(corporateActivityPlans).where(eq(corporateActivityPlans.activityId, activityId)).limit(1);
      const existing = found[0] ?? null;
      const currentRevision = existing?.revision ?? 0;
      if (input.expectedRevision !== currentRevision) throw new DomainError(409, 'revision_conflict', 'План уже изменился. Обновите карточку и повторите правку.');
      const revision = currentRevision + 1;
      const now = new Date();
      const values = {
        activityId,
        programMode: input.programMode,
        requestedPlaces: input.requestedPlaces,
        brief: input.brief,
        methodologist: input.methodologist,
        proposed: input.proposed,
        agreed: input.agreed,
        approval: input.approval,
        revision,
        updatedAt: now,
        actorSub: actor.sub,
        actorName: actor.name,
      };
      const saved = await tx.insert(corporateActivityPlans).values(values).onConflictDoUpdate({
        target: corporateActivityPlans.activityId,
        set: { programMode: values.programMode, requestedPlaces: values.requestedPlaces, brief: values.brief, methodologist: values.methodologist, proposed: values.proposed, agreed: values.agreed, approval: values.approval, revision, updatedAt: now, actorSub: actor.sub, actorName: actor.name },
      }).returning();
      await tx.update(activities).set({ updatedAt: now }).where(eq(activities.id, activityId));
      const before = corporatePlanDto(existing, false);
      const after = corporatePlanDto(saved[0], false);
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId, eventType: 'corporate_plan_updated',
        summary: `План корпоративной программы обновлён · версия ${revision}`,
        details: { previousRevision: currentRevision, revision, previous: before, current: after },
        actorSub: actor.sub, actorName: actor.name,
      });
      return after;
    });
  }

  async listActivityContractLicenses(actor: Actor, activityId: string): Promise<ActivityContractLicense[] | null> {
    const result = await db.execute(sql`
      SELECT c.id, c.activity_id AS "activityId", c.title, c.contract_reference AS "contractReference",
        c.contract_status AS "contractStatus", c.license_expiry_precision AS "licenseExpiryPrecision",
        c.license_expires_on AS "licenseExpiresOn", c.license_expires_year AS "licenseExpiresYear",
        c.document_id AS "documentId", d.original_name AS "documentName", c.note, c.revision,
        c.updated_at AS "updatedAt", c.actor_name AS "updatedBy", a.closed
      FROM activities a LEFT JOIN activity_contract_licenses c ON c.activity_id=a.id
      LEFT JOIN activity_documents d ON d.id=c.document_id AND d.activity_id=c.activity_id
      WHERE a.id=${activityId} AND ${canSee(actor)}
      ORDER BY c.updated_at DESC NULLS LAST,c.id
    `);
    const rows = rowsOf(result);
    if (!rows.length) return null;
    const closed = Boolean(rows[0].closed);
    return rows.filter((row) => row.id !== null).map((row) => activityContractLicenseDto(row, closed));
  }

  async addActivityContractLicense(actor: Actor, activityId: string, input: ActivityContractLicenseFields): Promise<ActivityContractLicense> {
    validateActivityContractLicense(input);
    return db.transaction(async (tx) => {
      const scope = await tx.execute(sql`SELECT a.id,a.closed FROM activities a WHERE a.id=${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(scope));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Закрытую активность можно только просматривать.');
      if (input.documentId) {
        const document = await tx.execute(sql`SELECT id FROM activity_documents WHERE id=${input.documentId} AND activity_id=${activityId}`);
        if (!rowsOf(document).length) throw new DomainError(400, 'invalid_contract_document', 'Выберите документ, прикреплённый к этой активности.');
      }
      const id = randomUUID();
      const now = new Date();
      await tx.insert(activityContractLicenses).values({
        id, activityId, title: input.title.trim(), contractReference: input.contractReference?.trim() || null,
        contractStatus: input.contractStatus, licenseExpiryPrecision: input.licenseExpiryPrecision,
        licenseExpiresOn: input.licenseExpiresOn, licenseExpiresYear: input.licenseExpiresYear,
        documentId: input.documentId, note: input.note?.trim() || null, revision: 1,
        updatedAt: now, actorSub: actor.sub, actorName: actor.name,
      });
      await tx.update(activities).set({ updatedAt: now }).where(eq(activities.id, activityId));
      const savedResult = await tx.execute(sql`
        SELECT c.id,c.activity_id AS "activityId",c.title,c.contract_reference AS "contractReference",
          c.contract_status AS "contractStatus",c.license_expiry_precision AS "licenseExpiryPrecision",
          c.license_expires_on AS "licenseExpiresOn",c.license_expires_year AS "licenseExpiresYear",
          c.document_id AS "documentId",d.original_name AS "documentName",c.note,c.revision,
          c.updated_at AS "updatedAt",c.actor_name AS "updatedBy"
        FROM activity_contract_licenses c LEFT JOIN activity_documents d ON d.id=c.document_id AND d.activity_id=c.activity_id
        WHERE c.id=${id}
      `);
      const saved = top(rowsOf(savedResult));
      if (!saved) throw new Error('Inserted contract/license context was not returned.');
      const after = activityContractLicenseDto(saved, false);
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId, eventType: 'contract_license_created', summary: `Добавлена запись договора или лицензии: ${after.title}`,
        details: { recordId: id, revision: 1, current: activityContractLicenseSnapshot({ ...after, ...input }) },
        actorSub: actor.sub, actorName: actor.name,
      });
      return after;
    });
  }

  async updateActivityContractLicense(actor: Actor, activityId: string, recordId: string, input: ActivityContractLicenseInput): Promise<ActivityContractLicense> {
    validateActivityContractLicense(input);
    return db.transaction(async (tx) => {
      const scope = await tx.execute(sql`SELECT a.id,a.closed FROM activities a WHERE a.id=${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(scope));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Закрытую активность можно только просматривать.');
      const currentResult = await tx.execute(sql`
        SELECT c.id,c.activity_id AS "activityId",c.title,c.contract_reference AS "contractReference",
          c.contract_status AS "contractStatus",c.license_expiry_precision AS "licenseExpiryPrecision",
          c.license_expires_on AS "licenseExpiresOn",c.license_expires_year AS "licenseExpiresYear",
          c.document_id AS "documentId",d.original_name AS "documentName",c.note,c.revision,
          c.updated_at AS "updatedAt",c.actor_name AS "updatedBy"
        FROM activity_contract_licenses c LEFT JOIN activity_documents d ON d.id=c.document_id AND d.activity_id=c.activity_id
        WHERE c.id=${recordId} AND c.activity_id=${activityId} FOR UPDATE OF c
      `);
      const currentRow = top(rowsOf(currentResult));
      if (!currentRow) throw new DomainError(404, 'contract_license_not_found', 'Запись договора или лицензии не найдена.');
      const current = activityContractLicenseDto(currentRow, false);
      if (current.revision !== input.expectedRevision) throw new DomainError(409, 'revision_conflict', 'Запись уже изменилась. Обновите карточку и повторите правку.');
      if (input.documentId) {
        const document = await tx.execute(sql`SELECT id FROM activity_documents WHERE id=${input.documentId} AND activity_id=${activityId}`);
        if (!rowsOf(document).length) throw new DomainError(400, 'invalid_contract_document', 'Выберите документ, прикреплённый к этой активности.');
      }
      const revision = current.revision + 1;
      const now = new Date();
      await tx.update(activityContractLicenses).set({
        title: input.title.trim(), contractReference: input.contractReference?.trim() || null, contractStatus: input.contractStatus,
        licenseExpiryPrecision: input.licenseExpiryPrecision, licenseExpiresOn: input.licenseExpiresOn,
        licenseExpiresYear: input.licenseExpiresYear, documentId: input.documentId, note: input.note?.trim() || null,
        revision, updatedAt: now, actorSub: actor.sub, actorName: actor.name,
      }).where(eq(activityContractLicenses.id, recordId));
      await tx.update(activities).set({ updatedAt: now }).where(eq(activities.id, activityId));
      const savedResult = await tx.execute(sql`
        SELECT c.id,c.activity_id AS "activityId",c.title,c.contract_reference AS "contractReference",
          c.contract_status AS "contractStatus",c.license_expiry_precision AS "licenseExpiryPrecision",
          c.license_expires_on AS "licenseExpiresOn",c.license_expires_year AS "licenseExpiresYear",
          c.document_id AS "documentId",d.original_name AS "documentName",c.note,c.revision,
          c.updated_at AS "updatedAt",c.actor_name AS "updatedBy"
        FROM activity_contract_licenses c LEFT JOIN activity_documents d ON d.id=c.document_id AND d.activity_id=c.activity_id
        WHERE c.id=${recordId}
      `);
      const savedRow = top(rowsOf(savedResult));
      if (!savedRow) throw new Error('Updated contract/license context was not returned.');
      const after = activityContractLicenseDto(savedRow, false);
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId, eventType: 'contract_license_updated', summary: `Обновлена запись договора или лицензии: ${after.title} · версия ${revision}`,
        details: { recordId, previousRevision: current.revision, revision, previous: activityContractLicenseSnapshot(current), current: activityContractLicenseSnapshot(after) },
        actorSub: actor.sub, actorName: actor.name,
      });
      return after;
    });
  }

  async deleteActivityContractLicense(actor: Actor, activityId: string, recordId: string, expectedRevision: number): Promise<boolean> {
    return db.transaction(async (tx) => {
      const scope = await tx.execute(sql`SELECT a.id,a.closed FROM activities a WHERE a.id=${activityId} AND ${canSee(actor)} FOR UPDATE`);
      const activity = top(rowsOf(scope));
      if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'Закрытую активность можно только просматривать.');
      const result = await tx.execute(sql`
        SELECT c.id,c.activity_id AS "activityId",c.title,c.contract_reference AS "contractReference",
          c.contract_status AS "contractStatus",c.license_expiry_precision AS "licenseExpiryPrecision",
          c.license_expires_on AS "licenseExpiresOn",c.license_expires_year AS "licenseExpiresYear",
          c.document_id AS "documentId",d.original_name AS "documentName",c.note,c.revision,
          c.updated_at AS "updatedAt",c.actor_name AS "updatedBy"
        FROM activity_contract_licenses c LEFT JOIN activity_documents d ON d.id=c.document_id AND d.activity_id=c.activity_id
        WHERE c.id=${recordId} AND c.activity_id=${activityId} FOR UPDATE OF c
      `);
      const row = top(rowsOf(result));
      if (!row) throw new DomainError(404, 'contract_license_not_found', 'Запись договора или лицензии не найдена.');
      const current = activityContractLicenseDto(row, false);
      if (current.revision !== expectedRevision) throw new DomainError(409, 'revision_conflict', 'Запись уже изменилась. Обновите карточку перед удалением.');
      await tx.delete(activityContractLicenses).where(eq(activityContractLicenses.id, recordId));
      const now = new Date();
      await tx.update(activities).set({ updatedAt: now }).where(eq(activities.id, activityId));
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId, eventType: 'contract_license_deleted', summary: `Удалена запись договора или лицензии: ${current.title}`,
        details: { recordId, previousRevision: current.revision, deleted: activityContractLicenseSnapshot(current) },
        actorSub: actor.sub, actorName: actor.name,
      });
      return true;
    });
  }

  async universitySteps(actor: Actor, activityId: string) {
    const result = await db.execute(sql`
      WITH scoped_activity AS (
        SELECT a.id, a.kind, a.closed FROM activities a
        WHERE a.id = ${activityId} AND ${canSee(actor)}
      ), all_steps AS (
        SELECT d.id AS "stepId", d.label, d.description, d.group_key AS "groupKey", d.group_label AS "groupLabel",
          d.ordinal, d.optional, COALESCE(s.status, 'unrecorded') AS status,
          COALESCE(s.note, '') AS note, s.evidence_reference AS "evidenceReference",
          s.evidence_source AS "evidenceSource", s.actor_sub AS "actorSub", s.actor_name AS "actorName",
          s.updated_at AS "updatedAt", COALESCE(s.revision, 0) AS revision
        FROM university_step_definitions d
        LEFT JOIN activity_university_steps s ON s.step_id = d.id AND s.activity_id = ${activityId}
      ), status_counts AS (
        SELECT status, count(*)::integer AS amount FROM all_steps GROUP BY status
      )
      SELECT a.kind, a.closed,
        (SELECT json_agg(to_jsonb(all_steps) ORDER BY all_steps.ordinal) FROM all_steps) AS steps,
        json_build_object(
          'statusCounts', json_build_object(
            'unrecorded', COALESCE((SELECT amount FROM status_counts WHERE status = 'unrecorded'), 0),
            'in_progress', COALESCE((SELECT amount FROM status_counts WHERE status = 'in_progress'), 0),
            'waiting', COALESCE((SELECT amount FROM status_counts WHERE status = 'waiting'), 0),
            'documented', COALESCE((SELECT amount FROM status_counts WHERE status = 'documented'), 0),
            'not_applicable', COALESCE((SELECT amount FROM status_counts WHERE status = 'not_applicable'), 0)
          ),
          'openTaskCount', (SELECT count(*)::integer FROM tasks t WHERE t.activity_id = a.id AND t.status = 'open'),
          'openTasks', COALESCE((SELECT json_agg(json_build_object('id', t.id, 'title', t.title, 'dueAt', t.due_at, 'ownerName', t.owner_name) ORDER BY t.due_at, t.created_at, t.id)
            FROM tasks t WHERE t.activity_id = a.id AND t.status = 'open'), '[]'::json),
          'latestEvent', (SELECT json_build_object('id', e.id, 'eventType', e.event_type, 'summary', e.summary,
            'actorName', e.actor_name, 'createdAt', e.created_at)
            FROM activity_events e WHERE e.activity_id = a.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1)
        ) AS overview
      FROM scoped_activity a
    `);
    const row = top(rowsOf(result));
    if (!row) return null;
    if (row.kind !== 'university') throw new DomainError(409, 'university_steps_not_applicable', 'Пункты партнёрства доступны только для вузовских активностей.');
    return { steps: row.steps ?? [], overview: row.overview, readOnly: Boolean(row.closed) };
  }

  private async lockUniversityActivity(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], actor: Actor, activityId: string) {
    const result = await tx.execute(sql`SELECT a.id, a.kind, a.closed FROM activities a WHERE a.id = ${activityId} AND ${canSee(actor)} FOR UPDATE`);
    const activity = top(rowsOf(result));
    if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (activity.kind !== 'university') throw new DomainError(409, 'university_steps_not_applicable', 'Пункты партнёрства доступны только для вузовских активностей.');
    if (activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённая активность доступна только для чтения.');
    return activity;
  }

  private async currentUniversityStep(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], activityId: string, stepId: string) {
    const result = await tx.execute(sql`SELECT status, note, evidence_reference, evidence_source, revision FROM activity_university_steps WHERE activity_id = ${activityId} AND step_id = ${stepId} FOR UPDATE`);
    return top(rowsOf(result)) ?? { status: 'unrecorded', note: '', evidence_reference: null, evidence_source: null, revision: 0 };
  }

  async updateUniversityStep(actor: Actor, activityId: string, stepId: string, input: UniversityStepUpdate) {
    return db.transaction(async (tx) => {
      await this.lockUniversityActivity(tx, actor, activityId);
      const definitionResult = await tx.execute(sql`SELECT id, label, optional FROM university_step_definitions WHERE id = ${stepId}`);
      const definition = top(rowsOf(definitionResult));
      if (!definition) throw new DomainError(404, 'university_step_not_found', 'Пункт партнёрства не найден.');
      if (stepId === 'U05' && input.status !== 'not_applicable') throw new DomainError(400, 'correction_return_required', 'Корректировку документов можно зафиксировать только отдельным действием возврата.');
      if (input.status === 'not_applicable' && !definition.optional) throw new DomainError(400, 'required_step_cannot_be_skipped', 'Этот пункт нельзя отметить как неприменимый.');
      const evidenceReference = input.evidenceReference?.trim() || null;
      const evidenceSource = input.evidenceSource?.trim() || null;
      const note = input.note.trim();
      if (input.status === 'documented' && stepsRequiringReferenceAndSource.includes(stepId) && (!evidenceReference || !evidenceSource)) {
        throw new DomainError(400, 'supporting_evidence_required', 'Для фиксации этого пункта нужны ссылка или позиция и источник.');
      }
      if (input.status === 'documented' && !stepsRequiringReferenceAndSource.includes(stepId) && !note && !evidenceReference) throw new DomainError(400, 'supporting_evidence_required', 'Для фиксации этого пункта добавьте заметку или ссылку.');
      const current = await this.currentUniversityStep(tx, activityId, stepId);
      if (Number(current.revision) !== input.expectedRevision) throw new DomainError(409, 'step_revision_conflict', 'Пункт уже изменён другим участником. Обновите данные и повторите.');
      const now = new Date();
      const nextRevision = input.expectedRevision + 1;
      await tx.execute(sql`
        INSERT INTO activity_university_steps (activity_id, step_id, status, note, evidence_reference, evidence_source, actor_sub, actor_name, updated_at, revision)
        VALUES (${activityId}, ${stepId}, ${input.status}, ${note}, ${evidenceReference}, ${evidenceSource}, ${actor.sub}, ${actor.name}, ${now}, ${nextRevision})
        ON CONFLICT (activity_id, step_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note,
          evidence_reference = EXCLUDED.evidence_reference, evidence_source = EXCLUDED.evidence_source,
          actor_sub = EXCLUDED.actor_sub, actor_name = EXCLUDED.actor_name, updated_at = EXCLUDED.updated_at, revision = EXCLUDED.revision
      `);
      await tx.update(activities).set({ updatedAt: now }).where(eq(activities.id, activityId));
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId, eventType: 'university_step_updated',
        summary: `${definition.label}: ${stepStatusLabels[input.status]}`,
        details: { stepId, previousStatus: current.status, status: input.status, previousRevision: input.expectedRevision, revision: nextRevision, note, evidenceReference, evidenceSource },
        actorSub: actor.sub, actorName: actor.name,
      });
      return { stepId, status: input.status, note, evidenceReference, evidenceSource, actorSub: actor.sub, actorName: actor.name, updatedAt: now.toISOString(), revision: nextRevision };
    });
  }

  async universityCorrectionReturn(actor: Actor, activityId: string, input: UniversityCorrectionReturn) {
    return db.transaction(async (tx) => {
      await this.lockUniversityActivity(tx, actor, activityId);
      const u04 = await this.currentUniversityStep(tx, activityId, 'U04');
      const u05 = await this.currentUniversityStep(tx, activityId, 'U05');
      if (Number(u04.revision) !== input.expectedU04Revision || Number(u05.revision) !== input.expectedU05Revision) {
        throw new DomainError(409, 'step_revision_conflict', 'Пункты уже изменены другим участником. Обновите данные и повторите.');
      }
      if (!['documented', 'waiting'].includes(u04.status)) throw new DomainError(409, 'correction_return_not_applicable', 'Возврат на корректировку доступен после передачи пакета документов.');
      const correctionNote = input.note.trim();
      const correctionReference = input.evidenceReference?.trim() || null;
      const correctionSource = input.evidenceSource?.trim() || null;
      if (!correctionNote && !correctionReference) throw new DomainError(400, 'supporting_evidence_required', 'Для фиксации возврата добавьте заметку или ссылку.');
      const now = new Date();
      const u04Revision = input.expectedU04Revision + 1;
      const u05Revision = input.expectedU05Revision + 1;
      const updates = [
        { stepId: 'U04', status: 'in_progress', revision: u04Revision, note: u04.note, evidenceReference: u04.evidence_reference, evidenceSource: u04.evidence_source },
        { stepId: 'U05', status: 'documented', revision: u05Revision, note: correctionNote, evidenceReference: correctionReference, evidenceSource: correctionSource },
      ] as const;
      for (const update of updates) {
        await tx.execute(sql`
          INSERT INTO activity_university_steps (activity_id, step_id, status, note, evidence_reference, evidence_source, actor_sub, actor_name, updated_at, revision)
          VALUES (${activityId}, ${update.stepId}, ${update.status}, ${update.note}, ${update.evidenceReference}, ${update.evidenceSource}, ${actor.sub}, ${actor.name}, ${now}, ${update.revision})
          ON CONFLICT (activity_id, step_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note,
            evidence_reference = EXCLUDED.evidence_reference, evidence_source = EXCLUDED.evidence_source,
            actor_sub = EXCLUDED.actor_sub, actor_name = EXCLUDED.actor_name, updated_at = EXCLUDED.updated_at, revision = EXCLUDED.revision
        `);
      }
      await tx.update(activities).set({ updatedAt: now }).where(eq(activities.id, activityId));
      await tx.insert(activityEvents).values({
        id: randomUUID(), activityId, eventType: 'university_correction_return',
        summary: 'Пакет документов возвращён на корректировку; обмен открыт повторно',
        details: { stepId: 'U05', previousU04Status: u04.status, previousU04Revision: input.expectedU04Revision, previousU04EvidenceReference: u04.evidence_reference, previousU04EvidenceSource: u04.evidence_source, u04Status: 'in_progress', u04Revision, previousU05Status: u05.status, previousU05Revision: input.expectedU05Revision, u05Status: 'documented', u05Revision, note: correctionNote, evidenceReference: correctionReference, evidenceSource: correctionSource },
        actorSub: actor.sub, actorName: actor.name,
      });
      return { u04: { stepId: 'U04', status: 'in_progress', revision: u04Revision }, u05: { stepId: 'U05', status: 'documented', revision: u05Revision }, updatedAt: now.toISOString() };
    });
  }

  async catalog(actor: Actor) {
    assertBusinessAccess(actor);
    const visibility = hasTeamBusinessScope(actor) ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM activities assigned WHERE assigned.owner_sub = ${actor.sub} AND (assigned.organization_id = o.id OR assigned.payer_organization_id = o.id))`;
    const organizationScope = actor.allowedOrganizationIds == null ? sql`TRUE`
      : actor.allowedOrganizationIds.length === 0 ? sql`FALSE`
        : sql`o.id IN (${sql.join(actor.allowedOrganizationIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
    const orgResult = await db.execute(sql`SELECT o.id,o.name,o.segment FROM organizations o WHERE ${visibility} AND ${organizationScope} ORDER BY o.name`);
    const productRows = await db.select({ id: products.id, name: products.name }).from(products)
      .where(eq(products.catalogVisible, true)).orderBy(asc(products.name));
    const workflows = await this.getWorkflow();
    return { organizations: rowsOf(orgResult), products: productRows, workflows };
  }
}

export const closeRepository = () => pool.end();
