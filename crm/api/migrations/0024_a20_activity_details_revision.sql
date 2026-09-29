ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS details_revision integer NOT NULL DEFAULT 0
    CHECK (details_revision >= 0);
