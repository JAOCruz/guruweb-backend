process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { preparar_cotizacion } = require('../src/agent/tools/quote');
const { pasar_a_humano, notifyUrgentAfterHandoff } = require('../src/agent/tools/handoff');
const { clearCache } = require('../src/agent/businessInfo');
const handler = require('../src/whatsapp/handler');

const PHONE = '18095550111';
// 2026-10-05 es lunes; 15:00Z = 11:00 en Santo Domingo (abierto). 03:00Z del martes = 23:00 lunes (cerrado).
const OPEN = new Date('2026-10-05T15:00:00Z');
const CLOSED = new Date('2026-10-06T03:00:00Z');
let ids, ctx, botUserId, adminId, digId, clientId;

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS wa_bot_state, notifications, bot_tool_log, bot_memory, business_info, tramites, invoices, service_catalog, service_categories, clients CASCADE`);
  await pool.query(`CREATE TABLE service_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, category_id INT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB DEFAULT '[]', unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY, doc_number TEXT, type TEXT, status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','approved','sent','rejected','paid')), client_id INT, case_id INT, client_name TEXT, client_phone TEXT,
    items JSONB, notes TEXT, subtotal NUMERIC, itbis NUMERIC, total NUMERIC, created_by INT, source TEXT, discount_type TEXT, discount_value NUMERIC,
    discount_code TEXT, discount_amount NUMERIC, discount_reason TEXT, approved_by INT, approved_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE, name VARCHAR(255), assigned_to INT, user_id INT, email VARCHAR(255), address TEXT, notes TEXT, source VARCHAR(20) DEFAULT 'whatsapp')`);
  await pool.query(`CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(255) NOT NULL, message TEXT NOT NULL, link TEXT, read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query('CREATE TABLE wa_bot_state (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)');
  await runSqlFile('migrations/20261005_bot_agent.sql');
  clearCache();
  const mk = async (u, role, name) => (await pool.query(
    `INSERT INTO users (username, email, password_hash, name, role) VALUES ($1,$2,'x',$3,$4) RETURNING id`, [u, `${u}@t.co`, name, role])).rows[0].id;
  adminId = await mk('adm', 'admin', 'Admin Uno');
  digId = await mk('dig', 'digitador', 'Digi Tador');
  botUserId = (await pool.query(`SELECT id FROM users WHERE username='bot'`)).rows[0].id;
  await pool.query(`INSERT INTO service_categories (id, name) VALUES (1, 'Actos de venta')`);
  const ins = async (name, cols) => (await pool.query(
    `INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, price_tiers, por_confirmar) VALUES ($1,1,$2,$3,$4,$5) RETURNING id`,
    [name, cols.dig, cols.not || null, JSON.stringify(cols.tiers || []), !!cols.pc])).rows[0].id;
  ids = {
    acto: await ins('Acto de Venta', { dig: 500, not: 300, tiers: [{ min: 0, max: 1000000, price: 450 }] }),
    copia: await ins('Copia certificada', { dig: 700 }),
    conf: await ins('Estatus Jurídico', { dig: 1000, pc: true }),
    cero: await ins('Servicio en cero', { dig: 0 }),
  };
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Ana Cliente') RETURNING id`, [PHONE])).rows[0].id;
  const client = (await pool.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
  ctx = { phone: PHONE, client, botUserId, now: OPEN };
  handler.setManualMode(PHONE, false);
});
test.after(async () => { await pool.end(); });

const notifs = async (type) => (await pool.query('SELECT * FROM notifications WHERE type=$1 ORDER BY id', [type])).rows;

test('preparar_cotizacion recalcula con el catálogo, la crea por aprobar como el bot y avisa a los admins', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.acto, valor_del_bien: 500000 }] }, ctx);
  assert.equal(r.total, 950); assert.equal(r.estado, 'pending_approval');
  assert.match(r.cotizacion, /^COT-/);
  const inv = (await pool.query('SELECT * FROM invoices')).rows[0];
  assert.equal(r.invoice_id, inv.id); // I1: el id numérico, para ligar el documento con preparar_documento
  assert.equal(inv.created_by, botUserId); assert.equal(inv.status, 'pending_approval');
  assert.equal(inv.source, 'bot'); assert.equal(inv.type, 'COTIZACIÓN');
  assert.equal(Number(inv.total), 950); assert.equal(Number(inv.itbis), 0);
  assert.equal(inv.items[0].cantidad, 1); assert.equal(inv.items[0].precio, 950);
  assert.match(inv.items[0].desc, /^Acto de Venta/);
  const n = await notifs('invoice');
  assert.ok(n.length >= 1); assert.equal(n[0].link, '/cotizaciones');
  assert.ok(n.every((x) => x.user_id !== digId));
});

test('con una partida por confirmar no crea nada y dice cuál', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.copia }, { servicio_id: ids.conf }, { servicio_id: 99999 }] }, ctx);
  assert.equal(r.error, 'hay partidas sin precio confirmado');
  assert.deepEqual(r.sin_precio, ['Estatus Jurídico', '99999']);
  assert.equal((await pool.query('SELECT count(*)::int c FROM invoices')).rows[0].c, 0);
});

test('cantidad multiplica el precio unitario', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.copia, cantidad: 3 }] }, ctx);
  assert.equal(r.total, 2100);
});

test('pasar_a_humano pone el chat en manual, avisa y devuelve el mensaje de espera exacto', async () => {
  const r = await pasar_a_humano({ motivo: 'reclamación' }, ctx);
  assert.equal(r.urgente, false);
  assert.equal(r.mensaje, "Un miembro de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo 'urgente'.");
  assert.equal(handler.isManualMode(PHONE), true);
  const st = (await pool.query(`SELECT value FROM wa_bot_state WHERE key=$1`, [`handoff:${PHONE}`])).rows[0].value;
  assert.equal(st.motivo, 'reclamación'); assert.equal(st.urgente_avisado, false); assert.ok(st.at);
  const n = await notifs('handoff');
  assert.equal(n[0].title, '🙋 El bot pasó un chat: Ana Cliente');
  assert.equal(n[0].link, `/bot-messages?phone=${PHONE}`);
});

test('con asignado, solo se le avisa a esa persona', async () => {
  await pool.query('UPDATE clients SET assigned_to=$1', [digId]);
  ctx.client.assigned_to = digId;
  await pasar_a_humano({ motivo: 'x' }, ctx);
  assert.deepEqual((await notifs('handoff')).map((x) => x.user_id), [digId]);
});

test('fuera de horario con "urgente" el aviso dice URGENTE', async () => {
  const r = await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: CLOSED, lastText: 'Es ÚRGENTE, por favor' });
  assert.equal(r.urgente, true);
  assert.equal((await notifs('handoff'))[0].title, '🚨 URGENTE 🙋 El bot pasó un chat: Ana Cliente');
  const r2 = await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: OPEN, lastText: 'urgente' });
  assert.equal(r2.urgente, false);
  const r3 = await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: CLOSED, lastText: 'urgentemente' });
  assert.equal(r3.urgente, false);
});

test('notifyUrgentAfterHandoff avisa una sola vez', async () => {
  await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: CLOSED, lastText: 'hola' });
  const before = (await notifs('handoff')).length;
  assert.equal(await notifyUrgentAfterHandoff(PHONE, 'es urgente', CLOSED), true);
  const after = await notifs('handoff');
  assert.equal(after.length, before + 1);
  assert.match(after[after.length - 1].title, /^🚨 URGENTE /);
  assert.equal(await notifyUrgentAfterHandoff(PHONE, 'urgente!!', CLOSED), false);
  assert.equal((await notifs('handoff')).length, before + 1);
});

test('notifyUrgentAfterHandoff no avisa abierto ni sin la palabra, y no hace nada si el bot no pasó el chat', async () => {
  assert.equal(await notifyUrgentAfterHandoff(PHONE, 'urgente', CLOSED), false);
  await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: CLOSED, lastText: 'hola' });
  assert.equal(await notifyUrgentAfterHandoff(PHONE, 'urgente', OPEN), false);
  assert.equal(await notifyUrgentAfterHandoff(PHONE, 'gracias', CLOSED), false);
  assert.equal((await notifs('handoff')).length, 1);
});

test('una partida en RD$0 se rechaza como sin precio', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.copia }, { servicio_id: ids.cero }] }, ctx);
  assert.equal(r.error, 'hay partidas sin precio confirmado');
  assert.deepEqual(r.sin_precio, ['Servicio en cero']);
  assert.equal((await pool.query('SELECT count(*)::int c FROM invoices')).rows[0].c, 0);
});

test('si pasar_a_humano ya avisó urgente, notifyUrgentAfterHandoff no repite', async () => {
  await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: CLOSED, lastText: 'urgente' });
  const urgent = async () => (await notifs('handoff')).filter((n) => n.title.startsWith('🚨 URGENTE ')).length;
  assert.equal(await urgent(), 1);
  assert.equal(await notifyUrgentAfterHandoff(PHONE, 'urgente', CLOSED), false);
  assert.equal(await urgent(), 1);
});

// ---------- revisión final ----------

test('preparar_cotizacion rechaza una partida por tramos sin valor del bien y dice que falta el valor', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.acto }, { servicio_id: ids.copia }] }, ctx);
  assert.equal(r.error, 'falta el valor del bien');
  assert.deepEqual(r.falta_valor, ['Acto de Venta']);
  assert.equal((await pool.query('SELECT count(*)::int c FROM invoices')).rows[0].c, 0);
  // Con valor sí sale.
  const ok = await preparar_cotizacion({ partidas: [{ servicio_id: ids.acto, valor_del_bien: 500000 }, { servicio_id: ids.copia }] }, ctx);
  assert.equal(ok.total, 1650);
});

test('preparar_cotizacion sin cliente registrado lo crea por teléfono', async () => {
  const NEW = '18095550222';
  const c = { phone: NEW, client: null, botUserId, now: OPEN };
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.copia }] }, c);
  assert.equal(r.total, 700);
  const row = (await pool.query('SELECT * FROM clients WHERE phone=$1', [NEW])).rows[0];
  assert.ok(row); assert.equal(row.name, NEW); assert.equal(row.source, 'whatsapp');
  assert.equal(c.client.id, row.id);
  const inv = (await pool.query('SELECT * FROM invoices')).rows[0];
  assert.equal(inv.client_id, row.id);
});

test('un aviso urgente llega al asignado y también a cada admin activo', async () => {
  await pool.query('UPDATE clients SET assigned_to=$1', [digId]);
  ctx.client.assigned_to = digId;
  await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: CLOSED, lastText: 'es urgente' });
  const ids1 = (await notifs('handoff')).map((x) => x.user_id).sort((a, b) => a - b);
  assert.deepEqual(ids1, [adminId, digId].sort((a, b) => a - b));
  // Después del traspaso (no urgente: solo al asignado), un "urgente" avisa a los dos.
  await pool.query('DELETE FROM notifications');
  await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: CLOSED, lastText: 'hola' });
  assert.deepEqual((await notifs('handoff')).map((x) => x.user_id), [digId]);
  assert.equal(await notifyUrgentAfterHandoff(PHONE, 'urgente', CLOSED), true);
  const urgent = (await notifs('handoff')).filter((n) => n.title.startsWith('🚨 URGENTE ')).map((x) => x.user_id).sort((a, b) => a - b);
  assert.deepEqual(urgent, [adminId, digId].sort((a, b) => a - b));
});

test('dos "urgente" a la vez avisan una sola vez', async () => {
  await pasar_a_humano({ motivo: 'x' }, { ...ctx, now: CLOSED, lastText: 'hola' });
  const before = (await notifs('handoff')).length;
  const r = await Promise.all([notifyUrgentAfterHandoff(PHONE, 'urgente', CLOSED), notifyUrgentAfterHandoff(PHONE, 'urgente', CLOSED)]);
  assert.deepEqual(r.sort(), [false, true]);
  assert.equal((await notifs('handoff')).length, before + 1);
  const st = (await pool.query(`SELECT value FROM wa_bot_state WHERE key=$1`, [`handoff:${PHONE}`])).rows[0].value;
  assert.equal(st.urgente_avisado, true); assert.equal(st.motivo, 'x');
});
