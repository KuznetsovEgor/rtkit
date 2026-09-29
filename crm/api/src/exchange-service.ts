import { randomUUID } from 'node:crypto';
import { pool } from './db/connection.js';
import { assertActivityKindAllowed, DomainError, hasBusinessAccess, hasTeamBusinessScope, isActivityKindAllowed, type ActivityKind, type Actor, type CrmRepository } from './domain.js';

export type ExchangeSystem = 'cms' | 'lms';
export type ExchangeFailureMode = 'http_error' | 'reject_next';
export type LearningFactKind = 'enrollment' | 'learning_started' | 'learning_completed';
export type ExchangeJob = {
  id: string; direction: string; system: ExchangeSystem; operation: string; activityId: string | null; actorSub: string;
  correlationId: string; idempotencyKey: string; externalEventId: string | null;
  status: 'queued' | 'sent' | 'accepted' | 'performed' | 'rejected' | 'retryable_error'; attemptCount: number;
  payload: Record<string, unknown>; response: Record<string, unknown> | null; lastError: string | null;
  createdAt: string; updatedAt: string;
};
type MockEvent = {
  eventId: string; correlationId: string; eventType: string; occurredAt: string;
  lead?: { kind: 'individual' | 'corporate'; title: string; personName: string; organizationName?: string; externalReference: string };
  activityReference?: string; factKind?: LearningFactKind; reference?: string;
};
type ServiceOptions = { cmsUrl: string; lmsUrl: string; fetcher?: typeof fetch };
const MAX_ATTEMPTS = 3;
const DISPATCH_LEASE_SECONDS = 30;
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 500) : 'Mock exchange request failed.';
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const actorIsAdmin = (actor: Actor) => actor.roles.includes('admin');
const batchPullOperation = (job: Pick<ExchangeJob, 'operation'>) => job.operation === 'pull_inquiries' || job.operation === 'pull_learning_facts';
const retryableState = (job: ExchangeJob) => (job.status === 'retryable_error' || job.status === 'queued') && job.attemptCount < MAX_ATTEMPTS;
const technicalJob = (job: ExchangeJob, canRetry = batchPullOperation(job) && retryableState(job)) => ({
  id: job.id, direction: job.direction, system: job.system, operation: job.operation,
  status: job.status, attemptCount: job.attemptCount, createdAt: job.createdAt, updatedAt: job.updatedAt,
  activityLinked: Boolean(job.activityId), error: Boolean(job.lastError), canRetry,
  summary: Object.fromEntries(['processed', 'matched', 'duplicates', 'conflicts', 'errors', 'rejected', 'deferred']
    .filter((key) => typeof job.response?.[key] === 'number')
    .map((key) => [key, job.response![key] as number])),
});
type TechnicalExchangeJob = ReturnType<typeof technicalJob>;
const presentJob = (actor: Actor, job: ExchangeJob | TechnicalExchangeJob): ExchangeJob | TechnicalExchangeJob => {
  if ('activityLinked' in job) return job;
  // A batch result can aggregate events from multiple business records, so it must
  // remain compact even for a manager whose team scope may exclude imported records.
  return hasTeamBusinessScope(actor) && !batchPullOperation(job) ? job : technicalJob(job);
};
const technicalServiceStatus = (value: Record<string, unknown>) => ({
  mode: value.mode === 'mock' ? 'mock' : 'unknown', status: value.status === 'ok' ? 'ok' : 'unavailable',
  ...(typeof value.eventCount === 'number' ? { eventCount: value.eventCount } : {}),
  ...(typeof value.requestCount === 'number' ? { requestCount: value.requestCount } : {}),
  ...(typeof value.updatedStatusCount === 'number' ? { updatedStatusCount: value.updatedStatusCount } : {}),
  ...(value.status !== 'ok' ? { error: 'Сервис недоступен.' } : {}),
});
const cmsDetailValue = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
const dto = (row: any): ExchangeJob => ({
  id: row.id, direction: row.direction, system: row.system, operation: row.operation, activityId: row.activity_id,
  actorSub: row.actor_sub, correlationId: row.correlation_id, idempotencyKey: row.idempotency_key,
  externalEventId: row.external_event_id, status: row.status, attemptCount: Number(row.attempt_count),
  payload: row.payload ?? {}, response: row.response ?? null, lastError: row.last_error,
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
});

export class PostgresExchangeService {
  private readonly fetcher: typeof fetch;
  constructor(private readonly repository: CrmRepository, private readonly options: ServiceOptions) {
    for (const [name, address] of [['CMS', options.cmsUrl], ['LMS', options.lmsUrl]] as const) {
      const url = new URL(address);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`${name} exchange endpoint must be a plain HTTP loopback origin for the local mock service.`);
      }
    }
    this.fetcher = options.fetcher ?? fetch;
  }
  private base(system: ExchangeSystem) { return system === 'cms' ? this.options.cmsUrl : this.options.lmsUrl; }
  private async call(system: ExchangeSystem, path: string, init?: RequestInit) {
    const response = await this.fetcher(`${this.base(system)}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    return { response, body };
  }
  private async requireActivity(actor: Actor, activityId: string) {
    const activity = await this.repository.getActivity(actor, activityId);
    if (!activity) throw new DomainError(404, 'activity_not_found', 'Активность не найдена.');
    return activity as Record<string, any>;
  }
  private async createJob(input: {
    direction: string; system: ExchangeSystem; operation: string; actor: Actor; activityId?: string | null;
    correlationId?: string; idempotencyKey?: string; externalEventId?: string | null; status?: ExchangeJob['status'];
    payload?: Record<string, unknown>; scopeKey?: string;
  }) {
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const scopeKey = input.scopeKey ?? input.activityId ?? input.actor.sub;
    const inserted = await pool.query(`INSERT INTO exchange_jobs
      (id,direction,system,operation,activity_id,actor_sub,scope_key,correlation_id,idempotency_key,external_event_id,status,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT(direction,scope_key,idempotency_key) DO NOTHING RETURNING *`, [
      randomUUID(), input.direction, input.system, input.operation, input.activityId ?? null, input.actor.sub, scopeKey,
      input.correlationId ?? randomUUID(), idempotencyKey, input.externalEventId ?? null, input.status ?? 'queued', JSON.stringify(input.payload ?? {}),
    ]);
    if (inserted.rows[0]) return dto(inserted.rows[0]);
    const existing = await pool.query('SELECT * FROM exchange_jobs WHERE direction=$1 AND scope_key=$2 AND idempotency_key=$3', [input.direction, scopeKey, idempotencyKey]);
    if (!existing.rows[0]) throw new DomainError(500, 'exchange_job_create_failed', 'Не удалось создать задание обмена.');
    return dto(existing.rows[0]);
  }
  private async setStatus(id: string, status: ExchangeJob['status'], fields: { response?: unknown; error?: string; attemptCount?: number; activityId?: string | null; externalEventId?: string | null } = {}) {
    const result = await pool.query(`UPDATE exchange_jobs SET status=$2, response=COALESCE($3::jsonb,response),
      last_error=$4, attempt_count=COALESCE($5,attempt_count), activity_id=COALESCE($6,activity_id),
      external_event_id=COALESCE($7,external_event_id), updated_at=now()
      WHERE id=$1 AND ($5::integer IS NULL OR (attempt_count=$5 AND status='sent')) RETURNING *`, [
      id, status, fields.response === undefined ? null : JSON.stringify(fields.response), fields.error ?? null,
      fields.attemptCount ?? null, fields.activityId ?? null, fields.externalEventId ?? null,
    ]);
    return dto(result.rows[0] ?? await this.getJob(id));
  }
  private async claimJob(id: string) {
    const result = await pool.query(`UPDATE exchange_jobs SET status='sent',attempt_count=attempt_count+1,last_error=NULL,updated_at=now()
      WHERE id=$1 AND attempt_count < $2 AND status IN ('queued','retryable_error') RETURNING *`, [id, MAX_ATTEMPTS]);
    return result.rows[0] ? dto(result.rows[0]) : null;
  }
  private async claimLmsRequest(actor: Actor, job: ExchangeJob) {
    if (!job.activityId) throw new DomainError(404, 'exchange_job_not_found', 'Задание обмена не найдено.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the final scope check with reassignment and workflow changes. Lock ordering is
      // activity -> exchange job, matching reassignment's activity-first transaction.
      const activityResult = await client.query(`SELECT a.id,a.kind,a.closed,a.stage_key
        FROM activities a
        WHERE a.id=$1 AND ($3::boolean AND (a.import_owner_only=FALSE OR a.owner_sub=$2)
          OR NOT $3::boolean AND $4::boolean AND a.owner_sub=$2)
          AND ($5::uuid[] IS NULL OR
            ((a.organization_id IS NULL OR a.organization_id=ANY($5::uuid[]))
              AND (a.payer_organization_id IS NULL OR a.payer_organization_id=ANY($5::uuid[]))))
        FOR UPDATE OF a`, [job.activityId, actor.sub, hasTeamBusinessScope(actor), hasBusinessAccess(actor), actor.allowedOrganizationIds ?? null]);
      const activity = activityResult.rows[0];
      if (!activity) throw new DomainError(404, 'exchange_job_not_found', 'Задание обмена не найдено.');
      assertActivityKindAllowed(actor, activity.kind as ActivityKind);
      if (activity.kind !== 'individual') throw new DomainError(409, 'lms_request_not_applicable', 'Запрос на учебное действие применим только к индивидуальной активности.');
      if (activity.closed) throw new DomainError(409, 'activity_closed', 'В закрытую активность нельзя отправить запрос.');
      if (activity.stage_key !== 'lms_handoff') throw new DomainError(409, 'lms_handoff_required', 'Запрос доступен на стадии передачи в LMS.');
      const claimed = await client.query(`UPDATE exchange_jobs SET status='sent',attempt_count=attempt_count+1,last_error=NULL,updated_at=now()
        WHERE id=$1 AND activity_id=$2 AND direction='crm_to_lms' AND system='lms' AND operation='prepare_access'
          AND attempt_count < $3 AND status IN ('queued','retryable_error') RETURNING *`, [job.id, job.activityId, MAX_ATTEMPTS]);
      await client.query('COMMIT');
      return claimed.rows[0] ? dto(claimed.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  private async getJob(jobId: string) {
    const result = await pool.query('SELECT * FROM exchange_jobs WHERE id=$1::uuid', [jobId]);
    return result.rows[0] ? dto(result.rows[0]) : null;
  }
  private async recoverExpiredDispatches() {
    await pool.query(`UPDATE exchange_jobs SET status='retryable_error',last_error='No final acknowledgement arrived before the local request lease expired; retry reuses the same idempotency key.',updated_at=now()
      WHERE status='sent' AND updated_at < now() - ($1::integer * interval '1 second')`, [DISPATCH_LEASE_SECONDS]);
  }
  private async retryAuthorized(actor: Actor, job: ExchangeJob) {
    // Retrying a batch pull repeats a technical integration read. Retrying a specific
    // business operation still requires access to its linked activity.
    if (batchPullOperation(job)) return actorIsAdmin(actor);
    if (job.activityId) return hasBusinessAccess(actor) && Boolean(await this.repository.getActivity(actor, job.activityId));
    return hasBusinessAccess(actor) && (hasTeamBusinessScope(actor) || job.actorSub === actor.sub);
  }
  private async canRetryJob(actor: Actor, job: ExchangeJob) {
    return retryableState(job) && this.retryAuthorized(actor, job);
  }
  async listForActivity(actor: Actor, activityId: string) {
    await this.requireActivity(actor, activityId);
    await this.recoverExpiredDispatches();
    const result = await pool.query('SELECT * FROM exchange_jobs WHERE activity_id=$1 ORDER BY created_at DESC LIMIT 100', [activityId]);
    return result.rows.map(dto);
  }
  async cmsIntake(actor: Actor) {
    if (!hasBusinessAccess(actor)) throw new DomainError(403, 'forbidden', 'Входящие обращения недоступны этой роли.');
    const result = await pool.query(`SELECT a.id,a.kind,a.title,a.origin_reference AS "originReference",a.owner_name AS "intakeOwner",
        p.full_name AS "personName",o.name AS "organizationName",a.created_at AS "createdAt"
      FROM activities a LEFT JOIN people p ON p.id=a.person_id LEFT JOIN organizations o ON o.id=a.organization_id
      WHERE a.origin='cms_mock' AND a.closed=FALSE AND EXISTS(
        SELECT 1 FROM exchange_jobs j WHERE j.activity_id=a.id AND j.direction='cms_to_crm'
          AND j.operation='receive_inquiry' AND j.actor_sub=a.owner_sub)
        AND ($1::text[] IS NULL OR a.kind=ANY($1::text[]))
        AND ($2::uuid[] IS NULL OR
          ((a.organization_id IS NULL OR a.organization_id=ANY($2::uuid[]))
            AND (a.payer_organization_id IS NULL OR a.payer_organization_id=ANY($2::uuid[]))))
      ORDER BY a.created_at ASC LIMIT 100`, [actor.allowedKinds ?? null, actor.allowedOrganizationIds ?? null]);
    return result.rows;
  }
  async claimCmsIntake(actor: Actor, activityId: string) {
    if (!actor.roles.includes('kam')) throw new DomainError(403, 'forbidden', 'Назначить входящее обращение может КАМ.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const available = await client.query(`SELECT a.kind FROM activities a
        WHERE a.id=$1 AND a.origin='cms_mock' AND a.closed=FALSE AND a.owner_sub=(
          SELECT j.actor_sub FROM exchange_jobs j WHERE j.activity_id=a.id AND j.direction='cms_to_crm'
            AND j.operation='receive_inquiry' ORDER BY j.created_at LIMIT 1)
          AND ($2::uuid[] IS NULL OR
            ((a.organization_id IS NULL OR a.organization_id=ANY($2::uuid[]))
              AND (a.payer_organization_id IS NULL OR a.payer_organization_id=ANY($2::uuid[]))))
        FOR UPDATE OF a`, [activityId, actor.allowedOrganizationIds ?? null]);
      if (!available.rows[0]) throw new DomainError(409, 'cms_inquiry_unavailable', 'Это обращение уже назначено или недоступно.');
      assertActivityKindAllowed(actor, available.rows[0].kind as ActivityKind);
      const claimed = await client.query(`UPDATE activities a SET owner_sub=$2,owner_name=$3,updated_at=now()
        WHERE a.id=$1 AND a.origin='cms_mock' AND a.closed=FALSE AND a.owner_sub=(
          SELECT j.actor_sub FROM exchange_jobs j WHERE j.activity_id=a.id AND j.direction='cms_to_crm'
            AND j.operation='receive_inquiry' ORDER BY j.created_at LIMIT 1)
        RETURNING a.id`, [activityId, actor.sub, actor.name]);
      if (!claimed.rows[0]) throw new DomainError(409, 'cms_inquiry_unavailable', 'Это обращение уже назначено или недоступно.');
      const assignment = await client.query(`SELECT j.actor_sub AS "fromSub" FROM exchange_jobs j
        WHERE j.activity_id=$1 AND j.direction='cms_to_crm' AND j.operation='receive_inquiry' ORDER BY j.created_at LIMIT 1`, [activityId]);
      await client.query(`INSERT INTO activity_events(id,activity_id,event_type,summary,details,actor_sub,actor_name)
        VALUES($1,$2,'cms_inquiry_assigned','Входящее обращение назначено КАМ',$3::jsonb,$4,$5)`, [
        randomUUID(), activityId, JSON.stringify({ source: 'CMS mock', fromOwnerSub: assignment.rows[0]?.fromSub ?? null, toOwnerSub: actor.sub }), actor.sub, actor.name,
      ]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return this.requireActivity(actor, activityId);
  }
  async monitor(actor: Actor) {
    this.assertAdmin(actor);
    await this.recoverExpiredDispatches();
    const rows = await pool.query('SELECT * FROM exchange_jobs ORDER BY created_at DESC LIMIT 200');
    const jobs = rows.rows.map(dto);
    const linkedActivityIds = [...new Set(jobs.flatMap((job) => job.activityId ? [job.activityId] : []))];
    const visibleActivityIds = new Set<string>();
    if (hasBusinessAccess(actor)) {
      const accessible = await Promise.all(linkedActivityIds.map(async (activityId) =>
        await this.repository.getActivity(actor, activityId) ? activityId : null));
      for (const activityId of accessible) if (activityId) visibleActivityIds.add(activityId);
    }
    const [cms, lms] = await Promise.all(['cms', 'lms'].map(async (system) => {
      try {
        const { response, body } = await this.call(system as ExchangeSystem, '/status');
        return response.ok ? technicalServiceStatus(body) : { mode: 'mock', status: 'unavailable', error: 'Сервис недоступен.' };
      } catch { return { mode: 'mock', status: 'unavailable', error: 'Сервис недоступен.' }; }
    }));
    const presentedJobs = await Promise.all(jobs.map(async (job) => {
      if (hasTeamBusinessScope(actor) && job.activityId && visibleActivityIds.has(job.activityId)) return job;
      return technicalJob(job, await this.canRetryJob(actor, job));
    }));
    return { mode: 'mock', services: { cms, lms }, jobs: presentedJobs, retryLimit: MAX_ATTEMPTS };
  }
  assertAdmin(actor: Actor) {
    if (!actorIsAdmin(actor)) throw new DomainError(403, 'forbidden', 'Для управления обменом нужна роль администратора.');
  }
  async setFailure(actor: Actor, system: ExchangeSystem, mode: ExchangeFailureMode) {
    this.assertAdmin(actor);
    const { response, body } = await this.call(system, '/control/fail-next', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    if (!response.ok) throw new DomainError(503, 'mock_unavailable', body.message ?? 'Не удалось настроить локальный mock.');
    return { system, mode: 'mock', nextOperation: body.nextOperation };
  }
  async requestLms(actor: Actor, activityId: string, idempotencyKey: string) {
    const activity = await this.requireActivity(actor, activityId);
    assertActivityKindAllowed(actor, activity.kind as ActivityKind);
    if (activity.kind !== 'individual') throw new DomainError(409, 'lms_request_not_applicable', 'Запрос на учебное действие применим только к индивидуальной активности.');
    if (activity.closed) throw new DomainError(409, 'activity_closed', 'В закрытую активность нельзя отправить запрос.');
    if (activity.stageKey !== 'lms_handoff') throw new DomainError(409, 'lms_handoff_required', 'Запрос доступен на стадии передачи в LMS.');
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey)) throw new DomainError(400, 'invalid_idempotency_key', 'Укажите непрозрачный ключ идемпотентности до 160 символов.');
    const correlationId = randomUUID();
    const job = await this.createJob({ direction: 'crm_to_lms', system: 'lms', operation: 'prepare_access', actor, activityId, correlationId, idempotencyKey, payload: { activityReference: activityId, requestedAction: 'prepare_access' } });
    if (job.status !== 'queued') return job;
    return this.dispatchLmsRequest(actor, job);
  }
  private async dispatchLmsRequest(actor: Actor, job: ExchangeJob) {
    const claimed = await this.claimLmsRequest(actor, job);
    if (!claimed) {
      const current = await this.getJob(job.id);
      if (!current) throw new DomainError(404, 'exchange_job_not_found', 'Задание обмена не найдено.');
      if (current.attemptCount >= MAX_ATTEMPTS && current.status === 'retryable_error') throw new DomainError(409, 'exchange_retry_limit', 'Исчерпан предел автоматизированных повторов для этого задания.');
      return current;
    }
    const attemptCount = claimed.attemptCount;
    try {
      const { response, body } = await this.call('lms', '/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        operation: job.operation, correlationId: job.correlationId, idempotencyKey: `${job.activityId}:${job.idempotencyKey}`, activityReference: job.activityId,
      }) });
      if (!response.ok) return this.setStatus(job.id, 'retryable_error', { attemptCount, response: { httpStatus: response.status }, error: body.message ?? `LMS mock returned HTTP ${response.status}.` });
      if (body.status === 'rejected') return this.setStatus(job.id, 'rejected', { attemptCount, response: body, error: body.reason ?? 'LMS mock rejected the request.' });
      if (!['accepted', 'performed'].includes(body.status) || body.correlationId !== job.correlationId) return this.setStatus(job.id, 'retryable_error', { attemptCount, response: body, error: 'LMS mock returned an unknown or mismatched acknowledgement.' });
      return this.setStatus(job.id, 'accepted', { attemptCount, response: body });
    } catch (error) { return this.setStatus(job.id, 'retryable_error', { attemptCount, error: safeError(error) }); }
  }
  async retry(actor: Actor, jobId: string) {
    await this.recoverExpiredDispatches();
    const job = await this.getJob(jobId);
    if (!job || !await this.retryAuthorized(actor, job)) throw new DomainError(404, 'exchange_job_not_found', 'Задание обмена не найдено или недоступно.');
    if (job.status !== 'retryable_error' && job.status !== 'queued') throw new DomainError(409, 'exchange_not_retryable', 'Повторить можно только задание с технической ошибкой.');
    if (job.attemptCount >= MAX_ATTEMPTS) throw new DomainError(409, 'exchange_retry_limit', 'Достигнут предел в три отправки для этого задания.');
    if (job.system === 'lms' && job.operation === 'prepare_access') return presentJob(actor, await this.dispatchLmsRequest(actor, job));
    if (job.system === 'cms' && job.operation === 'return_status') return presentJob(actor, await this.sendCmsStatus(job));
    if (job.system === 'cms' && job.operation === 'pull_inquiries') return this.pullCms(actor, actor.sub, job.id);
    if (job.system === 'lms' && job.operation === 'pull_learning_facts') return this.pullLms(actor, actor.sub, job.id);
    throw new DomainError(409, 'exchange_not_retryable', 'Это направление нельзя повторить.');
  }
  private async insertInboundEvent(job: ExchangeJob, system: ExchangeSystem, event: MockEvent, payload: Record<string, unknown>) {
    const result = await pool.query(`INSERT INTO exchange_events(id,job_id,source_system,direction,event_id,correlation_id,event_type,occurred_at,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(source_system,event_id) DO NOTHING RETURNING id`, [
      randomUUID(), job.id, system, system === 'cms' ? 'cms_to_crm' : 'lms_to_crm', event.eventId,
      event.correlationId, typeof event.eventType === 'string' ? event.eventType : 'invalid', event.occurredAt, JSON.stringify(payload),
    ]);
    return Boolean(result.rowCount);
  }
  private async acknowledgeLmsEvent(event: MockEvent, jobId: string) {
    const { response, body } = await this.call('lms', `/events/${encodeURIComponent(event.eventId)}/ack`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'accepted' }),
    });
    if (!response.ok) return;
    await pool.query(`UPDATE exchange_jobs SET response=COALESCE(response,'{}'::jsonb) || $2::jsonb,updated_at=now() WHERE id=$1`, [jobId, JSON.stringify({ receiverAcknowledgement: body })]);
  }
  private async createCmsActivityEvent(actor: Actor, event: MockEvent) {
    const lead = event.lead!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cms:${event.eventId}`]);
      const referenceResult = await client.query('SELECT lower(btrim($1::text)) AS reference_key', [lead.externalReference]);
      const referenceKey = referenceResult.rows[0].reference_key as string;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cms-ref:${referenceKey}`]);
      const prior = await client.query(`SELECT e.job_id,j.activity_id,j.status,j.last_error,j.response FROM exchange_events e
        JOIN exchange_jobs j ON j.id=e.job_id WHERE e.source_system='cms' AND e.event_id=$1`, [event.eventId]);
      if (prior.rows[0]) {
        await client.query('COMMIT');
        return {
          duplicate: true, matched: false, conflict: prior.rows[0].status === 'rejected',
          conflictDetails: prior.rows[0].response?.conflict ?? null,
          conflictReason: prior.rows[0].last_error as string | null,
          jobId: prior.rows[0].job_id as string, activityId: prior.rows[0].activity_id as string | null,
        };
      }
      const existing = await client.query(`SELECT a.id,a.kind,a.title,p.full_name AS person_name,o.name AS organization_name
        FROM activities a
        LEFT JOIN people p ON p.id=a.person_id
        LEFT JOIN organizations o ON o.id=a.organization_id
        WHERE a.origin='cms_mock' AND lower(btrim(a.origin_source))='cms mock'
          AND lower(btrim(a.origin_reference))=$1
        FOR UPDATE OF a`, [referenceKey]);
      const incoming = {
        kind: lead.kind,
        title: cmsDetailValue(lead.title),
        personName: cmsDetailValue(lead.personName),
        organizationName: lead.kind === 'corporate' ? cmsDetailValue(lead.organizationName?.trim() || 'Компания из CMS') : null,
      };
      if (existing.rows[0]) {
        const saved = existing.rows[0];
        const differences: string[] = [];
        if (saved.kind !== incoming.kind) differences.push('kind');
        if (cmsDetailValue(saved.title) !== incoming.title) differences.push('title');
        if (cmsDetailValue(saved.person_name) !== incoming.personName) differences.push('personName');
        if (incoming.kind === 'corporate' && cmsDetailValue(saved.organization_name ?? '') !== incoming.organizationName) differences.push('organizationName');
        const conflict = differences.length > 0;
        const activityId = saved.id as string;
        const jobId = randomUUID();
        const scopeKey = `cms-event:${event.eventId}`;
        const idempotencyKey = `cms-event:${event.eventId}`;
        const conflictDetails = conflict ? {
          code: 'external_reference_conflict', activityId, externalReference: lead.externalReference,
          conflictingFields: differences, saved: {
            kind: saved.kind, title: saved.title, personName: saved.person_name,
            organizationName: saved.organization_name,
          }, incoming: {
            kind: lead.kind, title: lead.title, personName: lead.personName,
            organizationName: lead.organizationName ?? null,
          },
        } : null;
        const reason = conflict ? `CMS external reference matches an existing activity, but lead details differ (${differences.join(', ')}).` : null;
        await client.query(`INSERT INTO exchange_jobs(id,direction,system,operation,activity_id,actor_sub,scope_key,correlation_id,idempotency_key,external_event_id,status,payload,response,last_error)
          VALUES($1,'cms_to_crm','cms','receive_inquiry',$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`, [
          jobId, activityId, actor.sub, scopeKey, event.correlationId, idempotencyKey, event.eventId, conflict ? 'rejected' : 'performed',
          JSON.stringify({ source: 'CMS mock', externalReference: lead.externalReference, sourceOccurredAt: event.occurredAt, lead }),
          conflictDetails ? JSON.stringify({ conflict: conflictDetails }) : JSON.stringify({ match: 'normalized_external_reference', activityReference: activityId }),
          reason,
        ]);
        await client.query(`INSERT INTO exchange_events(id,job_id,source_system,direction,event_id,correlation_id,event_type,occurred_at,payload)
          VALUES($1,$2,'cms','cms_to_crm',$3,$4,$5,$6,$7::jsonb)`, [
          randomUUID(), jobId, event.eventId, event.correlationId, event.eventType, new Date(event.occurredAt),
          JSON.stringify({ source: 'CMS mock', externalReference: lead.externalReference, activityReference: activityId, lead, ...(conflictDetails ? { conflict: conflictDetails } : { match: 'normalized_external_reference' }) }),
        ]);
        await client.query(`INSERT INTO activity_events(id,activity_id,event_type,summary,details,actor_sub,actor_name)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [
          randomUUID(), activityId, conflict ? 'cms_inquiry_conflict' : 'cms_inquiry_matched',
          conflict ? 'Входящая заявка CMS конфликтует с существующей ссылкой' : 'Повторная заявка CMS сопоставлена по внешней ссылке',
          JSON.stringify(conflictDetails ?? { source: 'CMS mock', eventId: event.eventId, externalReference: lead.externalReference, matchedBy: 'normalized_external_reference' }),
          actor.sub, actor.name,
        ]);
        await client.query('COMMIT');
        return { duplicate: false, matched: !conflict, conflict, conflictDetails, conflictReason: reason, jobId, activityId };
      }
      const activityId = randomUUID();
      const jobId = randomUUID();
      const organizationId = lead.kind === 'corporate' ? randomUUID() : null;
      const personId = randomUUID();
      const scopeKey = `cms-event:${event.eventId}`;
      const idempotencyKey = `cms-event:${event.eventId}`;
      await client.query(`INSERT INTO exchange_jobs(id,direction,system,operation,activity_id,actor_sub,scope_key,correlation_id,idempotency_key,external_event_id,status,payload)
        VALUES($1,'cms_to_crm','cms','receive_inquiry',NULL,$2,$3,$4,$5,$6,'performed',$7::jsonb)`, [
        jobId, actor.sub, scopeKey, event.correlationId, idempotencyKey, event.eventId,
        JSON.stringify({ source: 'CMS mock', externalReference: lead.externalReference, sourceOccurredAt: event.occurredAt }),
      ]);
      if (organizationId) await client.query("INSERT INTO organizations(id,name,segment) VALUES($1,$2,'company')", [organizationId, lead.organizationName?.trim() || 'Компания из CMS']);
      await client.query('INSERT INTO people(id,full_name) VALUES($1,$2)', [personId, lead.personName.trim()]);
      const stage = await client.query(`SELECT stage_key FROM workflow_stages WHERE kind=$1 ORDER BY ordinal LIMIT 1`, [lead.kind]);
      if (!stage.rows[0]) throw new Error(`No initial CMS activity stage for ${lead.kind}.`);
      const routeVersion = lead.kind === 'individual' ? 'v2' : 'legacy';
      await client.query(`INSERT INTO activities(id,kind,title,organization_id,person_id,stage_key,owner_sub,owner_name,route_version,origin,origin_source,origin_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'cms_mock','CMS mock',$10)`, [
        activityId, lead.kind, lead.title.trim(), organizationId, personId, stage.rows[0].stage_key, actor.sub, actor.name,
        routeVersion, lead.externalReference.trim(),
      ]);
      await client.query(`INSERT INTO activity_events(id,activity_id,event_type,summary,details,actor_sub,actor_name)
        VALUES($1,$2,'cms_inquiry_received','Получена заявка из CMS mock',$3::jsonb,$4,$5)`, [
        randomUUID(), activityId, JSON.stringify({ source: 'CMS mock', externalReference: lead.externalReference, sourceOccurredAt: event.occurredAt, eventId: event.eventId }), actor.sub, actor.name,
      ]);
      await client.query('UPDATE exchange_jobs SET activity_id=$2 WHERE id=$1', [jobId, activityId]);
      await client.query(`INSERT INTO exchange_events(id,job_id,source_system,direction,event_id,correlation_id,event_type,occurred_at,payload)
        VALUES($1,$2,'cms','cms_to_crm',$3,$4,$5,$6,$7::jsonb)`, [
        randomUUID(), jobId, event.eventId, event.correlationId, event.eventType, new Date(event.occurredAt),
        JSON.stringify({ source: 'CMS mock', externalReference: lead.externalReference, activityReference: activityId }),
      ]);
      await client.query('COMMIT');
      return { duplicate: false, matched: false, conflict: false, conflictDetails: null, conflictReason: null, jobId, activityId };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private async returnCmsStatus(actor: Actor, event: MockEvent, activityId: string) {
    const ack = await this.createJob({ direction: 'crm_to_cms', system: 'cms', operation: 'return_status', actor, activityId, correlationId: event.correlationId, idempotencyKey: `cms-status:${event.eventId}`, externalEventId: event.eventId, payload: { status: 'received', activityReference: activityId } });
    if (ack.status === 'queued' || ack.status === 'retryable_error') await this.sendCmsStatus(ack);
  }
  async pullCms(actor: Actor, _actorSub = actor.sub, retryJobId?: string) {
    this.assertAdmin(actor);
    let job = retryJobId ? await this.getJob(retryJobId) : null;
    if (!job) job = await this.createJob({ direction: 'cms_to_crm', system: 'cms', operation: 'pull_inquiries', actor, idempotencyKey: randomUUID(), payload: { mode: 'mock' } });
    const claimed = await this.claimJob(job.id);
    if (!claimed) return presentJob(actor, (await this.getJob(job.id))!);
    const attemptCount = claimed.attemptCount;
    let events: MockEvent[];
    try {
      const { response, body } = await this.call('cms', '/events');
      if (!response.ok) return presentJob(actor, await this.setStatus(job.id, 'retryable_error', { attemptCount, response: { httpStatus: response.status }, error: body.message ?? `CMS mock returned HTTP ${response.status}.` }));
      if (!Array.isArray(body.events)) return presentJob(actor, await this.setStatus(job.id, 'retryable_error', { attemptCount, error: 'CMS mock response has no events array.' }));
      events = body.events;
    } catch (error) { return presentJob(actor, await this.setStatus(job.id, 'retryable_error', { attemptCount, error: safeError(error) })); }
    let processed = 0; let duplicates = 0; let matched = 0; let conflicts = 0; let errors = 0; const eventErrors: string[] = []; const conflictDetails: Record<string, unknown>[] = [];
    for (const event of events) {
      if (!event || typeof event.eventId !== 'string' || !uuid(event.correlationId) || !event.lead || event.eventType !== 'inquiry.submitted' || !Number.isFinite(Date.parse(event.occurredAt))) { errors += 1; continue; }
      const lead = event.lead;
      if (!['individual', 'corporate'].includes(lead.kind) || typeof lead.personName !== 'string' || !lead.personName.trim() || typeof lead.title !== 'string' || !lead.title.trim() || typeof lead.externalReference !== 'string' || !lead.externalReference.trim() || lead.externalReference.trim().length > 240 || (lead.organizationName !== undefined && typeof lead.organizationName !== 'string')) { errors += 1; continue; }
      try {
        const received = await this.createCmsActivityEvent(actor, event);
        if (!received.activityId) { duplicates += 1; continue; }
        const activityId = received.activityId;
        if (received.conflict) {
          conflicts += 1;
          conflictDetails.push({ eventId: event.eventId, ...((received.conflictDetails as Record<string, unknown> | null) ?? {}), reason: received.conflictReason });
        } else {
          await this.returnCmsStatus(actor, event, activityId);
          if (received.duplicate) duplicates += 1;
          else if (received.matched) matched += 1;
          else processed += 1;
        }
      } catch (error) { errors += 1; eventErrors.push(safeError(error)); }
    }
    return presentJob(actor, await this.setStatus(job.id, errors ? 'retryable_error' : 'accepted', { attemptCount, response: { processed, matched, duplicates, conflicts, conflictDetails, errors, eventErrors }, error: errors ? `${errors} CMS event(s) could not be processed: ${eventErrors[0] ?? 'unknown error'}` : undefined }));
  }
  private async sendCmsStatus(job: ExchangeJob) {
    const claimed = await this.claimJob(job.id);
    if (!claimed) return (await this.getJob(job.id))!;
    const attemptCount = claimed.attemptCount;
    try {
      const { response, body } = await this.call('cms', `/events/${encodeURIComponent(job.externalEventId ?? '')}/ack`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': job.idempotencyKey }, body: JSON.stringify(job.payload),
      });
      if (!response.ok) return this.setStatus(job.id, 'retryable_error', { attemptCount, response: { httpStatus: response.status }, error: body.message ?? `CMS mock returned HTTP ${response.status}.` });
      if (body.status === 'rejected') return this.setStatus(job.id, 'rejected', { attemptCount, response: body, error: body.reason ?? 'CMS mock rejected the status update.' });
      if (body.status !== 'accepted') return this.setStatus(job.id, 'retryable_error', { attemptCount, response: body, error: 'CMS mock returned an unknown acknowledgement.' });
      return this.setStatus(job.id, 'accepted', { attemptCount, response: body });
    } catch (error) { return this.setStatus(job.id, 'retryable_error', { attemptCount, error: safeError(error) }); }
  }
  async pullLms(actor: Actor, _actorSub = actor.sub, retryJobId?: string) {
    this.assertAdmin(actor);
    let job = retryJobId ? await this.getJob(retryJobId) : null;
    if (!job) job = await this.createJob({ direction: 'lms_to_crm', system: 'lms', operation: 'pull_learning_facts', actor, payload: { mode: 'mock' } });
    const claimed = await this.claimJob(job.id);
    if (!claimed) return presentJob(actor, (await this.getJob(job.id))!);
    const attemptCount = claimed.attemptCount;
    try {
      const { response, body } = await this.call('lms', '/events');
      if (!response.ok) return presentJob(actor, await this.setStatus(job.id, 'retryable_error', { attemptCount, response: { httpStatus: response.status }, error: body.message ?? `LMS mock returned HTTP ${response.status}.` }));
      if (!Array.isArray(body.events)) return presentJob(actor, await this.setStatus(job.id, 'retryable_error', { attemptCount, error: 'LMS mock response has no events array.' }));
      let processed = 0; let duplicates = 0; let rejected = 0; let deferredCount = 0;
      for (const event of body.events as MockEvent[]) {
        if (!event || typeof event.eventId !== 'string' || !uuid(event.correlationId) || !Number.isFinite(Date.parse(event.occurredAt))) { rejected += 1; continue; }
        const existing = await pool.query(`SELECT e.job_id,j.status FROM exchange_events e JOIN exchange_jobs j ON j.id=e.job_id
          WHERE e.source_system='lms' AND e.event_id=$1`, [event.eventId]);
        if (existing.rows[0]) {
          if (existing.rows[0].status === 'performed') await this.acknowledgeLmsEvent(event, existing.rows[0].job_id);
          duplicates += 1;
          continue;
        }
        const outboundResult = await pool.query(`SELECT * FROM exchange_jobs WHERE system='lms' AND direction='crm_to_lms' AND correlation_id=$1`, [event.correlationId]);
        const outbound = outboundResult.rows[0] ? dto(outboundResult.rows[0]) : null;
        const eventJob = await this.createJob({ direction: 'lms_to_crm', system: 'lms', operation: 'receive_learning_fact', actor, activityId: outbound?.activityId ?? null, externalEventId: event.eventId, correlationId: event.correlationId, idempotencyKey: `lms-event:${event.eventId}`, scopeKey: `lms-event:${event.eventId}`, status: 'queued', payload: { sourceOccurredAt: event.occurredAt } });
        let reason: string | undefined;
        let deferred = false;
        if (!outbound) reason = 'Не найден исходящий запрос для внешнего события.';
        else if (['sent', 'queued', 'retryable_error'].includes(outbound.status)) {
          reason = 'Подтверждение исходящего запроса ещё не определено; факт останется доступен для повторной обработки после повтора запроса.';
          deferred = true;
        }
        else if (!['accepted', 'performed'].includes(outbound.status)) reason = 'Исходящий запрос был отклонён внешним источником.';
        if (event.eventType !== 'learning.fact') { reason = 'Внешнее событие не соответствует типу learning.fact.'; deferred = false; }
        if (!event.activityReference || outbound?.activityId !== event.activityReference) { reason = 'Внешняя ссылка не сопоставлена с исходящим запросом.'; deferred = false; }
        const activityResult = outbound?.activityId
          ? await pool.query('SELECT id,kind FROM activities WHERE id=$1::uuid LIMIT 1', [outbound.activityId])
          : null;
        const activity = activityResult?.rows[0] as { id: string; kind: string } | undefined;
        if (!activity) { reason = 'Активность не найдена в разрешённой области.'; deferred = false; }
        else if (!isActivityKindAllowed(actor, activity.kind as ActivityKind)) { reason = 'Активность находится вне разрешённого сегмента.'; deferred = false; }
        else if (activity.kind !== 'individual') { reason = 'Учебная проекция доступна только для индивидуального процесса.'; deferred = false; }
        const factKinds: LearningFactKind[] = ['enrollment', 'learning_started', 'learning_completed'];
        if (!factKinds.includes(event.factKind as LearningFactKind) || typeof event.reference !== 'string' || !event.reference) { reason = 'Внешнее событие не соответствует контракту факта обучения.'; deferred = false; }
        await pool.query(`UPDATE exchange_jobs SET status=$2,last_error=$3,updated_at=now() WHERE id=$1`, [eventJob.id, reason ? 'rejected' : 'queued', reason ?? null]);
        if (reason) {
          if (!deferred) await this.insertInboundEvent(eventJob, 'lms', event, { factKind: event.factKind, reference: event.reference, activityReference: event.activityReference, eventType: event.eventType });
          else await pool.query(`UPDATE exchange_jobs SET status='retryable_error',updated_at=now() WHERE id=$1`, [eventJob.id]);
          if (deferred) deferredCount += 1;
          else rejected += 1;
          continue;
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const persisted = await client.query(`INSERT INTO exchange_events(id,job_id,source_system,direction,event_id,correlation_id,event_type,occurred_at,payload)
            VALUES($1,$2,'lms','lms_to_crm',$3,$4,$5,$6,$7::jsonb) ON CONFLICT(source_system,event_id) DO NOTHING RETURNING id`, [
            randomUUID(), eventJob.id, event.eventId, event.correlationId, event.eventType, new Date(event.occurredAt),
            JSON.stringify({ factKind: event.factKind, reference: event.reference, activityReference: event.activityReference }),
          ]);
          if (!persisted.rowCount) {
            await client.query('ROLLBACK');
            duplicates += 1;
            continue;
          }
          await client.query(`INSERT INTO individual_learning_facts(id,activity_id,fact_kind,source,occurred_at,reference,exchange_event_id)
            VALUES($1,$2,$3,'LMS mock',$4,$5,$6)`, [randomUUID(), activity!.id, event.factKind, new Date(event.occurredAt), event.reference, persisted.rows[0].id]);
          await client.query(`UPDATE exchange_jobs SET status='performed',updated_at=now() WHERE id=$1`, [eventJob.id]);
          await client.query(`UPDATE exchange_jobs SET status='performed',response=COALESCE(response,'{}'::jsonb) || $2::jsonb,updated_at=now() WHERE id=$1`, [outbound!.id, JSON.stringify({ performedEventId: event.eventId, factKind: event.factKind, source: 'LMS mock', occurredAt: event.occurredAt, reference: event.reference })]);
          await client.query('COMMIT');
          processed += 1;
        } catch (error) { await client.query('ROLLBACK'); await this.setStatus(eventJob.id, 'retryable_error', { error: safeError(error) }); rejected += 1; }
        finally { client.release(); }
        try { await this.acknowledgeLmsEvent(event, eventJob.id); } catch { /* replay retries the acknowledgement; the durable CRM fact remains deduplicated */ }
      }
      return presentJob(actor, await this.setStatus(job.id, 'accepted', { attemptCount, response: { processed, duplicates, rejected, deferred: deferredCount } }));
    } catch (error) { return presentJob(actor, await this.setStatus(job.id, 'retryable_error', { attemptCount, error: safeError(error) })); }
  }
  async setLmsOutcome(actor: Actor, jobId: string, outcome: 'perform' | 'reject', factKind: LearningFactKind) {
    this.assertAdmin(actor);
    const job = await this.getJob(jobId);
    if (!job || job.direction !== 'crm_to_lms' || !job.activityId) throw new DomainError(404, 'exchange_job_not_found', 'Исходящий запрос LMS не найден.');
    const activity = await pool.query('SELECT id,kind FROM activities WHERE id=$1::uuid LIMIT 1', [job.activityId]);
    if (!activity.rows[0]) throw new DomainError(404, 'exchange_job_not_found', 'Исходящий запрос LMS не найден.');
    assertActivityKindAllowed(actor, activity.rows[0].kind as ActivityKind);
    if (!['accepted', 'performed'].includes(job.status)) throw new DomainError(409, 'lms_request_not_accepted', 'В mock LMS можно выполнить только принятый запрос.');
    const suffix = outcome === 'perform' ? 'perform' : 'reject';
    const { response, body } = await this.call('lms', `/control/requests/${encodeURIComponent(job.correlationId)}/${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ factKind }) });
    if (!response.ok) throw new DomainError(response.status === 409 ? 409 : 503, body.code ?? 'mock_unavailable', body.message ?? 'Локальный LMS mock недоступен.');
    if (body.status === 'rejected') await this.setStatus(job.id, 'rejected', { response: body, error: 'Запрос отклонён источником LMS mock.' });
    return { mode: 'mock', status: body.status, outcome, factKind };
  }
}
