CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  segment text NOT NULL CHECK (segment IN ('university','company')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY,
  full_name text NOT NULL,
  email text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_stages (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('university','individual','corporate')),
  stage_key text NOT NULL,
  label text NOT NULL,
  ordinal smallint NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  UNIQUE(kind, stage_key), UNIQUE(kind, ordinal)
);
CREATE TABLE IF NOT EXISTS workflow_transitions (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('university','individual','corporate')),
  from_key text NOT NULL,
  to_key text NOT NULL,
  UNIQUE(kind, from_key, to_key),
  FOREIGN KEY(kind, from_key) REFERENCES workflow_stages(kind, stage_key),
  FOREIGN KEY(kind, to_key) REFERENCES workflow_stages(kind, stage_key)
);
CREATE TABLE IF NOT EXISTS activities (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('university','individual','corporate')),
  title text NOT NULL,
  organization_id uuid REFERENCES organizations(id),
  person_id uuid REFERENCES people(id),
  payer_organization_id uuid REFERENCES organizations(id),
  stage_key text NOT NULL,
  owner_sub text NOT NULL,
  owner_name text NOT NULL,
  priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  awaiting_reply boolean NOT NULL DEFAULT false,
  closed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(kind, stage_key) REFERENCES workflow_stages(kind, stage_key),
  CHECK ((kind = 'individual' AND person_id IS NOT NULL) OR (kind <> 'individual' AND organization_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS activities_owner_updated_idx ON activities(owner_sub, updated_at DESC);
CREATE TABLE IF NOT EXISTS activity_products (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  PRIMARY KEY(activity_id, product_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  title text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  owner_sub text NOT NULL,
  owner_name text NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_open_due_idx ON tasks(status, due_at);
CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_sub text NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_events_timeline_idx ON activity_events(activity_id, created_at DESC);

INSERT INTO workflow_stages(id,kind,stage_key,label,ordinal,terminal) VALUES
('11111111-1111-4111-8111-111111111101','university','contact','Первичный контакт',1,false),
('11111111-1111-4111-8111-111111111102','university','meeting','Встреча и потребность',2,false),
('11111111-1111-4111-8111-111111111103','university','documents','Документы и согласование',3,false),
('11111111-1111-4111-8111-111111111104','university','implementation','Внедрение',4,false),
('11111111-1111-4111-8111-111111111105','university','closed','Завершено',5,true),
('22222222-2222-4222-8222-222222222201','individual','request','Новая заявка',1,false),
('22222222-2222-4222-8222-222222222202','individual','consultation','Консультация',2,false),
('22222222-2222-4222-8222-222222222203','individual','enrollment','Подготовка к обучению',3,false),
('22222222-2222-4222-8222-222222222204','individual','learning','Обучение',4,false),
('22222222-2222-4222-8222-222222222205','individual','closed','Завершено',5,true),
('33333333-3333-4333-8333-333333333301','corporate','qualification','Потребность компании',1,false),
('33333333-3333-4333-8333-333333333302','corporate','brief','Бриф и оценка',2,false),
('33333333-3333-4333-8333-333333333303','corporate','approval','Согласование программы',3,false),
('33333333-3333-4333-8333-333333333304','corporate','launch','Подготовка запуска',4,false),
('33333333-3333-4333-8333-333333333305','corporate','closed','Завершено',5,true)
ON CONFLICT (kind,stage_key) DO NOTHING;
INSERT INTO workflow_transitions(id,kind,from_key,to_key) VALUES
('aaaaaaaa-0001-4000-8000-000000000001','university','contact','meeting'),
('aaaaaaaa-0002-4000-8000-000000000002','university','meeting','documents'),
('aaaaaaaa-0003-4000-8000-000000000003','university','documents','implementation'),
('aaaaaaaa-0004-4000-8000-000000000004','university','implementation','closed'),
('bbbbbbbb-0001-4000-8000-000000000001','individual','request','consultation'),
('bbbbbbbb-0002-4000-8000-000000000002','individual','consultation','enrollment'),
('bbbbbbbb-0003-4000-8000-000000000003','individual','enrollment','learning'),
('bbbbbbbb-0004-4000-8000-000000000004','individual','learning','closed'),
('cccccccc-0001-4000-8000-000000000001','corporate','qualification','brief'),
('cccccccc-0002-4000-8000-000000000002','corporate','brief','approval'),
('cccccccc-0003-4000-8000-000000000003','corporate','approval','launch'),
('cccccccc-0004-4000-8000-000000000004','corporate','launch','closed')
ON CONFLICT (kind,from_key,to_key) DO NOTHING;
INSERT INTO products(id,name) VALUES
('44444444-4444-4444-8444-444444444401','RT.DataLake'),
('44444444-4444-4444-8444-444444444402','RT.Warehouse'),
('44444444-4444-4444-8444-444444444403','IT-школа: разработка')
ON CONFLICT (name) DO NOTHING;
