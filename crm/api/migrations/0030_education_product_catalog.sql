-- Keep canonical names for imports and existing links. Only verified educational
-- product examples are added to the visible demonstration catalog.
UPDATE products SET catalog_visible=false WHERE name='RT.Warehouse';

INSERT INTO products(id,name,catalog_visible) VALUES
  ('44444444-4444-4444-8444-444444444407','Акола',true)
ON CONFLICT (name) DO NOTHING;
