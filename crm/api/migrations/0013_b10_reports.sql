CREATE TABLE IF NOT EXISTS report_jobs (
  id uuid PRIMARY KEY,
  job_type text NOT NULL CHECK (job_type IN ('snapshot','export')),
  report_id text NOT NULL CHECK (report_id IN ('crm_portfolio','demand_learning')),
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  parameters jsonb NOT NULL,
  payload jsonb NOT NULL,
  format text CHECK (format IS NULL OR format IN ('xls','xlsx','pdf','json','png','chart-pdf')),
  file_key uuid UNIQUE,
  file_name text,
  media_type text,
  file_size bigint CHECK (file_size IS NULL OR file_size >= 0),
  file_sha256 text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[a-f0-9]{64}$'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','expired')),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (
    (job_type = 'snapshot' AND format IS NULL AND file_key IS NULL AND file_name IS NULL AND media_type IS NULL AND file_size IS NULL AND file_sha256 IS NULL)
    OR job_type = 'export'
  )
);
CREATE INDEX IF NOT EXISTS report_jobs_actor_created_idx ON report_jobs(actor_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS report_jobs_expiry_idx ON report_jobs(expires_at);
CREATE INDEX IF NOT EXISTS report_jobs_queue_idx ON report_jobs(status, created_at) WHERE job_type = 'export';
