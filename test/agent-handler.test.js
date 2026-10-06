// El agente conectado a WhatsApp: qué chats van al agente, el aviso de "urgente" después de un traspaso,
// el estado del traspaso al devolver un chat al bot y las herramientas de cada respuesta en la API de Mensajes.
process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
process.env.BOT_AI_PROVIDER = 'fake';
const { pool } = require('./helpers/db');
const { createAgentSchema, createUser, seedCatalog } = require('./helpers/agentDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { generateToken } = require('../src/middleware/auth');
const { createFakeProvider, setFakeProvider } = require('../src/agent/provider');
const { clearCache } = require('../src/agent/businessInfo');
const { _resetBotUserCache } = require('../src/agent/agent');
const { pasar_a_humano } = require('../src/agent/tools/handoff');
const { engineFor } = require('../src/agent/engine');
const handler = require('../src/whatsapp/handler');

const AGENT = '18095550177';
const LEGACY = '18095550266';
const jid = (p) => `${p}@s.whatsapp.net`;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

let ids, adminId, clientIds = {}, server, base, tok;
let sent, fetchCalls;
const originalFetch = global.fetch;
const sock = { sendMessage: async (to, content) => { sent.push({ to, text: content.text }); return { key: { id: `out-${sent.length}` } }; } };

// Un proveedor que nunca debe ser llamado (chats legacy, chats en manual).
const untouchable = () => ({ name: 'fake', calls: [], async chat() { throw new Error('el modelo no debía llamarse'); } });

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/messages', require('../src/routes/messages'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await createAgentSchema();
  // Como en producción: el índice que usa Message.create para deduplicar, y la tabla de sesiones del motor viejo.
  await pool.query(`CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL`);
  await pool.query(`DROP TABLE IF EXISTS conversation_sessions`);
  await pool.query(`CREATE TABLE conversation_sessions (id SERIAL PRIMARY KEY, phone VARCHAR(20) NOT NULL, client_id INT,
    flow VARCHAR(50) NOT NULL DEFAULT 'main_menu', step VARCHAR(50) NOT NULL DEFAULT 'init', data JSONB DEFAULT '{}', active BOOLEAN DEFAULT true,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 minutes'), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  clearCache();
  _resetBotUserCache();
  adminId = await createUser('adm', 'admin', 'Admin Uno');
  tok = generateToken({ id: adminId, username: 'adm', email: 'adm@t.co', role: 'admin' });
  ids = await seedCatalog();
  for (const [k, p] of [['agent', AGENT], ['legacy', LEGACY]]) {
    clientIds[k] = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, $2) RETURNING id`, [p, `Cliente ${k}`])).rows[0].id;
  }
  process.env.BOT_ENGINE = 'legacy';
  process.env.BOT_AGENT_PHONES = AGENT;
  handler.setBotMode('all');
  handler.setManualMode(AGENT, false);
  handler.setManualMode(LEGACY, false);
  handler._setAIRetryDelayMs(null);
  sent = [];
  fetchCalls = [];
  // La detección de reclamaciones por HTTP: se registra la llamada, no hay servidor.
  global.fetch = async (url, opts) => { fetchCalls.push({ url: String(url), opts }); return new Response('{}', { status: 500 }); };
  setFakeProvider(untouchable());
});
test.afterEach(() => { global.fetch = originalFetch; });
test.after(async () => { server.close(); await pool.end(); });

const inbound = async (phone, text) => (await pool.query(
  `INSERT INTO messages (phone, client_id, direction, content, wa_message_id) VALUES ($1, $2, 'inbound', $3, $4) RETURNING id`,
  [phone, clientIds[phone === AGENT ? 'agent' : 'legacy'], text, `in-${Date.now()}-${Math.random()}`])).rows[0].id;
const batch = (phone, text, willRespond = true, savedMedia = null) =>
  [{ msg: { key: { remoteJid: jid(phone) }, messageTimestamp: Math.floor(Date.now() / 1000) }, text, savedMedia, willRespond }];
const outbound = async (phone) => (await pool.query(`SELECT * FROM messages WHERE phone=$1 AND direction='outbound' ORDER BY id`, [phone])).rows;
const logs = async () => (await pool.query('SELECT * FROM bot_tool_log ORDER BY id')).rows;
const notifs = async (type) => (await pool.query('SELECT * FROM notifications WHERE type=$1 ORDER BY id', [type])).rows;
const handoffRows = async () => (await pool.query(`SELECT key FROM wa_bot_state WHERE key LIKE 'handoff:%' ORDER BY key`)).rows.map((r) => r.key);
const closeBusiness = async () => {
  await pool.query(`UPDATE business_info SET valor = '{"dias":[],"abre":"09:00","cierra":"18:00","zona":"America/Santo_Domingo"}'::jsonb WHERE clave = 'horario'`);
  clearCache();
};

// ---------- engineFor ----------

test('engineFor: un teléfono en BOT_AGENT_PHONES usa el agente aunque BOT_ENGINE sea legacy', () => {
  process.env.BOT_ENGINE = 'legacy';
  process.env.BOT_AGENT_PHONES = ' 18095550177 , +1 (809) 555-0300@s.whatsapp.net,,';
  assert.equal(engineFor('18095550177'), 'agent');
  assert.equal(engineFor('18095550177@s.whatsapp.net'), 'agent');
  assert.equal(engineFor('18095550177@lid'), 'agent');
  assert.equal(engineFor('18095550300'), 'agent');
  assert.equal(engineFor('18095550301'), 'legacy');
});

test('engineFor: por defecto todos usan el agente; BOT_ENGINE=legacy es el interruptor para volver al bot viejo', () => {
  delete process.env.BOT_ENGINE;
  delete process.env.BOT_AGENT_PHONES;
  assert.equal(engineFor('18095550177'), 'agent');
  assert.equal(engineFor('18095550999@s.whatsapp.net'), 'agent');
  process.env.BOT_ENGINE = 'legacy';
  assert.equal(engineFor('18095550999'), 'legacy');
  process.env.BOT_ENGINE = 'agent';
  assert.equal(engineFor('18095550999'), 'agent');
});

// ---------- processBatch ----------

test('un lote de un chat con agente se responde con el agente, se envía y se liga a sus herramientas', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'buscar_servicio', args: { consulta: 'acto de venta vehiculo' } }] },
    { toolCalls: [{ id: '2', name: 'calcular_precio', args: { servicio_id: ids.acto, valor_del_bien: 500000 } }] },
    { text: 'El acto de venta le sale en RD$950 🦉' }]);
  setFakeProvider(p);
  await inbound(AGENT, 'cuanto es un acto de venta de un carro de 500 mil');
  await handler.processBatch(AGENT, batch(AGENT, 'cuanto es un acto de venta de un carro de 500 mil'), sock);

  assert.deepEqual(sent, [{ to: jid(AGENT), text: 'El acto de venta le sale en RD$950 🦉' }]);
  const out = await outbound(AGENT);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'El acto de venta le sale en RD$950 🦉');
  assert.equal(out[0].client_id, clientIds.agent);
  const l = await logs();
  assert.deepEqual(l.map((x) => [x.herramienta, x.ok, x.message_id]), [['buscar_servicio', true, out[0].id], ['calcular_precio', true, out[0].id]]);
  assert.equal(p.calls.length, 3);
  // El agente decide cuándo pasar a una persona: no corre la detección de reclamaciones por HTTP ni el motor viejo.
  assert.deepEqual(fetchCalls, []);
  assert.equal((await pool.query('SELECT count(*)::int c FROM conversation_sessions')).rows[0].c, 0);
});

test('un lote con solo medios se responde con el agente y el texto de la foto', async () => {
  const p = createFakeProvider([(messages) => ({ text: `Vi: ${messages[messages.length - 1].text}` })]);
  setFakeProvider(p);
  const media = { id: 7, media_type: 'image', analysis: 'Cédula de Ana' };
  await handler.processBatch(AGENT, batch(AGENT, '', true, media), sock);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\[Foto\/Documento enviado, id 7\]: Cédula de Ana/);
});

test('un chat legacy sigue yendo a routeMessage', async () => {
  await inbound(LEGACY, 'hola');
  await handler.processBatch(LEGACY, batch(LEGACY, 'hola'), sock);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, jid(LEGACY));
  assert.ok(sent[0].text.length > 0); // el saludo del motor viejo (sin modelo: texto fijo)
  const out = await outbound(LEGACY);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, sent[0].text);
  // El motor viejo abrió su sesión y corrió la detección de reclamaciones como siempre.
  assert.equal((await pool.query('SELECT count(*)::int c FROM conversation_sessions')).rows[0].c, 1);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/cases\/detect-and-create$/);
  assert.equal((await logs()).length, 0);
});

test('si el lote no debe responderse, el agente no corre y no se manda nada', async () => {
  await handler.processBatch(AGENT, batch(AGENT, 'hola', false), sock);
  assert.deepEqual(sent, []);
  assert.deepEqual(await outbound(AGENT), []);
});

test('chat en manual después de un traspaso: "urgente" fuera de horario avisa al admin una vez y el bot no responde', async () => {
  await closeBusiness();
  // El agente pasó el chat a una persona (como lo haría la herramienta en un turno anterior).
  const client = (await pool.query('SELECT * FROM clients WHERE phone=$1', [AGENT])).rows[0];
  const botUserId = (await pool.query(`SELECT id FROM users WHERE username='bot'`)).rows[0].id;
  await pasar_a_humano({ motivo: 'reclamación' }, { phone: AGENT, client, botUserId, now: new Date(), lastText: 'tengo una queja' });
  assert.equal(handler.isManualMode(AGENT), true);
  const before = (await notifs('handoff')).length;

  await handler.processBatch(AGENT, batch(AGENT, 'Es URGENTE por favor', false), sock);
  let n = await notifs('handoff');
  assert.equal(n.length, before + 1);
  assert.match(n[n.length - 1].title, /^🚨 URGENTE /);
  assert.deepEqual(sent, []);
  assert.deepEqual(await outbound(AGENT), []);

  // Un segundo "urgente" no repite el aviso.
  await handler.processBatch(AGENT, batch(AGENT, 'urgente!!', false), sock);
  assert.equal((await notifs('handoff')).length, before + 1);
  assert.deepEqual(sent, []);
});

test('un "urgente" viejo (ráfaga tras reconectar) no avisa', async () => {
  await closeBusiness();
  const client = (await pool.query('SELECT * FROM clients WHERE phone=$1', [AGENT])).rows[0];
  const botUserId = (await pool.query(`SELECT id FROM users WHERE username='bot'`)).rows[0].id;
  await pasar_a_humano({ motivo: 'x' }, { phone: AGENT, client, botUserId, now: new Date(), lastText: 'hola' });
  const before = (await notifs('handoff')).length;
  const stale = batch(AGENT, 'urgente', false).map((b) => ({ ...b, isStale: true }));
  await handler.processBatch(AGENT, stale, sock);
  assert.equal((await notifs('handoff')).length, before);
  await handler.processBatch(AGENT, [...stale, ...batch(AGENT, 'urgente', false)], sock); // uno fresco en el lote: sí
  assert.equal((await notifs('handoff')).length, before + 1);
});

test('un chat en manual sin traspaso del bot no avisa, y un fallo del aviso no rompe el lote', async () => {
  await closeBusiness();
  handler.setManualMode(LEGACY, true);
  await handler.processBatch(LEGACY, batch(LEGACY, 'urgente', false), sock);
  assert.equal((await notifs('handoff')).length, 0);
  // Sin la tabla de estado el aviso falla; el lote sigue sin lanzar.
  await pool.query('DROP TABLE wa_bot_state');
  await handler.processBatch(LEGACY, batch(LEGACY, 'urgente', false), sock);
  assert.deepEqual(sent, []);
});

test('sin cuota el agente difiere el lote y el reintento responde con el agente', async () => {
  handler._setAIRetryDelayMs(50);
  let calls = 0;
  setFakeProvider({ name: 'fake', async chat() { calls++; if (calls === 1) { const e = new Error('x'); e.code = 'QUOTA'; throw e; } return { text: 'Ya con cuota', toolCalls: [] }; } });
  await handler.processBatch(AGENT, batch(AGENT, 'hola, un poder'), sock);
  assert.deepEqual(sent, []);
  await settle(400);
  assert.deepEqual(sent, [{ to: jid(AGENT), text: 'Ya con cuota' }]);
  assert.equal((await outbound(AGENT))[0].content, 'Ya con cuota');
  assert.equal(calls, 2);
});

test('sin cuota para siempre: deja de reintentar a los 6 intentos y manda un solo mensaje de espera', async () => {
  handler._setAIRetryDelayMs(20);
  let calls = 0;
  setFakeProvider({ name: 'fake', async chat() { calls++; const e = new Error('x'); e.code = 'QUOTA'; throw e; } });
  await handler.processBatch(AGENT, batch(AGENT, 'hola'), sock);
  await settle(800);
  assert.equal(calls, 7); // el intento original + 6 reintentos
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /miembro de nuestro equipo/);
  await settle(200);
  assert.equal(calls, 7); // y no sigue intentando
});

test('un lote encolado mientras el turno anterior pasó el chat a una persona no corre el modelo ni manda nada', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'pasar_a_humano', args: { motivo: 'reclamación' } }] },
    { text: 'Entiendo, le paso con una persona.' },
    { text: 'Esto no debía salir' }]);
  setFakeProvider(p);
  // Los dos lotes se calcularon con willRespond=true (el chat aún era del bot); el segundo espera su turno.
  const a = handler.processBatch(AGENT, batch(AGENT, 'tengo una queja'), sock);
  const b = handler.processBatch(AGENT, batch(AGENT, 'y otra cosa'), sock);
  await Promise.all([a, b]);
  assert.equal(handler.isManualMode(AGENT), true);
  assert.equal(sent.length, 1); // el mensaje de espera del traspaso sí se manda
  assert.match(sent[0].text, /Entiendo, le paso con una persona\./);
  assert.match(sent[0].text, /Un miembro de nuestro equipo/);
  assert.equal(p.calls.length, 2);
  assert.equal((await outbound(AGENT)).length, 1);
});

test('si un empleado toma el chat mientras el agente responde, la respuesta no se manda', async () => {
  setFakeProvider(createFakeProvider([() => { handler.setManualMode(AGENT, true); return { text: 'Tarde' }; }]));
  await handler.processBatch(AGENT, batch(AGENT, 'hola'), sock);
  assert.deepEqual(sent, []);
  assert.deepEqual(await outbound(AGENT), []);
});

test('la respuesta guardada lleva el cliente aunque se haya registrado durante el turno', async () => {
  const NEW = '18095550399';
  process.env.BOT_AGENT_PHONES = `${AGENT},${NEW}`;
  setFakeProvider(createFakeProvider([async () => {
    await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Nuevo Cliente')`, [NEW]);
    return { text: 'Registrado' };
  }]));
  await handler.processBatch(NEW, batch(NEW, 'quiero registrarme'), sock);
  const out = (await pool.query(`SELECT client_id FROM messages WHERE phone=$1 AND direction='outbound'`, [NEW])).rows;
  const clientId = (await pool.query('SELECT id FROM clients WHERE phone=$1', [NEW])).rows[0].id;
  assert.deepEqual(out, [{ client_id: clientId }]);
});

// ---------- estado del traspaso al devolver el chat al bot ----------

test('al devolver un chat al bot se borra el estado del traspaso', async () => {
  const put = (phone) => pool.query(`INSERT INTO wa_bot_state (key, value, updated_at) VALUES ($1, '{"at":"2026-10-05T15:00:00.000Z","motivo":"m","urgente_avisado":false}', NOW())`, [`handoff:${phone}`]);
  await put(AGENT);
  handler.setManualMode(AGENT, true);
  handler.setManualMode(AGENT, false);
  await settle();
  assert.deepEqual(await handoffRows(), []);

  await put(AGENT);
  handler.setManualMode(AGENT, true);
  assert.equal(handler.toggleChatBot(AGENT), true); // en "all" el botón devuelve el chat al bot
  await settle();
  assert.deepEqual(await handoffRows(), []);

  await put(AGENT); await put(LEGACY);
  handler.setManualMode(AGENT, true); handler.setManualMode(LEGACY, true);
  handler.clearManualPhones();
  await settle();
  assert.deepEqual(await handoffRows(), []);

  // Pasar a manual no borra nada.
  await put(AGENT);
  handler.setManualMode(AGENT, true);
  await settle();
  assert.deepEqual(await handoffRows(), [`handoff:${AGENT}`]);
});

// ---------- API de Mensajes ----------

test('GET /api/messages/phone/:phone trae las herramientas de cada respuesta del bot', async () => {
  const inId = await inbound(AGENT, 'cuanto es un poder');
  const out1 = (await pool.query(`INSERT INTO messages (phone, client_id, direction, content) VALUES ($1,$2,'outbound','RD$700') RETURNING id`, [AGENT, clientIds.agent])).rows[0].id;
  const out2 = (await pool.query(`INSERT INTO messages (phone, client_id, direction, content) VALUES ($1,$2,'outbound','Gracias') RETURNING id`, [AGENT, clientIds.agent])).rows[0].id;
  const log = (name, ok, messageId) => pool.query(
    `INSERT INTO bot_tool_log (phone, herramienta, args, resultado, ok, ms, message_id) VALUES ($1,$2,'{}','{}',$3,1,$4)`, [AGENT, name, ok, messageId]);
  await log('buscar_servicio', true, out1);
  await log('calcular_precio', false, out1);
  await log('estado_solicitud', true, null); // sin ligar (turno sin entrega)

  // originalFetch: en beforeEach global.fetch es el doble de la detección de reclamaciones.
  const res = await originalFetch(`${base}/api/messages/phone/${AGENT}`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const { messages } = JSON.parse(body);
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  assert.deepEqual(byId[out1].tools, [{ herramienta: 'buscar_servicio', ok: true }, { herramienta: 'calcular_precio', ok: false }]);
  assert.deepEqual(byId[out2].tools, []);
  assert.equal('tools' in byId[inId], false);
  assert.equal(byId[inId].content, 'cuanto es un poder');
});

// ---------- revisión final ----------

test('un lote con foto (análisis lento) y luego uno de texto del mismo teléfono: se responden en orden y el texto ve el análisis', async () => {
  let release;
  handler._setMediaAnalysis({
    analyzeDocument: () => new Promise((r) => { release = () => r('Cédula de Ana López'); }),
    transcribeAudio: async () => null,
  });
  try {
    const p = createFakeProvider([
      (messages) => ({ text: `Foto: ${messages[messages.length - 1].text}` }),
      (messages) => ({ text: `Texto: ${messages.map((m) => m.text).join(' | ')}` }),
    ]);
    setFakeProvider(p);
    await pool.query(`INSERT INTO messages (phone, client_id, direction, content, wa_message_id) VALUES ($1,$2,'inbound','[📎 image]','img-1')`, [AGENT, clientIds.agent]);
    const media = { id: 7, media_type: 'image', mime_type: 'image/jpeg', file_path: '/tmp/x.jpg', wa_message_id: 'img-1' };
    const a = handler.processBatch(AGENT, batch(AGENT, '', true, media), sock);
    await settle(30);
    // El siguiente lote llega (y se guarda) mientras la foto todavía se analiza.
    await inbound(AGENT, 'y cuanto cuesta');
    const b = handler.processBatch(AGENT, batch(AGENT, 'y cuanto cuesta'), sock);
    await settle(100);
    assert.deepEqual(sent, [], 'nada se responde hasta que termine el lote de la foto');
    release();
    await Promise.all([a, b]);
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /^Foto: .*Cédula de Ana López/);
    assert.match(sent[1].text, /^Texto: /);
    assert.match(sent[1].text, /Cédula de Ana López/, 'el turno del texto ve el análisis de la foto');
    assert.match(sent[1].text, /y cuanto cuesta/);
    // El inbound que llegó después del cierre del lote de la foto no entra al turno de la foto.
    assert.ok(!p.calls[0].messages.some((m) => m.text.includes('y cuanto cuesta')), 'el lote de la foto no responde el texto siguiente');
    // El turno del texto ve la respuesta de la foto y termina con el texto actual (una sola respuesta por lote).
    const msgs = p.calls[1].messages;
    assert.equal(msgs[msgs.length - 1].role, 'user');
    assert.match(msgs[msgs.length - 1].text, /y cuanto cuesta/);
    assert.ok(msgs.some((m) => m.role === 'assistant' && /^Foto: /.test(m.text)));
    assert.equal((await outbound(AGENT)).length, 2);
  } finally {
    handler._setMediaAnalysis(null);
  }
});

test('GET /api/messages/phone/:phone responde 200 aunque no exista bot_tool_log', async () => {
  await inbound(AGENT, 'hola');
  await pool.query(`INSERT INTO messages (phone, client_id, direction, content) VALUES ($1,$2,'outbound','Hola 🦉')`, [AGENT, clientIds.agent]);
  await pool.query('DROP TABLE bot_tool_log');
  const res = await originalFetch(`${base}/api/messages/phone/${AGENT}`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  const { messages } = JSON.parse(body);
  assert.equal(messages.length, 2);
  const out = messages.find((m) => m.direction === 'outbound');
  assert.deepEqual(out.tools, []);
  assert.equal(messages.find((m) => m.direction === 'inbound').tools, undefined);
});

test('clearHandoffState no borra un traspaso más nuevo que el momento de devolver el chat', async () => {
  const put = (at) => pool.query(
    `INSERT INTO wa_bot_state (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [`handoff:${AGENT}`, JSON.stringify({ at, motivo: 'm', urgente_avisado: false })]);
  const t = new Date();
  const fresh = new Date(t.getTime() + 1000).toISOString();
  const old = new Date(t.getTime() - 1000).toISOString();
  await put(fresh);
  handler.clearHandoffState(AGENT, t);
  await settle();
  assert.deepEqual(await handoffRows(), [`handoff:${AGENT}`], 'un traspaso posterior al clic se conserva');
  await put(old);
  handler.clearHandoffState(AGENT, t);
  await settle();
  assert.deepEqual(await handoffRows(), []);
  await put(fresh);
  handler.clearHandoffState(null, t);
  await settle();
  assert.deepEqual(await handoffRows(), [`handoff:${AGENT}`]);
  await put(old);
  handler.clearHandoffState(null, t);
  await settle();
  assert.deepEqual(await handoffRows(), []);
});
