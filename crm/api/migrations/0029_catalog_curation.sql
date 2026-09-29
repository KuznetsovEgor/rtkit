ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_visible boolean NOT NULL DEFAULT true;

-- Keep existing activity/vendor links and report history, but do not offer test
-- fixtures or the old catch-all education label for new selections.
UPDATE products SET catalog_visible=false
WHERE id='44444444-4444-4444-8444-444444444403'
   OR name ~ '^(A[0-9]{2}|B[0-9]{2}|Report) product ';

-- IT products named in the supplied vendor sample and the research register.
INSERT INTO products(id,name,catalog_visible) VALUES
  ('44444444-4444-4444-8444-444444444404','Базис',true),
  ('44444444-4444-4444-8444-444444444405','Аврора',true),
  ('44444444-4444-4444-8444-444444444406','RT.Web3Gate',true)
ON CONFLICT (name) DO NOTHING;

-- Distinct educational programs: names are illustrative catalog entries based
-- on the research register, not claims of an active customer contract or run.
INSERT INTO learning_programs(id,name,priority) VALUES
  ('55555555-5555-4555-8555-555555555501','Акола — веб-разработка для студентов',3),
  ('55555555-5555-4555-8555-555555555502','DevOps-инженер — Базис (преподаватели)',3),
  ('55555555-5555-4555-8555-555555555503','Мобильная разработка на Авроре и Qt Quick',3),
  ('55555555-5555-4555-8555-555555555504','Распределённые реестры и RT.Web3Gate',3),
  ('55555555-5555-4555-8555-555555555505','Анализ данных с low-code',3),
  ('55555555-5555-4555-8555-555555555506','Управление ИТ-проектами',3)
ON CONFLICT DO NOTHING;
