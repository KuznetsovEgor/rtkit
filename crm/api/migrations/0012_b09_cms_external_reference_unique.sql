CREATE UNIQUE INDEX IF NOT EXISTS activities_cms_mock_external_reference_idx
  ON activities (lower(btrim(origin_source)), lower(btrim(origin_reference)))
  WHERE origin = 'cms_mock';
