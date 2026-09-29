ALTER TABLE individual_learning_facts
  ADD COLUMN exchange_event_id uuid UNIQUE
  REFERENCES exchange_events(id) ON DELETE SET NULL;
