-- Restore original password hashes from 2026-05-23 Railway backup
-- These hashes were captured before any temporary password resets.
-- Remove the duplicate 'administracion' account; admin already exists.

UPDATE users SET password_hash = '$2a$10$NJzGpmpyGk5YZDZVk1IUluQnzSWUSMrCmiPWgeFI3TGHQs5Lx4I4W' WHERE username = 'admin';
UPDATE users SET password_hash = '$2a$10$k7sC84.qMc0WgZwLkEbd.u8Y95cks10HQ0.aSzI28H5J3yvJAcWwW' WHERE username = 'hengi';
UPDATE users SET password_hash = '$2a$10$atamSh4llmXGEwZaW03OguqcNlJg7PoPeZp3Ce/aSodpC4BOZnfs2' WHERE username = 'marleni';
UPDATE users SET password_hash = '$2a$10$O/qLjZ5tFJQitVSNPv.oQuPX.oSlArLNpcv9tEwJNFoAXtC2hzVLi' WHERE username = 'israel';
UPDATE users SET password_hash = '$2a$10$.M66i8DLJWEcmiqrdtNv9uW5ER1dsn3UqdK2REMaQPJ4VJtrJZiau' WHERE username = 'thaicar';
UPDATE users SET password_hash = '$2a$10$qxh3S4g7d83/UJnUFzSzpuxW/.Xqe7aazuDRWGrruxyLsOwB.yVY6' WHERE username = 'devtest';

-- Delete the duplicate admin-ish account requested by user
DELETE FROM users WHERE username = 'administracion';

-- Normalize roles: existing employee -> digitador for non-admin, keep admin/devtest as admin
-- (role normalization already done in migration, this just ensures consistency)
UPDATE users SET role = 'admin' WHERE username IN ('admin', 'devtest');
UPDATE users SET role = 'digitador' WHERE role = 'employee';

SELECT id, username, role FROM users ORDER BY id;
