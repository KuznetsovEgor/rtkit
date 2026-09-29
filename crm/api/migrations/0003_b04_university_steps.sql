CREATE TABLE IF NOT EXISTS university_step_definitions (
  id text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  group_key text NOT NULL,
  group_label text NOT NULL,
  ordinal smallint NOT NULL UNIQUE,
  optional boolean NOT NULL DEFAULT false,
  CONSTRAINT university_step_definition_id CHECK (id ~ '^U(0[1-9]|1[0-3])$')
);

INSERT INTO university_step_definitions (id, label, description, group_key, group_label, ordinal, optional) VALUES
  ('U01', 'Контакт ответственного', 'Найти контакт представителя, отвечающего за взаимодействие с вузом.', 'contact', 'Контакт и потребность', 1, false),
  ('U02', 'Актуальность программ', 'Уточнить запрос вуза и актуальность интересующих программ.', 'contact', 'Контакт и потребность', 2, false),
  ('U03', 'Встреча', 'Согласовать встречу и зафиксировать её результат.', 'meeting', 'Встреча', 3, false),
  ('U04', 'Обмен документами', 'Зафиксировать передачу пакета документов и связанные ссылки или позиции.', 'documents', 'Документы', 4, false),
  ('U05', 'Корректировка документов', 'Зафиксировать запрос на корректировку и возврат документов на согласование.', 'documents', 'Документы', 5, true),
  ('U06', 'Подписание документов', 'Зафиксировать подтверждённый статус подписания и ссылку или источник документа.', 'documents', 'Документы', 6, false),
  ('U07', 'Передача материалов и лицензии', 'Зафиксировать переданные материалы, документацию и подтверждения передачи.', 'launch', 'Передача и внедрение', 7, false),
  ('U08', 'Сопровождение внедрения', 'Зафиксировать ответственного, текущую задачу и состояние готовности внедрения.', 'launch', 'Передача и внедрение', 8, false),
  ('U09', 'Обучение преподавателей', 'Зафиксировать запрос или ссылку на обучение и результат с указанием источника.', 'learning', 'Учебная работа и материалы', 9, false),
  ('U10', 'Актуализация учебной программы', 'Зафиксировать согласованную редакцию программы или результат работы.', 'learning', 'Учебная работа и материалы', 10, false),
  ('U11', 'Ведение занятий', 'Связать активность с потоком и наблюдаемыми фактами проведения занятий.', 'learning', 'Учебная работа и материалы', 11, false),
  ('U12', 'Актуализация материалов', 'Зафиксировать изменение или передачу актуальной редакции материалов.', 'learning', 'Учебная работа и материалы', 12, false),
  ('U13', 'Повышение квалификации', 'Зафиксировать повторную потребность и связанные учебные результаты из указанного источника.', 'learning', 'Учебная работа и материалы', 13, false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS activity_university_steps (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  step_id text NOT NULL REFERENCES university_step_definitions(id),
  status text NOT NULL,
  note text NOT NULL DEFAULT '',
  evidence_reference text,
  evidence_source text,
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL,
  PRIMARY KEY (activity_id, step_id),
  CONSTRAINT activity_university_step_status CHECK (status IN ('in_progress', 'waiting', 'documented', 'not_applicable')),
  CONSTRAINT activity_university_step_note_length CHECK (char_length(note) <= 1000),
  CONSTRAINT activity_university_step_evidence_reference_length CHECK (evidence_reference IS NULL OR char_length(evidence_reference) <= 500),
  CONSTRAINT activity_university_step_evidence_source_length CHECK (evidence_source IS NULL OR char_length(evidence_source) <= 160),
  CONSTRAINT activity_university_step_revision CHECK (revision > 0)
);
