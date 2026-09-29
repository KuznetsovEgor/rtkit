-- Assignment notifications belong to an activity, before any task exists.
ALTER TABLE activity_notifications ALTER COLUMN task_id DROP NOT NULL;
