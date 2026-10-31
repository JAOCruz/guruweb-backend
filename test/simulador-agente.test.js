// El simulador del panel usa el agente (Jay, 2026-10-31): una cotización pedida en el simulador queda por aprobar
// en el panel, y al aprobarla y enviarla el PDF vuelve al chat del simulador en vez de salir por WhatsApp.
process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-sim-'));
const fs = require('fs');
const path = require('path');
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, seedCatalog } = require('./helpers/agentDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeProvider } = require('../src/agent/provider');
const { simulatorTurn, MANUAL_TEXT } = require('../src/agent/simulator');
const outgoing = require('../src/whatsapp/outgoing');
const handler = require('../src/whatsapp/handler');

const SIM = 'sim_prueba01';
let ids;

test.before(async () => {
  await createAgentSchema();
  await pool.query('DROP TABLE IF EXISTS simulator_messages, simulator_conversations CASCADE');
  await runSqlFile('migrations/20250729_messages_dedupe.sql');
  await pool.query(`ALTER TABLE client_media ADD COLUMN original_name VARCHAR(255), ADD COLUMN saved_name VARCHAR(255),
    ADD COLUMN file_size BIGINT, ADD COLUMN context VARCHAR(50), ADD COLUMN doc_request_id INT, ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW()`);
  await runSqlFile('migrations/20250618_add_simulator_chat_tables.sql');
  ids = await seedCatalog();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES ('adm','adm@t.co','x','Admin','admin')`);
  await pool.query(`INSERT INTO simulator_conversations (session_id) VALUES ($1)`, [SIM]);
  handler.setManualMode(SIM, false); // el estado del bot se restaura de la base: una corrida anterior pudo dejarlo en manual
});
test.after(() => pool.end());

test('un turno del simulador va al agente: cliente de prueba, mensajes guardados y cotización por aprobar', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'preparar_cotizacion', args: { partidas: [{ servicio_id: ids.poder }] } }] },
    { text: 'Le preparé la cotización del poder por RD$700 🦉' }]);
  const out = await simulatorTurn(SIM, 'quiero la cotización de un poder', null, { provider: p });
  assert.match(out, /RD\$700/);

  const client = (await pool.query('SELECT * FROM clients WHERE phone = $1', [SIM])).rows[0];
  assert.equal(client.source, 'simulator');
  assert.match(client.name, /simulador/i);

  const inv = (await pool.query('SELECT * FROM invoices WHERE client_phone = $1', [SIM])).rows;
  assert.equal(inv.length, 1);
  assert.equal(inv[0].status, 'pending_approval');
  assert.equal(Number(inv[0].total), 700);

  const msgs = (await pool.query('SELECT direction, content FROM messages WHERE phone = $1 ORDER BY id', [SIM])).rows;
  assert.deepEqual(msgs.map((m) => m.direction), ['inbound', 'outbound']);
  assert.equal(msgs[0].content, 'quiero la cotización de un poder');

  const avisos = (await pool.query(`SELECT title FROM notifications`)).rows.map((r) => r.title);
  assert.ok(avisos.some((t) => /Cotizaci[oó]n por aprobar/i.test(t)), avisos.join(' | '));
});

test('el segundo turno ve el primero (historial en messages)', async () => {
  const p = createFakeProvider([{ text: 'Claro' }]);
  await simulatorTurn(SIM, 'y cuánto tarda?', null, { provider: p });
  const users = p.calls[0].messages.filter((m) => m.role === 'user').map((m) => m.text);
  assert.ok(users.some((t) => /cotización de un poder/.test(t)), users.join(' | '));
});

test('lo que se "envía por WhatsApp" a un cliente del simulador queda en su chat, con el archivo', async () => {
  const file = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'COT-1.pdf');
  fs.writeFileSync(file, '%PDF-1.4 prueba');
  const r = await outgoing.sendDocument(SIM, file, 'COT-1.pdf', 'Aquí tiene su cotización');
  assert.match(r.key.id, /^sim_out_/);
  const conv = (await pool.query('SELECT id FROM simulator_conversations WHERE session_id = $1', [SIM])).rows[0];
  const last = (await pool.query('SELECT * FROM simulator_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [conv.id])).rows[0];
  assert.equal(last.role, 'bot');
  assert.equal(last.text, 'Aquí tiene su cotización');
  assert.equal(last.media_type, 'document');
  assert.equal(last.media_original_name, 'COT-1.pdf');
  const media = (await pool.query(`SELECT * FROM client_media WHERE phone = $1 AND context = 'simulator'`, [SIM])).rows;
  assert.equal(media.length, 1);
  assert.equal(media[0].file_path, file);

  await outgoing.sendText(SIM, 'Recibimos su pago');
  const t = (await pool.query('SELECT text FROM simulator_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [conv.id])).rows[0];
  assert.equal(t.text, 'Recibimos su pago');
  assert.equal(outgoing.isAvailable(SIM), true);
});

test('con el chat pasado a una persona, el simulador lo dice y no llama al modelo', async () => {
  handler.setManualMode(SIM, true);
  const p = createFakeProvider([{ text: 'no debería' }]);
  assert.equal(await simulatorTurn(SIM, 'hola?', null, { provider: p }), MANUAL_TEXT);
  assert.equal(p.calls.length, 0);
  handler.setManualMode(SIM, false);
});
