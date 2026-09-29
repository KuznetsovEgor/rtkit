ALTER TABLE known_crm_users
  ADD COLUMN IF NOT EXISTS allowed_kinds text[],
  ADD COLUMN IF NOT EXISTS scope_revision integer NOT NULL DEFAULT 0;

ALTER TABLE known_crm_users
  DROP CONSTRAINT IF EXISTS known_crm_users_allowed_kinds_check;
ALTER TABLE known_crm_users
  ADD CONSTRAINT known_crm_users_allowed_kinds_check
  CHECK (allowed_kinds IS NULL OR allowed_kinds <@ ARRAY['university', 'corporate', 'individual']::text[]);

CREATE TABLE IF NOT EXISTS crm_activity_scope_audit (
  id uuid PRIMARY KEY,
  target_sub text NOT NULL REFERENCES known_crm_users(user_sub),
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  previous_allowed_kinds text[],
  allowed_kinds text[],
  revision integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_activity_scope_audit_target_idx
  ON crm_activity_scope_audit (target_sub, created_at DESC);
