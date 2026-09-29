import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDemandLearningMetrics, buildReportActivityScope, mapReportRow, normalizeReportMetric, validateReportRequest, type DemandLearningMetricAggregate } from '../src/report-service.js';
import { DomainError, type Actor } from '../src/domain.js';

const asOf = '2026-09-27T10:30:00.000Z';
const sameFactTimes = { lastEnrollmentFactAt: asOf, lastLearningStartedFactAt: asOf, lastLearningCompletedFactAt: asOf };
type ReceiptFields = Pick<DemandLearningMetricAggregate,
  'enrollmentReceiptCount' | 'startedReceiptCount' | 'completedReceiptCount' |
  'lastEnrollmentFactReceivedAt' | 'lastLearningStartedFactReceivedAt' | 'lastLearningCompletedFactReceivedAt'>;
const metricsByKey = (aggregate: Omit<DemandLearningMetricAggregate, keyof ReceiptFields> & Partial<ReceiptFields>) => new Map(
  buildDemandLearningMetrics({
    enrollmentReceiptCount: 0, startedReceiptCount: 0, completedReceiptCount: 0,
    lastEnrollmentFactReceivedAt: null, lastLearningStartedFactReceivedAt: null, lastLearningCompletedFactReceivedAt: null,
    ...aggregate,
  }).map((item) => [item.key, item]),
);

test('report source labels use public-form provenance while preserving ordinary manual and external origins', () => {
  const base = {
    activityId: 'activity-1', kind: 'individual', title: 'Inquiry', stageKey: 'request', stageLabel: 'Новая заявка',
    ownerSub: 'kam-1', ownerName: 'КАМ', createdAt: asOf, updatedAt: asOf,
  };
  assert.equal(mapReportRow({ ...base, origin: 'manual', publicFormOrigin: true }).originLabel, 'Заявка с сайта');
  assert.equal(mapReportRow({ ...base, origin: 'manual', publicFormOrigin: false }).originLabel, 'Ручная заявка');
  assert.equal(mapReportRow({ ...base, origin: 'external_ready', originSource: 'LMS', publicFormOrigin: false }).originLabel, 'Внешний заказ · LMS');
  assert.equal(mapReportRow({ ...base, origin: 'cms_mock', publicFormOrigin: false }).originLabel, 'CMS mock');
});

test('report owner scope matches visible report rows and includes both open and closed activity owners', () => {
  const scope = buildReportActivityScope({
    sub: 'manager-1', name: 'Manager', roles: ['manager'],
    allowedKinds: ['university', 'corporate'],
    allowedOrganizationIds: ['550e8400-e29b-41d4-a716-446655440000'],
  });

  assert.deepEqual(scope.values, [
    'manager-1', ['university', 'corporate'], ['550e8400-e29b-41d4-a716-446655440000'],
  ]);
  assert.match(scope.where[0], /a\.import_owner_only = FALSE OR a\.owner_sub = \$1/);
  assert.match(scope.where[1], /a\.kind = ANY\(\$2::text\[\]\)/);
  assert.match(scope.where[2], /a\.organization_id IS NULL OR a\.organization_id = ANY\(\$3::uuid\[\]\)/);
  assert.match(scope.where[2], /a\.payer_organization_id IS NULL OR a\.payer_organization_id = ANY\(\$3::uuid\[\]\)/);
  assert.doesNotMatch(scope.where.join(' '), /a\.closed\s*=\s*FALSE/i);
});

test('report activity scope limits KAMs to their own rows and empty organization scope to unlinked activities', () => {
  const kamScope = buildReportActivityScope({ sub: 'kam-1', name: 'Kam', roles: ['kam'], allowedKinds: null, allowedOrganizationIds: null });
  assert.deepEqual(kamScope.values, ['kam-1']);
  assert.deepEqual(kamScope.where, ['a.owner_sub = $1']);

  const restrictedManagerScope = buildReportActivityScope({ sub: 'manager-1', name: 'Manager', roles: ['manager'], allowedOrganizationIds: [] });
  assert.deepEqual(restrictedManagerScope.where, [
    '(a.import_owner_only = FALSE OR a.owner_sub = $1)',
    'a.organization_id IS NULL AND a.payer_organization_id IS NULL',
  ]);
});

test('organization report filter is manager-only and requires a UUID', () => {
  const manager: Actor = { sub: 'manager-1', name: 'Manager', roles: ['manager'] };
  const kam: Actor = { sub: 'kam-1', name: 'Kam', roles: ['kam'] };
  const organizationId = '550e8400-e29b-41d4-a716-446655440000';

  assert.equal(validateReportRequest(manager, 'crm_portfolio', { organizationId }).filters.organizationId, organizationId);
  assert.throws(() => validateReportRequest(manager, 'crm_portfolio', { organizationId: 'not-an-id' }),
    (error: unknown) => error instanceof DomainError && error.statusCode === 400 && error.code === 'invalid_report_filter');
  assert.throws(() => validateReportRequest(kam, 'crm_portfolio', { organizationId }),
    (error: unknown) => error instanceof DomainError && error.statusCode === 403 && error.code === 'forbidden');
});

test('program report filter accepts a UUID for either business role and rejects malformed values', () => {
  const manager: Actor = { sub: 'manager-1', name: 'Manager', roles: ['manager'] };
  const kam: Actor = { sub: 'kam-1', name: 'Kam', roles: ['kam'] };
  const programId = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(validateReportRequest(manager, 'demand_learning', { programId }).filters.programId, programId);
  assert.equal(validateReportRequest(kam, 'crm_portfolio', { programId }).filters.programId, programId);
  assert.throws(() => validateReportRequest(kam, 'crm_portfolio', { programId: 'not-an-id' }),
    (error: unknown) => error instanceof DomainError && error.statusCode === 400 && error.code === 'invalid_report_filter');
});

test('legacy cross-kind freshness is not misreported as a per-kind occurrence or receipt time', () => {
  const oldActivityMetric = normalizeReportMetric({ key: 'activities', freshAt: asOf });
  const oldFactMetric = normalizeReportMetric({ key: 'enrollmentFacts', freshAt: asOf });

  assert.equal(oldActivityMetric.timeScope, 'selected_activity_creation_period');
  assert.equal(oldActivityMetric.lastFactOccurredAt, null, 'The old activity snapshot timestamp is not a fact occurrence.');
  assert.equal(oldFactMetric.timeScope, 'selected_activities_all_available_fact_times');
  assert.equal(oldFactMetric.grouping, 'learning_fact_event');
  assert.equal(oldFactMetric.lastFactOccurredAt, null, 'The old aggregate maximum cannot be assigned to one fact kind.');
  assert.equal('freshAt' in oldFactMetric, false);
  assert.equal('receivedAt' in oldFactMetric, false);
});

test('partial corporate plan coverage is reported as an observed subtotal with explicit coverage', () => {
  const metrics = metricsByKey({
    corporateCount: 4, requestedPlacesCount: 2, requestedPlacesSum: 73,
    enrollmentCount: 5, startedCount: 3, completedCount: 1, ...sameFactTimes,
  });
  const places = metrics.get('requestedPlaces')!;

  assert.equal(places.value, 73, 'The numeric sum includes all and only observed plans.');
  assert.equal(places.timeScope, 'selected_activity_creation_period');
  assert.equal(places.grouping, 'activity');
  assert.equal(places.lastFactOccurredAt, null, 'Plan metrics do not expose a fact or receipt timestamp.');
  assert.equal(places.label, 'Заявленные места (известная часть)');
  assert.match(places.definition, /известной частью суммы/);
  assert.match(places.completeness, /2 из 4/);
  assert.match(places.completeness, /ещё для 2 активностей план не записан/);
});

test('complete plan coverage keeps the ordinary label and explicitly states the coverage', () => {
  const metrics = metricsByKey({
    corporateCount: 2, requestedPlacesCount: 2, requestedPlacesSum: 0,
    enrollmentCount: 0, startedCount: 0, completedCount: 0, lastEnrollmentFactAt: null, lastLearningStartedFactAt: null, lastLearningCompletedFactAt: null,
  });
  const places = metrics.get('requestedPlaces')!;

  assert.equal(places.value, 0, 'A recorded zero remains a known numeric value.');
  assert.equal(places.timeScope, 'selected_activity_creation_period');
  assert.equal(places.label, 'Заявленные места');
  assert.match(places.completeness, /Полное покрытие планов/);
  assert.match(places.completeness, /2 из 2/);
});

test('unique learner and concurrent stream metrics stay null with concrete data-gap reasons', () => {
  const metrics = metricsByKey({
    corporateCount: 1, requestedPlacesCount: 0, requestedPlacesSum: 0,
    enrollmentCount: 5, startedCount: 3, completedCount: 1, ...sameFactTimes,
  });
  const learners = metrics.get('uniqueLearners')!;
  const streams = metrics.get('concurrentStreams')!;
  const enrollment = metrics.get('enrollmentFacts')!;

  assert.equal(learners.value, null);
  assert.equal(learners.lastFactOccurredAt, null);
  assert.equal(learners.grouping, 'not_calculated');
  assert.match(learners.completeness, /^Недостаточно данных:/);
  assert.match(learners.completeness, /стабильного идентификатора обучающегося/);
  assert.equal(streams.value, null);
  assert.equal(streams.lastFactOccurredAt, null);
  assert.match(streams.completeness, /^Недостаточно данных:/);
  assert.match(streams.completeness, /периодов начала и окончания/);
  assert.equal(enrollment.value, 5, 'Adding unknown metrics does not duplicate or alter LMS event counts.');
  assert.equal(enrollment.timeScope, 'selected_activities_all_available_fact_times');
  assert.equal(enrollment.grouping, 'learning_fact_event');
  assert.equal(enrollment.lastFactOccurredAt, asOf, 'The timestamp describes the last event occurrence, not CRM receipt.');
  assert.equal('receivedAt' in enrollment, false, 'No receipt timestamp is inferred.');
});

test('source-level inquiry and learning application totals stay null despite CRM activities and LMS facts', () => {
  const metrics = metricsByKey({
    corporateCount: 4, requestedPlacesCount: 4, requestedPlacesSum: 86,
    enrollmentCount: 7, startedCount: 5, completedCount: 2, ...sameFactTimes,
  });
  const inquiries = metrics.get('incomingInquiries')!;
  const applications = metrics.get('learningApplications')!;

  assert.equal(inquiries.value, null, 'CRM activities are not counted as source inquiries.');
  assert.equal(inquiries.lastFactOccurredAt, null);
  assert.equal(inquiries.timeScope, 'not_calculated');
  assert.equal(inquiries.unit, 'обращений из источников');
  assert.match(inquiries.completeness, /^Недостаточно данных:/);
  assert.match(inquiries.completeness, /срез содержит CRM-активности/);
  assert.match(inquiries.completeness, /полный перечень входящих обращений из источников в пределах доступа пользователя/);

  assert.equal(applications.value, null, 'CRM activities and projected LMS events are not counted as applications.');
  assert.equal(applications.lastFactOccurredAt, null);
  assert.equal(applications.unit, 'заявок на обучение');
  assert.notEqual(inquiries.unit, applications.unit, 'The two source units remain distinct.');
  assert.match(applications.completeness, /^Недостаточно данных:/);
  assert.match(applications.completeness, /срез содержит CRM-активности и факты обучения/);
  assert.match(applications.completeness, /полный перечень заявок на обучение из источников в пределах доступа пользователя/);

  assert.equal(metrics.get('corporateActivities')!.value, 4);
  assert.equal(metrics.get('enrollmentFacts')!.value, 7, 'Existing CRM activity and LMS event metrics retain their values.');
});

test('no recorded corporate plan is unknown rather than a zero-place total', () => {
  const metrics = metricsByKey({
    corporateCount: 2, requestedPlacesCount: 0, requestedPlacesSum: 0,
    enrollmentCount: 0, startedCount: 0, completedCount: 0, lastEnrollmentFactAt: null, lastLearningStartedFactAt: null, lastLearningCompletedFactAt: null,
  });
  const places = metrics.get('requestedPlaces')!;

  assert.equal(places.value, null);
  assert.match(places.completeness, /^Недостаточно данных:/);
  assert.match(places.completeness, /ни для одной из 2/);
});

test('each LMS metric reports only the latest occurrence of its own fact kind', () => {
  const metrics = metricsByKey({
    corporateCount: 1, requestedPlacesCount: 0, requestedPlacesSum: 0,
    enrollmentCount: 2, startedCount: 4, completedCount: 0,
    lastEnrollmentFactAt: '2026-09-27T09:00:00.000Z',
    lastLearningStartedFactAt: '2026-09-27T13:00:00.000Z',
    lastLearningCompletedFactAt: null,
  });

  assert.equal(metrics.get('enrollmentFacts')!.lastFactOccurredAt, '2026-09-27T09:00:00.000Z');
  assert.equal(metrics.get('learningStartedFacts')!.lastFactOccurredAt, '2026-09-27T13:00:00.000Z');
  assert.equal(metrics.get('learningCompletedFacts')!.lastFactOccurredAt, null, 'No completion event means no occurrence timestamp, even when other fact kinds exist.');
});

test('source receipt time is reported only when every counted fact of that kind has an accepted receipt', () => {
  const metrics = metricsByKey({
    corporateCount: 0, requestedPlacesCount: 0, requestedPlacesSum: 0,
    enrollmentCount: 2, startedCount: 1, completedCount: 0,
    lastEnrollmentFactAt: '2026-09-27T08:00:00.000Z', lastLearningStartedFactAt: '2026-09-27T09:00:00.000Z', lastLearningCompletedFactAt: null,
    enrollmentReceiptCount: 1, startedReceiptCount: 1, completedReceiptCount: 0,
    lastEnrollmentFactReceivedAt: '2026-09-27T10:00:00.000Z', lastLearningStartedFactReceivedAt: '2026-09-27T10:05:00.000Z', lastLearningCompletedFactReceivedAt: null,
  });

  assert.equal(metrics.get('enrollmentFacts')!.lastFactOccurredAt, '2026-09-27T08:00:00.000Z');
  assert.equal(metrics.get('enrollmentFacts')!.sourceReceivedAt, null, 'A linked subset must not be presented as the kind’s latest receipt time.');
  assert.equal(metrics.get('learningStartedFacts')!.lastFactOccurredAt, '2026-09-27T09:00:00.000Z');
  assert.equal(metrics.get('learningStartedFacts')!.sourceReceivedAt, '2026-09-27T10:05:00.000Z');
  assert.equal(metrics.get('learningCompletedFacts')!.sourceReceivedAt, null, 'No counted fact means no receipt timestamp.');
});
