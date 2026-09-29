CREATE TABLE IF NOT EXISTS known_crm_users (
  user_sub text PRIMARY KEY,
  display_name text NOT NULL,
  realm_roles text[] NOT NULL DEFAULT '{}',
  provision_source text NOT NULL DEFAULT 'keycloak-jwt-observation',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  disabled_by_sub text,
  disabled_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_sub text
);

CREATE INDEX IF NOT EXISTS known_crm_users_policy_idx
  ON known_crm_users (disabled_at, display_name, user_sub);

CREATE TABLE IF NOT EXISTS crm_access_policy_audit (
  id uuid PRIMARY KEY,
  target_sub text NOT NULL REFERENCES known_crm_users(user_sub),
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  action text NOT NULL CHECK (action IN ('enabled', 'disabled')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_access_policy_audit_target_idx
  ON crm_access_policy_audit (target_sub, created_at DESC);
