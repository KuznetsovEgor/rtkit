ALTER TABLE report_jobs
  ALTER COLUMN row_count TYPE bigint;

ALTER TABLE report_jobs
  ADD COLUMN IF NOT EXISTS source_snapshot_id uuid REFERENCES report_jobs(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS report_snapshot_rows (
  snapshot_id uuid NOT NULL REFERENCES report_jobs(id) ON DELETE CASCADE,
  row_number bigint NOT NULL CHECK (row_number > 0),
  activity_id uuid NOT NULL,
  row_data jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, row_number),
  UNIQUE (snapshot_id, activity_id)
);

CREATE INDEX IF NOT EXISTS report_snapshot_rows_activity_idx ON report_snapshot_rows(activity_id, snapshot_id);

INSERT INTO report_snapshot_rows(snapshot_id,row_number,activity_id,row_data)
SELECT job.id,
  legacy.ordinality,
  (legacy.row_data->>'activityId')::uuid,
  legacy.row_data
FROM report_jobs job
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(job.payload->'rows','[]'::jsonb)) WITH ORDINALITY AS legacy(row_data,ordinality)
WHERE job.job_type='snapshot' AND legacy.row_data ? 'activityId'
ON CONFLICT DO NOTHING;

INSERT INTO report_snapshot_rows(snapshot_id,row_number,activity_id,row_data)
SELECT source.id,
  legacy.ordinality,
  (legacy.row_data->>'activityId')::uuid,
  legacy.row_data
FROM report_jobs export_job
JOIN report_jobs source ON source.id=(export_job.payload->>'snapshotId')::uuid AND source.job_type='snapshot'
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(export_job.payload->'rows','[]'::jsonb)) WITH ORDINALITY AS legacy(row_data,ordinality)
WHERE export_job.job_type='export' AND legacy.row_data ? 'activityId'
ON CONFLICT DO NOTHING;

UPDATE report_jobs export_job
SET source_snapshot_id=source.id
FROM report_jobs source
WHERE export_job.job_type='export'
  AND export_job.source_snapshot_id IS NULL
  AND source.job_type='snapshot'
  AND source.actor_sub=export_job.actor_sub
  AND source.id=(export_job.payload->>'snapshotId')::uuid;

UPDATE report_jobs source
SET expires_at=GREATEST(source.expires_at,live_exports.latest_expiry)
FROM (
  SELECT source_snapshot_id, max(expires_at) AS latest_expiry
  FROM report_jobs
  WHERE job_type='export' AND source_snapshot_id IS NOT NULL
    AND status <> 'expired' AND expires_at>now()
  GROUP BY source_snapshot_id
) live_exports
WHERE source.id=live_exports.source_snapshot_id
  AND source.job_type='snapshot'
  AND live_exports.latest_expiry>source.expires_at;
