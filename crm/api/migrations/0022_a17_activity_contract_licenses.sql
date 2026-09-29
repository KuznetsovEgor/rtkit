-- Contract/license context belongs to an activity: an organization can have
-- several activities and each activity may have zero or more records.
CREATE TABLE activity_contract_licenses (
  id uuid PRIMARY KEY,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  contract_reference text CHECK (contract_reference IS NULL OR char_length(btrim(contract_reference)) <= 180),
  contract_status text CHECK (contract_status IS NULL OR contract_status IN ('draft','signed','ended','unknown')),
  license_expiry_precision text CHECK (license_expiry_precision IS NULL OR license_expiry_precision IN ('exact_date','year','unknown')),
  license_expires_on date,
  license_expires_year integer CHECK (license_expires_year IS NULL OR license_expires_year BETWEEN 1900 AND 9999),
  document_id uuid REFERENCES activity_documents(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 1500),
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  CHECK (
    (license_expiry_precision IS NULL AND license_expires_on IS NULL AND license_expires_year IS NULL) OR
    (license_expiry_precision = 'exact_date' AND license_expires_on IS NOT NULL AND license_expires_year IS NULL) OR
    (license_expiry_precision = 'year' AND license_expires_on IS NULL AND license_expires_year IS NOT NULL) OR
    (license_expiry_precision = 'unknown' AND license_expires_on IS NULL AND license_expires_year IS NULL)
  )
);
CREATE INDEX activity_contract_licenses_activity_idx ON activity_contract_licenses(activity_id, updated_at DESC, id);
