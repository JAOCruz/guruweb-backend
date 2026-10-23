const { pool, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// The website's "Ventanilla Gurú" lists the models an admin approved in Revisión de etiquetas:
// public, read-only, names and categories only.
let server, base;

test.before(async () => {
  await resetDb();
  await pool.query('DROP TABLE IF EXISTS doc_templates, doc_categories CASCADE');
  await pool.query('CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)');
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, description TEXT, file_path TEXT, file_name TEXT,
    category_id INT, is_active BOOLEAN DEFAULT TRUE, approved_tag_version_id INT)`);
  await pool.query(`INSERT INTO doc_categories (name) VALUES ('PODERES'), ('BIENES TRASLATIVOS')`);
  await pool.query(`INSERT INTO doc_templates (name, file_path, category_id, is_active, approved_tag_version_id) VALUES
    ('PODER ESPECIAL', '/secret/poder.docx', 1, TRUE, 7),
    ('ACTO DE VENTA DE VEHICULO', '/secret/venta.docx', 2, TRUE, 9),
    ('PODER SIN APROBAR', '/secret/x.docx', 1, TRUE, NULL),
    ('MODELO INACTIVO', '/secret/y.docx', 2, FALSE, 3),
    ('SIN CATEGORIA', '/secret/z.docx', NULL, TRUE, 4)`);
  const app = express();
  app.use('/api/public', require('../src/routes/publicModels'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) server.close(); await pool.end(); });

test('lists only active, approved models, by category then name, with no file paths', async () => {
  const res = await fetch(`${base}/api/public/models`);
  assert.equal(res.status, 200);
  const { models } = await res.json();
  assert.deepEqual(models, [
    { id: 2, name: 'ACTO DE VENTA DE VEHICULO', category: 'BIENES TRASLATIVOS' },
    { id: 1, name: 'PODER ESPECIAL', category: 'PODERES' },
    { id: 5, name: 'SIN CATEGORIA', category: null },
  ]);
});

test('any website may read it (no cookies), and browsers may cache it briefly', async () => {
  const res = await fetch(`${base}/api/public/models`, { headers: { Origin: 'https://guruweb-landing-premium.netlify.app' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.match(res.headers.get('cache-control') || '', /public, max-age=300/);
});
