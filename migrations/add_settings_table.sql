-- Create settings table for employee percentage configuration
CREATE TABLE IF NOT EXISTS settings (
    id SERIAL PRIMARY KEY,
    employee_percentage DECIMAL(5, 2) NOT NULL CHECK (employee_percentage >= 0 AND employee_percentage <= 100),
    effective_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on effective_date for efficient queries
CREATE INDEX IF NOT EXISTS idx_settings_effective_date ON settings(effective_date DESC);

-- Insert default 50/50 split starting from today
INSERT INTO settings (employee_percentage, effective_date)
VALUES (50.00, CURRENT_DATE)
ON CONFLICT DO NOTHING;
