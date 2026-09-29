-- Correct the early B05 draft that moved legacy nodes and reused their ordinals.
-- Safe on fresh databases where the original constraint is still present.
UPDATE workflow_stages SET ordinal = 6 WHERE kind = 'individual' AND stage_key = 'conditions';
UPDATE workflow_stages SET ordinal = 7 WHERE kind = 'individual' AND stage_key = 'lms_handoff';
UPDATE workflow_stages SET ordinal = 8 WHERE kind = 'individual' AND stage_key = 'exceptions';
UPDATE workflow_stages SET ordinal = 9 WHERE kind = 'individual' AND stage_key = 'result';
UPDATE workflow_stages SET ordinal = 3 WHERE kind = 'individual' AND stage_key = 'enrollment';
UPDATE workflow_stages SET ordinal = 4 WHERE kind = 'individual' AND stage_key = 'learning';
UPDATE workflow_stages SET ordinal = 5 WHERE kind = 'individual' AND stage_key = 'closed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workflow_stages'::regclass
      AND conname = 'workflow_stages_kind_ordinal_key'
  ) THEN
    ALTER TABLE workflow_stages
      ADD CONSTRAINT workflow_stages_kind_ordinal_key UNIQUE (kind, ordinal);
  END IF;
END
$$;
