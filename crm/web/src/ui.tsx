import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type UIEvent } from 'react';
import { NavigationIcon } from './nav-icons';
import { clearStoredImportDraft, ImportPanel, prepareImportSession } from './import-panel';
import { UniversityWorkflowAdmin } from './university-workflow-admin';
import { AccessUsers } from './access-users';
import { ActivityFeedPage, NotificationsPage, TaskUpdates } from './activity-updates';
import { KamDashboard } from './kam-dashboard';
import { ProgramCatalog, type LearningProgram } from './program-catalog';
import { formatRussianCount, russianNounForm } from './russian-count';
import { UserAvatar } from './user-avatar';

type Kind = 'university' | 'individual' | 'corporate';
type Segment = 'all' | 'university' | 'company' | 'individual';
type Collection = 'today' | 'overdue' | 'awaiting_reply' | 'no_next_step' | 'all';
type ActivityOrigin = 'manual' | 'external_ready' | 'cms_mock';
type QueueDrilldown = { ownerSub?: string; ownerName?: string; productId?: string; productName?: string; stageKeys?: string[]; routeVersion?: 'legacy' | 'v2'; stageLabel?: string } | null;
type Token = () => Promise<string>;
type User = { sub?: string; name?: string; preferred_username?: string; realm_access?: { roles?: string[] } };
type Product = { id: string; name: string };
const PRODUCT_LABELS: Record<string, string> = {
  'RT.DataLake': 'RT.DataLake — корпоративное хранилище данных',
  'RT.Warehouse': 'RT.Warehouse — продукт из файла поставщиков',
  'RT.Web3Gate': 'RT.Web3Gate — платформа распределённых реестров',
  'Базис': 'Базис — инфраструктура для DevOps',
  'Аврора': 'Аврора — мобильная платформа',
  'Акола': 'Акола — среда веб-разработки',
};
const productLabel = (name: string) => PRODUCT_LABELS[name] ?? name;
type Workflow = { kind: Kind; key: string; label: string; ordinal: number; terminal: boolean; allowedNext?: string[]; allowedNextByRoute?: { legacy: string[]; v2: string[] } };
type Task = { id: string; title: string; dueAt: string; status: 'open' | 'done'; ownerName?: string };
type Activity = {
  id: string; kind: Kind; title: string; stageKey: string; stageLabel: string; workflowRevision?: number | null; origin?: ActivityOrigin; originSource?: string | null; originReference?: string | null; originLabel?: string; routeVersion?: 'legacy' | 'v2'; allowedNext?: string[]; organizationName?: string;
  ownerSub?: string; ownerName?: string; assignmentRevision?: number;
  personName?: string; personId?: string; organizationId?: string; personEmail?: string; email?: string; phone?: string;
  priority: number; revision?: number; productIds?: string[]; programIds?: string[]; awaitingReply?: boolean; createdAt?: string; updatedAt?: string; nextTaskId?: string;
  nextTaskTitle?: string; nextTaskDueAt?: string; nextTaskStatus?: string; allowedNextLabels?: string[]; productNames?: string[]; productLinks?: { id: string; name: string; catalogVisible: boolean }[]; programNames?: string[];
  payerOrganizationName?: string; tasks?: Task[]; closed?: boolean;
};

function selectedQueuePosition(selected: Activity, loadedQueue: Activity[], hasCurrentQueueAccess: boolean) {
  if (!hasCurrentQueueAccess) return null;
  const index = loadedQueue.findIndex((activity) => activity.id === selected.id);
  return index >= 0 ? { index: index + 1, total: loadedQueue.length } : null;
}
function savedQueueState() {
  try {
    return JSON.parse(localStorage.getItem('lct-queue-v1') ?? '{"segment":"all","collection":"all"}') as {
      segment?: Segment; collection?: Collection; search?: string;
    };
  } catch {
    return { segment: 'all' as Segment, collection: 'all' as Collection, search: '' };
  }
}
function savedSidebarCollapsed() {
  try {
    return localStorage.getItem('lct-sidebar-collapsed-v1') === 'true';
  } catch {
    return false;
  }
}
function savedTheme(): 'light' | 'dark' {
  try { return localStorage.getItem('lct-theme-v1') === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}
type ActivityPage = { items: Activity[]; total: number; offset: number; limit: number };
type ApiCall = <T,>(path: string, init?: RequestInit) => Promise<T>;
type ReportRow = {
  activityId: string; kind: Kind; kindLabel: string; title: string; stageLabel: string | null; ownerName: string;
  organizationName: string | null; personName: string | null; originLabel: string; createdAt: string; closed: boolean;
  productNames: string[]; requestedPlaces: number | null; enrollmentFactCount: number; learningStartedFactCount: number; learningCompletedFactCount: number;
};
type ReportMetric = {
  key: string; label: string; value: number | null; unit: string; definition: string; source: string; completeness: string;
  timeScope: 'selected_activity_creation_period' | 'selected_activities_all_available_fact_times' | 'not_calculated';
  grouping: 'activity' | 'learning_fact_event' | 'not_calculated'; lastFactOccurredAt: string | null; sourceReceivedAt: string | null;
};
const REPORT_METRIC_TIME_SCOPE_LABEL: Record<ReportMetric['timeScope'], string> = {
  selected_activity_creation_period: 'Даты создания активностей среза',
  selected_activities_all_available_fact_times: 'Все доступные времена фактов по активностям среза',
  not_calculated: 'Не рассчитывается',
};
const REPORT_METRIC_GROUPING_LABEL: Record<ReportMetric['grouping'], string> = {
  activity: 'Активность CRM',
  learning_fact_event: 'Событие учебного факта',
  not_calculated: 'Не рассчитывается',
};
type ReportSnapshot = {
  snapshotId: string; reportId: 'crm_portfolio' | 'demand_learning'; dataProfile: string; title: string; asOf: string;
  rowCount: number; page: number; pageSize: number; rows: ReportRow[]; metrics: ReportMetric[];
  filters: { from?: string; to?: string; kind?: string; ownerSub?: string; organizationId?: string; organizationName?: string; productId?: string; programId?: string; learningFactKind?: string; requestedPlacesRecorded?: boolean; includeClosed: boolean };
  chart: ReportChart; charts: ReportChart[]; sources: string[]; notes: string[];
};
type ReportChart = { id: string; title: string; unit: string; series: { label: string; value: number; filter?: { kind?: string; productId?: string; learningFactKind?: string; requestedPlacesRecorded?: boolean } }[] };
type ReportExport = { id: string; reportId: string; format: string; rowCount: number; status: 'queued' | 'running' | 'completed' | 'failed' | 'expired'; fileName: string | null; downloadUrl: string | null; errorMessage: string | null; createdAt: string };
type ReportExportColumn = { key: string; label: string };
type ReportOrganization = { organizationId: string; organizationName: string };
type ReadyReport = { exportColumns: ReportExportColumn[] };

function mergeReportExports(current: ReportExport[], incoming: ReportExport[]) {
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) byId.set(job.id, job);
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 20);
}

const REPORT_EXPORT_STATUS_LABEL: Record<ReportExport['status'], string> = {
  queued: 'В очереди', running: 'Формируем файл', completed: 'Готово', failed: 'Ошибка', expired: 'Истёк срок хранения',
};
type ActivityDocument = { id: string; activityId: string; name: string; extension: string; mediaType: string; sizeBytes: number; sha256: string; uploadedAt: string; uploadedByName: string };
type ContractStatus = 'draft' | 'signed' | 'ended' | 'unknown';
type LicenseExpiryPrecision = 'exact_date' | 'year' | 'unknown';
type ActivityContractLicenseFields = {
  title: string; contractReference: string | null; contractStatus: ContractStatus | null;
  licenseExpiryPrecision: LicenseExpiryPrecision | null; licenseExpiresOn: string | null; licenseExpiresYear: number | null;
  documentId: string | null; note: string | null;
};
type ActivityContractLicense = ActivityContractLicenseFields & {
  id: string; activityId: string; documentName: string | null; revision: number; updatedAt: string; updatedBy: string; readOnly: boolean;
};
type Event = { id: string; eventType: string; summary: string; actorSub: string; actorName: string; createdAt: string; details: Record<string, unknown> };
type Catalog = { organizations: { id: string; name: string; segment: string }[]; products: Product[]; workflows: Workflow[] };
type ImportedContact = { id: string; fullName: string; email: string | null; phone: string | null; organizationName: string | null };
type ManagerOverview = {
  asOf: string;
  metrics: { totalOpen: number; byKind: { university: number; corporate: number; individual: number }; overdue: number; awaitingReply: number; noNextStep: number };
  byOwner: { ownerSub: string; ownerName: string; open: number; overdue: number }[];
  topProducts: { id: string; name: string; activityCount: number }[];
  pipeline: { kind: Kind; routeVersion: 'legacy' | 'v2' | 'current'; routeLabel: string; stages: { key: string; label: string; stageKeys: string[]; count: number; oldestUpdatedAt: string | null }[] }[];
  definitions: Record<string, string>;
};
type ManagerKam = { sub: string; name: string };
type ReassignmentImpact = {
  stageKey: string; stageLabel: string; closed: boolean; awaitingReply: boolean; createdAt: string;
  historyEventCount: number; taskCount: number; openTaskCount: number; nextOpenTaskDueAt: string | null;
  openTasksWillTransfer: boolean; completedTaskAttributionWillRemain: boolean;
};
type ReassignmentPreview = {
  activityId: string; title: string; kind: Kind; currentOwner: { sub: string; name: string };
  targetOwner: { sub: string; name: string }; assignmentRevision: number; updatedAt: string;
  canConfirm: boolean; previewToken: string | null; blockers: { code: string; message: string }[]; impact: ReassignmentImpact;
};
type ReassignmentResult = {
  activityId: string; owner: { sub: string; name: string }; assignmentRevision: number;
  openTasksReassigned: number; completedTasksPreserved: number;
};
type GuidanceFeedback = { action: 'defer' | 'reject'; reason: string | null; deferredUntil: string | null; updatedAt: string; active: boolean };
type GuidanceArticle = { title: string; summary: string; focus: string; checks: string[]; boundary: string; draftMessage: string; recommendationWhenNoOpenTask?: string };
type ActivityGuidance = {
  kind: Kind; stageKey: string; stageLabel: string;
  metadata: { source: string; version: string; reviewDate: string; projectStatus: 'provisional'; statusLabel: string };
  article: GuidanceArticle;
  tip: { recommendationKey: string; recommendation: string; whyNow: string };
  feedback: GuidanceFeedback | null;
};
type GuidanceEditorialArticle = Required<GuidanceArticle>;
type GuidanceHandbookItem = {
  id: string; kind: Kind; stageKey: string; stageLabel: string; current: boolean; state: 'published' | 'seed' | 'draft' | 'stale' | 'missing';
  staleReason: string | null; article: GuidanceArticle | null; draftArticle?: GuidanceEditorialArticle | null; draftRevision?: number;
  publishedRevision?: number | null; publishedAt?: string | null; publishedByName?: string | null; draftStageCurrent?: boolean;
};
type UniversityStepStatus = 'unrecorded' | 'in_progress' | 'waiting' | 'documented' | 'not_applicable';
type UniversityStep = {
  stepId: string; label: string; description: string; groupKey: string; groupLabel: string; ordinal: number; optional: boolean;
  status: UniversityStepStatus; note: string; evidenceReference: string | null; evidenceSource: string | null;
  actorSub: string | null; actorName: string | null; updatedAt: string | null; revision: number;
};
type UniversityStepOverview = {
  statusCounts: Record<UniversityStepStatus, number>;
  openTaskCount: number; openTasks: { id: string; title: string; dueAt: string; ownerName: string }[];
  latestEvent: { id: string; eventType: string; summary: string; actorName: string; createdAt: string } | null;
};
type UniversitySteps = { steps: UniversityStep[]; overview: UniversityStepOverview; readOnly: boolean };
type LearningFact = { id: string; factKind: 'enrollment' | 'learning_started' | 'learning_completed'; source: string; occurredAt: string; reference: string };
type ExchangeJob = {
  id: string; direction: 'cms_to_crm' | 'crm_to_cms' | 'crm_to_lms' | 'lms_to_crm'; system: 'cms' | 'lms'; operation: string;
  activityId: string | null; correlationId: string; idempotencyKey: string; externalEventId: string | null;
  status: 'queued' | 'sent' | 'accepted' | 'performed' | 'rejected' | 'retryable_error'; attemptCount: number;
  payload: Record<string, unknown>; response: Record<string, unknown> | null; lastError: string | null; createdAt: string; updatedAt: string;
};
type ExchangeMonitorJob = Pick<ExchangeJob, 'id' | 'direction' | 'system' | 'operation' | 'status' | 'attemptCount' | 'createdAt' | 'updatedAt'> & {
  activityId?: string | null; activityLinked?: boolean; correlationId?: string; externalEventId?: string | null; lastError?: string | null; error?: boolean; canRetry?: boolean;
};
type ExchangeMonitor = { mode: 'mock'; services: { cms: Record<string, unknown>; lms: Record<string, unknown> }; jobs: ExchangeMonitorJob[]; retryLimit: number };
type AdminImportSummary = {
  counts: { byStatus: Record<'uploaded' | 'preview_ready' | 'completed' | 'expired', number>; byTarget: Record<'contacts' | 'vendors' | 'individual_applications', number>; previewRowsRequiringResolution: number };
  recentJobs: { id: string; target: 'contacts' | 'vendors' | 'individual_applications'; status: 'uploaded' | 'preview_ready' | 'completed' | 'expired'; created_at: string; expires_at: string; previewRowsRequiringResolution: number }[];
};
type CmsIntake = { id: string; kind: Kind; title: string; originReference: string; intakeOwner: string; personName?: string; organizationName?: string; createdAt: string };
type UniversityStepInput = { status: Exclude<UniversityStepStatus, 'unrecorded'>; note: string; evidenceReference: string | null; evidenceSource: string | null; expectedRevision: number };
type CorrectionReturnInput = { expectedU04Revision: number; expectedU05Revision: number; note: string; evidenceReference: string | null; evidenceSource: string | null };
type CorporatePlan = {
  programMode: 'standard' | 'adapted' | 'new' | 'undecided'; requestedPlaces: number | null;
  brief: { expectedOutcome: string | null; audience: string | null; entryLevel: string | null; deliveryFormat: string | null; volume: string | null; technologyContext: string | null };
  methodologist: { name: string | null; feasibility: 'unassessed' | 'feasible' | 'feasible_with_changes' | 'not_feasible'; note: string | null };
  proposed: { scope: string | null; startDate: string | null; endDate: string | null; acceptanceCriteria: string | null };
  agreed: { scope: string | null; startDate: string | null; endDate: string | null; acceptanceCriteria: string | null };
  approval: { status: 'not_recorded' | 'pending' | 'approved' | 'rejected'; evidenceReference: string | null; evidenceSource: string | null; note: string | null };
  revision: number; updatedAt: string | null; updatedBy: string | null; readOnly: boolean;
};
type CorporatePlanInput = Omit<CorporatePlan, 'revision' | 'updatedAt' | 'updatedBy' | 'readOnly'> & { expectedRevision: number };

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'all', label: 'Все сегменты' }, { key: 'university', label: 'Вузы' },
  { key: 'company', label: 'Компании' }, { key: 'individual', label: 'Физлица' },
];
const COLLECTIONS: { key: Collection; label: string }[] = [
  { key: 'today', label: 'Сегодня · МСК' }, { key: 'overdue', label: 'Просрочено' },
  { key: 'awaiting_reply', label: 'Ожидаю ответа' }, { key: 'no_next_step', label: 'Без следующего шага' },
  { key: 'all', label: 'Все активности' },
];
const KIND_LABEL: Record<Kind, string> = { university: 'Вуз', individual: 'Физлицо', corporate: 'Компания' };
const INDIVIDUAL_ROUTE_STAGES = {
  v2: ['request', 'consultation', 'conditions', 'lms_handoff', 'exceptions', 'result'],
  legacy: ['request', 'consultation', 'enrollment', 'learning', 'closed'],
} as const;
const PROCESS_LABEL: Record<Kind, string> = {
  university: 'Партнёрства с вузами', individual: 'Индивидуальное обучение', corporate: 'Корпоративное обучение',
};
const OUTCOMES = [
  ['connected', 'Связались'], ['no_answer', 'Не ответил'], ['meeting_booked', 'Договорились о встрече'],
  ['awaiting_reply', 'Ожидаю ответ'], ['not_interested', 'Не актуально'], ['other', 'Другое'],
  ['cancelled', 'Отменено'], ['refused', 'Отказ'],
];
const EXCHANGE_STATUS: Record<ExchangeJob['status'], string> = {
  queued: 'В очереди', sent: 'Отправлено', accepted: 'Принято источником',
  performed: 'Выполнено источником', rejected: 'Отклонено источником', retryable_error: 'Техническая ошибка · можно повторить',
};
const EXCHANGE_DIRECTION: Record<ExchangeJob['direction'], string> = {
  cms_to_crm: 'CMS → CRM', crm_to_cms: 'CRM → CMS', crm_to_lms: 'CRM → LMS', lms_to_crm: 'LMS → CRM',
};
const EXCHANGE_OPERATION_LABEL: Record<string, string> = {
  prepare_access: 'Подготовка доступа',
  return_status: 'Передача статуса обработки',
  pull_inquiries: 'Получение обращений',
  pull_learning_facts: 'Получение учебных фактов',
  receive_learning_fact: 'Получение учебного факта',
};
const exchangeOperationLabel = (operation: string) => EXCHANGE_OPERATION_LABEL[operation] ?? `Техническая операция: ${operation.replaceAll('_', ' ')}`;
const outcomeLabel = (event: Event) => {
  if (event.eventType === 'university_step_updated') return 'Обновлено состояние пункта партнёрства';
  if (event.eventType === 'university_correction_return') return 'Записан возврат документов на корректировку';
  if (event.eventType === 'corporate_plan_updated') return 'План корпоративной программы обновлён';
  if (event.eventType !== 'outcome_recorded' || typeof event.details?.outcome !== 'string') return event.summary;
  const label = OUTCOMES.find(([key]) => key === event.details.outcome)?.[1];
  return label ? `Итог контакта: ${label}` : event.summary;
};
const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function useApi(token: Token) {
  return async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const accessToken = await token();
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${accessToken}`, ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
    const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      const errorDetails = body?.error;
      const message = response.status === 403
        ? 'Доступ к этому разделу ограничен. Обратитесь к администратору CRM.'
        : body?.message ?? errorDetails?.message ?? 'Не удалось выполнить действие.';
      const error = new Error(message) as Error & { status: number; code?: string };
      error.status = response.status;
      error.code = body?.code ?? errorDetails?.code;
      throw error;
    }
    return body as T;
  };
}

function isActivityAccessRevoked(reason: unknown): boolean {
  const status = (reason as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

function formatDate(value?: string) {
  if (!value) return 'Без срока';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(value));
}

function contactOptionLabel(contact: ImportedContact) {
  const details = [contact.email, contact.phone].filter((value): value is string => Boolean(value));
  return details.length ? `${contact.fullName} · ${details.join(' · ')}` : contact.fullName;
}

function defaultDueAt() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

function moscowDateTimeToIso(value: string) {
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const moscowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(localAsUtc));
  const moscowValue = Object.fromEntries(moscowParts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(Number(moscowValue.year), Number(moscowValue.month) - 1, Number(moscowValue.day), Number(moscowValue.hour), Number(moscowValue.minute));
  return new Date(localAsUtc - (representedAsUtc - localAsUtc)).toISOString();
}

export function App({ token, user, logout }: { token: Token; user: User; logout: () => void }) {
  const api = useMemo(() => useApi(token), [token]);
  const roles = user.realm_access?.roles ?? [];
  const hasManagerAccess = roles.includes('manager');
  const hasAdminAccess = roles.includes('admin');
  const hasKamAccess = roles.includes('kam');
  const hasQueueAccess = hasManagerAccess || hasKamAccess;
  const isTechnicalAdminOnly = hasAdminAccess && !hasManagerAccess && !hasKamAccess;
  const hasCrmWorkspaceAccess = hasQueueAccess || hasAdminAccess;
  const roleScope = ['manager', 'admin', 'kam'].filter((role) => roles.includes(role)).join('|');
  const importScope = `${user.sub ?? user.preferred_username ?? 'session'}:${['admin', 'manager', 'kam'].filter((role) => roles.includes(role)).join('|')}`;
  const roleScopeRef = useRef(roleScope);
  const [activeView, setActiveView] = useState<'queue' | 'activities' | 'manager' | 'dashboard' | 'reports' | 'import' | 'exchange' | 'cms-intake' | 'workflow' | 'users' | 'handbook' | 'feed' | 'notifications'>(() => hasManagerAccess ? 'manager' : isTechnicalAdminOnly ? 'exchange' : 'queue');
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(savedSidebarCollapsed);
  const [theme, setTheme] = useState<'light' | 'dark'>(savedTheme);
  const [segment, setSegment] = useState<Segment>(() => savedQueueState().segment ?? 'all');
  const [collection, setCollection] = useState<Collection>(() => savedQueueState().collection ?? 'all');
  const [searchInput, setSearchInput] = useState(() => savedQueueState().search?.slice(0, 120) ?? '');
  const [queueSearch, setQueueSearch] = useState(() => savedQueueState().search?.slice(0, 120).trim() ?? '');
  const [drilldown, setDrilldown] = useState<QueueDrilldown>(null);
  const queueFilters = useRef({ segment, collection, search: queueSearch, drilldown });
  const [list, setList] = useState<Activity[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const queueRequestVersion = useRef(0);
  const detailRouteVersion = useRef(0);
  const detailRequestVersion = useRef(0);
  const [catalog, setCatalog] = useState<Catalog>({ organizations: [], products: [], workflows: [] });
  const [contacts, setContacts] = useState<ImportedContact[]>([]);
  const [selected, setSelected] = useState<Activity | null>(null);
  const [history, setHistory] = useState<Event[]>([]);
  const [documents, setDocuments] = useState<ActivityDocument[]>([]);
  const [contractLicenses, setContractLicenses] = useState<ActivityContractLicense[]>([]);
  const [universitySteps, setUniversitySteps] = useState<UniversitySteps | null>(null);
  const [learningFacts, setLearningFacts] = useState<LearningFact[]>([]);
  const [exchangeJobs, setExchangeJobs] = useState<ExchangeJob[]>([]);
  const [corporatePlan, setCorporatePlan] = useState<CorporatePlan | null>(null);
  const [guidance, setGuidance] = useState<ActivityGuidance | null>(null);
  const [guidanceError, setGuidanceError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [managerOverview, setManagerOverview] = useState<ManagerOverview | null>(null);
  const [managerLoading, setManagerLoading] = useState(false);
  const [overviewReloadKey, setOverviewReloadKey] = useState(0);
  const [managerKams, setManagerKams] = useState<ManagerKam[]>([]);
  const [exchangeMonitor, setExchangeMonitor] = useState<ExchangeMonitor | null>(null);
  const [adminImportSummary, setAdminImportSummary] = useState<AdminImportSummary | null>(null);
  const [exchangeLoading, setExchangeLoading] = useState(false);
  const [exchangeReloadKey, setExchangeReloadKey] = useState(0);
  const [cmsIntake, setCmsIntake] = useState<CmsIntake[]>([]);
  const [cmsIntakeLoading, setCmsIntakeLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const unsavedDetailSections = useRef(new Set<string>());
  const detailDraftRevision = useRef(0);
  const confirmedDiscardRefresh = useRef(false);
  const [detailDraftResetVersion, setDetailDraftResetVersion] = useState(0);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const mobileMoreRef = useRef<HTMLDivElement>(null);
  const mobileMoreTriggerRef = useRef<HTMLButtonElement>(null);
  const userLabel = user.name ?? user.preferred_username ?? 'Команда CRM';

  useLayoutEffect(() => { prepareImportSession(importScope); }, [importScope]);

  useEffect(() => {
    try {
      localStorage.setItem('lct-sidebar-collapsed-v1', String(sidebarCollapsed));
    } catch {
      // The preference is optional; keep the current in-memory state if storage is unavailable.
    }
  }, [sidebarCollapsed]);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem('lct-theme-v1', theme); } catch { /* Optional local preference. */ }
  }, [theme]);

  function isCurrentRoleScope(scope = roleScope) { return roleScopeRef.current === scope; }

  async function refreshList(offset = 0, append = false, requestVersion = queueRequestVersion.current): Promise<ActivityPage> {
    const scope = roleScope;
    if (!hasQueueAccess || !isCurrentRoleScope(scope)) return { items: [], total: 0, offset, limit: 50 };
    if (append) setLoadingMore(true); else setListLoading(true);
    const query = new URLSearchParams({ segment, collection, offset: String(offset), limit: '50' });
    if (queueSearch) query.set('q', queueSearch);
    if (drilldown?.ownerSub) query.set('ownerSub', drilldown.ownerSub);
    if (drilldown?.productId) query.set('productId', drilldown.productId);
    if (drilldown?.stageKeys?.length) query.set('stageKeys', drilldown.stageKeys.join(','));
    if (drilldown?.routeVersion) query.set('routeVersion', drilldown.routeVersion);
    try {
      const page = await api<ActivityPage>(`/api/activities?${query.toString()}`);
      if (requestVersion === queueRequestVersion.current && isCurrentRoleScope(scope)) {
        setList((current) => append ? [...current, ...page.items] : page.items);
        setListTotal(page.total);
      }
      return page;
    } finally {
      if (requestVersion === queueRequestVersion.current && isCurrentRoleScope(scope)) {
        if (append) setLoadingMore(false); else setListLoading(false);
      }
    }
  }
  async function refreshLoadedQueue() {
    const scope = roleScope;
    if (!hasQueueAccess || !isCurrentRoleScope(scope)) return;
    const requestVersion = queueRequestVersion.current;
    const previousLength = list.length;
    const firstPage = await refreshList(0, false, requestVersion);
    let loaded = firstPage.items.length;
    while (requestVersion === queueRequestVersion.current && isCurrentRoleScope(scope) && loaded < previousLength && loaded < firstPage.total) {
      const nextPage = await refreshList(loaded, true, requestVersion);
      if (!nextPage.items.length) break;
      loaded += nextPage.items.length;
    }
  }
  async function refreshManagerOverview() {
    const scope = roleScope;
    if (!hasManagerAccess || !isCurrentRoleScope(scope)) return;
    setManagerLoading(true);
    try {
      const overview = await api<ManagerOverview>('/api/manager/overview');
      if (isCurrentRoleScope(scope)) setManagerOverview(overview);
    } finally { if (isCurrentRoleScope(scope)) setManagerLoading(false); }
  }
  function beginDetailNavigation() {
    detailRouteVersion.current += 1;
    detailRequestVersion.current += 1;
    return detailRouteVersion.current;
  }
  function closeRevokedDetail(id: string, routeVersion: number) {
    if (routeVersion !== detailRouteVersion.current || selected?.id !== id) return;
    beginDetailNavigation();
    unsavedDetailSections.current.clear();
    detailDraftRevision.current += 1;
    setDetailDraftResetVersion((version) => version + 1);
    setSelected(null); setHistory([]); setDocuments([]); setContractLicenses([]); setUniversitySteps(null);
    setLearningFacts([]); setExchangeJobs([]); setCorporatePlan(null); setGuidance(null); setGuidanceError('');
    setActiveView(activeView === 'activities' ? 'activities' : 'queue');
    setError(`Доступ к активности изменился. Карточка закрыта; ${activeView === 'activities' ? 'общий список активностей' : 'рабочая очередь'} обновляется.`);
    setList((items) => items.filter((item) => item.id !== id));
    const queueVersion = ++queueRequestVersion.current;
    void refreshList(0, false, queueVersion).catch(() => {
      // The restricted detail is already removed; the user can retry the queue refresh.
    });
  }
  function confirmDetailExit() {
    if (!unsavedDetailSections.current.size) return true;
    if (!window.confirm('Есть несохранённые изменения. Нажмите «Отмена», чтобы остаться и сохранить их, или «ОК», чтобы отбросить.')) return false;
    unsavedDetailSections.current.clear();
    detailDraftRevision.current += 1;
    return true;
  }
  function updateDetailDirty(section: string, dirty: boolean) {
    if (dirty) {
      unsavedDetailSections.current.add(section);
      if (!confirmedDiscardRefresh.current) detailDraftRevision.current += 1;
    }
    else unsavedDetailSections.current.delete(section);
  }
  async function refreshCurrentDetail(id: string) {
    if (busy) return;
    const hadUnsavedChanges = unsavedDetailSections.current.size > 0;
    if (hadUnsavedChanges && !window.confirm('Есть несохранённые изменения. Нажмите «Отмена», чтобы остаться и сохранить их, или «ОК», чтобы отбросить.')) return;
    const draftRevision = detailDraftRevision.current;
    const routeVersion = detailRouteVersion.current;
    confirmedDiscardRefresh.current = hadUnsavedChanges;
    try {
      await run(async () => {
        const refreshed = await refreshDetail(id, routeVersion);
        if (!refreshed || !hadUnsavedChanges || routeVersion !== detailRouteVersion.current || detailDraftRevision.current !== draftRevision) return;
        unsavedDetailSections.current.clear();
        detailDraftRevision.current += 1;
        setDetailDraftResetVersion((version) => version + 1);
      });
    } finally {
      confirmedDiscardRefresh.current = false;
    }
  }
  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsavedDetailSections.current.size) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, []);
  function leaveDetail() {
    if (!confirmDetailExit()) return false;
    beginDetailNavigation();
    setSelected(null);
    return true;
  }
  async function refreshAfterReassignment(id: string, routeVersion: number) {
    const refreshes: Promise<unknown>[] = [refreshDetail(id, routeVersion), refreshLoadedQueue()];
    if (hasManagerAccess) refreshes.push(refreshManagerOverview());
    await Promise.all(refreshes);
  }
  async function confirmReassignment(id: string, previewToken: string, routeVersion: number): Promise<ReassignmentResult> {
    const scope = roleScope;
    if (!hasManagerAccess || !isCurrentRoleScope(scope)) throw new Error('Область доступа изменилась. Обновите экран.');
    setBusy(true);
    setError('');
    try {
      const result = await api<ReassignmentResult>(`/api/manager/activities/${id}/reassignment/confirm`, {
        method: 'POST', body: JSON.stringify({ previewToken }),
      });
      if (!isCurrentRoleScope(scope)) return result;
      // The transfer is already saved if a subsequent refresh fails, so keep that success visible.
      try { await refreshAfterReassignment(id, routeVersion); }
      catch (reason) { if (isCurrentRoleScope(scope)) setError(`Передача выполнена, но обновить карточку не удалось. ${reason instanceof Error ? reason.message : 'Обновите карточку вручную.'}`); }
      if (!isCurrentRoleScope(scope)) return result;
      setNotice(`Ответственный изменён: ${result.owner.name}.`);
      return result;
    } finally { if (isCurrentRoleScope(scope)) setBusy(false); }
  }
  async function refreshExchangeMonitor() {
    const scope = roleScope;
    if (!hasAdminAccess || !isCurrentRoleScope(scope)) return;
    setExchangeLoading(true);
    try {
      const [monitor, imports] = await Promise.all([
        api<ExchangeMonitor>('/api/admin/exchanges'),
        api<AdminImportSummary>('/api/admin/imports/summary'),
      ]);
      if (isCurrentRoleScope(scope)) { setExchangeMonitor(monitor); setAdminImportSummary(imports); }
    } finally { if (isCurrentRoleScope(scope)) setExchangeLoading(false); }
  }
  async function refreshCmsIntake() {
    const scope = roleScope;
    if (!hasKamAccess || !isCurrentRoleScope(scope)) return;
    setCmsIntakeLoading(true);
    try {
      const intake = await api<CmsIntake[]>('/api/cms-mock/intake');
      if (isCurrentRoleScope(scope)) setCmsIntake(intake);
    } finally { if (isCurrentRoleScope(scope)) setCmsIntakeLoading(false); }
  }
  async function refreshAfterImport() {
    const scope = roleScope;
    if (!hasManagerAccess || !isCurrentRoleScope(scope)) return;
    const refreshes: Promise<unknown>[] = [
      refreshLoadedQueue(),
      api<Catalog>('/api/catalog').then((value) => { if (isCurrentRoleScope(scope)) setCatalog(value); }),
      api<ImportedContact[]>('/api/contacts').then((value) => { if (isCurrentRoleScope(scope)) setContacts(value); }),
    ];
    if (hasManagerAccess) refreshes.push(refreshManagerOverview());
    await Promise.all(refreshes);
  }
  async function refreshDetail(id: string, routeVersion = detailRouteVersion.current): Promise<boolean> {
    const scope = roleScope;
    if (!hasQueueAccess || !isCurrentRoleScope(scope)) return false;
    const requestVersion = ++detailRequestVersion.current;
    const mayUpdateRoute = () => isCurrentRoleScope(scope) && routeVersion === detailRouteVersion.current && requestVersion === detailRequestVersion.current;
    let detail: Activity;
    try {
      detail = await api<Activity>(`/api/activities/${id}`);
    } catch (reason) {
      if (isActivityAccessRevoked(reason)) closeRevokedDetail(id, routeVersion);
      throw reason;
    }
    if (!mayUpdateRoute()) return false;
    let related;
    try {
      related = await Promise.all([
        api<Event[]>(`/api/activities/${id}/history`), api<Catalog>('/api/catalog'),
        detail.kind === 'university' ? api<UniversitySteps>(`/api/activities/${id}/university-steps`) : Promise.resolve(null),
        detail.kind === 'individual' ? api<LearningFact[]>(`/api/activities/${id}/learning-facts`) : Promise.resolve([]),
        detail.kind === 'corporate' ? api<CorporatePlan>(`/api/activities/${id}/corporate-plan`) : Promise.resolve(null),
        api<ActivityDocument[]>(`/api/activities/${id}/documents`),
        api<ActivityContractLicense[]>(`/api/activities/${id}/contract-licenses`),
        api<ExchangeJob[]>(`/api/activities/${id}/exchanges`),
      ] as const);
    } catch (reason) {
      if (isActivityAccessRevoked(reason)) closeRevokedDetail(id, routeVersion);
      throw reason;
    }
    const [events, freshCatalog, freshUniversitySteps, freshLearningFacts, freshCorporatePlan, freshDocuments, freshContractLicenses, freshExchangeJobs] = related;
    let freshGuidance: ActivityGuidance | null = null;
    let freshGuidanceError = '';
    try {
      freshGuidance = await api<ActivityGuidance>(`/api/activities/${id}/guidance`);
    } catch (reason) {
      freshGuidanceError = reason instanceof Error ? reason.message : 'Инструкция для этой стадии недоступна.';
    }
    if (!mayUpdateRoute()) return false;
    setSelected(detail); setHistory(events); setDocuments(freshDocuments); setContractLicenses(freshContractLicenses); setCatalog(freshCatalog); setUniversitySteps(freshUniversitySteps);
    setLearningFacts(freshLearningFacts); setCorporatePlan(freshCorporatePlan);
    setExchangeJobs(freshExchangeJobs);
    setGuidance(freshGuidance); setGuidanceError(freshGuidanceError);
    return true;
  }
  useEffect(() => {
    if (!selected || !hasQueueAccess) return;
    const id = selected.id;
    const routeVersion = detailRouteVersion.current;
    let checking = false;
    const recheckAccess = async () => {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        await api<Activity>(`/api/activities/${id}`);
      } catch (reason) {
        if (isActivityAccessRevoked(reason)) closeRevokedDetail(id, routeVersion);
      } finally {
        checking = false;
      }
    };
    window.addEventListener('focus', recheckAccess);
    document.addEventListener('visibilitychange', recheckAccess);
    const interval = window.setInterval(recheckAccess, 15_000);
    return () => {
      window.removeEventListener('focus', recheckAccess);
      document.removeEventListener('visibilitychange', recheckAccess);
      window.clearInterval(interval);
    };
  }, [selected?.id, roleScope]);
  useEffect(() => {
    if (roleScopeRef.current === roleScope) return;
    roleScopeRef.current = roleScope;
    queueRequestVersion.current += 1;
    beginDetailNavigation();
    unsavedDetailSections.current.clear();
    localStorage.removeItem('lct-queue-v1');
    sessionStorage.removeItem('lct-queue-scroll');
    sessionStorage.removeItem('lct-activities-scroll');
    sessionStorage.removeItem('lct-report-snapshot-v1');
    sessionStorage.removeItem('lct-report-page-v1');
    clearStoredImportDraft();
    setActiveView(hasManagerAccess ? 'manager' : isTechnicalAdminOnly ? 'exchange' : 'queue');
    setSegment('all'); setCollection('all'); setSearchInput(''); setQueueSearch(''); setDrilldown(null);
    queueFilters.current = { segment: 'all', collection: 'all', search: '', drilldown: null };
    setList([]); setListTotal(0); setListLoading(false); setLoadingMore(false);
    setCatalog({ organizations: [], products: [], workflows: [] }); setContacts([]);
    setSelected(null); setHistory([]); setDocuments([]); setContractLicenses([]); setUniversitySteps(null); setLearningFacts([]); setExchangeJobs([]);
    setCorporatePlan(null); setGuidance(null); setGuidanceError(''); setShowCreate(false);
    setManagerOverview(null); setManagerLoading(false); setManagerKams([]);
    setExchangeMonitor(null); setAdminImportSummary(null); setExchangeLoading(false); setCmsIntake([]); setCmsIntakeLoading(false);
    setBusy(false); setError(''); setNotice('');
    setOverviewReloadKey((key) => key + 1); setExchangeReloadKey((key) => key + 1);
  }, [roleScope, hasManagerAccess, isTechnicalAdminOnly]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setQueueSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);
  useEffect(() => {
    if (!hasQueueAccess) {
      queueRequestVersion.current += 1;
      setList([]); setListTotal(0); setListLoading(false); setLoadingMore(false);
      return;
    }
    const scope = roleScope;
    if (activeView === 'queue') {
      queueFilters.current = { segment, collection, search: queueSearch, drilldown };
      localStorage.setItem('lct-queue-v1', JSON.stringify({ segment, collection, search: queueSearch }));
    }
    setError('');
    setList([]); setListTotal(0); setLoadingMore(false);
    const requestVersion = ++queueRequestVersion.current;
    refreshList(0, false, requestVersion).catch((reason: Error) => { if (isCurrentRoleScope(scope)) setError(reason.message); });
  }, [segment, collection, drilldown, queueSearch, hasQueueAccess, roleScope, activeView]);
  useEffect(() => {
    if (!hasQueueAccess) { setCatalog({ organizations: [], products: [], workflows: [] }); setContacts([]); return; }
    const scope = roleScope;
    let current = true;
    Promise.all([api<Catalog>('/api/catalog'), api<ImportedContact[]>('/api/contacts')]).then(([freshCatalog, freshContacts]) => {
      if (current && isCurrentRoleScope(scope)) { setCatalog(freshCatalog); setContacts(freshContacts); }
    }).catch((reason: Error) => { if (current && isCurrentRoleScope(scope)) setError(reason.message); });
    return () => { current = false; };
  }, [api, hasQueueAccess, roleScope]);
  useEffect(() => {
    if (!roles.includes('manager')) { setManagerKams([]); return; }
    let current = true;
    const scope = roleScope;
    api<ManagerKam[]>('/api/manager/kams').then((kams) => { if (current && isCurrentRoleScope(scope)) setManagerKams(kams); })
      .catch((reason: Error) => { if (current && isCurrentRoleScope(scope)) setError(reason.message); });
    return () => { current = false; };
  }, [api, roles.join(','), roleScope]);
  useEffect(() => {
    const scope = roleScope;
    if (hasManagerAccess && activeView === 'manager') {
      refreshManagerOverview().catch((reason: Error) => { if (isCurrentRoleScope(scope)) setError(reason.message); });
    }
  }, [api, activeView, hasManagerAccess, overviewReloadKey, roleScope]);
  useEffect(() => {
    const scope = roleScope;
    if (hasAdminAccess && activeView === 'exchange') refreshExchangeMonitor().catch((reason: Error) => { if (isCurrentRoleScope(scope)) setError(reason.message); });
  }, [api, activeView, hasAdminAccess, exchangeReloadKey, roleScope]);
  useEffect(() => {
    const scope = roleScope;
    if (hasKamAccess && activeView === 'cms-intake') refreshCmsIntake().catch((reason: Error) => { if (isCurrentRoleScope(scope)) setError(reason.message); });
  }, [api, activeView, hasKamAccess, roleScope]);
  useEffect(() => {
    if (!hasQueueAccess) { setUnreadNotifications(0); return; }
    let live = true;
    const refreshCount = () => {
      if (document.hidden) return;
      api<{ unreadCount: number }>('/api/notifications?limit=1')
        .then((value) => { if (live) setUnreadNotifications(value.unreadCount); })
        .catch(() => { /* The notifications page shows the actionable error. */ });
    };
    refreshCount();
    const timer = window.setInterval(refreshCount, 30_000);
    document.addEventListener('visibilitychange', refreshCount);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshCount); };
  }, [api, hasQueueAccess, roleScope]);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(id);
  }, [notice]);

  async function run(action: () => Promise<void>, success?: string) {
    const scope = roleScope;
    setBusy(true); setError('');
    try { await action(); if (success && isCurrentRoleScope(scope)) setNotice(success); }
    catch (reason) { if (isCurrentRoleScope(scope)) setError(reason instanceof Error ? reason.message : 'Не удалось сохранить.'); }
    finally { if (isCurrentRoleScope(scope)) setBusy(false); }
  }

  async function openActivity(item: Activity) {
    if (!confirmDetailExit()) return;
    const routeVersion = beginDetailNavigation();
    await run(async () => { await refreshDetail(item.id, routeVersion); });
    document.querySelector('.page-scroll')?.scrollTo({ top: 0 });
  }

  async function navigateLoadedQueue(direction: -1 | 1) {
    const scope = roleScope;
    if (!hasQueueAccess || !isCurrentRoleScope(scope) || !selected) return;
    const currentIndex = list.findIndex((activity) => activity.id === selected.id);
    const neighbor = currentIndex >= 0 ? list[currentIndex + direction] : undefined;
    if (!neighbor) return;
    if (!confirmDetailExit()) return;
    const routeVersion = beginDetailNavigation();
    setError('');
    await run(async () => {
      if (!isCurrentRoleScope(scope)) return;
      await refreshDetail(neighbor.id, routeVersion);
      if (isCurrentRoleScope(scope) && routeVersion === detailRouteVersion.current) document.querySelector('.page-scroll')?.scrollTo({ top: 0 });
    });
  }

  async function createActivity(data: Record<string, unknown>) {
    const scope = roleScope;
    setBusy(true);
    setError('');
    try {
      const created = await api<Activity>('/api/activities', { method: 'POST', body: JSON.stringify(data) });
      if (!isCurrentRoleScope(scope)) return;
      setShowCreate(false);
      setNotice('Активность создана');
      setManagerOverview(null);
      setOverviewReloadKey((key) => key + 1);

      const refreshes = await Promise.allSettled([
        refreshLoadedQueue(), refreshDetail(created.id),
        api<ImportedContact[]>('/api/contacts').then((value) => { if (isCurrentRoleScope(scope)) setContacts(value); }),
      ]);
      if (!isCurrentRoleScope(scope)) return;
      if (refreshes.some((result) => result.status === 'rejected')) {
        setError('Активность создана, но экран не удалось полностью обновить. Обновите его вручную.');
      } else {
        document.querySelector('.page-scroll')?.scrollTo({ top: 0 });
      }
    } finally {
      if (isCurrentRoleScope(scope)) setBusy(false);
    }
  }

  async function mutateDetail(action: () => Promise<unknown>, message: string): Promise<boolean> {
    const scope = roleScope;
    if (!hasQueueAccess || !isCurrentRoleScope(scope) || !selected || selected.closed) return false;
    let saved = false;
    await run(async () => {
      await action();
      saved = true;
      if (!isCurrentRoleScope(scope)) return;
      await Promise.all([refreshDetail(selected.id), refreshLoadedQueue()]);
      if (!isCurrentRoleScope(scope) || !hasManagerAccess) return;
      setManagerOverview(null);
      setOverviewReloadKey((key) => key + 1);
    }, message);
    return saved;
  }

  async function runAdminExchange(action: () => Promise<unknown>, message: string) {
    await run(async () => {
      await action();
      await refreshExchangeMonitor();
      if (selected) await refreshDetail(selected.id);
    }, message);
  }

  async function transitionActivity(targetStage: string): Promise<boolean> {
    if (!selected || selected.closed) return false;
    if (unsavedDetailSections.current.size && !window.confirm('Есть несохранённые изменения. Нажмите «Отмена», чтобы остаться и сохранить их, или «ОК», чтобы выполнить переход и отбросить ввод.')) return false;
    const scope = roleScope;
    const activity = selected;
    let transitionSaved = false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/api/activities/${activity.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({
          targetStage,
          expectedStageKey: activity.stageKey,
          expectedWorkflowRevision: activity.workflowRevision ?? null,
        }),
      });
      transitionSaved = true;
      if (!isCurrentRoleScope(scope)) return transitionSaved;
      await Promise.all([refreshDetail(activity.id), refreshLoadedQueue()]);
      if (!isCurrentRoleScope(scope)) return transitionSaved;
      if (hasManagerAccess) { setManagerOverview(null); setOverviewReloadKey((key) => key + 1); }
      setNotice('Стадия изменена');
      return true;
    } catch (reason) {
      if (!isCurrentRoleScope(scope)) return transitionSaved;
      if (transitionSaved) {
        setError(`Переход сохранён, но карточку не удалось обновить. ${reason instanceof Error ? reason.message : 'Обновите карточку, чтобы увидеть текущую стадию.'}`);
      } else if ((reason as Error & { status?: number })?.status === 409) {
        const code = (reason as Error & { code?: string })?.code;
        const conflictReason = code === 'workflow_revision_conflict' || code === 'workflow_revision_required'
          ? 'Общая схема вузов изменилась.'
          : code === 'transition_stage_conflict'
            ? 'Стадия активности уже изменилась.'
            : code === 'activity_closed'
              ? 'Активность уже закрыта.'
              : 'Изменились стадия активности или разрешённые переходы.';
        try {
          await Promise.all([refreshDetail(activity.id), refreshLoadedQueue()]);
          if (!isCurrentRoleScope(scope)) return transitionSaved;
          setError(`Переход не выполнен: ${conflictReason} Карточка обновлена; проверьте текущую стадию и выберите разрешённый переход заново.`);
        } catch (refreshReason) {
          if (isCurrentRoleScope(scope)) setError(`Переход не выполнен из-за изменения стадии или маршрута, но карточку не удалось обновить. ${refreshReason instanceof Error ? refreshReason.message : 'Повторите обновление карточки.'}`);
        }
      } else setError(reason instanceof Error ? reason.message : 'Не удалось изменить стадию.');
      return transitionSaved;
    } finally {
      if (isCurrentRoleScope(scope)) setBusy(false);
    }
  }

  async function openExchangeActivity(activityId: string) {
    const scope = roleScope;
    if (!hasQueueAccess || !isCurrentRoleScope(scope)) return;
    if (!confirmDetailExit()) return;
    const routeVersion = beginDetailNavigation();
    setActiveView('queue');
    await run(async () => { await refreshDetail(activityId, routeVersion); });
  }

  async function openReportActivity(activityId: string) {
    if (!confirmDetailExit()) return;
    sessionStorage.setItem('lct-report-scroll-v1', String(document.querySelector('.page-scroll')?.scrollTop ?? 0));
    const routeVersion = beginDetailNavigation();
    await run(async () => { await refreshDetail(activityId, routeVersion); });
  }

  async function downloadActivityDocument(activityId: string, fileRecord: ActivityDocument) {
    const scope = roleScope;
    if (!hasQueueAccess || !isCurrentRoleScope(scope)) return;
    const accessToken = await token();
    if (!isCurrentRoleScope(scope)) return;
    const response = await fetch(`${API}/api/activities/${activityId}/documents/${fileRecord.id}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!isCurrentRoleScope(scope)) return;
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new Error(body?.message ?? 'Не удалось скачать документ.');
    }
    const blob = await response.blob();
    if (!isCurrentRoleScope(scope)) return;
    const href = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = href; link.download = fileRecord.name; link.rel = 'noopener';
    window.document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function goBack() {
    const returnView = activeView;
    if (!leaveDetail()) return;
    setError('');
    requestAnimationFrame(() => {
      document.getElementById(returnView === 'reports' ? 'reports-heading' : returnView === 'activities' ? 'activities-heading' : 'queue-heading')?.focus();
      if (returnView === 'reports') {
        document.querySelector('.page-scroll')?.scrollTo({ top: Number(sessionStorage.getItem('lct-report-scroll-v1') ?? 0) });
        return;
      }
      const mobile = window.matchMedia('(max-width: 900px)').matches;
      const scrollContainer = document.querySelector(mobile ? '.page-scroll' : '.queue-list');
      const scrollKey = returnView === 'activities' ? 'lct-activities-scroll' : 'lct-queue-scroll';
      scrollContainer?.scrollTo({ top: Number(sessionStorage.getItem(scrollKey) ?? 0) });
    });
  }

  function restoreListPosition(view: 'queue' | 'activities') {
    requestAnimationFrame(() => {
      const mobile = window.matchMedia('(max-width: 900px)').matches;
      const scrollContainer = document.querySelector(mobile ? '.page-scroll' : '.queue-list');
      const scrollKey = view === 'activities' ? 'lct-activities-scroll' : 'lct-queue-scroll';
      scrollContainer?.scrollTo({ top: Number(sessionStorage.getItem(scrollKey) ?? 0) });
    });
  }

  function goToQueue(nextSegment: Segment = 'all', nextCollection: Collection = 'all', nextDrilldown: QueueDrilldown = null, nextSearch = queueFilters.current.search) {
    if (!hasQueueAccess) return false;
    if (!leaveDetail()) return false;
    queueFilters.current = { segment: nextSegment, collection: nextCollection, search: nextSearch, drilldown: nextDrilldown };
    localStorage.setItem('lct-queue-v1', JSON.stringify({ segment: nextSegment, collection: nextCollection, search: nextSearch }));
    setActiveView('queue');
    setSegment(nextSegment);
    setCollection(nextCollection);
    setDrilldown(nextDrilldown);
    setSearchInput(nextSearch);
    setQueueSearch(nextSearch);
    setError('');
    restoreListPosition('queue');
    return true;
  }

  function goToSavedQueue() {
    if (activeView === 'queue') return goToQueue(segment, collection, drilldown, searchInput.trim());
    const filters = queueFilters.current;
    return goToQueue(filters.segment, filters.collection, filters.drilldown, filters.search);
  }

  function goToAllActivities() {
    if (!hasQueueAccess || !leaveDetail()) return false;
    if (activeView === 'queue') {
      queueFilters.current = { segment, collection, search: searchInput.trim(), drilldown };
      localStorage.setItem('lct-queue-v1', JSON.stringify({ segment, collection, search: searchInput.trim() }));
    }
    setActiveView('activities');
    setSegment('all');
    setCollection('all');
    setDrilldown(null);
    setSearchInput('');
    setQueueSearch('');
    setError('');
    restoreListPosition('activities');
    return true;
  }

  function navigateToMobileView(view: Exclude<typeof activeView, 'queue'>) {
    if ((view === 'cms-intake' && !hasKamAccess)
      || (view === 'dashboard' && !hasKamAccess)
      || ((view === 'feed' || view === 'notifications') && !hasQueueAccess)
      || ((view === 'manager' || view === 'reports' || view === 'import') && !hasManagerAccess)
      || ((view === 'exchange' || view === 'workflow' || view === 'users') && !hasAdminAccess)
      || (view === 'handbook' && !(hasQueueAccess || hasAdminAccess))) return false;
    if (!leaveDetail()) return false;
    setActiveView(view);
    if (view === 'manager') setOverviewReloadKey((key) => key + 1);
    if (view === 'exchange') setExchangeReloadKey((key) => key + 1);
    setError('');
    return true;
  }

  function selectMobileDestination(destination: { select: () => boolean }) {
    if (!destination.select()) return;
    setMobileMoreOpen(false);
    requestAnimationFrame(() => mobileMoreTriggerRef.current?.focus());
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.classList.contains('queue-list') || window.matchMedia('(max-width: 900px)').matches) {
      const scrollKey = activeView === 'activities' ? 'lct-activities-scroll' : 'lct-queue-scroll';
      sessionStorage.setItem(scrollKey, String(target.scrollTop));
    }
  }

  useEffect(() => {
    if (!mobileMoreOpen) return;
    mobileMoreRef.current?.querySelector<HTMLButtonElement>('[data-mobile-more-item]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!mobileMoreRef.current?.contains(event.target as Node)) setMobileMoreOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMobileMoreOpen(false);
      mobileMoreTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileMoreOpen]);

  const mobileNavigationDestinations = [
    ...(hasManagerAccess ? [{ id: 'manager', label: 'Показатели команды', icon: 'portfolio' as const, select: () => navigateToMobileView('manager') }] : []),
    ...(hasQueueAccess ? [{ id: 'queue', label: 'Рабочая очередь', icon: 'queue' as const, select: goToSavedQueue }] : []),
    ...(hasQueueAccess ? [{ id: 'activities', label: 'Все активности', icon: 'activities' as const, select: goToAllActivities }] : []),
    ...(hasKamAccess && !hasManagerAccess ? [{ id: 'dashboard', label: 'Показатели', icon: 'portfolio' as const, select: () => navigateToMobileView('dashboard') }] : []),
    ...(hasQueueAccess ? [{ id: 'feed', label: hasManagerAccess ? 'Движение команды' : 'Мои действия', icon: 'feed' as const, select: () => navigateToMobileView('feed') }] : []),
    ...(hasQueueAccess ? [{ id: 'notifications', label: 'Уведомления', icon: 'notifications' as const, select: () => navigateToMobileView('notifications') }] : []),
    ...(hasKamAccess ? [{ id: 'cms-intake', label: 'Входящие с сайта', icon: 'intake' as const, select: () => navigateToMobileView('cms-intake') }] : []),
    ...((hasQueueAccess || hasAdminAccess) ? [{ id: 'handbook', label: 'Справочник этапов', icon: 'handbook' as const, select: () => navigateToMobileView('handbook') }] : []),
    ...(hasManagerAccess ? [
      { id: 'reports', label: 'Отчёты', icon: 'reports' as const, select: () => navigateToMobileView('reports') },
      { id: 'import', label: 'Каталоги и импорт', icon: 'import' as const, select: () => navigateToMobileView('import') },
    ] : []),
    ...(hasAdminAccess ? [
      { id: 'exchange', label: 'Состояние системы', icon: 'exchange' as const, select: () => navigateToMobileView('exchange') },
      { id: 'workflow', label: 'Схема вузов', icon: 'workflow' as const, select: () => navigateToMobileView('workflow') },
      { id: 'users', label: 'Пользователи CRM', icon: 'users' as const, select: () => navigateToMobileView('users') },
    ] : []),
  ];
  const mobilePrimaryIds = ['queue', 'manager', 'reports'];
  const mobilePrimaryDestinations = mobileNavigationDestinations.filter((destination) => mobilePrimaryIds.includes(destination.id));
  const mobileOverflowDestinations = mobileNavigationDestinations.filter((destination) => !mobilePrimaryIds.includes(destination.id));
  const activeMobileOverflow = !selected && mobileOverflowDestinations.find((destination) => destination.id === activeView);

  return <div className={`app-shell ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
    <aside className={`sidebar ${hasManagerAccess ? 'has-manager-nav' : ''} ${hasManagerAccess && hasAdminAccess ? 'is-manager-admin' : ''}`} aria-label="Основная навигация">
      <div className="brand" aria-label="Ростелеком · ИТ Школа CRM">
        <span className="brand-mark" aria-hidden="true">/</span>
        <span className="brand-copy"><strong>Ростелеком</strong><b>ИТ ШКОЛА · CRM</b></span>
      </div>
      <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <div id="desktop-navigation" className="desktop-nav">
      {hasManagerAccess && <button className={`nav-item ${!selected && activeView === 'manager' ? 'active' : ''}`} aria-label="Показатели команды" title="Показатели команды" aria-current={!selected && activeView === 'manager' ? 'page' : undefined} onClick={() => { if (!leaveDetail()) return; setActiveView('manager'); setOverviewReloadKey((key) => key + 1); setError(''); }}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="portfolio" /></span><span className="nav-label-wide">Показатели команды</span><span className="nav-label-mobile" aria-hidden="true">Портфель</span></button>}
      {hasQueueAccess && <button className={`nav-item ${!selected && activeView === 'queue' ? 'active' : ''}`} aria-label="Рабочая очередь" title="Рабочая очередь" aria-current={!selected && activeView === 'queue' ? 'page' : undefined} onClick={goToSavedQueue}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="queue" /></span><span className="nav-label-wide">Рабочая очередь</span><span className="nav-label-mobile" aria-hidden="true">Очередь</span>{activeView === 'queue' && <span className="nav-count">{listTotal}</span>}</button>}
      {hasKamAccess && !hasManagerAccess && <button className={`nav-item ${!selected && activeView === 'dashboard' ? 'active' : ''}`} aria-label="Показатели" title="Показатели" aria-current={!selected && activeView === 'dashboard' ? 'page' : undefined} onClick={() => navigateToMobileView('dashboard')}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="portfolio" /></span><span className="nav-label-wide">Показатели</span></button>}
      {hasQueueAccess && <button className={`nav-item ${!selected && activeView === 'feed' ? 'active' : ''}`} aria-label={hasManagerAccess ? 'Движение команды' : 'Мои действия'} title={hasManagerAccess ? 'Движение команды' : 'Мои действия'} aria-current={!selected && activeView === 'feed' ? 'page' : undefined} onClick={() => navigateToMobileView('feed')}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="feed" /></span><span className="nav-label-wide">{hasManagerAccess ? 'Движение команды' : 'Мои действия'}</span></button>}
      {hasQueueAccess && <button className={`nav-item ${!selected && activeView === 'notifications' ? 'active' : ''}`} aria-label={`Уведомления${unreadNotifications ? `, непрочитанных: ${unreadNotifications}` : ''}`} title="Уведомления" aria-current={!selected && activeView === 'notifications' ? 'page' : undefined} onClick={() => navigateToMobileView('notifications')}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="notifications" /></span><span className="nav-label-wide">Уведомления</span>{unreadNotifications > 0 && <span className="nav-count">{unreadNotifications}</span>}</button>}
      {hasKamAccess && <button className={`nav-item ${!selected && activeView === 'cms-intake' ? 'active' : ''}`} aria-label="Входящие с сайта" title="Входящие с сайта" aria-current={!selected && activeView === 'cms-intake' ? 'page' : undefined} onClick={() => { if (!leaveDetail()) return; setActiveView('cms-intake'); setError(''); }}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="intake" /></span><span className="nav-label-wide">Входящие с сайта</span><span className="nav-label-mobile" aria-hidden="true">Входящие</span></button>}
      {(hasQueueAccess || hasAdminAccess) && <button className={`nav-item ${!selected && activeView === 'handbook' ? 'active' : ''}`} aria-label="Справочник этапов" title="Справочник этапов" aria-current={!selected && activeView === 'handbook' ? 'page' : undefined} onClick={() => { if (!leaveDetail()) return; setActiveView('handbook'); setError(''); }}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="handbook" /></span><span className="nav-label-wide">Справочник этапов</span><span className="nav-label-mobile" aria-hidden="true">Справка</span></button>}
      {hasManagerAccess && <button className={`nav-item ${!selected && activeView === 'reports' ? 'active' : ''}`} aria-label="Отчёты" title="Отчёты" aria-current={!selected && activeView === 'reports' ? 'page' : undefined} onClick={() => { if (!leaveDetail()) return; setActiveView('reports'); setError(''); }}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="reports" /></span><span className="nav-label-wide">Отчёты</span><span className="nav-label-mobile" aria-hidden="true">Отчёты</span></button>}
      {hasAdminAccess && <button className={`nav-item ${!selected && activeView === 'exchange' ? 'active' : ''}`} aria-label="Состояние системы" title="Состояние системы" aria-current={!selected && activeView === 'exchange' ? 'page' : undefined} onClick={() => { if (!leaveDetail()) return; setActiveView('exchange'); setExchangeReloadKey((key) => key + 1); setError(''); }}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="exchange" /></span><span className="nav-label-wide">Состояние системы</span><span className="nav-label-mobile" aria-hidden="true">Система</span></button>}
      {hasAdminAccess && <button className={`nav-item ${!selected && activeView === 'workflow' ? 'active' : ''}`} aria-label="Схема вузов" title="Схема вузов" aria-current={!selected && activeView === 'workflow' ? 'page' : undefined} onClick={() => { if (!leaveDetail()) return; setActiveView('workflow'); setError(''); }}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="workflow" /></span><span className="nav-label-wide">Схема вузов</span><span className="nav-label-mobile" aria-hidden="true">Схема</span></button>}
      {hasAdminAccess && <button className={`nav-item ${!selected && activeView === 'users' ? 'active' : ''}`} aria-label="Пользователи CRM" title="Пользователи CRM" aria-current={!selected && activeView === 'users' ? 'page' : undefined} onClick={() => { if (!leaveDetail()) return; setActiveView('users'); setError(''); }}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="users" /></span><span className="nav-label-wide">Пользователи</span><span className="nav-label-mobile" aria-hidden="true">Доступ</span></button>}
      {hasManagerAccess && <button className={`nav-item ${!selected && activeView === 'import' ? 'active' : ''}`} aria-label="Каталоги и импорт" title="Каталоги и импорт" aria-current={!selected && activeView === 'import' ? 'page' : undefined} onClick={() => { if (!leaveDetail()) return; setActiveView('import'); setError(''); }}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="import" /></span><span className="nav-label-wide">Каталоги и импорт</span><span className="nav-label-mobile" aria-hidden="true">Импорт</span></button>}
      {hasQueueAccess && <button className={`nav-item ${!selected && activeView === 'activities' ? 'active' : ''}`} aria-label="Все активности" title="Все активности" aria-current={!selected && activeView === 'activities' ? 'page' : undefined} onClick={goToAllActivities}><span className="nav-icon" aria-hidden="true"><NavigationIcon name="activities" /></span><span className="nav-label-wide">Все активности</span><span className="nav-label-mobile" aria-hidden="true">Все</span></button>}
      </div>
      {hasManagerAccess && hasAdminAccess && <nav className="mobile-nav" aria-label="Навигация CRM для небольшого экрана">
        {mobilePrimaryDestinations.map((destination) => <button
          key={destination.id}
          type="button"
          className={`nav-item ${!selected && activeView === destination.id ? 'active' : ''}`}
          aria-label={destination.label}
          aria-current={!selected && activeView === destination.id ? 'page' : undefined}
          onClick={() => { destination.select(); }}
        ><span className="nav-icon" aria-hidden="true"><NavigationIcon name={destination.icon} /></span><span className="nav-label-mobile" aria-hidden="true">{destination.id === 'queue' ? 'Очередь' : destination.id === 'manager' ? 'Показатели' : destination.label}</span></button>)}
        <div className="mobile-nav-more" ref={mobileMoreRef} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMobileMoreOpen(false);
        }}>
          <button
            ref={mobileMoreTriggerRef}
            type="button"
            className={`nav-item mobile-more-trigger ${activeMobileOverflow ? 'active' : ''}`}
            aria-label={activeMobileOverflow ? `Ещё разделы, текущий раздел: ${activeMobileOverflow.label}` : 'Ещё разделы'}
            aria-expanded={mobileMoreOpen}
            aria-controls="mobile-more-menu"
            onClick={() => setMobileMoreOpen((open) => !open)}
          ><span className="nav-icon" aria-hidden="true"><NavigationIcon name="more" /></span><span className="nav-label-mobile" aria-hidden="true">Ещё</span></button>
          <nav id="mobile-more-menu" className="mobile-more-menu" aria-label="Дополнительные разделы" hidden={!mobileMoreOpen}>
            {mobileOverflowDestinations.map((destination) => <button
              key={destination.id}
              type="button"
              data-mobile-more-item
              className={`nav-item mobile-more-item ${!selected && activeView === destination.id ? 'active' : ''}`}
              aria-current={!selected && activeView === destination.id ? 'page' : undefined}
              onClick={() => selectMobileDestination(destination)}
            ><span className="nav-icon" aria-hidden="true"><NavigationIcon name={destination.icon} /></span>{destination.label}</button>)}
          </nav>
        </div>
      </nav>}
      <div className="sidebar-toggle-row">
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={sidebarCollapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'}
          aria-expanded={!sidebarCollapsed}
          aria-controls="desktop-navigation"
          title={sidebarCollapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >
          <svg className="sidebar-toggle-icon" viewBox="0 0 32 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 3 2 10l7 7M19 3l-7 7 7 7M29 3l-7 7 7 7" /></svg>
        </button>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="crumbs"><span>Рабочее пространство</span><i>/</i><b>{selected ? 'Активность' : activeView === 'activities' ? 'Все активности' : activeView === 'manager' ? 'Показатели команды' : activeView === 'dashboard' ? 'Показатели' : activeView === 'feed' ? hasManagerAccess ? 'Движение команды' : 'Мои действия' : activeView === 'notifications' ? 'Уведомления' : activeView === 'reports' ? 'Отчёты' : activeView === 'import' ? 'Импорт и каталоги' : activeView === 'exchange' ? 'Состояние системы' : activeView === 'workflow' ? 'Схема вузов' : activeView === 'users' ? 'Пользователи' : activeView === 'cms-intake' ? 'Входящие с сайта' : activeView === 'handbook' ? 'Справочник этапов' : 'Рабочая очередь'}</b></div>
        <div className="topbar-right">
          {hasQueueAccess && <button type="button" className={`topbar-notifications${!selected && activeView === 'notifications' ? ' active' : ''}`} aria-label={`Уведомления${unreadNotifications ? `, непрочитанных: ${unreadNotifications}` : ''}`} aria-current={!selected && activeView === 'notifications' ? 'page' : undefined} title="Уведомления" onClick={() => navigateToMobileView('notifications')}><span className="topbar-notifications-icon"><NavigationIcon name="notifications" /></span>{unreadNotifications > 0 && <span className="topbar-notifications-count">{unreadNotifications}</span>}</button>}
          <button type="button" className="theme-toggle" aria-label={theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'} title={theme === 'light' ? 'Тёмная тема' : 'Светлая тема'} onClick={() => setTheme((value) => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '☾' : '☀'}</button>
          <UserAvatar name={userLabel} className="user-avatar" /><span className="user-name">{userLabel}</span>
          <button className="logout" onClick={() => { if (confirmDetailExit()) { clearStoredImportDraft(); logout(); } }}>Выйти</button>
        </div>
      </header>

      <div className="page-scroll" onScroll={selected ? undefined : handleScroll}>
        {error && <div className="alert error"><span>!</span>{error}<button onClick={() => setError('')}>Закрыть</button></div>}
        {notice && <div className="toast"><span>✓</span>{notice}</div>}
        {!hasCrmWorkspaceAccess ? <section className="panel workspace-access" role="status" aria-labelledby="workspace-access-title">
          <span className="workspace-access-icon" aria-hidden="true">!</span>
          <div><div className="eyebrow">ДОСТУП К CRM</div><h1 id="workspace-access-title">Рабочее пространство недоступно</h1>
            <p>{roles.length === 0 ? 'Для вашей учётной записи не назначена роль CRM. Обратитесь к администратору, чтобы получить доступ.' : 'В этой учётной записи нет роли для работы в CRM. Обратитесь к администратору, чтобы проверить доступ.'}</p>
          </div>
        </section> : !selected && activeView === 'handbook' && (hasQueueAccess || hasAdminAccess) ? <GuidanceHandbook api={api} canEditDrafts={hasManagerAccess} canPublish={hasAdminAccess} /> : !selected && activeView === 'users' && hasAdminAccess ? <AccessUsers api={api} currentUserSub={user.sub} /> : !selected && activeView === 'workflow' && hasAdminAccess ? <UniversityWorkflowAdmin api={api} onApplied={() => {
          const scope = roleScope;
          if (!isCurrentRoleScope(scope)) return;
          if (hasQueueAccess) {
            api<Catalog>('/api/catalog').then((value) => { if (isCurrentRoleScope(scope)) setCatalog(value); }).catch((reason: Error) => { if (isCurrentRoleScope(scope)) setError(reason.message); });
            void refreshLoadedQueue();
          }
          if (hasManagerAccess) { setManagerOverview(null); setOverviewReloadKey((key) => key + 1); }
        }} /> : !selected && activeView === 'dashboard' && hasKamAccess && !hasManagerAccess ? <KamDashboard api={api} onQueue={(nextSegment, nextCollection, nextRouteVersion) => goToQueue(nextSegment, nextCollection, nextRouteVersion ? { routeVersion: nextRouteVersion, stageLabel: nextRouteVersion === 'legacy' ? 'Прежний процесс физлиц' : 'Текущий процесс физлиц' } : null, '')} /> : !selected && activeView === 'feed' && hasQueueAccess ? <ActivityFeedPage api={api} manager={hasManagerAccess} kams={managerKams} onOpenActivity={(id) => { void run(async () => { await refreshDetail(id, beginDetailNavigation()); }); }} /> : !selected && activeView === 'notifications' && hasQueueAccess ? <NotificationsPage api={api} onRead={setUnreadNotifications} onOpenActivity={(id) => { void run(async () => { await refreshDetail(id, beginDetailNavigation()); }); }} /> : !selected && activeView === 'reports' && hasManagerAccess ? <ReportsPage api={api} token={token} hasManagerAccess={hasManagerAccess} onOpenActivity={openReportActivity} /> : !selected && activeView === 'import' && hasManagerAccess ? <ImportPanel api={api} scope={importScope} onCompleted={() => { refreshAfterImport().catch((reason: Error) => setError(reason.message)); }} /> : !selected && activeView === 'exchange' && hasAdminAccess ? <ExchangeMonitorPage monitor={exchangeMonitor} imports={adminImportSummary} loading={exchangeLoading} busy={busy} onRefresh={() => setExchangeReloadKey((key) => key + 1)} onOpenUsers={() => { if (!leaveDetail()) return; setActiveView('users'); setError(''); }} onCmsPull={() => runAdminExchange(() => api('/api/admin/exchanges/cms/pull', { method: 'POST' }), 'Обмен с CMS выполнен. Проверьте отдельное подтверждение CRM → CMS.')} onLmsPull={() => runAdminExchange(() => api('/api/admin/exchanges/lms/pull', { method: 'POST' }), 'События LMS обработаны; учебное представление содержит только полученные факты.')} onFailure={(system, mode) => runAdminExchange(() => api(`/api/admin/exchanges/mocks/${system}/fail-next`, { method: 'POST', body: JSON.stringify({ mode }) }), mode === 'http_error' ? `Следующий запрос в тестовой среде ${system.toUpperCase()} завершится технической ошибкой.` : `Следующая команда тестовой среды ${system.toUpperCase()} будет отклонена.`)} onRetry={(id) => runAdminExchange(() => api(`/api/exchanges/${id}/retry`, { method: 'POST' }), 'Повтор отправлен; проверьте ответ источника.')} onOutcome={(id, outcome, factKind) => runAdminExchange(async () => { await api(`/api/admin/exchanges/lms/${id}/outcome`, { method: 'POST', body: JSON.stringify({ outcome, factKind }) }); if (outcome === 'perform') await api('/api/admin/exchanges/lms/pull', { method: 'POST' }); }, outcome === 'perform' ? 'Событие получено из LMS и добавлено в представление только для просмотра.' : 'Тестовая среда LMS отклонила запрос.')} onOpenActivity={hasQueueAccess ? openExchangeActivity : undefined} /> : !selected && activeView === 'cms-intake' && hasKamAccess ? <CmsIntakePage items={cmsIntake} loading={cmsIntakeLoading} busy={busy} onRefresh={() => refreshCmsIntake().catch((reason: Error) => setError(reason.message))} onClaim={(id) => { const scope = roleScope; if (!isCurrentRoleScope(scope)) return; const routeVersion = beginDetailNavigation(); return run(async () => { await api(`/api/cms-mock/intake/${id}/claim`, { method: 'POST' }); if (!isCurrentRoleScope(scope)) return; await refreshCmsIntake(); await refreshLoadedQueue(); await refreshDetail(id, routeVersion); if (!isCurrentRoleScope(scope)) return; setActiveView('queue'); }, 'Обращение назначено вам'); }} /> : !selected && activeView === 'manager' && hasManagerAccess ? <ManagerPortfolio overview={managerOverview} loading={managerLoading} onRefresh={() => setOverviewReloadKey((key) => key + 1)} onQueue={(nextSegment, nextCollection, nextDrilldown) => goToQueue(nextSegment, nextCollection, nextDrilldown, '')} /> : !selected && hasQueueAccess ? <>
          <div className="page-heading queue-heading">
            <div><div className="eyebrow">{activeView === 'activities' ? 'ОБЩИЙ СПИСОК · ВСЕ СЕГМЕНТЫ' : `ПОРТФЕЛЬ · ${hasManagerAccess ? 'ВСЯ КОМАНДА' : 'МОИ АКТИВНОСТИ'}`}</div><h1 id={activeView === 'activities' ? 'activities-heading' : 'queue-heading'} tabIndex={-1}>{activeView === 'activities' ? 'Все активности' : 'Рабочая очередь'}</h1><p>{activeView === 'activities' ? 'Общий список активностей по вузам, компаниям и физлицам' : 'Следующие действия по клиентам и учебным программам'}</p></div>
            <button className="primary" onClick={() => setShowCreate(true)}><span>＋</span> Новая активность</button>
          </div>
          <section className="filters" aria-label={activeView === 'activities' ? 'Фильтры всех активностей' : 'Фильтры очереди'}>
            <div className="filter-block"><span className="filter-label">Сегмент</span><div className="segmented">{SEGMENTS.map((item) => <button key={item.key} type="button" aria-pressed={segment === item.key} className={segment === item.key ? 'selected' : ''} onClick={() => { if (item.key !== segment && (drilldown?.stageKeys || drilldown?.routeVersion)) setDrilldown(null); setSegment(item.key); }}>{item.label}</button>)}</div></div>
            <div className="filter-block collection-block"><span className="filter-label">{activeView === 'activities' ? 'Подборка' : 'Рабочая подборка'}</span><div className="collection-pills">{COLLECTIONS.map((item) => <button key={item.key} type="button" aria-pressed={collection === item.key} className={collection === item.key ? 'selected' : ''} onClick={() => setCollection(item.key)}>{item.label}</button>)}</div></div>
            <div className="filter-block queue-search-block"><label className="filter-label" htmlFor="queue-search">Поиск</label><div className="queue-search-control"><input id="queue-search" type="text" value={searchInput} maxLength={120} placeholder="Название, организация или контакт" onChange={(event) => setSearchInput(event.target.value)} /><button type="button" aria-label="Сбросить поиск" title="Сбросить поиск" disabled={!searchInput} onClick={() => { setSearchInput(''); setQueueSearch(''); }}>×</button></div></div>
          </section>
          {drilldown && <div className="queue-drilldown" role="status"><span>{drilldown.ownerName ? `Ответственный: ${drilldown.ownerName}` : drilldown.productName ? `Продукт: ${drilldown.productName}` : `Этап: ${drilldown.stageLabel}`}</span><button className="text-button" onClick={() => setDrilldown(null)}>Сбросить фильтр</button></div>}
          <div className="list-summary"><b>{list.length}</b> из <b>{listTotal}</b> {listTotal === 1 ? 'активности' : 'активностей'} <span>{listLoading ? '· обновляем список' : '· сортировка по приоритету и сроку'}</span></div>
          <div className="queue-list" key={`${activeView}:${segment}:${collection}:${drilldown?.ownerSub ?? drilldown?.productId ?? drilldown?.stageKeys?.join('-') ?? 'all'}:${queueSearch}`} onScroll={handleScroll}>
            {list.map((item) => <ActivityRow key={item.id} item={item} showOwner={hasManagerAccess} open={() => {
              const mobile = window.matchMedia('(max-width: 900px)').matches;
              const scrollContainer = document.querySelector(mobile ? '.page-scroll' : '.queue-list');
              const scrollKey = activeView === 'activities' ? 'lct-activities-scroll' : 'lct-queue-scroll';
              sessionStorage.setItem(scrollKey, String(scrollContainer?.scrollTop ?? 0));
              void openActivity(item);
            }} />)}
            {listLoading && !list.length && <div className="queue-loading">Загружаем очередь…</div>}
            {!list.length && !listLoading && <div className="empty-state"><div className="empty-icon">✓</div><h2>{queueSearch ? 'Совпадений не найдено' : activeView === 'activities' && collection === 'all' ? 'Активностей пока нет' : 'В этой подборке пока пусто'}</h2><p>{queueSearch ? 'Измените запрос или сбросьте поиск.' : activeView === 'activities' && collection === 'all' ? 'Здесь появятся активности по вузам, компаниям и физлицам.' : 'Попробуйте другой сегмент или создайте новую активность.'}</p>{!queueSearch && <button className="secondary" onClick={() => setShowCreate(true)}>Создать активность</button>}</div>}
            {list.length < listTotal && <div className="queue-load-more"><button className="secondary" onClick={() => refreshList(list.length, true).catch((reason: Error) => setError(reason.message))} disabled={loadingMore || listLoading}>{loadingMore ? 'Загружаем…' : `Показать ещё (${listTotal - list.length})`}</button></div>}
          </div>
        </> : selected && hasQueueAccess ? <ActivityDetail key={`${selected.id}:${detailDraftResetVersion}`} item={selected} contacts={contacts} products={catalog.products} managerKams={managerKams} canReassign={roles.includes('manager')} currentUserSub={user.sub} routeVersion={detailRouteVersion.current} api={api} onReassigned={confirmReassignment} onStale={refreshAfterReassignment} guidance={guidance} guidanceError={guidanceError} workflow={catalog.workflows.filter((stage) => stage.kind === selected.kind)} history={history} documents={documents} contractLicenses={contractLicenses} universitySteps={universitySteps} learningFacts={learningFacts} exchangeJobs={exchangeJobs} corporatePlan={corporatePlan} busy={busy} onDirtyChange={updateDetailDirty} onBack={goBack} returnLabel={activeView === 'reports' ? 'К отчётам' : activeView === 'activities' ? 'Ко всем активностям' : 'К очереди'} queuePosition={activeView === 'reports' ? null : selectedQueuePosition(selected, list, hasQueueAccess && isCurrentRoleScope())} onQueueNavigate={navigateLoadedQueue} onRefresh={() => { void refreshCurrentDetail(selected.id); }} onCoreSave={(input) => mutateDetail(() => api(`/api/activities/${selected.id}/details`, { method: 'PUT', body: JSON.stringify(input) }), 'Основные сведения сохранены')} onTask={(title, dueAt) => mutateDetail(() => api(`/api/activities/${selected.id}/tasks`, { method: 'POST', body: JSON.stringify({ title, dueAt }) }), 'Действие добавлено')} onComplete={(taskId) => { const key = `task-update-${taskId}`; if (unsavedDetailSections.current.has(key) && !window.confirm('Черновик обновления этой задачи не сохранён. Выполнить задачу и отбросить текст?')) return; void mutateDetail(() => api(`/api/activities/${selected.id}/tasks/${taskId}/complete`, { method: 'POST' }), 'Действие выполнено').then((saved) => { if (saved) updateDetailDirty(key, false); }); }} onGuidanceFeedback={(recommendationKey, action, reason) => mutateDetail(() => api(`/api/activities/${selected.id}/guidance/feedback`, { method: 'POST', body: JSON.stringify({ recommendationKey, action, reason }) }), action === 'defer' ? 'Рекомендация отложена на сутки' : 'Причина отклонения сохранена')} onOutcome={(outcome, note) => mutateDetail(() => api(`/api/activities/${selected.id}/outcomes`, { method: 'POST', body: JSON.stringify({ outcome, note }) }), 'Итог записан в историю')} onTransition={transitionActivity} onUniversityStep={(stepId, input) => mutateDetail(() => api(`/api/activities/${selected.id}/university-steps/${stepId}`, { method: 'PUT', body: JSON.stringify(input) }), 'Пункт партнёрства обновлён')} onCorrectionReturn={(input) => mutateDetail(() => api(`/api/activities/${selected.id}/university-steps/correction-return`, { method: 'POST', body: JSON.stringify(input) }), 'Возврат документов записан')} onCorporatePlan={(input) => mutateDetail(() => api(`/api/activities/${selected.id}/corporate-plan`, { method: 'PUT', body: JSON.stringify(input) }), 'План программы сохранён')} onContractLicenseSave={(recordId, input, expectedRevision) => mutateDetail(() => api(`/api/activities/${selected.id}/contract-licenses${recordId ? `/${recordId}` : ''}`, { method: recordId ? 'PUT' : 'POST', body: JSON.stringify(recordId ? { ...input, expectedRevision } : input) }), 'Данные договора или лицензии сохранены')} onContractLicenseDelete={(record) => mutateDetail(() => api(`/api/activities/${selected.id}/contract-licenses/${record.id}?expectedRevision=${record.revision}`, { method: 'DELETE' }), 'Запись договора или лицензии удалена')} onLmsRequest={(activityId) => mutateDetail(() => api(`/api/activities/${activityId}/exchanges/lms-requests`, { method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }), 'Запрос создан. Ниже показан ответ тестовой среды LMS.')} onRetryExchange={(jobId) => mutateDetail(() => api(`/api/exchanges/${jobId}/retry`, { method: 'POST' }), 'Повтор отправлен; проверьте ответ источника.')} onUploadDocument={(file) => mutateDetail(() => api(`/api/activities/${selected.id}/documents?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } }), 'Документ добавлен')} onDownloadDocument={(file) => run(async () => { await downloadActivityDocument(selected.id, file); await refreshDetail(selected.id); }, 'Файл скачан')} /> : null}
      </div>
    </main>

    {showCreate && hasQueueAccess && <CreateActivity catalog={catalog} contacts={contacts} api={api} busy={busy} close={() => setShowCreate(false)} create={createActivity} />}
  </div>;
}

const MANAGER_SEGMENTS: { key: Segment; label: string; value: (overview: ManagerOverview) => number }[] = [
  { key: 'university', label: 'Вузы', value: (overview) => overview.metrics.byKind.university },
  { key: 'company', label: 'Компании', value: (overview) => overview.metrics.byKind.corporate },
  { key: 'individual', label: 'Физлица', value: (overview) => overview.metrics.byKind.individual },
];
const MANAGER_DEFINITION_LABELS: Record<string, string> = {
  totalOpen: 'Открыто', byKind: 'Типы активностей', overdue: 'Просрочено', awaitingReply: 'Ожидают ответа',
  noNextStep: 'Без следующего шага', byOwner: 'По ответственным', topProducts: 'Продукты',
};

const guidanceArticleText = (article: GuidanceArticle | GuidanceEditorialArticle | null | undefined) => [
  article?.title, article?.summary, article?.focus, ...(article?.checks ?? []), article?.boundary,
  article?.draftMessage, article?.recommendationWhenNoOpenTask,
].map((value) => String(value ?? '')).join('\n');

const editorialArticle = (article: GuidanceArticle | GuidanceEditorialArticle | null | undefined): GuidanceEditorialArticle => ({
  title: article?.title ?? '', summary: article?.summary ?? '', focus: article?.focus ?? '',
  checks: article?.checks?.length ? [...article.checks] : [''], boundary: article?.boundary ?? '',
  draftMessage: article?.draftMessage ?? '', recommendationWhenNoOpenTask: article?.recommendationWhenNoOpenTask ?? '',
});

const handbookArticleFields: { key: keyof GuidanceEditorialArticle; label: string }[] = [
  { key: 'title', label: 'Заголовок' }, { key: 'summary', label: 'Кратко' }, { key: 'focus', label: 'Фокус' },
  { key: 'checks', label: 'Проверки' }, { key: 'boundary', label: 'Граница ответственности' },
  { key: 'draftMessage', label: 'Предлагаемый черновик сообщения' },
  { key: 'recommendationWhenNoOpenTask', label: 'Рекомендация без открытых задач' },
];

const handbookFieldText = (article: GuidanceArticle | GuidanceEditorialArticle, key: keyof GuidanceEditorialArticle) => {
  const value = article[key];
  return Array.isArray(value) ? value.join('\n') : String(value ?? '');
};

function GuidanceHandbook({ api, canEditDrafts, canPublish }: { api: ApiCall; canEditDrafts: boolean; canPublish: boolean }) {
  const handbookPath = canPublish && !canEditDrafts ? '/api/admin/guidance/handbook' : '/api/guidance/handbook';
  const [items, setItems] = useState<GuidanceHandbookItem[]>([]);
  const [kind, setKind] = useState<Kind>('university');
  const [individualRoute, setIndividualRoute] = useState<'v2' | 'legacy'>('v2');
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [localDrafts, setLocalDrafts] = useState<Record<string, GuidanceEditorialArticle>>({});
  const [localDraftBaseRevisions, setLocalDraftBaseRevisions] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [actionError, setActionError] = useState('');
  async function refresh() {
    setLoading(true);
    setError('');
    try { const response = await api<{ items: GuidanceHandbookItem[] }>(handbookPath); setItems(response.items); return response.items; }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось загрузить справочник.'); return null; }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [api, handbookPath]);
  async function saveDraft(item: GuidanceHandbookItem, article: GuidanceEditorialArticle) {
    setBusyId(item.id); setActionError('');
    try {
      const cleanedArticle = { ...article, checks: article.checks.map((check) => check.trim()).filter(Boolean) };
      const saved = await api<{ draftRevision: number }>(`/api/guidance/${item.kind}/${item.stageKey}/draft`, {
        method: 'PUT', body: JSON.stringify({ expectedRevision: localDraftBaseRevisions[item.id] ?? item.draftRevision ?? 0, article: cleanedArticle }),
      });
      setLocalDrafts((current) => ({ ...current, [item.id]: cleanedArticle }));
      setLocalDraftBaseRevisions((current) => ({ ...current, [item.id]: saved.draftRevision }));
      const refreshed = await refresh();
      if (refreshed) {
        setLocalDrafts((current) => { const next = { ...current }; delete next[item.id]; return next; });
        setLocalDraftBaseRevisions((current) => { const next = { ...current }; delete next[item.id]; return next; });
      }
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : 'Не удалось сохранить черновик.'); }
    finally { setBusyId(''); }
  }
  async function publish(item: GuidanceHandbookItem) {
    setBusyId(item.id); setActionError('');
    try {
      await api(`/api/admin/guidance/${item.kind}/${item.stageKey}/publish`, { method: 'POST', body: JSON.stringify({ expectedDraftRevision: item.draftRevision }) });
      await refresh();
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : 'Не удалось опубликовать инструкцию.'); }
    finally { setBusyId(''); }
  }
  const segmentItems = useMemo(() => items.filter((item) => item.kind === kind &&
    (kind !== 'individual' || INDIVIDUAL_ROUTE_STAGES[individualRoute].some((stage) => stage === item.stageKey))), [items, kind, individualRoute]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('ru');
    if (!search) return segmentItems;
    return segmentItems.filter((item) => [KIND_LABEL[item.kind], item.stageLabel, item.stageKey,
      guidanceArticleText(item.article), guidanceArticleText(item.draftArticle), guidanceArticleText(localDrafts[item.id])].some((value) => value.toLocaleLowerCase('ru').includes(search)));
  }, [segmentItems, query, localDrafts]);
  const activeItem = filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? null;
  useEffect(() => {
    if (activeItem?.id !== selectedId) setSelectedId(activeItem?.id ?? '');
  }, [activeItem?.id, selectedId]);
  const countsByKind = useMemo(() => Object.fromEntries((['university', 'individual', 'corporate'] as Kind[]).map((currentKind) =>
    [currentKind, items.filter((item) => item.kind === currentKind &&
      (currentKind !== 'individual' || INDIVIDUAL_ROUTE_STAGES[individualRoute].some((stage) => stage === item.stageKey))).length])) as Record<Kind, number>, [items, individualRoute]);
  const statusLabel: Record<GuidanceHandbookItem['state'], string> = {
    published: 'Опубликована', seed: 'Есть инструкция', draft: 'Есть черновик', stale: 'Нужна повторная привязка', missing: 'Нет инструкции',
  };
  return <div className="handbook-page">
    <div className="page-heading"><div><div className="eyebrow">ИНСТРУКЦИИ ПО ТИПАМ И СТАДИЯМ</div><h1>Справочник этапов</h1><p>Короткие ориентиры и предлагаемые формулировки для вузов, физлиц и компаний.</p></div><button className="secondary" disabled={loading || Boolean(busyId)} onClick={() => void refresh()}>↻ Обновить</button></div>
    {(canEditDrafts || canPublish) && <ProgramCatalog api={api} showDemand={canEditDrafts} />}
    <section className="panel handbook-search-panel"><label className="field" htmlFor="handbook-search"><span>Поиск по справочнику</span><input id="handbook-search" type="search" value={query} maxLength={120} placeholder="Стадия, тема или формулировка" onChange={(event) => setQuery(event.target.value)} /></label>
      <span className="handbook-count" aria-live="polite">{loading ? 'Загружаем…' : `${filtered.length} из ${segmentItems.length} этапов · поиск по тексту статей`}</span>
    </section>
    <div className="handbook-segments" role="tablist" aria-label="Процесс обучения">
      {(['university', 'individual', 'corporate'] as Kind[]).map((currentKind) => <button key={currentKind} type="button" role="tab" tabIndex={kind === currentKind ? 0 : -1}
        id={`handbook-tab-${currentKind}`} aria-selected={kind === currentKind} aria-controls="handbook-content"
        className={kind === currentKind ? 'selected' : ''} onClick={() => { setKind(currentKind); setSelectedId(''); }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const kinds: Kind[] = ['university', 'individual', 'corporate'];
          const index = kinds.indexOf(currentKind);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? kinds.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : kinds.length - 1)) % kinds.length;
          setKind(kinds[next]); setSelectedId('');
          requestAnimationFrame(() => document.getElementById(`handbook-tab-${kinds[next]}`)?.focus());
        }}>
        {KIND_LABEL[currentKind]} <span>{countsByKind[currentKind]}</span>
      </button>)}
    </div>
    {kind === 'individual' && <><div className="handbook-routes" role="group" aria-label="Версия маршрута индивидуальной заявки">
      <button type="button" className={individualRoute === 'v2' ? 'selected' : ''} aria-pressed={individualRoute === 'v2'} onClick={() => { setIndividualRoute('v2'); setSelectedId(''); }}>Новые заявки · 6 этапов</button>
      <button type="button" className={individualRoute === 'legacy' ? 'selected' : ''} aria-pressed={individualRoute === 'legacy'} onClick={() => { setIndividualRoute('legacy'); setSelectedId(''); }}>Заявки прежнего процесса · 5 этапов</button>
    </div><p className="handbook-route-note">Это версии процесса по времени создания заявки, а не разделение клиентов на новых и повторных.</p></>}
    {kind === 'university' && <p className="handbook-route-note">Пять крупных этапов — общий маршрут для первого и повторного взаимодействия с вузом. В карточке активности отдельно отслеживаются 13 пунктов работы и сквозной контроль исполнения.</p>}
    {error && <section className="panel handbook-empty" role="status"><h2>Справочник недоступен</h2><p>{error}</p><button className="secondary" onClick={() => void refresh()}>Повторить</button></section>}
    {actionError && <p className="handbook-action-error" role="alert">{actionError}</p>}
    {!error && <div className="handbook-workspace" id="handbook-content" role="tabpanel" aria-labelledby={`handbook-tab-${kind}`}>
      <nav className="panel handbook-stage-list" aria-label={`Этапы: ${KIND_LABEL[kind]}`}>
        <div className="handbook-stage-list-heading"><b>Этапы процесса</b><span>{filtered.length}</span></div>
        {filtered.map((item) => <button type="button" id={`handbook-stage-${item.id}`} className={`handbook-stage-option ${activeItem?.id === item.id ? 'selected' : ''}`}
          key={item.id} aria-current={activeItem?.id === item.id ? 'true' : undefined} onClick={() => setSelectedId(item.id)}
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = filtered.findIndex((stage) => stage.id === item.id);
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            const nextId = filtered[nextIndex]?.id;
            if (nextId) { setSelectedId(nextId); requestAnimationFrame(() => document.getElementById(`handbook-stage-${nextId}`)?.focus()); }
          }}>
          <span className="handbook-stage-option-label">{item.stageLabel}</span>
          <span className={`handbook-status handbook-status-${!item.current ? 'removed' : item.state}`}>{item.current ? statusLabel[item.state] : 'Стадия удалена'}</span>
          {localDrafts[item.id] && JSON.stringify(localDrafts[item.id]) !== JSON.stringify(editorialArticle(item.draftArticle ?? item.article)) &&
            <span className="handbook-local-flag">Есть несохранённые изменения</span>}
        </button>)}
        {!loading && !filtered.length && <div className="handbook-no-matches">По этому запросу этапов нет.</div>}
      </nav>
      {activeItem ? <article className="panel handbook-entry" key={activeItem.id}>
        <div className="handbook-entry-heading"><div><div className="eyebrow">{KIND_LABEL[activeItem.kind]} · ИНСТРУКЦИЯ ПО ЭТАПУ</div><h2>{activeItem.stageLabel}</h2>{activeItem.article && activeItem.article.title !== activeItem.stageLabel && <p>{activeItem.article.title}</p>}</div>
          <span className={`handbook-status handbook-status-${!activeItem.current ? 'removed' : activeItem.state}`}>{activeItem.current ? statusLabel[activeItem.state] : 'Стадия удалена'}</span></div>
        {activeItem.state === 'stale' && activeItem.current && <p className="handbook-stale-note">Инструкция скрыта: схема стадии изменилась после привязки. Администратор может проверить и привязать актуальную ревизию.</p>}
        {!activeItem.current && <p className="handbook-stale-note">Стадия удалена из схемы. Инструкция остаётся недоступной для рекомендаций.</p>}
        {activeItem.article ? <><p>{activeItem.article.summary}</p><p><b>Фокус:</b> {activeItem.article.focus}</p><div><b>Проверьте</b><ul>{activeItem.article.checks.map((check, index) => <li key={`${index}:${check}`}>{check}</li>)}</ul></div><p><b>Граница:</b> {activeItem.article.boundary}</p>
          <p><b>Если нет открытых задач:</b> {activeItem.article.recommendationWhenNoOpenTask}</p><details className="handbook-draft"><summary>Предлагаемый черновик сообщения</summary><p>{activeItem.article.draftMessage}</p></details></>
          : activeItem.state !== 'stale' && <p>Инструкция для этой стадии ещё не опубликована. Пока используйте подтверждённые данные активности и текущую схему.</p>}
        {(canEditDrafts || canPublish) && activeItem.current && <GuidanceEditorialControls key={activeItem.id} item={activeItem} canEdit={canEditDrafts} canPublish={canPublish} busy={busyId === activeItem.id}
          article={localDrafts[activeItem.id] ?? editorialArticle(activeItem.draftArticle ?? activeItem.article)}
          hasLocalDraft={Boolean(localDrafts[activeItem.id])}
          baseRevision={localDraftBaseRevisions[activeItem.id] ?? activeItem.draftRevision ?? 0}
          onArticleChange={(article) => {
            setLocalDraftBaseRevisions((current) => current[activeItem.id] === undefined ? { ...current, [activeItem.id]: activeItem.draftRevision ?? 0 } : current);
            setLocalDrafts((current) => ({ ...current, [activeItem.id]: article }));
          }}
          onSave={(article) => void saveDraft(activeItem, article)} onPublish={() => void publish(activeItem)} />}
      </article> : <section className="panel handbook-empty"><h2>{loading ? 'Загружаем этапы…' : 'Ничего не найдено'}</h2><p>{loading ? 'Этапы процесса появятся здесь.' : 'Очистите поиск или выберите другой процесс.'}</p></section>}
    </div>}
  </div>;
}

function GuidanceEditorialControls({ item, canEdit, canPublish, busy, article, hasLocalDraft, baseRevision, onArticleChange, onSave, onPublish }: {
  item: GuidanceHandbookItem; canEdit: boolean; canPublish: boolean; busy: boolean; article: GuidanceEditorialArticle; hasLocalDraft: boolean; baseRevision: number;
  onArticleChange: (article: GuidanceEditorialArticle) => void;
  onSave: (article: GuidanceEditorialArticle) => void; onPublish: () => void;
}) {
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null);
  useEffect(() => { setConfirmedRevision(null); }, [item.id, item.draftRevision]);
  const savedDraft = editorialArticle(item.draftArticle ?? item.article);
  const hasUnsavedChanges = JSON.stringify(article) !== JSON.stringify(savedDraft);
  const published = item.article;
  const changedFields = published && item.draftArticle ? handbookArticleFields.filter(({ key }) => handbookFieldText(item.draftArticle!, key) !== handbookFieldText(published, key)) : [];
  const setField = <K extends keyof GuidanceEditorialArticle>(key: K, value: GuidanceEditorialArticle[K]) => onArticleChange({ ...article, [key]: value });
  return <section className="handbook-editorial" aria-label={`Редактура инструкции: ${item.stageLabel}`}>
    <div className="handbook-editorial-heading"><b>Редактура и публикация</b><small>{item.publishedRevision ? `Опубликована ревизия ${item.publishedRevision}${item.publishedByName ? ` · ${item.publishedByName}` : ''}` : 'Опубликованной ревизии нет'}</small></div>
    {hasLocalDraft && <p className={`handbook-local-draft ${hasUnsavedChanges ? 'unsaved' : ''}`} role="status">{hasUnsavedChanges ? `Есть несохранённые изменения · черновик сохранится при переключении этапа. Основа редакции: ${baseRevision}.` : 'Черновик сохранён.'}</p>}
    {canEdit && <details className="handbook-editor-details"><summary>{item.draftRevision ? `Изменить черновик · ревизия ${item.draftRevision}` : 'Подготовить черновик'}</summary>
      <div className="handbook-editor-grid">
        <label className="field"><span>Заголовок</span><input maxLength={120} value={article.title} disabled={busy} onChange={(event) => setField('title', event.target.value)} /></label>
        <label className="field"><span>Кратко</span><textarea maxLength={500} rows={2} value={article.summary} disabled={busy} onChange={(event) => setField('summary', event.target.value)} /></label>
        <label className="field"><span>Фокус</span><textarea maxLength={500} rows={2} value={article.focus} disabled={busy} onChange={(event) => setField('focus', event.target.value)} /></label>
        <label className="field"><span>Проверки · по одной на строку</span><textarea maxLength={2400} rows={3} value={article.checks.join('\n')} disabled={busy} onChange={(event) => setField('checks', event.target.value.split('\n').slice(0, 8))} /></label>
        <label className="field"><span>Граница ответственности</span><textarea maxLength={500} rows={2} value={article.boundary} disabled={busy} onChange={(event) => setField('boundary', event.target.value)} /></label>
        <label className="field"><span>Предлагаемый черновик сообщения</span><textarea maxLength={1000} rows={3} value={article.draftMessage} disabled={busy} onChange={(event) => setField('draftMessage', event.target.value)} /></label>
        <label className="field"><span>Рекомендация без открытых задач</span><textarea maxLength={300} rows={2} value={article.recommendationWhenNoOpenTask} disabled={busy} onChange={(event) => setField('recommendationWhenNoOpenTask', event.target.value)} /></label>
      </div>
      {item.draftStageCurrent === false && <p className="handbook-stale-note">Схема изменилась после сохранения черновика. Проверьте текст перед новой публикацией.</p>}
      {hasUnsavedChanges && <p className="handbook-stale-note">Сохранение использует ревизию {baseRevision}. Если черновик изменился в другом окне, сервер отклонит запись; обновите страницу и сравните версии.</p>}
      <button className="secondary" type="button" disabled={busy || !item.current || !hasUnsavedChanges} onClick={() => onSave(article)}>{busy ? 'Сохраняем…' : 'Сохранить черновик'}</button>
    </details>}
    {canPublish && <div className="handbook-review" aria-labelledby="handbook-review-title">
      <div className="handbook-review-heading"><h3 id="handbook-review-title">Проверка черновика перед публикацией</h3><span>{item.draftRevision ? `Черновик · ревизия ${item.draftRevision}` : 'Черновика пока нет'}</span></div>
      {item.draftArticle && item.draftRevision ? <>
        <div className="handbook-review-copy" aria-label={`Точный текст черновика, ревизия ${item.draftRevision}`}>
          {handbookArticleFields.map(({ key, label }) => <section key={key} className="handbook-review-field"><b>{label}</b><pre>{handbookFieldText(item.draftArticle!, key) || '—'}</pre></section>)}
        </div>
        <section className="handbook-diff" aria-label={item.publishedRevision ? 'Отличия от опубликованной инструкции' : 'Отличия от исходного текста'}>
          <h4>{item.publishedRevision ? 'Отличия от опубликованной инструкции' : 'Отличия от исходного текста'}</h4>
          {published ? changedFields.length ? <div className="handbook-diff-list">{changedFields.map(({ key, label }) => <div key={key} className="handbook-diff-field"><b>{label}</b><div><small>{item.publishedRevision ? 'Опубликовано' : 'Исходный текст'}</small><pre>{handbookFieldText(published, key) || '—'}</pre></div><div><small>Черновик</small><pre>{handbookFieldText(item.draftArticle!, key) || '—'}</pre></div></div>)}</div>
            : <p>Содержимое совпадает с {item.publishedRevision ? 'опубликованной инструкцией' : 'исходным текстом'}.</p> : <p>Опубликованной статьи и исходного текста нет; текст черновика приведён выше.</p>}
        </section>
        <label className="handbook-review-confirm"><input type="checkbox" checked={confirmedRevision === item.draftRevision} disabled={busy}
          onChange={(event) => setConfirmedRevision(event.target.checked ? item.draftRevision ?? null : null)} />
          Я проверил(а) текст черновика и его отличия, ревизия {item.draftRevision}.</label>
      </> : <p className="handbook-review-empty">Для просмотра и публикации сначала сохраните черновик с ролью руководителя.</p>}
      <div className="handbook-publish-row"><span>{item.draftStageCurrent === false ? 'Схема изменилась: руководитель должен проверить и повторно сохранить черновик.' : item.draftRevision ? `После публикации будет привязана ревизия ${item.draftRevision}.` : 'Ожидается сохранённая ревизия черновика.'}</span>
        <button className="primary" type="button" disabled={busy || !item.current || !item.draftRevision || item.draftStageCurrent === false || confirmedRevision !== item.draftRevision} onClick={onPublish}>{busy ? 'Публикуем…' : 'Привязать и опубликовать'}</button></div>
    </div>}
  </section>;
}

function CmsIntakePage({ items, loading, busy, onRefresh, onClaim }: {
  items: CmsIntake[]; loading: boolean; busy: boolean; onRefresh: () => void; onClaim: (id: string) => void;
}) {
  return <div className="cms-intake-page">
    <div className="page-heading"><div><div className="eyebrow">ВХОДЯЩИЕ ОБРАЩЕНИЯ</div><h1>Входящие с сайта</h1><p>Назначьте себе обращение, чтобы работать с ним в своей очереди.</p></div><button className="secondary" disabled={loading} onClick={onRefresh}>↻ {loading ? 'Обновляем…' : 'Обновить'}</button></div>
    {items.length ? <div className="cms-intake-list">{items.map((item) => <article className="panel cms-intake-row" key={item.id}>
      <div><div className="eyebrow">ТЕСТОВАЯ СРЕДА CMS · {KIND_LABEL[item.kind]}</div><h2>{item.organizationName ?? item.personName ?? item.title}</h2><p>{item.title}</p><small>Внешний ключ {item.originReference} · {formatDate(item.createdAt)}</small></div>
      <button className="primary" disabled={busy} onClick={() => onClaim(item.id)}>{busy ? 'Назначаем…' : 'Взять в работу'}</button>
    </article>)}</div> : <section className="panel cms-intake-empty" aria-live="polite"><span className="cms-intake-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7.5 5.1 4h13.8L21 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M3 8h5l1.5 2h5L16 8h5M9 15h6"/></svg></span><div><h2>{loading ? 'Загружаем обращения…' : 'Неназначенных обращений нет'}</h2><p>Новые обращения появятся здесь после загрузки из CMS.</p></div></section>}
  </div>;
}

function ExchangeMonitorPage({ monitor, imports, loading, busy, onRefresh, onOpenUsers, onCmsPull, onLmsPull, onFailure, onRetry, onOutcome, onOpenActivity }: {
  monitor: ExchangeMonitor | null; imports: AdminImportSummary | null; loading: boolean; busy: boolean; onRefresh: () => void; onOpenUsers: () => void; onCmsPull: () => void; onLmsPull: () => void;
  onFailure: (system: 'cms' | 'lms', mode: 'http_error' | 'reject_next') => void; onRetry: (id: string) => void;
  onOutcome: (id: string, outcome: 'perform' | 'reject', factKind: LearningFact['factKind']) => void; onOpenActivity?: (id: string) => void;
}) {
  const [factKind, setFactKind] = useState<LearningFact['factKind']>('enrollment');
  const services = monitor?.services;
  const returnedJobs = monitor?.jobs ?? [];
  const latestJob = returnedJobs.reduce<ExchangeMonitorJob | null>((latest, job) => {
    if (!latest || Date.parse(job.updatedAt) > Date.parse(latest.updatedAt)) return job;
    return latest;
  }, null);
  const retryableErrorCount = returnedJobs.filter((job) => job.status === 'retryable_error' || job.status === 'rejected').length;
  const flowRows: { direction: ExchangeMonitorJob['direction']; system: 'cms' | 'lms'; label: string }[] = [
    { direction: 'cms_to_crm', system: 'cms', label: 'CMS → CRM · обращения' },
    { direction: 'crm_to_cms', system: 'cms', label: 'CRM → CMS · согласованный статус' },
    { direction: 'crm_to_lms', system: 'lms', label: 'CRM → LMS · учебный запрос' },
    { direction: 'lms_to_crm', system: 'lms', label: 'LMS → CRM · учебные факты' },
  ];
  const statusLabels: Record<ExchangeJob['status'], string> = {
    queued: 'В очереди', sent: 'Отправлено', accepted: 'Принято', performed: 'Выполнено', rejected: 'Отклонено', retryable_error: 'Ошибка обмена',
  };
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return <div className="exchange-page">
    <section className="panel exchange-overview" aria-labelledby="exchange-overview-title">
      <div className="exchange-overview-heading"><div><h1 id="exchange-overview-title">Состояние системы</h1><p>Обмены и качество данных</p></div><button className="secondary" onClick={onRefresh} disabled={loading}>↻ {loading ? 'Обновляем…' : 'Обновить'}</button></div>
      <div className="exchange-overview-intro"><strong>Источники не подключены</strong><p>Реальные CMS и LMS к CRM не подключены; ниже показано состояние локальных тестовых сервисов.</p></div>
      <ul className="exchange-overview-flows" aria-label="Состояние направлений обмена">
        {flowRows.map((flow) => {
          const latest = returnedJobs.filter((job) => job.direction === flow.direction)
            .reduce<ExchangeMonitorJob | null>((current, job) => !current || Date.parse(job.updatedAt) > Date.parse(current.updatedAt) ? job : current, null);
          const serviceStatus = services?.[flow.system]?.status;
          const isUnavailable = serviceStatus === 'unavailable';
          const hasError = latest?.status === 'retryable_error' || latest?.status === 'rejected';
          const statusText = isUnavailable ? 'Тестовый сервис недоступен' : latest ? (hasError ? 'Ошибка' : statusLabels[latest.status]) : monitor ? serviceStatus === 'ok' ? 'Нет заданий' : 'Нет данных' : loading ? 'Проверяем…' : 'Нет данных';
          const statusClass = isUnavailable ? 'attention' : latest ? hasError || latest.status === 'rejected' ? 'attention' : latest.status === 'performed' || latest.status === 'accepted' ? 'healthy' : 'pending' : 'pending';
          const detail = latest ? `Последнее задание: ${hasError ? 'ошибка' : statusLabels[latest.status]} · обновлено ${formatDate(latest.updatedAt)}${serviceStatus === 'ok' ? ` · тестовый сервис ${flow.system.toUpperCase()} на связи` : serviceStatus === 'unavailable' ? ` · тестовый сервис ${flow.system.toUpperCase()} не отвечает` : ''}` : monitor ? isUnavailable ? `Локальный тестовый сервис ${flow.system.toUpperCase()} не отвечает.` : serviceStatus === 'ok' ? `Локальный тестовый сервис ${flow.system.toUpperCase()} на связи; в списке нет заданий этого направления.` : `Состояние локального тестового сервиса ${flow.system.toUpperCase()} пока неизвестно.` : loading ? 'Получаем состояние тестовых сервисов и список заданий.' : 'Состояние тестовых сервисов пока неизвестно.';
          return <li className="exchange-overview-flow" key={flow.direction}><div className="exchange-overview-flow-copy"><strong>{flow.label}</strong><span>{detail}</span></div><span className={`exchange-overview-status ${statusClass}`}>{statusText}</span></li>;
        })}
      </ul>
      <div className="exchange-overview-metrics" aria-label="Краткие показатели">
        <article className="exchange-overview-metric"><span>Последнее обновление среди 200 заданий</span><strong>{latestJob ? formatDate(latestJob.updatedAt) : monitor ? 'Заданий нет' : loading ? 'Загружаем…' : 'Нет данных'}</strong></article>
        <article className="exchange-overview-metric"><span>Ошибки и отклонения</span><strong>{monitor ? retryableErrorCount : loading ? 'Загружаем…' : 'Нет данных'}</strong><small>В выданном списке, не более 200 заданий</small></article>
        <article className="exchange-overview-metric"><span>Строк импорта для разбора</span><strong>{imports ? imports.counts.previewRowsRequiringResolution : loading ? 'Загружаем…' : 'Нет данных'}</strong></article>
      </div>
      <div className="exchange-overview-actions">
        <button className="primary" type="button" onClick={() => jumpTo('exchange-controls')}>Открыть обмены и соответствия</button>
        <button className="secondary" type="button" onClick={() => jumpTo('import-quality')}>Проверить качество данных</button>
        <button className="secondary" type="button" onClick={onOpenUsers}>Пользователи и области доступа</button>
      </div>
      <p className="exchange-overview-footnote">Показатели заданий рассчитаны по выданному списку до 200 записей. Учебные сведения и финансовая аналитика здесь не рассчитываются без подтверждённых источников и разрешений.</p>
    </section>
    <div className="exchange-contract" role="note">В этом сценарии <b>отправлено</b>, <b>принято</b> и <b>выполнено</b> — разные состояния. Тестовая среда LMS самостоятельно сообщает учебные факты; CRM только показывает их.</div>
    <section className="exchange-services" id="exchange-controls" aria-label="Управление тестовыми сервисами">
      {(['cms', 'lms'] as const).map((system) => {
        const service = services?.[system]; const status = service?.status === 'ok' ? 'На связи' : service?.status === 'unavailable' ? 'Недоступен' : loading ? 'Проверяем…' : 'Нет данных';
        return <article className="panel exchange-service" key={system}>
          <div className="section-top"><div><div className="eyebrow">ТЕСТОВАЯ СРЕДА</div><h2>{system.toUpperCase()}</h2></div><span className={`exchange-indicator ${service?.status === 'ok' ? 'ok' : service?.status === 'unavailable' ? 'down' : ''}`}>{status}</span></div>
          <p>{system === 'cms' ? 'Входящие обращения и подтверждение статуса обработки.' : 'Запрос передачи и факты обучения только для просмотра.'}</p>
          <div className="exchange-actions"><button className="secondary" disabled={busy} onClick={() => system === 'cms' ? onCmsPull() : onLmsPull()}>{system === 'cms' ? 'Получить обращения' : 'Получить события'}</button>
            <button className="text-button" disabled={busy} onClick={() => onFailure(system, 'http_error')}>Сбой следующего запроса</button>
            <button className="text-button" disabled={busy} onClick={() => onFailure(system, 'reject_next')}>Отклонить следующую команду</button>
          </div>
        </article>;
      })}
    </section>
    <section className="panel exchange-panel" id="import-quality" aria-labelledby="import-quality-title">
      <div className="section-top"><div><div className="eyebrow">КОНТРОЛЬ КАЧЕСТВА ДАННЫХ</div><h2 id="import-quality-title">Импорт</h2></div><span className="history-count">{imports ? Object.values(imports.counts.byStatus).reduce((sum, count) => sum + count, 0) : 0}</span></div>
      <p className="muted-copy">Руководитель загружает и подтверждает файлы. Здесь видны только состояния и количество строк для разбора, без исходных данных.</p>
      <div className="exchange-job-list">
        <article className="exchange-job"><b>Ожидают разбора: {imports?.counts.previewRowsRequiringResolution ?? 0}</b><span>Загрузки с предпросмотром: {imports?.counts.byStatus.preview_ready ?? 0} · завершены: {imports?.counts.byStatus.completed ?? 0}</span><span>Контакты: {imports?.counts.byTarget.contacts ?? 0} · поставщики: {imports?.counts.byTarget.vendors ?? 0} · индивидуальные заявки: {imports?.counts.byTarget.individual_applications ?? 0}</span></article>
        {imports?.recentJobs.filter((job) => job.previewRowsRequiringResolution > 0).map((job) => <article className="exchange-job" key={job.id}>
          <div className="exchange-job-head"><div><b>{job.target === 'contacts' ? 'Контакты' : job.target === 'vendors' ? 'Поставщики' : 'Индивидуальные заявки'}</b><span>{formatDate(job.created_at)} · {job.id.slice(0, 8)}</span></div><span className="exchange-status retryable_error">Строк для разбора: {job.previewRowsRequiringResolution}</span></div>
        </article>)}
      </div>
    </section>
    <section className="panel exchange-panel" id="exchange-details" aria-labelledby="exchange-details-title">
      <div className="section-top"><div><div className="eyebrow">СОХРАНЁННЫЕ ОБМЕНЫ</div><h2 id="exchange-details-title">Задания и события</h2></div><span className="history-count">{monitor?.jobs.length ?? 0}</span></div>
      {!monitor?.jobs.length ? <p className="muted-copy">Обменов пока нет. Загрузите обращение из CMS или отправьте запрос из индивидуальной активности на стадии передачи в LMS.</p> : <div className="exchange-job-list">
        {monitor.jobs.map((job) => <article className="exchange-job" key={job.id}>
          <div className="exchange-job-head"><div><b>{EXCHANGE_DIRECTION[job.direction]}</b><span>{exchangeOperationLabel(job.operation)} · {formatDate(job.createdAt)}</span></div><span className={`exchange-status ${job.status}`}>{EXCHANGE_STATUS[job.status]}</span></div>
          {job.activityId && onOpenActivity ? <button className="exchange-activity-link" onClick={() => onOpenActivity(job.activityId!)}>Открыть активность · {job.activityId.slice(0, 8)}</button> : job.activityLinked && <span className="exchange-linked-indicator">Связано с активностью</span>}
          <div className="exchange-job-meta"><span>Попытки: {job.attemptCount} / {monitor.retryLimit}</span>{job.correlationId && <code>Идентификатор связи: {job.correlationId}</code>}{job.externalEventId && <code>Идентификатор события: {job.externalEventId}</code>}</div>
          {job.error && <p className="exchange-error">В последнем обмене есть техническая ошибка.</p>}
          {!job.error && job.lastError && <p className="exchange-error">{job.lastError}</p>}
          <div className="exchange-job-actions">
            {(job.canRetry ?? (job.status === 'retryable_error' && job.attemptCount < monitor.retryLimit && job.operation !== 'prepare_access')) && <button className="secondary" disabled={busy} onClick={() => onRetry(job.id)}>Повторить запрос</button>}
            {job.direction === 'crm_to_lms' && ['accepted', 'performed'].includes(job.status) && <>
              <label className="exchange-fact-choice"><span>Факт, который сообщит тестовая среда LMS</span><select value={factKind} disabled={busy} onChange={(event) => setFactKind(event.target.value as LearningFact['factKind'])}><option value="enrollment">Зачисление</option><option value="learning_started">Начало обучения</option><option value="learning_completed">Завершение обучения</option></select></label>
              <button className="secondary" disabled={busy} onClick={() => onOutcome(job.id, 'perform', factKind)}>Подтвердить в тестовой среде LMS</button>
              <button className="text-button" disabled={busy} onClick={() => onOutcome(job.id, 'reject', factKind)}>Отклонить в тестовой среде LMS</button>
            </>}
          </div>
        </article>)}
      </div>}
      <p className="exchange-footnote">В представлении LMS CRM сохраняет только тип факта, источник, время и ссылку. Платёжные данные не запрашиваются и не создаются.</p>
    </section>
  </div>;
}

function reportMetricUnit(value: number, unit: string) {
  if (unit === 'активностей') return russianNounForm(value, 'активность', 'активности', 'активностей');
  if (unit === 'активностей CRM') return russianNounForm(value, 'активность CRM', 'активности CRM', 'активностей CRM');
  if (unit === 'мест') return russianNounForm(value, 'место', 'места', 'мест');
  if (unit === 'событий') return russianNounForm(value, 'событие', 'события', 'событий');
  return unit;
}

function ReportsPage({ api, token, hasManagerAccess, onOpenActivity }: { api: ApiCall; token: Token; hasManagerAccess: boolean; onOpenActivity: (activityId: string) => void }) {
  const [reportId, setReportId] = useState<ReportSnapshot['reportId']>('crm_portfolio');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState('');
  const [ownerSub, setOwnerSub] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [productId, setProductId] = useState('');
  const [programId, setProgramId] = useState('');
  const [learningFactKind, setLearningFactKind] = useState('');
  const [requestedPlacesRecorded, setRequestedPlacesRecorded] = useState<boolean | undefined>();
  const [includeClosed, setIncludeClosed] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [programs, setPrograms] = useState<LearningProgram[]>([]);
  const [owners, setOwners] = useState<{ ownerSub: string; ownerName: string }[]>([]);
  const [organizations, setOrganizations] = useState<ReportOrganization[]>([]);
  const [snapshot, setSnapshot] = useState<ReportSnapshot | null>(null);
  const [chartId, setChartId] = useState(() => sessionStorage.getItem('lct-report-chart-v1') ?? '');
  const [exportFormat, setExportFormat] = useState(() => sessionStorage.getItem('lct-report-format-v1') ?? 'xlsx');
  const [reportExportColumns, setReportExportColumns] = useState<ReportExportColumn[]>([]);
  const [selectedExportColumnKeys, setSelectedExportColumnKeys] = useState<string[]>(() => {
    try {
      const saved = sessionStorage.getItem('lct-report-columns-v1');
      const parsed: unknown = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) && parsed.every((key) => typeof key === 'string') ? parsed : [];
    } catch { return []; }
  });
  const [exportJobs, setExportJobs] = useState<ReportExport[]>([]);
  const [page, setPage] = useState(1);
  const [pageLoading, setPageLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [downloadingExportId, setDownloadingExportId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const snapshotRequestGeneration = useRef(0);
  const drilldownResultsHeadingRef = useRef<HTMLHeadingElement>(null);
  function isCurrentSnapshotRequest(generation: number, snapshotId?: string) {
    return generation === snapshotRequestGeneration.current &&
      (snapshotId === undefined || sessionStorage.getItem('lct-report-snapshot-v1') === snapshotId);
  }
  useEffect(() => {
    api<{ products: Product[] }>('/api/catalog').then((catalog) => setProducts(catalog.products)).catch(() => undefined);
    api<{ items: LearningProgram[] }>('/api/programs').then((catalog) => setPrograms(catalog.items)).catch(() => undefined);
    if (hasManagerAccess) {
      api<{ ownerSub: string; ownerName: string }[]>('/api/reports/owners').then(setOwners).catch(() => undefined);
      api<ReportOrganization[]>('/api/reports/organizations').then(setOrganizations).catch(() => undefined);
    }
    api<ReadyReport[]>('/api/reports/ready').then((reports) => {
      const columns = reports[0]?.exportColumns ?? [];
      setReportExportColumns(columns);
      const saved = sessionStorage.getItem('lct-report-columns-v1');
      if (saved === null) setSelectedExportColumnKeys(columns.map((column) => column.key));
      else {
        try {
          const savedKeys: unknown = JSON.parse(saved);
          const previousDefault = Array.isArray(savedKeys) && columns.filter((column) => column.key !== 'programNames').every((column) => savedKeys.includes(column.key)) && savedKeys.length === columns.length - 1;
          setSelectedExportColumnKeys(Array.isArray(savedKeys) ? columns.filter((column) => previousDefault || savedKeys.includes(column.key)).map((column) => column.key) : columns.map((column) => column.key));
        } catch { setSelectedExportColumnKeys(columns.map((column) => column.key)); }
      }
    }).catch(() => undefined);
    api<ReportExport[]>('/api/reports/exports?limit=20').then((jobs) => {
      setExportJobs((current) => mergeReportExports(current, jobs));
    }).catch((reason: Error) => setError(reason.message));
  }, [api, hasManagerAccess]);

  useEffect(() => {
    const snapshotId = sessionStorage.getItem('lct-report-snapshot-v1');
    if (!snapshotId) return;
    const generation = ++snapshotRequestGeneration.current;
    let cancelled = false;
    let removedInvalidSnapshot = false;
    setLoading(true); setPageLoading(false); setError('');
    const savedPage = Number(sessionStorage.getItem('lct-report-page-v1') ?? '1');
    const requestedPage = Number.isSafeInteger(savedPage) && savedPage > 0 ? savedPage : 1;
    api<ReportSnapshot>(`/api/reports/snapshots/${snapshotId}?page=${requestedPage}`).then((saved) => {
      if (cancelled || !isCurrentSnapshotRequest(generation, snapshotId) || saved.snapshotId !== snapshotId) return;
      setSnapshot(saved); setPage(saved.page); setReportId(saved.reportId); setFrom(saved.filters.from ?? ''); setTo(saved.filters.to ?? '');
      setKind(saved.filters.kind ?? ''); setOwnerSub(saved.filters.ownerSub ?? ''); setProductId(saved.filters.productId ?? ''); setProgramId(saved.filters.programId ?? '');
      setOrganizationId(saved.filters.organizationId ?? '');
      setLearningFactKind(saved.filters.learningFactKind ?? ''); setRequestedPlacesRecorded(saved.filters.requestedPlacesRecorded); setIncludeClosed(saved.filters.includeClosed);
      const savedChartId = sessionStorage.getItem('lct-report-chart-v1');
      const restoredChartId = saved.charts.some((chart) => chart.id === savedChartId) ? savedChartId! : saved.chart.id;
      setChartId(restoredChartId); sessionStorage.setItem('lct-report-chart-v1', restoredChartId);
      requestAnimationFrame(() => document.querySelector('.page-scroll')?.scrollTo({ top: Number(sessionStorage.getItem('lct-report-scroll-v1') ?? 0) }));
    }).catch((reason: Error) => {
      if (!cancelled && isCurrentSnapshotRequest(generation, snapshotId)) {
        sessionStorage.removeItem('lct-report-snapshot-v1');
        removedInvalidSnapshot = true;
        setError(reason.message);
      }
    }).finally(() => {
      if (!cancelled && generation === snapshotRequestGeneration.current &&
        (removedInvalidSnapshot || sessionStorage.getItem('lct-report-snapshot-v1') === snapshotId)) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    const pending = exportJobs.filter((job) => ['queued', 'running'].includes(job.status));
    if (!pending.length) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      const results = await Promise.all(pending.map(async (job): Promise<{ id: string; updated?: ReportExport; remove?: boolean; error?: Error }> => {
        try { return { id: job.id, updated: await api<ReportExport>(`/api/reports/exports/${job.id}`) }; }
        catch (reason) {
          const status = (reason as Error & { status?: number }).status;
          return status === 403 || status === 404 ? { id: job.id, remove: true } : { id: job.id, error: reason as Error };
        }
      }));
      if (cancelled) return;
      const removedIds = new Set(results.filter((result) => result.remove).map((result) => result.id));
      const updates = results.flatMap((result) => result.updated ? [result.updated] : []);
      if (removedIds.size || updates.length) {
        setExportJobs((current) => mergeReportExports(current.filter((job) => !removedIds.has(job.id)), updates));
      }
      const pollError = results.find((result) => result.error)?.error;
      if (pollError) setError(pollError.message);
      timer = window.setTimeout(() => { void poll(); }, 1200);
    };
    timer = window.setTimeout(() => { void poll(); }, 1200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, exportJobs]);

  async function loadSnapshot(overrides: Partial<{ from: string; to: string; kind: string; ownerSub: string; organizationId: string; productId: string; programId: string; learningFactKind: string; requestedPlacesRecorded: boolean | undefined; includeClosed: boolean }> = {}, targetReportId = reportId, focusDrilldownResults = false) {
    const generation = ++snapshotRequestGeneration.current;
    setLoading(true); setPageLoading(false); setError(''); setSnapshot(null); setPage(1); sessionStorage.removeItem('lct-report-snapshot-v1');
    try {
      const current = { from, to, kind, ownerSub, organizationId, productId, programId, learningFactKind, requestedPlacesRecorded, includeClosed, ...overrides };
      const filters: Record<string, unknown> = { includeClosed: current.includeClosed };
      for (const field of ['from', 'to', 'kind', 'ownerSub', 'organizationId', 'productId', 'programId', 'learningFactKind'] as const) if (current[field]) filters[field] = current[field];
      if (current.requestedPlacesRecorded !== undefined) filters.requestedPlacesRecorded = current.requestedPlacesRecorded;
      const saved = await api<ReportSnapshot>('/api/reports/snapshots', { method: 'POST', body: JSON.stringify({ reportId: targetReportId, filters }) });
      if (!isCurrentSnapshotRequest(generation)) return;
      setSnapshot(saved); setPage(saved.page); setChartId(saved.chart.id); sessionStorage.setItem('lct-report-chart-v1', saved.chart.id); sessionStorage.setItem('lct-report-snapshot-v1', saved.snapshotId); sessionStorage.setItem('lct-report-page-v1', String(saved.page));
      if (focusDrilldownResults) requestAnimationFrame(() => {
        if (isCurrentSnapshotRequest(generation, saved.snapshotId)) drilldownResultsHeadingRef.current?.focus();
      });
    } catch (reason) { if (isCurrentSnapshotRequest(generation)) setError((reason as Error).message); }
    finally { if (isCurrentSnapshotRequest(generation)) setLoading(false); }
  }

  function createSnapshot(event: React.FormEvent) { event.preventDefault(); setLearningFactKind(''); setRequestedPlacesRecorded(undefined); void loadSnapshot({ learningFactKind: '', requestedPlacesRecorded: undefined }); }

  async function loadSnapshotPage(nextPage: number) {
    if (!snapshot || nextPage < 1 || nextPage > Math.max(1, Math.ceil(snapshot.rowCount / snapshot.pageSize))) return;
    const snapshotId = snapshot.snapshotId;
    const generation = ++snapshotRequestGeneration.current;
    setLoading(false); setPageLoading(true); setError('');
    try {
      const saved = await api<ReportSnapshot>(`/api/reports/snapshots/${snapshotId}?page=${nextPage}`);
      if (isCurrentSnapshotRequest(generation, snapshotId) && saved.snapshotId === snapshotId) {
        setSnapshot(saved); setPage(saved.page); sessionStorage.setItem('lct-report-page-v1', String(saved.page));
      }
    } catch (reason) { if (isCurrentSnapshotRequest(generation, snapshotId)) setError((reason as Error).message); }
    finally { if (isCurrentSnapshotRequest(generation, snapshotId)) setPageLoading(false); }
  }

  function drillToSeries(filter: ReportChart['series'][number]['filter']) {
    if (!snapshot || !filter) return;
    const filters = {
      ...snapshot.filters,
      ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
      ...(filter.productId !== undefined ? { productId: filter.productId } : {}),
      ...(filter.learningFactKind !== undefined ? { learningFactKind: filter.learningFactKind } : {}),
      ...(filter.requestedPlacesRecorded !== undefined ? { requestedPlacesRecorded: filter.requestedPlacesRecorded } : {}),
    };
    setReportId(snapshot.reportId);
    setFrom(filters.from ?? ''); setTo(filters.to ?? ''); setKind(filters.kind ?? ''); setOwnerSub(filters.ownerSub ?? ''); setOrganizationId(filters.organizationId ?? ''); setProductId(filters.productId ?? ''); setProgramId(filters.programId ?? '');
    setLearningFactKind(filters.learningFactKind ?? ''); setRequestedPlacesRecorded(filters.requestedPlacesRecorded); setIncludeClosed(filters.includeClosed);
    void loadSnapshot(filters, snapshot.reportId, true);
  }

  async function startExport() {
    if (!snapshot || reportId !== snapshot.reportId || from !== (snapshot.filters.from ?? '') || to !== (snapshot.filters.to ?? '') ||
      kind !== (snapshot.filters.kind ?? '') || ownerSub !== (snapshot.filters.ownerSub ?? '') || organizationId !== (snapshot.filters.organizationId ?? '') || productId !== (snapshot.filters.productId ?? '') || programId !== (snapshot.filters.programId ?? '') ||
      learningFactKind !== (snapshot.filters.learningFactKind ?? '') || requestedPlacesRecorded !== snapshot.filters.requestedPlacesRecorded ||
      includeClosed !== snapshot.filters.includeClosed) return;
    setExporting(true); setError('');
    const dataExport = ['xls', 'xlsx', 'csv', 'pdf', 'json'].includes(exportFormat);
    const columns = reportExportColumns.filter((column) => selectedExportColumnKeys.includes(column.key)).map((column) => column.key);
    try {
      const created = await api<ReportExport>('/api/reports/exports', { method: 'POST', body: JSON.stringify({ snapshotId: snapshot.snapshotId, format: exportFormat, ...(currentChart && ['png', 'chart-pdf'].includes(exportFormat) ? { chartId: currentChart.id } : {}), ...(dataExport && reportExportColumns.length ? { columns } : {}) }) });
      setExportJobs((current) => [created, ...current.filter((job) => job.id !== created.id)].slice(0, 20));
    }
    catch (reason) { setError((reason as Error).message); }
    finally { setExporting(false); }
  }

  function saveExportColumns(next: string[]) {
    setSelectedExportColumnKeys(next); sessionStorage.setItem('lct-report-columns-v1', JSON.stringify(next));
  }

  function toggleExportColumn(key: string) {
    const selected = new Set(selectedExportColumnKeys);
    if (selected.has(key)) selected.delete(key); else selected.add(key);
    const next = reportExportColumns.filter((column) => selected.has(column.key)).map((column) => column.key);
    saveExportColumns(next);
  }

  async function downloadFile(exportJob: ReportExport) {
    if (!exportJob.downloadUrl) return;
    setDownloadingExportId(exportJob.id); setError('');
    try {
      const accessToken = await token();
      const response = await fetch(`${API}${exportJob.downloadUrl}`, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body?.message ?? 'Файл недоступен по текущей области доступа.');
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = objectUrl;
      link.download = exportJob.fileName ?? `report.${exportJob.format}`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (reason) { setError((reason as Error).message); }
    finally { setDownloadingExportId(null); }
  }

  const shownRows = snapshot?.rows ?? [];
  const numericMetrics = snapshot?.metrics.filter((metric) => metric.value !== null) ?? [];
  const unavailableMetrics = snapshot?.metrics.filter((metric) => metric.value === null) ?? [];
  const hasActivityCreationPeriod = snapshot?.metrics.some((metric) => metric.timeScope === 'selected_activity_creation_period') ?? false;
  const learningFactMetrics = snapshot?.metrics.filter((metric) => metric.grouping === 'learning_fact_event') ?? [];
  const learningFactScope = learningFactMetrics[0]?.timeScope;
  const learningFactCoverage = learningFactMetrics[0]?.completeness.split(';')[0].replace(/\.$/, '');
  const zeroLearningFacts = learningFactMetrics.length > 0 && learningFactMetrics.every((metric) => metric.value === 0);
  const requestedPlacesMetric = numericMetrics.find((metric) => metric.key === 'requestedPlaces');
  const requestedPlacesCoverageMatch = requestedPlacesMetric?.completeness.match(/(?:Записано для|места записаны для) (\d+) из (\d+) корпоративных активностей/);
  const requestedPlacesCoverage = requestedPlacesCoverageMatch ? `Планы: ${requestedPlacesCoverageMatch[1]} из ${requestedPlacesCoverageMatch[2]}` : '';
  const pageCount = snapshot ? Math.max(1, Math.ceil(snapshot.rowCount / snapshot.pageSize)) : 1;
  const currentChart = snapshot?.charts.find((chart) => chart.id === chartId) ?? snapshot?.chart;
  const maxChart = Math.max(1, ...(currentChart?.series.map((item) => item.value) ?? []));
  const chartTicks = [0, maxChart];
  const dataExport = ['xls', 'xlsx', 'csv', 'pdf', 'json'].includes(exportFormat);
  const filtersChanged = Boolean(snapshot && (
    reportId !== snapshot.reportId || from !== (snapshot.filters.from ?? '') || to !== (snapshot.filters.to ?? '') ||
    kind !== (snapshot.filters.kind ?? '') || ownerSub !== (snapshot.filters.ownerSub ?? '') || organizationId !== (snapshot.filters.organizationId ?? '') ||
    productId !== (snapshot.filters.productId ?? '') || programId !== (snapshot.filters.programId ?? '') || learningFactKind !== (snapshot.filters.learningFactKind ?? '') ||
    requestedPlacesRecorded !== snapshot.filters.requestedPlacesRecorded || includeClosed !== snapshot.filters.includeClosed
  ));
  const activeAdvancedFilters = [kind, ownerSub, organizationId, productId, programId, !includeClosed].filter(Boolean).length;
  return <div className="reports-page">
    <div className="reports-heading"><div><div className="eyebrow">ГОТОВЫЕ ОТЧЁТЫ</div><h1 id="reports-heading" tabIndex={-1}>Показатели и данные CRM</h1><p>Метрики, график, исходные строки и выгрузка рассчитаны из одного сохранённого среза.</p></div></div>
    {error && <div className="alert error" role="alert"><span>!</span>{error}<button onClick={() => setError('')}>Закрыть</button></div>}
    <form className="panel reports-filters" onSubmit={createSnapshot}>
      <div className="reports-filter-primary">
        <label><span>Отчёт</span><select value={reportId} onChange={(event) => setReportId(event.target.value as ReportSnapshot['reportId'])}><option value="crm_portfolio">Портфель CRM</option><option value="demand_learning">Спрос и факты обучения</option></select></label>
        <label><span>Созданы с</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>Созданы по</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button className="primary" disabled={loading}>{loading ? 'Считаем…' : 'Показать отчёт'}</button>
      </div>
      <details className="reports-advanced-filters">
        <summary>Дополнительные фильтры{activeAdvancedFilters ? ` · выбрано: ${activeAdvancedFilters}` : ''}</summary>
        <div className="reports-filter-grid">
          <label><span>Тип процесса</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Все процессы</option><option value="university">{PROCESS_LABEL.university}</option><option value="corporate">{PROCESS_LABEL.corporate}</option><option value="individual">{PROCESS_LABEL.individual}</option></select></label>
          {hasManagerAccess && <label><span>Ответственный КАМ</span><select value={ownerSub} onChange={(event) => setOwnerSub(event.target.value)}><option value="">Все доступные КАМ</option>{owners.map((owner) => <option key={owner.ownerSub} value={owner.ownerSub}>{owner.ownerName}</option>)}</select></label>}
          {hasManagerAccess && <label><span>Организация</span><select aria-label="Фильтр отчёта по организации" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}><option value="">Все доступные организации</option>{organizationId && snapshot?.filters.organizationId === organizationId && !organizations.some((organization) => organization.organizationId === organizationId) && <option value={organizationId}>{snapshot.filters.organizationName ?? organizationId}</option>}{organizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.organizationName}</option>)}</select></label>}
          <label><span>Продукт</span><select value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Все продукты</option>{products.map((product) => <option key={product.id} value={product.id}>{productLabel(product.name)}</option>)}</select></label>
          <label><span>Учебная программа</span><select value={programId} onChange={(event) => setProgramId(event.target.value)}><option value="">Все программы</option>{programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}</select></label>
          <label className="reports-checkbox"><input type="checkbox" checked={includeClosed} onChange={(event) => setIncludeClosed(event.target.checked)} /><span>Включить закрытые активности</span></label>
        </div>
      </details>
      {(learningFactKind || requestedPlacesRecorded !== undefined) && <div className="reports-drilldown-filter" role="status"><span>Фильтр из графика: {learningFactKind === 'enrollment' ? 'зачисление' : learningFactKind === 'learning_started' ? 'начало обучения' : learningFactKind === 'learning_completed' ? 'завершение обучения' : requestedPlacesRecorded ? 'места указаны' : 'места не указаны'}</span><button type="button" className="text-button" onClick={() => { setLearningFactKind(''); setRequestedPlacesRecorded(undefined); void loadSnapshot({ learningFactKind: '', requestedPlacesRecorded: undefined }); }}>Сбросить</button></div>}
      {filtersChanged && <p role="status">Фильтры изменены. Нажмите «Показать отчёт», чтобы применить их к данным и выгрузке.</p>}
    </form>
    {!snapshot && <section className="panel reports-empty"><h2>Выберите срез</h2><p>Начните с готового отчёта. Даты периода относятся к созданию активности по московскому времени.</p></section>}
    {snapshot && <>
      <div className="reports-result-head"><div><div className="eyebrow">{snapshot.title.toLocaleUpperCase('ru-RU')}</div><h2 ref={drilldownResultsHeadingRef} tabIndex={-1} className="programmatic-focus-target">{formatRussianCount(snapshot.rowCount, 'активность', 'активности', 'активностей')} в срезе</h2><p>Срез на {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(snapshot.asOf))} · выгрузка и постраничный просмотр используют один сохранённый срез. Применённые фильтры: {snapshot.filters.from || snapshot.filters.to ? `${snapshot.filters.from ?? 'начало'} — ${snapshot.filters.to ?? 'сегодня'}` : 'все даты'}, {snapshot.filters.kind ? (PROCESS_LABEL[snapshot.filters.kind as Kind] ?? snapshot.filters.kind) : 'все процессы'}, {snapshot.filters.includeClosed ? 'с закрытыми' : 'только открытые'}{snapshot.filters.ownerSub ? `, КАМ: ${owners.find((owner) => owner.ownerSub === snapshot.filters.ownerSub)?.ownerName ?? snapshot.filters.ownerSub}` : ''}{snapshot.filters.organizationId ? `, организация: ${snapshot.filters.organizationName ?? organizations.find((organization) => organization.organizationId === snapshot.filters.organizationId)?.organizationName ?? snapshot.filters.organizationId}` : ''}{snapshot.filters.productId ? `, продукт: ${products.find((product) => product.id === snapshot.filters.productId)?.name ?? snapshot.filters.productId}` : ''}{snapshot.filters.programId ? `, программа: ${programs.find((program) => program.id === snapshot.filters.programId)?.name ?? snapshot.filters.programId}` : ''}{snapshot.filters.learningFactKind ? `, факт LMS: ${snapshot.filters.learningFactKind}` : ''}{snapshot.filters.requestedPlacesRecorded !== undefined ? `, заявленные места: ${snapshot.filters.requestedPlacesRecorded ? 'указаны' : 'не указаны'}` : ''}.</p>{snapshot.filters.programId && <p>По программе показаны связанные активности. Места и факты обучения относятся к активности целиком и не распределяются между её программами.</p>}</div>
      </div>
      {(hasActivityCreationPeriod || learningFactScope) && <div className="reports-metric-context" aria-label="Период и полнота данных">
        {hasActivityCreationPeriod && <span>{snapshot.reportId === 'demand_learning' ? 'Активности и планы: выбранный период создания.' : 'Показатели: выбранный период создания активностей.'}</span>}
        {learningFactScope && <span>Факты LMS: {learningFactScope === 'selected_activities_all_available_fact_times' ? 'все доступные даты связанных активностей' : REPORT_METRIC_TIME_SCOPE_LABEL[learningFactScope]}.</span>}
        {learningFactCoverage && <span>{learningFactCoverage}.</span>}
        {zeroLearningFacts && <span>Ноль известных событий не доказывает отсутствие обучения.</span>}
      </div>}
      {numericMetrics.length > 0 && <div className="reports-metric-grid">{numericMetrics.map((metric) => <article className="reports-metric panel" key={metric.key}><span>{metric.label}</span><strong>{metric.value!.toLocaleString('ru-RU')}</strong><small>{reportMetricUnit(metric.value!, metric.unit)}</small>{metric.key === 'requestedPlaces' && requestedPlacesCoverage && <small className="reports-metric-coverage">{requestedPlacesCoverage}</small>}</article>)}</div>}
      {unavailableMetrics.length > 0 && <section className="panel reports-unavailable-panel" aria-labelledby="reports-unavailable-title"><h3 id="reports-unavailable-title">Недостаточно данных для показателей</h3><ul>{unavailableMetrics.map((metric) => <li key={metric.key}>{metric.label} · {metric.unit}</li>)}</ul><p>Причины и источники раскрыты в «Источники и определения показателей».</p></section>}
      <section className="panel reports-chart-panel"><div className="section-top"><div><div className="eyebrow">ГРАФИК · НАЖМИТЕ НА СТОЛБЕЦ ДЛЯ ДЕТАЛИЗАЦИИ</div><h2>{currentChart?.title}</h2></div><div className="reports-chart-tools"><label className="reports-chart-unit"><span>Показать</span><select value={currentChart?.id ?? ''} onChange={(event) => { setChartId(event.target.value); sessionStorage.setItem('lct-report-chart-v1', event.target.value); }}>{snapshot.charts.map((chart) => <option key={chart.id} value={chart.id}>{chart.title}</option>)}</select></label><span className="reports-chart-unit">{currentChart?.unit}</span></div></div>
        {currentChart?.series.length ? <div className="reports-chart">
          <div className="reports-chart-axis" aria-hidden="true"><span /><div>{chartTicks.map((tick) => <span key={tick} style={{ left: `${tick / maxChart * 100}%` }}>{tick.toLocaleString('ru-RU')}</span>)}</div><span /></div>
          {currentChart.series.map((item) => <button className="reports-chart-row" type="button" key={item.label} onClick={() => drillToSeries(item.filter)} aria-label={`Показать исходные активности: ${item.label}, ${item.value.toLocaleString('ru-RU')}`}><span>{item.label}</span><div className="reports-chart-track"><i style={{ width: `${item.value / maxChart * 100}%` }} /></div><b>{item.value.toLocaleString('ru-RU')}</b></button>)}
        </div> : <p className="muted-copy">Нет данных для графика.</p>}
        <p className="reports-chart-note">{currentChart?.id === 'product-demand-places' ? 'Каждое заявленное число мест целиком относится к каждому продукту, связанному с корпоративной активностью. При нескольких продуктах значения повторяются; продуктовые суммы не складываются. Нажатие строит срез данных только из активностей с записанными местами для этого продукта.' : currentChart?.id === 'learning-events' ? 'Столбец показывает число записанных событий. Нажатие открывает активности с выбранным видом факта; одна активность может содержать несколько событий, поэтому число строк может быть меньше числа событий.' : 'Нажатие на столбец строит новый доступный срез данных с дополнительным фильтром. По продуктам активности могут пересекаться: число связанных активностей по продуктам не суммируется в уникальные активности.'}</p>
      </section>
      <section className="panel reports-source-panel"><div className="section-top"><div><div className="eyebrow">ИСХОДНЫЕ ЗАПИСИ</div><h2>Активности отчёта</h2></div><span className="history-count">{snapshot.rowCount.toLocaleString('ru-RU')}</span></div>
        <div className="reports-table-wrap"><table className="reports-table"><thead><tr><th>Активность</th><th>Тип и стадия</th><th>Ответственный</th><th>Создана</th>{snapshot.reportId === 'demand_learning' && <><th>Заявлено мест</th><th>Факты LMS</th></>}</tr></thead><tbody>
          {shownRows.map((row) => <tr key={row.activityId}><td><b>{row.title}</b><small>{row.organizationName ?? row.personName ?? row.originLabel}{row.productNames.length ? ` · ${row.productNames.map(productLabel).join(', ')}` : ''}</small><button className="report-row-open" onClick={() => onOpenActivity(row.activityId)}>Открыть активность</button></td><td>{row.kindLabel}<small>{row.stageLabel ?? 'Стадия не указана'}{row.closed ? ' · закрыта' : ''}</small></td><td>{row.ownerName}</td><td>{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'Europe/Moscow' }).format(new Date(row.createdAt))}</td>{snapshot.reportId === 'demand_learning' && <><td>{row.requestedPlaces === null ? 'Не указано' : row.requestedPlaces.toLocaleString('ru-RU')}</td><td>{row.enrollmentFactCount} событий зачисления · {row.learningStartedFactCount} событий начала · {row.learningCompletedFactCount} событий завершения</td></>}</tr>)}
          {!shownRows.length && <tr><td colSpan={snapshot.reportId === 'demand_learning' ? 6 : 4}>Нет записей по выбранным фильтрам.</td></tr>}
        </tbody></table></div>
        {snapshot.rowCount > 0 && <div className="reports-pagination"><span>{pageLoading ? 'Загружаем страницу…' : `Строки ${(page - 1) * snapshot.pageSize + 1}–${Math.min(page * snapshot.pageSize, snapshot.rowCount)} из ${snapshot.rowCount.toLocaleString('ru-RU')}`}</span><div><button className="secondary" disabled={pageLoading || page <= 1} onClick={() => void loadSnapshotPage(page - 1)}>Назад</button><span>Страница {page} из {pageCount}</span><button className="secondary" disabled={pageLoading || page >= pageCount} onClick={() => void loadSnapshotPage(page + 1)}>Дальше</button></div></div>}
      </section>
      <div className="panel reports-export-panel"><div className="reports-export-controls"><label><span>Формат выгрузки</span><select value={exportFormat} onChange={(event) => { setExportFormat(event.target.value); sessionStorage.setItem('lct-report-format-v1', event.target.value); }}><option value="xls">XLS · Excel 97–2003</option><option value="xlsx">XLSX · Excel</option><option value="csv">CSV · UTF-8</option><option value="pdf">PDF · отчёт</option><option value="json">JSON · данные</option><option value="png">PNG · график</option><option value="chart-pdf">PDF · график</option></select></label><button className="primary" disabled={filtersChanged || exporting || (dataExport && reportExportColumns.length > 0 && selectedExportColumnKeys.length === 0)} onClick={startExport}>{exporting ? 'Ставим в очередь…' : 'Создать файл'}</button></div></div>
      {dataExport && reportExportColumns.length > 0 && <details className="panel report-column-picker"><summary>Колонки выгрузки · {selectedExportColumnKeys.length} из {reportExportColumns.length}</summary><div className="report-column-picker-body"><p>По умолчанию включены все доступные поля. График и показатели отчёта сохраняются полностью.</p><div className="report-column-actions"><button type="button" className="secondary" onClick={() => saveExportColumns(reportExportColumns.map((column) => column.key))}>Выбрать все</button><button type="button" className="secondary" onClick={() => saveExportColumns([])}>Очистить выбор</button></div><div className="report-column-grid">{reportExportColumns.map((column) => <label key={column.key}><input type="checkbox" checked={selectedExportColumnKeys.includes(column.key)} onChange={() => toggleExportColumn(column.key)} /><span>{column.label}</span></label>)}</div>{selectedExportColumnKeys.length === 0 && <p className="report-column-empty" role="status">Выберите хотя бы одну колонку, чтобы создать файл.</p>}</div></details>}
      <details className="panel reports-definitions"><summary>Источники и определения показателей</summary><dl>{snapshot.metrics.map((metric) => <div key={metric.key}><dt>{metric.label} · {metric.unit}</dt><dd>{metric.definition} Источник: {metric.source}. {metric.completeness} Период показателя: {REPORT_METRIC_TIME_SCOPE_LABEL[metric.timeScope]}. Группировка: {REPORT_METRIC_GROUPING_LABEL[metric.grouping]}.{metric.lastFactOccurredAt ? ` Последний факт произошёл: ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(metric.lastFactOccurredAt))}.` : ''} Время получения из источника: {metric.sourceReceivedAt ? formatDate(metric.sourceReceivedAt) : metric.grouping === 'learning_fact_event' ? 'не подтверждено для всех событий' : 'не фиксируется'}.</dd></div>)}</dl>{snapshot.notes.map((note) => <p key={note}>{note}</p>)}<p>Источники: {snapshot.sources.join('; ')}.</p></details>
    </>}
    <section className="panel reports-export-list" aria-label="Недавние выгрузки">
      <div className="section-top"><div><div className="eyebrow">СОХРАНЁННЫЕ ФАЙЛЫ</div><h2>Недавние выгрузки</h2></div><span className="history-count">{exportJobs.length}</span></div>
      {exportJobs.length ? <ul>{exportJobs.map((job) => <li className={`report-job-row ${job.status}`} key={job.id}>
        <div className="report-job-copy"><div className="report-job-title"><strong>{job.reportId === 'crm_portfolio' ? 'Портфель CRM' : 'Спрос и факты обучения'} · {job.format === 'chart-pdf' ? 'PDF график' : job.format.toUpperCase()}</strong><span>{job.rowCount.toLocaleString('ru-RU')} строк · {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(job.createdAt))}</span></div>
          <span className="report-job-state" aria-live="polite">{REPORT_EXPORT_STATUS_LABEL[job.status]}</span>
          {job.status === 'completed' && job.fileName && <small>{job.fileName}</small>}
          {job.status === 'failed' && job.errorMessage && <small>{job.errorMessage}</small>}
        </div>
        {job.status === 'completed' && job.downloadUrl && <button className="secondary" disabled={downloadingExportId !== null} onClick={() => void downloadFile(job)}>{downloadingExportId === job.id ? 'Скачиваем…' : 'Скачать'}</button>}
      </li>)}</ul> : <p className="report-export-empty">Пока нет сохранённых файлов. Созданные выгрузки появятся здесь.</p>}
    </section>
  </div>;
}

function ManagerPortfolio({ overview, loading, onRefresh, onQueue }: {
  overview: ManagerOverview | null; loading: boolean; onRefresh: () => void; onQueue: (segment: Segment, collection: Collection, drilldown?: QueueDrilldown) => void;
}) {
  if (!overview) return <section className="manager-empty panel"><div className="eyebrow">ПОРТФЕЛЬ КОМАНДЫ</div><h1>Открытые взаимодействия</h1><p>{loading ? 'Загружаем срез портфеля…' : 'Не удалось загрузить портфель.'}</p>{!loading && <button className="secondary" onClick={onRefresh}>Повторить</button>}</section>;
  const { metrics } = overview;
  const asOf = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(overview.asOf));
  const statCards: { label: string; value: number; hint: string; collection: Collection }[] = [
    { label: 'Открыто', value: metrics.totalOpen, hint: 'в портфеле', collection: 'all' },
    { label: 'Просрочено', value: metrics.overdue, hint: 'есть задача со сроком в прошлом', collection: 'overdue' },
    { label: 'Ожидают ответа', value: metrics.awaitingReply, hint: 'зафиксирован такой исход контакта', collection: 'awaiting_reply' },
    { label: 'Без следующего шага', value: metrics.noNextStep, hint: 'нет открытой задачи', collection: 'no_next_step' },
  ];
  const segmentColors: Record<Segment, string> = {
    university: 'var(--crm-accent)',
    company: 'var(--crm-success)',
    individual: 'var(--crm-warning)',
  };
  let segmentCursor = 0;
  const segmentStops = MANAGER_SEGMENTS.map((item) => {
    const value = item.value(overview);
    const start = segmentCursor;
    segmentCursor += metrics.totalOpen ? value / metrics.totalOpen * 100 : 0;
    return `${segmentColors[item.key]} ${start}% ${segmentCursor}%`;
  });
  const segmentDonut = metrics.totalOpen ? `conic-gradient(${segmentStops.join(', ')})` : 'var(--crm-neutral-container)';
  const nextStepCounts = [metrics.overdue, metrics.totalOpen - metrics.noNextStep - metrics.overdue, metrics.noNextStep];
  const nextStepLabels = ['Просрочена задача', 'Есть задача, срок не прошёл', 'Нет открытой задачи'];
  const nextStepClasses = ['overdue', 'scheduled', 'missing'];
  const maxStageCount = Math.max(0, ...overview.pipeline.flatMap((lane) => lane.stages.map((stage) => stage.count)));
  return <div className="manager-page">
    <div className="page-heading manager-heading">
      <div><div className="eyebrow">ГЛАВНЫЙ РАЗДЕЛ · ПОРТФЕЛЬ КОМАНДЫ</div><h1>Показатели команды</h1><p>Открытые активности, требующие внимания, и распределение портфеля. Продажи, обучение и платежи здесь не считаются.</p></div>
      <button className="secondary manager-refresh" onClick={onRefresh} disabled={loading} aria-label="Обновить портфель">↻ <span>{loading ? 'Обновляем…' : 'Обновить'}</span></button>
    </div>
    <div className="manager-asof">Данные на {asOf}</div>
    <section className="manager-snapshot" aria-label="Состояние портфеля">
      <button className="manager-snapshot-main" onClick={() => onQueue('all', 'all')} aria-label={`Открыто в портфеле: ${metrics.totalOpen}. Показать все активности.`}>
        <span className="manager-snapshot-kicker">В РАБОТЕ СЕЙЧАС <span aria-hidden="true">↗</span></span>
        <span className="manager-snapshot-total"><strong>{metrics.totalOpen}</strong><span>открытых<br />взаимодействий</span></span>
        <span className="manager-snapshot-caption">Вузы · компании · физлица<br />Откройте полный портфель команды</span>
        <span className="manager-snapshot-mark" aria-hidden="true" />
      </button>
      <div className="manager-snapshot-signals" aria-label="Требуют внимания">
        {statCards.slice(1).map((card, index) => <button key={card.label} className={`manager-signal ${card.collection === 'overdue' ? 'manager-signal-urgent' : ''}`} onClick={() => onQueue('all', card.collection)}>
          <span className="manager-signal-index" aria-hidden="true">0{index + 1}</span>
          <span className="manager-signal-copy"><b>{card.label}</b><small>{card.hint}</small></span>
          <strong>{card.value}</strong><span className="manager-signal-arrow" aria-hidden="true">↗</span>
        </button>)}
      </div>
    </section>
    <div className="manager-chart-grid">
    <section className="manager-panel panel" aria-labelledby="manager-segments-title">
      <div className="section-top"><div><div className="eyebrow">РАЗБИВКА</div><h2 id="manager-segments-title">Активности по типу</h2></div><span className="manager-units">Открытые CRM-активности · шт.</span></div>
      <div className="manager-segment-chart" role="group" aria-label="Доли открытых активностей по сегментам">
        <div className="manager-donut-wrap">
          <div className="manager-donut" role="img" aria-label={`Распределение ${formatRussianCount(metrics.totalOpen, 'активность', 'активности', 'активностей')} по типам`} style={{ background: segmentDonut }}>
            <span><strong>{metrics.totalOpen}</strong><small>всего</small></span>
          </div>
        </div>
        <div className="manager-segment-legend">
        {MANAGER_SEGMENTS.map((item) => {
          const value = item.value(overview);
          const share = metrics.totalOpen ? Math.round((value / metrics.totalOpen) * 100) : 0;
          return <button key={item.key} className="manager-segment-row" onClick={() => onQueue(item.key, 'all')} aria-label={`${item.label}: ${formatRussianCount(value, 'активность', 'активности', 'активностей')}, ${share}% от портфеля. Открыть очередь сегмента.`}>
            <i className={`manager-segment-swatch ${item.key}`} aria-hidden="true" /><span className="manager-segment-label">{item.label}</span><strong>{value}</strong><small>{share}%</small>
          </button>;
        })}
        </div>
      </div>
    <p className="manager-panel-note">Доля рассчитана от открытых активностей; сегменты не пересекаются. Нажмите строку, чтобы открыть очередь.</p>
    </section>
    <section className="manager-panel panel manager-next-step" aria-labelledby="manager-next-step-title">
      <div className="section-top"><div><div className="eyebrow">СЛЕДУЮЩИЙ ШАГ</div><h2 id="manager-next-step-title">Состояние задач</h2></div><span className="manager-units">Открытые CRM-активности · шт.</span></div>
      {metrics.totalOpen ? <>
        <div className="manager-next-step-bar" role="img" aria-label={`Из ${metrics.totalOpen} открытых активностей: ${nextStepLabels.map((label, index) => `${label.toLowerCase()} — ${nextStepCounts[index]}`).join('; ')}`}>
          {nextStepCounts.map((count, index) => count > 0 && <span key={nextStepClasses[index]} className={`manager-next-step-part ${nextStepClasses[index]}`} style={{ width: `${count / metrics.totalOpen * 100}%` }} />)}
        </div>
        <div className="manager-next-step-legend">
          {nextStepCounts.map((count, index) => {
            const content = <><i className={`manager-next-step-swatch ${nextStepClasses[index]}`} aria-hidden="true" /><span>{nextStepLabels[index]}</span><strong>{count}</strong><small>{Math.round(count / metrics.totalOpen * 100)}%</small></>;
            return index === 1 ? <div key={nextStepClasses[index]} className="manager-next-step-row">{content}</div> : <button key={nextStepClasses[index]} className="manager-next-step-row manager-next-step-link" onClick={() => onQueue('all', index === 0 ? 'overdue' : 'no_next_step')} aria-label={`${nextStepLabels[index]}: ${formatRussianCount(count, 'активность', 'активности', 'активностей')}. Открыть очередь.`}>{content}</button>;
          })}
        </div>
      </> : <p className="manager-next-step-empty">Нет открытых активностей · 0 шт.</p>}
      <p className="manager-panel-note">Текущий срез на {asOf}. Каждая активность учтена один раз по ближайшей открытой задаче.</p>
    </section>
    </div>
    <section className="pipeline-panel panel" aria-labelledby="pipeline-title">
      <div className="section-top"><div><div className="eyebrow">СОСТОЯНИЕ ПОРТФЕЛЯ</div><h2 id="pipeline-title">Где находятся открытые активности</h2></div><span className="manager-units">Текущий этап · шт.</span></div>
      <p className="manager-panel-note">Каждая активность показана на своём текущем этапе; при возврате учитывается фактический этап. Полная длина маркера соответствует {maxStageCount ? formatRussianCount(maxStageCount, 'активность', 'активности', 'активностей') : 'нулевому количеству активностей'} на общей шкале маршрутов. Возраст указан для самой давно не обновлявшейся записи на этапе; физлица разделены по версиям маршрута.</p>
      <div className="pipeline-lanes">{overview.pipeline.map((lane) => <section className={`pipeline-lane pipeline-${lane.kind} pipeline-${lane.routeVersion}`} key={`${lane.kind}:${lane.routeVersion}`} aria-label={`${lane.kind === 'university' ? 'Вузы' : lane.kind === 'corporate' ? 'Компании' : 'Физлица'} · ${lane.routeLabel}`}>
        <div className="pipeline-lane-heading"><span className={`kind-icon ${lane.kind}`} aria-hidden="true">{lane.kind === 'university' ? 'У' : lane.kind === 'corporate' ? 'К' : 'Ф'}</span><div><b>{lane.kind === 'university' ? 'Вузы' : lane.kind === 'corporate' ? 'Компании' : 'Физлица'}</b><small>{lane.routeLabel}</small></div></div>
        <div className="pipeline-stages">{lane.stages.every((stage) => stage.count === 0) ? <p className="pipeline-lane-empty">Открытых активностей на этом маршруте нет.</p> : lane.stages.map((stage, index) => {
          const oldest = stage.oldestUpdatedAt ? Math.max(0, Math.floor((Date.parse(overview.asOf) - Date.parse(stage.oldestUpdatedAt)) / 86400000)) : null;
          const segment: Segment = lane.kind === 'university' ? 'university' : lane.kind === 'corporate' ? 'company' : 'individual';
          const barWidth = maxStageCount ? stage.count / maxStageCount * 100 : 0;
          return <button key={stage.key} className="pipeline-stage" onClick={() => onQueue(segment, 'all', { stageKeys: stage.stageKeys, routeVersion: lane.kind === 'individual' ? lane.routeVersion as 'legacy' | 'v2' : undefined, stageLabel: `${stage.label} · ${lane.routeLabel}` })} aria-label={`${stage.label}: ${formatRussianCount(stage.count, 'активность', 'активности', 'активностей')}${oldest === null ? '' : `, старейшее обновление ${oldest} дн. назад`}. Открыть очередь этапа.`}>
            <span className="pipeline-stage-index">{String(index + 1).padStart(2, '0')}</span><span className="pipeline-stage-name">{stage.label}</span><strong>{stage.count}</strong>
            <span className="pipeline-stage-track" aria-hidden="true"><i style={{ width: `${barWidth}%` }} /></span>
            <span className="pipeline-stage-age">{stage.count === 0 ? 'Нет активностей' : oldest === null ? 'Дата обновления неизвестна' : `Максимум без обновления · ${formatRussianCount(oldest, 'день', 'дня', 'дней')}`}</span>
          </button>;
        })}</div>
      </section>)}</div>
    </section>
    <div className="manager-detail-grid">
      <section className="manager-panel panel" aria-labelledby="manager-owners-title">
        <div className="section-top"><div><div className="eyebrow">НАГРУЗКА</div><h2 id="manager-owners-title">По ответственным</h2></div></div>
        {overview.byOwner.length ? <div className="manager-table-wrap"><table className="manager-table"><thead><tr><th>КАМ</th><th>Открыто</th><th>Просрочено</th></tr></thead><tbody>{overview.byOwner.map((owner) => <tr key={owner.ownerSub}><th scope="row"><button className="manager-drilldown-link" onClick={() => onQueue('all', 'all', { ownerSub: owner.ownerSub, ownerName: owner.ownerName })} aria-label={`Показать портфель ${owner.ownerName}: ${formatRussianCount(owner.open, 'активность', 'активности', 'активностей')}`}>{owner.ownerName} <span aria-hidden="true">↗</span></button></th><td>{owner.open}</td><td className={owner.overdue ? 'manager-overdue' : ''}>{owner.overdue}</td></tr>)}</tbody></table></div> : <p className="manager-panel-note">Открытых активностей нет.</p>}
      </section>
      <section className="manager-panel panel" aria-labelledby="manager-products-title">
        <div className="section-top"><div><div className="eyebrow">СВЯЗИ</div><h2 id="manager-products-title">Продукты</h2></div></div>
        {overview.topProducts.length ? <div className="manager-table-wrap"><table className="manager-table"><thead><tr><th>Продукт</th><th>Активности</th></tr></thead><tbody>{overview.topProducts.slice(0, 5).map((product) => <tr key={product.id}><th scope="row"><button className="manager-drilldown-link" onClick={() => onQueue('all', 'all', { productId: product.id, productName: productLabel(product.name) })} aria-label={`Показать ${formatRussianCount(product.activityCount, 'активность', 'активности', 'активностей')} продукта ${productLabel(product.name)}`}>{productLabel(product.name)} <span aria-hidden="true">↗</span></button></th><td>{product.activityCount}</td></tr>)}</tbody></table></div> : <p className="manager-panel-note">У открытых активностей пока нет связанных продуктов.</p>}
        <p className="manager-panel-note">Число уникальных открытых активностей с продуктом.</p>
      </section>
    </div>
    <details className="manager-definitions"><summary>Как считаются показатели</summary><dl>{Object.entries(overview.definitions).map(([key, definition]) => <div key={key}><dt>{MANAGER_DEFINITION_LABELS[key] ?? key}</dt><dd>{definition}</dd></div>)}</dl></details>
  </div>;
}

function ActivityRow({ item, showOwner, open }: { item: Activity; showOwner: boolean; open: () => void }) {
  const dueClass = item.nextTaskDueAt && new Date(item.nextTaskDueAt).getTime() < Date.now() ? 'overdue' : '';
  const rowContext = `${KIND_LABEL[item.kind]}${item.origin === 'external_ready' ? ' · Внешний заказ' : item.origin === 'cms_mock' ? ' · тестовая среда CMS' : item.originLabel === 'Заявка с сайта' ? ' · заявка с сайта' : ''}${item.productNames?.length ? ` · ${item.productNames.slice(0, 2).map(productLabel).join(', ')}${item.productNames.length > 2 ? ` +${item.productNames.length - 2}` : ''}` : ''}`;
  return <button className="activity-row" onClick={open}>
    <span className={`kind-icon ${item.kind}`}>{item.kind === 'university' ? 'У' : item.kind === 'corporate' ? 'К' : 'Ф'}</span>
    <span className="row-main"><span className="row-client">{item.organizationName ?? item.personName ?? 'Без названия'}</span><span className="row-context">{rowContext}</span>{showOwner && item.ownerName && <span className="row-context row-owner">Ответственный: {item.ownerName}</span>}<span className="row-context row-activity-title" title={item.title}>{item.title}</span></span>
    <span className="row-next"><span className="row-next-title">{item.nextTaskTitle ?? 'Следующий шаг не задан'}</span><span className={`row-due ${dueClass}`}>{formatDate(item.nextTaskDueAt)}</span></span>
    <span className="stage-badge">{item.stageLabel}</span>
    {item.allowedNextLabels?.length ? <span className="row-milestone">{item.allowedNextLabels.length > 1 ? 'Доступные переходы: ' : 'Следующий рубеж: '}{item.allowedNextLabels.join(' / ')}</span> : <span className="row-milestone">Следующий переход не задан</span>}
    <span className="priority-mark" title={`Приоритет ${item.priority}`}>{'●'.repeat(Math.max(1, Math.min(item.priority, 5)))}</span>
    <span className="row-arrow">›</span>
  </button>;
}

function CreateActivity({ catalog, contacts, api, busy, close, create }: { catalog: Catalog; contacts: ImportedContact[]; api: ApiCall; busy: boolean; close: () => void; create: (data: Record<string, unknown>) => Promise<void> }) {
  const [currentCatalog, setCurrentCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [kind, setKind] = useState<Kind>('university');
  const [title, setTitle] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [personName, setPersonName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactId, setContactId] = useState('');
  const [payerOrganizationName, setPayerOrganizationName] = useState('');
  const [payerOrganizationId, setPayerOrganizationId] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [productIds, setProductIds] = useState<string[]>([]);
  const [programIds, setProgramIds] = useState<string[]>([]);
  const [programs, setPrograms] = useState<LearningProgram[]>([]);
  const [programError, setProgramError] = useState('');
  const [programLoading, setProgramLoading] = useState(true);
  const [submitError, setSubmitError] = useState('');
  const submissionLock = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const hasDraft = kind !== 'university' || [title, organizationId, organizationName, personName, contactName, contactId, payerOrganizationName, payerOrganizationId, email, phone].some((value) => value.trim().length > 0) || productIds.length > 0 || programIds.length > 0;
  useEffect(() => {
    let mounted = true;
    api<Catalog>('/api/catalog').then((value) => { if (mounted) setCurrentCatalog(value); }).catch((reason: Error) => { if (mounted) setCatalogError(reason.message); });
    api<{ items: LearningProgram[] }>('/api/programs').then((value) => { if (mounted) setPrograms(value.items); }).catch((reason: Error) => { if (mounted) setProgramError(reason.message); }).finally(() => { if (mounted) setProgramLoading(false); });
    return () => { mounted = false; };
  }, [api]);
  const requestClose = () => {
    if (busy || submissionLock.current) return;
    if (hasDraft && !window.confirm('В форме есть несохранённые данные. Закрыть и удалить черновик?')) return;
    close();
  };
  closeRef.current = requestClose;
  const organizations = (currentCatalog ?? catalog).organizations.filter((organization) => kind === 'university' ? organization.segment === 'university' : true);
  const payerOrganizations = (currentCatalog ?? catalog).organizations;
  const titleForKind: Record<Kind, string> = { university: 'Новая активность с вузом', individual: 'Новая активность с физлицом', corporate: 'Новая активность с компанией' };
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = dialogRef.current?.parentElement;
    const background = Array.from(backdrop?.parentElement?.children ?? []).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop);
    const previousBackgroundState = background.map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    previousBackgroundState.forEach(({ element }) => { element.inert = true; element.setAttribute('aria-hidden', 'true'); });

    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
      ?? dialog?.querySelector<HTMLElement>('button:not([disabled])');
    (firstFocusable ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousBackgroundState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', ariaHidden);
      });
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}><section ref={dialogRef} className="modal create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title" tabIndex={-1}>
    <div className="modal-heading"><div><div className="eyebrow">НОВАЯ ЗАПИСЬ</div><h2 id="create-title">Создать активность</h2></div><button type="button" className="icon-button" onClick={requestClose} aria-label="Закрыть" disabled={busy}>×</button></div>
    <div className="type-picker" role="group" aria-label="Тип процесса">{(['university', 'individual', 'corporate'] as Kind[]).map((value) => <button type="button" key={value} disabled={busy} aria-pressed={kind === value} className={kind === value ? 'active' : ''} onClick={() => { if (value === kind) return; setKind(value); setOrganizationId(''); setPayerOrganizationId(''); setContactId(''); }}>{PROCESS_LABEL[value]}</button>)}</div>
    {kind === 'individual' && <p className="process-hint" role="note">Если индивидуальное обучение оплачивает компания, укажите её ниже как плательщика. Тип процесса останется индивидуальным.</p>}
    <form onSubmit={async (event) => { event.preventDefault(); if (busy || submissionLock.current) return; submissionLock.current = true; setSubmitError(''); const data: Record<string, unknown> = { kind, title: title.trim(), productIds, programIds }; if (kind === 'individual') Object.assign(data, { personId: contactId || undefined, personName: contactId ? undefined : personName.trim(), email: contactId ? undefined : email.trim() || undefined, phone: contactId ? undefined : phone.trim() || undefined, payerOrganizationId: payerOrganizationId || undefined, payerOrganizationName: payerOrganizationId ? undefined : payerOrganizationName.trim() || undefined }); else Object.assign(data, { organizationId: organizationId || undefined, organizationName: organizationId ? undefined : organizationName.trim(), personId: contactId || undefined, personName: contactId ? undefined : contactName.trim() || undefined, email: contactId ? undefined : email.trim() || undefined, phone: contactId ? undefined : phone.trim() || undefined }); try { await create(data); } catch (reason) { setSubmitError(reason instanceof Error ? reason.message : 'Не удалось создать активность. Проверьте данные и попробуйте ещё раз.'); } finally { submissionLock.current = false; } }}>
      {submitError && <div className="alert error" role="alert"><span>!</span>{submitError}</div>}
      <label className="field"><span>Название активности <b>*</b></span><input maxLength={180} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={titleForKind[kind]} required /></label>
      {kind === 'individual' ? <>
        <label className="field"><span>Физлицо <b>*</b></span><select disabled={busy} value={contactId} onChange={(event) => setContactId(event.target.value)}><option value="">Новый контакт</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactOptionLabel(contact)}</option>)}</select></label>
        {!contactId && <><label className="field"><span>Имя и фамилия <b>*</b></span><input maxLength={180} disabled={busy} value={personName} onChange={(event) => setPersonName(event.target.value)} placeholder="Имя и фамилия" required /></label><div className="two-fields"><label className="field"><span>Электронная почта</span><input type="email" maxLength={254} disabled={busy} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.ru" /></label><label className="field"><span>Телефон</span><input maxLength={64} disabled={busy} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+7 …" /></label></div></>}
        <div className="org-entry"><label className="field"><span>Организация-плательщик <small>если применимо</small></span><select disabled={busy} value={payerOrganizationId} onChange={(event) => setPayerOrganizationId(event.target.value)}><option value="">Новая организация или без плательщика</option>{payerOrganizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>{!payerOrganizationId && <label className="field"><span>Название организации-плательщика</span><input maxLength={180} disabled={busy} value={payerOrganizationName} onChange={(event) => setPayerOrganizationName(event.target.value)} placeholder="Можно оставить пустым" /></label>}</div>
      </> : <>
        <label className="field"><span>{kind === 'university' ? 'Учебное заведение' : 'Корпоративный заказчик'} <b>*</b></span><select disabled={busy} value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}><option value="">Создать новую организацию</option>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
        {!organizationId && <label className="field"><span>Название организации <b>*</b></span><input maxLength={180} disabled={busy} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} placeholder={kind === 'university' ? 'Название вуза' : 'Название компании'} required /></label>}
        <div className="contact-heading">Контактное лицо <small>необязательно</small></div>
        <label className="field"><span>Сохранённый контакт</span><select disabled={busy} value={contactId} onChange={(event) => setContactId(event.target.value)}><option value="">Новый контакт</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactOptionLabel(contact)}</option>)}</select></label>
        {!contactId && <><div className="two-fields"><label className="field"><span>Имя</span><input maxLength={180} disabled={busy} value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Имя и фамилия" /></label><label className="field"><span>Электронная почта</span><input type="email" maxLength={254} disabled={busy} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.ru" /></label></div><label className="field"><span>Телефон</span><input maxLength={64} disabled={busy} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+7 …" /></label></>}
      </>}
      <fieldset className="product-field" disabled={busy || !currentCatalog || Boolean(catalogError)}><legend>ИТ-продукты <small>можно выбрать несколько</small></legend><div className="product-choices">{(currentCatalog?.products ?? []).map((product) => <label key={product.id}><input type="checkbox" checked={productIds.includes(product.id)} onChange={() => setProductIds((ids) => ids.includes(product.id) ? ids.filter((id) => id !== product.id) : [...ids, product.id])} />{productLabel(product.name)}</label>)}</div>{!currentCatalog && !catalogError && <small>Загружаем актуальный каталог…</small>}{catalogError && <small role="alert">Не удалось загрузить каталог: {catalogError}</small>}</fieldset>
      <fieldset className="product-field" disabled={busy || programLoading || Boolean(programError)}><legend>Учебные программы <small>можно выбрать несколько</small></legend><div className="product-choices">{programs.map((program) => <label key={program.id}><input type="checkbox" checked={programIds.includes(program.id)} onChange={() => setProgramIds((ids) => ids.includes(program.id) ? ids.filter((id) => id !== program.id) : [...ids, program.id])} />{program.name}</label>)}</div>{programLoading && <small>Загружаем программы…</small>}{!programLoading && !programs.length && !programError && <small>Программы пока не добавлены в каталог.</small>}{programError && <small role="alert">Не удалось загрузить программы: {programError}</small>}</fieldset>
      <div className="modal-footer"><button type="button" className="secondary" onClick={requestClose} disabled={busy}>Отмена</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Создаём…' : 'Создать активность'}</button></div>
    </form>
  </section></div>;
}

const STEP_STATUS_LABELS: Record<UniversityStepStatus, string> = {
  unrecorded: 'Не записан', in_progress: 'В работе', waiting: 'Ожидание', documented: 'Зафиксировано в CRM', not_applicable: 'Не применяется',
};

function UniversityStepsCard({ value, busy, onSave, onCorrectionReturn, onDirtyChange }: {
  value: UniversitySteps; busy: boolean; onSave: (stepId: string, input: UniversityStepInput) => Promise<boolean>;
  onCorrectionReturn: (input: CorrectionReturnInput) => Promise<boolean>; onDirtyChange: (section: string, dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState<{ stepId: string; correction: boolean } | null>(null);
  const [status, setStatus] = useState<Exclude<UniversityStepStatus, 'unrecorded'>>('in_progress');
  const [note, setNote] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [evidenceSource, setEvidenceSource] = useState('');
  const [formError, setFormError] = useState('');
  const savedDraft = useRef('');
  const currentDraft = JSON.stringify({ status, note, evidenceReference, evidenceSource });
  useEffect(() => onDirtyChange('university-step', editing !== null && currentDraft !== savedDraft.current), [editing, currentDraft]);
  const groups = [...new Map(value.steps.map((step) => [step.groupKey, { key: step.groupKey, label: step.groupLabel }])).values()];
  const canReturn = (step: UniversityStep) => step.stepId === 'U05'
    && ['documented', 'waiting'].includes(value.steps.find((item) => item.stepId === 'U04')?.status ?? '');

  function startEdit(step: UniversityStep, correction = false) {
    if (editing && currentDraft !== savedDraft.current && !window.confirm('Несохранённые изменения пункта будут отброшены. Продолжить?')) return;
    savedDraft.current = JSON.stringify({ status: step.status === 'unrecorded' ? 'in_progress' : step.status, note: correction ? '' : step.note,
      evidenceReference: correction ? '' : step.evidenceReference ?? '', evidenceSource: correction ? '' : step.evidenceSource ?? '' });
    setEditing({ stepId: step.stepId, correction });
    setStatus(step.status === 'unrecorded' ? 'in_progress' : step.status);
    setNote(correction ? '' : step.note);
    setEvidenceReference(correction ? '' : step.evidenceReference ?? '');
    setEvidenceSource(correction ? '' : step.evidenceSource ?? '');
    setFormError('');
  }

  async function markCorrectionNotApplicable(step: UniversityStep) {
    const saved = await onSave(step.stepId, { status: 'not_applicable', note: '', evidenceReference: null, evidenceSource: null, expectedRevision: step.revision });
    if (saved) setFormError('');
  }

  return <section className="panel university-steps-panel">
    <details className="university-steps-disclosure">
      <summary><span><b>Пункты партнёрства</b><small>{value.overview.statusCounts.documented} зафиксировано в CRM · {value.overview.statusCounts.in_progress} в работе</small></span><span className="university-step-count">13 пунктов</span></summary>
      {value.readOnly && <p className="university-readonly">Завершённая активность доступна только для чтения.</p>}
      <section className="university-u14" aria-label="Контроль исполнения">
        <div><b>Контроль исполнения</b><span>{value.overview.openTaskCount} открытых действий · {value.overview.statusCounts.waiting} ожиданий</span></div>
        {value.overview.openTasks.length > 0 && <ul>{value.overview.openTasks.slice(0, 3).map((task) => <li key={task.id}>{task.title} · {formatDate(task.dueAt)} · {task.ownerName}</li>)}</ul>}
        {value.overview.latestEvent && <p>Последнее событие: {value.overview.latestEvent.eventType.startsWith('university_') ? outcomeLabel(value.overview.latestEvent as Event) : value.overview.latestEvent.summary} · {value.overview.latestEvent.actorName} · {formatDate(value.overview.latestEvent.createdAt)}</p>}
        <small>Сводка основана на открытых задачах, истории и состояниях пунктов CRM.</small>
      </section>
      <p className="university-recording-note">Статусы описывают только записи координации в CRM. Они не являются юридическим подтверждением подписания и не доказывают результат обучения или занятий. Время факта во внешней системе отдельно не фиксируется.</p>
      <div className="university-step-groups">
        {groups.map((group) => {
          const steps = value.steps.filter((step) => step.groupKey === group.key).sort((a, b) => a.ordinal - b.ordinal);
          return <details className="university-step-group" key={group.key}>
            <summary><span>{group.label}</span><small>{steps.filter((step) => step.status === 'documented').length} / {steps.length} зафиксировано</small></summary>
            <div className="university-step-list">
              {steps.map((step) => {
                const isEditing = editing?.stepId === step.stepId;
                const needsExternalEvidence = status === 'documented' && ['U04', 'U06', 'U07', 'U09', 'U10', 'U11', 'U12', 'U13'].includes(step.stepId);
                return <article className="university-step-row" key={step.stepId}>
                  <div className="university-step-heading"><div><b>{step.label}{step.optional && <span className="optional-chip">по необходимости</span>}</b><p>{step.description}</p></div><span className={`step-status status-${step.status}`}>{STEP_STATUS_LABELS[step.status]}</span></div>
                  {step.note && !isEditing && <p className="university-step-note">{step.note}</p>}
                  {(step.evidenceReference || step.evidenceSource) && !isEditing && <p className="university-step-evidence">{step.evidenceReference && <span>Ссылка/позиция: {step.evidenceReference}</span>}{step.evidenceSource && <span>Источник: {step.evidenceSource}</span>}</p>}
                  {!value.readOnly && !isEditing && <div className="university-step-actions">
                    {step.stepId !== 'U05' && <button className="text-button" disabled={busy} onClick={() => startEdit(step)}>Изменить</button>}
                    {step.stepId === 'U05' && step.status === 'unrecorded' && <button className="text-button" disabled={busy} onClick={() => void markCorrectionNotApplicable(step)}>Отметить как неприменимый</button>}
                    {canReturn(step) && <button className="text-button" disabled={busy} onClick={() => startEdit(step, true)}>{step.status === 'not_applicable' ? 'Зафиксировать возврат, если корректировка всё же нужна' : 'Зафиксировать возврат документов'}</button>}
                  </div>}
                  {isEditing && <form className="university-step-form" onSubmit={async (event) => {
                    event.preventDefault();
                    setFormError('');
                    const evidence = { evidenceReference: evidenceReference.trim() || null, evidenceSource: evidenceSource.trim() || null };
                    const cleanNote = note.trim();
                    const requiresReferenceSource = ['U04', 'U06', 'U07', 'U09', 'U10', 'U11', 'U12', 'U13'].includes(step.stepId);
                    if (!editing.correction && status === 'documented' && requiresReferenceSource && (!evidence.evidenceReference || !evidence.evidenceSource)) {
                      setFormError('Добавьте ссылку или позицию и укажите источник.'); return;
                    }
                    if (!editing.correction && status === 'documented' && !requiresReferenceSource && !cleanNote && !evidence.evidenceReference) {
                      setFormError('Добавьте короткую заметку или ссылку.'); return;
                    }
                    if (editing.correction && !cleanNote) { setFormError('Кратко опишите, что требуется скорректировать.'); return; }
                    const saved = editing.correction
                      ? await onCorrectionReturn({ expectedU04Revision: value.steps.find((item) => item.stepId === 'U04')?.revision ?? 0, expectedU05Revision: step.revision, note: cleanNote, ...evidence })
                      : await onSave(step.stepId, { status, note: cleanNote, ...evidence, expectedRevision: step.revision });
                    if (saved) { onDirtyChange('university-step', false); setEditing(null); }
                  }}>
                    {!editing.correction && <label className="field"><span>Состояние</span><select disabled={busy} value={status} onChange={(event) => setStatus(event.target.value as Exclude<UniversityStepStatus, 'unrecorded'>)}>
                      <option value="in_progress">В работе</option><option value="waiting">Ожидание</option><option value="documented">Зафиксировано в CRM</option>
                    </select></label>}
                    {editing.correction && <p className="university-correction-help">Запись о корректировке сохранится, а обмен документами вернётся в состояние «В работе».</p>}
                    <label className="field"><span>{editing.correction ? 'Что требуется скорректировать' : 'Краткая заметка'}</span><textarea disabled={busy} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} required={editing.correction} placeholder="Кратко запишите состояние или договорённость" /></label>
                    <label className="field"><span>{needsExternalEvidence ? 'Ссылка или позиция *' : 'Ссылка или позиция'}</span><input disabled={busy} value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} maxLength={500} required={needsExternalEvidence} placeholder="Например, номер записи или ссылка" /></label>
                    <label className="field"><span>{needsExternalEvidence ? 'Источник *' : 'Источник'}</span><input disabled={busy} value={evidenceSource} onChange={(event) => setEvidenceSource(event.target.value)} maxLength={160} required={needsExternalEvidence} placeholder="Например, LMS или подтверждение вуза" /></label>
                    {needsExternalEvidence && <p className="university-evidence-hint">Для фиксации добавьте ссылку или позицию и источник. Это запись в CRM, не подтверждение юридического статуса или учебного результата.</p>}
                    {formError && <p className="university-form-error" role="alert">{formError}</p>}
                    <div className="form-actions"><span>{editing.correction ? 'Событие и оба состояния сохранятся вместе.' : 'Изменение попадёт в историю активности.'}</span><div><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Отмена</button><button className="primary" disabled={busy}>{busy ? 'Сохраняем…' : editing.correction ? 'Записать возврат' : 'Сохранить пункт'}</button></div></div>
                  </form>}
                  {step.updatedAt && <small className="university-step-updated">Записано в CRM: {step.actorName} · {formatDate(step.updatedAt)} · версия {step.revision}</small>}
                </article>;
              })}
            </div>
          </details>;
        })}
      </div>
    </details>
  </section>;
}

function IndividualLearningCard({ facts }: { facts: LearningFact[] }) {
  const labels: Record<LearningFact['factKind'], string> = {
    enrollment: 'Зачисление', learning_started: 'Начало обучения', learning_completed: 'Завершение обучения',
  };
  return <section className="panel learning-facts-panel">
    <div className="section-top"><div><div className="eyebrow">ДАННЫЕ ОБУЧЕНИЯ ИЗ LMS</div><h2>Факты обучения</h2></div><span className="history-count">{facts.length}</span></div>
    {facts.length ? <div className="learning-facts-list">{facts.map((fact) => <div className="learning-fact" key={fact.id}><b>{labels[fact.factKind]}</b><span>{fact.source} · {formatDate(fact.occurredAt)}</span><code>{fact.reference}</code></div>)}</div> : <p className="muted-copy">Подтверждённых фактов из LMS пока нет.</p>}
    <small>CRM показывает только тип факта, источник, время и ссылку. Учебная запись остаётся в LMS.</small>
  </section>;
}

function CmsExchangeCard({ jobs, busy, onRetry }: { jobs: ExchangeJob[]; busy: boolean; onRetry: (id: string) => void }) {
  const received = jobs.find((job) => job.direction === 'cms_to_crm' && job.operation === 'receive_inquiry');
  const acknowledgement = jobs.find((job) => job.direction === 'crm_to_cms' && job.operation === 'return_status');
  return <section className="panel cms-exchange-card">
    <div className="section-top"><div><div className="eyebrow">ИСТОЧНИК · ТЕСТОВАЯ СРЕДА CMS</div><h2>Входящее обращение</h2></div></div>
    <div className="cms-exchange-status"><span>Получено в CRM</span><b>{received ? EXCHANGE_STATUS[received.status] : 'Ожидает подтверждения'}</b></div>
    <div className="cms-exchange-status"><span>Подтверждение CMS</span><b>{acknowledgement ? EXCHANGE_STATUS[acknowledgement.status] : 'Не отправлено'}</b></div>
    {acknowledgement?.lastError && <p className="exchange-error">{acknowledgement.lastError}</p>}
    {acknowledgement?.status === 'retryable_error' && acknowledgement.attemptCount < 3 && <button className="secondary" disabled={busy} onClick={() => onRetry(acknowledgement.id)}>Повторить подтверждение</button>}
  </section>;
}

function LmsExchangeCard({ activityId, stageKey, jobs, busy, onRequest, onRetry }: {
  activityId: string; stageKey: string; jobs: ExchangeJob[]; busy: boolean; onRequest: () => void; onRetry: (id: string) => void;
}) {
  const lmsJobs = jobs.filter((job) => job.system === 'lms');
  const latestRequest = lmsJobs.find((job) => job.direction === 'crm_to_lms');
  const canRequest = stageKey === 'lms_handoff' && (!latestRequest || latestRequest.status === 'rejected');
  return <section className="panel learning-exchange-panel">
    <div className="section-top"><div><div className="eyebrow">ОБМЕН · ТЕСТОВАЯ СРЕДА LMS</div><h2>Передача в LMS</h2></div><span className="exchange-mode-tag">Локальная симуляция</span></div>
    <p className="muted-copy">Отправка или принятие запроса не подтверждает зачисление и начало обучения. Эти факты появятся только после входящего события тестовой среды LMS.</p>
    {latestRequest && <div className="learning-request-status"><div><b>{EXCHANGE_STATUS[latestRequest.status]}</b><span>{formatDate(latestRequest.updatedAt)} · попытка {latestRequest.attemptCount}</span></div><code>{latestRequest.correlationId}</code></div>}
    {latestRequest?.lastError && <p className="exchange-error">{latestRequest.lastError}</p>}
    {latestRequest?.status === 'retryable_error' && latestRequest.attemptCount < 3 && <button className="secondary" disabled={busy} onClick={() => onRetry(latestRequest.id)}>Повторить технический запрос</button>}
    {canRequest ? <button className="primary exchange-send-button" disabled={busy} onClick={onRequest}>{busy ? 'Отправляем…' : 'Отправить запрос на подготовку доступа'}</button> : stageKey !== 'lms_handoff' && <p className="exchange-stage-hint">Запрос доступен на стадии «Передача в LMS».</p>}
    {lmsJobs.filter((job) => job.direction === 'lms_to_crm').map((job) => <div className="learning-request-status" key={job.id}><div><b>{EXCHANGE_STATUS[job.status]}</b><span>LMS → CRM · {formatDate(job.updatedAt)}</span></div><small>{job.response?.factKind ? String(job.response.factKind) : job.lastError ?? ''}</small></div>)}
  </section>;
}

function CorporatePlanCard({ value, busy, onSave, onDirtyChange }: { value: CorporatePlan; busy: boolean; onSave: (input: CorporatePlanInput) => Promise<boolean>; onDirtyChange: (section: string, dirty: boolean) => void }) {
  const [draft, setDraft] = useState(value);
  const savedDraft = useRef(JSON.stringify(value));
  useEffect(() => { savedDraft.current = JSON.stringify(value); setDraft(value); onDirtyChange('corporate-plan', false); }, [value.revision, value.readOnly]);
  useEffect(() => onDirtyChange('corporate-plan', JSON.stringify(draft) !== savedDraft.current), [draft]);
  const editingDisabled = busy || value.readOnly;
  const modeLabels = { standard: 'Готовая программа', adapted: 'Адаптация', new: 'Новая программа', undecided: 'Пока не определено' };
  const feasibilityLabels = { unassessed: 'Не оценена', feasible: 'Реализуемо', feasible_with_changes: 'Реализуемо с условиями', not_feasible: 'Не реализуемо' };
  const approvalLabels = { not_recorded: 'Не записано', pending: 'На согласовании', approved: 'Одобрение указано в источнике', rejected: 'Отказ указан в источнике' };
  const setBrief = (key: keyof CorporatePlan['brief'], value: string) => setDraft((current) => ({ ...current, brief: { ...current.brief, [key]: value || null } }));
  const setMethodologist = (key: keyof CorporatePlan['methodologist'], value: string) => setDraft((current) => ({ ...current, methodologist: { ...current.methodologist, [key]: value || null } }));
  const setProposed = (key: keyof CorporatePlan['proposed'], value: string) => setDraft((current) => ({ ...current, proposed: { ...current.proposed, [key]: value || null } }));
  const setAgreed = (key: keyof CorporatePlan['agreed'], value: string) => setDraft((current) => ({ ...current, agreed: { ...current.agreed, [key]: value || null } }));
  const setApproval = (key: keyof CorporatePlan['approval'], value: string) => setDraft((current) => ({ ...current, approval: { ...current.approval, [key]: value || null } }));
  const hasCustomization = draft.programMode === 'adapted' || draft.programMode === 'new';
  return <section className="panel corporate-plan-panel"><details className="corporate-plan-disclosure">
    <summary><span><b>План программы</b><small>{modeLabels[value.programMode]} · {value.requestedPlaces === null ? 'места не указаны' : `${value.requestedPlaces} запрошенных мест`}</small></span><i>{value.revision ? `Версия ${value.revision}` : 'Не заполнен'}</i></summary>
    <form className="corporate-plan-form" onSubmit={async (event) => {
      event.preventDefault();
      if (editingDisabled) return;
      if (await onSave({ expectedRevision: value.revision, programMode: draft.programMode, requestedPlaces: draft.requestedPlaces, brief: draft.brief, methodologist: draft.methodologist, proposed: draft.proposed, agreed: draft.agreed, approval: draft.approval })) {
        savedDraft.current = JSON.stringify(draft); onDirtyChange('corporate-plan', false);
      }
    }}>
      <p className="corporate-plan-hint">Карточка специалиста · запрошенные места не являются зачислениями LMS.</p>
      <label className="field"><span>Вариант программы</span><select value={draft.programMode} disabled={editingDisabled} onChange={(event) => setDraft((current) => ({ ...current, programMode: event.target.value as CorporatePlan['programMode'] }))}>
        <option value="undecided">Пока не определено</option><option value="standard">Готовая программа</option><option value="adapted">Адаптация</option><option value="new">Новая программа</option>
      </select></label>
      <label className="field"><span>Запрошено мест</span><input type="number" min="0" max="1000000" step="1" value={draft.requestedPlaces ?? ''} disabled={editingDisabled} onChange={(event) => setDraft((current) => ({ ...current, requestedPlaces: event.target.value === '' ? null : Number(event.target.value) }))} /></label>
      {!hasCustomization && <p className="corporate-plan-hint">Данные адаптации и разработки сохранены и остаются доступными для редактирования. Для варианта «{modeLabels[draft.programMode]}» они сейчас неактивны.</p>}
      <div className="corporate-plan-carried-data">
        <details className="corporate-plan-section" open={hasCustomization}><summary>Бриф и методолог</summary>
          <label className="field"><span>Ожидаемый результат</span><textarea rows={2} maxLength={1000} value={draft.brief.expectedOutcome ?? ''} disabled={editingDisabled} onChange={(event) => setBrief('expectedOutcome', event.target.value)} /></label>
          <label className="field"><span>Аудитория</span><input maxLength={500} value={draft.brief.audience ?? ''} disabled={editingDisabled} onChange={(event) => setBrief('audience', event.target.value)} /></label>
          <label className="field"><span>Входной уровень</span><input maxLength={500} value={draft.brief.entryLevel ?? ''} disabled={editingDisabled} onChange={(event) => setBrief('entryLevel', event.target.value)} /></label>
          <label className="field"><span>Формат</span><input maxLength={300} value={draft.brief.deliveryFormat ?? ''} disabled={editingDisabled} onChange={(event) => setBrief('deliveryFormat', event.target.value)} /></label>
          <label className="field"><span>Объём</span><input maxLength={300} value={draft.brief.volume ?? ''} disabled={editingDisabled} onChange={(event) => setBrief('volume', event.target.value)} /></label>
          <label className="field"><span>Технологический контекст</span><input maxLength={500} value={draft.brief.technologyContext ?? ''} disabled={editingDisabled} onChange={(event) => setBrief('technologyContext', event.target.value)} /></label>
          <label className="field"><span>Методолог</span><input maxLength={180} value={draft.methodologist.name ?? ''} disabled={editingDisabled} onChange={(event) => setMethodologist('name', event.target.value)} /></label>
          <label className="field"><span>Оценка реализуемости</span><select value={draft.methodologist.feasibility} disabled={editingDisabled} onChange={(event) => setMethodologist('feasibility', event.target.value)}>{Object.entries(feasibilityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="field"><span>Комментарий методолога</span><textarea rows={2} maxLength={2000} value={draft.methodologist.note ?? ''} disabled={editingDisabled} onChange={(event) => setMethodologist('note', event.target.value)} /></label>
        </details>
        <details className="corporate-plan-section"><summary>Предложенный объём, сроки и приёмка</summary>
          <label className="field"><span>Предложенный объём работ</span><textarea rows={2} maxLength={2000} value={draft.proposed.scope ?? ''} disabled={editingDisabled} onChange={(event) => setProposed('scope', event.target.value)} /></label>
          <div className="corporate-plan-date-range"><label className="field"><span>Начало</span><input type="date" value={draft.proposed.startDate ?? ''} disabled={editingDisabled} onChange={(event) => setProposed('startDate', event.target.value)} /></label><label className="field"><span>Окончание</span><input type="date" value={draft.proposed.endDate ?? ''} disabled={editingDisabled} onChange={(event) => setProposed('endDate', event.target.value)} /></label></div>
          <label className="field"><span>Предложенные критерии приёмки</span><textarea rows={2} maxLength={1500} value={draft.proposed.acceptanceCriteria ?? ''} disabled={editingDisabled} onChange={(event) => setProposed('acceptanceCriteria', event.target.value)} /></label>
        </details>
        <details className="corporate-plan-section"><summary>Согласованный объём, сроки и приёмка</summary>
          <label className="field"><span>Согласованный объём работ</span><textarea rows={2} maxLength={2000} value={draft.agreed.scope ?? ''} disabled={editingDisabled} onChange={(event) => setAgreed('scope', event.target.value)} /></label>
          <div className="corporate-plan-date-range"><label className="field"><span>Начало</span><input type="date" value={draft.agreed.startDate ?? ''} disabled={editingDisabled} onChange={(event) => setAgreed('startDate', event.target.value)} /></label><label className="field"><span>Окончание</span><input type="date" value={draft.agreed.endDate ?? ''} disabled={editingDisabled} onChange={(event) => setAgreed('endDate', event.target.value)} /></label></div>
          <label className="field"><span>Согласованные критерии приёмки</span><textarea rows={2} maxLength={1500} value={draft.agreed.acceptanceCriteria ?? ''} disabled={editingDisabled} onChange={(event) => setAgreed('acceptanceCriteria', event.target.value)} /></label>
        </details>
        <details className="corporate-plan-section"><summary>Сведения о согласовании</summary>
          <label className="field"><span>Состояние в источнике</span><select value={draft.approval.status} disabled={editingDisabled} onChange={(event) => setApproval('status', event.target.value)}>{Object.entries(approvalLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="field"><span>Ссылка или позиция подтверждения</span><input maxLength={500} value={draft.approval.evidenceReference ?? ''} disabled={editingDisabled} onChange={(event) => setApproval('evidenceReference', event.target.value)} /></label>
          <label className="field"><span>Источник подтверждения</span><input maxLength={160} value={draft.approval.evidenceSource ?? ''} disabled={editingDisabled} onChange={(event) => setApproval('evidenceSource', event.target.value)} /></label>
          <label className="field"><span>Примечание</span><textarea rows={2} maxLength={2000} value={draft.approval.note ?? ''} disabled={editingDisabled} onChange={(event) => setApproval('note', event.target.value)} /></label>
          <small>Состояние отражает запись по указанному источнику и не подтверждает юридический статус само по себе.</small>
        </details>
      </div>
      {value.readOnly ? <p className="corporate-plan-hint">Активность закрыта; план доступен только для чтения.</p> : <button className="primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить план'}</button>}
      {value.updatedAt && <small>Изменил(а) {value.updatedBy} · {formatDate(value.updatedAt)} · версия {value.revision}</small>}
    </form>
  </details></section>;
}

function ActivityDocumentsCard({ documents, busy, readOnly, onUpload, onDownload }: {
  documents: ActivityDocument[]; busy: boolean; readOnly: boolean; onUpload: (file: File) => Promise<boolean>; onDownload: (document: ActivityDocument) => void;
}) {
  const [uploadIssue, setUploadIssue] = useState('');
  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setUploadIssue('Размер файла не должен превышать 20 МБ.');
      input.value = '';
      return;
    }
    setUploadIssue('');
    if (await onUpload(file)) input.value = '';
  }
  const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} КБ` : `${(size / 1024 / 1024).toFixed(1)} МБ`;
  return <section className="panel documents-panel" aria-labelledby="activity-documents-title">
    <div className="section-top"><div><div className="eyebrow">ФАЙЛЫ АКТИВНОСТИ</div><h2 id="activity-documents-title">Документы</h2></div><span className="history-count">{documents.length}</span></div>
    <div className="documents-toolbar">
      <label className={`documents-file-control ${readOnly || busy ? 'disabled' : ''}`}>
        <span>{busy ? 'Сохраняем…' : 'Прикрепить файл'}</span>
        <input type="file" accept=".png,.jpg,.jpeg,.pdf,.zip,.gz,.gzip,.rar,.doc,.docx,.xls,.xlsx" disabled={readOnly || busy} onChange={handleFileChange} />
      </label>
      <span className="documents-help">PNG, JPEG, PDF, ZIP, GZIP, RAR, DOC, DOCX, XLS, XLSX · до 20 МБ</span>
    </div>
    {readOnly && <p className="documents-readonly">Закрытая активность доступна только для просмотра.</p>}
    {uploadIssue && <p className="documents-error" role="alert">{uploadIssue}</p>}
    {documents.length ? <div className="documents-list" role="list">
      {documents.map((file) => <article className="document-row" role="listitem" key={file.id}>
        <div className="document-copy"><strong title={file.name}>{file.name}</strong><small>{file.extension.toUpperCase()} · {sizeLabel(file.sizeBytes)} · {formatDate(file.uploadedAt)} · {file.uploadedByName}</small></div>
        <button className="document-download" type="button" aria-label={`Скачать ${file.name}`} disabled={busy} onClick={() => onDownload(file)}>Скачать</button>
      </article>)}
    </div> : <p className="muted-copy documents-empty">В этой активности пока нет вложений.</p>}
  </section>;
}

const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = { draft: 'Черновик', signed: 'Подписан', ended: 'Завершён', unknown: 'Неизвестно' };
function licenseExpiryLabel(record: Pick<ActivityContractLicenseFields, 'licenseExpiryPrecision' | 'licenseExpiresOn' | 'licenseExpiresYear'>) {
  if (record.licenseExpiryPrecision === 'exact_date' && record.licenseExpiresOn) return `Точная дата · ${formatDate(record.licenseExpiresOn)}`;
  if (record.licenseExpiryPrecision === 'year' && record.licenseExpiresYear) return `Указан только год · ${record.licenseExpiresYear}`;
  if (record.licenseExpiryPrecision === 'unknown') return 'Срок действия неизвестен';
  return 'Срок действия не указан';
}

function ActivityContractLicensesCard({ records, documents, busy, readOnly, onSave, onDelete, onDownload, onDirtyChange }: {
  records: ActivityContractLicense[]; documents: ActivityDocument[]; busy: boolean; readOnly: boolean;
  onSave: (recordId: string | null, input: ActivityContractLicenseFields, expectedRevision: number) => Promise<boolean>;
  onDelete: (record: ActivityContractLicense) => Promise<boolean>; onDownload: (document: ActivityDocument) => void; onDirtyChange: (section: string, dirty: boolean) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ActivityContractLicenseFields>({
    title: '', contractReference: null, contractStatus: null, licenseExpiryPrecision: null,
    licenseExpiresOn: null, licenseExpiresYear: null, documentId: null, note: null,
  });
  const [formError, setFormError] = useState('');
  const savedDraft = useRef(JSON.stringify(draft));
  useEffect(() => onDirtyChange('contract-license', editingId !== null && JSON.stringify(draft) !== savedDraft.current), [draft, editingId]);
  const editing = editingId !== null;
  const activeRecord = editingId && editingId !== 'new' ? records.find((record) => record.id === editingId) ?? null : null;
  function startNew() {
    const fresh = { title: '', contractReference: null, contractStatus: null, licenseExpiryPrecision: null, licenseExpiresOn: null, licenseExpiresYear: null, documentId: null, note: null };
    savedDraft.current = JSON.stringify(fresh);
    setDraft(fresh);
    setEditingId('new'); setFormError('');
  }
  function startEdit(record: ActivityContractLicense) {
    if (editingId && JSON.stringify(draft) !== savedDraft.current && !window.confirm('Несохранённые изменения договора будут отброшены. Продолжить?')) return;
    const { id: _id, activityId: _activityId, documentName: _documentName, revision: _revision, updatedAt: _updatedAt, updatedBy: _updatedBy, readOnly: _readOnly, ...fields } = record;
    savedDraft.current = JSON.stringify(fields);
    setDraft(fields); setEditingId(record.id); setFormError('');
  }
  function setExpiryPrecision(value: string) {
    const precision = value ? value as LicenseExpiryPrecision : null;
    setDraft((current) => ({ ...current, licenseExpiryPrecision: precision,
      licenseExpiresOn: precision === 'exact_date' ? current.licenseExpiresOn : null,
      licenseExpiresYear: precision === 'year' ? current.licenseExpiresYear : null,
    }));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingId || busy || readOnly) return;
    if (draft.licenseExpiryPrecision === 'exact_date' && !draft.licenseExpiresOn || draft.licenseExpiryPrecision === 'year' && !draft.licenseExpiresYear) {
      setFormError('Укажите точную дату или год в соответствии с выбранной точностью.'); return;
    }
    const recordId = editingId === 'new' ? null : editingId;
    const saved = await onSave(recordId, { ...draft, title: draft.title.trim(), contractReference: draft.contractReference?.trim() || null, note: draft.note?.trim() || null }, activeRecord?.revision ?? 0);
    if (saved) { savedDraft.current = JSON.stringify(draft); onDirtyChange('contract-license', false); setEditingId(null); setFormError(''); }
  }
  const linkedDocument = (record: ActivityContractLicense) => documents.find((file) => file.id === record.documentId);
  return <section className="panel contract-license-panel">
    <details className="contract-license-disclosure">
      <summary><span><b>Договоры и лицензии</b><small>{records.length ? `${formatRussianCount(records.length, 'запись', 'записи', 'записей')} · в контексте этой активности` : 'Можно оставить пустым, пока договор не появился'}</small></span><span className="history-count">{records.length}</span></summary>
      <div className="contract-license-content">
        {records.length ? <div className="contract-license-list">
          {records.map((record) => <article className="contract-license-record" key={record.id}>
            <div className="contract-license-record-head"><div><strong>{record.title}</strong>{record.contractReference && <small>Номер или ссылка: {record.contractReference}</small>}</div>
              {!readOnly && <div className="contract-license-actions"><button type="button" className="text-button" disabled={busy} onClick={() => startEdit(record)}>Изменить</button><button type="button" className="text-button contract-license-delete" disabled={busy} onClick={() => { if (window.confirm(`Удалить запись «${record.title}»? Событие останется в истории.`)) void onDelete(record); }}>Удалить</button></div>}
            </div>
            <p>{record.contractStatus ? `Состояние договора · ${CONTRACT_STATUS_LABEL[record.contractStatus]}` : 'Состояние договора не записано'}<span> · </span>{licenseExpiryLabel(record)}</p>
            {record.documentName && <p className="contract-license-file">Документ · {linkedDocument(record) ? <button type="button" className="text-button" onClick={() => onDownload(linkedDocument(record)!)}>{record.documentName}</button> : record.documentName}</p>}
            {record.note && <p className="contract-license-note">{record.note}</p>}
            <small className="contract-license-updated">Изменил(а) {record.updatedBy} · {formatDate(record.updatedAt)} · версия {record.revision}</small>
          </article>)}
        </div> : <p className="muted-copy contract-license-empty">Здесь появятся несколько договоров или лицензий, если они относятся к этой активности.</p>}
        {readOnly ? <p className="documents-readonly">Активность закрыта; данные доступны только для чтения.</p> : <>
          {!editing && <button type="button" className="secondary contract-license-add" disabled={busy} onClick={startNew}>Добавить запись</button>}
          {editing && <form className="contract-license-form" onSubmit={submit}>
            <div className="two-fields"><label className="field"><span>Название <b>*</b></span><input autoFocus maxLength={160} required value={draft.title} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Например, договор на программу" /></label>
              <label className="field"><span>Номер или ссылка</span><input maxLength={180} value={draft.contractReference ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, contractReference: event.target.value || null }))} placeholder="Если уже есть" /></label></div>
            <div className="two-fields"><label className="field"><span>Состояние договора</span><select value={draft.contractStatus ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, contractStatus: event.target.value ? event.target.value as ContractStatus : null }))}><option value="">Не указано</option><option value="draft">Черновик</option><option value="signed">Подписан</option><option value="ended">Завершён</option><option value="unknown">Неизвестно</option></select></label>
              <label className="field"><span>Точность срока лицензии</span><select value={draft.licenseExpiryPrecision ?? ''} disabled={busy} onChange={(event) => setExpiryPrecision(event.target.value)}><option value="">Не указано</option><option value="exact_date">Точная дата</option><option value="year">Известен только год</option><option value="unknown">Неизвестно</option></select></label></div>
            {draft.licenseExpiryPrecision === 'exact_date' && <label className="field"><span>Срок действия · дата</span><input type="date" required value={draft.licenseExpiresOn ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, licenseExpiresOn: event.target.value || null }))} /></label>}
            {draft.licenseExpiryPrecision === 'year' && <label className="field"><span>Срок действия · год</span><input type="number" inputMode="numeric" min={1900} max={9999} step={1} required value={draft.licenseExpiresYear ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, licenseExpiresYear: event.target.value ? Number(event.target.value) : null }))} /></label>}
            <label className="field"><span>Связанный документ</span><select value={draft.documentId ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, documentId: event.target.value || null }))}><option value="">Без документа</option>{documents.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}</select></label>
            <label className="field"><span>Контекст или примечание</span><textarea rows={2} maxLength={1500} value={draft.note ?? ''} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value || null }))} placeholder="Кратко зафиксируйте важный контекст" /></label>
            {formError && <p className="documents-error" role="alert">{formError}</p>}
            <div className="contract-license-form-actions"><small>Срок не подставляется автоматически. Запись не выдаёт лицензию и не включает права в продукте.</small><div><button type="button" className="secondary" disabled={busy} onClick={() => { setEditingId(null); setFormError(''); }}>Отмена</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></div></div>
          </form>}
        </>}
      </div>
    </details>
  </section>;
}

function ReassignmentCard({ item, kams, api, busy, currentUserSub, routeVersion, onConfirm, onStale, onBack }: {
  item: Activity; kams: ManagerKam[]; api: ApiCall; busy: boolean; currentUserSub?: string; routeVersion: number;
  onConfirm: (id: string, token: string, routeVersion: number) => Promise<ReassignmentResult>; onStale: (id: string, routeVersion: number) => Promise<void>; onBack: () => void;
}) {
  const [targetKamSub, setTargetKamSub] = useState('');
  const [preview, setPreview] = useState<ReassignmentPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState('');
  const [formNotice, setFormNotice] = useState('');
  const previewSequence = useRef(0);
  const identity = `${item.id}:${item.ownerSub ?? ''}:${item.assignmentRevision ?? ''}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    previewSequence.current += 1;
    setTargetKamSub(''); setPreview(null); setPreviewing(false); setFormError(''); setFormNotice('');
    return () => { previewSequence.current += 1; };
  }, [identity]);

  function cancelPreview() {
    previewSequence.current += 1;
    setPreview(null); setPreviewing(false); setFormError('');
  }

  async function refreshAfterConflict(): Promise<boolean> {
    try { await onStale(item.id, routeVersion); return true; }
    catch { return false; }
  }

  async function requestPreview() {
    if (!item.ownerSub || typeof item.assignmentRevision !== 'number' || !targetKamSub || busy || previewing || confirming) return;
    const sequence = ++previewSequence.current;
    const requestedIdentity = identity;
    setPreview(null); setFormError(''); setFormNotice(''); setPreviewing(true);
    try {
      const result = await api<ReassignmentPreview>(`/api/manager/activities/${item.id}/reassignment/preview`, {
        method: 'POST', body: JSON.stringify({ targetKamSub, expectedOwnerSub: item.ownerSub, expectedAssignmentRevision: item.assignmentRevision }),
      });
      if (sequence !== previewSequence.current || identityRef.current !== requestedIdentity) return;
      setPreview(result);
    } catch (reason) {
      if (sequence !== previewSequence.current || identityRef.current !== requestedIdentity) return;
      if ((reason as Error & { status?: number })?.status === 409) {
        const refreshed = await refreshAfterConflict();
        setFormError(refreshed
          ? 'Ответственный или данные активности изменились. Карточка и очередь обновлены; сформируйте новый предварительный просмотр.'
          : 'Данные активности уже изменились, но карточку и очередь не удалось обновить. Нажмите «Обновить карточку».');
      } else setFormError(reason instanceof Error ? reason.message : 'Не удалось подготовить передачу.');
    } finally {
      if (sequence === previewSequence.current && identityRef.current === requestedIdentity) setPreviewing(false);
    }
  }

  async function confirmTransfer() {
    if (!preview?.canConfirm || !preview.previewToken || busy || previewing || confirming) return;
    const previousOwnerSub = item.ownerSub;
    setConfirming(true); setFormError(''); setFormNotice('');
    try {
      const result = await onConfirm(item.id, preview.previewToken, routeVersion);
      previewSequence.current += 1;
      setPreview(null); setTargetKamSub(''); setFormNotice(`Активность передана ${result.owner.name}. Открытые задачи переданы: ${result.openTasksReassigned}; выполненные задачи сохранены: ${result.completedTasksPreserved}.`);
      if (currentUserSub && currentUserSub === previousOwnerSub) onBack();
    } catch (reason) {
      if ((reason as Error & { status?: number })?.status === 409) {
        setPreview(null);
        const refreshed = await refreshAfterConflict();
        setFormError(refreshed
          ? 'Предварительный просмотр устарел или передача уже выполнена. Карточка и очередь обновлены; проверьте текущего ответственного.'
          : 'Передача не выполнена, а карточку и очередь не удалось обновить. Нажмите «Обновить карточку».');
      } else setFormError(reason instanceof Error ? reason.message : 'Не удалось передать активность.');
    } finally { setConfirming(false); }
  }

  if (!item.ownerSub) return <section className="panel reassignment-panel"><div className="eyebrow">ОТВЕТСТВЕННЫЙ</div><h2>Передача активности</h2><p className="reassignment-error" role="status">В карточке не указан текущий ответственный. Обновите её перед передачей.</p></section>;
  const currentOwnerName = kams.find((kam) => kam.sub === item.ownerSub)?.name ?? item.ownerName ?? item.ownerSub;
  const targetOptions = kams.filter((kam) => kam.sub !== item.ownerSub);
  const disabled = busy || previewing || confirming;

  return <section className="panel reassignment-panel" aria-labelledby="reassignment-title">
    <div className="eyebrow">МАРШРУТ АКТИВНОСТИ</div><h2 id="reassignment-title">Ответственный</h2>
    <div className="reassignment-current"><span>Сейчас</span><strong>{currentOwnerName}</strong></div>
    {preview ? <div className="reassignment-preview" aria-live="polite">
      <div className="reassignment-transfer"><span>{preview.currentOwner.name}</span><b aria-hidden="true">→</b><strong>{preview.targetOwner.name}</strong></div>
      <p className="reassignment-copy">Проверьте изменения перед подтверждением передачи активности.</p>
      <dl className="reassignment-facts">
        <div><dt>Стадия</dt><dd>{preview.impact.stageLabel}</dd></div>
        <div><dt>Состояние</dt><dd>{preview.impact.closed ? 'Закрыта' : 'Открыта'}{preview.impact.awaitingReply ? ' · ожидается ответ' : ''}</dd></div>
        <div><dt>Создана</dt><dd>{formatDate(preview.impact.createdAt)}</dd></div>
        <div><dt>История</dt><dd>{preview.impact.historyEventCount} событий</dd></div>
        <div><dt>Задачи</dt><dd>{preview.impact.taskCount} всего · {preview.impact.openTaskCount} открытых</dd></div>
        <div><dt>Ближайший срок</dt><dd>{preview.impact.nextOpenTaskDueAt ? formatDate(preview.impact.nextOpenTaskDueAt) : 'Открытых задач нет'}</dd></div>
      </dl>
      <ul className="reassignment-consequences">
        <li>{preview.impact.openTasksWillTransfer ? 'Открытые задачи перейдут новому ответственному.' : 'Открытые задачи не переходят новому ответственному.'}</li>
        <li>{preview.impact.completedTaskAttributionWillRemain ? 'История выполненных задач останется у прежнего исполнителя.' : 'Атрибуция выполненных задач изменится вместе с передачей.'}</li>
      </ul>
      {preview.blockers.length > 0 && <ul className="reassignment-blockers" role="alert">{preview.blockers.map((blocker) => <li key={`${blocker.code}:${blocker.message}`}>{blocker.message}</li>)}</ul>}
      <div className="reassignment-actions"><button type="button" className="secondary" disabled={disabled} onClick={cancelPreview}>Отмена</button><button type="button" className="primary" disabled={disabled || !preview.canConfirm || !preview.previewToken} onClick={() => void confirmTransfer()}>{confirming ? 'Передаём…' : 'Подтвердить передачу'}</button></div>
    </div> : <>
      <label className="field reassignment-target"><span>Передать КАМ</span><select value={targetKamSub} disabled={disabled || targetOptions.length === 0} onChange={(event) => { previewSequence.current += 1; setTargetKamSub(event.target.value); setPreview(null); setFormError(''); setFormNotice(''); }}><option value="">Выберите ответственного</option>{targetOptions.map((kam) => <option key={kam.sub} value={kam.sub}>{kam.name}</option>)}</select></label>
      {targetOptions.length === 0 && <p className="muted-copy">Нет других доступных КАМ для передачи.</p>}
      <p className="reassignment-copy">Перед подтверждением CRM покажет стадию активности, историю и судьбу открытых и выполненных задач.</p>
      <div className="reassignment-actions">{previewing
        ? <><span className="reassignment-loading" role="status">Готовим просмотр…</span><button type="button" className="secondary" disabled={busy || confirming} onClick={cancelPreview}>Отменить проверку</button></>
        : <button type="button" className="secondary reassignment-preview-button" disabled={disabled || !targetKamSub || typeof item.assignmentRevision !== 'number'} onClick={() => void requestPreview()}>Проверить последствия</button>}
      </div>
    </>}
    {formError && <p className="reassignment-error" role="alert">{formError}</p>}
    {formNotice && <p className="reassignment-success" role="status">{formNotice}</p>}
  </section>;
}

function ActivityCoreEditor({ item, contacts, products, api, busy, onSave, onDirtyChange }: {
  item: Activity; contacts: ImportedContact[]; products: Product[]; api: ApiCall; busy: boolean;
  onSave: (input: { personId?: string | null; newPerson?: { fullName: string; email?: string; phone?: string }; productIds: string[]; programIds: string[]; priority: number; expectedRevision: number }) => Promise<boolean>;
  onDirtyChange: (section: string, dirty: boolean) => void;
}) {
  const [personId, setPersonId] = useState(item.personId ?? '');
  const [productIds, setProductIds] = useState(item.productIds ?? []);
  const [programIds, setProgramIds] = useState(item.programIds ?? []);
  const [programs, setPrograms] = useState<LearningProgram[]>([]);
  const [programError, setProgramError] = useState('');
  const [priority, setPriority] = useState(item.priority);
  const [newContactName, setNewContactName] = useState('');
  const [newContactEmail, setNewContactEmail] = useState('');
  const [newContactPhone, setNewContactPhone] = useState('');
  const [editing, setEditing] = useState(false);
  const saved = useRef(JSON.stringify({ personId: item.personId ?? '', productIds: [...(item.productIds ?? [])].sort(), programIds: [...(item.programIds ?? [])].sort(), priority: item.priority, newContactName: '', newContactEmail: '', newContactPhone: '' }));
  const current = JSON.stringify({ personId, productIds: [...productIds].sort(), programIds: [...programIds].sort(), priority, newContactName, newContactEmail, newContactPhone });
  useEffect(() => {
    let current = true;
    api<{ items: LearningProgram[] }>('/api/programs').then((value) => { if (current) setPrograms(value.items); }).catch((reason: Error) => { if (current) setProgramError(reason.message); });
    return () => { current = false; };
  }, [api]);
  useEffect(() => {
    setPersonId(item.personId ?? ''); setProductIds(item.productIds ?? []); setProgramIds(item.programIds ?? []); setPriority(item.priority);
    setNewContactName(''); setNewContactEmail(''); setNewContactPhone('');
    saved.current = JSON.stringify({ personId: item.personId ?? '', productIds: [...(item.productIds ?? [])].sort(), programIds: [...(item.programIds ?? [])].sort(), priority: item.priority, newContactName: '', newContactEmail: '', newContactPhone: '' });
    onDirtyChange('core-details', false);
  }, [item.revision]);
  useEffect(() => onDirtyChange('core-details', current !== saved.current), [current]);
  const availableContacts = item.personId && !contacts.some((contact) => contact.id === item.personId)
    ? [{ id: item.personId, fullName: item.personName ?? 'Текущий контакт', email: item.personEmail ?? item.email ?? null, phone: item.phone ?? null, organizationName: item.organizationName ?? null }, ...contacts]
    : contacts;
  const retiredProducts = (item.productLinks ?? []).filter((product) => !product.catalogVisible && productIds.includes(product.id));
  if (item.closed || typeof item.revision !== 'number') return null;
  return <details className="core-editor" open={editing} onToggle={(event) => setEditing(event.currentTarget.open)}>
    <summary>Уточнить контакт, продукты и приоритет</summary>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      if (await onSave({ ...(personId === '__new__' ? { newPerson: { fullName: newContactName.trim(), ...(newContactEmail.trim() ? { email: newContactEmail.trim() } : {}), ...(newContactPhone.trim() ? { phone: newContactPhone.trim() } : {}) } } : { personId: personId || null }),
        productIds, programIds, priority, expectedRevision: item.revision! })) {
        saved.current = current; onDirtyChange('core-details', false); setEditing(false);
      }
    }}>
      <label className="field"><span>Контакт{item.kind === 'individual' ? ' *' : ''}</span><select value={personId} required={item.kind === 'individual'} disabled={busy} onChange={(event) => setPersonId(event.target.value)}><option value="">{item.kind === 'individual' ? 'Выберите физлицо' : 'Пока не указан'}</option><option value="__new__">Добавить новое контактное лицо</option>{availableContacts.map((contact) => <option value={contact.id} key={contact.id}>{contactOptionLabel(contact)}</option>)}</select></label>
      {personId === '__new__' && <div className="core-new-contact"><label className="field"><span>Имя и фамилия *</span><input value={newContactName} disabled={busy} onChange={(event) => setNewContactName(event.target.value)} maxLength={180} required /></label><label className="field"><span>Электронная почта</span><input type="email" value={newContactEmail} disabled={busy} onChange={(event) => setNewContactEmail(event.target.value)} maxLength={254} /></label><label className="field"><span>Телефон</span><input value={newContactPhone} disabled={busy} onChange={(event) => setNewContactPhone(event.target.value)} maxLength={64} /></label></div>}
      <fieldset className="product-field" disabled={busy}><legend>Продукты</legend><div className="product-choices">{products.map((product) => <label key={product.id}><input type="checkbox" checked={productIds.includes(product.id)} onChange={() => setProductIds((ids) => ids.includes(product.id) ? ids.filter((id) => id !== product.id) : [...ids, product.id])} />{productLabel(product.name)}</label>)}{retiredProducts.map((product) => <label key={product.id}><input type="checkbox" checked onChange={() => setProductIds((ids) => ids.filter((id) => id !== product.id))} />{product.name} · прежняя позиция</label>)}</div></fieldset>
      <fieldset className="product-field" disabled={busy || Boolean(programError)}><legend>Учебные программы</legend><div className="product-choices">{programs.map((program) => <label key={program.id}><input type="checkbox" checked={programIds.includes(program.id)} onChange={() => setProgramIds((ids) => ids.includes(program.id) ? ids.filter((id) => id !== program.id) : [...ids, program.id])} />{program.name}</label>)}</div>{!programs.length && !programError && <small>Программы добавляются в справочнике этапов.</small>}{programError && <small role="alert">Программы недоступны: {programError}</small>}</fieldset>
      <label className="field"><span>Приоритет</span><select value={priority} disabled={busy} onChange={(event) => setPriority(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} / 5</option>)}</select></label>
      <div className="core-editor-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { setPersonId(item.personId ?? ''); setProductIds(item.productIds ?? []); setProgramIds(item.programIds ?? []); setPriority(item.priority); setNewContactName(''); setNewContactEmail(''); setNewContactPhone(''); setEditing(false); onDirtyChange('core-details', false); }}>Отмена</button><button className="primary" disabled={busy || current === saved.current}>{busy ? 'Сохраняем…' : 'Сохранить сведения'}</button></div>
    </form>
  </details>;
}

function ActivityDetail({ item, contacts, products, managerKams, canReassign, currentUserSub, routeVersion, api, onReassigned, onStale, guidance, guidanceError, workflow, history, documents, contractLicenses, universitySteps, learningFacts, exchangeJobs, corporatePlan, busy, onDirtyChange, onBack, returnLabel, queuePosition, onQueueNavigate, onRefresh, onCoreSave, onTask, onComplete, onGuidanceFeedback, onOutcome, onTransition, onUniversityStep, onCorrectionReturn, onCorporatePlan, onContractLicenseSave, onContractLicenseDelete, onLmsRequest, onRetryExchange, onUploadDocument, onDownloadDocument }: {
  item: Activity; contacts: ImportedContact[]; products: Product[]; managerKams: ManagerKam[]; canReassign: boolean; currentUserSub?: string; routeVersion: number; api: ApiCall;
  onReassigned: (id: string, token: string, routeVersion: number) => Promise<ReassignmentResult>; onStale: (id: string, routeVersion: number) => Promise<void>;
  guidance: ActivityGuidance | null; guidanceError: string; workflow: Workflow[]; history: Event[]; documents: ActivityDocument[]; contractLicenses: ActivityContractLicense[]; universitySteps: UniversitySteps | null; learningFacts: LearningFact[]; exchangeJobs: ExchangeJob[]; corporatePlan: CorporatePlan | null; busy: boolean; onDirtyChange: (section: string, dirty: boolean) => void; onBack: () => void; returnLabel: string; queuePosition: { index: number; total: number } | null; onQueueNavigate: (direction: -1 | 1) => void; onRefresh: () => void;
  onTask: (title: string, dueAt: string) => Promise<boolean>; onComplete: (taskId: string) => void;
  onGuidanceFeedback: (recommendationKey: string, action: 'defer' | 'reject', reason?: string) => Promise<boolean>;
  onCoreSave: (input: { personId?: string | null; newPerson?: { fullName: string; email?: string; phone?: string }; productIds: string[]; programIds: string[]; priority: number; expectedRevision: number }) => Promise<boolean>;
  onOutcome: (outcome: string, note: string) => Promise<boolean>; onTransition: (target: string) => Promise<boolean>;
  onUniversityStep: (stepId: string, input: UniversityStepInput) => Promise<boolean>;
  onCorrectionReturn: (input: CorrectionReturnInput) => Promise<boolean>;
  onCorporatePlan: (input: CorporatePlanInput) => Promise<boolean>;
  onContractLicenseSave: (recordId: string | null, input: ActivityContractLicenseFields, expectedRevision: number) => Promise<boolean>;
  onContractLicenseDelete: (record: ActivityContractLicense) => Promise<boolean>;
  onLmsRequest: (activityId: string) => Promise<boolean>; onRetryExchange: (jobId: string) => void;
  onUploadDocument: (file: File) => Promise<boolean>; onDownloadDocument: (document: ActivityDocument) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [historyAuthor, setHistoryAuthor] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState(defaultDueAt);
  const [suggestedTaskTitle, setSuggestedTaskTitle] = useState('');
  const [suggestedTaskDue, setSuggestedTaskDue] = useState(defaultDueAt);
  const [rejectionReason, setRejectionReason] = useState('');
  const suggestedTaskBaseline = useRef({ title: '', due: suggestedTaskDue });
  const [copyMessage, setCopyMessage] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [outcome, setOutcome] = useState('connected');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState('');
  const [confirmTransition, setConfirmTransition] = useState(false);
  const [showOutcome, setShowOutcome] = useState(false);
  const formSubmitLock = useRef(false);
  const initialTaskDue = useRef(taskDue);
  const savedOutcome = useRef({ outcome: 'connected', note: '' });
  useEffect(() => { headingRef.current?.focus(); }, [item.id]);
  useEffect(() => onDirtyChange('contact-outcome', note.trim() !== savedOutcome.current.note || outcome !== savedOutcome.current.outcome), [note, outcome]);
  useEffect(() => onDirtyChange('new-task', taskTitle.trim() !== '' || taskDue !== initialTaskDue.current), [taskTitle, taskDue]);
  useEffect(() => {
    if (!guidance) return;
    suggestedTaskBaseline.current = { title: guidance.tip.recommendation, due: initialTaskDue.current };
    setSuggestedTaskTitle(guidance.tip.recommendation);
    setSuggestedTaskDue(initialTaskDue.current);
    setRejectionReason(''); setShowRejectForm(false); setCopyMessage('');
  }, [guidance?.tip.recommendationKey]);
  useEffect(() => {
    const baseline = suggestedTaskBaseline.current;
    const meaningfulTaskDraft = !guidance?.feedback?.active && Boolean(suggestedTaskTitle.trim())
      && (suggestedTaskTitle !== baseline.title || suggestedTaskDue !== baseline.due);
    const meaningfulRejectionDraft = !guidance?.feedback?.active && showRejectForm && Boolean(rejectionReason.trim());
    onDirtyChange('guidance-draft', meaningfulTaskDraft || meaningfulRejectionDraft);
  }, [guidance?.tip.recommendationKey, guidance?.feedback?.active, suggestedTaskTitle, suggestedTaskDue, rejectionReason, showRejectForm]);
  const nextStages = (item.allowedNext ?? []).map((key) => workflow.find((candidate) => candidate.key === key)).filter((stage): stage is Workflow => !!stage);
  useEffect(() => {
    if (target && !(item.allowedNext ?? []).includes(target)) {
      setTarget('');
      setConfirmTransition(false);
    }
  }, [item.stageKey, item.allowedNext, target]);
  const currentRouteKeys: readonly string[] | null = item.kind === 'individual' ? INDIVIDUAL_ROUTE_STAGES[item.routeVersion === 'legacy' ? 'legacy' : 'v2'] : null;
  const routeWorkflow = currentRouteKeys ? workflow.filter((stage) => currentRouteKeys.includes(stage.key)) : workflow;
  const exitedRouteStages = new Set(history.flatMap((event) => {
    const from = event.eventType === 'stage_changed' ? event.details?.from : undefined;
    return typeof from === 'string' && routeWorkflow.some((stage) => stage.key === from) ? [from] : [];
  }));
  const tasks = item.tasks ?? [];
  const openTasks = tasks.filter((task) => task.status === 'open').sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const doneTasks = tasks.filter((task) => task.status === 'done').sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt));
  const visibleHistory = historyAuthor ? history.filter((event) => event.actorSub === historyAuthor) : history;
  const historyAuthors = [...new Map(history.map((event) => [event.actorSub, event.actorName])).entries()];
  const [firstOpenTask, ...otherOpenTasks] = openTasks;
  const renderTimelineEntry = (event: Event) => <div className="timeline-entry" key={event.id}><span className={`timeline-dot ${event.eventType}`} /><div className="timeline-copy"><b>{outcomeLabel(event)}</b><p>{event.actorName} · {formatDate(event.createdAt)}</p>{typeof event.details?.note === 'string' && event.details.note && <blockquote>{event.details.note}</blockquote>}{typeof event.details?.text === 'string' && event.details.text && <blockquote>{event.details.text}</blockquote>}</div></div>;

  return <div className="detail-page">
    <div className="detail-top"><button className="back-button" onClick={onBack}>← <span>{returnLabel}</span></button>{queuePosition && <nav className="detail-queue-navigation" aria-label="Навигация по загруженной части списка"><button type="button" className="secondary" aria-label="Предыдущая активность" title="Предыдущая активность в загруженной части списка" disabled={busy || queuePosition.index <= 1} onClick={() => onQueueNavigate(-1)}>← <span>Предыдущая</span></button><span aria-live="polite">{queuePosition.index} из {queuePosition.total} загруженных</span><button type="button" className="secondary" aria-label="Следующая активность" title="Следующая активность в загруженной части списка" disabled={busy || queuePosition.index >= queuePosition.total} onClick={() => onQueueNavigate(1)}><span>Следующая</span> →</button></nav>}<span className="detail-date">Обновлено {formatDate(item.updatedAt)}</span><button className="refresh-button" disabled={busy} onClick={onRefresh} title="Обновить карточку">↻</button></div>
    {item.closed && <p className="documents-readonly">Активность закрыта и доступна только для просмотра.</p>}
    <div className="detail-heading"><div className={`kind-icon large ${item.kind}`}>{item.kind === 'university' ? 'У' : item.kind === 'corporate' ? 'К' : 'Ф'}</div><div className="heading-copy"><div className="eyebrow">{KIND_LABEL[item.kind].toUpperCase()} · АКТИВНОСТЬ{item.origin === 'cms_mock' ? ' · ТЕСТОВАЯ СРЕДА CMS' : item.kind === 'individual' ? ` · ${item.origin === 'external_ready' ? 'ВНЕШНИЙ ЗАКАЗ' : item.originLabel === 'Заявка с сайта' ? 'ЗАЯВКА С САЙТА' : 'РУЧНАЯ ЗАЯВКА'}` : ''}</div><h1 ref={headingRef} tabIndex={-1}>{item.title}</h1>{(item.organizationName || item.personName) && <p>{[item.organizationName, item.personName].filter(Boolean).join(' · ')}</p>}</div><span className="stage-badge detail-stage">{item.stageLabel}</span></div>
    {(item.phone || item.personEmail || item.email) && <div className="detail-contact-actions" aria-label="Контакт по активности">
      {item.phone && <a href={`tel:${item.phone.replace(/[^+\d]/g, '')}`}>Позвонить · {item.phone}</a>}
      {(item.personEmail ?? item.email) && <a href={`mailto:${encodeURIComponent(item.personEmail ?? item.email ?? '')}`}>Написать · {item.personEmail ?? item.email}</a>}
    </div>}

    <div className="detail-grid">
      <div className="detail-main-column">
        {item.kind === 'corporate' && corporatePlan && <CorporatePlanCard key={item.id} value={corporatePlan} busy={busy} onSave={onCorporatePlan} onDirtyChange={onDirtyChange} />}
        {item.kind === 'university' && universitySteps && <UniversityStepsCard value={universitySteps} busy={busy} onSave={onUniversityStep} onCorrectionReturn={onCorrectionReturn} onDirtyChange={onDirtyChange} />}
        <section className="panel action-panel"><div className="section-top"><div><div className="eyebrow">БЛИЖАЙШЕЕ ДЕЙСТВИЕ</div><h2>{firstOpenTask ? firstOpenTask.title : item.closed ? 'Активность закрыта' : 'Следующий шаг не задан'}</h2></div><span className="action-icon">↗</span></div>
          {firstOpenTask ? <div className="task-meta"><span>◷ {formatDate(firstOpenTask.dueAt)}</span><span>Ответственный: {firstOpenTask.ownerName ?? 'вы'}</span><button className="complete-button" disabled={busy || item.closed} onClick={() => onComplete(firstOpenTask.id)}>Отметить выполненным</button></div> : item.closed ? <p className="muted-copy">Список действий доступен только для просмотра.</p> : <p className="muted-copy">Добавьте задачу со сроком, чтобы следующее действие было видно в очереди.</p>}
          {firstOpenTask && <details className="task-update-disclosure" key={firstOpenTask.id}><summary>Обновления и подписка</summary><TaskUpdates api={api} activityId={item.id} taskId={firstOpenTask.id} readOnly={Boolean(item.closed)} onChanged={onRefresh} onDirtyChange={onDirtyChange} /></details>}
          {!item.closed && <form className="inline-task-form" onSubmit={async (event) => { event.preventDefault(); if (busy || item.closed || formSubmitLock.current) return; formSubmitLock.current = true; try { if (await onTask(taskTitle, moscowDateTimeToIso(taskDue))) { setTaskTitle(''); setTaskDue(initialTaskDue.current); } } finally { formSubmitLock.current = false; } }}><label className="field"><span>Новое действие</span><input disabled={busy} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} maxLength={180} placeholder="Например, уточнить состав программы" required /></label><label className="field due-field"><span>Срок · МСК</span><input disabled={busy} type="datetime-local" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} required /></label><button className="primary task-add" disabled={busy || item.closed}>Поставить действие</button></form>}
          {otherOpenTasks.length > 0 && <div className="other-tasks">{otherOpenTasks.map((task) => <div key={task.id}><div className="task-line"><span>{task.title}</span><time>{formatDate(task.dueAt)}</time><button disabled={busy || item.closed} onClick={() => onComplete(task.id)}>Готово</button></div><details className="task-update-disclosure"><summary>Обновления и подписка</summary><TaskUpdates api={api} activityId={item.id} taskId={task.id} readOnly={Boolean(item.closed)} onChanged={onRefresh} onDirtyChange={onDirtyChange} /></details></div>)}</div>}
          {doneTasks.length > 0 && <details className="completed-tasks"><summary>Завершённые действия · {doneTasks.length}</summary>{doneTasks.map((task) => <div key={task.id}><div className="task-line"><span>{task.title}</span><time>Выполнено</time></div><details className="task-update-disclosure"><summary>Обновления и подписка</summary><TaskUpdates api={api} activityId={item.id} taskId={task.id} readOnly={Boolean(item.closed)} onChanged={onRefresh} onDirtyChange={onDirtyChange} /></details></div>)}</details>}
        </section>

        <section className="panel transition-panel"><div className="section-top"><div><div className="eyebrow">СЕЙЧАС И ДАЛЕЕ</div><h2>{item.stageLabel}</h2></div><span className="route-count">Этапов в схеме: {routeWorkflow.length}</span></div><details className="route-details"><summary>Показать этапы схемы</summary><div className="stage-track">{routeWorkflow.map((stage) => { const isCurrent = stage.key === item.stageKey; const isPassed = !isCurrent && exitedRouteStages.has(stage.key); return <span key={stage.key} className={`stage-dot ${isCurrent ? 'current' : isPassed ? 'passed' : ''}`}><i />{stage.label}</span>; })}</div></details>
          {!item.closed && nextStages.length > 0 ? <div className="transition-controls"><label className="field"><span>Разрешённый следующий этап</span><select value={target} onChange={(event) => { setTarget(event.target.value); setConfirmTransition(false); }}><option value="">Выберите этап</option>{nextStages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label><button className="secondary" disabled={!target || busy} onClick={() => setConfirmTransition(true)}>Предложить переход</button></div> : <p className="muted-copy">{item.closed ? 'Закрытая активность доступна только для просмотра.' : 'Для этой стадии нет следующего перехода.'}</p>}
          {!item.closed && confirmTransition && target && <div className="confirm-box"><span>Перевести «{item.stageLabel}» → «{workflow.find((stage) => stage.key === target)?.label}»?</span><div><button className="secondary" onClick={() => setConfirmTransition(false)}>Отмена</button><button className="primary" disabled={busy} onClick={async () => { if (await onTransition(target)) { setConfirmTransition(false); setTarget(''); } }}>Подтвердить переход</button></div></div>}
          {guidance && !guidance.feedback?.active && <p className="transition-guidance">Подсказка: {guidance.tip.recommendation} <a href="#activity-guidance">Подробнее в инструкции ↓</a></p>}
        </section>

        <section className="panel outcome-panel"><div className="section-top"><div><div className="eyebrow">КОНТАКТ</div><h2>Записать результат взаимодействия</h2></div><button className="text-button" disabled={busy || item.closed} onClick={() => setShowOutcome((show) => !show)}>{item.closed ? 'Только чтение' : showOutcome ? 'Свернуть' : 'Добавить итог'}</button></div>
          {showOutcome && !item.closed && <form className="outcome-form" onSubmit={async (event) => { event.preventDefault(); if (busy || item.closed || formSubmitLock.current) return; formSubmitLock.current = true; try { if (await onOutcome(outcome, note)) { savedOutcome.current = { outcome, note: '' }; setNote(''); setShowOutcome(false); onDirtyChange('contact-outcome', false); } } finally { formSubmitLock.current = false; } }}><label className="field"><span>Результат</span><select disabled={busy} value={outcome} onChange={(event) => setOutcome(event.target.value)}>{OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>{outcome === 'cancelled' || outcome === 'refused' ? 'Причина завершения' : 'Краткая заметка'}</span><textarea disabled={busy} required={outcome === 'cancelled' || outcome === 'refused'} value={note} onChange={(event) => setNote(event.target.value)} maxLength={3000} placeholder={outcome === 'cancelled' || outcome === 'refused' ? 'Укажите, кто и почему отменил запрос или отказался' : 'Что обсудили и о чём договорились?'} rows={3} /></label><div className="form-actions"><span>{outcome === 'cancelled' || outcome === 'refused' ? 'Причина сохранится в истории; после этого можно завершить активность.' : 'Запись попадёт в историю. Стадия не изменится.'}</span><button className="primary" disabled={busy || item.closed}>Сохранить результат</button></div></form>}
          {(item.closed || !showOutcome) && <p className="muted-copy">{item.closed ? 'Закрытая активность доступна только для просмотра.' : 'Результат контакта будет сохранён в истории отдельно от стадии активности.'}</p>}
        </section>

        <section className="panel history-panel"><div className="section-top"><div><div className="eyebrow">ЕДИНАЯ ЛЕНТА</div><h2>Все действия по активности</h2></div><span className="history-count">{visibleHistory.length}</span></div>
          {canReassign && historyAuthors.length > 1 && <label className="field activity-history-filter"><span>Автор действия</span><select value={historyAuthor} onChange={(event) => setHistoryAuthor(event.target.value)}><option value="">Все участники</option>{historyAuthors.map(([sub, name]) => <option key={sub} value={sub}>{name}</option>)}</select></label>}
          {visibleHistory.length ? <><div className="timeline">{visibleHistory.slice(0, 3).map(renderTimelineEntry)}</div>{visibleHistory.length > 3 && <details className="history-more"><summary>Показать более ранние события · ещё {visibleHistory.length - 3}</summary><div className="timeline">{visibleHistory.slice(3).map(renderTimelineEntry)}</div></details>}</> : <p className="muted-copy">Событий по этому автору пока нет.</p>}
        </section>

        {item.origin === 'cms_mock' && <CmsExchangeCard jobs={exchangeJobs} busy={busy} onRetry={onRetryExchange} />}
        {item.kind === 'individual' && <><IndividualLearningCard facts={learningFacts} /><LmsExchangeCard activityId={item.id} stageKey={item.stageKey} jobs={exchangeJobs} busy={busy} onRequest={() => { void onLmsRequest(item.id); }} onRetry={onRetryExchange} /></>}
        <ActivityContractLicensesCard records={contractLicenses} documents={documents} busy={busy} readOnly={Boolean(item.closed)} onSave={onContractLicenseSave} onDelete={onContractLicenseDelete} onDownload={onDownloadDocument} onDirtyChange={onDirtyChange} />
        <ActivityDocumentsCard documents={documents} busy={busy} readOnly={Boolean(item.closed)} onUpload={onUploadDocument} onDownload={onDownloadDocument} />

        <section id="activity-guidance" className="panel guidance-panel">
          {guidance ? <>
            <div className="eyebrow">ПОДСКАЗКА · {guidance.stageLabel}</div>
            {guidance.feedback?.active ? <div className="guidance-feedback-state" role="status">
              <h2>{guidance.feedback.action === 'defer' ? 'Рекомендация отложена' : 'Рекомендация отклонена'}</h2>
              {guidance.feedback.action === 'defer' ? <p>Она снова появится {guidance.feedback.deferredUntil ? `после ${formatDate(guidance.feedback.deferredUntil)}` : 'позже'}.</p> : <p>Причина: {guidance.feedback.reason}</p>}
              <p className="guidance-why">{guidance.tip.recommendation}</p>
            </div> : <>
              <h2>{guidance.tip.recommendation}</h2>
              <p className="guidance-why">{guidance.tip.whyNow}</p>
              {!item.closed && <div className="guidance-actions">
                <form className="guidance-task-form" onSubmit={async (event) => { event.preventDefault(); if (busy || formSubmitLock.current) return; formSubmitLock.current = true; try { if (await onTask(suggestedTaskTitle, moscowDateTimeToIso(suggestedTaskDue))) { setSuggestedTaskTitle(''); setSuggestedTaskDue(initialTaskDue.current); } } finally { formSubmitLock.current = false; } }}>
                  <label className="field"><span>Задача по рекомендации</span><input disabled={busy} value={suggestedTaskTitle} onChange={(event) => setSuggestedTaskTitle(event.target.value)} maxLength={180} required /></label>
                  <label className="field"><span>Срок · МСК</span><input disabled={busy} type="datetime-local" value={suggestedTaskDue} onChange={(event) => setSuggestedTaskDue(event.target.value)} required /></label>
                  <button className="primary" disabled={busy || !suggestedTaskTitle.trim()}>Создать задачу</button>
                </form>
                <details className="guidance-draft"><summary>Черновик сообщения</summary><p>{guidance.article.draftMessage}</p><button className="secondary" type="button" onClick={async () => {
                  try { await navigator.clipboard.writeText(guidance.article.draftMessage); setCopyMessage('Черновик скопирован. Проверьте его перед отправкой.'); }
                  catch { setCopyMessage('Не удалось открыть буфер обмена. Текст черновика можно выделить и скопировать вручную.'); }
                }}>Скопировать черновик</button></details>
                <div className="guidance-feedback-actions"><button className="secondary" type="button" disabled={busy} onClick={() => void onGuidanceFeedback(guidance.tip.recommendationKey, 'defer')}>Отложить на сутки</button>
                  <button className="text-button" type="button" disabled={busy} onClick={() => setShowRejectForm((value) => !value)}>{showRejectForm ? 'Скрыть отказ' : 'Отклонить'}</button></div>
                {showRejectForm && <form className="guidance-reject-form" onSubmit={async (event) => { event.preventDefault(); if (busy || !rejectionReason.trim()) return; if (await onGuidanceFeedback(guidance.tip.recommendationKey, 'reject', rejectionReason)) { setShowRejectForm(false); setRejectionReason(''); } }}>
                  <label className="field"><span>Почему рекомендация не подходит?</span><textarea value={rejectionReason} disabled={busy} onChange={(event) => setRejectionReason(event.target.value)} maxLength={1000} rows={2} required /></label>
                  <button className="secondary" disabled={busy || !rejectionReason.trim()}>Сохранить причину</button>
                </form>}
                {copyMessage && <p className="guidance-copy-status" role="status">{copyMessage}</p>}
              </div>}
            </>}
            <details className="guidance-details">
              <summary>Инструкция по стадии</summary>
              <div className="guidance-article">
                <h3>{guidance.article.title}</h3>
                <p>{guidance.article.summary}</p>
                <p><b>Фокус:</b> {guidance.article.focus}</p>
                <div><b>Проверьте</b><ul>{guidance.article.checks.map((check) => <li key={check}>{check}</li>)}</ul></div>
                <p><b>Граница:</b> {guidance.article.boundary}</p>
              </div>
            </details>
            <div className="guidance-meta">{guidance.metadata.statusLabel} · {guidance.metadata.source} · {guidance.metadata.version} · проверка {guidance.metadata.reviewDate}</div>
          </> : <>
            <div className="eyebrow">ИНСТРУКЦИЯ · {item.stageLabel}</div>
            <h2>Подсказка временно недоступна</h2>
            <p className="guidance-why">{guidanceError || 'Для текущей стадии пока нет актуальной проектной инструкции.'}</p>
          </>}
        </section>


      </div>

      <aside className="detail-side-column">{canReassign && <ReassignmentCard item={item} kams={managerKams} api={api} busy={busy} currentUserSub={currentUserSub} routeVersion={routeVersion} onConfirm={onReassigned} onStale={onStale} onBack={onBack} />}<section className="panel profile-panel"><div className="eyebrow">КРАТКО О ЗАПИСИ</div><h2>Детали</h2><dl><dt>Сегмент</dt><dd>{KIND_LABEL[item.kind]}</dd>{item.origin === 'cms_mock' && <><dt>Источник</dt><dd>Тестовая среда CMS</dd><dt>Внешний ключ</dt><dd>{item.originReference ?? '—'}</dd></>}{item.kind === 'individual' && item.origin !== 'cms_mock' && <><dt>Источник заявки</dt><dd>{item.origin === 'external_ready' ? item.originSource ?? 'Внешний заказ' : item.originLabel ?? 'Ручная заявка'}</dd>{item.origin === 'external_ready' && <><dt>Номер заказа</dt><dd>{item.originReference ?? '—'}</dd></>}</>}{item.personName && <><dt>Физлицо</dt><dd>{item.personName}</dd></>}{(item.personEmail ?? item.email) && <><dt>Электронная почта</dt><dd>{item.personEmail ?? item.email}</dd></>}{item.phone && <><dt>Телефон</dt><dd>{item.phone}</dd></>}{item.organizationName && <><dt>Организация</dt><dd>{item.organizationName}</dd></>}{item.payerOrganizationName && <><dt>Организация-плательщик</dt><dd>{item.payerOrganizationName}</dd></>}<dt>Приоритет</dt><dd>{item.priority} / 5</dd><dt>Продукты</dt><dd>{item.productLinks?.length ? item.productLinks.map((product) => <span className="product-tag" key={product.id}>{productLabel(product.name)}{product.catalogVisible ? '' : ' · прежняя позиция'}</span>) : item.productNames?.length ? item.productNames.map((name) => <span className="product-tag" key={name}>{productLabel(name)}</span>) : 'Не выбраны'}</dd><dt>Учебные программы</dt><dd>{item.programNames?.length ? item.programNames.map((name) => <span className="product-tag" key={name}>{name}</span>) : 'Не выбраны'}</dd></dl><ActivityCoreEditor item={item} contacts={contacts} products={products} api={api} busy={busy} onSave={onCoreSave} onDirtyChange={onDirtyChange} /></section></aside>
    </div>
  </div>;
}
