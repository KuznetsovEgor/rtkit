CREATE TABLE IF NOT EXISTS activity_documents (
  id uuid PRIMARY KEY,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  object_key uuid NOT NULL UNIQUE,
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 180),
  extension text NOT NULL CHECK (extension IN ('png','jpg','jpeg','pdf','zip','gz','gzip','rar','doc','docx','xls','xlsx')),
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_sub text NOT NULL,
  uploaded_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_documents_activity_idx ON activity_documents(activity_id, created_at DESC, id);
