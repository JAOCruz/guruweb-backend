-- PIN (bcrypt) que pide el dashboard del admin para mostrar las ganancias. Idempotente.
ALTER TABLE users ADD COLUMN IF NOT EXISTS earnings_pin_hash TEXT;
