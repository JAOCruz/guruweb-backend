// Crear desde cero (remake de Documentos): un documento nuevo que no sale de ningún modelo. La IA lo redacta
// completo a partir de lo que pide el digitador (los datos que faltan quedan como {{ETIQUETAS}}, nunca
// inventados) o se crea un Word en blanco con solo el título. Queda como v1 en Mis documentos.
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');

const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-cero-'));
process.env.GURU_TEMPLATES_BASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-cero-tpl-'));

const aiDocs = require('../src/documentos/aiDocs');
const { listBlocks } = require('../src/documentos/docxText');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {};
let ai = async () => { throw new Error('unexpected AI call'); };
aiDocs.setGenerator((parts) => ai(parts));

test.before(async () => {
  if (!hasDocx) return;
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Leandro','admin'), ('hengi','hengi@x.com','x','Hengi','digitador'), ('marleni','marleni@x.com','x','Marleni','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query('DROP TABLE IF EXISTS legal_profiles, portfolio_versions, portfolio_documents, clients, doc_template_variables, doc_variables, doc_templates, doc_categories CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, email TEXT, address TEXT, notes TEXT, user_id INT, source TEXT, assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, is_private BOOLEAN NOT NULL DEFAULT FALSE, created_by INT, publish_requested_at TIMESTAMPTZ, name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await pool.query(`CREATE TABLE doc_variables (id SERIAL PRIMARY KEY, tag TEXT, description TEXT, is_rol_dynamic BOOLEAN DEFAULT FALSE, rol_type TEXT)`);
  await pool.query(`CREATE TABLE doc_template_variables (id SERIAL PRIMARY KEY, template_id INT, variable_id INT, is_required BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0)`);
  await pool.query(`INSERT INTO clients (name, phone) VALUES ('Juan Pérez', '18095550001')`);
  await runSqlFile('migrations/20260929_portfolio.sql');
  await pool.query('DROP TABLE IF EXISTS invoices CASCADE');
  await pool.query('CREATE TABLE invoices (id SERIAL PRIMARY KEY, status TEXT)');
  await pool.query('DROP TABLE IF EXISTS business_info');
  await pool.query('CREATE TABLE business_info (clave TEXT PRIMARY KEY, valor JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  await runSqlFile('migrations/20261027_documentos_sin_cliente.sql');
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) tok[u.username] = generateToken(u);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/documentos', require('../src/routes/documentos'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) server.close(); await pool.end(); });

const call = (method, p, who, body) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: body ? JSON.stringify(body) : undefined });
const fileText = async (versionId) => {
  const { rows } = await pool.query('SELECT file_path FROM portfolio_versions WHERE id = $1', [versionId]);
  return (await listBlocks(rows[0].file_path)).map((b) => b.text);
};

test('la IA redacta el documento desde cero; los datos que faltan quedan como etiquetas', { skip: !hasDocx }, async () => {
  let prompt = '';
  ai = async (parts) => {
    prompt = String(parts);
    return JSON.stringify({
      title: 'CONTRATO DE ALQUILER DE LOCAL COMERCIAL',
      paragraphs: [
        // the model tends to repeat the title as a heading: it is dropped (the Word gets the title on its own)
        { text: 'CONTRATO DE ALQUILER DE LOCAL COMERCIAL', align: 'center', bold: true },
        { text: 'Entre {{NOMBRE_ARRENDADOR}}, dominicano, mayor de edad, cédula {{DOCUMENTO IDENTIDAD_ARRENDADOR}}, y {{NOMBRE_ARRENDATARIO}}.', align: 'justify' },
        { text: 'PRIMERO: El local comercial ubicado en Piantini, por dos (2) años, a RD$45,000.00 mensuales.' },
        'SEGUNDO: Elección de domicilio.',
        { text: 'Hecho y firmado en {{CIUDAD_FIRMA}}, a los {{DIA_TEXTO}} ({{DIA_NUMERO}}) días del mes de {{MES_TEXTO}} del año {{AÑO_TEXTO}}.' },
        { text: 'Yo, {{NOMBRE_NOTARIO}}, Notario Público de los del número del Distrito Nacional, matrícula {{MATRICULA_NOTARIO}}, certifico.' },
        { text: '' },
        { text: '{{NOMBRE_ARRENDADOR}}', align: 'center' },
        { text: 'Arrendador', align: 'center', bold: true },
      ],
    });
  };
  const res = await call('POST', '/api/documentos/documents/new', 'hengi', {
    client_id: 1, request: 'Contrato de alquiler de un local comercial en Piantini por 2 años, RD$45,000 mensuales',
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(prompt, /Piantini/);
  assert.match(prompt, /Juan Pérez/);
  assert.match(prompt, /NUNCA inventes/);
  // sin título en el pedido, se usa el de la IA
  assert.equal(body.document.title, 'CONTRATO DE ALQUILER DE LOCAL COMERCIAL');
  assert.equal(body.document.client_id, 1);
  assert.equal(body.document.template_id, null);
  assert.equal(body.document.approved_version, null);
  assert.equal(body.document.versions.length, 1);
  assert.equal(body.document.versions[0].source, 'generated');
  assert.match(body.document.versions[0].notes, /^Redactado desde cero con IA: Contrato de alquiler/);
  // los datos del cliente que faltan, aparte de los que siempre llena el equipo (notario, fecha y ciudad de firma)
  assert.deepEqual(body.placeholders, ['NOMBRE_ARRENDADOR', 'DOCUMENTO IDENTIDAD_ARRENDADOR', 'NOMBRE_ARRENDATARIO']);
  assert.deepEqual(body.staff_placeholders, ['CIUDAD_FIRMA', 'DIA_TEXTO', 'DIA_NUMERO', 'MES_TEXTO', 'AÑO_TEXTO', 'NOMBRE_NOTARIO', 'MATRICULA_NOTARIO']);
  const text = await fileText(body.document.versions[0].id);
  assert.equal(text[0], 'CONTRATO DE ALQUILER DE LOCAL COMERCIAL');
  assert.equal(text.filter((t) => t === 'CONTRATO DE ALQUILER DE LOCAL COMERCIAL').length, 1);
  assert.ok(text.includes('SEGUNDO: Elección de domicilio.'));
  assert.ok(text.includes('PRIMERO: El local comercial ubicado en Piantini, por dos (2) años, a RD$45,000.00 mensuales.'));
  assert.equal(text[text.length - 1], 'Arrendador');
  // aparece en Mis documentos de quien lo hizo, no de otro digitador
  const mine = await (await call('GET', '/api/documentos/documents?client_id=1', 'hengi')).json();
  assert.deepEqual(mine.documents.map((d) => d.id), [body.document.id]);
  const other = await (await call('GET', '/api/documentos/documents?client_id=1', 'marleni')).json();
  assert.deepEqual(other.documents, []);
  const { rows } = await pool.query(`SELECT action, summary FROM activity_log WHERE action = 'documento.new'`);
  assert.equal(rows[0].summary, 'Redactó desde cero con IA «CONTRATO DE ALQUILER DE LOCAL COMERCIAL» (Juan Pérez)');
});

test('el título del digitador manda sobre el de la IA; sin cliente queda en «Sin cliente»', { skip: !hasDocx }, async () => {
  ai = async () => JSON.stringify({ title: 'OTRO', paragraphs: [{ text: 'DECLARACIÓN JURADA DE SOLTERÍA', align: 'center' }, { text: 'Yo, {{NOMBRE_DECLARANTE}}, declaro bajo juramento.' }] });
  const res = await call('POST', '/api/documentos/documents/new', 'hengi', { title: 'Declaración jurada de soltería', request: 'Declaración jurada de soltería para un trámite de visa' });
  assert.equal(res.status, 201);
  const { document, placeholders } = await res.json();
  assert.equal(document.title, 'Declaración jurada de soltería');
  assert.equal(document.client_id, null);
  assert.deepEqual(placeholders, ['NOMBRE_DECLARANTE']);
  assert.deepEqual(await fileText(document.versions[0].id), ['DECLARACIÓN JURADA DE SOLTERÍA', '', 'Yo, {{NOMBRE_DECLARANTE}}, declaro bajo juramento.']);
});

test('documento en blanco: solo el título, sin llamar a la IA', { skip: !hasDocx }, async () => {
  ai = async () => { throw new Error('no debía llamar a la IA'); };
  const res = await call('POST', '/api/documentos/documents/new', 'admin', { blank: true, title: 'Carta de autorización', client_id: 1 });
  assert.equal(res.status, 201);
  const { document, placeholders, staff_placeholders } = await res.json();
  assert.deepEqual(placeholders, []);
  assert.deepEqual(staff_placeholders, []);
  assert.equal(document.versions[0].notes, 'Documento en blanco');
  assert.deepEqual(await fileText(document.versions[0].id), ['CARTA DE AUTORIZACIÓN', '']);
});

test('validaciones: pedido corto, blanco sin título, cliente inexistente, IA caída', { skip: !hasDocx }, async () => {
  let res = await call('POST', '/api/documentos/documents/new', 'hengi', { request: 'un poder' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'REQUEST_REQUIRED');
  res = await call('POST', '/api/documentos/documents/new', 'hengi', { blank: true });
  assert.equal((await res.json()).code, 'TITLE_REQUIRED');
  res = await call('POST', '/api/documentos/documents/new', 'hengi', { blank: true, title: 'x', client_id: 999 });
  assert.equal((await res.json()).code, 'INVALID_CLIENT');
  ai = async () => { throw new Error('timeout'); };
  res = await call('POST', '/api/documentos/documents/new', 'hengi', { request: 'Contrato de préstamo entre dos personas por RD$100,000' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'AI_UNAVAILABLE');
  // una respuesta vacía de la IA tampoco crea nada
  ai = async () => JSON.stringify({ title: 'X', paragraphs: [] });
  res = await call('POST', '/api/documentos/documents/new', 'hengi', { request: 'Contrato de préstamo entre dos personas por RD$100,000' });
  assert.equal(res.status, 502);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM portfolio_documents`)).rows[0].n, 3);
});
