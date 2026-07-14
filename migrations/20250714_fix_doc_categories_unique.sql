-- Allow the same category name/slug under different parents
ALTER TABLE doc_categories DROP CONSTRAINT IF EXISTS doc_categories_name_key;
ALTER TABLE doc_categories DROP CONSTRAINT IF EXISTS doc_categories_slug_key;
ALTER TABLE doc_categories ADD CONSTRAINT doc_categories_name_parent_unique UNIQUE (name, parent_id);
ALTER TABLE doc_categories ADD CONSTRAINT doc_categories_slug_parent_unique UNIQUE (slug, parent_id);
