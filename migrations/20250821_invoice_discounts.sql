-- Add discount support to invoices (admin-only feature)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20) CHECK (discount_type IN ('percentage', 'fixed', 'coupon')),
  ADD COLUMN IF NOT EXISTS discount_value DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_reason TEXT;
