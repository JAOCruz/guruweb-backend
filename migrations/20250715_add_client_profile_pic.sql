-- Add profile picture URL to clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS profile_pic_url TEXT;
