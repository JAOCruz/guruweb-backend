-- ============================================================
-- Create extra employee accounts for production metrics
-- Date: 2025-07-14
-- Description:
--   - administracion: digitador (general admin workload)
--   - auxiliar1: auxiliar
--   - auxiliar2: auxiliar
-- ============================================================

INSERT INTO users (username, email, password_hash, name, role, created_at, updated_at)
VALUES
  ('administracion', 'administracion@guru.local', '$2a$10$NxfwhIwB02iHhDmEUGG.hufZbf7c9R8lVh.j0Z5BpIkCuTM3copP6', 'Administracion', 'digitador', NOW(), NOW()),
  ('auxiliar1',      'auxiliar1@guru.local',      '$2a$10$2uGSysPxMTODpRpl.nS6te/.kNMXNC72d.phdLzjzH8F2bUmxI1lu', 'Auxiliar 1',     'auxiliar',  NOW(), NOW()),
  ('auxiliar2',      'auxiliar2@guru.local',      '$2a$10$GI3GeWId2Op0qQSAjgtUIuyVDpDHS8yrKtDQiH3aKNYD41zWTeQWG', 'Auxiliar 2',     'auxiliar',  NOW(), NOW())
ON CONFLICT (username) DO NOTHING;

SELECT 'Migration 20250714_create_extra_users completed successfully' AS status;
