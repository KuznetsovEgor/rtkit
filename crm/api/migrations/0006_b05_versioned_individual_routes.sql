ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS route_version text NOT NULL DEFAULT 'legacy';
UPDATE activities SET route_version = 'legacy' WHERE kind = 'individual' AND route_version IS NULL;
ALTER TABLE activities
  ADD CONSTRAINT activities_route_version_allowed CHECK (route_version IN ('legacy', 'v2'));

ALTER TABLE workflow_transitions
  ADD COLUMN IF NOT EXISTS route_version text NOT NULL DEFAULT 'legacy';
ALTER TABLE workflow_transitions
  DROP CONSTRAINT IF EXISTS workflow_transitions_kind_from_key_to_key_key;
ALTER TABLE workflow_transitions
  ADD CONSTRAINT workflow_transitions_route_unique UNIQUE (kind, route_version, from_key, to_key);
ALTER TABLE workflow_transitions
  ADD CONSTRAINT workflow_transitions_route_version_allowed CHECK (route_version IN ('legacy', 'v2'));

-- Migrations 0004/0005 describe the new graph. Mark its edges as v2, restore
-- the legacy edge removed by the first draft of 0004, and share the common
-- request -> consultation edge across both routes.
UPDATE workflow_transitions
SET route_version = 'v2'
WHERE kind = 'individual' AND (from_key, to_key) IN (
  ('consultation', 'conditions'),
  ('conditions', 'lms_handoff'),
  ('lms_handoff', 'exceptions'),
  ('lms_handoff', 'result'),
  ('exceptions', 'lms_handoff'),
  ('exceptions', 'result')
);

INSERT INTO workflow_transitions(id, kind, route_version, from_key, to_key) VALUES
  ('bbbbbbbb-0002-4000-8000-000000000002', 'individual', 'legacy', 'consultation', 'enrollment'),
  ('bbbbbbbb-0011-4000-8000-000000000011', 'individual', 'v2', 'request', 'consultation')
ON CONFLICT (kind, route_version, from_key, to_key) DO NOTHING;
