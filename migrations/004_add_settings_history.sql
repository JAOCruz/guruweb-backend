-- Migration: Add settings_history table for tracking percentage changes over time
-- This allows accurate historical calculations

CREATE TABLE IF NOT EXISTS settings_history (
    id SERIAL PRIMARY KEY,
    employee_percentage DECIMAL(5, 4) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_date_range CHECK (end_date IS NULL OR end_date >= start_date)
);

-- Create index for efficient date lookups
CREATE INDEX IF NOT EXISTS idx_settings_history_dates ON settings_history(start_date, end_date);

-- Insert initial record with 50% starting from a past date
INSERT INTO settings_history (employee_percentage, start_date, end_date)
VALUES (0.5, '2024-01-01', NULL)
ON CONFLICT DO NOTHING;
