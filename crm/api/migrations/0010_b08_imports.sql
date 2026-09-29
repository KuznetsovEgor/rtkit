ALTER TABLE people ADD COLUMN IF NOT EXISTS import_owner_sub text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS organization_name text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS import_source text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS import_external_key text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS import_payload_hash text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS import_owner_only boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS vendors (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  owner_sub text NOT NULL,
  import_source text,
  import_external_key text,
  import_payload_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendors_owner_name_idx ON vendors(owner_sub, lower(name));
CREATE TABLE IF NOT EXISTS vendor_products (
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  PRIMARY KEY(vendor_id, product_id)
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY,
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  target text NOT NULL CHECK (target IN ('contacts','vendors','individual_applications')),
  source_system text NOT NULL,
  file_name text NOT NULL,
  file_format text NOT NULL CHECK (file_format IN ('xls','xlsx','json')),
  payload jsonb NOT NULL,
  selected_sheet text,
  header_row integer,
  raw_headings jsonb NOT NULL DEFAULT '[]'::jsonb,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb,
  status text NOT NULL CHECK (status IN ('uploaded','preview_ready','completed','expired')),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS import_jobs_owner_expiry_idx ON import_jobs(actor_sub, expires_at);
CREATE TABLE IF NOT EXISTS import_identities (
  id uuid PRIMARY KEY,
  target text NOT NULL CHECK (target IN ('contacts','vendors','individual_applications')),
  source_system text NOT NULL,
  external_key text NOT NULL,
  owner_sub text NOT NULL,
  entity_id uuid NOT NULL,
  payload_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(target, source_system, external_key)
);
CREATE TABLE IF NOT EXISTS import_confirmations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS import_applied_rows (
  job_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  payload_hash text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id, row_number)
);
CREATE TABLE IF NOT EXISTS import_provenance (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  confirmation_id uuid NOT NULL,
  target text NOT NULL,
  entity_id uuid NOT NULL,
  source_system text NOT NULL,
  external_key text,
  file_name text NOT NULL,
  source_row_number integer NOT NULL,
  raw_headings jsonb NOT NULL,
  mapping jsonb NOT NULL,
  payload_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('created','updated','unchanged')),
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_provenance_entity_idx ON import_provenance(target, entity_id, created_at DESC);
