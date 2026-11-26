// Envíos (Jay, 2026-11-26): el bot recoge los datos del envío y el dashboard los organiza por estado.
// Nada de dinero: el pago del Uber lo maneja el equipo por fuera.
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { generateToken } = require('../src/middleware/auth');
const { registrar_envio } = require('../src/agent/tools/delivery');

const PHONE = '18095550101';
let server, base, tok = {}, ids = {}, clientId, ctx;

test.before(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS deliveries, notifications, cases, clients, activity_log CASCADE`);
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE, name VARCHAR(255), assigned_to INT, user_id INT, email VARCHAR(255), address TEXT, notes TEXT, source VARCHAR(20) DEFAULT 'whatsapp', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE cases (id SERIAL PRIMARY KEY, case_number TEXT, title TEXT, client_id INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(255) NOT NULL, message TEXT NOT NULL, link TEXT, read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20261126_envios.sql');
  await runSqlFile('migrations/20261126_envios.sql'); // idempotente
  for (const [u, role] of [['adm', 'admin'], ['dig', 'digitador']]) {
    const { rows } = await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES ($1,$2,'x',$1,$3) RETURNING id, username, email, role`, [u, `${u}@t.co`, role]);
    ids[u] = rows[0].id;
    tok[u] = generateToken(rows[0]);
  }
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Ana Pérez') RETURNING id`, [PHONE])).rows[0].id;
  await pool.query(`INSERT INTO cases (case_number, title, client_id) VALUES ('C-1','Contrato — Ana', $1)`, [clientId]);
  const client = (await pool.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
  ctx = { phone: PHONE, client };

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/deliveries', require('../src/routes/deliveries'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, path, who, body) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who && { Authorization: `Bearer ${tok[who]}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });

test('registrar_envio pide la dirección', async () => {
  const r = await registrar_envio({ recibe: 'Ana' }, ctx);
  assert.ok(r.error);
});

test('registrar_envio crea el envío «por enviar», ligado al cliente y su solicitud, y avisa a los admins', async () => {
  const r = await registrar_envio({ direccion: 'C/ Duarte 10, Gazcue', referencia: 'frente al colmado', recibe: 'Ana Pérez', telefono_recibe: '8095550101', documento: 'Contrato de alquiler' }, ctx);
  assert.equal(r.estado, 'por_enviar');
  const { rows } = await pool.query('SELECT * FROM deliveries');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, clientId);
  assert.ok(rows[0].case_id);
  assert.equal(rows[0].address, 'C/ Duarte 10, Gazcue');
  assert.equal(rows[0].reference, 'frente al colmado');
  assert.equal(rows[0].recipient_name, 'Ana Pérez');
  assert.equal(rows[0].document, 'Contrato de alquiler');
  assert.equal(rows[0].source, 'whatsapp');
  const n = await pool.query(`SELECT user_id, link FROM notifications WHERE type = 'delivery'`);
  assert.deepEqual(n.rows.map((x) => x.user_id), [ids.adm]);
  assert.equal(n.rows[0].link, `/envios?envio=${rows[0].id}`);
});

test('si ya tiene un envío por enviar, lo actualiza en vez de crear otro', async () => {
  const r = await registrar_envio({ direccion: 'Av. Lincoln 5, Piantini' }, ctx);
  assert.equal(r.actualizado, true);
  const { rows } = await pool.query('SELECT address, recipient_name FROM deliveries');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, 'Av. Lincoln 5, Piantini');
  assert.equal(rows[0].recipient_name, 'Ana Pérez'); // lo que no vino se conserva
});

test('GET /api/deliveries pide sesión; cualquier usuario ve la lista por estado con contadores', async () => {
  assert.equal((await call('GET', '/api/deliveries')).status, 401);
  const res = await call('GET', '/api/deliveries?status=por_enviar', 'dig');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deliveries.length, 1);
  assert.equal(body.deliveries[0].client_name, 'Ana Pérez');
  assert.equal(body.deliveries[0].client_phone, PHONE);
  assert.deepEqual(body.counts, { por_enviar: 1, enviado: 0, entregado: 0, cancelado: 0 });
});

test('crear un envío a mano pide la dirección', async () => {
  let res = await call('POST', '/api/deliveries', 'dig', { recipient_name: 'Luis' });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/deliveries', 'dig', { address: 'C/ El Conde 3', recipient_name: 'Luis', recipient_phone: '8090000000', document: 'Poder' });
  assert.equal(res.status, 201);
  const { delivery } = await res.json();
  assert.equal(delivery.status, 'por_enviar');
  assert.equal(delivery.source, 'manual');
  assert.equal(delivery.created_by, ids.dig);
});

test('editar los datos de un envío', async () => {
  const id = (await pool.query(`SELECT id FROM deliveries WHERE source='manual'`)).rows[0].id;
  const res = await call('PUT', `/api/deliveries/${id}`, 'dig', { address: 'C/ El Conde 5', note: 'Llamar antes' });
  assert.equal(res.status, 200);
  const { delivery } = await res.json();
  assert.equal(delivery.address, 'C/ El Conde 5');
  assert.equal(delivery.note, 'Llamar antes');
  assert.equal(delivery.recipient_name, 'Luis');
  assert.equal((await call('PUT', `/api/deliveries/${id}`, 'dig', { address: '  ' })).status, 400);
  assert.equal((await call('PUT', `/api/deliveries/99999`, 'dig', { note: 'x' })).status, 404);
});

test('cambiar de estado guarda la fecha y queda en Actividad; un estado inventado se rechaza', async () => {
  const id = (await pool.query(`SELECT id FROM deliveries WHERE source='manual'`)).rows[0].id;
  assert.equal((await call('POST', `/api/deliveries/${id}/status`, 'dig', { status: 'volando' })).status, 400);
  let res = await call('POST', `/api/deliveries/${id}/status`, 'dig', { status: 'enviado' });
  assert.equal(res.status, 200);
  let { delivery } = await res.json();
  assert.equal(delivery.status, 'enviado');
  assert.ok(delivery.sent_at);
  ({ delivery } = await (await call('POST', `/api/deliveries/${id}/status`, 'adm', { status: 'entregado' })).json());
  assert.ok(delivery.delivered_at);
  const counts = (await (await call('GET', '/api/deliveries?status=entregado', 'adm')).json()).counts;
  assert.equal(counts.entregado, 1);
  const log = await pool.query(`SELECT category, action FROM activity_log WHERE action = 'delivery.status' ORDER BY id`);
  assert.equal(log.rows.length, 2);
  assert.equal(log.rows[0].category, 'envios');
});

test('un envío ya enviado no lo pisa el bot: crea uno nuevo', async () => {
  const id = (await pool.query(`SELECT id FROM deliveries WHERE client_id=$1`, [clientId])).rows[0].id;
  await call('POST', `/api/deliveries/${id}/status`, 'dig', { status: 'enviado' });
  const r = await registrar_envio({ direccion: 'Otra dirección 1' }, ctx);
  assert.notEqual(r.actualizado, true);
  const { rows } = await pool.query('SELECT status FROM deliveries WHERE client_id=$1 ORDER BY id', [clientId]);
  assert.deepEqual(rows.map((x) => x.status), ['enviado', 'por_enviar']);
});
