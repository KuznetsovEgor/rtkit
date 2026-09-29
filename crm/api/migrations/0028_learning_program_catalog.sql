CREATE TABLE IF NOT EXISTS learning_programs (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_programs_name_ci ON learning_programs (lower(name));

CREATE TABLE IF NOT EXISTS activity_programs (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES learning_programs(id) ON DELETE RESTRICT,
  PRIMARY KEY(activity_id, program_id)
);
CREATE INDEX IF NOT EXISTS activity_programs_program_idx ON activity_programs(program_id, activity_id);
