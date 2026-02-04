-- Migration to add comment column to services table
-- Run this on your Railway production database

ALTER TABLE services 
ADD COLUMN IF NOT EXISTS comment TEXT;
