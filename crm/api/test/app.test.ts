import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { afterEach } from 'node:test';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildApp, type Authenticator } from '../src/app.js';
import { assertAdmin, DomainError, hasBusinessAccess, hasTeamBusinessScope, type Actor, type ActivityContractLicense, type ActivityContractLicenseFields, type ActivityContractLicenseInput, type ActivityDetailsUpdate, type ActivityDocument, type ActivityFilters, type ActivityReassignmentPreviewInput, type ActivityReassignmentResult, type CorporatePlan, type CorporatePlanInput, type CrmRepository, type GuidanceArticleContent, type GuidanceEditorialRecord, type GuidanceFeedback, type GuidanceFeedbackAction, type ManagerOverview, type NewActivity, type NewActivityDocument, type NewTask, type Outcome, type StoredActivityDocument, type UniversityCorrectionReturn, type UniversityStepUpdate, type UniversityWorkflowApply, type UniversityWorkflowChange } from '../src/domain.js';
import { previewUniversityWorkflow, type UniversityWorkflowState } from '../src/university-workflow.js';
import { guidanceStageSnapshot, validateGuidanceArticleContent } from '../src/guidance.js';
import { removePrivateDocument } from '../src/document-files.js';
import { MAX_ACTIVITY_DOCUMENT_BYTES } from '../src/document-files.js';
import { assertAccessPolicyChange, type AccessPolicyService, type AccessPolicyUser } from '../src/access-policy-service.js';

const anna: Actor = { sub: 'kam-anna', name: 'Анна Орлова', roles: ['kam'] };
const dmitry: Actor = { sub: 'kam-dmitry', name: 'Дмитрий Соколов', roles: ['kam'] };
const manager: Actor = { sub: 'manager', name: 'Руководитель', roles: ['manager'] };
const admin: Actor = { sub: 'admin', name: 'Администратор', roles: ['admin'] };
const managerAdmin: Actor = { sub: 'manager-admin', name: 'Администратор и руководитель', roles: ['admin', 'manager'] };
const id = '550e8400-e29b-41d4-a716-446655440000';
const taskId = '550e8400-e29b-41d4-a716-446655440001';

class MemoryRepository implements CrmRepository {
  activity: Record<string, any> = { id, kind: 'university', title: 'Пилотная программа', organizationName: 'Синтетический вуз', stageKey: 'contact', stageLabel: 'Первичный контакт', routeVersion: 'legacy', workflowRevision: 1, revision: 0, personId: null, productIds: [], allowedNext: ['meeting'], ownerSub: anna.sub, priority: 2, tasks: [] };
  events: Record<string, any>[] = [];
  tasks: Record<string, any>[] = [];
  taskSubscriptions: { activityId: string; taskId: string; subscriberSub: string }[] = [];
  notificationRows: Record<string, any>[] = [];
  learningFacts: Record<string, any>[] = [];
  documents: StoredActivityDocument[] = [];
  savedCorporatePlan: CorporatePlan | null = null;
  savedContractLicenses: ActivityContractLicense[] = [];
  universityProgress = new Map<string, Record<string, any>>();
  guidanceFeedback = new Map<string, GuidanceFeedback>();
  guidanceArticles = new Map<string, GuidanceEditorialRecord>();
  learningPrograms: { id: string; name: string; priority: number; revision: number; demandCount: number }[] = [];
  createInput?: NewActivity;
  workflowOverride?: Record<string, unknown>[];
  universityWorkflowRevision = 1;
  universityWorkflowStages = [
    { key: 'contact', label: 'Первичный контакт', ordinal: 1, terminal: false },
    { key: 'meeting', label: 'Встреча и потребность', ordinal: 2, terminal: false },
    { key: 'documents', label: 'Документы и согласование', ordinal: 3, terminal: false },
    { key: 'implementation', label: 'Внедрение', ordinal: 4, terminal: false },
    { key: 'closed', label: 'Завершено', ordinal: 5, terminal: true },
  ];
  universityWorkflowTransitions = [
    { from: 'contact', to: 'meeting' }, { from: 'meeting', to: 'documents' },
    { from: 'documents', to: 'implementation' }, { from: 'implementation', to: 'closed' },
  ];
  overview: ManagerOverview = {
    asOf: new Date().toISOString(),
    metrics: { totalOpen: 1, byKind: { university: 1, corporate: 0, individual: 0 }, overdue: 0, awaitingReply: 0, noNextStep: 1 },
    byOwner: [{ ownerSub: anna.sub, ownerName: anna.name, open: 1, overdue: 0 }],
    topProducts: [],
    pipeline: [],
    definitions: {
      totalOpen: 'Открытые активности CRM; каждая активность считается один раз.',
      byKind: 'Открытые активности по типу: вуз, компания или физлицо.',
      overdue: 'Просрочена ближайшая открытая задача; активность считается один раз.',
      awaitingReply: 'Активности с зафиксированным исходом «Ожидаю ответ».',
      noNextStep: 'Открытые активности без открытых задач.',
      byOwner: 'Открытые и просроченные активности по ответственному КАМ.',
      topProducts: 'Число уникальных открытых активностей, связанных с продуктом.',
      pipeline: 'Текущий этап активности.',
    },
  };

  private canSee(actor: Actor) { return hasTeamBusinessScope(actor) || (hasBusinessAccess(actor) && this.activity.ownerSub === actor.sub); }
  private requireVisible(actor: Actor) { if (!this.canSee(actor)) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.'); }
  extraActivities: Record<string, any>[] = [];
  lastActivityFilters?: ActivityFilters;
  async listActivities(actor: Actor, filters: ActivityFilters) {
    this.lastActivityFilters = filters;
    const rows = [this.activity, ...this.extraActivities].filter((item) => {
      if (!hasTeamBusinessScope(actor) && (!hasBusinessAccess(actor) || item.ownerSub !== actor.sub)) return false;
      if (filters.segment === 'university' && item.kind !== 'university') return false;
      if (filters.segment === 'company' && item.kind !== 'corporate') return false;
      if (filters.segment === 'individual' && item.kind !== 'individual') return false;
      if (filters.ownerSub && item.ownerSub !== filters.ownerSub) return false;
      if (filters.productId && !item.productIds?.includes(filters.productId)) return false;
      const search = filters.search?.trim().toLowerCase();
      if (search && ![item.title, item.organizationName, item.personName].some((value) => String(value ?? '').toLowerCase().includes(search))) return false;
      if (filters.collection === 'awaiting_reply' && !item.awaitingReply) return false;
      if (filters.collection === 'no_next_step' && (item.nextTaskId || item.nextTaskDueAt)) return false;
      if (filters.collection === 'overdue' && (!item.nextTaskDueAt || Date.parse(item.nextTaskDueAt) >= Date.now())) return false;
      return true;
    });
    return { items: rows.slice(filters.offset, filters.offset + filters.limit), total: rows.length, offset: filters.offset, limit: filters.limit };
  }
  async managerOverview() { return this.overview; }
  async listLearningPrograms(actor: Actor) { return this.learningPrograms.map((program) => ({ ...program, demandCount: [this.activity, ...this.extraActivities].filter((item) => item.programIds?.includes(program.id) && (hasTeamBusinessScope(actor) || (hasBusinessAccess(actor) && item.ownerSub === actor.sub))).length })); }
  async createLearningProgram(_actor: Actor, name: string) {
    if (this.learningPrograms.some((program) => program.name.toLowerCase() === name.trim().toLowerCase())) throw new DomainError(409, 'program_name_conflict', 'exists');
    const program = { id: randomUUID(), name: name.trim(), priority: 3, revision: 0, demandCount: 0 };
    this.learningPrograms.push(program);
    return program;
  }
  async updateLearningProgramPriority(_actor: Actor, programId: string, priority: number, expectedRevision: number) {
    const program = this.learningPrograms.find((item) => item.id === programId);
    if (!program) throw new DomainError(404, 'program_not_found', 'not found');
    if (program.revision !== expectedRevision) throw new DomainError(409, 'program_revision_conflict', 'stale');
    program.priority = priority; program.revision += 1;
    return { ...program };
  }
  async listAssignableKams(actor: Actor) {
    if (!actor.roles.includes('manager')) throw new DomainError(403, 'forbidden', 'Для назначения нужна роль руководителя.');
    return [{ sub: anna.sub, name: anna.name }, { sub: dmitry.sub, name: dmitry.name }];
  }
  async previewActivityReassignment(actor: Actor, activityId: string, input: ActivityReassignmentPreviewInput) {
    if (!actor.roles.includes('manager')) throw new DomainError(403, 'forbidden', 'Для назначения нужна роль руководителя.');
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (input.expectedOwnerSub !== this.activity.ownerSub || input.expectedAssignmentRevision !== (this.activity.assignmentRevision ?? 0)) throw new DomainError(409, 'activity_changed', 'Активность изменилась.');
    const targetOwner = (await this.listAssignableKams(actor)).find((kam) => kam.sub === input.targetKamSub);
    if (!targetOwner) throw new DomainError(400, 'invalid_target_kam', 'Выберите действующего КАМ.');
    return {
      activityId, title: this.activity.title, kind: this.activity.kind, currentOwner: { sub: this.activity.ownerSub, name: this.activity.ownerName ?? anna.name },
      targetOwner, assignmentRevision: this.activity.assignmentRevision ?? 0, updatedAt: this.activity.updatedAt ?? new Date().toISOString(),
      canConfirm: targetOwner.sub !== this.activity.ownerSub, previewToken: targetOwner.sub === this.activity.ownerSub ? null : '550e8400-e29b-41d4-a716-446655440004',
      blockers: [], impact: { stageKey: this.activity.stageKey, stageLabel: this.activity.stageLabel, closed: false, awaitingReply: false,
        createdAt: this.activity.createdAt ?? new Date().toISOString(), historyEventCount: this.events.length, taskCount: this.tasks.length,
        openTaskCount: this.tasks.filter((task) => task.status === 'open').length, nextOpenTaskDueAt: this.tasks.find((task) => task.status === 'open')?.dueAt ?? null,
        openTasksWillTransfer: true, completedTaskAttributionWillRemain: true },
    };
  }
  async confirmActivityReassignment(actor: Actor, activityId: string, _previewToken: string): Promise<ActivityReassignmentResult> {
    if (!actor.roles.includes('manager')) throw new DomainError(403, 'forbidden', 'Для назначения нужна роль руководителя.');
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    const previousOwner = { sub: this.activity.ownerSub, name: this.activity.ownerName ?? anna.name };
    const owner = { sub: dmitry.sub, name: dmitry.name };
    this.activity.ownerSub = owner.sub; this.activity.ownerName = owner.name; this.activity.assignmentRevision = (this.activity.assignmentRevision ?? 0) + 1;
    const eventId = 'owner-event';
    this.events.unshift({ id: eventId, eventType: 'owner_reassigned', summary: 'Ответственный КАМ изменён', actorName: actor.name });
    return { activityId, previousOwner, owner, assignmentRevision: this.activity.assignmentRevision, updatedAt: new Date().toISOString(), openTasksReassigned: 0, completedTasksPreserved: 0, eventId };
  }
  async getActivity(actor: Actor, activityId: string) { return this.canSee(actor) && activityId === this.activity.id ? { ...this.activity, programIds: this.activity.programIds ?? [], programNames: this.learningPrograms.filter((program) => this.activity.programIds?.includes(program.id)).map((program) => program.name) } : null; }
  async updateActivityDetails(actor: Actor, activityId: string, input: ActivityDetailsUpdate) {
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    this.requireVisible(actor);
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённую активность можно только просматривать.');
    if ((this.activity.revision ?? 0) !== input.expectedRevision) throw new DomainError(409, 'activity_revision_conflict', 'Основные сведения активности уже изменились. Обновите карточку.');
    const nextPersonId = input.newPerson ? randomUUID() : input.personId ?? null;
    if (this.activity.kind === 'individual' && nextPersonId === null) throw new DomainError(400, 'person_required', 'Для активности физлица контакт обязателен.');
    const previous = { personId: this.activity.personId ?? null, productIds: [...(this.activity.productIds ?? [])], priority: this.activity.priority };
    const nextRevision = input.expectedRevision + 1;
    this.activity = { ...this.activity, personId: nextPersonId, personName: input.newPerson?.fullName ?? (nextPersonId === null ? null : this.activity.personName), email: input.newPerson?.email ?? null, phone: input.newPerson?.phone ?? null, productIds: [...input.productIds].sort(), ...(input.programIds !== undefined ? { programIds: [...input.programIds].sort() } : {}), priority: input.priority, revision: nextRevision, updatedAt: new Date().toISOString() };
    this.events.unshift({ eventType: 'activity_details_updated', summary: 'Обновлены основные сведения активности', actorName: actor.name, createdAt: this.activity.updatedAt, details: { revision: nextRevision, ...(input.newPerson ? { contactCreated: true } : {}), previous, current: { personId: nextPersonId, productIds: this.activity.productIds, priority: input.priority } } });
    return { id: activityId, personId: nextPersonId, productIds: this.activity.productIds, programIds: this.activity.programIds ?? [], priority: input.priority, revision: nextRevision, stageKey: this.activity.stageKey, updatedAt: this.activity.updatedAt };
  }
  private guidanceFeedbackKey(actor: Actor, activityId: string, recommendationKey: string) { return `${actor.sub}:${activityId}:${recommendationKey}`; }
  async getGuidanceFeedback(actor: Actor, activityId: string, recommendationKey: string) {
    if (activityId !== this.activity.id || !this.canSee(actor)) return null;
    return this.guidanceFeedback.get(this.guidanceFeedbackKey(actor, activityId, recommendationKey)) ?? null;
  }
  async saveGuidanceFeedback(actor: Actor, activityId: string, recommendationKey: string, action: GuidanceFeedbackAction, reason: string | null) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённую активность можно только просматривать.');
    const now = new Date();
    const row: GuidanceFeedback = { action, reason, deferredUntil: action === 'defer' ? new Date(now.valueOf() + 86_400_000).toISOString() : null, updatedAt: now.toISOString() };
    this.guidanceFeedback.set(this.guidanceFeedbackKey(actor, activityId, recommendationKey), row);
    return row;
  }
  async getGuidanceCatalog() { return { workflow: await this.getWorkflow(), articles: [...this.guidanceArticles.values()] }; }
  async saveGuidanceDraft(actor: Actor, kind: 'university' | 'individual' | 'corporate', stageKey: string, rawArticle: GuidanceArticleContent, expectedRevision: number) {
    if (!actor.roles.includes('manager')) throw new DomainError(403, 'forbidden', 'Для редактирования инструкции нужна роль руководителя.');
    const stage = (await this.getWorkflow()).find((candidate: any) => candidate.kind === kind && candidate.key === stageKey) as Record<string, any> | undefined;
    if (!stage) throw new DomainError(409, 'guidance_stage_stale', 'Стадия отсутствует в текущей схеме.');
    const article = validateGuidanceArticleContent(rawArticle);
    const key = `${kind}:${stageKey}`;
    const old = this.guidanceArticles.get(key);
    const currentRevision = old?.draftRevision ?? 0;
    if (currentRevision !== expectedRevision) throw new DomainError(409, 'guidance_draft_conflict', 'Черновик уже изменился.');
    const snapshot = guidanceStageSnapshot(stage);
    const now = new Date().toISOString();
    const record: GuidanceEditorialRecord = { kind, stageKey, seedStageSnapshot: old?.seedStageSnapshot ?? snapshot,
      draftArticle: article, draftRevision: currentRevision + 1, draftStageSnapshot: snapshot,
      publishedArticle: old?.publishedArticle ?? null, publishedRevision: old?.publishedRevision ?? null,
      publishedStageSnapshot: old?.publishedStageSnapshot ?? null, publishedAt: old?.publishedAt ?? null,
      publishedByName: old?.publishedByName ?? null, updatedAt: now };
    this.guidanceArticles.set(key, record);
    return record;
  }
  async publishGuidanceArticle(actor: Actor, kind: 'university' | 'individual' | 'corporate', stageKey: string, expectedDraftRevision: number) {
    if (!actor.roles.includes('admin')) throw new DomainError(403, 'forbidden', 'Для публикации инструкции нужна роль администратора.');
    const key = `${kind}:${stageKey}`;
    const old = this.guidanceArticles.get(key);
    if (!old?.draftArticle || old.draftRevision < 1) throw new DomainError(409, 'guidance_draft_missing', 'Сначала сохраните черновик инструкции.');
    if (old.draftRevision !== expectedDraftRevision) throw new DomainError(409, 'guidance_draft_conflict', 'Черновик уже изменился.');
    const stage = (await this.getWorkflow()).find((candidate: any) => candidate.kind === kind && candidate.key === stageKey) as Record<string, any> | undefined;
    if (!stage) throw new DomainError(409, 'guidance_stage_stale', 'Стадия отсутствует в текущей схеме.');
    const record: GuidanceEditorialRecord = { ...old, publishedArticle: old.draftArticle, publishedRevision: old.draftRevision,
      publishedStageSnapshot: guidanceStageSnapshot(stage), publishedAt: new Date().toISOString(), publishedByName: actor.name };
    this.guidanceArticles.set(key, record);
    return record;
  }
  async createActivity(actor: Actor, input: NewActivity) {
    this.createInput = input;
    const stageKey = input.kind === 'individual' && input.origin === 'external_ready' ? 'lms_handoff' : input.kind === 'individual' ? 'request' : input.kind === 'corporate' ? 'qualification' : 'contact';
    const routeVersion = input.kind === 'individual' ? 'v2' : 'legacy';
    const allowedNext = stageKey === 'lms_handoff' ? ['exceptions', 'result'] : stageKey === 'request' ? ['consultation'] : stageKey === 'contact' ? ['meeting'] : [];
    this.activity = { id, kind: input.kind, title: input.title, origin: input.origin ?? 'manual', originSource: input.originSource ?? null, originReference: input.originReference ?? null, routeVersion, workflowRevision: input.kind === 'university' ? this.universityWorkflowRevision : null, allowedNext, stageKey, stageLabel: stageKey === 'lms_handoff' ? 'Передача в LMS' : 'Стартовая стадия', ownerSub: actor.sub, priority: input.priority ?? 3, tasks: [] };
    const details = stageKey === 'lms_handoff' ? { origin: 'external_ready', routeVersion, source: input.originSource, reference: input.originReference, initialStage: stageKey, mappingReason: 'Готовый внешний заказ направлен к передаче в LMS; ручные стадии продажи пропущены. Зачисление, начало обучения и исход не создавались.' } : { origin: input.origin ?? 'manual', routeVersion, initialStage: stageKey };
    this.events.unshift({ id: 'created', eventType: 'created', summary: 'Создана активность', actorName: actor.name, createdAt: new Date().toISOString(), details });
    return this.activity;
  }
  async getWorkflow() {
    return this.workflowOverride ?? [
      ...[
        ['contact', 'Первичный контакт'], ['meeting', 'Встреча и потребность'], ['documents', 'Документы и согласование'], ['implementation', 'Внедрение'], ['closed', 'Завершено'],
      ].map(([key, label], index) => ({ kind: 'university', key, label, ordinal: index + 1, terminal: key === 'closed', allowedNext: key === 'contact' ? ['meeting'] : [] })),
      ...[
        ['request', 'Новая заявка'], ['consultation', 'Консультация'], ['conditions', 'Условия обучения'], ['lms_handoff', 'Передача в LMS'], ['exceptions', 'Исключения и возврат'], ['result', 'Итог сопровождения'], ['enrollment', 'Подготовка к обучению'], ['learning', 'Обучение'], ['closed', 'Завершено'],
      ].map(([key, label], index) => ({ kind: 'individual', key, label, ordinal: index + 1, terminal: key === 'closed', allowedNext: [] })),
      ...[
        ['qualification', 'Потребность компании'], ['brief', 'Бриф и оценка'], ['approval', 'Согласование программы'], ['launch', 'Подготовка запуска'], ['closed', 'Завершено'],
      ].map(([key, label], index) => ({ kind: 'corporate', key, label, ordinal: index + 1, terminal: key === 'closed', allowedNext: [] })),
    ];
  }
  private universityWorkflowState(): UniversityWorkflowState {
    const allActivities = [this.activity, ...this.extraActivities].filter((item) => item.kind === 'university');
    const labelByKey = new Map(this.universityWorkflowStages.map((stage) => [stage.key, stage.label]));
    return {
      revision: this.universityWorkflowRevision,
      stages: this.universityWorkflowStages,
      transitions: this.universityWorkflowTransitions,
      activities: allActivities.map((item) => ({
        id: item.id, title: item.title, ownerName: item.ownerName ?? '', stageKey: item.stageKey,
        stageLabel: labelByKey.get(item.stageKey) ?? item.stageLabel ?? item.stageKey, closed: item.closed === true,
      })),
    };
  }
  async getUniversityWorkflowAdmin(actor: Actor) {
    assertAdmin(actor);
    return { kind: 'university', revision: this.universityWorkflowRevision, stages: this.universityWorkflowStages, transitions: this.universityWorkflowTransitions };
  }
  async previewUniversityWorkflow(actor: Actor, input: UniversityWorkflowChange) {
    assertAdmin(actor);
    return previewUniversityWorkflow(this.universityWorkflowState(), input);
  }
  async applyUniversityWorkflow(actor: Actor, input: UniversityWorkflowApply) {
    assertAdmin(actor);
    const preview = previewUniversityWorkflow(this.universityWorkflowState(), input);
    if (preview.previewToken !== input.previewToken) throw new DomainError(409, 'workflow_preview_stale', 'Создайте новый предпросмотр.');
    if (!preview.canApply) throw new DomainError(409, 'workflow_preview_blocked', 'Исправьте блокировки.');
    const activityMap = new Map([this.activity, ...this.extraActivities].map((activity) => [activity.id, activity]));
    for (const affected of preview.impactedActivities as Record<string, any>[]) {
      if (!affected.changeRequired) continue;
      const activity = activityMap.get(affected.id as string);
      if (!activity) continue;
      activity.stageKey = affected.targetStageKey;
      activity.stageLabel = affected.targetStageLabel;
      this.events.unshift({ eventType: 'workflow_stage_migrated', summary: `Стадия перенесена: ${affected.stageLabel} → ${affected.targetStageLabel}`, actorName: actor.name });
    }
    this.universityWorkflowStages = input.stages;
    this.universityWorkflowTransitions = input.transitions;
    this.universityWorkflowRevision += 1;
    for (const activity of [this.activity, ...this.extraActivities]) if (activity.kind === 'university') activity.workflowRevision = this.universityWorkflowRevision;
    return { kind: 'university', revision: this.universityWorkflowRevision, migratedCount: preview.counts.changedOpen + preview.counts.changedClosed, preservedClosedCount: preview.counts.changedClosed, changedActivities: preview.impactedActivities.filter((row: any) => row.changeRequired) };
  }
  async createTask(actor: Actor, activityId: string, input: NewTask) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    const task = { id: taskId, title: input.title, dueAt: input.dueAt, status: 'open', ownerName: actor.name };
    this.tasks.push(task); this.activity.tasks = this.tasks;
    this.events.unshift({ id: 'task', eventType: 'task_created', summary: `Поставлено действие: ${input.title}`, actorName: actor.name, createdAt: new Date().toISOString(), details: { taskId } });
    return task;
  }
  async activityFeed(actor: Actor, input: { limit: number; cursor?: string; actorSub?: string }) {
    if (!hasTeamBusinessScope(actor) && input.actorSub !== undefined && input.actorSub !== actor.sub) throw new DomainError(403, 'feed_actor_forbidden', 'Можно просматривать только события, созданные вами.');
    const rows = this.events.filter((event) => hasTeamBusinessScope(actor) ? (input.actorSub === undefined || event.actorSub === input.actorSub) : event.actorSub === actor.sub)
      .slice(0, input.limit)
      .map((event) => ({ id: event.id, activityId: id, activityTitle: this.activity.title, kind: this.activity.kind, eventType: event.eventType, summary: event.summary, actorSub: event.actorSub, actorName: event.actorName, createdAt: event.createdAt, ...(event.details?.text ? { text: event.details.text } : {}), ...(event.details?.taskId ? { taskId: event.details.taskId } : {}) }));
    return { items: rows, nextCursor: null };
  }
  async taskSubscription(actor: Actor, activityId: string, targetTaskId: string) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id || !this.tasks.some((task) => task.id === targetTaskId)) throw new DomainError(404, 'task_not_found', 'Действие не найдено.');
    return { subscribed: this.taskSubscriptions.some((row) => row.activityId === activityId && row.taskId === targetTaskId && row.subscriberSub === actor.sub) };
  }
  async setTaskSubscription(actor: Actor, activityId: string, targetTaskId: string, subscribed: boolean) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id || !this.tasks.some((task) => task.id === targetTaskId)) throw new DomainError(404, 'task_not_found', 'Действие не найдено.');
    if (this.activity.closed && subscribed) throw new DomainError(409, 'activity_closed', 'Завершённую активность можно только просматривать.');
    this.taskSubscriptions = this.taskSubscriptions.filter((row) => !(row.activityId === activityId && row.taskId === targetTaskId && row.subscriberSub === actor.sub));
    if (subscribed) this.taskSubscriptions.push({ activityId, taskId: targetTaskId, subscriberSub: actor.sub });
    return { subscribed };
  }
  async createTaskUpdate(actor: Actor, activityId: string, targetTaskId: string, text: string) {
    this.requireVisible(actor);
    const task = this.tasks.find((item) => item.id === targetTaskId);
    if (activityId !== this.activity.id || !task) throw new DomainError(404, 'task_not_found', 'Действие не найдено.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённую активность можно только просматривать.');
    const createdAt = new Date().toISOString();
    const event = { id: randomUUID(), activityId, taskId: targetTaskId, eventType: 'task_updated', summary: `Обновление по действию «${String(task.title).slice(0, 180)}»`, actorSub: actor.sub, actorName: actor.name, createdAt, details: { taskId: targetTaskId, text: text.trim() } };
    this.events.unshift(event);
    for (const subscription of this.taskSubscriptions) if (subscription.activityId === activityId && subscription.taskId === targetTaskId && subscription.subscriberSub !== actor.sub) {
      this.notificationRows.unshift({ id: randomUUID(), activityId, activityTitle: this.activity.title, taskId: targetTaskId, eventType: 'task_updated', summary: event.summary, text: event.details.text, actorName: actor.name, createdAt, readAt: null, recipientSub: subscription.subscriberSub });
    }
    return { ...event, text: event.details.text };
  }
  async notifications(actor: Actor, input: { limit: number; cursor?: string }) {
    const rows = this.notificationRows.filter((row) => row.recipientSub === actor.sub && this.canSee(actor)).slice(0, input.limit)
      .map(({ recipientSub: _recipientSub, ...notification }) => notification);
    return { items: rows, nextCursor: null, unreadCount: this.notificationRows.filter((row) => row.recipientSub === actor.sub && !row.readAt && this.canSee(actor)).length };
  }
  async markNotificationRead(actor: Actor, notificationId: string) {
    const notification = this.notificationRows.find((row) => row.id === notificationId && row.recipientSub === actor.sub && this.canSee(actor));
    if (!notification) throw new DomainError(404, 'notification_not_found', 'Уведомление не найдено.');
    notification.readAt ??= new Date().toISOString();
    return { id: notificationId, readAt: notification.readAt };
  }
  async completeTask(actor: Actor, activityId: string, targetTaskId: string) {
    this.requireVisible(actor);
    const task = this.tasks.find((entry) => entry.id === targetTaskId);
    if (activityId !== this.activity.id || !task) throw new DomainError(404, 'task_not_found', 'Действие не найдено.');
    if (task.status === 'done') throw new DomainError(409, 'task_already_done', 'Действие уже выполнено.');
    task.status = 'done';
    this.events.unshift({ id: 'completed', eventType: 'task_completed', summary: `Выполнено действие: ${task.title}`, actorName: actor.name, createdAt: new Date().toISOString(), details: { taskId } });
    return task;
  }
  async recordOutcome(actor: Actor, activityId: string, outcome: Outcome, note: string) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (['cancelled', 'refused'].includes(outcome) && !note.trim()) throw new DomainError(400, 'closure_outcome_reason_required', 'Для отмены или отказа укажите причину.');
    this.activity.awaitingReply = outcome === 'awaiting_reply';
    const closureOutcome = ['cancelled', 'refused'].includes(outcome);
    this.events.unshift({ id: 'outcome', eventType: closureOutcome ? 'closure_outcome_recorded' : 'outcome_recorded', summary: `${closureOutcome ? 'Итог завершения' : 'Итог контакта'}: ${outcome}`, actorName: actor.name, createdAt: new Date().toISOString(), details: { outcome, note, ...(closureOutcome ? { stageKey: this.activity.stageKey } : {}) } });
    return { outcome, note };
  }
  async transition(actor: Actor, activityId: string, targetStage: string, expectedStageKey: string, expectedWorkflowRevision: number | null) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.stageKey !== expectedStageKey) throw new DomainError(409, 'transition_stage_conflict', 'Обновите карточку.');
    if (this.activity.kind === 'university' && expectedWorkflowRevision !== this.universityWorkflowRevision) throw new DomainError(409, 'workflow_revision_conflict', 'Обновите карточку.');
    if (this.activity.stageKey !== 'contact' || targetStage !== 'meeting') throw new DomainError(409, 'transition_not_allowed', 'Этот переход не разрешён текущей схемой.');
    const previous = this.activity.stageKey;
    this.activity = { ...this.activity, stageKey: targetStage, stageLabel: 'Встреча' };
    this.events.unshift({ id: 'stage', eventType: 'stage_changed', summary: 'Стадия изменена: Встреча', actorName: actor.name, createdAt: new Date().toISOString(), details: { from: previous, to: targetStage } });
    return { id: activityId, from: previous, stageKey: targetStage, stageLabel: 'Встреча', closed: false };
  }
  async history(actor: Actor, activityId: string) { return activityId === this.activity.id && this.canSee(actor) ? this.events : null; }
  async listActivityDocuments(actor: Actor, activityId: string): Promise<ActivityDocument[] | null> {
    if (activityId !== this.activity.id || !this.canSee(actor)) return null;
    return this.documents.map(({ objectKey: _objectKey, ...document }) => document);
  }
  async addActivityDocument(actor: Actor, input: NewActivityDocument): Promise<ActivityDocument> {
    this.requireVisible(actor);
    if (input.activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'В закрытую активность нельзя добавлять документы.');
    const document = { ...input, uploadedAt: new Date().toISOString(), uploadedByName: actor.name };
    this.documents.unshift(document);
    this.events.unshift({ id: document.id, eventType: 'document_uploaded', summary: `Добавлен документ: ${document.name}`, actorName: actor.name, createdAt: document.uploadedAt, details: { documentId: document.id } });
    return (({ objectKey: _objectKey, ...publicDocument }) => publicDocument)(document);
  }
  async getActivityDocumentForDownload(actor: Actor, activityId: string, documentId: string): Promise<StoredActivityDocument | null> {
    const document = this.documents.find((item) => item.activityId === activityId && item.id === documentId);
    if (!document || !this.canSee(actor)) return null;
    return document;
  }
  async recordActivityDocumentDownload(actor: Actor, activityId: string, documentId: string): Promise<boolean> {
    const document = this.documents.find((item) => item.activityId === activityId && item.id === documentId);
    if (!document || !this.canSee(actor)) return false;
    this.events.unshift({ id: `${document.id}-download`, eventType: 'document_downloaded', summary: `Скачан документ: ${document.name}`, actorName: actor.name, createdAt: new Date().toISOString(), details: { documentId: document.id } });
    return true;
  }
  async individualLearningFacts(actor: Actor, activityId: string) {
    if (activityId !== this.activity.id || !this.canSee(actor)) return null;
    if (this.activity.kind !== 'individual') throw new DomainError(409, 'learning_facts_not_applicable', 'Учебная проекция доступна только для индивидуального процесса.');
    return this.learningFacts;
  }
  async corporatePlan(actor: Actor, activityId: string) {
    if (activityId !== this.activity.id || !this.canSee(actor)) return null;
    if (this.activity.kind !== 'corporate') throw new DomainError(409, 'corporate_plan_not_applicable', 'План программы доступен только для корпоративных активностей.');
    if (this.savedCorporatePlan) return { ...this.savedCorporatePlan, readOnly: Boolean(this.activity.closed) };
    return {
      programMode: 'undecided', requestedPlaces: null,
      brief: { expectedOutcome: null, audience: null, entryLevel: null, deliveryFormat: null, volume: null, technologyContext: null },
      methodologist: { name: null, feasibility: 'unassessed', note: null },
      proposed: { scope: null, startDate: null, endDate: null, acceptanceCriteria: null },
      agreed: { scope: null, startDate: null, endDate: null, acceptanceCriteria: null },
      approval: { status: 'not_recorded', evidenceReference: null, evidenceSource: null, note: null },
      revision: 0, updatedAt: null, updatedBy: null, readOnly: Boolean(this.activity.closed),
    } as CorporatePlan;
  }
  async updateCorporatePlan(actor: Actor, activityId: string, input: CorporatePlanInput) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.kind !== 'corporate') throw new DomainError(409, 'corporate_plan_not_applicable', 'План программы доступен только для корпоративных активностей.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Закрытую активность можно только просматривать.');
    const current = await this.corporatePlan(actor, activityId);
    if (input.expectedRevision !== current?.revision) throw new DomainError(409, 'revision_conflict', 'План уже изменился. Обновите карточку.');
    const now = new Date().toISOString();
    const { expectedRevision: _expectedRevision, ...data } = input;
    this.savedCorporatePlan = { ...data, revision: input.expectedRevision + 1, updatedAt: now, updatedBy: actor.name, readOnly: false };
    this.events.unshift({ id: `corp-plan-${this.savedCorporatePlan.revision}`, eventType: 'corporate_plan_updated', summary: `План корпоративной программы обновлён · версия ${this.savedCorporatePlan.revision}`, actorName: actor.name, createdAt: now, details: { previous: current, current: this.savedCorporatePlan, previousRevision: current?.revision, revision: this.savedCorporatePlan.revision } });
    return this.savedCorporatePlan;
  }
  async listActivityContractLicenses(actor: Actor, activityId: string) {
    if (activityId !== this.activity.id || !this.canSee(actor)) return null;
    return this.savedContractLicenses.map((item) => ({ ...item, readOnly: Boolean(this.activity.closed) }));
  }
  async addActivityContractLicense(actor: Actor, activityId: string, input: ActivityContractLicenseFields) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Закрытую активность можно только просматривать.');
    const now = new Date().toISOString();
    const value: ActivityContractLicense = { ...input, id: randomUUID(), activityId, documentName: input.documentId ? this.documents.find((doc) => doc.id === input.documentId)?.name ?? null : null, revision: 1, updatedAt: now, updatedBy: actor.name, readOnly: false };
    this.savedContractLicenses.push(value);
    this.events.unshift({ id: value.id, eventType: 'contract_license_created', summary: `Добавлена запись договора или лицензии: ${value.title}`, actorName: actor.name, createdAt: now, details: { recordId: value.id, current: value } });
    return value;
  }
  async updateActivityContractLicense(actor: Actor, activityId: string, recordId: string, input: ActivityContractLicenseInput) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Закрытую активность можно только просматривать.');
    const index = this.savedContractLicenses.findIndex((item) => item.id === recordId);
    if (index < 0) throw new DomainError(404, 'contract_license_not_found', 'Запись не найдена.');
    const current = this.savedContractLicenses[index];
    if (current.revision !== input.expectedRevision) throw new DomainError(409, 'revision_conflict', 'Запись уже изменилась.');
    const now = new Date().toISOString();
    const value: ActivityContractLicense = { ...current, ...input, revision: current.revision + 1, updatedAt: now, updatedBy: actor.name, documentName: input.documentId ? this.documents.find((doc) => doc.id === input.documentId)?.name ?? null : null };
    this.savedContractLicenses[index] = value;
    this.events.unshift({ id: `${value.id}-${value.revision}`, eventType: 'contract_license_updated', summary: `Обновлена запись договора или лицензии: ${value.title}`, actorName: actor.name, createdAt: now, details: { previous: current, current: value } });
    return value;
  }
  async deleteActivityContractLicense(actor: Actor, activityId: string, recordId: string, expectedRevision: number) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Закрытую активность можно только просматривать.');
    const index = this.savedContractLicenses.findIndex((item) => item.id === recordId);
    if (index < 0) throw new DomainError(404, 'contract_license_not_found', 'Запись не найдена.');
    const deleted = this.savedContractLicenses[index];
    if (deleted.revision !== expectedRevision) throw new DomainError(409, 'revision_conflict', 'Запись уже изменилась.');
    this.savedContractLicenses.splice(index, 1);
    const now = new Date().toISOString();
    this.events.unshift({ id: `${deleted.id}-deleted`, eventType: 'contract_license_deleted', summary: `Удалена запись договора или лицензии: ${deleted.title}`, actorName: actor.name, createdAt: now, details: { deleted } });
    return true;
  }
  private stepDefinitionRows() {
    const ids = ['U01','U02','U03','U04','U05','U06','U07','U08','U09','U10','U11','U12','U13'];
    const labels = ['Контакт ответственного','Актуальность программ','Встреча','Обмен документами','Корректировка документов','Подписание документов','Передача материалов и лицензии','Сопровождение внедрения','Обучение преподавателей','Актуализация учебной программы','Ведение занятий','Актуализация материалов','Повышение квалификации'];
    return ids.map((stepId, index) => ({ stepId, label: labels[index], description: `Описание ${stepId}`, groupKey: index < 2 ? 'contact' : index < 3 ? 'meeting' : index < 6 ? 'documents' : index < 8 ? 'launch' : 'learning', groupLabel: index < 2 ? 'Контакт и потребность' : index < 3 ? 'Встреча' : index < 6 ? 'Документы' : index < 8 ? 'Передача и внедрение' : 'Учебная работа и материалы', ordinal: index + 1, optional: stepId === 'U05' }));
  }
  async universitySteps(actor: Actor, activityId: string) {
    if (!this.canSee(actor) || activityId !== this.activity.id) return null;
    if (this.activity.kind !== 'university') throw new DomainError(409, 'university_steps_not_applicable', 'Пункты партнёрства доступны только для вузовских активностей.');
    const steps = this.stepDefinitionRows().map((definition) => ({ ...definition, ...(this.universityProgress.get(definition.stepId) ?? { status: 'unrecorded', note: '', evidenceReference: null, evidenceSource: null, actorSub: null, actorName: null, updatedAt: null, revision: 0 }) }));
    const statusCounts = Object.fromEntries(['unrecorded','in_progress','waiting','documented','not_applicable'].map((status) => [status, steps.filter((step) => step.status === status).length]));
    const openTasks = this.tasks.filter((task) => task.status === 'open');
    const latest = this.events[0];
    return { steps, readOnly: Boolean(this.activity.closed), overview: { statusCounts, openTaskCount: openTasks.length, openTasks, latestEvent: latest ? { id: latest.id, eventType: latest.eventType, summary: latest.summary, actorName: latest.actorName, createdAt: latest.createdAt } : null } };
  }
  async updateUniversityStep(actor: Actor, activityId: string, stepId: string, input: UniversityStepUpdate) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённая активность доступна только для чтения.');
    if (this.activity.kind !== 'university') throw new DomainError(409, 'university_steps_not_applicable', 'Пункты партнёрства доступны только для вузовских активностей.');
    const definition = this.stepDefinitionRows().find((step) => step.stepId === stepId);
    if (!definition) throw new DomainError(404, 'university_step_not_found', 'Пункт партнёрства не найден.');
    if (stepId === 'U05' && input.status !== 'not_applicable') throw new DomainError(400, 'correction_return_required', 'Корректировку документов можно зафиксировать только отдельным действием возврата.');
    if (input.status === 'not_applicable' && !definition.optional) throw new DomainError(400, 'required_step_cannot_be_skipped', 'Этот пункт нельзя отметить как неприменимый.');
    const evidenceSteps = ['U04','U06','U07','U09','U10','U11','U12','U13'];
    if (input.status === 'documented' && evidenceSteps.includes(stepId) && (!input.evidenceReference?.trim() || !input.evidenceSource?.trim())) throw new DomainError(400, 'supporting_evidence_required', 'Для фиксации этого пункта нужны ссылка или позиция и источник.');
    if (input.status === 'documented' && !evidenceSteps.includes(stepId) && !input.note.trim() && !input.evidenceReference?.trim()) throw new DomainError(400, 'supporting_evidence_required', 'Для фиксации этого пункта добавьте заметку или ссылку.');
    const current = this.universityProgress.get(stepId) ?? { status: 'unrecorded', revision: 0 };
    if (current.revision !== input.expectedRevision) throw new DomainError(409, 'step_revision_conflict', 'Пункт уже изменён другим участником. Обновите данные и повторите.');
    const updatedAt = new Date().toISOString();
    const row = { stepId, status: input.status, note: input.note.trim(), evidenceReference: input.evidenceReference ?? null, evidenceSource: input.evidenceSource ?? null, actorSub: actor.sub, actorName: actor.name, updatedAt, revision: input.expectedRevision + 1 };
    this.universityProgress.set(stepId, row);
    this.events.unshift({ id: `step-${stepId}-${row.revision}`, eventType: 'university_step_updated', summary: `${stepId} · ${definition.label}`, actorName: actor.name, createdAt: updatedAt, details: { stepId, status: row.status, previousRevision: input.expectedRevision, revision: row.revision, note: row.note } });
    return row;
  }
  async universityCorrectionReturn(actor: Actor, activityId: string, input: UniversityCorrectionReturn) {
    this.requireVisible(actor);
    if (activityId !== this.activity.id) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    if (this.activity.closed) throw new DomainError(409, 'activity_closed', 'Завершённая активность доступна только для чтения.');
    const u04 = this.universityProgress.get('U04') ?? { status: 'unrecorded', revision: 0 };
    const u05 = this.universityProgress.get('U05') ?? { status: 'unrecorded', revision: 0 };
    if (input.expectedU04Revision !== u04.revision || input.expectedU05Revision !== u05.revision) throw new DomainError(409, 'step_revision_conflict', 'Пункты уже изменены другим участником. Обновите данные и повторите.');
    if (!['documented','waiting'].includes(u04.status)) throw new DomainError(409, 'correction_return_not_applicable', 'Возврат на корректировку сейчас неприменим.');
    const updatedAt = new Date().toISOString();
    const u04Row = { stepId: 'U04', status: 'in_progress', note: u04.note ?? '', evidenceReference: u04.evidenceReference ?? null, evidenceSource: u04.evidenceSource ?? null, actorSub: actor.sub, actorName: actor.name, updatedAt, revision: u04.revision + 1 };
    const u05Row = { stepId: 'U05', status: 'documented', note: input.note.trim(), evidenceReference: input.evidenceReference ?? null, evidenceSource: input.evidenceSource ?? null, actorSub: actor.sub, actorName: actor.name, updatedAt, revision: u05.revision + 1 };
    this.universityProgress.set('U04', u04Row); this.universityProgress.set('U05', u05Row);
    this.events.unshift({ id: `correction-${u05Row.revision}`, eventType: 'university_correction_return', summary: 'Пакет документов возвращён на корректировку', actorName: actor.name, createdAt: updatedAt, details: { previousU04Status: u04.status, previousU04Revision: u04.revision, previousU04EvidenceReference: u04.evidenceReference ?? null, previousU04EvidenceSource: u04.evidenceSource ?? null, u04Status: 'in_progress', u04Revision: u04Row.revision, previousU05Status: u05.status, previousU05Revision: u05.revision, u05Status: 'documented', u05Revision: u05Row.revision, note: input.note, evidenceReference: input.evidenceReference ?? null, evidenceSource: input.evidenceSource ?? null } });
    return { u04: { stepId: 'U04', status: u04Row.status, revision: u04Row.revision }, u05: { stepId: 'U05', status: u05Row.status, revision: u05Row.revision }, updatedAt };
  }
  async catalog(_actor: Actor) { return { organizations: [], products: [], workflows: await this.getWorkflow() }; }
}

const apps: FastifyInstance[] = [];
const repository = new MemoryRepository();
const authenticate: Authenticator = async (request: FastifyRequest) => {
  const user = request.headers['x-test-user'];
  if (user === 'anna') return anna;
  if (user === 'dmitry') return dmitry;
  if (user === 'manager') return manager;
  if (user === 'admin') return admin;
  if (user === 'manager-admin') return managerAdmin;
  if (user === 'outsider') return { sub: 'outsider', name: 'Внешний пользователь', roles: [] };
  throw new DomainError(401, 'unauthorized', 'Войдите в рабочее пространство.');
};

async function appForTest() {
  const app = buildApp({ repository, authenticate });
  apps.push(app);
  await app.ready();
  return app;
}
const as = (user: string) => ({ 'x-test-user': user });

test('browser preflight permits task subscription and other write methods', async () => {
  const app = await appForTest();
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await app.inject({
      method: 'OPTIONS',
      url: `/api/activities/${id}/tasks/${id}/subscription`,
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization',
      },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.match(String(response.headers['access-control-allow-methods']), new RegExp(`\\b${method}\\b`));
  }
});

test('public demo inquiry route validates synthetic input, applies honeypot and rate limit, and does not require CRM credentials', async () => {
  const accepted: { input: unknown; key: string }[] = [];
  const app = buildApp({ repository, authenticate, publicDemoIntake: { enabled: true, submit: async (input, key) => { accepted.push({ input, key }); return { duplicate: false }; } } });
  apps.push(app); await app.ready();
  const payload = { kind: 'individual', name: 'Алексей Демо', email: 'demo@example.test', phone: '', organization: '', note: 'Хочу попробовать основы анализа данных.', honeypot: '', idempotencyKey: '08d159b2-a31c-49ce-8133-d137164e96c0' };
  const created = await app.inject({ method: 'POST', url: '/api/public-demo/inquiries', payload });
  assert.equal(created.statusCode, 202);
  assert.equal(created.json().accepted, true);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].key, payload.idempotencyKey);

  const bad = await app.inject({ method: 'POST', url: '/api/public-demo/inquiries', payload: { ...payload, idempotencyKey: 'not-a-uuid', email: 'not-an-email' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(accepted.length, 1);

  const spam = await app.inject({ method: 'POST', url: '/api/public-demo/inquiries', payload: { ...payload, idempotencyKey: '08d159b2-a31c-49ce-8133-d137164e96c1', honeypot: 'filled by bot' } });
  assert.equal(spam.statusCode, 202);
  assert.equal(accepted.length, 1);

  for (let index = 1; index < 3; index += 1) {
    const response = await app.inject({ method: 'POST', url: '/api/public-demo/inquiries', payload: { ...payload, idempotencyKey: `08d159b2-a31c-49ce-8133-d137164e96c${index}` } });
    assert.equal(response.statusCode, 202);
  }
  const limited = await app.inject({ method: 'POST', url: '/api/public-demo/inquiries', payload: { ...payload, idempotencyKey: '08d159b2-a31c-49ce-8133-d137164e96c9' } });
  assert.equal(limited.statusCode, 429);
});

test('public demo intake validation requires a university name but accepts an individual request without an organization', async () => {
  const { validatePublicDemoInquiry } = await import('../src/public-demo-intake.js');
  const base = { name: 'Синтетический контакт', email: 'demo@example.test', note: 'Достаточно длинная заметка', honeypot: '', idempotencyKey: randomUUID() };
  assert.throws(() => validatePublicDemoInquiry({ ...base, kind: 'university' }), /Укажите название вуза/);
  assert.equal(validatePublicDemoInquiry({ ...base, kind: 'individual' }).organization, null);
  assert.throws(() => validatePublicDemoInquiry({ ...base, kind: 'corporate' }), /Укажите название компании/);
  assert.equal(validatePublicDemoInquiry({ ...base, kind: 'corporate', organization: 'Синтетическая компания' }).kind, 'corporate');
});

test('public demo inquiry route accepts all three synthetic CRM activity kinds', async () => {
  const accepted: string[] = [];
  const app = buildApp({ repository, authenticate, publicDemoIntake: { enabled: true, submit: async (input) => { accepted.push(input.kind); return { duplicate: false }; } } });
  apps.push(app); await app.ready();
  const base = { name: 'Синтетический контакт', email: 'demo@example.test', phone: '', note: 'Обсудить тестовую программу обучения.', honeypot: '' };
  for (const [index, kind] of ['university', 'corporate', 'individual'].entries()) {
    const response = await app.inject({ method: 'POST', url: '/api/public-demo/inquiries', payload: {
      ...base, kind, organization: kind === 'university' ? 'Учебный университет' : kind === 'corporate' ? 'Учебная компания' : '', idempotencyKey: randomUUID(),
    } });
    assert.equal(response.statusCode, 202, `kind ${kind} should be accepted (case ${index})`);
  }
  assert.deepEqual(accepted, ['university', 'corporate', 'individual']);
});

afterEach(async () => {
  await Promise.all(repository.documents.map((document) => removePrivateDocument(document.objectKey)));
  repository.documents = [];
  repository.activity = { id, kind: 'university', title: 'Пилотная программа', organizationName: 'Синтетический вуз', stageKey: 'contact', stageLabel: 'Первичный контакт', routeVersion: 'legacy', workflowRevision: 1, revision: 0, personId: null, productIds: [], allowedNext: ['meeting'], ownerSub: anna.sub, priority: 2, tasks: [] };
  repository.events = []; repository.tasks = []; repository.learningFacts = []; repository.learningPrograms = []; repository.savedCorporatePlan = null; repository.savedContractLicenses = []; repository.universityProgress.clear(); repository.guidanceFeedback.clear(); repository.guidanceArticles.clear(); repository.createInput = undefined; repository.workflowOverride = undefined;
  repository.extraActivities = [];
  repository.universityWorkflowRevision = 1;
  repository.universityWorkflowStages = [
    { key: 'contact', label: 'Первичный контакт', ordinal: 1, terminal: false },
    { key: 'meeting', label: 'Встреча и потребность', ordinal: 2, terminal: false },
    { key: 'documents', label: 'Документы и согласование', ordinal: 3, terminal: false },
    { key: 'implementation', label: 'Внедрение', ordinal: 4, terminal: false },
    { key: 'closed', label: 'Завершено', ordinal: 5, terminal: true },
  ];
  repository.universityWorkflowTransitions = [
    { from: 'contact', to: 'meeting' }, { from: 'meeting', to: 'documents' },
    { from: 'documents', to: 'implementation' }, { from: 'implementation', to: 'closed' },
  ];
  repository.overview = {
    asOf: new Date().toISOString(),
    metrics: { totalOpen: 1, byKind: { university: 1, corporate: 0, individual: 0 }, overdue: 0, awaitingReply: 0, noNextStep: 1 },
    byOwner: [{ ownerSub: anna.sub, ownerName: anna.name, open: 1, overdue: 0 }], topProducts: [], pipeline: [],
    definitions: {
      totalOpen: 'Открытые активности CRM; каждая активность считается один раз.', byKind: 'Открытые активности по типу: вуз, компания или физлицо.',
      overdue: 'Просрочена ближайшая открытая задача; активность считается один раз.', awaitingReply: 'Активности с зафиксированным исходом «Ожидаю ответ».',
      noNextStep: 'Открытые активности без открытых задач.', byOwner: 'Открытые и просроченные активности по ответственному КАМ.', topProducts: 'Число уникальных открытых активностей, связанных с продуктом.', pipeline: 'Текущий этап активности.',
    },
  };
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

test('learning program catalog is authenticated, independently prioritized and revision guarded', async () => {
  const app = await appForTest();
  const denied = await app.inject({ method: 'GET', url: '/api/programs', headers: as('outsider') });
  assert.equal(denied.statusCode, 403);
  const kamCreate = await app.inject({ method: 'POST', url: '/api/programs', headers: as('anna'), payload: { name: 'Программа аналитики' } });
  assert.equal(kamCreate.statusCode, 403);
  const created = await app.inject({ method: 'POST', url: '/api/programs', headers: as('manager'), payload: { name: 'Программа аналитики' } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().priority, 3);
  assert.equal(created.json().demandCount, 0);
  const id = created.json().id;
  const linked = await app.inject({ method: 'PUT', url: `/api/activities/${repository.activity.id}/details`, headers: as('anna'), payload: { personId: null, productIds: [], programIds: [id], priority: 2, expectedRevision: 0 } });
  assert.equal(linked.statusCode, 200, linked.body);
  assert.deepEqual(linked.json().programIds, [id]);
  const card = await app.inject({ method: 'GET', url: `/api/activities/${repository.activity.id}`, headers: as('anna') });
  assert.deepEqual(card.json().programIds, [id]);
  assert.deepEqual(card.json().programNames, ['Программа аналитики']);
  const kamPriority = await app.inject({ method: 'PUT', url: `/api/programs/${id}/priority`, headers: as('anna'), payload: { priority: 1, expectedRevision: 0 } });
  assert.equal(kamPriority.statusCode, 403);
  const adminPriority = await app.inject({ method: 'PUT', url: `/api/programs/${id}/priority`, headers: as('admin'), payload: { priority: 1, expectedRevision: 0 } });
  assert.equal(adminPriority.statusCode, 200, adminPriority.body);
  assert.equal(adminPriority.json().revision, 1);
  const stale = await app.inject({ method: 'PUT', url: `/api/programs/${id}/priority`, headers: as('manager'), payload: { priority: 5, expectedRevision: 0 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'program_revision_conflict');
  const listed = await app.inject({ method: 'GET', url: '/api/programs', headers: as('anna') });
  assert.equal(listed.json().items[0].name, 'Программа аналитики');
  assert.equal(listed.json().items[0].priority, 1);
  assert.equal(listed.json().items[0].demandCount, 1);
});

test('API rejects a missing session and does not expose another KAM’s card or history', async () => {
  const app = await appForTest();
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}` })).statusCode, 401);
  const hidden = await app.inject({ method: 'GET', url: `/api/activities/${id}`, headers: as('dmitry') });
  assert.equal(hidden.statusCode, 404);
  const hiddenHistory = await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers: as('dmitry') });
  assert.equal(hiddenHistory.statusCode, 404);
  assert.deepEqual(await hidden.json(), { code: 'activity_not_found', message: 'Активность не найдена.' });
});

test('activity details edit is scoped, revisioned, auditable, and preserves the workflow stage', async () => {
  const app = await appForTest();
  const path = `/api/activities/${id}/details`;
  const payload = { newPerson: { fullName: 'Новый координатор', email: 'new@example.test', phone: '+70000000000' }, productIds: ['550e8400-e29b-41d4-a716-446655440002'], priority: 1, expectedRevision: 0 };
  const denied = await app.inject({ method: 'PUT', url: path, headers: as('outsider'), payload });
  assert.equal(denied.statusCode, 403);
  const hidden = await app.inject({ method: 'PUT', url: path, headers: as('dmitry'), payload });
  assert.equal(hidden.statusCode, 404);
  const invalid = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload: { ...payload, priority: 6 } });
  assert.equal(invalid.statusCode, 400);
  const bothContactModes = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload: { ...payload, personId: id } });
  assert.equal(bothContactModes.statusCode, 400);

  const saved = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().id, id);
  assert.match(saved.json().personId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(saved.json().productIds, payload.productIds);
  assert.equal(saved.json().priority, 1);
  assert.equal(saved.json().revision, 1);
  assert.equal(saved.json().stageKey, 'contact');
  assert.equal(repository.activity.stageKey, 'contact');
  assert.equal(repository.activity.revision, 1);
  const history = await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers: as('anna') });
  assert.equal(history.json()[0].eventType, 'activity_details_updated');
  assert.equal(history.json()[0].details.contactCreated, true);

  const clearContact = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload: { personId: null, productIds: payload.productIds, priority: 1, expectedRevision: 1 } });
  assert.equal(clearContact.statusCode, 200, clearContact.body);
  assert.equal(clearContact.json().personId, null);
  assert.equal(clearContact.json().revision, 2);

  const stale = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'activity_revision_conflict');
  repository.activity.closed = true;
  const closed = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload: { personId: null, productIds: payload.productIds, priority: 2, expectedRevision: 2 } });
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().code, 'activity_closed');
  repository.activity.closed = false;
  repository.activity.kind = 'individual';
  const missingIndividualContact = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload: { personId: null, productIds: payload.productIds, priority: 1, expectedRevision: 2 } });
  assert.equal(missingIndividualContact.statusCode, 400);
  assert.equal(missingIndividualContact.json().code, 'person_required');
});

test('activity documents are validated, audited, downloaded as attachments, and scoped to the current KAM', async () => {
  const app = await appForTest();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const uploadUrl = `/api/activities/${id}/documents?filename=${encodeURIComponent('Пакет предложения.png')}`;
  const upload = await app.inject({ method: 'POST', url: uploadUrl, headers: { ...as('anna'), 'content-type': 'application/octet-stream' }, payload: png });
  assert.equal(upload.statusCode, 201, upload.body);
  const document = upload.json();
  assert.equal(document.name, 'Пакет предложения.png');
  assert.equal(document.extension, 'png');
  assert.equal(document.mediaType, 'image/png');
  assert.equal(document.sizeBytes, png.length);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/documents`, headers: as('anna') })).json()[0].id, document.id);

  const hiddenList = await app.inject({ method: 'GET', url: `/api/activities/${id}/documents`, headers: as('dmitry') });
  const hiddenDownload = await app.inject({ method: 'GET', url: `/api/activities/${id}/documents/${document.id}`, headers: as('dmitry') });
  assert.equal(hiddenList.statusCode, 404);
  assert.equal(hiddenDownload.statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/documents`, headers: as('manager') })).statusCode, 200);
  const downloadAuditsBeforeHead = repository.events.filter((event) => event.eventType === 'document_downloaded').length;
  const head = await app.inject({ method: 'HEAD', url: `/api/activities/${id}/documents/${document.id}`, headers: as('anna') });
  assert.equal(head.statusCode, 404);
  assert.equal(repository.events.filter((event) => event.eventType === 'document_downloaded').length, downloadAuditsBeforeHead);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/documents/${document.id}`, headers: as('admin') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/documents/${document.id}`, headers: as('manager-admin') })).statusCode, 200);

  const download = await app.inject({ method: 'GET', url: `/api/activities/${id}/documents/${document.id}`, headers: as('anna') });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(String(download.headers['content-disposition']), /attachment/);
  assert.deepEqual(download.rawPayload, png);
  const history = await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers: as('anna') });
  assert.ok(history.json().some((event: Event) => event.eventType === 'document_uploaded'));
  assert.ok(history.json().some((event: Event) => event.eventType === 'document_downloaded'));

  const wrongContent = await app.inject({ method: 'POST', url: `/api/activities/${id}/documents?filename=report.pdf`, headers: { ...as('anna'), 'content-type': 'application/octet-stream' }, payload: png });
  const unsafeName = await app.inject({ method: 'POST', url: `/api/activities/${id}/documents?filename=${encodeURIComponent('../secret.png')}`, headers: { ...as('anna'), 'content-type': 'application/octet-stream' }, payload: png });
  const tooLarge = await app.inject({ method: 'POST', url: `/api/activities/${id}/documents?filename=large.png`, headers: { ...as('anna'), 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(MAX_ACTIVITY_DOCUMENT_BYTES + 1) });
  assert.equal(wrongContent.statusCode, 400);
  assert.equal(unsafeName.statusCode, 400);
  assert.equal(tooLarge.statusCode, 413);

  repository.activity.closed = true;
  const closedUpload = await app.inject({ method: 'POST', url: uploadUrl, headers: { ...as('anna'), 'content-type': 'application/octet-stream' }, payload: png });
  assert.equal(closedUpload.statusCode, 409);
});

test('OpenAPI contract is public and describes the real activity routes', async () => {
  const app = await appForTest();
  const spec = await app.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(spec.statusCode, 200);
  const contract = spec.json();
  assert.equal(contract.openapi, '3.1.0');
  assert.equal(contract.info.title, 'RTK CRM B12 API');
  assert.equal(contract.servers[0].url, '/', 'the API contract follows the host used to open it');
  assert.ok(contract.paths['/api/activities/{id}/transition']);
  assert.ok(contract.paths['/api/activities/{id}/tasks/{taskId}/complete']);
  assert.ok(contract.paths['/api/guidance/{kind}/{stageKey}']);
  assert.ok(contract.paths['/api/activities/{id}/guidance']);
  assert.ok(contract.paths['/api/activities/{id}/documents'].get);
  assert.ok(contract.paths['/api/activities/{id}/documents'].post);
  assert.ok(contract.paths['/api/activities/{id}/documents/{documentId}'].get);
  assert.ok(contract.paths['/api/activities/{id}/contract-licenses'].get);
  assert.ok(contract.paths['/api/activities/{id}/contract-licenses'].post);
  assert.ok(contract.paths['/api/activities/{id}/contract-licenses/{recordId}'].put);
  assert.ok(contract.paths['/api/activities/{id}/contract-licenses/{recordId}'].delete);
  assert.ok(contract.components.schemas.ActivityContractLicense);
  assert.ok(contract.components.schemas.ActivityContractLicenseInput);
  assert.ok(contract.components.schemas.ActivityGuidance);
  assert.ok(contract.components.schemas.NewActivity);
  assert.ok(contract.paths['/api/manager/overview'].get);
  assert.ok(contract.components.schemas.ManagerOverview);
  assert.ok(contract.components.schemas.ActivityPage);
  const transitionInput = contract.components.schemas.StageTransition;
  assert.deepEqual(transitionInput.required, ['targetStage', 'expectedStageKey', 'expectedWorkflowRevision']);
  const workflowApplyInput = contract.components.schemas.UniversityWorkflowApplyInput;
  assert.equal(workflowApplyInput.allOf, undefined, 'The apply schema is a single closed object schema, valid with additionalProperties:false.');
  assert.equal(workflowApplyInput.additionalProperties, false);
  assert.ok(workflowApplyInput.required.includes('previewToken'));
  assert.ok(contract.paths['/api/activities/{id}/university-steps'].get);
  assert.ok(contract.paths['/api/activities/{id}/university-steps/{stepId}'].put);
  assert.ok(contract.paths['/api/activities/{id}/university-steps/correction-return'].post);
  assert.ok(contract.paths['/api/activities/{id}/learning-facts'].get);
  assert.ok(contract.paths['/api/activities/{id}/corporate-plan'].get);
  assert.ok(contract.paths['/api/activities/{id}/corporate-plan'].put);
  assert.ok(contract.components.schemas.CorporatePlan);
  assert.ok(contract.components.schemas.IndividualLearningFact);
  assert.ok(contract.components.schemas.ExchangeJob);
  assert.ok(contract.paths['/api/activities/{id}/exchanges'].get);
  assert.ok(contract.paths['/api/reports/ready'].get);
  assert.ok(contract.paths['/api/reports/owners'].get);
  assert.ok(contract.paths['/api/reports/organizations'].get);
  assert.ok(contract.paths['/api/reports/snapshots'].post);
  const snapshotFilterSchema = contract.paths['/api/reports/snapshots'].post.requestBody.content['application/json'].schema.properties.filters;
  assert.equal(snapshotFilterSchema.properties.organizationId.format, 'uuid');
  const snapshotPageParameters = contract.paths['/api/reports/snapshots/{id}'].get.parameters;
  assert.equal(snapshotPageParameters.find((parameter: { name: string }) => parameter.name === 'page').schema.default, '1');
  assert.ok(contract.paths['/api/reports/exports'].post);
  assert.ok(contract.paths['/api/reports/exports'].get);
  const exportListLimit = contract.paths['/api/reports/exports'].get.parameters.find((parameter: { name: string }) => parameter.name === 'limit');
  assert.equal(exportListLimit.schema.maximum, 20);
  const exportColumnsSchema = contract.paths['/api/reports/exports'].post.requestBody.content['application/json'].schema.properties.columns;
  assert.equal(exportColumnsSchema.minItems, 1);
  assert.equal(exportColumnsSchema.uniqueItems, true);
  assert.ok(exportColumnsSchema.items.enum.includes('title'));
  assert.ok(contract.paths['/api/reports/exports/{id}/file'].get);
  assert.equal(contract.paths['/api/reports/snapshots/{id}'].get.responses['200'].headers['Cache-Control'].schema.enum[0], 'private, no-store');
  assert.equal(contract.paths['/api/reports/exports/{id}/file'].get.responses['200'].headers['Cache-Control'].schema.enum[0], 'private, no-store');
  const readyReports = await app.inject({ method: 'GET', url: '/api/reports/ready', headers: as('anna') });
  assert.equal(readyReports.statusCode, 200);
  assert.equal(readyReports.headers['cache-control'], 'private, no-store');
  assert.ok(readyReports.json()[0].exportColumns.some((column: { key: string }) => column.key === 'title'));
  assert.ok(readyReports.json()[0].filters.includes('organizationId'));
  assert.ok(contract.paths['/api/activities/{id}/exchanges/lms-requests'].post);
  assert.ok(contract.paths['/api/admin/exchanges'].get);
  assert.ok(contract.paths['/api/admin/exchanges/cms/pull'].post);
  assert.ok(contract.paths['/api/admin/exchanges/lms/pull'].post);
  assert.ok(contract.paths['/api/cms-mock/intake'].get);
  assert.ok(contract.paths['/api/cms-mock/intake/{id}/claim'].post);
  assert.ok(contract.components.schemas.ActivityRouteState);
  assert.ok(contract.paths['/api/imports'].post);
  assert.ok(contract.paths['/api/admin/imports/summary'].get);
  assert.ok(contract.paths['/api/imports/{id}/header'].get);
  assert.ok(contract.paths['/api/imports/{id}/preview'].put);
  assert.ok(contract.paths['/api/imports/{id}/confirm'].post);
  assert.ok(contract.components.schemas.ImportConfirmationInput);
  assert.equal(contract.components.schemas.NewActivity.properties.origin.enum.join(','), 'manual');
  assert.equal(contract.components.schemas.NewActivity.not.anyOf.some((rule: { required?: string[] }) => rule.required?.includes('originSource')), true);
  assert.ok(contract.paths['/api/activities'].get.parameters.some((parameter: { name: string }) => parameter.name === 'productId'));
});

test('corporate plan is scoped, revisioned, auditable, and read-only after activity closure', async () => {
  const app = await appForTest();
  repository.activity = { ...repository.activity, kind: 'corporate', title: 'Адаптация программы', stageKey: 'qualification' };
  const path = `/api/activities/${id}/corporate-plan`;
  const initial = await app.inject({ method: 'GET', url: path, headers: as('anna') });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().programMode, 'undecided');
  assert.equal(initial.json().revision, 0);
  assert.equal(initial.json().requestedPlaces, null);
  assert.equal((await app.inject({ method: 'GET', url: path, headers: as('dmitry') })).statusCode, 404);

  const payload = {
    expectedRevision: 0, programMode: 'adapted', requestedPlaces: 30,
    brief: { expectedOutcome: 'Подготовить группу к работе с данными', audience: 'Аналитики', entryLevel: 'Базовый', deliveryFormat: 'Смешанный', volume: '24 часа', technologyContext: 'Заказчик использует внутреннюю платформу' },
    methodologist: { name: 'Методолог A', feasibility: 'feasible_with_changes', note: 'Нужны примеры заказчика' },
    proposed: { scope: 'Обновить практические кейсы', startDate: '2026-10-01', endDate: '2026-11-01', acceptanceCriteria: 'Провести пилот' },
    agreed: { scope: 'Обновить два кейса', startDate: '2026-10-05', endDate: '2026-10-25', acceptanceCriteria: 'Приняты заказчиком по протоколу' },
    approval: { status: 'approved', evidenceReference: 'PROTOCOL-7', evidenceSource: 'Протокол заказчика', note: 'Источник указывает согласование объёма' },
  };
  assert.equal((await app.inject({ method: 'PUT', url: path, headers: as('outsider'), payload })).statusCode, 403);
  const missingEvidence = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload: { ...payload, approval: { ...payload.approval, evidenceReference: null } } });
  assert.equal(missingEvidence.statusCode, 400);
  assert.equal(missingEvidence.json().code, 'approval_evidence_required');
  const saved = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().revision, 1);
  assert.equal(saved.json().programMode, 'adapted');
  assert.equal(saved.json().requestedPlaces, 30);
  assert.equal(saved.json().methodologist.feasibility, 'feasible_with_changes');
  assert.equal(saved.json().approval.evidenceReference, 'PROTOCOL-7');
  assert.equal(repository.activity.stageKey, 'qualification');
  const standardPayload = { ...payload, expectedRevision: 1, programMode: 'standard' };
  const standard = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload: standardPayload });
  assert.equal(standard.statusCode, 200, standard.body);
  assert.equal(standard.json().programMode, 'standard');
  assert.equal(standard.json().revision, 2);
  assert.equal(standard.json().brief.expectedOutcome, payload.brief.expectedOutcome);
  assert.equal(standard.json().proposed.scope, payload.proposed.scope);
  assert.equal(standard.json().agreed.acceptanceCriteria, payload.agreed.acceptanceCriteria);
  assert.equal(standard.json().approval.evidenceReference, payload.approval.evidenceReference);
  const stale = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'revision_conflict');
  const history = await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers: as('anna') });
  assert.equal(history.json()[0].eventType, 'corporate_plan_updated');
  const latestPlanEvent = history.json().find((event: { eventType: string; details: { revision: number } }) => event.eventType === 'corporate_plan_updated' && event.details.revision === 2);
  assert.equal(latestPlanEvent.details.previousRevision, 1);
  assert.equal(latestPlanEvent.details.current.programMode, 'standard');
  assert.equal(latestPlanEvent.details.current.brief.expectedOutcome, payload.brief.expectedOutcome);

  repository.activity.closed = true;
  assert.equal((await app.inject({ method: 'GET', url: path, headers: as('anna') })).json().readOnly, true);
  const closedWrite = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload: { ...standardPayload, expectedRevision: 2 } });
  assert.equal(closedWrite.statusCode, 409);
  assert.equal(closedWrite.json().code, 'activity_closed');
  repository.activity.kind = 'university';
  const mismatchedType = await app.inject({ method: 'GET', url: path, headers: as('anna') });
  assert.equal(mismatchedType.statusCode, 409);
  assert.equal(mismatchedType.json().code, 'corporate_plan_not_applicable');
});

test('activity contract and license context supports zero or many records, precise expiry, scoped edits, and history', async () => {
  const app = await appForTest();
  const path = `/api/activities/${id}/contract-licenses`;
  assert.deepEqual((await app.inject({ method: 'GET', url: path, headers: as('anna') })).json(), [], 'an early activity can have no contract yet');
  assert.equal((await app.inject({ method: 'GET', url: path, headers: as('dmitry') })).statusCode, 404);
  const yearPayload = {
    title: 'Договор на программу', contractReference: 'RTK-2031-04', contractStatus: 'signed',
    licenseExpiryPrecision: 'year', licenseExpiresOn: null, licenseExpiresYear: 2031,
    documentId: null, note: 'Срок известен только до года.',
  };
  const first = await app.inject({ method: 'POST', url: path, headers: as('anna'), payload: yearPayload });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().licenseExpiryPrecision, 'year');
  assert.equal(first.json().licenseExpiresYear, 2031);
  assert.equal(first.json().licenseExpiresOn, null, 'a year-only expiry does not gain an invented date');
  const second = await app.inject({ method: 'POST', url: path, headers: as('anna'), payload: {
    title: 'Лицензия продукта', contractReference: null, contractStatus: null,
    licenseExpiryPrecision: 'unknown', licenseExpiresOn: null, licenseExpiresYear: null, documentId: null, note: null,
  } });
  assert.equal(second.statusCode, 201, second.body);
  assert.equal((await app.inject({ method: 'GET', url: path, headers: as('anna') })).json().length, 2);
  const updated = await app.inject({ method: 'PUT', url: `${path}/${first.json().id}`, headers: as('anna'), payload: {
    ...yearPayload, expectedRevision: 1, licenseExpiryPrecision: 'exact_date', licenseExpiresOn: '2031-12-31', licenseExpiresYear: null,
  } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().revision, 2);
  assert.equal(updated.json().licenseExpiresOn, '2031-12-31');
  const stale = await app.inject({ method: 'PUT', url: `${path}/${first.json().id}`, headers: as('anna'), payload: { ...yearPayload, expectedRevision: 1 } });
  assert.equal(stale.statusCode, 409);
  const invalidPrecision = await app.inject({ method: 'POST', url: path, headers: as('anna'), payload: { ...yearPayload, licenseExpiryPrecision: 'unknown', licenseExpiresYear: 2031 } });
  assert.equal(invalidPrecision.statusCode, 400);
  const history = await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers: as('anna') });
  assert.equal(history.json()[0].eventType, 'contract_license_updated');
  assert.equal(history.json()[0].details.current.licenseExpiryPrecision, 'exact_date');
  const forbidden = await app.inject({ method: 'POST', url: path, headers: as('outsider'), payload: yearPayload });
  assert.equal(forbidden.statusCode, 403);
  repository.activity.closed = true;
  const closed = await app.inject({ method: 'DELETE', url: `${path}/${first.json().id}?expectedRevision=2`, headers: as('anna') });
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().code, 'activity_closed');
});

test('university step read is scoped and returns thirteen separate unrecorded controls plus U14 facts', async () => {
  const app = await appForTest();
  repository.tasks = [{ id: taskId, title: 'Уточнить встречу', dueAt: new Date(Date.now() + 60_000).toISOString(), status: 'open', ownerName: anna.name }];
  repository.events = [{ id: 'evt-current', eventType: 'task_created', summary: 'Поставлено действие: Уточнить встречу', actorName: anna.name, createdAt: new Date().toISOString(), details: {} }];
  const response = await app.inject({ method: 'GET', url: `/api/activities/${id}/university-steps`, headers: as('anna') });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.steps.length, 13);
  assert.deepEqual(body.steps.map((step: { stepId: string }) => step.stepId), Array.from({ length: 13 }, (_, index) => `U${String(index + 1).padStart(2, '0')}`));
  assert.ok(body.steps.every((step: { status: string; revision: number }) => step.status === 'unrecorded' && step.revision === 0));
  assert.equal(body.overview.statusCounts.unrecorded, 13);
  assert.equal(body.overview.openTaskCount, 1);
  assert.equal(body.overview.openTasks[0].id, taskId);
  assert.equal(body.overview.latestEvent.id, 'evt-current');
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/university-steps`, headers: as('dmitry') })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/university-steps`, headers: as('manager') })).statusCode, 200);
});

test('university step update checks revisions, appends immutable history, and leaves macro stage alone', async () => {
  const app = await appForTest();
  const path = `/api/activities/${id}/university-steps/U01`;
  const payload = { status: 'documented', note: 'Контакт найден', evidenceReference: 'CRM:contact-1', evidenceSource: 'Запись КАМ', expectedRevision: 0 };
  const saved = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().revision, 1);
  const conflict = await app.inject({ method: 'PUT', url: path, headers: as('anna'), payload });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'step_revision_conflict');
  const details = await app.inject({ method: 'GET', url: `/api/activities/${id}/university-steps`, headers: as('anna') });
  assert.equal(details.json().steps.find((step: { stepId: string }) => step.stepId === 'U01').revision, 1);
  const history = await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers: as('anna') });
  assert.equal(history.json()[0].eventType, 'university_step_updated');
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}`, headers: as('anna') })).json().stageKey, 'contact');
  const invalidOptional = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U04`, headers: as('anna'), payload: { status: 'not_applicable', note: '', expectedRevision: 0 } });
  assert.equal(invalidOptional.statusCode, 400);
  const invalidLength = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U02`, headers: as('anna'), payload: { status: 'waiting', note: 'x'.repeat(1001), expectedRevision: 0 } });
  assert.equal(invalidLength.statusCode, 400);
  const invalidEvidence = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U02`, headers: as('anna'), payload: { status: 'waiting', note: '', evidenceReference: 'x'.repeat(501), expectedRevision: 0 } });
  assert.equal(invalidEvidence.statusCode, 400);
  for (const stepId of ['U04', 'U06', 'U07', 'U09', 'U10', 'U11', 'U12', 'U13']) {
    const missingEvidence = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/${stepId}`, headers: as('anna'), payload: { status: 'documented', note: 'Есть заметка, но нет источника', expectedRevision: 0 } });
    assert.equal(missingEvidence.statusCode, 400, `${stepId} needs a reference and source`);
  }
  const unsupportedTrainingClaim = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U09`, headers: as('anna'), payload: { status: 'documented', note: 'Обучение завершено', expectedRevision: 0 } });
  assert.equal(unsupportedTrainingClaim.statusCode, 400);
  const missingPackageEvidence = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U04`, headers: as('anna'), payload: { status: 'documented', note: 'Пакет готов', expectedRevision: 0 } });
  assert.equal(missingPackageEvidence.statusCode, 400);
  const missingNoteOrReference = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U02`, headers: as('anna'), payload: { status: 'documented', note: '', expectedRevision: 0 } });
  assert.equal(missingNoteOrReference.statusCode, 400);
  for (const status of ['in_progress', 'waiting', 'documented']) {
    const bypass = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U05`, headers: as('anna'), payload: { status, note: 'Обход отдельного действия', expectedRevision: 0 } });
    assert.equal(bypass.statusCode, 400, `generic update must reject U05 ${status}`);
  }
  const optional = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U05`, headers: as('anna'), payload: { status: 'not_applicable', note: '', expectedRevision: 0 } });
  assert.equal(optional.statusCode, 200);
  assert.equal(optional.json().status, 'not_applicable');
});

test('correction-return updates U05 and reopens U04 atomically only after document exchange', async () => {
  const app = await appForTest();
  const url = `/api/activities/${id}/university-steps/correction-return`;
  const premature = await app.inject({ method: 'POST', url, headers: as('anna'), payload: { expectedU04Revision: 0, expectedU05Revision: 0, note: 'Возврат' } });
  assert.equal(premature.statusCode, 409);
  await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U04`, headers: as('anna'), payload: { status: 'documented', note: 'Пакет передан', evidenceReference: 'DOC-PKG-1', evidenceSource: 'Реестр передачи', expectedRevision: 0 } });
  const beforeStaleReturn = repository.events.length;
  const staleReturn = await app.inject({ method: 'POST', url, headers: as('anna'), payload: { expectedU04Revision: 1, expectedU05Revision: 7, note: 'Уточнить приложение' } });
  assert.equal(staleReturn.statusCode, 409);
  assert.equal(repository.events.length, beforeStaleReturn);
  assert.equal(repository.universityProgress.get('U04')?.status, 'documented');
  assert.equal(repository.universityProgress.get('U05'), undefined);
  const returned = await app.inject({ method: 'POST', url, headers: as('anna'), payload: { expectedU04Revision: 1, expectedU05Revision: 0, note: 'Нужно уточнить приложение', evidenceReference: 'DOC-7', evidenceSource: 'Ответ координатора' } });
  assert.equal(returned.statusCode, 200, returned.body);
  assert.equal(returned.json().u04.status, 'in_progress');
  assert.equal(returned.json().u05.status, 'documented');
  const steps = (await app.inject({ method: 'GET', url: `/api/activities/${id}/university-steps`, headers: as('anna') })).json().steps;
  assert.equal(steps.find((step: { stepId: string }) => step.stepId === 'U04').status, 'in_progress');
  assert.equal(steps.find((step: { stepId: string }) => step.stepId === 'U04').note, 'Пакет передан');
  assert.equal(steps.find((step: { stepId: string }) => step.stepId === 'U04').evidenceReference, 'DOC-PKG-1');
  assert.equal(steps.find((step: { stepId: string }) => step.stepId === 'U05').evidenceReference, 'DOC-7');
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers: as('anna') })).json()[0].eventType, 'university_correction_return');
});

test('a guarded correction-return can reopen U05 after it was marked not applicable and preserves U04 evidence', async () => {
  const app = await appForTest();
  const u04Url = `/api/activities/${id}/university-steps/U04`;
  const u05Url = `/api/activities/${id}/university-steps/U05`;
  const returnUrl = `/api/activities/${id}/university-steps/correction-return`;
  const packageSave = await app.inject({ method: 'PUT', url: u04Url, headers: as('anna'), payload: { status: 'documented', note: 'Пакет передан', evidenceReference: 'DOC-PKG-2', evidenceSource: 'Реестр передачи', expectedRevision: 0 } });
  assert.equal(packageSave.statusCode, 200, packageSave.body);
  const skipped = await app.inject({ method: 'PUT', url: u05Url, headers: as('anna'), payload: { status: 'not_applicable', note: '', expectedRevision: 0 } });
  assert.equal(skipped.statusCode, 200, skipped.body);

  const historyCount = repository.events.length;
  const stale = await app.inject({ method: 'POST', url: returnUrl, headers: as('anna'), payload: { expectedU04Revision: 1, expectedU05Revision: 0, note: 'Поздно поступили документы' } });
  assert.equal(stale.statusCode, 409);
  assert.equal(repository.events.length, historyCount);

  const returned = await app.inject({ method: 'POST', url: returnUrl, headers: as('anna'), payload: { expectedU04Revision: 1, expectedU05Revision: 1, note: 'Поздно поступили документы', evidenceReference: 'DOC-REV-2', evidenceSource: 'Ответ координатора' } });
  assert.equal(returned.statusCode, 200, returned.body);
  const steps = (await app.inject({ method: 'GET', url: `/api/activities/${id}/university-steps`, headers: as('anna') })).json().steps;
  const u04 = steps.find((step: { stepId: string }) => step.stepId === 'U04');
  const u05 = steps.find((step: { stepId: string }) => step.stepId === 'U05');
  assert.equal(u04.status, 'in_progress');
  assert.equal(u04.note, 'Пакет передан');
  assert.equal(u04.evidenceReference, 'DOC-PKG-2');
  assert.equal(u04.evidenceSource, 'Реестр передачи');
  assert.equal(u05.status, 'documented');
  assert.equal(u05.revision, 2);
  const history = (await app.inject({ method: 'GET', url: `/api/activities/${id}/history`, headers: as('anna') })).json();
  const returnEvent = history.find((event: { eventType: string }) => event.eventType === 'university_correction_return');
  assert.equal(history.filter((event: { eventType: string }) => event.eventType === 'university_step_updated').length, 2);
  assert.equal(returnEvent.details.previousU05Status, 'not_applicable');
  assert.equal(returnEvent.details.previousU04EvidenceReference, 'DOC-PKG-2');
});

test('closed university activities remain readable but reject university step writes', async () => {
  const app = await appForTest();
  repository.activity.closed = true;
  const view = await app.inject({ method: 'GET', url: `/api/activities/${id}/university-steps`, headers: as('anna') });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().readOnly, true);
  const save = await app.inject({ method: 'PUT', url: `/api/activities/${id}/university-steps/U01`, headers: as('anna'), payload: { status: 'waiting', note: '', expectedRevision: 0 } });
  assert.equal(save.statusCode, 409);
  assert.equal(save.json().code, 'activity_closed');
  const returnWrite = await app.inject({ method: 'POST', url: `/api/activities/${id}/university-steps/correction-return`, headers: as('anna'), payload: { expectedU04Revision: 0, expectedU05Revision: 0, note: 'Поздний возврат' } });
  assert.equal(returnWrite.statusCode, 409);
  assert.equal(returnWrite.json().code, 'activity_closed');
});

test('server returns a provisional article for every current workflow stage and rejects unknown or mismatched stages', async () => {
  const app = await appForTest();
  const workflow = await repository.getWorkflow();
  assert.equal(workflow.length, 19);
  for (const stage of workflow as { kind: string; key: string }[]) {
    const response = await app.inject({ method: 'GET', url: `/api/guidance/${stage.kind}/${stage.key}`, headers: as('anna') });
    assert.equal(response.statusCode, 200, `${stage.kind}/${stage.key}: ${response.body}`);
    const body = response.json();
    assert.equal(body.kind, stage.kind);
    assert.equal(body.stageKey, stage.key);
    assert.equal(body.metadata.projectStatus, 'provisional');
    assert.ok(body.metadata.source && body.metadata.version && body.metadata.reviewDate);
    assert.ok(body.article.summary && body.article.checks.length > 0 && body.article.draftMessage);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/guidance/university/not-a-stage', headers: as('anna') })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/guidance/corporate/contact', headers: as('anna') })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/guidance/other/contact', headers: as('anna') })).statusCode, 400);
});

test('activity guidance returns one factual tip, honors overdue tasks, and checks activity scope first', async () => {
  const app = await appForTest();
  const noTask = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') });
  assert.equal(noTask.statusCode, 200);
  const noTaskBody = noTask.json();
  assert.equal(noTaskBody.tip.recommendation, 'Свяжитесь с представителем вуза и зафиксируйте актуальность программ.');
  assert.match(noTaskBody.tip.whyNow, /Открытых действий нет/);
  assert.deepEqual(Object.keys(noTaskBody.tip).sort(), ['recommendation', 'recommendationKey', 'whyNow']);

  const nextDue = new Date(Date.now() + 86_400_000).toISOString();
  repository.tasks = [
    { id: 'done-task', title: 'Уже закрытое действие', dueAt: new Date(Date.now() - 60_000).toISOString(), status: 'done' },
    { id: taskId, title: 'Подготовить встречу', dueAt: nextDue, status: 'open' },
  ];
  repository.activity.tasks = repository.tasks;
  const scheduled = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') });
  assert.equal(scheduled.statusCode, 200);
  assert.equal(scheduled.json().tip.recommendation, 'Подготовьтесь к запланированному действию «Подготовить встречу».');
  const displayDate = (value: string) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(value));
  assert.ok(scheduled.json().tip.whyNow.includes(displayDate(nextDue)));

  const pastDue = new Date(Date.now() - 60_000).toISOString();
  repository.tasks = [{ id: taskId, title: 'Уточнить дату встречи', dueAt: pastDue, status: 'open' }];
  repository.activity.tasks = repository.tasks;
  const overdue = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') });
  assert.equal(overdue.statusCode, 200);
  assert.equal(overdue.json().tip.recommendation, 'Разберите просроченное действие «Уточнить дату встречи».');
  assert.ok(overdue.json().tip.whyNow.includes(displayDate(pastDue)));
  const hidden = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('dmitry') });
  assert.equal(hidden.statusCode, 404);
  assert.deepEqual(await hidden.json(), { code: 'activity_not_found', message: 'Активность не найдена.' });
});

test('handbook exposes one searchable-source catalog and flags instructions for removed stages', async () => {
  const app = await appForTest();
  const response = await app.inject({ method: 'GET', url: '/api/guidance/handbook', headers: as('anna') });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.items.length, 19);
  const universityStages = body.items.filter((item: any) => item.kind === 'university' && item.current);
  assert.deepEqual(universityStages.map((item: any) => item.stageOrdinal),
    universityStages.map((item: any) => item.stageOrdinal).sort((a: number, b: number) => a - b));
  assert.ok(body.items.every((item: any) => item.article?.draftMessage && item.article?.recommendationWhenNoOpenTask));
  assert.ok(body.items.find((item: any) => item.id === 'university:contact')?.current);
  repository.workflowOverride = (await repository.getWorkflow()).filter((stage: any) => stage.kind !== 'university' || stage.key !== 'contact');
  const stale = await app.inject({ method: 'GET', url: '/api/guidance/handbook', headers: as('anna') });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json().items.find((item: any) => item.id === 'university:contact')?.current, false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/guidance/handbook', headers: as('outsider') })).statusCode, 403);
});

test('guidance editing is manager-only, publication is admin-only, and changed stage bindings go stale', async () => {
  const app = await appForTest();
  const original = (await app.inject({ method: 'GET', url: '/api/guidance/handbook', headers: as('manager') })).json().items
    .find((item: any) => item.id === 'university:contact');
  const article: GuidanceArticleContent = {
    title: 'Первичный контакт · редакция', summary: 'Проверить актуальный интерес вуза.', focus: 'Уточнить ответственное лицо и тему.',
    checks: ['Записать подтверждённый контакт.'], boundary: 'Не считать интерес договорённостью.',
    draftMessage: 'Здравствуйте! Актуально ли сейчас обсуждение программ?', recommendationWhenNoOpenTask: 'Уточните у вуза актуальность обсуждения.',
  };
  const deniedEdit = await app.inject({ method: 'PUT', url: '/api/guidance/university/contact/draft', headers: as('anna'), payload: { expectedRevision: 0, article } });
  assert.equal(deniedEdit.statusCode, 403);
  const invalid = await app.inject({ method: 'PUT', url: '/api/guidance/university/contact/draft', headers: as('manager'), payload: { expectedRevision: 0, article: { ...article, checks: [] } } });
  assert.equal(invalid.statusCode, 400);
  const saved = await app.inject({ method: 'PUT', url: '/api/guidance/university/contact/draft', headers: as('manager'), payload: { expectedRevision: original.draftRevision, article } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().draftRevision, 1);
  const conflict = await app.inject({ method: 'PUT', url: '/api/guidance/university/contact/draft', headers: as('manager'), payload: { expectedRevision: 0, article } });
  assert.equal(conflict.statusCode, 409);
  const deniedPublish = await app.inject({ method: 'POST', url: '/api/admin/guidance/university/contact/publish', headers: as('manager'), payload: { expectedDraftRevision: 1 } });
  assert.equal(deniedPublish.statusCode, 403);
  const published = await app.inject({ method: 'POST', url: '/api/admin/guidance/university/contact/publish', headers: as('admin'), payload: { expectedDraftRevision: 1 } });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().publishedRevision, 1);
  const active = await app.inject({ method: 'GET', url: '/api/guidance/university/contact', headers: as('anna') });
  assert.equal(active.statusCode, 200);
  assert.equal(active.json().article.title, article.title);
  const kamHandbook = await app.inject({ method: 'GET', url: '/api/guidance/handbook', headers: as('anna') });
  const publicItem = kamHandbook.json().items.find((item: any) => item.id === 'university:contact');
  assert.equal(publicItem.article.title, article.title);
  assert.equal(Object.hasOwn(publicItem, 'draftArticle'), false);

  repository.workflowOverride = (await repository.getWorkflow()).map((stage: any) => stage.kind === 'university' && stage.key === 'contact' ? { ...stage, label: 'Первичный контакт обновлён' } : stage);
  const unavailable = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.json().code, 'guidance_unavailable');
  const staleItem = (await app.inject({ method: 'GET', url: '/api/admin/guidance/handbook', headers: as('admin') })).json().items
    .find((item: any) => item.id === 'university:contact');
  assert.equal(staleItem.state, 'stale');
  assert.equal(staleItem.article, null);
  const rebound = await app.inject({ method: 'POST', url: '/api/admin/guidance/university/contact/publish', headers: as('admin'), payload: { expectedDraftRevision: 1 } });
  assert.equal(rebound.statusCode, 200, rebound.body);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') })).statusCode, 200);

  repository.workflowOverride = repository.workflowOverride.filter((stage: any) => stage.kind !== 'university' || stage.key !== 'contact');
  const deletedItem = (await app.inject({ method: 'GET', url: '/api/guidance/handbook', headers: as('anna') })).json().items
    .find((item: any) => item.id === 'university:contact');
  assert.equal(deletedItem.current, false);
  assert.equal(deletedItem.state, 'stale');
  assert.equal(deletedItem.article, null);
});

test('recommendation defer and reasoned rejection persist per user and current recommendation', async () => {
  const app = await appForTest();
  const guidance = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') });
  const { recommendationKey } = guidance.json().tip;
  const deferred = await app.inject({ method: 'POST', url: `/api/activities/${id}/guidance/feedback`, headers: as('anna'), payload: { recommendationKey, action: 'defer' } });
  assert.equal(deferred.statusCode, 200, deferred.body);
  assert.equal(deferred.json().action, 'defer');
  assert.ok(Date.parse(deferred.json().deferredUntil) > Date.now());
  const savedDefer = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') });
  assert.equal(savedDefer.json().feedback.active, true);
  assert.equal(savedDefer.json().feedback.action, 'defer');

  const missingReason = await app.inject({ method: 'POST', url: `/api/activities/${id}/guidance/feedback`, headers: as('anna'), payload: { recommendationKey, action: 'reject' } });
  assert.equal(missingReason.statusCode, 400);
  const rejected = await app.inject({ method: 'POST', url: `/api/activities/${id}/guidance/feedback`, headers: as('anna'), payload: { recommendationKey, action: 'reject', reason: 'Этот шаг уже согласован.' } });
  assert.equal(rejected.statusCode, 200, rejected.body);
  const savedReject = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') });
  assert.equal(savedReject.json().feedback.action, 'reject');
  assert.equal(savedReject.json().feedback.reason, 'Этот шаг уже согласован.');
  assert.equal(savedReject.json().feedback.active, true);
  const managerView = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('manager') });
  assert.equal(managerView.json().feedback, null, 'personal feedback is isolated by authenticated user');
  const stale = await app.inject({ method: 'POST', url: `/api/activities/${id}/guidance/feedback`, headers: as('anna'), payload: { recommendationKey: 'stage:university:meeting', action: 'defer' } });
  assert.equal(stale.statusCode, 404);
});

test('guidance becomes unavailable when the current workflow has removed its stage', async () => {
  const app = await appForTest();
  repository.workflowOverride = [
    ...(await repository.getWorkflow()),
    { kind: 'university', key: 'new-unreviewed-stage', label: 'Новая стадия', ordinal: 6, terminal: false },
  ];
  const unreviewed = await app.inject({ method: 'GET', url: '/api/guidance/university/new-unreviewed-stage', headers: as('anna') });
  assert.equal(unreviewed.statusCode, 409);
  assert.equal(unreviewed.json().code, 'guidance_unavailable');

  repository.workflowOverride = repository.workflowOverride.filter((stage) => stage.kind !== 'university' || stage.key !== 'contact');
  const standalone = await app.inject({ method: 'GET', url: '/api/guidance/university/contact', headers: as('anna') });
  assert.equal(standalone.statusCode, 404);
  repository.activity.stageKey = 'retired-stage';
  const contextual = await app.inject({ method: 'GET', url: `/api/activities/${id}/guidance`, headers: as('anna') });
  assert.equal(contextual.statusCode, 409);
  assert.equal(contextual.json().code, 'guidance_unavailable');
});

test('individual activity can be created without an organization', async () => {
  const app = await appForTest();
  const response = await app.inject({ method: 'POST', url: '/api/activities', headers: as('anna'), payload: { kind: 'individual', title: 'Подбор курса', personName: 'Синтетический слушатель' } });
  assert.equal(response.statusCode, 201);
  assert.equal(repository.createInput?.kind, 'individual');
  assert.equal(repository.createInput?.organizationName, undefined);
  assert.equal(response.json().stageKey, 'request');
  assert.equal(response.json().routeVersion, 'v2');
  assert.deepEqual(response.json().allowedNext, ['consultation']);
});

test('ordinary activity creation rejects external origins and provenance metadata', async () => {
  const app = await appForTest();
  const payload = { kind: 'individual', title: 'Внешний заказ', personName: 'Синтетический слушатель', origin: 'external_ready', originSource: 'CMS orders', originReference: 'ORD-opaque-17' };
  const response = await app.inject({ method: 'POST', url: '/api/activities', headers: as('anna'), payload });
  assert.equal(response.statusCode, 400);
  assert.equal(repository.createInput, undefined);
  const manualWithSource = await app.inject({ method: 'POST', url: '/api/activities', headers: as('anna'), payload: { ...payload, origin: 'manual' } });
  assert.equal(manualWithSource.statusCode, 400);
  assert.equal(manualWithSource.json().code, 'external_origin_import_only');
  const metadataWithoutOrigin = await app.inject({ method: 'POST', url: '/api/activities', headers: as('anna'), payload: { kind: 'individual', title: 'Метаданные без origin', personName: 'Синтетический слушатель', originReference: 'ORD-opaque-18' } });
  assert.equal(metadataWithoutOrigin.statusCode, 400);
  assert.equal(metadataWithoutOrigin.json().code, 'external_origin_import_only');
  const arbitraryStage = await app.inject({ method: 'POST', url: '/api/activities', headers: as('anna'), payload: { kind: 'individual', title: 'Ручной маршрут', personName: 'Синтетический слушатель', stageKey: 'learning' } });
  assert.equal(arbitraryStage.statusCode, 201);
  assert.equal(arbitraryStage.json().origin, 'manual');
  assert.equal(arbitraryStage.json().stageKey, 'request');
});

test('learning facts endpoint exposes only the scoped read-only LMS projection', async () => {
  const app = await appForTest();
  repository.activity = { ...repository.activity, kind: 'individual', stageKey: 'lms_handoff', origin: 'external_ready', ownerSub: anna.sub };
  repository.learningFacts = [{ id: 'fact-1', factKind: 'enrollment', source: 'LMS', occurredAt: '2026-09-27T10:00:00.000Z', reference: 'lms-event-1' }];
  const visible = await app.inject({ method: 'GET', url: `/api/activities/${id}/learning-facts`, headers: as('anna') });
  assert.equal(visible.statusCode, 200);
  assert.deepEqual(visible.json(), repository.learningFacts);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}/learning-facts`, headers: as('dmitry') })).statusCode, 404);
  repository.activity = { ...repository.activity, kind: 'university' };
  const wrongKind = await app.inject({ method: 'GET', url: `/api/activities/${id}/learning-facts`, headers: as('anna') });
  assert.equal(wrongKind.statusCode, 409);
});

test('task completion and contact outcome are independent from stage transition', async () => {
  const app = await appForTest();
  const dueAt = new Date(Date.now() + 86_400_000).toISOString();
  const task = await app.inject({ method: 'POST', url: `/api/activities/${id}/tasks`, headers: as('anna'), payload: { title: 'Позвонить координатору', dueAt } });
  assert.equal(task.statusCode, 201);
  const outcome = await app.inject({ method: 'POST', url: `/api/activities/${id}/outcomes`, headers: as('anna'), payload: { outcome: 'awaiting_reply', note: 'Ждём подтверждения времени встречи.' } });
  assert.equal(outcome.statusCode, 201);
  assert.equal(repository.activity.stageKey, 'contact');
  assert.ok(repository.events.some((event) => event.eventType === 'outcome_recorded'));
  const complete = await app.inject({ method: 'POST', url: `/api/activities/${id}/tasks/${taskId}/complete`, headers: as('anna') });
  assert.equal(complete.statusCode, 200);
  assert.equal(repository.activity.stageKey, 'contact');
  assert.equal(repository.tasks[0].status, 'done');
});

test('explicit cancellation and refusal outcomes require a reason and are auditable closure events', async () => {
  const app = await appForTest();
  const missingReason = await app.inject({ method: 'POST', url: `/api/activities/${id}/outcomes`, headers: as('anna'), payload: { outcome: 'cancelled', note: '   ' } });
  assert.equal(missingReason.statusCode, 400);
  assert.equal(missingReason.json().code, 'closure_outcome_reason_required');
  const refused = await app.inject({ method: 'POST', url: `/api/activities/${id}/outcomes`, headers: as('anna'), payload: { outcome: 'refused', note: 'Клиент отказался от обучения.' } });
  assert.equal(refused.statusCode, 201, refused.body);
  assert.equal(repository.events[0].eventType, 'closure_outcome_recorded');
  assert.deepEqual(repository.events[0].details, { outcome: 'refused', note: 'Клиент отказался от обучения.', stageKey: 'contact' });
});

test('only a workflow transition declared by the server can change stage', async () => {
  const app = await appForTest();
  const missingPrecondition = await app.inject({ method: 'POST', url: `/api/activities/${id}/transition`, headers: as('anna'), payload: { targetStage: 'meeting' } });
  assert.equal(missingPrecondition.statusCode, 400);
  const staleStage = await app.inject({ method: 'POST', url: `/api/activities/${id}/transition`, headers: as('anna'), payload: { targetStage: 'meeting', expectedStageKey: 'meeting', expectedWorkflowRevision: 1 } });
  assert.equal(staleStage.statusCode, 409);
  assert.equal(staleStage.json().code, 'transition_stage_conflict');
  const staleWorkflow = await app.inject({ method: 'POST', url: `/api/activities/${id}/transition`, headers: as('anna'), payload: { targetStage: 'meeting', expectedStageKey: 'contact', expectedWorkflowRevision: 2 } });
  assert.equal(staleWorkflow.statusCode, 409);
  assert.equal(staleWorkflow.json().code, 'workflow_revision_conflict');
  const rejected = await app.inject({ method: 'POST', url: `/api/activities/${id}/transition`, headers: as('anna'), payload: { targetStage: 'closed', expectedStageKey: 'contact', expectedWorkflowRevision: 1 } });
  assert.equal(rejected.statusCode, 409);
  assert.equal(repository.activity.stageKey, 'contact');
  const accepted = await app.inject({ method: 'POST', url: `/api/activities/${id}/transition`, headers: as('anna'), payload: { targetStage: 'meeting', expectedStageKey: 'contact', expectedWorkflowRevision: 1 } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(repository.activity.stageKey, 'meeting');
  assert.ok(repository.events.some((event) => event.eventType === 'stage_changed'));
});

test('manager scope includes the team portfolio while unknown roles are denied', async () => {
  const app = await appForTest();
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}`, headers: as('manager') })).statusCode, 200);
  const outsider = await app.inject({ method: 'GET', url: '/api/activities', headers: as('outsider') });
  assert.equal(outsider.statusCode, 403);
});

test('technical admin has no business endpoints unless the token also grants a business role', async () => {
  const app = await appForTest();
  for (const [method, url, payload] of [
    ['GET', '/api/catalog'], ['GET', '/api/activities'], ['GET', `/api/activities/${id}`],
    ['GET', '/api/guidance/university/contact'], ['GET', '/api/reports/ready'], ['GET', '/api/reports/owners'], ['GET', '/api/reports/organizations'], ['GET', '/api/reports/exports?limit=20'],
    ['POST', '/api/reports/snapshots', { reportId: 'crm_portfolio' }],
    ['POST', '/api/activities', { kind: 'university', title: 'Admin business write', organizationName: 'Org' }],
  ] as const) {
    const response = await app.inject({ method, url, headers: as('admin'), payload });
    assert.equal(response.statusCode, 403, `${method} ${url} is business data/action for an admin-only token`);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/workflow/university', headers: as('admin') })).statusCode, 200,
    'Technical workflow administration remains available to admin-only users.');
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/guidance/handbook', headers: as('admin') })).statusCode, 200,
    'The admin-only handbook endpoint supports editorial publication without opening business queues.');

  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}`, headers: as('manager-admin') })).statusCode, 200,
    'The manager role grants business access when combined with technical administration.');
  assert.equal((await app.inject({ method: 'GET', url: '/api/catalog', headers: as('manager-admin') })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/reports/ready', headers: as('manager-admin') })).statusCode, 200);
});

test('manager overview is role gated and returns defined metrics for populated and empty portfolios', async () => {
  const app = await appForTest();
  assert.equal((await app.inject({ method: 'GET', url: '/api/reports/owners' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/reports/owners', headers: as('anna') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/reports/organizations' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/reports/organizations', headers: as('anna') })).statusCode, 403);
  const kamOrganizationFilter = await app.inject({ method: 'POST', url: '/api/reports/snapshots', headers: as('anna'), payload: {
    reportId: 'crm_portfolio', filters: { organizationId: id },
  } });
  assert.equal(kamOrganizationFilter.statusCode, 403, 'KAM requests cannot widen report access through an organization selector.');
  const populated = await app.inject({ method: 'GET', url: '/api/manager/overview', headers: as('manager') });
  assert.equal(populated.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/manager/overview' })).statusCode, 401);
  assert.equal(populated.json().metrics.totalOpen, 1);
  assert.deepEqual(populated.json().metrics.byKind, { university: 1, corporate: 0, individual: 0 });
  assert.ok(populated.json().definitions.overdue);
  assert.ok(populated.json().definitions.topProducts);
  assert.ok(Array.isArray(populated.json().pipeline));
  assert.ok(populated.json().definitions.pipeline);
  assert.ok(Number.isFinite(Date.parse(populated.json().asOf)));
  assert.equal((await app.inject({ method: 'GET', url: '/api/manager/overview', headers: as('admin') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/manager/overview', headers: as('manager-admin') })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/manager/overview', headers: as('anna') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/manager/overview', headers: as('outsider') })).statusCode, 403);

  repository.overview = {
    ...repository.overview,
    metrics: { totalOpen: 0, byKind: { university: 0, corporate: 0, individual: 0 }, overdue: 0, awaitingReply: 0, noNextStep: 0 },
    byOwner: [], topProducts: [], asOf: new Date().toISOString(),
  };
  const empty = await app.inject({ method: 'GET', url: '/api/manager/overview', headers: as('manager') });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().metrics.totalOpen, 0);
  assert.deepEqual(empty.json().byOwner, []);
  assert.deepEqual(empty.json().topProducts, []);
  assert.deepEqual(empty.json().pipeline, []);
});

test('queue pagination reaches records beyond the former cap and drilldowns stay within role scope', async () => {
  const app = await appForTest();
  const productId = '550e8400-e29b-41d4-a716-446655440010';
  const otherProductId = '550e8400-e29b-41d4-a716-446655440011';
  repository.activity.productIds = [productId];
  repository.extraActivities = Array.from({ length: 260 }, (_, index) => ({
    id: `queue-${index}`, kind: index % 3 === 0 ? 'corporate' : 'university', title: `Активность ${index}`,
    ownerSub: index % 2 === 0 ? anna.sub : dmitry.sub, ownerName: index % 2 === 0 ? anna.name : dmitry.name,
    productIds: index % 3 === 0 ? [productId] : [otherProductId], priority: 3,
  }));

  const firstPage = await app.inject({ method: 'GET', url: '/api/activities?limit=50', headers: as('manager') });
  assert.equal(firstPage.statusCode, 200);
  assert.equal(firstPage.json().total, 261);
  assert.equal(firstPage.json().items.length, 50);
  const lastPage = await app.inject({ method: 'GET', url: '/api/activities?offset=250&limit=50', headers: as('manager') });
  assert.equal(lastPage.json().total, 261);
  assert.equal(lastPage.json().items.length, 11);

  const ownerPage = await app.inject({ method: 'GET', url: `/api/activities?ownerSub=${anna.sub}&limit=100`, headers: as('manager') });
  assert.equal(ownerPage.statusCode, 200);
  assert.equal(ownerPage.json().total, 131);
  assert.ok(ownerPage.json().items.every((item: { ownerSub: string }) => item.ownerSub === anna.sub));
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities?ownerSub=${dmitry.sub}`, headers: as('anna') })).statusCode, 403);
  const emptyPage = await app.inject({ method: 'GET', url: '/api/activities?ownerSub=no-open-activities', headers: as('manager') });
  assert.equal(emptyPage.json().total, 0);
  assert.deepEqual(emptyPage.json().items, []);

  const productPage = await app.inject({ method: 'GET', url: `/api/activities?productId=${productId}&limit=100`, headers: as('anna') });
  assert.equal(productPage.statusCode, 200);
  assert.ok(productPage.json().items.every((item: { ownerSub: string }) => item.ownerSub === anna.sub));
  assert.ok(productPage.json().total < 100);
  assert.equal((await app.inject({ method: 'GET', url: '/api/activities?productId=invalid', headers: as('manager') })).statusCode, 400);

  const stagePage = await app.inject({ method: 'GET', url: '/api/activities?segment=individual&stageKeys=lms_handoff,exceptions&routeVersion=v2', headers: as('anna') });
  assert.equal(stagePage.statusCode, 200, stagePage.body);
  assert.deepEqual(repository.lastActivityFilters?.stageKeys, ['lms_handoff', 'exceptions']);
  assert.equal(repository.lastActivityFilters?.routeVersion, 'v2');
  assert.equal((await app.inject({ method: 'GET', url: '/api/activities?stageKeys=bad%20key', headers: as('anna') })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/activities?segment=university&routeVersion=legacy', headers: as('manager') })).statusCode, 400);
});

test('queue search trims and matches title, organization, and contact within each actor scope', async () => {
  const app = await appForTest();
  repository.activity = { ...repository.activity, title: 'Cloud adoption plan', organizationName: 'Northwind Group', personName: 'Elena Petrova', ownerSub: anna.sub };
  repository.extraActivities = [{ id: 'queue-search-2', kind: 'individual', title: 'Support request', organizationName: 'Dynamics Lab', personName: 'Petrova Elena', ownerSub: dmitry.sub }];

  const title = await app.inject({ method: 'GET', url: '/api/activities?q=%20CLOUD%20ADOPTION%20', headers: as('anna') });
  assert.equal(title.statusCode, 200, title.body);
  assert.equal(title.json().total, 1);
  assert.equal(title.json().items[0].title, 'Cloud adoption plan');
  assert.equal(repository.lastActivityFilters?.search, 'CLOUD ADOPTION');

  const organization = await app.inject({ method: 'GET', url: '/api/activities?q=nOrThWiNd', headers: as('manager') });
  assert.equal(organization.json().total, 1);
  assert.equal(organization.json().items[0].organizationName, 'Northwind Group');

  const contacts = new URLSearchParams({ q: 'pEtRoVa', limit: '1', offset: '1' });
  const secondContactPage = await app.inject({ method: 'GET', url: `/api/activities?${contacts}`, headers: as('manager') });
  assert.equal(secondContactPage.statusCode, 200, secondContactPage.body);
  assert.equal(secondContactPage.json().total, 2);
  assert.equal(secondContactPage.json().items.length, 1);
  const scopedContacts = await app.inject({ method: 'GET', url: '/api/activities?q=Petrova', headers: as('anna') });
  assert.equal(scopedContacts.json().total, 1);
  assert.ok(scopedContacts.json().items.every((item: { ownerSub: string }) => item.ownerSub === anna.sub));

  const literalWildcard = await app.inject({ method: 'GET', url: '/api/activities?q=%25', headers: as('manager') });
  assert.equal(literalWildcard.json().total, 0);
  assert.equal((await app.inject({ method: 'GET', url: `/api/activities?q=${'x'.repeat(121)}`, headers: as('manager') })).statusCode, 400);
});

test('admin access overlay revokes a still-valid identity before card, file, and report handlers', async () => {
  const users = new Map<string, AccessPolicyUser>();
  const accessPolicy: AccessPolicyService = {
    async observeAndAssertEnabled(actor) {
      const existing = users.get(actor.sub);
      const now = new Date().toISOString();
      users.set(actor.sub, { sub: actor.sub, name: actor.name, roles: actor.roles, enabled: existing?.enabled ?? true,
        allowedKinds: existing?.allowedKinds ?? null, allowedOrganizationIds: existing?.allowedOrganizationIds ?? null, scopeRevision: existing?.scopeRevision ?? 0,
        lastSeenAt: now, updatedAt: existing?.updatedAt ?? now, updatedBySub: existing?.updatedBySub ?? null, reason: existing?.reason ?? null });
      if (!users.get(actor.sub)!.enabled) throw new DomainError(403, 'access_revoked', 'Доступ отключён.');
      return { ...actor, allowedKinds: users.get(actor.sub)!.allowedKinds, allowedOrganizationIds: users.get(actor.sub)!.allowedOrganizationIds };
    },
    async listKnownUsers() { return [...users.values()]; },
    async listOrganizations(search) {
      const rows = [{ id: '550e8400-e29b-41d4-a716-446655440010', name: 'РТК Лаб', segment: 'company' }];
      return rows.filter((row) => row.name.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))).slice(0, 100);
    },
    async setEnabled(actor, targetSub, enabled, reason) {
      const target = users.get(targetSub);
      if (!target) throw new DomainError(404, 'user_not_found', 'Пользователь не найден.');
      const remainingAdmins = [...users.values()].filter((user) => user.enabled && user.roles.includes('admin') && user.sub !== targetSub).length;
      assertAccessPolicyChange(actor, targetSub, enabled, target.roles.includes('admin'), remainingAdmins);
      const updated = { ...target, enabled, updatedAt: new Date().toISOString(), updatedBySub: actor.sub, reason: enabled ? null : reason };
      users.set(targetSub, updated);
      return updated;
    },
    async setAllowedKinds(actor, targetSub, allowedKinds, expectedRevision, reason) {
      assertAdmin(actor);
      const target = users.get(targetSub);
      if (!target) throw new DomainError(404, 'user_not_found', 'Пользователь не найден.');
      if (target.scopeRevision !== expectedRevision) throw new DomainError(409, 'scope_revision_conflict', 'Область доступа уже изменена.');
      const updated = { ...target, allowedKinds, scopeRevision: expectedRevision + 1, updatedAt: new Date().toISOString(), updatedBySub: actor.sub, reason };
      users.set(targetSub, updated);
      return updated;
    },
    async setAllowedOrganizations(actor, targetSub, allowedOrganizationIds, expectedRevision, reason) {
      assertAdmin(actor);
      const target = users.get(targetSub);
      if (!target) throw new DomainError(404, 'user_not_found', 'Пользователь не найден.');
      if (target.scopeRevision !== expectedRevision) throw new DomainError(409, 'scope_revision_conflict', 'Область доступа уже изменена.');
      const updated = { ...target, allowedOrganizationIds, scopeRevision: expectedRevision + 1, updatedAt: new Date().toISOString(), updatedBySub: actor.sub, reason };
      users.set(targetSub, updated);
      return updated;
    },
  };
  const app = buildApp({ repository, authenticate, accessPolicy });
  apps.push(app);
  await app.ready();

  assert.equal((await app.inject({ method: 'GET', url: `/api/activities/${id}`, headers: as('anna') })).statusCode, 200);
  const userList = await app.inject({ method: 'GET', url: '/api/admin/access/users', headers: as('admin') });
  assert.equal(userList.statusCode, 200);
  assert.ok(userList.json().users.some((user: { sub: string }) => user.sub === anna.sub));
  const orgDirectory = await app.inject({ method: 'GET', url: '/api/admin/access/organizations?search=%D0%A0%D0%A2%D0%9A', headers: as('admin') });
  assert.equal(orgDirectory.statusCode, 200, orgDirectory.body);
  assert.deepEqual(orgDirectory.json(), { organizations: [{ id: '550e8400-e29b-41d4-a716-446655440010', name: 'РТК Лаб', segment: 'company' }] });
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/access/organizations', headers: as('anna') })).statusCode, 403);
  assert.ok((await app.inject({ method: 'GET', url: '/openapi.json' })).json().paths['/api/admin/access/organizations'].get);
  const disabled = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${anna.sub}`, headers: as('admin'), payload: { enabled: false, reason: 'Увольнение' } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().enabled, false);

  for (const url of [
    `/api/activities/${id}`,
    `/api/activities/${id}/documents/550e8400-e29b-41d4-a716-446655440002`,
    `/api/reports/exports/${id}/file`,
    '/api/reports/ready',
  ]) {
    const response = await app.inject({ method: 'GET', url, headers: as('anna') });
    assert.equal(response.statusCode, 403, `revoked but otherwise valid JWT cannot read ${url}`);
    assert.equal(response.json().code, 'access_revoked');
  }
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/access/users/admin', headers: as('admin'), payload: { enabled: false, reason: 'self' } })).json().code, 'cannot_disable_self');
  assert.throws(() => assertAccessPolicyChange(admin, 'another-admin', false, true, 0),
    (error: unknown) => error instanceof DomainError && error.code === 'last_admin');
  assert.ok((await app.inject({ method: 'GET', url: '/openapi.json' })).json().paths['/api/admin/access/users/{sub}'].put);
  await app.inject({ method: 'GET', url: '/api/activities', headers: as('dmitry') });
  const scoped = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${dmitry.sub}/scope`, headers: as('admin'), payload: { allowedKinds: ['individual'], expectedRevision: 0, reason: 'Ограничение интеграционного теста' } });
  assert.equal(scoped.statusCode, 200, scoped.body);
  assert.deepEqual(scoped.json().allowedKinds, ['individual']);
  assert.equal(scoped.json().scopeRevision, 1);
  const staleScope = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${dmitry.sub}/scope`, headers: as('admin'), payload: { allowedKinds: null, expectedRevision: 0, reason: 'устаревшая ревизия' } });
  assert.equal(staleScope.statusCode, 409);
  assert.equal(staleScope.json().code, 'scope_revision_conflict');
  const deniedCreate = await app.inject({ method: 'POST', url: '/api/activities', headers: as('dmitry'), payload: { kind: 'university', title: 'Недоступный вуз', organizationName: 'Тест' } });
  assert.equal(deniedCreate.statusCode, 403);
  assert.equal(deniedCreate.json().code, 'segment_forbidden');
  assert.ok((await app.inject({ method: 'GET', url: '/openapi.json' })).json().paths['/api/admin/access/users/{sub}/scope'].put);
  const organizationId = '550e8400-e29b-41d4-a716-446655440010';
  const organizationScoped = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${dmitry.sub}/organizations`, headers: as('admin'),
    payload: { allowedOrganizationIds: [organizationId], expectedRevision: 1, reason: 'Ограничение по организации' } });
  assert.equal(organizationScoped.statusCode, 200, organizationScoped.body);
  assert.deepEqual(organizationScoped.json().allowedOrganizationIds, [organizationId]);
  assert.equal(organizationScoped.json().scopeRevision, 2);
  const staleOrganizationScope = await app.inject({ method: 'PUT', url: `/api/admin/access/users/${dmitry.sub}/organizations`, headers: as('admin'),
    payload: { allowedOrganizationIds: null, expectedRevision: 1, reason: 'устаревшая ревизия' } });
  assert.equal(staleOrganizationScope.statusCode, 409);
  assert.equal(staleOrganizationScope.json().code, 'scope_revision_conflict');
  assert.ok((await app.inject({ method: 'GET', url: '/openapi.json' })).json().paths['/api/admin/access/users/{sub}/organizations'].put);
});

test('global university workflow preview requires explicit mappings and apply preserves closure', async () => {
  const app = await appForTest();
  const openRemoved = { id: 'univ-open-meeting', kind: 'university', title: 'Открытая активность на удаляемой стадии', ownerName: anna.name, ownerSub: anna.sub, stageKey: 'meeting', closed: false };
  const closedRemoved = { id: 'univ-closed-meeting', kind: 'university', title: 'Закрытая активность на удаляемой стадии', ownerName: dmitry.name, ownerSub: dmitry.sub, stageKey: 'meeting', closed: true };
  const company = { id: 'corporate-untouched', kind: 'corporate', title: 'Корпоративный маршрут', ownerName: anna.name, ownerSub: anna.sub, stageKey: 'qualification', closed: false };
  repository.extraActivities = [openRemoved, closedRemoved, company];

  const saved = await app.inject({ method: 'GET', url: '/api/admin/workflow/university', headers: as('admin') });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().revision, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/workflow/university', headers: as('manager') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/workflow/university', headers: as('anna') })).statusCode, 403);

  const draft = {
    expectedRevision: 1,
    stages: [
      { key: 'contact', label: 'Первичный контакт', ordinal: 1, terminal: false },
      { key: 'documents', label: 'Документы и согласование', ordinal: 2, terminal: false },
      { key: 'implementation', label: 'Внедрение', ordinal: 3, terminal: false },
      { key: 'closed', label: 'Завершено', ordinal: 4, terminal: true },
    ],
    transitions: [{ from: 'contact', to: 'documents' }, { from: 'documents', to: 'implementation' }, { from: 'implementation', to: 'closed' }],
    mappings: {},
  };
  const terminalOnly = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: as('admin'), payload: {
    expectedRevision: 1,
    stages: [{ key: 'closed', label: 'Завершено', ordinal: 1, terminal: true }],
    transitions: [], mappings: {},
  } });
  assert.equal(terminalOnly.statusCode, 400, 'A terminal-only route has no valid nonterminal initial stage.');
  const invalidGraph = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: as('admin'), payload: { ...draft, transitions: [{ from: 'contact', to: 'documents' }] } });
  assert.equal(invalidGraph.statusCode, 400);
  assert.equal(invalidGraph.json().code, 'workflow_terminal_unreachable');
  const missingMapping = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: as('admin'), payload: draft });
  assert.equal(missingMapping.statusCode, 200);
  assert.equal(missingMapping.json().canApply, false);
  assert.deepEqual(missingMapping.json().validReplacementKeys.meeting, ['contact', 'documents']);
  assert.equal(missingMapping.json().counts.total, 3);
  assert.equal(missingMapping.json().counts.closed, 1);
  assert.equal(repository.universityWorkflowRevision, 1, 'a preview can be cancelled without changing the workflow');
  assert.equal(closedRemoved.stageKey, 'meeting');

  const withMapping = { ...draft, mappings: { meeting: 'documents' } };
  const beforeConflict = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: as('admin'), payload: withMapping });
  assert.equal(beforeConflict.json().canApply, true);
  assert.ok(beforeConflict.json().impactedActivities.every((activity: { title: string | null; ownerName: string | null }) => activity.title === null && activity.ownerName === null));
  const managerPreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: as('manager-admin'), payload: withMapping });
  assert.equal(managerPreview.json().impactedActivities.find((activity: { id: string }) => activity.id === openRemoved.id).title, openRemoved.title,
    'The manager role keeps the detailed workflow preview when combined with admin.');
  openRemoved.stageKey = 'documents';
  const staleApply = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: as('admin'), payload: { ...withMapping, previewToken: beforeConflict.json().previewToken } });
  assert.equal(staleApply.statusCode, 409);
  assert.equal(staleApply.json().code, 'workflow_preview_stale');
  openRemoved.stageKey = 'meeting';

  const freshPreview = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/preview', headers: as('admin'), payload: withMapping });
  const apply = await app.inject({ method: 'POST', url: '/api/admin/workflow/university/apply', headers: as('admin'), payload: { ...withMapping, previewToken: freshPreview.json().previewToken } });
  assert.equal(apply.statusCode, 200, apply.body);
  assert.equal(apply.json().migratedCount, 2);
  assert.equal(apply.json().preservedClosedCount, 1);
  assert.ok(apply.json().changedActivities.every((activity: { title: string | null }) => activity.title === null));
  assert.equal(openRemoved.stageKey, 'documents');
  assert.equal(openRemoved.closed, false);
  assert.equal(closedRemoved.stageKey, 'documents');
  assert.equal(closedRemoved.closed, true);
  assert.equal(company.stageKey, 'qualification');
  assert.equal(repository.universityWorkflowRevision, 2);
  assert.ok(repository.events.some((event) => event.eventType === 'workflow_stage_migrated'));
});
