process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const legalProfile = require('../src/documentos/legalProfile');
const { guardar_datos_cliente, leer_documento, _setAnalyzer } = require('../src/agent/tools/client');
const { crear_solicitud, estado_solicitud } = require('../src/agent/tools/requests');

const PHONE = '18095550101';
let clientId, ctx, adminId, digId;

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS notifications, cases, messages, client_media, legal_profiles, clients CASCADE`);
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE, name VARCHAR(255), assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await pool.query(`CREATE TABLE client_media (id SERIAL PRIMARY KEY, phone VARCHAR(20) NOT NULL, client_id INT, wa_message_id VARCHAR(255), media_type VARCHAR(20) NOT NULL, mime_type VARCHAR(100), file_path TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE messages (id SERIAL PRIMARY KEY, wa_message_id VARCHAR(255), phone VARCHAR(20), content TEXT)`);
  await pool.query(`CREATE TABLE cases (id SERIAL PRIMARY KEY, case_number TEXT, title TEXT, description TEXT, status TEXT DEFAULT 'new', case_type TEXT, client_id INT, user_id INT, court TEXT, next_hearing TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), source TEXT, service_id INT, institution TEXT, expected_completion_date DATE, reminder_sent_at TIMESTAMPTZ, case_subtype TEXT)`);
  await pool.query(`CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(255) NOT NULL, message TEXT NOT NULL, link TEXT, read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
  const mk = async (u, role, name) => (await pool.query(
    `INSERT INTO users (username, email, password_hash, name, role) VALUES ($1,$2,'x',$3,$4) RETURNING id`, [u, `${u}@t.co`, name, role])).rows[0].id;
  adminId = await mk('adm', 'admin', 'Admin Uno');
  digId = await mk('dig', 'digitador', 'Digi Tador');
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, $1) RETURNING id`, [PHONE])).rows[0].id;
  const client = (await pool.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
  ctx = { phone: PHONE, client, botUserId: adminId, now: new Date() };
  _setAnalyzer(null);
});
test.after(async () => { await pool.end(); });

test('guardar_datos_cliente guarda en la ficha legal normalizando la clave', async () => {
  const r = await guardar_datos_cliente({ campos: { 'cédula': '001-0000000-1' } }, ctx);
  assert.deepEqual(r.guardado, ['CEDULA']);
  assert.equal((await legalProfile.get(clientId)).CEDULA, '001-0000000-1');
});

test('un dato que cambia queda en HISTORIAL y el nuevo reemplaza al viejo', async () => {
  await guardar_datos_cliente({ campos: { ESTADO_CIVIL: 'soltero' } }, ctx);
  const r = await guardar_datos_cliente({ campos: { 'estado civil': 'casado', PROFESION: 'abogado' } }, ctx);
  assert.deepEqual(r.cambios.find((c) => c.clave === 'ESTADO CIVIL'), { clave: 'ESTADO CIVIL', antes: 'soltero', ahora: 'casado' });
  const p = await legalProfile.get(clientId);
  assert.equal(p['ESTADO CIVIL'], 'casado');
  assert.equal(p.PROFESION, 'abogado');
  assert.equal(p.HISTORIAL.length, 1);
  assert.equal(p.HISTORIAL[0].clave, 'ESTADO CIVIL');
  assert.equal(p.HISTORIAL[0].antes, 'soltero');
  assert.ok(p.HISTORIAL[0].fecha);
});

test('NOMBRE reemplaza un nombre de cliente que era solo el teléfono', async () => {
  await guardar_datos_cliente({ campos: { NOMBRE: 'María Pérez' } }, ctx);
  const { rows } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
  assert.equal(rows[0].name, 'María Pérez');
});

test('NOMBRE no pisa un nombre real si la ficha ya tenía NOMBRE', async () => {
  await pool.query(`UPDATE clients SET name='Juan Real' WHERE id=$1`, [clientId]);
  await legalProfile.merge(clientId, { NOMBRE: 'Juan Real' }, adminId);
  ctx.client.name = 'Juan Real';
  await guardar_datos_cliente({ campos: { NOMBRE: 'Juan R. Otro' } }, ctx);
  const { rows } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
  assert.equal(rows[0].name, 'Juan Real');
});

async function media(phone, waId, content) {
  const m = await pool.query(`INSERT INTO client_media (phone, wa_message_id, media_type, mime_type, file_path) VALUES ($1,$2,'image','image/jpeg','/x.jpg') RETURNING id`, [phone, waId]);
  if (content != null) await pool.query(`INSERT INTO messages (wa_message_id, phone, content) VALUES ($1,$2,$3)`, [waId, phone, content]);
  return m.rows[0].id;
}

test('leer_documento no lee medios de otro teléfono', async () => {
  const id = await media('18095559999', 'w1', 'x');
  assert.deepEqual(await leer_documento({ media_id: id }, ctx), { error: 'archivo no encontrado' });
});

test('leer_documento usa el análisis ya guardado sin llamar a la IA', async () => {
  _setAnalyzer(async () => { throw new Error('no debe llamarse'); });
  const id = await media(PHONE, 'w2', '[Imagen]\n[📷 Imagen analizada]: Cédula 001-1234567-8, Ana Gómez');
  const r = await leer_documento({ media_id: id }, ctx);
  assert.deepEqual(r, { tipo: 'image', datos_extraidos: 'Cédula 001-1234567-8, Ana Gómez' });
});

test('leer_documento analiza si no hay análisis guardado', async () => {
  _setAnalyzer(async (p, mime, type) => `texto ${p} ${mime} ${type}`);
  const id = await media(PHONE, 'w3', '[Imagen]');
  const r = await leer_documento({ media_id: id }, ctx);
  assert.equal(r.datos_extraidos, 'texto /x.jpg image/jpeg image');
});

test('crear_solicitud crea el caso, lo deja al asignado y le avisa', async () => {
  await pool.query('UPDATE clients SET assigned_to=$1, name=$2 WHERE id=$3', [digId, 'Ana', clientId]);
  ctx.client = (await pool.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
  const r = await crear_solicitud({ servicio: 'Acto de venta', detalles: 'Carro' }, ctx);
  assert.match(r.caso, /^CASO-/);
  assert.equal(r.estado, 'new');
  assert.equal(r.asignado_a, 'Digi Tador');
  const c = (await pool.query('SELECT * FROM cases WHERE case_number=$1', [r.caso])).rows[0];
  assert.equal(c.user_id, digId);
  assert.equal(c.title, 'Acto de venta — Ana');
  assert.equal(c.source, 'whatsapp');
  const n = (await pool.query('SELECT * FROM notifications')).rows;
  assert.equal(n.length, 1);
  assert.equal(n[0].user_id, digId);
  assert.equal(n[0].type, 'case');
  assert.equal(n[0].link, '/cases');
});

test('crear_solicitud sin asignado avisa a cada admin activo', async () => {
  const a2 = (await pool.query(`INSERT INTO users (username,email,password_hash,name,role) VALUES ('adm2','a2@t.co','x','Admin Dos','admin') RETURNING id`)).rows[0].id;
  const a3 = (await pool.query(`INSERT INTO users (username,email,password_hash,name,role,is_active) VALUES ('adm3','a3@t.co','x','Inactivo','admin',false) RETURNING id`)).rows[0].id;
  const r = await crear_solicitud({ servicio: 'Poder' }, ctx);
  assert.equal(r.asignado_a, null);
  const ids = (await pool.query('SELECT user_id FROM notifications ORDER BY user_id')).rows.map((x) => x.user_id);
  assert.deepEqual(ids, [adminId, a2].sort((a, b) => a - b));
  assert.ok(!ids.includes(a3));
});

test('estado_solicitud devuelve las del cliente, la más nueva primero', async () => {
  for (let i = 1; i <= 6; i++) {
    await pool.query(`INSERT INTO cases (case_number, title, client_id, created_at) VALUES ($1,$2,$3, NOW() + ($4 || ' minutes')::interval)`, [`C${i}`, `T${i}`, clientId, String(i)]);
  }
  await pool.query(`INSERT INTO cases (case_number, title, client_id) VALUES ('OTRO','x',9999)`);
  const r = await estado_solicitud({}, ctx);
  assert.equal(r.solicitudes.length, 5);
  assert.deepEqual(r.solicitudes.map((s) => s.caso), ['C6', 'C5', 'C4', 'C3', 'C2']);
  assert.equal(r.solicitudes[0].estado, 'new');
});
