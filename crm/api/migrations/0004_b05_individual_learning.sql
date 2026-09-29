ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS origin_source text,
  ADD COLUMN IF NOT EXISTS origin_reference text;

ALTER TABLE activities
  ADD CONSTRAINT activities_origin_allowed CHECK (origin IN ('manual', 'external_ready')),
  ADD CONSTRAINT activities_origin_metadata_valid CHECK (
    (origin = 'manual' AND origin_source IS NULL AND origin_reference IS NULL)
    OR (
      origin = 'external_ready' AND kind = 'individual'
      AND origin_source IS NOT NULL AND char_length(btrim(origin_source)) BETWEEN 1 AND 160
      AND origin_source !~ '[[:cntrl:]]'
      AND origin_reference IS NOT NULL AND char_length(btrim(origin_reference)) BETWEEN 1 AND 240
      AND origin_reference !~ '[[:cntrl:]]'
      AND lower(origin_reference) NOT LIKE 'http://%'
      AND lower(origin_reference) NOT LIKE 'https://%'
    )
  );

-- Append new route nodes after legacy ordinals. Existing stages and their order
-- remain intact; the UI uses the route-specific stage-key projection.
INSERT INTO workflow_stages(id,kind,stage_key,label,ordinal,terminal) VALUES
  ('22222222-2222-4222-8222-222222222206','individual','conditions','Условия обучения',6,false),
  ('22222222-2222-4222-8222-222222222207','individual','lms_handoff','Передача в LMS',7,false),
  ('22222222-2222-4222-8222-222222222208','individual','exceptions','Исключения и возврат',8,false),
  ('22222222-2222-4222-8222-222222222209','individual','result','Итог сопровождения',9,true)
ON CONFLICT (kind,stage_key) DO NOTHING;

DELETE FROM workflow_transitions
WHERE kind = 'individual' AND from_key = 'consultation' AND to_key = 'enrollment';

INSERT INTO workflow_transitions(id,kind,from_key,to_key) VALUES
  ('bbbbbbbb-0005-4000-8000-000000000005','individual','consultation','conditions'),
  ('bbbbbbbb-0006-4000-8000-000000000006','individual','conditions','lms_handoff'),
  ('bbbbbbbb-0007-4000-8000-000000000007','individual','lms_handoff','exceptions'),
  ('bbbbbbbb-0008-4000-8000-000000000008','individual','lms_handoff','result'),
  ('bbbbbbbb-0009-4000-8000-000000000009','individual','exceptions','lms_handoff'),
  ('bbbbbbbb-0010-4000-8000-000000000010','individual','exceptions','result')
ON CONFLICT (kind,from_key,to_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS individual_learning_facts (
  id uuid PRIMARY KEY,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  fact_kind text NOT NULL CHECK (fact_kind IN ('enrollment', 'learning_started', 'learning_completed')),
  source text NOT NULL CHECK (char_length(btrim(source)) BETWEEN 1 AND 160),
  occurred_at timestamptz NOT NULL,
  reference text NOT NULL CHECK (char_length(btrim(reference)) BETWEEN 1 AND 500),
  CHECK (source !~ '[[:cntrl:]]' AND reference !~ '[[:cntrl:]]')
);

CREATE INDEX IF NOT EXISTS individual_learning_facts_activity_time_idx
  ON individual_learning_facts(activity_id, occurred_at DESC, id DESC);
