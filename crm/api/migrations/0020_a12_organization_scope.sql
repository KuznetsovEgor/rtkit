ALTER TABLE known_crm_users
  ADD COLUMN IF NOT EXISTS allowed_organization_ids uuid[];

ALTER TABLE crm_activity_scope_audit
  ADD COLUMN IF NOT EXISTS previous_allowed_organization_ids uuid[],
  ADD COLUMN IF NOT EXISTS allowed_organization_ids uuid[];
