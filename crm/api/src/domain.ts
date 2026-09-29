export type ActivityKind = 'university' | 'individual' | 'corporate';
export type ActivityOrigin = 'manual' | 'external_ready' | 'cms_mock';
export type LearningFactKind = 'enrollment' | 'learning_started' | 'learning_completed';
export type Collection = 'today' | 'overdue' | 'awaiting_reply' | 'no_next_step' | 'all';
export type Segment = 'all' | 'university' | 'company' | 'individual';
export type Role = 'kam' | 'manager' | 'admin' | string;

export interface Actor {
  sub: string;
  name: string;
  email?: string;
  roles: Role[];
  /** Null or omitted means all activity kinds; an empty list means none. */
  allowedKinds?: ActivityKind[] | null;
  /** Null or omitted means all organizations; an empty list permits only activities without organization links. */
  allowedOrganizationIds?: string[] | null;
}

export interface NewActivity {
  kind: ActivityKind;
  title: string;
  origin?: ActivityOrigin;
  originSource?: string;
  originReference?: string;
  organizationId?: string;
  organizationName?: string;
  personId?: string;
  personName?: string;
  email?: string;
  phone?: string;
  payerOrganizationId?: string;
  payerOrganizationName?: string;
  productIds?: string[];
  programIds?: string[];
  priority?: number;
}

export interface ActivityDetailsUpdate {
  personId?: string | null;
  newPerson?: { fullName: string; email?: string; phone?: string };
  productIds: string[];
  programIds?: string[];
  priority: number;
  expectedRevision: number;
}

export interface LearningProgram {
  id: string;
  name: string;
  priority: number;
  revision: number;
  demandCount: number;
}

export interface ActivityFilters {
  segment: Segment;
  collection: Collection;
  search?: string;
  ownerSub?: string;
  productId?: string;
  stageKeys?: string[];
  routeVersion?: 'legacy' | 'v2';
  offset: number;
  limit: number;
}

export interface ActivityPage {
  items: Record<string, unknown>[];
  total: number;
  offset: number;
  limit: number;
}

export interface ManagerOverview {
  asOf: string;
  metrics: {
    totalOpen: number;
    byKind: { university: number; corporate: number; individual: number };
    overdue: number;
    awaitingReply: number;
    noNextStep: number;
  };
  byOwner: { ownerSub: string; ownerName: string; open: number; overdue: number }[];
  topProducts: { id: string; name: string; activityCount: number }[];
  pipeline: { kind: ActivityKind; routeVersion: 'legacy' | 'v2' | 'current'; routeLabel: string; stages: { key: string; label: string; stageKeys: string[]; count: number; oldestUpdatedAt: string | null }[] }[];
  definitions: Record<string, string>;
}

export interface NewTask {
  title: string;
  dueAt: string;
}

export type GuidanceFeedbackAction = 'defer' | 'reject';
export interface GuidanceFeedback {
  action: GuidanceFeedbackAction;
  reason: string | null;
  deferredUntil: string | null;
  updatedAt: string;
}

export interface GuidanceArticleContent {
  title: string;
  summary: string;
  focus: string;
  checks: string[];
  boundary: string;
  draftMessage: string;
  recommendationWhenNoOpenTask: string;
}

export interface GuidanceStageSnapshot {
  label: string;
  ordinal: number;
  terminal: boolean;
  allowedNext: string[];
  allowedNextByRoute: { legacy: string[]; v2: string[] };
}

export interface GuidanceEditorialRecord {
  kind: ActivityKind;
  stageKey: string;
  seedStageSnapshot: GuidanceStageSnapshot;
  draftArticle: GuidanceArticleContent | null;
  draftRevision: number;
  draftStageSnapshot: GuidanceStageSnapshot | null;
  publishedArticle: GuidanceArticleContent | null;
  publishedRevision: number | null;
  publishedStageSnapshot: GuidanceStageSnapshot | null;
  publishedAt: string | null;
  publishedByName: string | null;
  updatedAt: string;
}

export interface GuidanceCatalogSnapshot {
  workflow: Record<string, unknown>[];
  articles: GuidanceEditorialRecord[];
}

export interface AssignableKam {
  sub: string;
  name: string;
}

export interface ActivityReassignmentPreviewInput {
  targetKamSub: string;
  expectedOwnerSub: string;
  expectedAssignmentRevision: number;
}

export interface ActivityReassignmentPreview {
  activityId: string;
  title: string;
  kind: ActivityKind;
  currentOwner: AssignableKam;
  targetOwner: AssignableKam;
  assignmentRevision: number;
  updatedAt: string;
  canConfirm: boolean;
  previewToken: string | null;
  blockers: { code: string; message: string }[];
  impact: {
    stageKey: string;
    stageLabel: string;
    closed: boolean;
    awaitingReply: boolean;
    createdAt: string;
    historyEventCount: number;
    taskCount: number;
    openTaskCount: number;
    nextOpenTaskDueAt: string | null;
    openTasksWillTransfer: boolean;
    completedTaskAttributionWillRemain: boolean;
  };
}

export interface ActivityReassignmentResult {
  activityId: string;
  previousOwner: AssignableKam;
  owner: AssignableKam;
  assignmentRevision: number;
  updatedAt: string;
  openTasksReassigned: number;
  completedTasksPreserved: number;
  eventId: string;
}

export type UniversityStepStatus = 'unrecorded' | 'in_progress' | 'waiting' | 'documented' | 'not_applicable';
export interface UniversityStepUpdate {
  status: Exclude<UniversityStepStatus, 'unrecorded'>;
  note: string;
  evidenceReference: string | null;
  evidenceSource: string | null;
  expectedRevision: number;
}
export interface UniversityCorrectionReturn {
  expectedU04Revision: number;
  expectedU05Revision: number;
  note: string;
  evidenceReference: string | null;
  evidenceSource: string | null;
}

export interface WorkflowStageDraft {
  key: string;
  label: string;
  ordinal: number;
  terminal: boolean;
}

export interface WorkflowTransitionDraft {
  from: string;
  to: string;
}

export interface UniversityWorkflowChange {
  expectedRevision: number;
  stages: WorkflowStageDraft[];
  transitions: WorkflowTransitionDraft[];
  mappings: Record<string, string>;
}

export interface UniversityWorkflowApply extends UniversityWorkflowChange {
  previewToken: string;
}

export type CorporateProgramMode = 'standard' | 'adapted' | 'new' | 'undecided';
export type MethodologistFeasibility = 'unassessed' | 'feasible' | 'feasible_with_changes' | 'not_feasible';
export type CorporateApprovalStatus = 'not_recorded' | 'pending' | 'approved' | 'rejected';
export interface CorporatePlanInput {
  expectedRevision: number;
  programMode: CorporateProgramMode;
  requestedPlaces: number | null;
  brief: { expectedOutcome: string | null; audience: string | null; entryLevel: string | null; deliveryFormat: string | null; volume: string | null; technologyContext: string | null };
  methodologist: { name: string | null; feasibility: MethodologistFeasibility; note: string | null };
  proposed: { scope: string | null; startDate: string | null; endDate: string | null; acceptanceCriteria: string | null };
  agreed: { scope: string | null; startDate: string | null; endDate: string | null; acceptanceCriteria: string | null };
  approval: { status: CorporateApprovalStatus; evidenceReference: string | null; evidenceSource: string | null; note: string | null };
}
export interface CorporatePlan extends Omit<CorporatePlanInput, 'expectedRevision'> {
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
  readOnly: boolean;
}

export interface ActivityDocument {
  id: string;
  activityId: string;
  name: string;
  extension: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedByName: string;
}

export type LicenseExpiryPrecision = 'exact_date' | 'year' | 'unknown';
export type ActivityContractStatus = 'draft' | 'signed' | 'ended' | 'unknown';
export interface ActivityContractLicenseFields {
  title: string;
  contractReference: string | null;
  contractStatus: ActivityContractStatus | null;
  licenseExpiryPrecision: LicenseExpiryPrecision | null;
  licenseExpiresOn: string | null;
  licenseExpiresYear: number | null;
  documentId: string | null;
  note: string | null;
}
export interface ActivityContractLicenseInput extends ActivityContractLicenseFields { expectedRevision: number }
export interface ActivityContractLicense extends ActivityContractLicenseFields {
  id: string;
  activityId: string;
  documentName: string | null;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  readOnly: boolean;
}

export interface NewActivityDocument extends Omit<ActivityDocument, 'uploadedAt' | 'uploadedByName'> {
  objectKey: string;
}

export interface StoredActivityDocument extends ActivityDocument {
  objectKey: string;
}

export type Outcome = 'connected' | 'no_answer' | 'meeting_booked' | 'awaiting_reply' | 'not_interested' | 'other' | 'cancelled' | 'refused';

export interface CrmRepository {
  listLearningPrograms(actor: Actor): Promise<LearningProgram[]>;
  createLearningProgram(actor: Actor, name: string): Promise<LearningProgram>;
  updateLearningProgramPriority(actor: Actor, id: string, priority: number, expectedRevision: number): Promise<LearningProgram>;
  listActivities(actor: Actor, filters: ActivityFilters): Promise<ActivityPage>;
  managerOverview(actor: Actor): Promise<ManagerOverview>;
  listAssignableKams(actor: Actor): Promise<AssignableKam[]>;
  previewActivityReassignment(actor: Actor, activityId: string, input: ActivityReassignmentPreviewInput): Promise<ActivityReassignmentPreview>;
  confirmActivityReassignment(actor: Actor, activityId: string, previewToken: string): Promise<ActivityReassignmentResult>;
  getActivity(actor: Actor, id: string): Promise<Record<string, unknown> | null>;
  createActivity(actor: Actor, input: NewActivity): Promise<Record<string, unknown>>;
  updateActivityDetails(actor: Actor, activityId: string, input: ActivityDetailsUpdate): Promise<Record<string, unknown>>;
  getWorkflow(): Promise<Record<string, unknown>[]>;
  getUniversityWorkflowAdmin(actor: Actor): Promise<Record<string, unknown>>;
  previewUniversityWorkflow(actor: Actor, input: UniversityWorkflowChange): Promise<Record<string, unknown>>;
  applyUniversityWorkflow(actor: Actor, input: UniversityWorkflowApply): Promise<Record<string, unknown>>;
  createTask(actor: Actor, activityId: string, input: NewTask): Promise<Record<string, unknown>>;
  activityFeed(actor: Actor, input: { limit: number; cursor?: string; actorSub?: string }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>;
  taskSubscription(actor: Actor, activityId: string, taskId: string): Promise<{ subscribed: boolean }>;
  setTaskSubscription(actor: Actor, activityId: string, taskId: string, subscribed: boolean): Promise<{ subscribed: boolean }>;
  createTaskUpdate(actor: Actor, activityId: string, taskId: string, text: string): Promise<Record<string, unknown>>;
  notifications(actor: Actor, input: { limit: number; cursor?: string }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null; unreadCount: number }>;
  markNotificationRead(actor: Actor, notificationId: string): Promise<{ id: string; readAt: string }>;
  getGuidanceFeedback(actor: Actor, activityId: string, recommendationKey: string): Promise<GuidanceFeedback | null>;
  saveGuidanceFeedback(actor: Actor, activityId: string, recommendationKey: string, action: GuidanceFeedbackAction, reason: string | null): Promise<GuidanceFeedback>;
  getGuidanceCatalog(): Promise<GuidanceCatalogSnapshot>;
  saveGuidanceDraft(actor: Actor, kind: ActivityKind, stageKey: string, article: GuidanceArticleContent, expectedRevision: number): Promise<GuidanceEditorialRecord>;
  publishGuidanceArticle(actor: Actor, kind: ActivityKind, stageKey: string, expectedDraftRevision: number): Promise<GuidanceEditorialRecord>;
  completeTask(actor: Actor, activityId: string, taskId: string): Promise<Record<string, unknown>>;
  recordOutcome(actor: Actor, activityId: string, outcome: Outcome, note: string): Promise<Record<string, unknown>>;
  transition(actor: Actor, activityId: string, targetStage: string, expectedStageKey: string, expectedWorkflowRevision: number | null): Promise<Record<string, unknown>>;
  history(actor: Actor, activityId: string): Promise<Record<string, unknown>[] | null>;
  listActivityDocuments(actor: Actor, activityId: string): Promise<ActivityDocument[] | null>;
  addActivityDocument(actor: Actor, input: NewActivityDocument): Promise<ActivityDocument>;
  getActivityDocumentForDownload(actor: Actor, activityId: string, documentId: string): Promise<StoredActivityDocument | null>;
  recordActivityDocumentDownload(actor: Actor, activityId: string, documentId: string): Promise<boolean>;
  individualLearningFacts(actor: Actor, activityId: string): Promise<Record<string, unknown>[] | null>;
  universitySteps(actor: Actor, activityId: string): Promise<Record<string, unknown> | null>;
  updateUniversityStep(actor: Actor, activityId: string, stepId: string, input: UniversityStepUpdate): Promise<Record<string, unknown>>;
  universityCorrectionReturn(actor: Actor, activityId: string, input: UniversityCorrectionReturn): Promise<Record<string, unknown>>;
  corporatePlan(actor: Actor, activityId: string): Promise<CorporatePlan | null>;
  updateCorporatePlan(actor: Actor, activityId: string, input: CorporatePlanInput): Promise<CorporatePlan>;
  listActivityContractLicenses(actor: Actor, activityId: string): Promise<ActivityContractLicense[] | null>;
  addActivityContractLicense(actor: Actor, activityId: string, input: ActivityContractLicenseFields): Promise<ActivityContractLicense>;
  updateActivityContractLicense(actor: Actor, activityId: string, recordId: string, input: ActivityContractLicenseInput): Promise<ActivityContractLicense>;
  deleteActivityContractLicense(actor: Actor, activityId: string, recordId: string, expectedRevision: number): Promise<boolean>;
  catalog(actor: Actor): Promise<Record<string, unknown>>;
}

const contractTextMax: Record<string, number> = { title: 160, contractReference: 180, note: 1500 };
function validateContractText(value: string | null, field: string, required = false) {
  if (required && (typeof value !== 'string' || !value.trim())) throw new DomainError(400, 'invalid_contract_license', 'Укажите название договора или лицензии.');
  if (value !== null && (typeof value !== 'string' || value.trim().length > contractTextMax[field] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) {
    throw new DomainError(400, 'invalid_contract_license', 'Поле договора или лицензии слишком длинное либо содержит недопустимые символы.');
  }
}

export function validateActivityContractLicense(input: ActivityContractLicenseFields) {
  validateContractText(input.title, 'title', true);
  validateContractText(input.contractReference, 'contractReference');
  validateContractText(input.note, 'note');
  if (input.contractStatus !== null && !['draft', 'signed', 'ended', 'unknown'].includes(input.contractStatus)) {
    throw new DomainError(400, 'invalid_contract_status', 'Укажите корректное состояние договора.');
  }
  const { licenseExpiryPrecision: precision, licenseExpiresOn: expiresOn, licenseExpiresYear: expiresYear } = input;
  if (precision === null) {
    if (expiresOn !== null || expiresYear !== null) throw new DomainError(400, 'invalid_license_expiry', 'Точность срока действия не указана, поэтому дату или год нужно очистить.');
  } else if (!['exact_date', 'year', 'unknown'].includes(precision)) {
    throw new DomainError(400, 'invalid_license_expiry', 'Укажите точность срока действия лицензии.');
  } else if (precision === 'exact_date') {
    if (typeof expiresOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || Number.isNaN(Date.parse(`${expiresOn}T00:00:00Z`)) || new Date(`${expiresOn}T00:00:00Z`).toISOString().slice(0, 10) !== expiresOn || expiresYear !== null) {
      throw new DomainError(400, 'invalid_license_expiry', 'Для точного срока укажите корректную дату без отдельного года.');
    }
  } else if (precision === 'year') {
    if (expiresOn !== null || !Number.isInteger(expiresYear) || expiresYear! < 1900 || expiresYear! > 9999) {
      throw new DomainError(400, 'invalid_license_expiry', 'Для срока с точностью до года укажите год от 1900 до 9999 без даты.');
    }
  } else if (expiresOn !== null || expiresYear !== null) {
    throw new DomainError(400, 'invalid_license_expiry', 'Для неизвестного срока дату и год оставьте пустыми.');
  }
  if (input.documentId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.documentId)) {
    throw new DomainError(400, 'invalid_contract_document', 'Выберите документ из вложений этой активности.');
  }
}

const planTextMax: Record<string, number> = {
  expectedOutcome: 1000, audience: 500, entryLevel: 500, deliveryFormat: 300, volume: 300, technologyContext: 500,
  name: 180, note: 2000, scope: 2000, acceptanceCriteria: 1500, evidenceReference: 500, evidenceSource: 160,
};
function validatePlanText(value: string | null, field: string) {
  if (value !== null && (typeof value !== 'string' || value.trim().length > planTextMax[field] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) {
    throw new DomainError(400, 'invalid_corporate_plan', `Поле ${field} слишком длинное или содержит недопустимые символы.`);
  }
}

export function validateCorporatePlan(input: CorporatePlanInput) {
  if (!['standard', 'adapted', 'new', 'undecided'].includes(input.programMode)) throw new DomainError(400, 'invalid_program_mode', 'Укажите готовую, адаптированную, новую или пока не выбранную программу.');
  if (input.requestedPlaces !== null && (!Number.isInteger(input.requestedPlaces) || input.requestedPlaces < 0 || input.requestedPlaces > 1000000)) {
    throw new DomainError(400, 'invalid_requested_places', 'Число запрошенных мест должно быть от 0 до 1 000 000.');
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 2147483646) throw new DomainError(400, 'invalid_revision', 'Некорректная версия плана.');
  for (const [field, value] of Object.entries(input.brief)) validatePlanText(value, field);
  for (const [field, value] of Object.entries(input.methodologist)) validatePlanText(value, field);
  for (const [field, value] of Object.entries(input.proposed)) validatePlanText(value, field);
  for (const [field, value] of Object.entries(input.agreed)) validatePlanText(value, field);
  for (const [field, value] of Object.entries(input.approval)) validatePlanText(value, field);
  if (!['unassessed', 'feasible', 'feasible_with_changes', 'not_feasible'].includes(input.methodologist.feasibility)) throw new DomainError(400, 'invalid_feasibility', 'Укажите корректную оценку реализуемости.');
  if (!['not_recorded', 'pending', 'approved', 'rejected'].includes(input.approval.status)) throw new DomainError(400, 'invalid_approval_status', 'Укажите корректное состояние согласования.');
  for (const dates of [input.proposed, input.agreed]) {
    for (const key of ['startDate', 'endDate'] as const) {
      const value = dates[key];
      if (value !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) {
        throw new DomainError(400, 'invalid_plan_date', 'Укажите корректную календарную дату.');
      }
    }
    if (dates.startDate && dates.endDate && dates.startDate > dates.endDate) throw new DomainError(400, 'invalid_plan_date_range', 'Дата начала должна быть не позже даты окончания.');
  }
  if (['approved', 'rejected'].includes(input.approval.status) && (!input.approval.evidenceReference?.trim() || !input.approval.evidenceSource?.trim())) {
    throw new DomainError(400, 'approval_evidence_required', 'Для зафиксированного решения укажите источник и ссылку или позицию подтверждения.');
  }
}

export const universityStepStatuses: UniversityStepStatus[] = ['unrecorded', 'in_progress', 'waiting', 'documented', 'not_applicable'];

export class DomainError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

export const hasBusinessAccess = (actor: Actor) => actor.roles.includes('kam') || actor.roles.includes('manager');
export const hasTeamBusinessScope = (actor: Actor) => actor.roles.includes('manager');
export const isActivityKindAllowed = (actor: Actor, kind: ActivityKind) => actor.allowedKinds == null || actor.allowedKinds.includes(kind);

export function assertActivityKindAllowed(actor: Actor, kind: ActivityKind) {
  if (!isActivityKindAllowed(actor, kind)) throw new DomainError(403, 'segment_forbidden', 'Доступ к этому типу активности ограничен администратором.');
}

export function assertBusinessAccess(actor: Actor) {
  if (!hasBusinessAccess(actor)) throw new DomainError(403, 'forbidden', 'Для бизнес-данных нужна роль КАМ или руководителя.');
}

export function assertCanCreate(actor: Actor) {
  assertBusinessAccess(actor);
}

export function assertAdmin(actor: Actor) {
  if (!actor.roles.includes('admin')) throw new DomainError(403, 'forbidden', 'Для изменения общей схемы нужна роль администратора.');
}

export function assertManager(actor: Actor) {
  if (!actor.roles.includes('manager')) throw new DomainError(403, 'forbidden', 'Для переназначения активности нужна роль руководителя.');
}

export function validateNewActivity(input: NewActivity) {
  if (!['university', 'individual', 'corporate'].includes(input.kind)) {
    throw new DomainError(400, 'invalid_kind', 'Выберите один из трёх типов активности.');
  }
  if (!input.title?.trim() || input.title.trim().length > 180) {
    throw new DomainError(400, 'invalid_title', 'Название обязательно и должно быть короче 180 символов.');
  }
  if (input.kind === 'individual' && !(input.personId || input.personName?.trim())) {
    throw new DomainError(400, 'person_required', 'Для физлица укажите имя человека.');
  }
  if (input.kind !== 'individual' && !(input.organizationId || input.organizationName?.trim())) {
    throw new DomainError(400, 'organization_required', 'Для этой активности укажите организацию.');
  }
  if (input.kind === 'individual' && (input.organizationId || input.organizationName?.trim())) {
    throw new DomainError(400, 'individual_organization_invalid', 'Для физлица укажите компанию отдельно как плательщика, если это нужно.');
  }
  validateManualActivityOrigin(input);
  if (input.organizationId && input.organizationName?.trim()) {
    throw new DomainError(400, 'organization_conflict', 'Выберите существующую организацию или создайте новую.');
  }
  if (input.personId && input.personName?.trim()) {
    throw new DomainError(400, 'person_conflict', 'Выберите существующее контактное лицо или создайте новое.');
  }
  if (input.payerOrganizationId && input.payerOrganizationName?.trim()) {
    throw new DomainError(400, 'payer_conflict', 'Выберите существующую компанию-плательщика или создайте новую.');
  }
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5)) {
    throw new DomainError(400, 'invalid_priority', 'Приоритет должен быть от 1 до 5.');
  }
  if ((input.productIds?.length ?? 0) > 20 || new Set(input.productIds ?? []).size !== (input.productIds ?? []).length) {
    throw new DomainError(400, 'invalid_products', 'Список продуктов содержит повтор или больше 20 позиций.');
  }
  if (input.programIds !== undefined && (!Array.isArray(input.programIds) || input.programIds.length > 50 || input.programIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(input.programIds).size !== input.programIds.length)) {
    throw new DomainError(400, 'invalid_programs', 'Выберите не более 50 разных учебных программ.');
  }
}

export function validateManualActivityOrigin(input: NewActivity) {
  if ((input.origin ?? 'manual') !== 'manual' || input.originSource !== undefined || input.originReference !== undefined) {
    throw new DomainError(400, 'external_origin_import_only', 'Внешние заявки и сведения об их происхождении создаются только через проверенный импорт.');
  }
}

export function validateActivityDetailsUpdate(input: ActivityDetailsUpdate) {
  const hasPersonId = Object.hasOwn(input, 'personId');
  const hasNewPerson = Object.hasOwn(input, 'newPerson');
  if (hasPersonId === hasNewPerson) {
    throw new DomainError(400, 'activity_contact_selection_invalid', 'Выберите существующий контакт, очистите его или укажите данные нового контакта.');
  }
  if (hasPersonId && input.personId !== null && (typeof input.personId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.personId))) {
    throw new DomainError(400, 'invalid_activity_details', 'Выберите корректное контактное лицо или очистите поле.');
  }
  if (hasNewPerson) {
    const person = input.newPerson;
    if (!person || typeof person.fullName !== 'string' || !person.fullName.trim() || person.fullName.trim().length > 180 || /[\u0000-\u001f\u007f]/.test(person.fullName)) {
      throw new DomainError(400, 'invalid_activity_contact', 'Укажите имя нового контакта (до 180 символов).');
    }
    if (person.email !== undefined && (typeof person.email !== 'string' || person.email.length > 254 || /[\u0000-\u001f\u007f]/.test(person.email))) {
      throw new DomainError(400, 'invalid_activity_contact', 'Email нового контакта слишком длинный или содержит недопустимые символы.');
    }
    if (person.phone !== undefined && (typeof person.phone !== 'string' || person.phone.length > 64 || /[\u0000-\u001f\u007f]/.test(person.phone))) {
      throw new DomainError(400, 'invalid_activity_contact', 'Телефон нового контакта слишком длинный или содержит недопустимые символы.');
    }
  }
  if (!Array.isArray(input.productIds) || input.productIds.length > 20 || input.productIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(input.productIds).size !== input.productIds.length) {
    throw new DomainError(400, 'invalid_activity_details', 'Выберите не более 20 разных продуктов.');
  }
  if (input.programIds !== undefined && (!Array.isArray(input.programIds) || input.programIds.length > 50 || input.programIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(input.programIds).size !== input.programIds.length)) {
    throw new DomainError(400, 'invalid_activity_details', 'Выберите не более 50 разных программ.');
  }
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5) {
    throw new DomainError(400, 'invalid_activity_details', 'Приоритет должен быть от 1 до 5.');
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 2147483646) {
    throw new DomainError(400, 'invalid_activity_details', 'Ревизия активности некорректна.');
  }
}

export function validateTask(input: NewTask) {
  if (!input.title?.trim() || input.title.trim().length > 180) {
    throw new DomainError(400, 'invalid_task_title', 'Напишите действие (до 180 символов).');
  }
  const dueAt = new Date(input.dueAt);
  if (!input.dueAt || Number.isNaN(dueAt.valueOf())) {
    throw new DomainError(400, 'invalid_due_at', 'Укажите корректный срок.');
  }
}
