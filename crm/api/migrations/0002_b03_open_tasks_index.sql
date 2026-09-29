-- Supports each activity's earliest open task lookup for queue and portfolio metrics.
CREATE INDEX IF NOT EXISTS tasks_open_activity_due_idx
  ON tasks (activity_id, due_at ASC, created_at ASC, id ASC)
  WHERE status = 'open';
