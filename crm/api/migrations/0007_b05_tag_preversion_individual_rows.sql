-- Rows created by the first B05 draft can be distinguished from B01 rows by
-- their added origin field/event, or by the new-only route stage keys.
-- Preserve genuine legacy rows at request/consultation with no origin event.
UPDATE activities a
SET route_version = 'v2'
WHERE a.kind = 'individual' AND a.route_version = 'legacy'
  AND (
    a.origin = 'external_ready'
    OR a.stage_key IN ('conditions', 'lms_handoff', 'exceptions', 'result')
    OR EXISTS (
      SELECT 1 FROM activity_events e
      WHERE e.activity_id = a.id AND e.event_type = 'created' AND e.details ? 'origin'
    )
  );
