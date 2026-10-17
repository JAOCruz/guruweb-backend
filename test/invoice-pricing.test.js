// Partidas por confirmar: el asignado del cliente (o el admin) pone los precios; no se aprueba ni se envía con precios pendientes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-pricing-'));

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const { generateToken } = require('../src/middleware/auth');

let server, base, adminId, digId, otroId, botId, clientId, tok;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/invoices', require('../src/routes/invoices'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  botId = await createAgentSchema();
  await pool.query(`ALTER TABLE invoices ADD COLUMN pdf_path TEXT, ADD COLUMN pdf_s3_key TEXT, ADD COLUMN pdf_storage_type TEXT,
    ADD COLUMN sent_at TIMESTAMPTZ, ADD COLUMN rejected_by INT, ADD COLUMN rejected_at TIMESTAMPTZ,
    ADD COLUMN paid_by INT, ADD COLUMN paid_at TIMESTAMPTZ, ADD COLUMN payment_method TEXT, ADD COLUMN payment_reference TEXT`);
  await pool.query('DROP TABLE IF EXISTS activity_log CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  botId = (await pool.query(`SELECT id FROM users WHERE username='bot'`)).rows[0].id;
  adminId = await createUser('leandro', 'admin', 'Leandro');
  digId = await createUser('hengi', 'digitador', 'Hengi');
  otroId = await createUser('otro', 'digitador', 'Otro');
  const t = (id, u, role) => generateToken({ id, username: u, email: `${u}@t.co`, role });
  tok = { admin: t(adminId, 'leandro', 'admin'), hengi: t(digId, 'hengi', 'digitador'), otro: t(otroId, 'otro', 'digitador') };
  clientId = (await pool.query(`INSERT INTO clients (phone, name, assigned_to) VALUES ('18095550001', 'Juan Pérez', $1) RETURNING id`, [digId])).rows[0].id;
});
test.after(async () => { server.close(); await pool.end(); });

const req = (method, p, who, body) => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: body ? JSON.stringify(body) : undefined,
});
const row = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
const ITEMS = [
  { desc: 'Copia certificada', cantidad: 1, precio: 700 },
  { desc: 'Apostilla en Cancillería', cantidad: 2, precio: null, por_confirmar: true, rango: { min: 250, max: 300 }, precio_sugerido: null, nota: 'Precio dentro del rango: lo confirma el digitador' },
];
async function botQuote(status = 'pending_approval', items = ITEMS) {
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, type, status, client_id, client_name, client_phone, items, subtotal, itbis, total, created_by, source)
     VALUES ('COT-2026-001', 'COTIZACIÓN', $1, $2, 'Juan Pérez', '18095550001', $3, 700, 0, 700, $4, 'bot') RETURNING *`,
    [status, clientId, JSON.stringify(items), botId]);
  return rows[0];
}

test('el digitador asignado ve la cotización del bot por aprobar', async () => {
  const inv = await botQuote();
  assert.equal((await req('GET', `/api/invoices/${inv.id}`, 'hengi')).status, 200);
  assert.equal((await req('GET', `/api/invoices/${inv.id}`, 'otro')).status, 403);
});

test('el asignado pone el precio: solo cambia precios, quita por_confirmar y recalcula el total', async () => {
  const inv = await botQuote();
  const res = await req('PUT', `/api/invoices/${inv.id}`, 'hengi', {
    items: [{ desc: 'CAMBIADO', cantidad: 9, precio: 1 }, { desc: 'otra', cantidad: 5, precio: 280 }, { desc: 'extra', cantidad: 1, precio: 99 }],
    notes: 'no debe cambiar', discountType: 'fixed', discountValue: 500,
  });
  assert.equal(res.status, 200);
  const r = await row(inv.id);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { desc: 'Copia certificada', cantidad: 1, precio: 1 });
  assert.equal(r.items[1].desc, 'Apostilla en Cancillería'); assert.equal(r.items[1].cantidad, 2);
  assert.equal(r.items[1].precio, 280); assert.equal(r.items[1].por_confirmar, undefined);
  assert.deepEqual(r.items[1].rango, { min: 250, max: 300 });
  assert.equal(Number(r.subtotal), 561); assert.equal(Number(r.total), 561);
  assert.equal(r.status, 'pending_approval');
  assert.equal(r.discount_type, null);
});

test('un precio vacío o 0 deja la línea por confirmar', async () => {
  const inv = await botQuote();
  await req('PUT', `/api/invoices/${inv.id}`, 'hengi', { items: [{ precio: 700 }, { precio: 0 }] });
  const r = await row(inv.id);
  assert.equal(r.items[1].por_confirmar, true); assert.equal(r.items[1].precio, null);
});

test('otro digitador, una cotización ya aprobada o una que no es del bot: 403/400', async () => {
  const inv = await botQuote();
  assert.equal((await req('PUT', `/api/invoices/${inv.id}`, 'otro', { items: [{ precio: 1 }, { precio: 1 }] })).status, 403);
  const aprobada = await botQuote('approved', [{ desc: 'x', cantidad: 1, precio: 100 }]);
  assert.equal((await req('PUT', `/api/invoices/${aprobada.id}`, 'hengi', { items: [{ precio: 1 }] })).status, 403);
  await pool.query(`UPDATE invoices SET source = 'dashboard' WHERE id = $1`, [inv.id]);
  assert.equal((await req('PUT', `/api/invoices/${inv.id}`, 'hengi', { items: [{ precio: 1 }, { precio: 1 }] })).status, 403);
});

test('el digitador no puede aprobar', async () => {
  const inv = await botQuote('pending_approval', [{ desc: 'x', cantidad: 1, precio: 100 }]);
  assert.equal((await req('POST', `/api/invoices/${inv.id}/approve`, 'hengi')).status, 403);
});

test('con precios por confirmar: aprobar, aprobar y enviar, enviar y enviar por WhatsApp dan 400 PRICES_PENDING', async () => {
  const inv = await botQuote();
  for (const p of ['approve', 'approve-and-send', 'send', 'send-whatsapp']) {
    const res = await req('POST', `/api/invoices/${inv.id}/${p}`, 'admin');
    assert.equal(res.status, 400, p);
    assert.equal((await res.json()).code, 'PRICES_PENDING', p);
  }
  assert.equal((await row(inv.id)).status, 'pending_approval');
});

test('el admin puede poner el precio y conserva los datos de las líneas que no toca', async () => {
  const inv = await botQuote();
  const res = await req('PUT', `/api/invoices/${inv.id}`, 'admin', { items: [ITEMS[0], { ...ITEMS[1] }] });
  assert.equal(res.status, 200);
  let r = await row(inv.id);
  assert.equal(r.items[1].por_confirmar, true); assert.deepEqual(r.items[1].rango, { min: 250, max: 300 });
  assert.equal(Number(r.total), 700);
  await req('PUT', `/api/invoices/${inv.id}`, 'admin', { items: [ITEMS[0], { ...ITEMS[1], precio: 300 }] });
  r = await row(inv.id);
  assert.equal(r.items[1].por_confirmar, undefined); assert.equal(Number(r.total), 1300);
  assert.equal((await req('POST', `/api/invoices/${inv.id}/approve`, 'admin')).status, 200);
});

test('al poner precios el asignado, el PDF viejo se descarta (no sale con "Por confirmar")', async () => {
  const inv = await botQuote();
  await pool.query(`UPDATE invoices SET pdf_path = '/tmp/viejo.pdf' WHERE id = $1`, [inv.id]);
  await req('PUT', `/api/invoices/${inv.id}`, 'hengi', { items: [{ precio: 700 }, { precio: 280 }] });
  assert.equal((await row(inv.id)).pdf_path, null);
});

test('el admin no puede dejar en blanco una línea con precio: queda por confirmar y bloquea aprobar', async () => {
  const inv = await botQuote('pending_approval', [{ desc: 'Copia', cantidad: 1, precio: 700 }]);
  await req('PUT', `/api/invoices/${inv.id}`, 'admin', { items: [{ desc: 'Copia', cantidad: 1, precio: null }] });
  const r = await row(inv.id);
  assert.equal(r.items[0].por_confirmar, true);
  assert.equal((await req('POST', `/api/invoices/${inv.id}/approve`, 'admin')).status, 400);
});

test('descuento en porcentaje se recalcula con el subtotal nuevo cuando el asignado pone precios', async () => {
  const inv = await botQuote();
  await pool.query(`UPDATE invoices SET discount_type = 'percentage', discount_value = 10, discount_amount = 70 WHERE id = $1`, [inv.id]);
  await req('PUT', `/api/invoices/${inv.id}`, 'hengi', { items: [{ precio: 700 }, { precio: 300 }] });
  const r = await row(inv.id);
  assert.equal(Number(r.subtotal), 1300); assert.equal(Number(r.discount_amount), 130); assert.equal(Number(r.total), 1170);
});

test('entrada rara del asignado (no objetos) no rompe: 200 y nada cambia', async () => {
  const inv = await botQuote();
  assert.equal((await req('PUT', `/api/invoices/${inv.id}`, 'hengi', { items: [500, 'x'] })).status, 200);
  assert.equal((await row(inv.id)).items[1].por_confirmar, true);
});

test('cuando el asignado deja todo con precio, avisa a los admins que está lista para aprobar', async () => {
  const inv = await botQuote();
  await req('PUT', `/api/invoices/${inv.id}`, 'hengi', { items: [{ precio: 700 }, { precio: 280 }] });
  const n = (await pool.query(`SELECT user_id, title, link FROM notifications ORDER BY id`)).rows;
  assert.deepEqual(n.map((x) => x.user_id), [adminId]);
  assert.match(n[0].title, /lista para aprobar/i);
  assert.equal(n[0].link, `/cotizaciones?invoice=${inv.id}`);
});
