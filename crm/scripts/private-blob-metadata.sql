-- Run only against a private, quiesced copy of the CRM database.
-- Output contains opaque storage keys and checksums, never document contents.
-- The entire metadata inventory is read in one PostgreSQL statement snapshot.
SELECT jsonb_build_object(
  'schemaVersion', 1,
  'documents', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'key', object_key,
      'sizeBytes', size_bytes,
      'sha256', sha256
    ) ORDER BY object_key)
    FROM activity_documents
  ), '[]'::jsonb),
  'reports', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'key', file_key,
      'sizeBytes', file_size,
      'sha256', file_sha256
    ) ORDER BY file_key)
    FROM report_jobs
    WHERE job_type = 'export' AND status = 'completed'
  ), '[]'::jsonb)
);
