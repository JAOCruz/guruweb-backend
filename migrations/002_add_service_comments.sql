-- Add comment column to services table
ALTER TABLE services
ADD COLUMN IF NOT EXISTS comment TEXT;

-- Add index for faster querying
CREATE INDEX IF NOT EXISTS idx_services_comment ON services(comment) WHERE comment IS NOT NULL;
