-- Widen phone columns to support simulator session IDs and longer phone numbers
ALTER TABLE IF EXISTS clients ALTER COLUMN phone TYPE VARCHAR(50);
ALTER TABLE IF EXISTS messages ALTER COLUMN phone TYPE VARCHAR(50);
ALTER TABLE IF EXISTS conversation_sessions ALTER COLUMN phone TYPE VARCHAR(50);
