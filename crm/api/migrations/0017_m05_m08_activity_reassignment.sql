ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS assignment_revision integer NOT NULL DEFAULT 0 CHECK (assignment_revision >= 0);

CREATE TABLE IF NOT EXISTS kam_directory (
  user_sub text PRIMARY KEY,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  provision_source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_reassignment_previews (
  id uuid PRIMARY KEY,
  manager_sub text NOT NULL,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  target_owner_sub text NOT NULL REFERENCES kam_directory(user_sub),
  expected_owner_sub text NOT NULL,
  expected_assignment_revision integer NOT NULL CHECK (expected_assignment_revision >= 0),
  expected_updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_reassignment_previews_expiry_idx
  ON activity_reassignment_previews(expires_at);
