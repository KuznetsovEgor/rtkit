-- Editable stage guidance uses stable workflow keys. The seed snapshot records
-- the workflow shape at migration time without copying the static article text.
CREATE TABLE stage_guidance_articles (
  kind text NOT NULL CHECK (kind IN ('university','individual','corporate')),
  stage_key text NOT NULL CHECK (stage_key ~ '^[a-z][a-z0-9_]{0,79}$'),
  seed_stage_snapshot jsonb NOT NULL CHECK (jsonb_typeof(seed_stage_snapshot) = 'object'),
  draft_article jsonb CHECK (draft_article IS NULL OR jsonb_typeof(draft_article) = 'object'),
  draft_revision integer NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  draft_stage_snapshot jsonb CHECK (draft_stage_snapshot IS NULL OR jsonb_typeof(draft_stage_snapshot) = 'object'),
  published_article jsonb CHECK (published_article IS NULL OR jsonb_typeof(published_article) = 'object'),
  published_revision integer CHECK (published_revision IS NULL OR published_revision > 0),
  published_stage_snapshot jsonb CHECK (published_stage_snapshot IS NULL OR jsonb_typeof(published_stage_snapshot) = 'object'),
  published_at timestamptz,
  published_by_sub text,
  published_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_sub text,
  updated_by_name text,
  PRIMARY KEY (kind, stage_key),
  CHECK ((draft_article IS NULL AND draft_revision = 0 AND draft_stage_snapshot IS NULL) OR
         (draft_article IS NOT NULL AND draft_revision > 0 AND draft_stage_snapshot IS NOT NULL)),
  CHECK ((published_article IS NULL AND published_revision IS NULL AND published_stage_snapshot IS NULL AND published_at IS NULL) OR
         (published_article IS NOT NULL AND published_revision IS NOT NULL AND published_stage_snapshot IS NOT NULL AND published_at IS NOT NULL))
);

INSERT INTO stage_guidance_articles(kind, stage_key, seed_stage_snapshot)
SELECT ws.kind, ws.stage_key, jsonb_build_object(
  'label', ws.label,
  'ordinal', ws.ordinal,
  'terminal', ws.terminal,
  'allowedNext', COALESCE((
    SELECT jsonb_agg(edges.to_key ORDER BY edges.to_key)
    FROM (SELECT DISTINCT to_key FROM workflow_transitions WHERE kind = ws.kind AND from_key = ws.stage_key) edges
  ), '[]'::jsonb),
  'allowedNextByRoute', jsonb_build_object(
    'legacy', COALESCE((SELECT jsonb_agg(edges.to_key ORDER BY edges.to_key) FROM (
      SELECT DISTINCT to_key FROM workflow_transitions WHERE kind = ws.kind AND from_key = ws.stage_key AND route_version = 'legacy'
    ) edges), '[]'::jsonb),
    'v2', COALESCE((SELECT jsonb_agg(edges.to_key ORDER BY edges.to_key) FROM (
      SELECT DISTINCT to_key FROM workflow_transitions WHERE kind = ws.kind AND from_key = ws.stage_key AND route_version = 'v2'
    ) edges), '[]'::jsonb)
  )
)
FROM workflow_stages ws
ON CONFLICT (kind, stage_key) DO NOTHING;

CREATE TABLE stage_guidance_article_events (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('university','individual','corporate')),
  stage_key text NOT NULL CHECK (stage_key ~ '^[a-z][a-z0-9_]{0,79}$'),
  action text NOT NULL CHECK (action IN ('draft_saved','published')),
  revision integer NOT NULL CHECK (revision > 0),
  article jsonb NOT NULL CHECK (jsonb_typeof(article) = 'object'),
  stage_snapshot jsonb NOT NULL CHECK (jsonb_typeof(stage_snapshot) = 'object'),
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_guidance_article_events_lookup_idx ON stage_guidance_article_events(kind, stage_key, created_at DESC);
