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
  await runSqlFile('migrations/20261009_precios_leandro_1.sql');
  await runSqlFile('migrations/20261017_reglas_atencion.sql');
  await runSqlFile('migrations/20261018_partidas_por_confirmar.sql');
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
  ids.foja = (await pool.query(`INSERT INTO service_catalog (name, category_id, digitacion_price, price_tiers, foja_tipo, fojas) VALUES ('Carta Legal Simple',1,100,'[]','legal_simple',2) RETURNING id`)).rows[0].id;
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
  assert.ok(n.length >= 1); assert.equal(n[0].link, `/cotizaciones?invoice=${inv.id}`);
  assert.ok(n.every((x) => x.user_id !== digId));
});

test('un servicio que no existe sigue siendo error y no crea nada', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.copia }, { servicio_id: 99999 }] }, ctx);
  assert.equal(r.error, 'hay partidas sin precio confirmado');
  assert.deepEqual(r.sin_precio, ['99999']);
  assert.equal((await pool.query('SELECT count(*)::int c FROM invoices')).rows[0].c, 0);
});

// ---------- partidas por confirmar ----------

async function extraServices() {
  await pool.query(`INSERT INTO service_categories (id, name) VALUES (2, 'Traducción'), (3, 'Modificación de un Documento') ON CONFLICT DO NOTHING`);
  const ins = async (name, cat, cols) => (await pool.query(
    `INSERT INTO service_catalog (name, category_id, digitacion_price, precio_rango, foja_tipo, fojas, por_confirmar, price_tiers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'[]') RETURNING id`,
    [name, cat, cols.dig ?? null, cols.rango ? JSON.stringify(cols.rango) : null, cols.foja || null, cols.fojas || null, !!cols.pc])).rows[0].id;
  return {
    apostilla: await ins('Apostilla en Cancillería', 1, { rango: { min: 250, max: 300 } }),
    trad: await ins('Traducción - Acta Natal', 2, { dig: 700 }),
    modif: await ins('Modificación de Documento Existente', 3, { dig: 100, foja: 'modificacion', fojas: 1 }),
  };
}

test('con partidas por confirmar la cotización se crea igual: líneas sin precio, total solo de lo confirmado', async () => {
  const x = await extraServices();
  const r = await preparar_cotizacion({ partidas: [
    { servicio_id: ids.copia }, { servicio_id: x.apostilla, cantidad: 2 }, { servicio_id: ids.conf }, { servicio_id: ids.cero },
  ] }, ctx);
  assert.equal(r.error, undefined);
  assert.equal(r.total, 700);
  const inv = (await pool.query('SELECT * FROM invoices')).rows[0];
  assert.equal(Number(inv.total), 700);
  const [copia, apo, conf, cero] = inv.items;
  assert.equal(copia.precio, 700); assert.equal(copia.por_confirmar, undefined);
  assert.deepEqual({ ...apo, desc: undefined }, { desc: undefined, cantidad: 2, precio: null, por_confirmar: true,
    rango: { min: 250, max: 300 }, precio_sugerido: null, nota: 'Precio dentro del rango: lo confirma el digitador' });
  assert.equal(conf.precio, null); assert.equal(conf.precio_sugerido, 1000); assert.equal(conf.nota, 'Precio por confirmar: lo confirma el digitador');
  assert.equal(cero.por_confirmar, true);
  assert.deepEqual(r.por_confirmar.map((p) => p.rango), [{ min: 250, max: 300 }, null, null]);
  assert.equal(r.por_confirmar[1].precio_sugerido, 1000);
});

test('una traducción siempre queda por confirmar con su precio como sugerido', async () => {
  const x = await extraServices();
  await preparar_cotizacion({ partidas: [{ servicio_id: x.trad }] }, ctx);
  const line = (await pool.query('SELECT items FROM invoices')).rows[0].items[0];
  assert.equal(line.precio, null); assert.equal(line.por_confirmar, true); assert.equal(line.precio_sugerido, 700);
  assert.equal(line.nota, 'Individual o en conjunto (una sola firma): lo confirma el digitador');
});

test('modificación de 3 fojas queda como rango por confirmar; de 2 fojas tiene precio', async () => {
  const x = await extraServices();
  await preparar_cotizacion({ partidas: [{ servicio_id: x.modif, fojas: 3 }, { servicio_id: x.modif, fojas: 2 }] }, ctx);
  const [tres, dos] = (await pool.query('SELECT items FROM invoices')).rows[0].items;
  assert.deepEqual(tres.rango, { min: 300, max: 450 }); assert.equal(tres.precio, null);
  assert.equal(tres.nota, 'Modificación de 3 fojas o más: lo confirma el digitador dentro del rango');
  assert.equal(dos.precio, 300);
});

test('con precios por confirmar avisa al asignado (o a los admins) con 💲 y el enlace a la cotización', async () => {
  const x = await extraServices();
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: x.apostilla }] }, ctx);
  let n = await notifs('invoice');
  assert.deepEqual(n.map((m) => m.user_id), [adminId]);
  assert.equal(n[0].title, '💲 Cotización con precios por confirmar');
  assert.equal(n[0].link, `/cotizaciones?invoice=${r.invoice_id}`);
  await pool.query('DELETE FROM notifications');
  await pool.query('UPDATE clients SET assigned_to=$1', [digId]);
  ctx.client.assigned_to = digId;
  await preparar_cotizacion({ partidas: [{ servicio_id: x.apostilla }] }, ctx);
  n = await notifs('invoice');
  assert.deepEqual(n.map((m) => m.user_id), [digId]);
});

test('cantidad multiplica el precio unitario', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.copia, cantidad: 3 }] }, ctx);
  assert.equal(r.total, 2100);
});

test('pasar_a_humano pone el chat en manual, avisa y devuelve el mensaje de espera exacto', async () => {
  const r = await pasar_a_humano({ motivo: 'reclamación' }, ctx);
  assert.equal(r.urgente, false);
  assert.equal(r.mensaje, "Un Gurú de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo 'urgente'.");
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

test('una partida en RD$0 queda por confirmar (nunca se cotiza en cero)', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.copia }, { servicio_id: ids.cero }] }, ctx);
  assert.equal(r.error, undefined);
  const line = (await pool.query('SELECT items FROM invoices')).rows[0].items[1];
  assert.equal(line.precio, null); assert.equal(line.por_confirmar, true);
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

test('preparar_cotizacion: partida por foja lleva (N fojas) y los duplicados van en su propia línea', async () => {
  const r = await preparar_cotizacion({ partidas: [{ servicio_id: ids.foja, fojas: 3, duplicados: 2 }] }, ctx);
  assert.equal(r.error, undefined);
  const inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [r.invoice_id])).rows[0];
  assert.equal(inv.items.length, 2);
  assert.match(inv.items[0].desc, /\(3 fojas\)$/);
  assert.equal(inv.items[0].precio, 750);
  assert.equal(inv.items[1].desc, 'Original adicional o duplicado');
  assert.equal(inv.items[1].cantidad, 2);
  assert.equal(inv.items[1].precio, 700);
  assert.equal(Number(inv.total), 750 + 1400);
  assert.equal(r.total, 2150);
});

test('destino admin: avisa solo a los admins aunque el cliente tenga asignado', async () => {
  await pool.query('UPDATE clients SET assigned_to=$1', [digId]);
  ctx.client.assigned_to = digId;
  await pasar_a_humano({ motivo: 'reclamo de precio', destino: 'admin' }, ctx);
  assert.deepEqual((await notifs('handoff')).map((x) => x.user_id), [adminId]);
  assert.equal(handler.isManualMode(PHONE), true);
});

test('destino digitador (o sin destino): el asignado; sin asignado, los admins', async () => {
  await pasar_a_humano({ motivo: 'error en el contrato', destino: 'digitador' }, ctx);
  assert.deepEqual((await notifs('handoff')).map((x) => x.user_id), [adminId]);
  await pool.query('DELETE FROM notifications');
  await pool.query('UPDATE clients SET assigned_to=$1', [digId]);
  ctx.client.assigned_to = digId;
  await pasar_a_humano({ motivo: 'estado de mi certificación', destino: 'digitador' }, ctx);
  assert.deepEqual((await notifs('handoff')).map((x) => x.user_id), [digId]);
});

test('el mensaje de espera dice "Un Gurú", y en inglés devuelve la versión en inglés', async () => {
  const es = await pasar_a_humano({ motivo: 'x' }, ctx);
  assert.match(es.mensaje, /^Un Gurú de nuestro equipo/);
  assert.doesNotMatch(es.mensaje, /abogado/i);
  const en = await pasar_a_humano({ motivo: 'x', idioma: 'en' }, ctx);
  assert.match(en.mensaje, /^A Gurú from our team will contact you shortly/);
  assert.match(en.mensaje, /writing 'urgent'/);
});
