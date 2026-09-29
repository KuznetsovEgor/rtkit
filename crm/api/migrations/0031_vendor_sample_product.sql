-- RT.Warehouse appears explicitly in the supplied vendor workbook. Keep the
-- canonical spelling available to the import preview and preserve old links.
-- Its educational use and functional description remain unverified.
UPDATE products SET catalog_visible=true WHERE name='RT.Warehouse';
