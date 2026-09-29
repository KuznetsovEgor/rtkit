CREATE TABLE guidance_feedback (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  actor_sub text NOT NULL,
  recommendation_key text NOT NULL CHECK (char_length(recommendation_key) BETWEEN 1 AND 160),
  action text NOT NULL CHECK (action IN ('defer','reject')),
  reason text,
  deferred_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, actor_sub, recommendation_key),
  CHECK (
    (action = 'defer' AND reason IS NULL AND deferred_until IS NOT NULL) OR
    (action = 'reject' AND reason IS NOT NULL AND char_length(btrim(reason)) BETWEEN 1 AND 1000 AND deferred_until IS NULL)
  )
);
