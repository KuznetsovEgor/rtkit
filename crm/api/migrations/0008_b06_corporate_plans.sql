-- B06 corporate scoping plan; legacy corporate activity stages/history are untouched.
-- Requested places are a request estimate, never LMS enrollments or learner records.
CREATE TABLE corporate_activity_plans (
  activity_id uuid PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
  program_mode text NOT NULL CHECK (program_mode IN ('standard', 'adapted', 'new', 'undecided')),
  requested_places integer CHECK (requested_places IS NULL OR requested_places BETWEEN 0 AND 1000000),
  brief jsonb NOT NULL,
  methodologist jsonb NOT NULL,
  proposed jsonb NOT NULL,
  agreed jsonb NOT NULL,
  approval jsonb NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  actor_sub text NOT NULL,
  actor_name text NOT NULL
);
