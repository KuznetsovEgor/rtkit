CREATE TABLE task_subscriptions (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  subscriber_sub text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, subscriber_sub)
);

CREATE INDEX task_subscriptions_activity_subscriber_idx
  ON task_subscriptions(activity_id, subscriber_sub);

CREATE TABLE activity_notifications (
  id uuid PRIMARY KEY,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  recipient_sub text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT activity_notifications_event_recipient_uq UNIQUE (event_id, recipient_sub)
);

CREATE INDEX activity_notifications_recipient_created_idx
  ON activity_notifications(recipient_sub, created_at DESC, id DESC);
