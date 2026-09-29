import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db/connection.js';
import { DomainError, hasBusinessAccess, hasTeamBusinessScope, isActivityKindAllowed, type Actor } from './domain.js';
import { cleanupOrphanReportTemps, readPrivateReport, removePrivateReport, writePrivateReport } from './report-files.js';
import { renderReportFileInWorker } from './report-renderer.js';
import { isReportExportColumnKey, REPORT_EXPORT_COLUMNS, type ReportExportColumnKey } from './report-columns.js';

export const EXPORT_FORMATS = ['xls', 'xlsx', 'csv', 'pdf', 'json', 'png', 'chart-pdf'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];
export type ReportId = 'crm_portfolio' | 'demand_learning';
export type ReportFilters = { from?: string; to?: string; kind?: 'university' | 'corporate' | 'individual'; ownerSub?: string; organizationId?: string; organizationName?: string; productId?: string; programId?: string; learningFactKind?: 'enrollment' | 'learning_started' | 'learning_completed'; requestedPlacesRecorded?: boolean; includeClosed: boolean };
export type ReportMetricTimeScope = 'selected_activity_creation_period' | 'selected_activities_all_available_fact_times' | 'not_calculated';
export type ReportMetricGrouping = 'activity' | 'learning_fact_event' | 'not_calculated';
export type ReportMetric = {
  key: string; label: string; value: number | null; unit: string; definition: string; source: string; completeness: string;
  timeScope: ReportMetricTimeScope; grouping: ReportMetricGrouping; lastFactOccurredAt: string | null; sourceReceivedAt: string | null;
};
export type ReportRow = {
  activityId: string; kind: 'university' | 'corporate' | 'individual'; kindLabel: string; title: string; stageKey: string; stageLabel: string | null;
  ownerSub: string; ownerName: string; organizationName: string | null; personName: string | null; origin: string; originSource: string | null;
  originReference: string | null; originLabel: string; createdAt: string; updatedAt: string; closed: boolean; awaitingReply: boolean;
  nextTaskDueAt: string | null; productNames: string[]; productLinks: { id: string; name: string }[]; programLinks: { id: string; name: string }[]; programNames: string[]; requestedPlaces: number | null; requestedPlacesRecorded: boolean;
  enrollmentFactCount: number; learningStartedFactCount: number; learningCompletedFactCount: number; learningFactsSource: string | null; lastLearningFactAt: string | null;
  // Relationship metadata is part of the default JSON snapshot, not a public file URL.
  organizationId?: string | null; personId?: string | null; payerOrganizationId?: string | null; programMode?: string | null;
  documentRefs?: { id: string; name: string }[]; contractLicenseRefs?: { id: string; title: string; documentId: string | null }[];
};
export type ReportSnapshot = {
  snapshotId: string; reportId: ReportId; dataProfile: 'synthetic_demo'; title: string; asOf: string; filters: ReportFilters;
  rowCount: number; page: number; pageSize: number; rows: ReportRow[]; metrics: ReportMetric[];
  chart: ReportChart; charts: ReportChart[]; sources: string[]; notes: string[];
};
export type ReportSnapshotPayload = Omit<ReportSnapshot, 'rows'>;
export type ReportChart = { id: string; title: string; unit: string; series: { label: string; value: number; filter?: { kind?: ReportFilters['kind']; productId?: string; learningFactKind?: ReportFilters['learningFactKind']; requestedPlacesRecorded?: boolean } }[] };
type JobRow = {
  id: string; jobType: 'snapshot' | 'export'; reportId: ReportId; actorSub: string; actorName: string; parameters: ExportJobParameters;
  sourceSnapshotId: string | null;
  payload: ReportSnapshotPayload; format: ExportFormat | null; fileKey: string | null; fileName: string | null; mediaType: string | null;
  fileSize: number | null; fileSha256: string | null; rowCount: number; status: 'queued' | 'running' | 'completed' | 'failed' | 'expired';
  errorCode: string | null; errorMessage: string | null; createdAt: Date; updatedAt: Date; expiresAt: Date;
};

type ExportJobParameters = ReportFilters & { exportColumns?: ReportExportColumnKey[] };

export function validateReportExportColumns(value: unknown): ReportExportColumnKey[] {
  if (value === undefined) return REPORT_EXPORT_COLUMNS.map((column) => column.key);
  if (!Array.isArray(value) || value.length === 0) throw new DomainError(400, 'invalid_export_columns', 'Выберите хотя бы одну колонку выгрузки.');
  if (value.some((column) => !isReportExportColumnKey(column))) throw new DomainError(400, 'invalid_export_columns', 'В списке есть неизвестная колонка выгрузки.');
  if (new Set(value).size !== value.length) throw new DomainError(400, 'invalid_export_columns', 'Колонки выгрузки не должны повторяться.');
  return value as ReportExportColumnKey[];
}

export const MAX_REPORT_EXPORT_LIST_LIMIT = 20;

export function validateReportExportListLimit(value: unknown): number {
  if (value === undefined) return MAX_REPORT_EXPORT_LIST_LIMIT;
  const limit = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORT_EXPORT_LIST_LIMIT) {
    throw new DomainError(400, 'invalid_export_limit', `Число выгрузок должно быть от 1 до ${MAX_REPORT_EXPORT_LIST_LIMIT}.`);
  }
  return limit;
}

const definitions: Record<ReportId, { title: string; sources: string[]; notes: string[] }> = {
  crm_portfolio: {
    title: 'Портфель CRM', sources: ['CRM: активности, этапы, ответственные, задачи и связи с продуктами'],
    notes: ['Считает активности CRM, не внешние обращения и не заявки на обучение.', 'Выручка, конверсия и динамика по месяцам не рассчитываются: подтверждённых финансовых фактов и сопоставимых когорт нет.'],
  },
  demand_learning: {
    title: 'Спрос и факты обучения', sources: ['CRM: активности и заявленные места', 'Read-only проекция LMS: факты зачисления, начала и завершения'],
    notes: ['Заявленные места не равны людям, зачисленным, начавшим или завершившим обучение.', 'LMS-показатели считают записанные события проекции, не уникальных людей; отсутствие события в проекции не доказывает отсутствие события в LMS.', 'Период применяется к дате создания активности; привязанные учебные факты показаны за всё доступное время. Месячная динамика и параллельность без подтверждённых периодов не рассчитываются.'],
  },
};

const kindLabels = { university: 'Вуз', corporate: 'Компания', individual: 'Физлицо' } as const;
export const REPORT_PAGE_SIZE = 25;
export const XLS_MAX_DATA_ROWS = 65_534;
export const XLSX_MAX_DATA_ROWS = 1_048_574;
export const MAX_REPORT_SOURCE_BYTES = 32 * 1024 * 1024;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roleHasWorkspace = hasBusinessAccess;

/**
 * Keep every report source query on the same row-level visibility rules. Owner
 * options intentionally use this scope without a closed-activity predicate so
 * managers can select owners represented in either open or closed reports.
 */
export function buildReportActivityScope(actor: Actor) {
  const values: unknown[] = [actor.sub];
  const where = [hasTeamBusinessScope(actor) ? '(a.import_owner_only = FALSE OR a.owner_sub = $1)' : 'a.owner_sub = $1'];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (actor.allowedKinds != null) where.push(`a.kind = ANY(${bind(actor.allowedKinds)}::text[])`);
  if (actor.allowedOrganizationIds != null) {
    if (actor.allowedOrganizationIds.length === 0) where.push('a.organization_id IS NULL AND a.payer_organization_id IS NULL');
    else {
      const allowedOrganizationIds = bind(actor.allowedOrganizationIds);
      where.push(`(a.organization_id IS NULL OR a.organization_id = ANY(${allowedOrganizationIds}::uuid[])) AND (a.payer_organization_id IS NULL OR a.payer_organization_id = ANY(${allowedOrganizationIds}::uuid[]))`);
    }
  }
  return { values, where };
}

function validateDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !dayPattern.test(value)) throw new DomainError(400, 'invalid_report_filter', `Некорректная дата фильтра ${field}.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new DomainError(400, 'invalid_report_filter', `Некорректная дата фильтра ${field}.`);
  return value;
}

export function validateReportRequest(actor: Actor, reportId: unknown, filtersValue: unknown): { reportId: ReportId; filters: ReportFilters } {
  if (!roleHasWorkspace(actor)) throw new DomainError(403, 'forbidden', 'Нет доступа к отчётам CRM.');
  if (reportId !== 'crm_portfolio' && reportId !== 'demand_learning') throw new DomainError(400, 'invalid_report', 'Неизвестный готовый отчёт.');
  const value = filtersValue && typeof filtersValue === 'object' && !Array.isArray(filtersValue) ? filtersValue as Record<string, unknown> : {};
  const from = validateDate(value.from, 'from');
  const to = validateDate(value.to, 'to');
  if (from && to && from > to) throw new DomainError(400, 'invalid_report_filter', 'Дата начала периода должна быть не позже даты окончания.');
  const kind = value.kind;
  if (kind !== undefined && !['university', 'corporate', 'individual'].includes(String(kind))) throw new DomainError(400, 'invalid_report_filter', 'Неизвестный тип активности.');
  if (kind !== undefined && !isActivityKindAllowed(actor, kind as 'university' | 'corporate' | 'individual')) throw new DomainError(403, 'segment_forbidden', 'Фильтр содержит тип активности вне вашей области доступа.');
  let ownerSub: string | undefined;
  if (value.ownerSub !== undefined) {
    if (!hasTeamBusinessScope(actor)) throw new DomainError(403, 'forbidden', 'Фильтр по ответственному доступен только руководителю.');
    if (typeof value.ownerSub !== 'string' || value.ownerSub.length < 1 || value.ownerSub.length > 255 || /[\u0000-\u001f\u007f]/.test(value.ownerSub)) throw new DomainError(400, 'invalid_report_filter', 'Некорректный ответственный.');
    ownerSub = value.ownerSub;
  }
  let organizationId: string | undefined;
  if (value.organizationId !== undefined) {
    if (!hasTeamBusinessScope(actor)) throw new DomainError(403, 'forbidden', 'Фильтр по организации доступен только руководителю.');
    if (typeof value.organizationId !== 'string' || !uuidPattern.test(value.organizationId)) throw new DomainError(400, 'invalid_report_filter', 'Некорректный фильтр по организации.');
    organizationId = value.organizationId;
  }
  let productId: string | undefined;
  if (value.productId !== undefined) {
    if (typeof value.productId !== 'string' || !uuidPattern.test(value.productId)) throw new DomainError(400, 'invalid_report_filter', 'Некорректный фильтр по продукту.');
    productId = value.productId;
  }
  let programId: string | undefined;
  if (value.programId !== undefined) {
    if (typeof value.programId !== 'string' || !uuidPattern.test(value.programId)) throw new DomainError(400, 'invalid_report_filter', 'Некорректный фильтр по учебной программе.');
    programId = value.programId;
  }
  const learningFactKind = value.learningFactKind;
  if (learningFactKind !== undefined && !['enrollment', 'learning_started', 'learning_completed'].includes(String(learningFactKind))) throw new DomainError(400, 'invalid_report_filter', 'Неизвестный тип учебного факта.');
  if (value.requestedPlacesRecorded !== undefined && typeof value.requestedPlacesRecorded !== 'boolean') throw new DomainError(400, 'invalid_report_filter', 'Фильтр записанных заявленных мест должен быть true или false.');
  if (value.includeClosed !== undefined && typeof value.includeClosed !== 'boolean') throw new DomainError(400, 'invalid_report_filter', 'Фильтр закрытых активностей должен быть true или false.');
  return { reportId, filters: { from, to, kind: kind as ReportFilters['kind'], ownerSub, organizationId, productId, programId, learningFactKind: learningFactKind as ReportFilters['learningFactKind'], requestedPlacesRecorded: value.requestedPlacesRecorded as boolean | undefined, includeClosed: value.includeClosed as boolean | undefined ?? true } };
}

function metric(key: string, label: string, value: number | null, unit: string, definition: string, source: string, completeness: string, timeScope: ReportMetricTimeScope, grouping: ReportMetricGrouping, lastFactOccurredAt: string | null = null, sourceReceivedAt: string | null = null): ReportMetric {
  return { key, label, value, unit, definition, source, completeness, timeScope, grouping, lastFactOccurredAt, sourceReceivedAt };
}

const learningFactMetricKeys = new Set(['enrollmentFacts', 'learningStartedFacts', 'learningCompletedFacts']);
const unavailableMetricKeys = new Set(['incomingInquiries', 'learningApplications', 'uniqueLearners', 'concurrentStreams']);
const metricTimeScopes: ReportMetricTimeScope[] = ['selected_activity_creation_period', 'selected_activities_all_available_fact_times', 'not_calculated'];
const metricGroupings: ReportMetricGrouping[] = ['activity', 'learning_fact_event', 'not_calculated'];

export function normalizeReportMetric(value: unknown): ReportMetric {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const key = String(raw.key ?? '');
  const isLearningFact = learningFactMetricKeys.has(key);
  const timeScope = metricTimeScopes.includes(raw.timeScope as ReportMetricTimeScope)
    ? raw.timeScope as ReportMetricTimeScope
    : isLearningFact ? 'selected_activities_all_available_fact_times' : unavailableMetricKeys.has(key) ? 'not_calculated' : 'selected_activity_creation_period';
  const grouping = metricGroupings.includes(raw.grouping as ReportMetricGrouping)
    ? raw.grouping as ReportMetricGrouping
    : isLearningFact ? 'learning_fact_event' : unavailableMetricKeys.has(key) ? 'not_calculated' : 'activity';
  // Older snapshots stored one cross-kind maximum as freshAt; it cannot truthfully identify this metric's fact kind.
  const lastFactOccurredAt = typeof raw.lastFactOccurredAt === 'string' ? raw.lastFactOccurredAt : null;
  const { freshAt: _legacyFreshAt, ...current } = raw;
  return { ...current, timeScope, grouping, lastFactOccurredAt, sourceReceivedAt: typeof raw.sourceReceivedAt === 'string' ? raw.sourceReceivedAt : null } as ReportMetric;
}

export function normalizeReportSnapshotPayload(payload: ReportSnapshotPayload): ReportSnapshotPayload {
  return { ...payload, metrics: payload.metrics.map(normalizeReportMetric) };
}

export function mapReportRow(raw: Record<string, unknown>): ReportRow {
  return {
    activityId: String(raw.activityId), kind: raw.kind as ReportRow['kind'], kindLabel: kindLabels[raw.kind as ReportRow['kind']], title: String(raw.title),
    stageKey: String(raw.stageKey), stageLabel: raw.stageLabel == null ? null : String(raw.stageLabel), ownerSub: String(raw.ownerSub), ownerName: String(raw.ownerName),
    organizationName: raw.organizationName == null ? null : String(raw.organizationName), personName: raw.personName == null ? null : String(raw.personName),
    origin: String(raw.origin), originSource: raw.originSource == null ? null : String(raw.originSource), originReference: raw.originReference == null ? null : String(raw.originReference),
    originLabel: raw.origin === 'external_ready' ? `Внешний заказ · ${String(raw.originSource ?? 'источник не указан')}`
      : raw.origin === 'cms_mock' ? 'CMS mock'
        : raw.publicFormOrigin === true ? 'Заявка с сайта'
          : raw.publicFormOrigin === false ? 'Ручная заявка' : 'Активность CRM',
    createdAt: new Date(String(raw.createdAt)).toISOString(), updatedAt: new Date(String(raw.updatedAt)).toISOString(), closed: Boolean(raw.closed), awaitingReply: Boolean(raw.awaitingReply),
    nextTaskDueAt: raw.nextTaskDueAt == null ? null : new Date(String(raw.nextTaskDueAt)).toISOString(),
    productNames: Array.isArray(raw.productNames) ? raw.productNames.map(String) : [],
    productLinks: Array.isArray(raw.productLinks) ? raw.productLinks.map((item) => ({ id: String((item as Record<string, unknown>).id), name: String((item as Record<string, unknown>).name) })) : [],
    programLinks: Array.isArray(raw.programLinks) ? raw.programLinks.map((item) => ({ id: String((item as Record<string, unknown>).id), name: String((item as Record<string, unknown>).name) })) : [],
    programNames: Array.isArray(raw.programLinks) ? raw.programLinks.map((item) => String((item as Record<string, unknown>).name)) : [],
    organizationId: raw.organizationId == null ? null : String(raw.organizationId), personId: raw.personId == null ? null : String(raw.personId),
    payerOrganizationId: raw.payerOrganizationId == null ? null : String(raw.payerOrganizationId), programMode: raw.programMode == null ? null : String(raw.programMode),
    documentRefs: Array.isArray(raw.documentRefs) ? raw.documentRefs.map((item) => ({ id: String((item as Record<string, unknown>).id), name: String((item as Record<string, unknown>).name) })) : [],
    contractLicenseRefs: Array.isArray(raw.contractLicenseRefs) ? raw.contractLicenseRefs.map((item) => ({
      id: String((item as Record<string, unknown>).id), title: String((item as Record<string, unknown>).title),
      documentId: (item as Record<string, unknown>).documentId == null ? null : String((item as Record<string, unknown>).documentId),
    })) : [],
    requestedPlaces: raw.requestedPlaces == null ? null : Number(raw.requestedPlaces), requestedPlacesRecorded: Boolean(raw.requestedPlacesRecorded),
    enrollmentFactCount: Number(raw.enrollmentFactCount ?? 0), learningStartedFactCount: Number(raw.learningStartedFactCount ?? 0), learningCompletedFactCount: Number(raw.learningCompletedFactCount ?? 0),
    learningFactsSource: raw.learningFactsSource == null ? null : String(raw.learningFactsSource), lastLearningFactAt: raw.lastLearningFactAt == null ? null : new Date(String(raw.lastLearningFactAt)).toISOString(),
  };
}

type ProductAggregate = { id: string; label: string; value: number };
type ReportAggregate = {
  rowCount: number; openCount: number; overdueCount: number; awaitingReplyCount: number;
  kindCounts: Record<string, number>; corporateCount: number; requestedPlacesCount: number; requestedPlacesSum: number;
  enrollmentCount: number; startedCount: number; completedCount: number;
  lastEnrollmentFactAt: string | null; lastLearningStartedFactAt: string | null; lastLearningCompletedFactAt: string | null;
  enrollmentReceiptCount: number; startedReceiptCount: number; completedReceiptCount: number;
  lastEnrollmentFactReceivedAt: string | null; lastLearningStartedFactReceivedAt: string | null; lastLearningCompletedFactReceivedAt: string | null;
  productActivities: ProductAggregate[]; productPlaces: ProductAggregate[];
};

export type DemandLearningMetricAggregate = Pick<ReportAggregate,
  'corporateCount' | 'requestedPlacesCount' | 'requestedPlacesSum' | 'enrollmentCount' | 'startedCount' | 'completedCount' |
  'lastEnrollmentFactAt' | 'lastLearningStartedFactAt' | 'lastLearningCompletedFactAt' |
  'enrollmentReceiptCount' | 'startedReceiptCount' | 'completedReceiptCount' |
  'lastEnrollmentFactReceivedAt' | 'lastLearningStartedFactReceivedAt' | 'lastLearningCompletedFactReceivedAt'>;

function receiptCoverage(count: number, linkedCount: number): string {
  return count === 0 ? 'Время получения не применимо: событий этого вида нет.'
    : `Время получения подтверждено для ${linkedCount} из ${count} записанных событий этого вида; дата показывается только при полном покрытии.`;
}

export function buildDemandLearningMetrics(aggregate: DemandLearningMetricAggregate): ReportMetric[] {
  const knownPlaces = aggregate.requestedPlacesCount;
  const corporateCount = aggregate.corporateCount;
  const placesArePartial = knownPlaces < corporateCount;
  const placesLabel = placesArePartial ? 'Заявленные места (известная часть)' : 'Заявленные места';
  const placesCompleteness = knownPlaces === 0
    ? corporateCount > 0
      ? `Недостаточно данных: число мест не записано ни для одной из ${corporateCount} корпоративных активностей.`
      : 'Недостаточно данных: в срезе нет корпоративных активностей, чтобы оценить заявленные места.'
    : placesArePartial
      ? `Записано для ${knownPlaces} из ${corporateCount} корпоративных активностей; сумма показывает известную часть, ещё для ${corporateCount - knownPlaces} активностей план не записан.`
      : `Полное покрытие планов: места записаны для ${knownPlaces} из ${corporateCount} корпоративных активностей.`;

  return [
    metric('corporateActivities', 'Корпоративные активности', corporateCount, 'активностей CRM', 'Число корпоративных активностей; не число клиентов или обучающихся.', 'CRM: корпоративные активности', 'Полный видимый срез среди записей CRM.', 'selected_activity_creation_period', 'activity'),
    metric('requestedPlaces', placesLabel, knownPlaces ? aggregate.requestedPlacesSum : null, 'мест', 'Сумма только записанных мест из корпоративного плана. Если часть планов не заполнена, показатель является известной частью суммы, а не итогом по всему срезу; это не число людей и не зачисление. Дополнительно есть разрез по связанным продуктам: полное число мест каждой активности относится к каждому её продукту, поэтому продуктовые суммы пересекаются и не складываются.', 'CRM: корпоративный план и связи с продуктами', placesCompleteness, 'selected_activity_creation_period', 'activity'),
    metric('enrollmentFacts', 'Факты зачисления в проекции LMS', aggregate.enrollmentCount, 'событий', 'Число записанных CRM событий factKind=enrollment; не число уникальных людей.', 'Read-only проекция LMS в CRM', `Полнота синхронизации с LMS неизвестна; 0 известных фактов не означает отсутствия зачислений. ${receiptCoverage(aggregate.enrollmentCount, aggregate.enrollmentReceiptCount)}`, 'selected_activities_all_available_fact_times', 'learning_fact_event', aggregate.lastEnrollmentFactAt, completeReceiptTime(aggregate.enrollmentCount, aggregate.enrollmentReceiptCount, aggregate.lastEnrollmentFactReceivedAt)),
    metric('learningStartedFacts', 'Факты начала обучения', aggregate.startedCount, 'событий', 'Число записанных CRM событий factKind=learning_started; не число уникальных людей.', 'Read-only проекция LMS в CRM', `Полнота синхронизации с LMS неизвестна; 0 известных фактов не означает отсутствия начал обучения. ${receiptCoverage(aggregate.startedCount, aggregate.startedReceiptCount)}`, 'selected_activities_all_available_fact_times', 'learning_fact_event', aggregate.lastLearningStartedFactAt, completeReceiptTime(aggregate.startedCount, aggregate.startedReceiptCount, aggregate.lastLearningStartedFactReceivedAt)),
    metric('learningCompletedFacts', 'Факты завершения обучения', aggregate.completedCount, 'событий', 'Число записанных CRM событий factKind=learning_completed; не число уникальных людей или подтверждённых результатов.', 'Read-only проекция LMS в CRM', `Полнота синхронизации с LMS неизвестна; 0 известных фактов не означает отсутствия завершений. ${receiptCoverage(aggregate.completedCount, aggregate.completedReceiptCount)}`, 'selected_activities_all_available_fact_times', 'learning_fact_event', aggregate.lastLearningCompletedFactAt, completeReceiptTime(aggregate.completedCount, aggregate.completedReceiptCount, aggregate.lastLearningCompletedFactReceivedAt)),
    metric('incomingInquiries', 'Входящие обращения из источников', null, 'обращений из источников', 'Число обращений, зарегистрированных в исходных системах в пределах доступа пользователя.', 'Исходные системы обращений', 'Недостаточно данных: срез содержит CRM-активности, а не полный перечень входящих обращений из источников в пределах доступа пользователя.', 'not_calculated', 'not_calculated'),
    metric('learningApplications', 'Заявки на обучение', null, 'заявок на обучение', 'Число заявок на обучение, зарегистрированных в исходных системах в пределах доступа пользователя.', 'Исходные системы заявок на обучение', 'Недостаточно данных: срез содержит CRM-активности и факты обучения, а не полный перечень заявок на обучение из источников в пределах доступа пользователя.', 'not_calculated', 'not_calculated'),
    metric('uniqueLearners', 'Уникальные обучающиеся', null, 'человек', 'Число уникальных людей среди учебных фактов.', 'Read-only проекция LMS в CRM', 'Недостаточно данных: в проекции нет стабильного идентификатора обучающегося, поэтому события нельзя надёжно объединить по людям.', 'not_calculated', 'not_calculated'),
    metric('concurrentStreams', 'Параллельные потоки', null, 'потоков', 'Число потоков, которые обучались одновременно в выбранном периоде.', 'CRM и read-only проекция LMS', 'Недостаточно данных: нет подтверждённых периодов начала и окончания обучения по каждому потоку.', 'not_calculated', 'not_calculated'),
  ];
}

function completeReceiptTime(factCount: number, receiptCount: number, latestReceiptAt: string | null): string | null {
  return factCount > 0 && receiptCount === factCount ? latestReceiptAt : null;
}

function buildSnapshotMetadata(snapshotId: string, reportId: ReportId, filters: ReportFilters, asOf: string, aggregate: ReportAggregate): ReportSnapshot {
  const rowCount = aggregate.rowCount;
  const source = definitions[reportId].sources.join('; ');
  const notes = filters.programId
    ? [...definitions[reportId].notes, 'Фильтр по программе выбирает связанные активности CRM. Заявленные места и факты LMS относятся к активности целиком; при нескольких программах они не распределяются между ними.']
    : definitions[reportId].notes;
  const metrics: ReportMetric[] = [];
  if (reportId === 'crm_portfolio') {
    const kinds = (['university', 'corporate', 'individual'] as const).map((kind) => ({ label: kindLabels[kind], value: Number(aggregate.kindCounts[kind] ?? 0) }));
    metrics.push(
      metric('activities', 'Активности CRM', rowCount, 'активностей', 'Каждая активность CRM в разрешённом срезе считается один раз.', source, `Полный срез среди видимых записей; ${rowCount} исходных строк.`, 'selected_activity_creation_period', 'activity'),
      metric('openActivities', 'Открытые активности', aggregate.openCount, 'активностей', 'Активности CRM с закрытым = false.', source, 'Статус активности заполнен CRM.', 'selected_activity_creation_period', 'activity'),
      metric('overdueActivities', 'Просроченные активности', aggregate.overdueCount, 'активностей', 'Открытые активности, у которых ближайшее открытое действие имеет срок раньше даты среза.', 'CRM: активности и открытые задачи', 'Задачи считаются только если срок записан; одна активность считается один раз.', 'selected_activity_creation_period', 'activity'),
      metric('awaitingReply', 'Ожидают ответа', aggregate.awaitingReplyCount, 'активностей', 'Открытые активности с явно записанным состоянием ожидания ответа.', source, 'Полный видимый срез; это состояние CRM, не внешнее событие.', 'selected_activity_creation_period', 'activity'),
    );
    const chart: ReportChart = { id: 'activity-kind', title: 'Активности по типу', unit: 'активностей CRM', series: kinds.map((item) => ({ ...item, filter: { kind: (['university', 'corporate', 'individual'] as const).find((kind) => kindLabels[kind] === item.label) } })) };
    return { snapshotId, reportId, dataProfile: 'synthetic_demo', title: definitions[reportId].title, asOf, filters, rowCount, page: 1, pageSize: REPORT_PAGE_SIZE, rows: [], metrics, chart, charts: [chart], sources: definitions[reportId].sources, notes };
  }

  metrics.push(...buildDemandLearningMetrics(aggregate));
  const productChart: ReportChart = { id: 'product-activity-links', title: 'Активности, связанные с продуктами', unit: 'связанных активностей · по продуктам не суммируется', series: aggregate.productActivities.map(({ id, label, value }) => ({
    label, value, filter: { productId: id },
  })) };
  const placesByProductChart: ReportChart = { id: 'product-demand-places', title: 'Заявленные места по связанным продуктам', unit: 'заявленных мест · полное значение каждой активности отнесено к каждому её продукту; по продуктам не суммируется', series: aggregate.productPlaces.map(({ id, label, value }) => ({
    label, value,
    filter: { kind: 'corporate' as const, productId: id, requestedPlacesRecorded: true },
  })) };
  const learningChart: ReportChart = { id: 'learning-events', title: 'Записанные факты обучения', unit: 'событий в read-only проекции LMS', series: [
    { label: 'Факты зачисления', value: aggregate.enrollmentCount, filter: { learningFactKind: 'enrollment' } },
    { label: 'Факты начала обучения', value: aggregate.startedCount, filter: { learningFactKind: 'learning_started' } },
    { label: 'Факты завершения обучения', value: aggregate.completedCount, filter: { learningFactKind: 'learning_completed' } },
  ] };
  return {
    snapshotId, reportId, dataProfile: 'synthetic_demo', title: definitions[reportId].title, asOf, filters, rowCount, page: 1, pageSize: REPORT_PAGE_SIZE, rows: [], metrics,
    chart: productChart, charts: [productChart, placesByProductChart, learningChart], sources: definitions[reportId].sources, notes,
  };
}

function snapshotPayload(snapshot: ReportSnapshot): ReportSnapshotPayload {
  const { rows: _rows, ...payload } = snapshot;
  return payload;
}

export const readyReports = Object.entries(definitions).map(([id, definition]) => ({
  id, title: definition.title, description: id === 'crm_portfolio' ? 'Открытые и закрытые активности, стадии, ответственные и следующие действия.' : 'Заявленные корпоративные места отдельно от записанных фактов из LMS.',
  filters: ['from', 'to', 'kind', 'ownerSub', 'organizationId', 'productId', 'programId', 'learningFactKind', 'requestedPlacesRecorded', 'includeClosed'],
  exportColumns: REPORT_EXPORT_COLUMNS.map(({ key, label }) => ({ key, label })), sources: definition.sources, limitations: definition.notes,
}));

function mapReportAggregate(value: unknown): ReportAggregate {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const number = (key: string) => Number(raw[key] ?? 0);
  const products = (key: string): ProductAggregate[] => Array.isArray(raw[key])
    ? (raw[key] as Record<string, unknown>[]).map((item) => ({ id: String(item.id), label: String(item.label), value: Number(item.value) }))
    : [];
  return {
    rowCount: number('rowCount'), openCount: number('openCount'), overdueCount: number('overdueCount'), awaitingReplyCount: number('awaitingReplyCount'),
    kindCounts: raw.kindCounts && typeof raw.kindCounts === 'object' ? Object.fromEntries(Object.entries(raw.kindCounts as Record<string, unknown>).map(([key, item]) => [key, Number(item)])) : {},
    corporateCount: number('corporateCount'), requestedPlacesCount: number('requestedPlacesCount'), requestedPlacesSum: number('requestedPlacesSum'),
    enrollmentCount: number('enrollmentCount'), startedCount: number('startedCount'), completedCount: number('completedCount'),
    enrollmentReceiptCount: number('enrollmentReceiptCount'), startedReceiptCount: number('startedReceiptCount'), completedReceiptCount: number('completedReceiptCount'),
    lastEnrollmentFactAt: raw.lastEnrollmentFactAt == null ? null : new Date(String(raw.lastEnrollmentFactAt)).toISOString(),
    lastLearningStartedFactAt: raw.lastLearningStartedFactAt == null ? null : new Date(String(raw.lastLearningStartedFactAt)).toISOString(),
    lastLearningCompletedFactAt: raw.lastLearningCompletedFactAt == null ? null : new Date(String(raw.lastLearningCompletedFactAt)).toISOString(),
    lastEnrollmentFactReceivedAt: raw.lastEnrollmentFactReceivedAt == null ? null : new Date(String(raw.lastEnrollmentFactReceivedAt)).toISOString(),
    lastLearningStartedFactReceivedAt: raw.lastLearningStartedFactReceivedAt == null ? null : new Date(String(raw.lastLearningStartedFactReceivedAt)).toISOString(),
    lastLearningCompletedFactReceivedAt: raw.lastLearningCompletedFactReceivedAt == null ? null : new Date(String(raw.lastLearningCompletedFactReceivedAt)).toISOString(),
    productActivities: products('productActivities'), productPlaces: products('productPlaces'),
  };
}

async function aggregateSnapshotRowsUsing(client: Pick<PoolClient, 'query'>, snapshotId: string, asOf: string): Promise<ReportAggregate> {
  const result = await client.query(`
    WITH rows AS (
      SELECT row_data AS d FROM report_snapshot_rows WHERE snapshot_id=$1::uuid
    ), kind_counts AS (
      SELECT d->>'kind' AS kind,count(*) AS value FROM rows GROUP BY d->>'kind'
    ), product_activity AS (
      SELECT product->>'id' AS id,product->>'name' AS label,count(*) AS value
      FROM rows CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d->'productLinks','[]'::jsonb)) product
      GROUP BY product->>'id',product->>'name'
    ), product_places AS (
      SELECT product->>'id' AS id,product->>'name' AS label,sum((d->>'requestedPlaces')::numeric) AS value
      FROM rows CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d->'productLinks','[]'::jsonb)) product
      WHERE d->>'kind'='corporate' AND d->>'requestedPlacesRecorded'='true'
      GROUP BY product->>'id',product->>'name'
    )
    SELECT jsonb_build_object(
      'rowCount',(SELECT count(*) FROM rows),
      'openCount',(SELECT count(*) FROM rows WHERE d->>'closed'='false'),
      'overdueCount',(SELECT count(*) FROM rows WHERE d->>'closed'='false' AND d->>'nextTaskDueAt' IS NOT NULL AND (d->>'nextTaskDueAt')::timestamptz < $2::timestamptz),
      'awaitingReplyCount',(SELECT count(*) FROM rows WHERE d->>'closed'='false' AND d->>'awaitingReply'='true'),
      'kindCounts',COALESCE((SELECT jsonb_object_agg(kind,value) FROM kind_counts),'{}'::jsonb),
      'corporateCount',(SELECT count(*) FROM rows WHERE d->>'kind'='corporate'),
      'requestedPlacesCount',(SELECT count(*) FROM rows WHERE d->>'kind'='corporate' AND d->>'requestedPlacesRecorded'='true'),
      'requestedPlacesSum',COALESCE((SELECT sum((d->>'requestedPlaces')::numeric) FROM rows WHERE d->>'kind'='corporate' AND d->>'requestedPlacesRecorded'='true'),0),
      'enrollmentCount',COALESCE((SELECT sum((d->>'enrollmentFactCount')::bigint) FROM rows),0),
      'startedCount',COALESCE((SELECT sum((d->>'learningStartedFactCount')::bigint) FROM rows),0),
      'completedCount',COALESCE((SELECT sum((d->>'learningCompletedFactCount')::bigint) FROM rows),0),
      'enrollmentReceiptCount',COALESCE((SELECT sum((d->>'enrollmentFactReceiptCount')::bigint) FROM rows),0),
      'startedReceiptCount',COALESCE((SELECT sum((d->>'learningStartedFactReceiptCount')::bigint) FROM rows),0),
      'completedReceiptCount',COALESCE((SELECT sum((d->>'learningCompletedFactReceiptCount')::bigint) FROM rows),0),
      'lastEnrollmentFactAt',(SELECT max((d->>'lastEnrollmentFactAt')::timestamptz) FROM rows),
      'lastLearningStartedFactAt',(SELECT max((d->>'lastLearningStartedFactAt')::timestamptz) FROM rows),
      'lastLearningCompletedFactAt',(SELECT max((d->>'lastLearningCompletedFactAt')::timestamptz) FROM rows),
      'lastEnrollmentFactReceivedAt',(SELECT max((d->>'lastEnrollmentFactReceivedAt')::timestamptz) FROM rows),
      'lastLearningStartedFactReceivedAt',(SELECT max((d->>'lastLearningStartedFactReceivedAt')::timestamptz) FROM rows),
      'lastLearningCompletedFactReceivedAt',(SELECT max((d->>'lastLearningCompletedFactReceivedAt')::timestamptz) FROM rows),
      'productActivities',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label,'value',value) ORDER BY value DESC,label) FROM product_activity),'[]'::jsonb),
      'productPlaces',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label,'value',value) ORDER BY value DESC,label) FROM product_places),'[]'::jsonb)
    ) AS summary`, [snapshotId, asOf]);
  return mapReportAggregate(result.rows[0]?.summary);
}

function pageNumber(value: unknown): number {
  if (value === undefined || value === '') return 1;
  const page = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(page) || page < 1) throw new DomainError(400, 'invalid_report_page', 'Номер страницы отчёта должен быть положительным целым числом.');
  return page;
}

export function validateReportExportSize(format: ExportFormat, rowCount: number) {
  if (format === 'xls' && rowCount > XLS_MAX_DATA_ROWS) throw new DomainError(413, 'export_format_limit', `Формат XLS поддерживает не более ${XLS_MAX_DATA_ROWS.toLocaleString('ru-RU')} строк данных; в срезе ${rowCount.toLocaleString('ru-RU')}. Выберите XLSX или JSON.`);
  if (format === 'xlsx' && rowCount > XLSX_MAX_DATA_ROWS) throw new DomainError(413, 'export_format_limit', `Формат XLSX поддерживает не более ${XLSX_MAX_DATA_ROWS.toLocaleString('ru-RU')} строк данных на листе; в срезе ${rowCount.toLocaleString('ru-RU')}.`);
}

export function validateReportExportSourceSize(format: ExportFormat, sourceBytes: number) {
  if (['xls', 'xlsx', 'csv', 'pdf', 'json'].includes(format) && sourceBytes > MAX_REPORT_SOURCE_BYTES) {
    throw new DomainError(413, 'export_source_limit', `Полный срез для этого формата занимает ${sourceBytes.toLocaleString('ru-RU')} байт. Для защиты рабочего сервиса ограничение составляет ${MAX_REPORT_SOURCE_BYTES.toLocaleString('ru-RU')} байт; сузьте фильтры отчёта и повторите выгрузку.`);
  }
}

export class ReportService {
  async listOrganizations(actor: Actor): Promise<{ organizationId: string; organizationName: string }[]> {
    if (!roleHasWorkspace(actor)) throw new DomainError(403, 'forbidden', 'Нет доступа к отчётам CRM.');
    if (!hasTeamBusinessScope(actor)) throw new DomainError(403, 'forbidden', 'Список организаций доступен только руководителю.');
    const { values, where } = buildReportActivityScope(actor);
    const result = await pool.query(`SELECT DISTINCT o.id AS "organizationId",o.name AS "organizationName"
      FROM organizations o WHERE
        EXISTS (SELECT 1 FROM activities a WHERE a.organization_id=o.id AND ${where.join(' AND ')})
        OR EXISTS (SELECT 1 FROM activities a WHERE a.payer_organization_id=o.id AND ${where.join(' AND ')})
      ORDER BY o.name ASC,o.id ASC`, values);
    return result.rows.map((row) => ({ organizationId: String(row.organizationId), organizationName: String(row.organizationName) }));
  }

  async listOwners(actor: Actor): Promise<{ ownerSub: string; ownerName: string }[]> {
    if (!roleHasWorkspace(actor)) throw new DomainError(403, 'forbidden', 'Нет доступа к отчётам CRM.');
    if (!hasTeamBusinessScope(actor)) throw new DomainError(403, 'forbidden', 'Список ответственных доступен только руководителю.');
    const { values, where } = buildReportActivityScope(actor);
    const result = await pool.query(`SELECT DISTINCT ON (a.owner_sub) a.owner_sub AS "ownerSub", a.owner_name AS "ownerName"
      FROM activities a WHERE ${where.join(' AND ')}
      ORDER BY a.owner_sub ASC, a.updated_at DESC, a.id ASC`, values);
    return result.rows.map((row) => ({ ownerSub: String(row.ownerSub), ownerName: String(row.ownerName) }));
  }

  async createSnapshot(actor: Actor, input: unknown): Promise<ReportSnapshot> {
    const params = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const { reportId, filters } = validateReportRequest(actor, params.reportId, params.filters);
    const { values, where } = buildReportActivityScope(actor);
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (filters.from) where.push(`a.created_at >= (${bind(filters.from)}::date::timestamp AT TIME ZONE 'Europe/Moscow')`);
    if (filters.to) where.push(`a.created_at < ((${bind(filters.to)}::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow')`);
    if (filters.kind) where.push(`a.kind = ${bind(filters.kind)}`);
    if (filters.ownerSub) where.push(`a.owner_sub = ${bind(filters.ownerSub)}`);
    if (filters.organizationId) {
      const organizationBind = `${bind(filters.organizationId)}::uuid`;
      where.push(`(a.organization_id = ${organizationBind} OR a.payer_organization_id = ${organizationBind})`);
    }
    if (filters.productId) where.push(`EXISTS (SELECT 1 FROM activity_products filter_ap WHERE filter_ap.activity_id = a.id AND filter_ap.product_id = ${bind(filters.productId)}::uuid)`);
    if (filters.programId) where.push(`EXISTS (SELECT 1 FROM activity_programs filter_apr WHERE filter_apr.activity_id = a.id AND filter_apr.program_id = ${bind(filters.programId)}::uuid)`);
    if (filters.learningFactKind) where.push(`EXISTS (SELECT 1 FROM individual_learning_facts filter_lf WHERE filter_lf.activity_id = a.id AND filter_lf.fact_kind = ${bind(filters.learningFactKind)})`);
    if (filters.requestedPlacesRecorded === true) where.push('cp.requested_places IS NOT NULL');
    if (filters.requestedPlacesRecorded === false) where.push('cp.requested_places IS NULL');
    if (!filters.includeClosed) where.push('a.closed = FALSE');
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const asOfResult = await client.query('SELECT transaction_timestamp() AS as_of');
      const asOf = new Date(asOfResult.rows[0].as_of).toISOString();
      if (filters.organizationId) {
        const accessibleScope = buildReportActivityScope(actor);
        accessibleScope.values.push(filters.organizationId);
        const organizationBind = `$${accessibleScope.values.length}::uuid`;
        const organizationResult = await client.query(`SELECT o.name AS "organizationName"
          FROM organizations o
          WHERE o.id=${organizationBind} AND EXISTS (
            SELECT 1 FROM activities a WHERE (a.organization_id=o.id OR a.payer_organization_id=o.id) AND ${accessibleScope.where.join(' AND ')}
          )`, accessibleScope.values);
        if (!organizationResult.rows[0]) throw new DomainError(403, 'report_filter_forbidden', 'Выбранная организация отсутствует в доступной области отчётов.');
        filters.organizationName = String(organizationResult.rows[0].organizationName);
      }
      await client.query(`INSERT INTO report_jobs(id,job_type,report_id,actor_sub,actor_name,parameters,payload,row_count,status,expires_at)
        VALUES($1,'snapshot',$2,$3,$4,$5::jsonb,'{}'::jsonb,0,'completed',now()+interval '24 hours')`,
      [id, reportId, actor.sub, actor.name, JSON.stringify(filters)]);
      const snapshotBind = `$${values.length + 1}::uuid`;
      await client.query(`
        INSERT INTO report_snapshot_rows(snapshot_id,row_number,activity_id,row_data)
        WITH matched AS (
        SELECT a.id AS "activityId", a.kind, a.title, a.stage_key AS "stageKey", ws.label AS "stageLabel",
          a.owner_sub AS "ownerSub", a.owner_name AS "ownerName", a.organization_id AS "organizationId", a.person_id AS "personId",
          a.payer_organization_id AS "payerOrganizationId", o.name AS "organizationName", p.full_name AS "personName",
          a.origin, a.origin_source AS "originSource", a.origin_reference AS "originReference",
          EXISTS (SELECT 1 FROM public_demo_intakes pdi WHERE pdi.activity_id=a.id) AS "publicFormOrigin",
          a.created_at AS "createdAt", a.updated_at AS "updatedAt",
          a.closed, a.awaiting_reply AS "awaitingReply", nt.due_at AS "nextTaskDueAt",
      COALESCE((SELECT json_agg(pr.name ORDER BY pr.name) FROM activity_products ap JOIN products pr ON pr.id=ap.product_id WHERE ap.activity_id=a.id), '[]'::json) AS "productNames",
      COALESCE((SELECT json_agg(json_build_object('id',pr.id,'name',pr.name) ORDER BY pr.name,pr.id) FROM activity_products ap JOIN products pr ON pr.id=ap.product_id WHERE ap.activity_id=a.id), '[]'::json) AS "productLinks",
      COALESCE((SELECT json_agg(json_build_object('id',lp.id,'name',lp.name) ORDER BY lp.name,lp.id) FROM activity_programs apr JOIN learning_programs lp ON lp.id=apr.program_id WHERE apr.activity_id=a.id), '[]'::json) AS "programLinks",
      COALESCE((SELECT json_agg(json_build_object('id',d.id,'name',d.original_name) ORDER BY d.created_at,d.id) FROM activity_documents d WHERE d.activity_id=a.id), '[]'::json) AS "documentRefs",
      COALESCE((SELECT json_agg(json_build_object('id',c.id,'title',c.title,'documentId',c.document_id) ORDER BY c.updated_at,c.id) FROM activity_contract_licenses c WHERE c.activity_id=a.id), '[]'::json) AS "contractLicenseRefs",
          cp.program_mode AS "programMode", cp.requested_places AS "requestedPlaces", (cp.requested_places IS NOT NULL) AS "requestedPlacesRecorded",
          lf.enrollment_count AS "enrollmentFactCount", lf.started_count AS "learningStartedFactCount", lf.completed_count AS "learningCompletedFactCount",
          lf.enrollment_receipt_count AS "enrollmentFactReceiptCount", lf.started_receipt_count AS "learningStartedFactReceiptCount", lf.completed_receipt_count AS "learningCompletedFactReceiptCount",
          lf.sources AS "learningFactsSource", lf.last_fact_at AS "lastLearningFactAt",
          lf.last_enrollment_fact_at AS "lastEnrollmentFactAt", lf.last_learning_started_fact_at AS "lastLearningStartedFactAt",
          lf.last_learning_completed_fact_at AS "lastLearningCompletedFactAt",
          lf.last_enrollment_fact_received_at AS "lastEnrollmentFactReceivedAt", lf.last_learning_started_fact_received_at AS "lastLearningStartedFactReceivedAt",
          lf.last_learning_completed_fact_received_at AS "lastLearningCompletedFactReceivedAt"
        FROM activities a
        LEFT JOIN workflow_stages ws ON ws.kind=a.kind AND ws.stage_key=a.stage_key
        LEFT JOIN organizations o ON o.id=a.organization_id
        LEFT JOIN people p ON p.id=a.person_id
        LEFT JOIN corporate_activity_plans cp ON cp.activity_id=a.id
        LEFT JOIN LATERAL (
          SELECT t.due_at FROM tasks t WHERE t.activity_id=a.id AND t.status='open' ORDER BY t.due_at ASC,t.created_at ASC,t.id ASC LIMIT 1
        ) nt ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE f.fact_kind='enrollment')::integer AS enrollment_count,
            count(*) FILTER (WHERE f.fact_kind='learning_started')::integer AS started_count,
            count(*) FILTER (WHERE f.fact_kind='learning_completed')::integer AS completed_count,
            max(f.occurred_at) FILTER (WHERE f.fact_kind='enrollment') AS last_enrollment_fact_at,
            max(f.occurred_at) FILTER (WHERE f.fact_kind='learning_started') AS last_learning_started_fact_at,
            max(f.occurred_at) FILTER (WHERE f.fact_kind='learning_completed') AS last_learning_completed_fact_at,
            count(*) FILTER (WHERE f.fact_kind='enrollment' AND accepted_event.id IS NOT NULL)::integer AS enrollment_receipt_count,
            count(*) FILTER (WHERE f.fact_kind='learning_started' AND accepted_event.id IS NOT NULL)::integer AS started_receipt_count,
            count(*) FILTER (WHERE f.fact_kind='learning_completed' AND accepted_event.id IS NOT NULL)::integer AS completed_receipt_count,
            max(accepted_event.received_at) FILTER (WHERE f.fact_kind='enrollment') AS last_enrollment_fact_received_at,
            max(accepted_event.received_at) FILTER (WHERE f.fact_kind='learning_started') AS last_learning_started_fact_received_at,
            max(accepted_event.received_at) FILTER (WHERE f.fact_kind='learning_completed') AS last_learning_completed_fact_received_at,
            string_agg(DISTINCT f.source, ', ' ORDER BY f.source) AS sources, max(f.occurred_at) AS last_fact_at
          FROM individual_learning_facts f
          LEFT JOIN LATERAL (
            SELECT e.id,e.received_at FROM exchange_events e
            JOIN exchange_jobs j ON j.id=e.job_id AND j.status='performed' AND j.system='lms' AND j.direction='lms_to_crm' AND j.operation='receive_learning_fact'
            WHERE e.id=f.exchange_event_id AND e.source_system='lms' AND e.direction='lms_to_crm'
          ) accepted_event ON TRUE
          WHERE f.activity_id=a.id
        ) lf ON TRUE
        WHERE ${where.join(' AND ')}
        ), ordered AS (
          SELECT row_number() OVER (ORDER BY matched."createdAt" DESC,matched."activityId" ASC) AS row_number,
            matched."activityId" AS activity_id,to_jsonb(matched) AS row_data
          FROM matched
        )
        SELECT ${snapshotBind},row_number,activity_id,row_data FROM ordered`, [...values, id]);
      const aggregate = await aggregateSnapshotRowsUsing(client, id, asOf);
      const snapshot = buildSnapshotMetadata(id, reportId, filters, asOf, aggregate);
      await client.query('UPDATE report_jobs SET row_count=$2,payload=$3::jsonb WHERE id=$1', [id, snapshot.rowCount, JSON.stringify(snapshotPayload(snapshot))]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    return this.getSnapshot(actor, id, 1);
  }

  private async loadAccessibleJob(actor: Actor, id: string): Promise<JobRow> {
    if (!uuidPattern.test(id)) throw new DomainError(404, 'report_not_found', 'Отчёт или задание не найдено.');
    const result = await pool.query(`SELECT id,job_type AS "jobType",report_id AS "reportId",actor_sub AS "actorSub",actor_name AS "actorName",
      parameters,payload,source_snapshot_id AS "sourceSnapshotId",format,file_key AS "fileKey",file_name AS "fileName",media_type AS "mediaType",file_size AS "fileSize",file_sha256 AS "fileSha256",
      row_count AS "rowCount",status,error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt",expires_at AS "expiresAt"
      FROM report_jobs WHERE id=$1 AND actor_sub=$2 AND expires_at>now() AND status <> 'expired' LIMIT 1`, [id, actor.sub]);
    const job = result.rows[0] as JobRow | undefined;
    if (!job) throw new DomainError(404, 'report_not_found', 'Отчёт или задание не найдено.');
    await this.assertCurrentScope(actor, job);
    return job;
  }

  private async assertCurrentScope(actor: Actor, job: JobRow) {
    if (!roleHasWorkspace(actor)) throw new DomainError(403, 'forbidden', 'Текущая роль не разрешает доступ к отчётам.');
    const snapshotId = job.jobType === 'snapshot' ? job.id : job.sourceSnapshotId;
    const unavailable = () => new DomainError(403, 'report_scope_changed', 'Область доступа к данным изменилась или сохранённый срез неполон. Постройте отчёт заново.');
    if (!snapshotId) {
      if (Number(job.rowCount) !== 0) throw unavailable();
      return;
    }
    if (job.parameters.organizationId) {
      const selectedOrganizationScope = buildReportActivityScope(actor);
      selectedOrganizationScope.values.push(job.parameters.organizationId);
      const organizationBind = `$${selectedOrganizationScope.values.length}::uuid`;
      const selectedOrganization = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM activities a
        WHERE (a.organization_id=${organizationBind} OR a.payer_organization_id=${organizationBind})
          AND ${selectedOrganizationScope.where.join(' AND ')}
      ) AS visible`, selectedOrganizationScope.values);
      if (selectedOrganization.rows[0]?.visible !== true) throw unavailable();
    }
    if (Number(job.rowCount) === 0) return;
    const ownershipRevoked = hasTeamBusinessScope(actor)
      ? 'NOT (a.import_owner_only=FALSE OR a.owner_sub=$2)'
      : 'a.owner_sub<>$2';
    const kindRevoked = '($3::text[] IS NOT NULL AND NOT (a.kind=ANY($3::text[])))';
    const organizationRevoked = '($4::uuid[] IS NOT NULL AND ((a.organization_id IS NOT NULL AND NOT (a.organization_id=ANY($4::uuid[]))) OR (a.payer_organization_id IS NOT NULL AND NOT (a.payer_organization_id=ANY($4::uuid[])))))';
    const visible = await pool.query(`SELECT source.row_count::text AS "sourceRowCount",source.actor_sub AS "sourceActorSub",source.report_id AS "sourceReportId",count(rr.activity_id)::text AS "storedRowCount",
        COALESCE(bool_or(rr.activity_id IS NOT NULL AND (a.id IS NULL OR ${ownershipRevoked} OR ${kindRevoked} OR ${organizationRevoked})),FALSE) AS revoked
        FROM report_jobs source LEFT JOIN report_snapshot_rows rr ON rr.snapshot_id=source.id
        LEFT JOIN activities a ON a.id=rr.activity_id
        WHERE source.id=$1::uuid AND source.job_type='snapshot' GROUP BY source.row_count,source.actor_sub,source.report_id`, [snapshotId, actor.sub, actor.allowedKinds, actor.allowedOrganizationIds]);
    const source = visible.rows[0] as { sourceRowCount?: string; sourceActorSub?: string; sourceReportId?: string; storedRowCount?: string; revoked?: boolean } | undefined;
    if (!source || source.sourceActorSub !== job.actorSub || source.sourceReportId !== job.reportId || Number(source.sourceRowCount) !== Number(job.rowCount) || Number(source.storedRowCount) !== Number(source.sourceRowCount) || source.revoked) throw unavailable();
  }

  async getSnapshot(actor: Actor, id: string, pageValue?: unknown) {
    const job = await this.loadAccessibleJob(actor, id);
    if (job.jobType !== 'snapshot' || job.status !== 'completed') throw new DomainError(404, 'report_not_found', 'Срез отчёта не найден.');
    const page = pageNumber(pageValue);
    const rowCount = Number(job.rowCount);
    const pageCount = Math.max(1, Math.ceil(rowCount / REPORT_PAGE_SIZE));
    if (page > pageCount) throw new DomainError(400, 'invalid_report_page', `Страница отчёта должна быть от 1 до ${pageCount}.`);
    const afterRow = (page - 1) * REPORT_PAGE_SIZE;
    const result = await pool.query(`SELECT row_data AS "rowData" FROM report_snapshot_rows
      WHERE snapshot_id=$1::uuid AND row_number>$2 ORDER BY row_number ASC LIMIT $3`, [id, afterRow, REPORT_PAGE_SIZE]);
    return { ...normalizeReportSnapshotPayload(job.payload), rowCount, page, pageSize: REPORT_PAGE_SIZE, rows: result.rows.map((row) => mapReportRow(row.rowData as Record<string, unknown>)) };
  }

  async createExport(actor: Actor, snapshotId: string, formatValue: unknown, chartIdValue?: unknown, columnsValue?: unknown) {
    if (!EXPORT_FORMATS.includes(formatValue as ExportFormat)) throw new DomainError(400, 'invalid_export_format', 'Выберите XLS, XLSX, CSV, PDF, PNG или JSON.');
    const exportColumns = validateReportExportColumns(columnsValue);
    const snapshotJob = await this.loadAccessibleJob(actor, snapshotId);
    if (snapshotJob.jobType !== 'snapshot' || snapshotJob.status !== 'completed') throw new DomainError(404, 'report_not_found', 'Срез отчёта не найден.');
    let exportSnapshot = normalizeReportSnapshotPayload(snapshotJob.payload);
    if (chartIdValue !== undefined) {
      const chart = exportSnapshot.charts.find((item) => item.id === chartIdValue);
      if (!chart) throw new DomainError(400, 'invalid_chart', 'Выберите график из этого среза отчёта.');
      exportSnapshot = { ...exportSnapshot, chart };
    }
    const format = formatValue as ExportFormat;
    const rowCount = Number(snapshotJob.rowCount);
    validateReportExportSize(format, rowCount);
    if (['xls', 'xlsx', 'csv', 'pdf', 'json'].includes(format)) {
      const size = await pool.query('SELECT COALESCE(sum(octet_length(row_data::text)),0)::bigint AS bytes FROM report_snapshot_rows WHERE snapshot_id=$1::uuid', [snapshotJob.id]);
      validateReportExportSourceSize(format, Number(size.rows[0]?.bytes ?? 0));
    }
    const id = randomUUID();
    const fileKey = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO report_jobs(id,job_type,report_id,actor_sub,actor_name,parameters,payload,source_snapshot_id,format,file_key,row_count,status,expires_at)
        VALUES($1,'export',$2,$3,$4,$5::jsonb,$6::jsonb,$7::uuid,$8,$9,$10,'queued',now()+interval '24 hours')`,
      [id, snapshotJob.reportId, actor.sub, actor.name, JSON.stringify({ ...snapshotJob.parameters, exportColumns }), JSON.stringify(exportSnapshot), snapshotJob.id, format, fileKey, snapshotJob.rowCount]);
      await client.query("UPDATE report_jobs SET expires_at=GREATEST(expires_at,now()+interval '24 hours') WHERE id=$1", [snapshotJob.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    queueReportExport(id);
    return { id, reportId: snapshotJob.reportId, format, rowCount, status: 'queued' as const, createdAt: new Date().toISOString() };
  }

  async getExportStatus(actor: Actor, id: string) {
    const job = await this.loadAccessibleJob(actor, id);
    if (job.jobType !== 'export') throw new DomainError(404, 'export_not_found', 'Задание экспорта не найдено.');
    return {
      id: job.id, reportId: job.reportId, format: job.format, rowCount: Number(job.rowCount), status: job.status,
      fileName: job.fileName, errorCode: job.errorCode, errorMessage: job.errorMessage,
      createdAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(), expiresAt: new Date(job.expiresAt).toISOString(),
      downloadUrl: job.status === 'completed' ? `/api/reports/exports/${job.id}/file` : null,
    };
  }

  async listExports(actor: Actor, limitValue?: unknown) {
    if (!roleHasWorkspace(actor)) throw new DomainError(403, 'forbidden', 'Нет доступа к отчётам CRM.');
    const limit = validateReportExportListLimit(limitValue);
    const result = await pool.query(`SELECT id FROM report_jobs
      WHERE job_type='export' AND actor_sub=$1 AND expires_at>now() AND status <> 'expired'
      ORDER BY created_at DESC,id DESC LIMIT $2`, [actor.sub, limit]);
    const jobs = await Promise.all((result.rows as { id: string }[]).map(async ({ id }) => {
      try { return await this.getExportStatus(actor, id); }
      catch (error) {
        // A list is a discovery surface: direct status reads continue to return
        // the normal 403/404, while inaccessible or expired jobs are omitted.
        if (error instanceof DomainError && (error.statusCode === 403 || error.statusCode === 404)) return null;
        throw error;
      }
    }));
    return jobs.filter((job): job is NonNullable<typeof job> => job !== null);
  }

  async downloadExport(actor: Actor, id: string) {
    const job = await this.loadAccessibleJob(actor, id);
    if (job.jobType !== 'export' || job.status !== 'completed' || !job.fileKey || !job.fileName || !job.mediaType || job.fileSize === null || !job.fileSha256) {
      if (job.status === 'failed') throw new DomainError(409, 'export_failed', job.errorMessage ?? 'Не удалось сформировать файл отчёта.');
      throw new DomainError(409, 'export_not_ready', 'Файл ещё формируется или недоступен.');
    }
    const bytes = await readPrivateReport(job.fileKey, Number(job.fileSize), job.fileSha256);
    return { bytes, fileName: job.fileName, mediaType: job.mediaType };
  }
}

type WorkerDependencies = {
  render?: typeof renderReportFileInWorker;
  write?: typeof writePrivateReport;
  remove?: typeof removePrivateReport;
  onError?: (phase: 'claim' | 'process' | 'remove' | 'fail_update' | 'recovery', error: unknown) => void;
  scheduleRecovery?: () => void;
};

type WorkerErrorPhase = NonNullable<WorkerDependencies['onError']> extends (phase: infer Phase, error: unknown) => void ? Phase : never;
type StartupRecoveryOptions = Pick<WorkerDependencies, 'onError'> & { wait?: () => Promise<void> };

function reportWorkerError(phase: WorkerErrorPhase, error: unknown, onError?: WorkerDependencies['onError']) {
  if (!onError) {
    console.error(`[report-export] ${phase} failed`, error);
    return;
  }
  try { onError(phase, error); }
  catch (diagnosticError) { console.error(`[report-export] ${phase} failed; error reporter also failed`, { error, diagnosticError }); }
}

export async function runReportExportJob(id: string, dependencies: WorkerDependencies = {}) {
  const render = dependencies.render ?? renderReportFileInWorker;
  const write = dependencies.write ?? writePrivateReport;
  const remove = dependencies.remove ?? removePrivateReport;
  let claimed;
  try {
    claimed = await pool.query(`UPDATE report_jobs SET status='running',updated_at=now() WHERE id=$1 AND job_type='export' AND status='queued' AND expires_at>now()
      RETURNING payload,parameters,format,file_key AS "fileKey",report_id AS "reportId",source_snapshot_id AS "sourceSnapshotId"`, [id]);
  } catch (error) {
    reportWorkerError('claim', error, dependencies.onError);
    (dependencies.scheduleRecovery ?? schedulePendingExportRecovery)();
    return;
  }
  if (!claimed.rowCount) return;
  const row = claimed.rows[0] as { payload: ReportSnapshotPayload; parameters: ExportJobParameters; format: ExportFormat; fileKey: string; reportId: ReportId; sourceSnapshotId: string | null };
  try {
    if (!row.fileKey || !EXPORT_FORMATS.includes(row.format)) throw new Error('Invalid export parameters.');
    const file = await render(normalizeReportSnapshotPayload(row.payload), row.format, row.parameters?.exportColumns, row.sourceSnapshotId ?? undefined);
    const integrity = await write(row.fileKey, file.bytes);
    const stamp = new Date(row.payload.asOf).toISOString().slice(0, 10);
    const safeTitle = row.payload.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_').slice(0, 60) || row.reportId;
    const extension = file.extension.toLowerCase();
    await pool.query(`UPDATE report_jobs SET status='completed',file_name=$2,media_type=$3,file_size=$4,file_sha256=$5,updated_at=now()
      WHERE id=$1 AND status='running'`, [id, `${safeTitle}_${stamp}.${extension}`, file.mediaType, integrity.size, integrity.sha256]);
  } catch (error) {
    reportWorkerError('process', error, dependencies.onError);
    if (row.fileKey) {
      try { await remove(row.fileKey); }
      catch (removeError) { reportWorkerError('remove', removeError, dependencies.onError); }
    }
    try {
      await pool.query(`UPDATE report_jobs SET status='failed',error_code='export_failed',error_message='Не удалось сформировать файл отчёта. Проверьте параметры и создайте новое задание.',updated_at=now()
        WHERE id=$1 AND status='running'`, [id]);
    } catch (updateError) {
      reportWorkerError('fail_update', updateError, dependencies.onError);
      pendingStoppedExportIds.add(id);
      (dependencies.scheduleRecovery ?? schedulePendingExportRecovery)();
    }
  }
}

const queue: string[] = [];
const queuedExportIds = new Set<string>();
const activeExportIds = new Set<string>();
// These jobs are known to have no live render worker in this process. Runtime repair is scoped by ID.
const pendingStoppedExportIds = new Set<string>();
let active = 0;
const maxParallelExports = 1;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePendingExportRecovery() {
  if (recoveryTimer) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined;
    void dispatchPendingReportExports().catch((error) => {
      reportWorkerError('recovery', error);
      schedulePendingExportRecovery();
    });
  }, 1_000);
  recoveryTimer.unref();
}

function pumpQueue() {
  while (active < maxParallelExports && queue.length) {
    const id = queue.shift()!;
    queuedExportIds.delete(id);
    if (activeExportIds.has(id)) continue;
    activeExportIds.add(id);
    active += 1;
    void runReportExportJob(id)
      .catch((error) => {
        reportWorkerError('process', error);
        schedulePendingExportRecovery();
      })
      .finally(() => { active -= 1; activeExportIds.delete(id); pumpQueue(); })
      .catch((error) => {
        reportWorkerError('recovery', error);
        schedulePendingExportRecovery();
      });
  }
}
function queueReportExport(id: string) {
  if (queuedExportIds.has(id) || activeExportIds.has(id)) return;
  queuedExportIds.add(id);
  queue.push(id);
  pumpQueue();
}

/** Runtime retries only dispatch jobs still queued. A live render is never reset by its own recovery timer. */
export async function dispatchPendingReportExports(options: Pick<WorkerDependencies, 'onError' | 'scheduleRecovery'> = {}) {
  try {
    for (const id of pendingStoppedExportIds) {
      await pool.query(`UPDATE report_jobs SET status='failed',error_code='export_failed',error_message='Не удалось сформировать файл отчёта. Проверьте параметры и создайте новое задание.',updated_at=now()
        WHERE id=$1 AND job_type='export' AND status='running'`, [id]);
      pendingStoppedExportIds.delete(id);
    }
    await pool.query("UPDATE report_jobs SET status='failed',error_code='export_expired',error_message='Задание истекло до восстановления после перезапуска.',updated_at=now() WHERE job_type='export' AND status='queued' AND expires_at<=now()");
    const pending = await pool.query("SELECT id FROM report_jobs WHERE job_type='export' AND status='queued' AND expires_at>now() ORDER BY created_at ASC");
    for (const row of pending.rows as { id: string }[]) queueReportExport(row.id);
  } catch (error) {
    reportWorkerError('recovery', error, options.onError);
    (options.scheduleRecovery ?? schedulePendingExportRecovery)();
  }
}

export async function resumePendingReportExports(options: Pick<WorkerDependencies, 'onError'> = {}) {
  await pool.query(`UPDATE report_jobs SET status='failed',error_code='export_expired',error_message='Задание истекло до восстановления после перезапуска.',updated_at=now()
    WHERE job_type='export' AND status='running' AND expires_at<=now()`);
  await pool.query("UPDATE report_jobs SET status='queued',updated_at=now() WHERE job_type='export' AND status='running' AND expires_at>now()");
  await dispatchPendingReportExports(options);
}

/** Startup retry remains separate from runtime dispatch, so it cannot reset work started by this process. */
export async function recoverPendingReportExportsOnStartup(options: StartupRecoveryOptions = {}) {
  const wait = options.wait ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, 1_000); }));
  for (;;) {
    try {
      await resumePendingReportExports(options);
      return;
    } catch (error) {
      reportWorkerError('recovery', error, options.onError);
      await wait();
    }
  }
}

export async function purgeExpiredReportJobs(options: { remove?: typeof removePrivateReport; cleanupTemps?: typeof cleanupOrphanReportTemps; onError?: (error: unknown) => void } = {}) {
  const remove = options.remove ?? removePrivateReport;
  const cleanupTemps = options.cleanupTemps ?? cleanupOrphanReportTemps;
  const expired = await pool.query("SELECT file_key AS \"fileKey\" FROM report_jobs WHERE expires_at<=now() AND file_key IS NOT NULL AND status NOT IN ('expired','running')");
  const failedKeys: string[] = [];
  for (const row of expired.rows as { fileKey: string }[]) {
    try { await remove(row.fileKey); }
    catch (error) { failedKeys.push(row.fileKey); options.onError?.(error); }
  }
  try { await cleanupTemps(); } catch (error) { options.onError?.(error); }
  const result = await pool.query("UPDATE report_jobs SET status='expired',payload='{}'::jsonb,error_message=NULL,updated_at=now() WHERE expires_at<=now() AND status NOT IN ('expired','running') AND (file_key IS NULL OR NOT(file_key=ANY($1::uuid[])))", [failedKeys]);
  await pool.query(`DELETE FROM report_snapshot_rows WHERE snapshot_id IN (
    SELECT source.id FROM report_jobs source
    WHERE source.job_type='snapshot' AND source.status='expired'
      AND NOT EXISTS (
        SELECT 1 FROM report_jobs export_job
        WHERE export_job.job_type='export' AND export_job.source_snapshot_id=source.id
          AND export_job.status <> 'expired'
          AND (export_job.status='running' OR export_job.expires_at>now())
      )
  )`);
  return result.rowCount ?? 0;
}
