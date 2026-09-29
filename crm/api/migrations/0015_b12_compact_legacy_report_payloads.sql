UPDATE report_jobs
SET payload=(payload-'rows') || jsonb_build_object('rowCount',row_count,'page',1,'pageSize',25)
WHERE job_type='snapshot' AND payload <> '{}'::jsonb;

UPDATE report_jobs
SET payload=(payload-'rows') || jsonb_build_object('rowCount',row_count,'page',1,'pageSize',25)
WHERE job_type='export' AND payload <> '{}'::jsonb;
