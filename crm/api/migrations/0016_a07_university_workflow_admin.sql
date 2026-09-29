-- One mutable global university route with a technical optimistic revision.
-- The revision row is also the lock taken by stage transitions and activity creation.
CREATE TABLE IF NOT EXISTS workflow_config_revisions (
  kind text PRIMARY KEY CHECK (kind = 'university'),
  revision integer NOT NULL CHECK (revision > 0),
  updated_by_sub text,
  updated_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workflow_config_revisions(kind, revision, updated_by_sub, updated_by_name)
VALUES ('university', 1, 'system', 'Система')
ON CONFLICT (kind) DO NOTHING;
