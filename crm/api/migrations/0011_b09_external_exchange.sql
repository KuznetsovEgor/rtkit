ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_origin_allowed;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_origin_metadata_valid;
ALTER TABLE activities ADD CONSTRAINT activities_origin_allowed CHECK (origin IN ('manual','external_ready','cms_mock'));
ALTER TABLE activities ADD CONSTRAINT activities_origin_metadata_valid CHECK (
  (origin = 'manual' AND origin_source IS NULL AND origin_reference IS NULL)
  OR (origin = 'external_ready' AND kind = 'individual'
      AND origin_source IS NOT NULL AND char_length(btrim(origin_source)) BETWEEN 1 AND 160
      AND origin_source !~ '[[:cntrl:]]'
      AND origin_reference IS NOT NULL AND char_length(btrim(origin_reference)) BETWEEN 1 AND 240
      AND origin_reference !~ '[[:cntrl:]]'
      AND lower(origin_reference) NOT LIKE 'http://%' AND lower(origin_reference) NOT LIKE 'https://%')
  OR (origin = 'cms_mock' AND origin_source = 'CMS mock'
      AND origin_reference IS NOT NULL AND char_length(btrim(origin_reference)) BETWEEN 1 AND 240
      AND origin_reference !~ '[[:cntrl:]]'
      AND lower(origin_reference) NOT LIKE 'http://%' AND lower(origin_reference) NOT LIKE 'https://%')
);

CREATE TABLE IF NOT EXISTS exchange_jobs (
  id uuid PRIMARY KEY,
  direction text NOT NULL CHECK (direction IN ('cms_to_crm','crm_to_cms','crm_to_lms','lms_to_crm')),
  system text NOT NULL CHECK (system IN ('cms','lms')),
  operation text NOT NULL,
  activity_id uuid REFERENCES activities(id) ON DELETE SET NULL,
  actor_sub text NOT NULL,
  scope_key text NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  external_event_id text,
  status text NOT NULL CHECK (status IN ('queued','sent','accepted','performed','rejected','retryable_error')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 3),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (direction, scope_key, idempotency_key)
);
CREATE INDEX IF NOT EXISTS exchange_jobs_activity_idx ON exchange_jobs(activity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS exchange_jobs_monitor_idx ON exchange_jobs(created_at DESC, status);

CREATE TABLE IF NOT EXISTS exchange_events (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES exchange_jobs(id) ON DELETE CASCADE,
  source_system text NOT NULL CHECK (source_system IN ('cms','lms')),
  direction text NOT NULL CHECK (direction IN ('cms_to_crm','lms_to_crm')),
  event_id text NOT NULL,
  correlation_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, event_id)
);
CREATE INDEX IF NOT EXISTS exchange_events_job_idx ON exchange_events(job_id, received_at);
