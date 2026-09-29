import { randomUUID } from 'node:crypto';
import { pool } from './db/connection.js';
import { assertAdmin, DomainError, type ActivityKind, type Actor } from './domain.js';

export interface AccessPolicyUser {
  sub: string;
  name: string;
  roles: string[];
  enabled: boolean;
  allowedKinds: ActivityKind[] | null;
  allowedOrganizationIds: string[] | null;
  scopeRevision: number;
  lastSeenAt: string;
  updatedAt: string;
  updatedBySub: string | null;
  reason: string | null;
}

export interface AccessPolicyService {
  observeAndAssertEnabled(actor: Actor): Promise<Actor>;
  listKnownUsers(): Promise<AccessPolicyUser[]>;
  listOrganizations(search: string): Promise<{ id: string; name: string; segment: string }[]>;
  setEnabled(actor: Actor, targetSub: string, enabled: boolean, reason: string): Promise<AccessPolicyUser>;
  setAllowedKinds(actor: Actor, targetSub: string, allowedKinds: ActivityKind[] | null, expectedRevision: number, reason: string): Promise<AccessPolicyUser>;
  setAllowedOrganizations(actor: Actor, targetSub: string, allowedOrganizationIds: string[] | null, expectedRevision: number, reason: string): Promise<AccessPolicyUser>;
}

const domainError = (statusCode: number, code: string, message: string) => new DomainError(statusCode, code, message);
export function assertAccessPolicyChange(actor: Actor, targetSub: string, enabled: boolean, targetIsAdmin: boolean, remainingEnabledAdmins: number): void {
  assertAdmin(actor);
  if (!enabled && actor.sub === targetSub) throw domainError(409, 'cannot_disable_self', 'Нельзя отключить собственную учётную запись.');
  if (!enabled && targetIsAdmin && remainingEnabledAdmins < 1) {
    throw domainError(409, 'last_admin', 'Нельзя отключить последнего известного администратора CRM.');
  }
}
const timestamp = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const dto = (row: Record<string, unknown>): AccessPolicyUser => ({
  sub: String(row.user_sub), name: String(row.display_name), roles: Array.isArray(row.realm_roles) ? row.realm_roles.map(String) : [],
  enabled: row.disabled_at === null, lastSeenAt: timestamp(row.last_seen_at), updatedAt: timestamp(row.updated_at),
  allowedKinds: row.allowed_kinds === null ? null : Array.isArray(row.allowed_kinds) ? row.allowed_kinds.map(String) as ActivityKind[] : null,
  allowedOrganizationIds: row.allowed_organization_ids === null ? null : Array.isArray(row.allowed_organization_ids) ? row.allowed_organization_ids.map(String) : null,
  scopeRevision: Number(row.scope_revision ?? 0),
  updatedBySub: row.updated_by_sub === null ? null : String(row.updated_by_sub),
  reason: row.disabled_reason === null ? null : String(row.disabled_reason),
});

export class PostgresAccessPolicyService implements AccessPolicyService {
  async observeAndAssertEnabled(actor: Actor): Promise<Actor> {
    const client = await pool.connect();
    let observedRow: { disabled_at: Date | null; allowed_kinds: ActivityKind[] | null; allowed_organization_ids: string[] | null } | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('crm-access-policy'))");
      const observed = await client.query<{ disabled_at: Date | null; allowed_kinds: ActivityKind[] | null; allowed_organization_ids: string[] | null }>(`
        INSERT INTO known_crm_users(user_sub, display_name, realm_roles, last_seen_at)
        VALUES($1, $2, $3::text[], now())
        ON CONFLICT(user_sub) DO UPDATE SET display_name=EXCLUDED.display_name,
          realm_roles=EXCLUDED.realm_roles, last_seen_at=now()
        RETURNING disabled_at, allowed_kinds, allowed_organization_ids`, [actor.sub, actor.name, actor.roles]);
      observedRow = observed.rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (observedRow?.disabled_at) throw domainError(403, 'access_revoked', 'Доступ к CRM отключён администратором.');
    return { ...actor, allowedKinds: observedRow?.allowed_kinds ?? null, allowedOrganizationIds: observedRow?.allowed_organization_ids ?? null };
  }

  async listKnownUsers(): Promise<AccessPolicyUser[]> {
    const result = await pool.query(`
      SELECT user_sub, display_name, realm_roles, disabled_at, allowed_kinds, allowed_organization_ids, scope_revision, last_seen_at, updated_at, updated_by_sub, disabled_reason
      FROM known_crm_users ORDER BY display_name, user_sub`);
    return result.rows.map((row) => dto(row));
  }

  async listOrganizations(search: string): Promise<{ id: string; name: string; segment: string }[]> {
    const needle = search.trim().replace(/[\\%_]/g, (value) => `\\${value}`);
    const result = await pool.query(`
      SELECT id, name, segment FROM organizations
      WHERE name ILIKE $1 ESCAPE E'\\\\'
      ORDER BY name, id LIMIT 100`, [`%${needle}%`]);
    return result.rows.map((row) => ({ id: String(row.id), name: String(row.name), segment: String(row.segment) }));
  }

  async setEnabled(actor: Actor, targetSub: string, enabled: boolean, reason: string): Promise<AccessPolicyUser> {
    assertAdmin(actor);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize policy changes so two administrators cannot concurrently disable
      // the final active administrator. Provisioning and reassignment use this same
      // advisory lock before taking user-policy or KAM-directory row locks.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('crm-access-policy'))");
      const operator = await client.query('SELECT disabled_at FROM known_crm_users WHERE user_sub=$1', [actor.sub]);
      if (operator.rows[0]?.disabled_at) throw domainError(403, 'access_revoked', 'Доступ к CRM отключён администратором.');
      if (!enabled && actor.sub === targetSub) assertAccessPolicyChange(actor, targetSub, enabled, true, 1);

      const target = await client.query(`
        SELECT user_sub, display_name, realm_roles, disabled_at
        FROM known_crm_users WHERE user_sub=$1 FOR UPDATE`, [targetSub]);
      if (!target.rowCount) throw domainError(404, 'user_not_found', 'Пользователь не найден в локальном каталоге CRM.');
      const targetRow = target.rows[0] as { user_sub: string; realm_roles: string[]; disabled_at: Date | null };
      if (!enabled && !targetRow.disabled_at && targetRow.realm_roles.includes('admin')) {
        const remaining = await client.query(`
          SELECT count(*)::integer AS count FROM known_crm_users
          WHERE disabled_at IS NULL AND user_sub<>$1 AND realm_roles @> ARRAY['admin']::text[]`, [targetSub]);
        assertAccessPolicyChange(actor, targetSub, enabled, true, Number(remaining.rows[0]?.count ?? 0));
      }

      const updated = await client.query(`
        UPDATE known_crm_users SET
          disabled_at=CASE WHEN $2 THEN NULL ELSE now() END,
          disabled_by_sub=CASE WHEN $2 THEN NULL ELSE $3 END,
          disabled_reason=CASE WHEN $2 THEN NULL ELSE $4 END,
          updated_at=now(), updated_by_sub=$3
        WHERE user_sub=$1
        RETURNING user_sub, display_name, realm_roles, disabled_at, allowed_kinds, allowed_organization_ids, scope_revision, last_seen_at, updated_at, updated_by_sub, disabled_reason`,
      [targetSub, enabled, actor.sub, reason]);
      await client.query(`
        INSERT INTO crm_access_policy_audit(id, target_sub, actor_sub, actor_name, action, reason)
        VALUES($1, $2, $3, $4, $5, $6)`, [randomUUID(), targetSub, actor.sub, actor.name, enabled ? 'enabled' : 'disabled', reason]);
      await client.query('COMMIT');
      return dto(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setAllowedKinds(actor: Actor, targetSub: string, allowedKinds: ActivityKind[] | null, expectedRevision: number, reason: string): Promise<AccessPolicyUser> {
    assertAdmin(actor);
    const validKinds = ['university', 'corporate', 'individual'];
    if (allowedKinds !== null && (!Array.isArray(allowedKinds) || allowedKinds.some((kind) => !validKinds.includes(kind)) || new Set(allowedKinds).size !== allowedKinds.length)) {
      throw domainError(400, 'invalid_segment_scope', 'Укажите допустимые типы активности без повторений или null для всех типов.');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 2147483646) {
      throw domainError(400, 'invalid_revision', 'Некорректная версия области доступа.');
    }
    if (!reason.trim() || reason.length > 500) throw domainError(400, 'invalid_reason', 'Укажите основание изменения области доступа.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('crm-access-policy'))");
      const operator = await client.query('SELECT disabled_at FROM known_crm_users WHERE user_sub=$1', [actor.sub]);
      if (operator.rows[0]?.disabled_at) throw domainError(403, 'access_revoked', 'Доступ к CRM отключён администратором.');
      const target = await client.query(`
        SELECT user_sub, display_name, realm_roles, disabled_at, allowed_kinds, scope_revision,
          allowed_organization_ids, last_seen_at, updated_at, updated_by_sub, disabled_reason
        FROM known_crm_users WHERE user_sub=$1 FOR UPDATE`, [targetSub]);
      if (!target.rowCount) throw domainError(404, 'user_not_found', 'Пользователь не найден в локальном каталоге CRM.');
      const targetRow = target.rows[0] as { scope_revision: number; allowed_kinds: ActivityKind[] | null };
      if (Number(targetRow.scope_revision) !== expectedRevision) throw domainError(409, 'scope_revision_conflict', 'Область доступа уже изменена. Обновите список пользователей и повторите.');
      const updated = await client.query(`
        UPDATE known_crm_users SET allowed_kinds=$2::text[], scope_revision=scope_revision+1,
          updated_at=now(), updated_by_sub=$3
        WHERE user_sub=$1
        RETURNING user_sub, display_name, realm_roles, disabled_at, allowed_kinds, allowed_organization_ids, scope_revision,
          last_seen_at, updated_at, updated_by_sub, disabled_reason`,
      [targetSub, allowedKinds, actor.sub]);
      await client.query(`
        INSERT INTO crm_activity_scope_audit(id,target_sub,actor_sub,actor_name,previous_allowed_kinds,allowed_kinds,revision,reason)
        VALUES($1,$2,$3,$4,$5::text[],$6::text[],$7,$8)`, [
        randomUUID(), targetSub, actor.sub, actor.name, targetRow.allowed_kinds, allowedKinds,
        Number(updated.rows[0].scope_revision), reason.trim(),
      ]);
      await client.query('COMMIT');
      return dto(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setAllowedOrganizations(actor: Actor, targetSub: string, allowedOrganizationIds: string[] | null, expectedRevision: number, reason: string): Promise<AccessPolicyUser> {
    assertAdmin(actor);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (allowedOrganizationIds !== null && (!Array.isArray(allowedOrganizationIds)
      || allowedOrganizationIds.length > 5000
      || allowedOrganizationIds.some((id) => typeof id !== 'string' || !uuid.test(id))
      || new Set(allowedOrganizationIds.map((id) => id.toLowerCase())).size !== allowedOrganizationIds.length)) {
      throw domainError(400, 'invalid_organization_scope', 'Укажите до 5000 уникальных идентификаторов организаций UUID или null для всех организаций.');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 2147483646) {
      throw domainError(400, 'invalid_revision', 'Некорректная версия области доступа.');
    }
    if (!reason.trim() || reason.length > 500) throw domainError(400, 'invalid_reason', 'Укажите основание изменения области доступа.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('crm-access-policy'))");
      const operator = await client.query('SELECT disabled_at FROM known_crm_users WHERE user_sub=$1', [actor.sub]);
      if (operator.rows[0]?.disabled_at) throw domainError(403, 'access_revoked', 'Доступ к CRM отключён администратором.');
      const target = await client.query(`
        SELECT user_sub, display_name, realm_roles, disabled_at, allowed_kinds, allowed_organization_ids, scope_revision,
          last_seen_at, updated_at, updated_by_sub, disabled_reason
        FROM known_crm_users WHERE user_sub=$1 FOR UPDATE`, [targetSub]);
      if (!target.rowCount) throw domainError(404, 'user_not_found', 'Пользователь не найден в локальном каталоге CRM.');
      const targetRow = target.rows[0] as { scope_revision: number; allowed_organization_ids: string[] | null };
      if (Number(targetRow.scope_revision) !== expectedRevision) throw domainError(409, 'scope_revision_conflict', 'Область доступа уже изменена. Обновите список пользователей и повторите.');
      const updated = await client.query(`
        UPDATE known_crm_users SET allowed_organization_ids=$2::uuid[], scope_revision=scope_revision+1,
          updated_at=now(), updated_by_sub=$3
        WHERE user_sub=$1
        RETURNING user_sub, display_name, realm_roles, disabled_at, allowed_kinds, allowed_organization_ids, scope_revision,
          last_seen_at, updated_at, updated_by_sub, disabled_reason`, [targetSub, allowedOrganizationIds, actor.sub]);
      await client.query(`
        INSERT INTO crm_activity_scope_audit(id,target_sub,actor_sub,actor_name,previous_allowed_organization_ids,allowed_organization_ids,revision,reason)
        VALUES($1,$2,$3,$4,$5::uuid[],$6::uuid[],$7,$8)`, [
        randomUUID(), targetSub, actor.sub, actor.name, targetRow.allowed_organization_ids, allowedOrganizationIds,
        Number(updated.rows[0].scope_revision), reason.trim(),
      ]);
      await client.query('COMMIT');
      return dto(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
