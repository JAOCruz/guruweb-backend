process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const { pool } = require('./helpers/db');
const { createAgentSchema, createUser, seedCatalog } = require('./helpers/agentDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const { respond, attachToolLogs, collectAmounts, AI_DEFERRED, _resetBotUserCache, WRITE_TOOLS } = require('../src/agent/agent');
const { priceGuard } = require('../src/agent/priceGuard');
const { createFakeProvider } = require('../src/agent/provider');
const { clearCache } = require('../src/agent/businessInfo');
const handler = require('../src/whatsapp/handler');

const PHONE = '18095550188';
const WAIT = "Un miembro de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo 'urgente'.";
let ids, clientId;

test.beforeEach(async () => {
  await createAgentSchema();
  clearCache();
  _resetBotUserCache();
  await createUser('adm', 'admin', 'Admin Uno');
  ids = await seedCatalog();
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Ana Cliente') RETURNING id`, [PHONE])).rows[0].id;
  handler.setManualMode(PHONE, false);
});
test.after(async () => { await pool.end(); });

const logs = async () => (await pool.query('SELECT * FROM bot_tool_log ORDER BY id')).rows;
const save = async (direction, content, minutesAgo = 0) => (await pool.query(
  `INSERT INTO messages (phone, client_id, direction, content, created_at) VALUES ($1, $2, $3, $4, NOW() - ($5 || ' minutes')::interval) RETURNING id`,
  [PHONE, clientId, direction, content, String(minutesAgo)])).rows[0].id;
const failing = (code, times = Infinity) => {
  const calls = [];
  return { name: 'fake', calls, async chat(req) { calls.push(req); if (calls.length <= times) { const e = new Error('x'); if (code) e.code = code; throw e; } return { text: 'Listo', toolCalls: [] }; } };
};
const userTexts = (call) => call.messages.filter((m) => m.role === 'user').map((m) => m.text);

// ---------- ciclo ----------

test('pregunta de precio: busca, calcula y responde con el monto de la herramienta', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'buscar_servicio', args: { consulta: 'acto de venta vehiculo' } }] },
    { toolCalls: [{ id: '2', name: 'calcular_precio', args: { servicio_id: ids.acto, valor_del_bien: 500000 } }] },
    { text: 'El acto de venta le sale en RD$950 🦉' }]);
  const out = await respond(PHONE, 'cuanto es un acto de venta de un carro de 500 mil', { provider: p });
  assert.match(out, /RD\$950/);
  assert.equal(p.calls.length, 3);
  assert.equal(p.calls[0].timeoutMs, 25000);
  assert.equal(p.calls[0].tools.length, 12);
  assert.deepEqual(p.calls[0].messages, [{ role: 'user', text: 'cuanto es un acto de venta de un carro de 500 mil' }]);
  // el tercer llamado lleva la llamada y el resultado de cada herramienta
  const m = p.calls[2].messages;
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant', 'tool']);
  assert.equal(m[2].toolCallId, '1'); assert.equal(m[2].name, 'buscar_servicio');
  assert.equal(m[4].result.total, 950);
  const l = await logs();
  assert.deepEqual(l.map((x) => [x.herramienta, x.ok]), [['buscar_servicio', true], ['calcular_precio', true]]);
  assert.equal(handler.isManualMode(PHONE), false);
});

test('un monto inventado se cambia por "(se lo confirmo)"', async () => {
  const p = createFakeProvider([{ text: 'Eso cuesta RD$1,200' }]);
  const out = await respond(PHONE, 'cuanto cuesta un poder', { provider: p });
  assert.doesNotMatch(out, /1,200/);
  assert.match(out, /se lo confirmo/);
  assert.equal(out, 'Eso cuesta (se lo confirmo)');
});

test('el desglose de una herramienta se puede decir; el de un servicio por confirmar no', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'calcular_precio', args: { servicio_id: ids.acto, valor_del_bien: 500000 } }] },
    { text: 'Son RD$500 de digitación y RD$ 450 de notarización: RD$950.00 en total.' }]);
  const out = await respond(PHONE, 'desglose', { provider: p });
  assert.equal(out, 'Son RD$500 de digitación y RD$ 450 de notarización: RD$950.00 en total.');

  const p2 = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'calcular_precio', args: { servicio_id: ids.conf } }] },
    { text: 'La digitación son RD$1,000.' }]);
  const out2 = await respond(PHONE, 'estatus juridico', { provider: p2 });
  assert.equal(out2, 'La digitación son (se lo confirmo).');
});

test('herramienta desconocida o con argumentos inválidos: el modelo recibe el error y el turno termina con texto', async () => {
  let seen;
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'volar', args: { a: 1 } }] },
    { toolCalls: [{ id: '2', name: 'calcular_precio', args: { valor_del_bien: 5 } }, { id: '3', name: 'buscar_servicio', args: 'texto' }] },
    (messages) => { seen = messages.filter((m) => m.role === 'tool'); return { text: 'Listo' }; }]);
  assert.equal(await respond(PHONE, 'hola', { provider: p }), 'Listo');
  assert.deepEqual(seen.map((m) => m.result.error), ['herramienta desconocida: volar', 'faltan datos: servicio_id', 'faltan datos: consulta']);
  assert.deepEqual(seen.map((m) => m.toolCallId), ['1', '2', '3']);
  assert.equal((await logs()).filter((x) => x.ok === false).length, 3);
  assert.equal(handler.isManualMode(PHONE), false);
});

test('más de 6 herramientas pasa a una persona con el mensaje de espera', async () => {
  const step = (i) => ({ toolCalls: [{ id: String(i), name: 'buscar_servicio', args: { consulta: 'poder' } }] });
  const p = createFakeProvider([1, 2, 3, 4, 5, 6, 7, 8].map(step));
  assert.equal(await respond(PHONE, 'hola', { provider: p }), WAIT);
  assert.equal(p.calls.length, 7);
  assert.equal(handler.isManualMode(PHONE), true);
  const l = await logs();
  assert.deepEqual(l.map((x) => x.herramienta), [...Array(6).fill('buscar_servicio'), 'pasar_a_humano']);
  assert.equal(l[6].args.motivo, 'demasiados pasos');
});

test('cuota agotada devuelve AI_DEFERRED', async () => {
  const p = failing('QUOTA');
  assert.equal(await respond(PHONE, 'hola', { provider: p }), AI_DEFERRED);
  assert.equal(AI_DEFERRED, '<<AI_DEFERRED>>');
  assert.equal(p.calls.length, 1);
  assert.equal(handler.isManualMode(PHONE), false);
  assert.equal((await logs()).length, 0);
});

test('el modelo falla dos veces: pasa a una persona, sin error técnico', async () => {
  const p = failing(null);
  assert.equal(await respond(PHONE, 'hola', { provider: p }), WAIT);
  assert.equal(p.calls.length, 2);
  assert.equal(handler.isManualMode(PHONE), true);
  const l = await logs();
  assert.equal(l.length, 1); assert.equal(l[0].herramienta, 'pasar_a_humano'); assert.equal(l[0].args.motivo, 'falla del modelo');
});

test('un TIMEOUT se reintenta una vez y, si el reintento sale bien, responde normal', async () => {
  const p = failing('TIMEOUT', 1);
  assert.equal(await respond(PHONE, 'hola', { provider: p }), 'Listo');
  assert.equal(p.calls.length, 2);
  assert.equal(handler.isManualMode(PHONE), false);
});

test('tras una falla con herramientas ya corridas, el reintento sigue desde donde iba y no las repite', async () => {
  let n = 0;
  const p = {
    name: 'fake', calls: [],
    async chat(req) {
      this.calls.push(req); n++;
      if (n === 1) return { text: '', toolCalls: [{ id: '1', name: 'calcular_precio', args: { servicio_id: ids.poder } }] };
      if (n === 2) throw new Error('boom');
      return { text: 'El poder cuesta RD$700.', toolCalls: [] };
    },
  };
  assert.equal(await respond(PHONE, 'poder', { provider: p }), 'El poder cuesta RD$700.');
  assert.equal(p.calls.length, 3);
  assert.deepEqual(p.calls[2].messages.map((m) => m.role), ['user', 'assistant', 'tool'], 'el reintento retoma con el resultado de la herramienta');
  assert.equal(p.calls[2].messages[2].result.total, 700);
  const l = await logs();
  assert.equal(l.length, 1);
});

test('sin duplicar la solicitud: un TIMEOUT después de crear_solicitud retoma el turno con el caso ya creado', async () => {
  let n = 0;
  const p = { name: 'fake', calls: [], async chat(req) {
    this.calls.push(req); n++;
    if (n === 1) return { text: '', toolCalls: [{ id: '1', name: 'crear_solicitud', args: { servicio: 'Poder', detalles: 'para su mamá' } }] };
    if (n === 2) { const e = new Error('x'); e.code = 'TIMEOUT'; throw e; }
    return { text: 'Listo, su solicitud quedó creada.', toolCalls: [] };
  } };
  assert.equal(await respond(PHONE, 'si, creela', { provider: p }), 'Listo, su solicitud quedó creada.');
  assert.equal((await pool.query('SELECT count(*)::int c FROM cases')).rows[0].c, 1);
  assert.deepEqual((await logs()).map((x) => x.herramienta), ['crear_solicitud']);
  assert.equal(handler.isManualMode(PHONE), false);
});

test('cuota agotada después de una herramienta que escribe: pasa a una persona en vez de diferir (sin repetir el caso)', async () => {
  let n = 0;
  const p = { name: 'fake', calls: [], async chat(req) {
    this.calls.push(req); n++;
    if (n === 1) return { text: '', toolCalls: [{ id: '1', name: 'crear_solicitud', args: { servicio: 'Poder' } }] };
    const e = new Error('x'); e.code = 'QUOTA'; throw e;
  } };
  assert.equal(await respond(PHONE, 'si', { provider: p }), WAIT);
  assert.equal(p.calls.length, 2);
  assert.equal((await pool.query('SELECT count(*)::int c FROM cases')).rows[0].c, 1);
  assert.equal(handler.isManualMode(PHONE), true);
  assert.deepEqual((await logs()).map((x) => x.herramienta), ['crear_solicitud', 'pasar_a_humano']);
});

test('preparar_documento cuenta como herramienta que escribe: un fallo después no difiere el turno (duplicaría el borrador)', () => {
  // El llenado real del Word necesita python-docx (ver agent-tools-documents.test.js); aquí se fija la regla del ciclo.
  assert.deepEqual([...WRITE_TOOLS].sort(), ['crear_solicitud', 'preparar_cotizacion', 'preparar_documento']);
  assert.equal(WRITE_TOOLS.has('avisar_pago'), false, 'avisar_pago solo avisa: repetirlo no duplica nada');
});

test('un turno reintentado nunca pasa de 6 herramientas en total', async () => {
  const tc = (from, k) => Array.from({ length: k }, (_, i) => ({ id: String(from + i), name: 'buscar_servicio', args: { consulta: 'poder' } }));
  let n = 0;
  const p = { name: 'fake', calls: [], async chat(req) {
    this.calls.push(req); n++;
    if (n === 1) return { text: '', toolCalls: tc(1, 4) };
    if (n === 2) throw new Error('boom');
    return { text: '', toolCalls: tc(5, 3) };
  } };
  assert.equal(await respond(PHONE, 'hola', { provider: p }), WAIT);
  const l = await logs();
  assert.deepEqual(l.map((x) => x.herramienta), [...Array(6).fill('buscar_servicio'), 'pasar_a_humano']);
  assert.equal(l[6].args.motivo, 'demasiados pasos');
});

test('tres "si" o tres números seguidos no cuentan como repetición', async () => {
  for (const t of ['si', 'Sí', 'ok', '2', '1500']) {
    await pool.query('DELETE FROM messages');
    await save('inbound', t, 10); await save('inbound', t, 5);
    const p = createFakeProvider([{ text: 'Perfecto' }]);
    assert.equal(await respond(PHONE, t, { provider: p }), 'Perfecto', t);
    assert.equal(handler.isManualMode(PHONE), false, t);
  }
});

test('el mismo mensaje 3 veces pasa a una persona sin llamar al modelo', async () => {
  await save('inbound', 'Hola', 10);
  await save('outbound', '¿En qué le ayudo?', 9);
  await save('inbound', 'hola ', 5);
  const p = createFakeProvider([{ text: 'nunca' }]);
  assert.equal(await respond(PHONE, 'HOLA', { provider: p }), WAIT);
  assert.equal(p.calls.length, 0);
  assert.equal(handler.isManualMode(PHONE), true);
  const l = await logs();
  assert.equal(l.length, 1); assert.equal(l[0].herramienta, 'pasar_a_humano');
});

test('si el mensaje actual ya está guardado no se cuenta dos veces', async () => {
  await save('inbound', 'hola', 5);
  await save('inbound', 'hola'); // el lote actual, que el handler ya guardó
  const p = createFakeProvider([{ text: 'Buenas' }]);
  assert.equal(await respond(PHONE, 'hola', { provider: p }), 'Buenas');
  assert.equal(p.calls.length, 1);
  assert.equal(handler.isManualMode(PHONE), false);
  await save('inbound', 'hola');
  const p2 = createFakeProvider([{ text: 'nunca' }]);
  assert.equal(await respond(PHONE, 'hola', { provider: p2 }), WAIT);
  assert.equal(p2.calls.length, 0);
});

test('un lote con solo una foto llega al modelo como texto con su análisis', async () => {
  const p = createFakeProvider([{ text: 'Recibí su cédula' }]);
  await respond(PHONE, '', { provider: p, media: [{ id: 7, media_type: 'image', analysis: 'Cédula de JUAN PEREZ' }] });
  const last = p.calls[0].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.text, /Cédula de JUAN PEREZ/);
  assert.match(last.text, /\[Foto\/Documento enviado, id 7\]: Cédula de JUAN PEREZ/);
});

test('una nota de voz ya transcrita en el texto no se repite; una foto sin análisis se anuncia con su id', async () => {
  const p = createFakeProvider([{ text: 'ok' }]);
  await respond(PHONE, 'quiero un poder', { provider: p, media: [
    { id: 3, media_type: 'audio', transcription: 'quiero un poder' },
    { id: 4, media_type: 'document' }] });
  const text = p.calls[0].messages.at(-1).text;
  assert.equal(text.match(/quiero un poder/g).length, 1);
  assert.match(text, /\[Foto\/Documento enviado, id 4\]/);
  const p2 = createFakeProvider([{ text: 'ok' }]);
  await respond(PHONE, '', { provider: p2, media: [{ id: 5, media_type: 'audio', transcription: 'buenas tardes' }] });
  assert.match(p2.calls[0].messages.at(-1).text, /\[Nota de voz, id 5\]: buenas tardes/);
});

test('el texto actual aparece una sola vez aunque el handler ya lo haya guardado', async () => {
  await save('inbound', 'buenas');
  await save('outbound', 'Hola, ¿en qué le ayudo?');
  await save('inbound', 'cuanto cuesta un poder');
  await save('inbound', 'para mi mamá\n[📎 adjunto]\n[📷 Imagen analizada]:\nCédula de ANA');
  const p = createFakeProvider([{ text: 'ok' }]);
  await respond(PHONE, 'cuanto cuesta un poder para mi mamá', { provider: p, media: [{ id: 1, media_type: 'image', analysis: 'Cédula de ANA' }] });
  const m = p.calls[0].messages;
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(m[0].text, 'buenas');
  assert.equal(m[2].text, 'cuanto cuesta un poder para mi mamá\n[Foto/Documento enviado, id 1]: Cédula de ANA');
  assert.equal(userTexts(p.calls[0]).filter((t) => t.includes('cuanto cuesta un poder')).length, 1);
});

test('el historial se normaliza: sin turno inicial del asistente y sin turnos seguidos del mismo rol', async () => {
  await save('outbound', 'Bienvenido');
  await save('inbound', 'hola');
  await save('inbound', 'quiero un poder');
  await save('outbound', 'Claro.');
  await save('outbound', '¿Para quién?');
  const p = createFakeProvider([{ text: 'ok' }]);
  await respond(PHONE, 'para mi mamá', { provider: p });
  assert.deepEqual(p.calls[0].messages, [
    { role: 'user', text: 'hola\nquiero un poder' },
    { role: 'assistant', text: 'Claro.\n¿Para quién?' },
    { role: 'user', text: 'para mi mamá' }]);
});

test('si pasar_a_humano corrió y el modelo no repitió el mensaje de espera, se agrega al final', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'pasar_a_humano', args: { motivo: 'reclamación' } }] },
    { text: 'Entiendo su molestia 🙏🏾' }]);
  assert.equal(await respond(PHONE, 'quiero reclamar', { provider: p }), `Entiendo su molestia 🙏🏾\n\n${WAIT}`);
  assert.equal(handler.isManualMode(PHONE), true);
  const p2 = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'pasar_a_humano', args: { motivo: 'reclamación' } }] },
    { text: `Entiendo. ${WAIT}` }]);
  const out = await respond(PHONE, 'quiero reclamar otra vez', { provider: p2 });
  assert.equal(out, `Entiendo. ${WAIT}`);
  assert.equal(out.split('a la brevedad').length, 2);
});

test('si el modelo falla después de pasar_a_humano, se manda el mensaje de espera sin reintentar ni volver a pasar', async () => {
  for (const code of ['QUOTA', 'TIMEOUT', null]) {
    handler.setManualMode(PHONE, false);
    await pool.query('DELETE FROM bot_tool_log');
    let n = 0;
    const p = { name: 'fake', calls: [], async chat(req) {
      this.calls.push(req); n++;
      if (n === 1) return { text: '', toolCalls: [{ id: '1', name: 'pasar_a_humano', args: { motivo: 'reclamación' } }] };
      const e = new Error('x'); if (code) e.code = code; throw e;
    } };
    assert.equal(await respond(PHONE, 'quiero reclamar', { provider: p }), WAIT, String(code));
    assert.equal(p.calls.length, 2, String(code));
    assert.equal(handler.isManualMode(PHONE), true);
    assert.deepEqual((await logs()).map((x) => x.herramienta), ['pasar_a_humano'], String(code));
  }
});

test('dos turnos del mismo teléfono no se cruzan: el segundo ve la respuesta entregada del primero y cada uno liga sus herramientas', async () => {
  const calls = [];
  let n = 0;
  const p = { name: 'fake', calls, async chat(req) {
    const rec = { ...req, started: Date.now() }; calls.push(rec); n++;
    if (n === 1) return { text: '', toolCalls: [{ id: '1', name: 'buscar_servicio', args: { consulta: 'poder' } }] };
    if (n === 2) { await new Promise((r) => setTimeout(r, 200)); rec.finished = Date.now(); return { text: 'respuesta uno', toolCalls: [] }; }
    if (n === 3) return { text: '', toolCalls: [{ id: '2', name: 'estado_solicitud', args: {} }] };
    rec.finished = Date.now(); return { text: 'respuesta dos', toolCalls: [] };
  } };
  const delivered = [];
  const deliver = async (text) => { const id = await save('outbound', text); delivered.push({ text, id }); return id; };
  await save('inbound', 'primero');
  const a = respond(PHONE, 'primero', { provider: p, deliver });
  const b = respond(PHONE, 'segundo', { provider: p, deliver });
  assert.deepEqual(await Promise.all([a, b]), ['respuesta uno', 'respuesta dos']);
  assert.equal(calls.length, 4);
  assert.ok(calls[2].started >= calls[1].finished, 'el segundo turno arranca cuando el primero ya entregó');
  assert.deepEqual(calls[2].messages, [
    { role: 'user', text: 'primero' }, { role: 'assistant', text: 'respuesta uno' }, { role: 'user', text: 'segundo' }]);
  assert.deepEqual(delivered.map((d) => d.text), ['respuesta uno', 'respuesta dos']);
  const l = await logs();
  assert.deepEqual(l.map((x) => [x.herramienta, x.message_id]), [['buscar_servicio', delivered[0].id], ['estado_solicitud', delivered[1].id]]);
});

test('deliver no se llama con AI_DEFERRED ni con un turno vacío, y si falla el turno igual devuelve el texto', async () => {
  const delivered = [];
  const deliver = async (t) => { delivered.push(t); return null; };
  assert.equal(await respond(PHONE, 'hola', { provider: failing('QUOTA'), deliver }), AI_DEFERRED);
  assert.equal(await respond(PHONE, '', { provider: createFakeProvider([]), deliver }), '');
  assert.deepEqual(delivered, []);
  const boom = async () => { throw new Error('socket'); };
  assert.equal(await respond(PHONE, 'hola', { provider: createFakeProvider([{ text: 'Buenas' }]), deliver: boom }), 'Buenas');
});

test('si deliver se cuelga, el ciclo termina por tiempo y el siguiente turno del mismo teléfono corre y entrega', async () => {
  const delivered = [];
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  const a = await respond(PHONE, 'uno', { provider: createFakeProvider([{ text: 'A' }]), deliver: hang, deliverTimeoutMs: 100 });
  assert.equal(a, 'A');
  assert.ok(Date.now() - t0 < 2000, 'no espera para siempre');
  const b = await respond(PHONE, 'dos', { provider: createFakeProvider([{ text: 'B' }]), deliver: async (t) => { delivered.push(t); return null; } });
  assert.equal(b, 'B');
  assert.deepEqual(delivered, ['B']);
});

test('un turno que falla no bloquea el siguiente del mismo teléfono', async () => {
  const bad = { name: 'fake', calls: [], async chat() { throw new Error('boom'); } };
  const good = createFakeProvider([{ text: 'bien' }]);
  const [a, b] = await Promise.all([respond(PHONE, 'uno', { provider: bad }), respond(PHONE, 'dos', { provider: good })]);
  assert.equal(a, WAIT);
  assert.equal(b, 'bien');
});

test('attachToolLogs(messageId, ids) liga las herramientas al mensaje del bot', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'buscar_servicio', args: { consulta: 'poder' } }, { id: '2', name: 'estado_solicitud', args: {} }] },
    { text: 'Listo' }]);
  await respond(PHONE, 'poder', { provider: p });
  const before = await logs();
  assert.equal(before.length, 2);
  assert.ok(before.every((x) => x.message_id === null));
  const mid = await save('outbound', 'Listo');
  assert.equal(await attachToolLogs(mid, before.map((x) => x.id)), 2);
  assert.ok((await logs()).every((x) => x.message_id === mid));
  assert.equal(await attachToolLogs(mid, []), 0);
  assert.equal(await attachToolLogs(null, [before[0].id]), 0);
});

test('un cliente nuevo (sin fila en clients) también recibe respuesta', async () => {
  const p = createFakeProvider([{ text: 'Bienvenido' }]);
  assert.equal(await respond('18095550199', 'hola', { provider: p }), 'Bienvenido');
  assert.match(p.calls[0].system, /Cliente nuevo/);
});

// ---------- montos permitidos ----------

test('collectAmounts junta total, precio, rango, desglose y cantidad por precio; ignora lo por confirmar', () => {
  const s = new Set();
  collectAmounts({ total: 950, desglose: { digitacion: 500, notarizacion: 450 }, rango: null }, s);
  collectAmounts({ resultados: [{ precio: 700, rango: { min: 800, max: 1200 } }, { precio: null }] }, s);
  collectAmounts({ items: [{ cantidad: 3, precio: 100 }] }, s);
  collectAmounts({ total: null, por_confirmar: true, desglose: { digitacion: 1000, notarizacion: 0 } }, s);
  collectAmounts({ error: 'x', total: 'no' }, s);
  collectAmounts(null, s);
  assert.deepEqual([...s].sort((a, b) => a - b), [100, 300, 450, 500, 700, 800, 950, 1200]);
});

test('el valor del bien que el modelo pasó a calcular_precio se puede repetir con RD$', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'calcular_precio', args: { servicio_id: ids.acto, valor_del_bien: 500000 } }] },
    { text: 'Para un carro de RD$500,000 le sale en RD$950.' }]);
  assert.equal(await respond(PHONE, 'carro de 500 mil', { provider: p }), 'Para un carro de RD$500,000 le sale en RD$950.');
  const p2 = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'preparar_cotizacion', args: { partidas: [{ servicio_id: ids.acto, valor_del_bien: 650000 }] } }] },
    { text: 'Cotización por RD$950 (vehículo de RD$650,000).' }]);
  assert.equal(await respond(PHONE, 'cotice', { provider: p2 }), 'Cotización por RD$950 (vehículo de RD$650,000).');
});

test('la suma de dos o tres totales de herramientas se puede decir', async () => {
  const p = createFakeProvider([
    { toolCalls: [{ id: '1', name: 'calcular_precio', args: { servicio_id: ids.acto, valor_del_bien: 500000 } },
      { id: '2', name: 'calcular_precio', args: { servicio_id: ids.poder } }] },
    { text: 'RD$950 + RD$700 = RD$1,650 en total; RD$1,700 no.' }]);
  assert.equal(await respond(PHONE, 'ambos', { provider: p }), 'RD$950 + RD$700 = RD$1,650 en total; (se lo confirmo) no.');
});

test('un precio dado por una herramienta en un turno anterior se puede repetir; un precio de otro teléfono no', async () => {
  const p = createFakeProvider([{ toolCalls: [{ id: '1', name: 'calcular_precio', args: { servicio_id: ids.poder } }] }, { text: 'El poder cuesta RD$700.' }]);
  assert.equal(await respond(PHONE, 'poder', { provider: p }), 'El poder cuesta RD$700.');
  const p2 = createFakeProvider([{ text: 'Como le dije, el poder cuesta RD$700 🦉' }]);
  assert.equal(await respond(PHONE, 'cuanto era?', { provider: p2 }), 'Como le dije, el poder cuesta RD$700 🦉');
  const p3 = createFakeProvider([{ text: 'El poder cuesta RD$700.' }]);
  assert.equal(await respond('18095550177', 'poder', { provider: p3 }), 'El poder cuesta (se lo confirmo).');
  await pool.query(`UPDATE bot_tool_log SET created_at = NOW() - interval '25 hours'`);
  const p4 = createFakeProvider([{ text: 'El poder cuesta RD$700.' }]);
  assert.equal(await respond(PHONE, 'y ahora?', { provider: p4 }), 'El poder cuesta (se lo confirmo).');
});

test('un monto escrito por el cliente nunca se vuelve permitido', async () => {
  await save('inbound', 'me dijeron 500 pesos', 5);
  const p = createFakeProvider([{ text: 'Sí, son RD$500.' }]);
  assert.equal(await respond(PHONE, 'me dijeron 500 pesos', { provider: p }), 'Sí, son (se lo confirmo).');
});

// ---------- priceGuard ----------

test('priceGuard detecta RD$ 1,500, RD$1500, 1,500 pesos y $1500 y compara formatos', () => {
  const ok = new Set([1500]);
  for (const t of ['RD$ 1,500', 'RD$1500', '1,500 pesos', '$1500', 'RD $1,500.00', 'RD$1.500', '1500.00 pesos', 'rd$1,500']) {
    assert.deepEqual(priceGuard(`Cuesta ${t}.`, ok), { text: `Cuesta ${t}.`, blocked: [] }, t);
  }
  for (const t of ['RD$ 1,200', 'RD$1200', '1,200 pesos', '$1200', 'RD $1,200.00', 'US$1200']) {
    const r = priceGuard(`Cuesta ${t}.`, ok);
    assert.equal(r.text, 'Cuesta (se lo confirmo).', t);
    assert.deepEqual(r.blocked, [1200], t);
  }
  const r = priceGuard('Son RD$950 más RD$1,200 pesos y 300 pesos.', new Set([950]));
  assert.equal(r.text, 'Son RD$950 más (se lo confirmo) y (se lo confirmo).');
  assert.deepEqual(r.blocked, [1200, 300]);
  assert.deepEqual(priceGuard('RD$1,200', new Set()).blocked, [1200]);
  assert.deepEqual(priceGuard('', new Set()), { text: '', blocked: [] });
});

test('priceGuard entiende "mil", grupos con espacio, marcadores después y grupos mal formados', () => {
  const ok = new Set([1500, 950, 2000, 5000]);
  for (const t of ['2 mil pesos', 'RD$5 mil', 'RD$1 500', '1,500 RD$', '1,500 RD', '1500 DOP', 'DOP 1,500', 'RD$2 MIL pesos', '$1 500.00']) {
    assert.deepEqual(priceGuard(`Cuesta ${t}.`, ok), { text: `Cuesta ${t}.`, blocked: [] }, t);
  }
  assert.deepEqual(priceGuard('Cuesta RD$950 mil.', ok), { text: 'Cuesta (se lo confirmo).', blocked: [950000] });
  assert.deepEqual(priceGuard('Son 3 mil pesos.', ok), { text: 'Son (se lo confirmo).', blocked: [3000] });
  assert.deepEqual(priceGuard('Cuesta RD$1,5000 hoy.', new Set([15000, 1500, 5000])), { text: 'Cuesta (se lo confirmo) hoy.', blocked: [15000] });
  assert.deepEqual(priceGuard('Son 1,200 RD$.', ok), { text: 'Son (se lo confirmo).', blocked: [1200] });
  assert.deepEqual(priceGuard('Son DOP 1200.', ok), { text: 'Son (se lo confirmo).', blocked: [1200] });
  assert.deepEqual(priceGuard('Son 3 mil de valor y 2 originales.', ok), { text: 'Son 3 mil de valor y 2 originales.', blocked: [] });
  assert.deepEqual(priceGuard('Cuesta RD$950  mil.', new Set([950000])), { text: 'Cuesta RD$950  mil.', blocked: [] });
  assert.deepEqual(priceGuard('Cuesta RD$950  mil.', ok), { text: 'Cuesta (se lo confirmo).', blocked: [950000] });
  assert.deepEqual(priceGuard('Cuesta RD$950 millones.', new Set([950, 950000])), { text: 'Cuesta (se lo confirmo).', blocked: [950000000] });
  assert.deepEqual(priceGuard('Cuesta RD$1 5000 hoy.', new Set([15000, 1500, 5000, 1])), { text: 'Cuesta (se lo confirmo) hoy.', blocked: [15000] });
  assert.deepEqual(priceGuard('Cuesta RD$1 500 000 hoy.', new Set([1500000])), { text: 'Cuesta RD$1 500 000 hoy.', blocked: [] });
});

test('priceGuard no toca cédulas, fechas, horas, teléfonos, porcentajes ni cantidades sin moneda', () => {
  const text = 'Su cédula 001-0000000-1, el 5/10/2026 a las 9:00 o el 2026-10-05 10:30, al 809-555-0111 o +1 (809) 555 0111. ' +
    'Son 3 originales, 2 páginas, un 30% y 500 mil de valor; cuesta 1,200 dólares. Caso #1500.';
  assert.deepEqual(priceGuard(text, new Set()), { text, blocked: [] });
});

test('shouldRun se consulta dentro del candado: si el chat ya no es del bot, el turno se omite sin modelo ni entrega', async () => {
  const p = createFakeProvider([{ text: 'No debía salir' }]);
  const delivered = [];
  const deliver = async (t) => { delivered.push(t); return null; };
  let allowed = false;
  const out = await respond(PHONE, 'hola', { provider: p, deliver, shouldRun: () => allowed });
  assert.equal(out, '');
  assert.equal(p.calls.length, 0);
  assert.deepEqual(delivered, []);
  allowed = true;
  assert.equal(await respond(PHONE, 'hola', { provider: p, deliver, shouldRun: () => allowed }), 'No debía salir');
  assert.deepEqual(delivered, ['No debía salir']);
});

test('deliver recibe handoff=true solo cuando ese turno pasó el chat a una persona', async () => {
  const infos = [];
  const deliver = async (_t, info) => { infos.push(info); return null; };
  await respond(PHONE, 'hola', { provider: createFakeProvider([{ text: 'Buenas' }]), deliver });
  await respond(PHONE, 'tengo una queja', { provider: createFakeProvider([
    { toolCalls: [{ id: '1', name: 'pasar_a_humano', args: { motivo: 'reclamación' } }] }, { text: 'Entiendo.' }]), deliver });
  handler.setManualMode(PHONE, false);
  // Traspaso sin modelo (falla del modelo dos veces) también lo marca.
  await respond(PHONE, 'otra cosa', { provider: failing(null), deliver });
  assert.deepEqual(infos.map((i) => i.handoff), [false, true, true]);
});

// ---------- revisión final ----------

test('respond con cutoff: un inbound guardado después del corte no entra al contexto del turno', async () => {
  const id = await save('inbound', 'hola');
  await save('inbound', 'otro mensaje que llegó después');
  const p = createFakeProvider([{ text: 'ok' }]);
  assert.equal(await respond(PHONE, 'hola', { provider: p, cutoff: id }), 'ok');
  assert.deepEqual(p.calls[0].messages, [{ role: 'user', text: 'hola' }]);
});
