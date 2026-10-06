process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const fs = require('fs');
const path = require('path');
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS, runTool } = require('../src/agent/tools');
const { buildContext } = require('../src/agent/context');
const { maybeSummarize } = require('../src/agent/memory');
const { createFakeProvider } = require('../src/agent/provider');
const { clearCache } = require('../src/agent/businessInfo');

const PHONE = '18095550123';
// 2026-10-05 es lunes; 15:00Z = 11:00 en Santo Domingo (abierto). 2026-10-10 es sábado.
const MONDAY = new Date('2026-10-05T15:00:00Z');
const SATURDAY = new Date('2026-10-10T16:00:00Z');
let clientId, ctx, botUserId, actoId;

const GUIDE = path.join(__dirname, '..', 'src', 'agent', 'guide.md');

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS wa_bot_state, notifications, bot_tool_log, bot_memory, business_info, tramites, invoices,
    service_catalog, service_categories, legal_profiles, client_media, messages, cases, clients CASCADE`);
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE, name VARCHAR(255), assigned_to INT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await pool.query(`CREATE TABLE service_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, category_id INT, digitacion_price NUMERIC,
    notarizacion_price NUMERIC, price_tiers JSONB DEFAULT '[]', unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY)`);
  await pool.query(`CREATE TABLE cases (id SERIAL PRIMARY KEY, case_number TEXT, title TEXT, description TEXT, status TEXT DEFAULT 'new',
    case_type TEXT, client_id INT, user_id INT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), source TEXT, service_id INT)`);
  await pool.query(`CREATE TABLE messages (id SERIAL PRIMARY KEY, wa_message_id VARCHAR(255), phone VARCHAR(20), client_id INT, case_id INT,
    direction VARCHAR(10) NOT NULL, content TEXT NOT NULL, media_url TEXT, status VARCHAR(20) DEFAULT 'sent', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE client_media (id SERIAL PRIMARY KEY, phone VARCHAR(20) NOT NULL, client_id INT, wa_message_id VARCHAR(255),
    media_type VARCHAR(20) NOT NULL, mime_type VARCHAR(100), file_path TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL, link TEXT, read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query('CREATE TABLE wa_bot_state (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)');
  await runSqlFile('migrations/20261005_bot_agent.sql');
  clearCache();
  botUserId = (await pool.query(`SELECT id FROM users WHERE username='bot'`)).rows[0].id;
  await pool.query(`INSERT INTO service_categories (id, name) VALUES (1, 'Actos de venta')`);
  actoId = (await pool.query(`INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, alias)
    VALUES ('Acto de Venta', 1, 500, 300, '{"traspaso"}') RETURNING id`)).rows[0].id;
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Ana Cliente') RETURNING id`, [PHONE])).rows[0].id;
  const client = (await pool.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
  ctx = { phone: PHONE, client, botUserId, now: MONDAY, lastText: '', toolLogIds: [] };
});
test.after(async () => { await pool.end(); });

const logs = async () => (await pool.query('SELECT * FROM bot_tool_log ORDER BY id')).rows;
const seedMessages = async (n, { minutesAgo = 120, step = 1 } = {}) => {
  for (let i = 0; i < n; i++) {
    const dir = i % 2 === 0 ? 'inbound' : 'outbound';
    const at = new Date(MONDAY.getTime() - (minutesAgo - i * step) * 60 * 1000);
    await pool.query(`INSERT INTO messages (phone, client_id, direction, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [PHONE, clientId, dir, `mensaje ${i + 1}`, at]);
  }
};

// ---------- guía ----------

test('la guía no contiene montos en pesos', () => {
  const g = fs.readFileSync(GUIDE, 'utf8');
  assert.equal(/RD\$\s?\d|\d[\d,.]*\s*pesos/i.test(g), false);
});

test('la guía trae las reglas clave: usted, calcular_precio antes de cotizar, 30%, notario, 24 h', () => {
  const g = fs.readFileSync(GUIDE, 'utf8');
  for (const needle of ['usted', 'calcular_precio', 'pasar_a_humano', 'guardar_datos_cliente', 'ver_tramite', 'preparar_cotizacion',
    '30%', 'notario', 'MIREX', 'Procuraduría', '24 h', '48 h', '🦉', 'se lo confirmo']) {
    assert.ok(g.includes(needle), `falta "${needle}" en la guía`);
  }
  assert.doesNotMatch(g, /\btú\b|\btu\b/i);
});

// ---------- registro de herramientas ----------

test('hay exactamente 9 herramientas con los nombres del spec', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['buscar_servicio', 'calcular_precio', 'crear_solicitud', 'estado_solicitud',
    'guardar_datos_cliente', 'leer_documento', 'pasar_a_humano', 'preparar_cotizacion', 'ver_tramite']);
});

test('cada herramienta tiene descripción en español y parámetros JSON Schema en minúsculas', () => {
  for (const t of TOOLS) {
    assert.ok(t.description.length > 40, `${t.name}: descripción muy corta`);
    assert.equal(t.parameters.type, 'object');
    assert.equal(typeof t.parameters.properties, 'object');
    assert.ok(Array.isArray(t.parameters.required));
    for (const [k, p] of Object.entries(t.parameters.properties)) {
      assert.match(p.type, /^[a-z]+$/, `${t.name}.${k}: el tipo debe ir en minúsculas`);
      assert.ok(p.description, `${t.name}.${k}: sin descripción`);
    }
  }
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.deepEqual(byName.buscar_servicio.parameters.required, ['consulta']);
  assert.deepEqual(byName.calcular_precio.parameters.required, ['servicio_id']);
  assert.deepEqual(byName.preparar_cotizacion.parameters.required, ['partidas']);
  assert.match(byName.calcular_precio.description, /antes de dar cualquier precio/i);
  assert.match(byName.pasar_a_humano.description, /persona/i);
});

test('runTool con nombre desconocido devuelve error y lo registra', async () => {
  const r = await runTool('volar', { a: 1 }, ctx);
  assert.deepEqual(r, { error: 'herramienta desconocida: volar' });
  const l = await logs();
  assert.equal(l.length, 1);
  assert.equal(l[0].herramienta, 'volar');
  assert.equal(l[0].ok, false);
  assert.equal(l[0].phone, PHONE);
  assert.equal(l[0].message_id, null);
  assert.deepEqual(ctx.toolLogIds, [l[0].id]);
});

test('runTool sin un argumento requerido devuelve "faltan datos"', async () => {
  const r = await runTool('calcular_precio', { valor_del_bien: 100 }, ctx);
  assert.deepEqual(r, { error: 'faltan datos: servicio_id' });
  const r2 = await runTool('buscar_servicio', undefined, ctx);
  assert.deepEqual(r2, { error: 'faltan datos: consulta' });
  const l = await logs();
  assert.equal(l.length, 2);
  assert.ok(l.every((x) => x.ok === false));
});

test('runTool registra cada llamada en bot_tool_log con args, resultado, ok y ms', async () => {
  const r = await runTool('buscar_servicio', { consulta: 'traspaso' }, ctx);
  assert.equal(r.resultados[0].nombre, 'Acto de Venta');
  const r2 = await runTool('calcular_precio', { servicio_id: actoId }, ctx);
  assert.equal(r2.total, 800);
  const r3 = await runTool('calcular_precio', { servicio_id: 99999 }, ctx);
  assert.equal(r3.error, 'servicio no encontrado');
  const l = await logs();
  assert.deepEqual(l.map((x) => [x.herramienta, x.ok]), [['buscar_servicio', true], ['calcular_precio', true], ['calcular_precio', false]]);
  assert.deepEqual(l[0].args, { consulta: 'traspaso' });
  assert.equal(l[0].resultado.resultados[0].nombre, 'Acto de Venta');
  assert.equal(l[1].resultado.total, 800);
  assert.ok(l.every((x) => Number.isInteger(x.ms) && x.ms >= 0));
  assert.deepEqual(ctx.toolLogIds, l.map((x) => x.id));
});

test('si la herramienta lanza, runTool devuelve "no se pudo completar" y lo registra', async () => {
  await pool.query('DROP TABLE service_catalog CASCADE');
  const r = await runTool('buscar_servicio', { consulta: 'traspaso' }, ctx);
  assert.deepEqual(r, { error: 'no se pudo completar' });
  const l = await logs();
  assert.equal(l.length, 1);
  assert.equal(l[0].ok, false);
  assert.equal(l[0].resultado.error, 'no se pudo completar');
});

test('runTool funciona sin toolLogIds en el ctx', async () => {
  const r = await runTool('estado_solicitud', {}, { phone: PHONE, client: ctx.client, botUserId, now: MONDAY });
  assert.deepEqual(r, { solicitudes: [] });
  assert.equal((await logs()).length, 1);
});

// ---------- contexto ----------

test('buildContext trae solo los últimos 30 mensajes, en orden', async () => {
  await seedMessages(35);
  const { messages } = await buildContext({ phone: PHONE, client: ctx.client, now: MONDAY });
  assert.equal(messages.length, 30);
  assert.deepEqual(messages[0], { role: 'assistant', text: 'mensaje 6' });
  assert.deepEqual(messages[1], { role: 'user', text: 'mensaje 7' });
  assert.deepEqual(messages[29], { role: 'user', text: 'mensaje 35' });
  assert.ok(messages.every((m) => ['user', 'assistant'].includes(m.role)));
});

test('buildContext incluye la ficha y el resumen, pero no HISTORIAL', async () => {
  await pool.query(`INSERT INTO legal_profiles (client_id, data) VALUES ($1, $2)`, [clientId, JSON.stringify({
    NOMBRE: 'Ana Cliente', 'ESTADO CIVIL': 'casada', PROFESION: 'contadora',
    HISTORIAL: [{ clave: 'ESTADO CIVIL', antes: 'soltera', fecha: '2026-09-01' }],
  })]);
  await pool.query(`INSERT INTO cases (case_number, title, status, client_id) VALUES ('CASO-1', 'Acto de Venta — Ana Cliente', 'in_progress', $1),
    ('CASO-2', 'Poder — Ana Cliente', 'completed', $1)`, [clientId]);
  await pool.query(`INSERT INTO bot_memory (client_id, resumen, hasta_mensaje_id) VALUES ($1, 'Pidió un acto de venta; quedó en mandar la matrícula.', 3)`, [clientId]);
  const { system } = await buildContext({ phone: PHONE, client: ctx.client, now: MONDAY });
  assert.ok(system.includes('Ana Cliente'));
  assert.ok(system.includes('ESTADO CIVIL: casada'));
  assert.ok(system.includes('PROFESION: contadora'));
  assert.ok(!system.includes('HISTORIAL'));
  assert.ok(!system.includes('soltera'));
  assert.ok(system.includes('CASO-1'));
  assert.ok(system.includes('Acto de Venta — Ana Cliente'));
  assert.ok(!system.includes('CASO-2'));
  assert.ok(system.includes('quedó en mandar la matrícula'));
});

test('buildContext trae la guía, los datos del negocio y los temas que van a una persona', async () => {
  const { system } = await buildContext({ phone: PHONE, client: ctx.client, now: MONDAY });
  assert.ok(system.includes(fs.readFileSync(GUIDE, 'utf8').trim()));
  assert.ok(system.includes('Av. Independencia 1607'));
  assert.ok(system.includes('transferencia o efectivo'));
  assert.ok(system.includes('reclamaciones'));
  assert.ok(!/RD\$\s?\d/.test(system));
});

test('buildContext dice "cerrado" un sábado y "abierto" un lunes a las 11', async () => {
  const sat = await buildContext({ phone: PHONE, client: ctx.client, now: SATURDAY });
  assert.match(sat.system, /Ahora: sábado, 10 de octubre de 2026, 12:00 \(cerrado\)/);
  const mon = await buildContext({ phone: PHONE, client: ctx.client, now: MONDAY });
  assert.match(mon.system, /Ahora: lunes, 5 de octubre de 2026, 11:00 \(abierto\)/);
});

test('buildContext con un cliente nuevo sin ficha no se cae', async () => {
  const { system, messages } = await buildContext({ phone: '18090000000', client: null, now: MONDAY });
  assert.equal(messages.length, 0);
  assert.ok(system.includes('Cliente nuevo'));
});

// ---------- memoria ----------

test('maybeSummarize guarda el resumen cuando la conversación anterior quedó quieta 30 min', async () => {
  await seedMessages(4, { minutesAgo: 120 });
  const p = createFakeProvider([{ text: 'Pidió un acto de venta.\nQuedó pendiente la matrícula.' }]);
  assert.equal(await maybeSummarize({ phone: PHONE, client: ctx.client, provider: p, now: MONDAY }), true);
  const m = (await pool.query('SELECT * FROM bot_memory WHERE client_id=$1', [clientId])).rows[0];
  assert.equal(m.resumen, 'Pidió un acto de venta.\nQuedó pendiente la matrícula.');
  const lastId = (await pool.query('SELECT max(id)::int m FROM messages')).rows[0].m;
  assert.equal(m.hasta_mensaje_id, lastId);
  assert.equal(p.calls.length, 1);
  assert.match(p.calls[0].system, /^Resume en español/);
  assert.deepEqual(p.calls[0].tools, []);
  assert.ok(p.calls[0].messages[0].text.includes('mensaje 4'));
});

test('maybeSummarize no hace nada si la conversación es reciente o no hay mensajes nuevos', async () => {
  await seedMessages(4, { minutesAgo: 5 });
  const p = createFakeProvider([{ text: 'x' }]);
  assert.equal(await maybeSummarize({ phone: PHONE, client: ctx.client, provider: p, now: MONDAY }), false);
  assert.equal(p.calls.length, 0);
  await pool.query('DELETE FROM messages');
  await seedMessages(4, { minutesAgo: 120 });
  const lastId = (await pool.query('SELECT max(id)::int m FROM messages')).rows[0].m;
  await pool.query(`INSERT INTO bot_memory (client_id, resumen, hasta_mensaje_id) VALUES ($1, 'ya', $2)`, [clientId, lastId]);
  assert.equal(await maybeSummarize({ phone: PHONE, client: ctx.client, provider: p, now: MONDAY }), false);
  assert.equal(p.calls.length, 0);
});

test('maybeSummarize ignora el mensaje del turno actual y agrega al resumen anterior', async () => {
  await seedMessages(4, { minutesAgo: 120 });
  const oldLast = (await pool.query('SELECT max(id)::int m FROM messages')).rows[0].m;
  await pool.query(`INSERT INTO bot_memory (client_id, resumen, hasta_mensaje_id) VALUES ($1, 'Resumen viejo.', $2)`, [clientId, oldLast - 2]);
  await pool.query(`INSERT INTO messages (phone, client_id, direction, content, created_at) VALUES ($1, $2, 'inbound', 'hola otra vez', $3)`,
    [PHONE, clientId, new Date(MONDAY.getTime() - 10 * 1000)]);
  const p = createFakeProvider([{ text: 'Resumen nuevo.' }]);
  assert.equal(await maybeSummarize({ phone: PHONE, client: ctx.client, provider: p, now: MONDAY }), true);
  const m = (await pool.query('SELECT * FROM bot_memory WHERE client_id=$1', [clientId])).rows[0];
  assert.equal(m.resumen, 'Resumen nuevo.');
  assert.equal(m.hasta_mensaje_id, oldLast);
  const sent = p.calls[0].messages[0].text;
  assert.ok(sent.includes('Resumen viejo.'));
  assert.ok(sent.includes('mensaje 3') && sent.includes('mensaje 4'));
  assert.ok(!sent.includes('mensaje 1'));
  assert.ok(!sent.includes('hola otra vez'));
});

test('maybeSummarize nunca lanza: proveedor roto o sin cliente', async () => {
  await seedMessages(2, { minutesAgo: 120 });
  const broken = { name: 'fake', async chat() { throw new Error('boom'); } };
  assert.equal(await maybeSummarize({ phone: PHONE, client: ctx.client, provider: broken, now: MONDAY }), false);
  assert.equal((await pool.query('SELECT count(*)::int c FROM bot_memory')).rows[0].c, 0);
  assert.equal(await maybeSummarize({ phone: PHONE, client: null, provider: createFakeProvider([{ text: 'x' }]), now: MONDAY }), false);
});

test('el resumen guardado no conserva cédulas ni montos aunque el modelo los escriba', async () => {
  await seedMessages(2, { minutesAgo: 120 });
  const p = createFakeProvider([{ text: 'Cliente con cédula 001-1234567-8 pidió un poder por RD$1,500.' }]);
  await maybeSummarize({ phone: PHONE, client: ctx.client, provider: p, now: MONDAY });
  const m = (await pool.query('SELECT resumen FROM bot_memory WHERE client_id=$1', [clientId])).rows[0];
  assert.ok(!m.resumen.includes('001-1234567-8'));
  assert.ok(!/RD\$\s?\d/.test(m.resumen));
  assert.ok(m.resumen.includes('pidió un poder'));
});
