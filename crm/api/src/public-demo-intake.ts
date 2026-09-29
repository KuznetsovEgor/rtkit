import { createHash, randomUUID } from 'node:crypto';
import { pool } from './db/connection.js';
import { DomainError } from './domain.js';

export type PublicDemoInquiry = {
  kind: 'individual' | 'university' | 'corporate';
  name: string;
  email: string;
  phone: string | null;
  organization: string | null;
  note: string;
};

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';

export function validatePublicDemoInquiry(body: Record<string, unknown>): PublicDemoInquiry {
  const kind = body.kind;
  const name = clean(body.name, 120);
  const email = clean(body.email, 254).toLowerCase();
  const phone = clean(body.phone, 40) || null;
  const organization = clean(body.organization, 160) || null;
  const note = clean(body.note, 1200);
  if ((kind !== 'individual' && kind !== 'university' && kind !== 'corporate') || name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DomainError(400, 'invalid_public_inquiry', 'Проверьте имя и адрес электронной почты.');
  }
  if (kind !== 'individual' && (!organization || organization.length < 2)) {
    throw new DomainError(400, 'invalid_public_inquiry', kind === 'university' ? 'Укажите название вуза.' : 'Укажите название компании.');
  }
  if (note.length < 8) throw new DomainError(400, 'invalid_public_inquiry', 'Добавьте короткое описание запроса.');
  return { kind, name, email, phone, organization, note };
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function createPublicDemoInquiry(input: PublicDemoInquiry, idempotencyKey: string) {
  const idempotencyHash = digest(idempotencyKey);
  const fingerprintHash = digest(JSON.stringify([input.kind, input.name.toLocaleLowerCase('ru'), input.email, input.phone, input.organization?.toLocaleLowerCase('ru') ?? '', input.note.toLocaleLowerCase('ru')]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [fingerprintHash]);
    const priorKey = await client.query('SELECT activity_id FROM public_demo_intakes WHERE idempotency_key_hash=$1', [idempotencyHash]);
    if (priorKey.rows[0]) { await client.query('COMMIT'); return { duplicate: true }; }
    const priorFingerprint = await client.query(`SELECT activity_id FROM public_demo_intakes
      WHERE fingerprint_hash=$1 AND created_at >= now() - interval '24 hours' AND activity_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [fingerprintHash]);
    if (priorFingerprint.rows[0]) {
      await client.query('INSERT INTO public_demo_intakes(idempotency_key_hash,fingerprint_hash,activity_id) VALUES($1,$2,$3)', [idempotencyHash, fingerprintHash, priorFingerprint.rows[0].activity_id]);
      await client.query('COMMIT'); return { duplicate: true };
    }
    const owner = await client.query(`SELECT user_sub, display_name FROM kam_directory WHERE enabled=true ORDER BY display_name,user_sub LIMIT 1`);
    if (!owner.rows[0]) throw new DomainError(503, 'public_intake_unavailable', 'Ответственный КАМ ещё не назначен.');
    const ownerSub = owner.rows[0].user_sub as string;
    const ownerName = owner.rows[0].display_name as string;
    const stage = await client.query('SELECT stage_key FROM workflow_stages WHERE kind=$1 ORDER BY ordinal LIMIT 1', [input.kind]);
    if (!stage.rows[0]) throw new DomainError(503, 'public_intake_unavailable', 'Маршрут заявок не настроен.');
    const id = randomUUID();
    const personId = randomUUID();
    const organizationId = input.kind === 'individual' ? null : randomUUID();
    await client.query('INSERT INTO people(id,full_name,email,phone) VALUES($1,$2,$3,$4)', [personId, input.name, input.email, input.phone]);
    if (organizationId) await client.query('INSERT INTO organizations(id,name,segment) VALUES($1,$2,$3)', [organizationId, input.organization, input.kind === 'university' ? 'university' : 'company']);
    const titlePrefix = input.kind === 'individual' ? 'Индивидуальное обучение' : input.kind === 'university' ? 'Сотрудничество с вузом' : 'Корпоративное обучение';
    const title = `${titlePrefix} · ${input.note.slice(0, 110)}`;
    await client.query(`INSERT INTO activities(id,kind,title,origin,route_version,organization_id,person_id,stage_key,owner_sub,owner_name,priority)
      VALUES($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9,3)`, [id, input.kind, title, input.kind === 'individual' ? 'v2' : 'legacy', organizationId, personId, stage.rows[0].stage_key, ownerSub, ownerName]);
    await client.query(`INSERT INTO activity_events(id,activity_id,event_type,summary,details,actor_sub,actor_name)
      VALUES($1,$2,'created','Заявка с публичной формы',$3::jsonb,$4,$5)`, [randomUUID(), id, JSON.stringify({ source: 'Публичная форма РТК ИТ Школы', note: input.note, demoOnly: true }), ownerSub, ownerName]);
    await client.query('INSERT INTO public_demo_intakes(idempotency_key_hash,fingerprint_hash,activity_id) VALUES($1,$2,$3)', [idempotencyHash, fingerprintHash, id]);
    await client.query('COMMIT');
    return { duplicate: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
