-- Backfill empty user names from data_column (legacy employees were created with name in data_column)
UPDATE users
SET name = NULLIF(data_column, '')
WHERE (name IS NULL OR name = '') AND NULLIF(data_column, '') IS NOT NULL;

SELECT 'Migration 20250717_backfill_user_names completed successfully' AS status;
