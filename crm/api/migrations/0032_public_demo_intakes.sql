CREATE TABLE IF NOT EXISTS public_demo_intakes (
  idempotency_key_hash text PRIMARY KEY,
  fingerprint_hash text NOT NULL,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_demo_intakes_fingerprint_created_idx
  ON public_demo_intakes(fingerprint_hash, created_at DESC);
