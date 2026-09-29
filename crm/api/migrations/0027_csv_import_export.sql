ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_file_format_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_file_format_check
  CHECK (file_format IN ('xls', 'xlsx', 'json', 'csv'));

ALTER TABLE report_jobs DROP CONSTRAINT IF EXISTS report_jobs_format_check;
ALTER TABLE report_jobs ADD CONSTRAINT report_jobs_format_check
  CHECK (format IS NULL OR format IN ('xls', 'xlsx', 'csv', 'pdf', 'json', 'png', 'chart-pdf'));
