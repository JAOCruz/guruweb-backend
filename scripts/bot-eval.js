#!/usr/bin/env node
// Batería de escenarios del bot con un modelo real (o el falso, con --provider fake).
//   node scripts/bot-eval.js [--provider gemini|claude|both|fake] [--solo texto] [--judge gemini|claude] [--pausa segundos]
// --pausa espera entre turnos para no pasar el límite por minuto del proveedor.
// Corre cada escenario de test/agent/escenarios/*.json contra el agente real, sobre tablas nuevas en la base
// LOCAL guru_test (el catálogo sale de test/agent/catalog-snapshot.json), revisa `espera` y `prohibido` con
// scripts/bot-eval-checks.js, pide una nota de tono a un segundo modelo y escribe
// test/agent/resultados/<fecha>-<proveedor>.md. Sale con código 1 si algún escenario viola `prohibido`.
// El juez de tono usa el mismo proveedor que se evalúa, salvo que se pase --judge.
// El costo de Claude solo se estima si se definen BOT_EVAL_PRICE_CLAUDE_IN y BOT_EVAL_PRICE_CLAUDE_OUT (USD por millón de
// tokens); el de Gemini usa precios por defecto (BOT_EVAL_PRICE_GEMINI_IN/OUT los reemplazan).
// En la consola solo van conteos y nombres de escenarios, nunca texto de mensajes.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-eval-'));
// helpers/db.js rechaza cualquier base que no sea local y fija DATABASE_URL antes de cargar el pool.
const { pool, runSqlFile } = require('../test/helpers/db');
const { createAgentSchema } = require('../test/helpers/agentDb');
const { seedBotKnowledge } = require('../src/db/seedBotKnowledge');
const { getProvider } = require('../src/agent/provider');
const { respond } = require('../src/agent/agent');
const { evaluateScenario } = require('./bot-eval-checks');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'test', 'agent', 'catalog-snapshot.json');
const ESCENARIOS = path.join(ROOT, 'test', 'agent', 'escenarios');
const RESULTADOS = path.join(ROOT, 'test', 'agent', 'resultados');

const RUBRIC = 'Eres un evaluador de tono. Recibes una conversación de WhatsApp entre un cliente y el asistente de Gurú Soluciones ' +
  '(documentos legales y trámites, República Dominicana). Califica SOLO las respuestas del asistente de 1 a 5 según: ' +
  '(1) cercano y amable, (2) corto: pocas líneas, sin párrafos largos, (3) trata de "usted", (4) no inventa precios, plazos ni datos, ' +
  '(5) pregunta lo que falta antes de cotizar. 5 = cumple todo; 3 = cumple a medias; 1 = falla en casi todo. ' +
  'Responda únicamente con JSON, sin texto extra: {"nota": <1-5>, "motivo": "<una frase en español>"}';

// Precios por millón de tokens en USD (entrada/salida). Solo se estima el costo si se conocen.
const PRICES = {
  gemini: { in: Number(process.env.BOT_EVAL_PRICE_GEMINI_IN ?? 0.30), out: Number(process.env.BOT_EVAL_PRICE_GEMINI_OUT ?? 2.50) },
  claude: { in: Number(process.env.BOT_EVAL_PRICE_CLAUDE_IN ?? NaN), out: Number(process.env.BOT_EVAL_PRICE_CLAUDE_OUT ?? NaN) },
};

function parseArgs(argv) {
  const a = { provider: 'gemini', solo: null, judge: null, pausa: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider') a.provider = argv[++i];
    else if (argv[i] === '--solo') a.solo = argv[++i];
    else if (argv[i] === '--judge') a.judge = argv[++i];
    else if (argv[i] === '--pausa') a.pausa = Number(argv[++i]) || 0;
  }
  if (!['gemini', 'claude', 'both', 'fake'].includes(a.provider)) throw new Error('--provider debe ser gemini, claude, both o fake');
  return a;
}

function loadScenarios(solo) {
  const all = fs.readdirSync(ESCENARIOS).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ archivo: f, ...JSON.parse(fs.readFileSync(path.join(ESCENARIOS, f), 'utf8')) }));
  const needle = solo ? solo.toLowerCase() : null;
  return needle ? all.filter((s) => s.nombre.toLowerCase().includes(needle) || s.archivo.includes(needle)) : all;
}

// ---------- base de datos ----------

async function setupDb() {
  await createAgentSchema(); // tablas del agente + migración (incluye el seed de business_info y el usuario 'bot')
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  await pool.query('DELETE FROM service_catalog');
  await pool.query('DELETE FROM service_categories');
  for (const c of snap.service_categories) await pool.query('INSERT INTO service_categories (id, name) VALUES ($1,$2)', [c.id, c.name]);
  for (const s of snap.service_catalog) {
    await pool.query(
      `INSERT INTO service_catalog (id, name, description, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.id, s.name, s.description, s.category_id, s.digitacion_price, s.notarizacion_price, JSON.stringify(s.price_tiers || []), s.unit_type, s.active !== false]);
  }
  await pool.query(`SELECT setval(pg_get_serial_sequence('service_categories','id'), COALESCE((SELECT MAX(id) FROM service_categories),1))`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('service_catalog','id'), COALESCE((SELECT MAX(id) FROM service_catalog),1))`);
  const r = await seedBotKnowledge({ dir: path.join(ROOT, 'seeds', 'bot') });
  // Precios de Leandro, ronda 1: la migración (fojas, duplicados, mensajería, Uber, tasas_cache) es idempotente y
  // vuelve a crear lo que el DELETE de arriba borró; luego se aplican las fojas de seeds/bot/fojas.json.
  await runSqlFile('migrations/20261009_precios_leandro_1.sql');
  await runSqlFile('migrations/20261017_reglas_atencion.sql');
  await runSqlFile('migrations/20261018_partidas_por_confirmar.sql');
  await runSqlFile('migrations/20261019_tiempos_entrega.sql');
  await runSqlFile('migrations/20261026_apostilla_cancilleria.sql');
  await runSqlFile('migrations/20261027_politicas_seguimiento.sql'); // políticas del negocio, pagaré, apoderado
  await runSqlFile('migrations/20261028_certificacion_vehiculo_plan_piloto.sql');
  for (const f of JSON.parse(fs.readFileSync(path.join(ROOT, 'seeds', 'bot', 'fojas.json'), 'utf8'))) {
    await pool.query('UPDATE service_catalog SET foja_tipo = $1, fojas = $2 WHERE name = $3', [f.foja_tipo, f.fojas, f.nombre]);
  }
  await applySnapshot(snap);
  // precios de las capturas de Leandro: van después del snapshot, que todavía tiene los de antes
  await runSqlFile('migrations/20261028_precios_capturas.sql');
  await runSqlFile('migrations/20261028_notarizacion_contratos.sql');
  await runSqlFile('migrations/20261028_declaracion_mejora_fija.sql');
  await runSqlFile('migrations/20261029_traduccion_varias_paginas.sql');
  await seedModeloAprobado();
  return { servicios: snap.service_catalog.length, seed: r };
}

// El snapshot es el catálogo de producción (scripts/export-catalog.js): al final se le ponen todas sus columnas
// (reglas, fojas, alias, requisitos…) por encima de lo que dejaron los seeds y las migraciones, y los trámites se reemplazan.
async function localColumns(table) {
  const { rows } = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}
const asParam = (v, type) => (v !== null && (type === 'jsonb' || type === 'json') ? JSON.stringify(v) : v);
async function applySnapshot(snap) {
  const cols = await localColumns('service_catalog');
  for (const row of snap.service_catalog) {
    const keys = Object.keys(row).filter((k) => k !== 'id' && cols.has(k));
    await pool.query(`UPDATE service_catalog SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')} WHERE id = $1`,
      [row.id, ...keys.map((k) => asParam(row[k], cols.get(k)))]);
  }
  const tcols = await localColumns('tramites');
  if (tcols.size && snap.tramites?.length) {
    await pool.query('DELETE FROM tramites');
    for (const row of snap.tramites) {
      const keys = Object.keys(row).filter((k) => tcols.has(k));
      await pool.query(`INSERT INTO tramites (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys.map((k) => asParam(row[k], tcols.get(k))));
    }
  }
}

// Modelo etiquetado y aprobado para los escenarios de documentos: "Acto de Venta - Vehículo Liviano" con el .docx
// de prueba (test/fixtures/venta-etiquetada.docx, {{NOMBRE_VENDEDOR}} y {{NOMBRE_COMPRADOR}}), ligado al servicio del catálogo.
// Los demás servicios quedan sin modelo (escenario "sin modelo aprobado").
const MODELO_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'venta-etiquetada.docx');
const MODELO_TAGS = [
  { key: 'NOMBRE_VENDEDOR', label: 'Nombre del vendedor', group: 'VENDEDOR' },
  { key: 'NOMBRE_COMPRADOR', label: 'Nombre del comprador', group: 'COMPRADOR' },
];
async function seedModeloAprobado() {
  await pool.query(`DROP TABLE IF EXISTS template_tag_versions, portfolio_versions, portfolio_documents, doc_templates, doc_categories CASCADE`);
  await pool.query('CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)');
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  for (const f of ['20260929_portfolio.sql', '20261002_template_tags.sql', '20261006_bot_fase2.sql',
    '20261022_modelo_desde_documento.sql', '20261025_modelos_papelera_correcciones.sql']) {
    await pool.query(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
  }
  const { rows: [tpl] } = await pool.query(
    `INSERT INTO doc_templates (name, file_path, file_name) VALUES ('ACTO DE VENTA - VEHÍCULO LIVIANO', 'venta-etiquetada.docx', 'venta-etiquetada.docx') RETURNING id`);
  const { rows: [ver] } = await pool.query(
    `INSERT INTO template_tag_versions (template_id, version_number, file_path, tags, source) VALUES ($1, 1, $2, $3, 'ai') RETURNING id`,
    [tpl.id, MODELO_FIXTURE, JSON.stringify(MODELO_TAGS)]);
  await pool.query('UPDATE doc_templates SET approved_tag_version_id = $1 WHERE id = $2', [ver.id, tpl.id]);
  const upd = await pool.query(`UPDATE service_catalog SET template_id = $1 WHERE name = 'Acto de Venta - Vehículo Liviano'`, [String(tpl.id)]);
  if (upd.rowCount !== 1) throw new Error(`el catálogo debía tener exactamente un "Acto de Venta - Vehículo Liviano" (hay ${upd.rowCount})`);
}

// ---------- proveedores ----------

// Envuelve un proveedor para medir latencia y tokens (si el adaptador devuelve usage).
function instrument(provider) {
  const stats = { calls: 0, ms: 0, input: 0, output: 0, withUsage: 0 };
  return {
    stats,
    name: provider.name,
    async chat(req) {
      const t0 = Date.now();
      try {
        const out = await provider.chat(req);
        if (out && out.usage) { stats.input += out.usage.input || 0; stats.output += out.usage.output || 0; stats.withUsage++; }
        return out;
      } finally { stats.calls++; stats.ms += Date.now() - t0; }
    },
  };
}

// Falso mínimo: siempre llama buscar_servicio y luego contesta; sin herramientas devuelve una nota de tono fija.
function createScriptedFake() {
  return {
    name: 'fake',
    async chat({ messages, tools }) {
      if (!tools || !tools.length) return { text: '{"nota":4,"motivo":"respuesta de prueba del proveedor falso"}', toolCalls: [] };
      const last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        return { text: '', toolCalls: [{ id: 'fake-1', name: 'buscar_servicio', args: { consulta: String(last.text || '').slice(0, 80) } }] };
      }
      return { text: '¿Cuál es el valor del bien? Con eso le confirmo.', toolCalls: [] };
    },
  };
}

function makeProvider(name) {
  return name === 'fake' ? createScriptedFake() : getProvider(name);
}

// ---------- un escenario ----------

let PAUSA_MS = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turnText = (t) => (typeof t === 'string' ? t : t.texto || '');
const turnMedia = (t) => (typeof t === 'string' ? [] : t.media || []);

async function runScenario(sc, index, provider) {
  const phone = `1809555${String(index + 1).padStart(4, '0')}`;
  const fixed = sc.ahora ? new Date(sc.ahora) : null;
  const replies = [];
  const turnEnds = [];
  const transcript = [];
  let error = null;
  const t0 = Date.now();
  for (let i = 0; i < sc.turnos.length; i++) {
    if (PAUSA_MS) await sleep(PAUSA_MS);
    const text = turnText(sc.turnos[i]); const media = turnMedia(sc.turnos[i]);
    const at = fixed ? new Date(fixed.getTime() + i * 60000) : new Date();
    const stored = text || media.map((m) => `[📷 ${m.media_type}]`).join(' ');
    await pool.query(`INSERT INTO messages (phone, direction, content, created_at) VALUES ($1,'inbound',$2,$3)`, [phone, stored, at]);
    // Los archivos inventados se pueden "leer" (leer_documento): cada uno queda en client_media con su análisis,
    // como en producción, y el bot no dice "no pude abrir su archivo".
    for (const m of media) {
      const wa = `eval-${phone}-${m.id}`;
      await pool.query(`INSERT INTO client_media (id, phone, wa_message_id, media_type, file_path) VALUES ($1,$2,$3,$4,'eval')
        ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, wa_message_id = EXCLUDED.wa_message_id`, [m.id, phone, wa, m.media_type]);
      await pool.query(`INSERT INTO messages (phone, direction, content, wa_message_id, created_at) VALUES ($1,'inbound',$2,$3,$4)`,
        [phone, `[📷 ${m.media_type} analizado]: ${m.analysis || ''}`, wa, new Date(at.getTime() - 1000)]);
    }
    transcript.push({ quien: 'Cliente', texto: stored });
    try {
      const reply = await respond(phone, text, {
        provider, now: at, media,
        deliver: async (out) => {
          const { rows } = await pool.query(
            `INSERT INTO messages (phone, direction, content, created_at) VALUES ($1,'outbound',$2,$3) RETURNING id`,
            [phone, out, new Date(at.getTime() + 1000)]);
          return rows[0].id;
        },
      });
      replies.push(reply || '');
      turnEnds.push((await pool.query('SELECT COUNT(*)::int AS n FROM bot_tool_log WHERE phone = $1', [phone])).rows[0].n);
      if (reply) transcript.push({ quien: 'Bot', texto: reply });
    } catch (err) {
      error = err.code || err.name || 'error';
      replies.push('');
      break;
    }
  }
  const { rows: log } = await pool.query(
    'SELECT herramienta, args, resultado, ok FROM bot_tool_log WHERE phone = $1 ORDER BY id', [phone]);
  const { fallas, violaciones, bloqueos } = evaluateScenario(sc, replies, log, turnEnds);
  if (error) fallas.push(`el escenario falló con error técnico (${error})`);
  return { sc, replies, transcript, log, fallas, violaciones, bloqueos, ms: Date.now() - t0, turnos: sc.turnos.length };
}

// ---------- juez de tono ----------

async function judge(judgeProvider, transcript) {
  try {
    const text = transcript.map((m) => `${m.quien}: ${m.texto}`).join('\n');
    const out = await judgeProvider.chat({ system: RUBRIC, messages: [{ role: 'user', text }], tools: [], timeoutMs: 25000 });
    const m = String(out.text || '').match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : out.text);
    const nota = Number(j.nota);
    if (!(nota >= 1 && nota <= 5)) return null;
    return { nota, motivo: String(j.motivo || '').slice(0, 200) };
  } catch { return null; }
}

// ---------- comparación con Leandro ----------

// Escenarios sacados de las capturas de Leandro (docs/bot-ia/ejemplos-leandro): `leandro` resume cómo respondió él.
const COMPARE = 'Comparas la respuesta del asistente de Gurú Soluciones con la de Leandro, el dueño, en la misma situación de WhatsApp. ' +
  'Recibes cómo respondió Leandro y la conversación del asistente. Califica de 1 a 5 si el asistente da la MISMA información y hace ' +
  'las MISMAS preguntas que Leandro (no importa la redacción ni el orden). 5 = lo mismo; 3 = la mitad; 1 = nada de lo de Leandro. ' +
  'Si el asistente dice un precio distinto al de Leandro, menciónalo. ' +
  'Responda únicamente con JSON, sin texto extra: {"nota": <1-5>, "motivo": "<qué le faltó o qué dijo distinto, una o dos frases en español>"}';

async function compareWithLeandro(judgeProvider, sc, transcript) {
  if (!sc.leandro) return null;
  try {
    const text = `Cómo respondió Leandro: ${sc.leandro}\n\nConversación del asistente:\n${transcript.map((m) => `${m.quien}: ${m.texto}`).join('\n')}`;
    const out = await judgeProvider.chat({ system: COMPARE, messages: [{ role: 'user', text }], tools: [], timeoutMs: 25000 });
    const m = String(out.text || '').match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : out.text);
    const nota = Number(j.nota);
    if (!(nota >= 1 && nota <= 5)) return null;
    return { nota, motivo: String(j.motivo || '').slice(0, 300) };
  } catch { return null; }
}

// ---------- reporte ----------

const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : 'n/d');

function buildReport(providerName, date, results, stats, info, judgeName) {
  const total = results.length;
  const viol = results.filter((r) => r.violaciones.length);
  const fail = results.filter((r) => r.fallas.length && !r.violaciones.length);
  const pass = results.filter((r) => !r.fallas.length && !r.violaciones.length);
  const bloqueos = results.reduce((a, r) => a + r.bloqueos, 0);
  const turns = results.reduce((a, r) => a + r.turnos, 0);
  const meanTurnMs = turns ? results.reduce((a, r) => a + r.ms, 0) / turns : NaN;
  const notas = results.map((r) => r.tono?.nota).filter((n) => Number.isFinite(n));
  const meanTone = notas.length ? notas.reduce((a, b) => a + b, 0) / notas.length : NaN;
  const known = stats.withUsage > 0;
  const tokens = stats.input + stats.output;
  const price = PRICES[providerName];
  const cost = known && price && Number.isFinite(price.in) && Number.isFinite(price.out)
    ? (stats.input * price.in + stats.output * price.out) / 1e6 : NaN;

  const L = [];
  L.push(`# Batería del bot — ${providerName} — ${date}`, '');
  L.push(`- Escenarios: ${total} | aprobados: ${pass.length} | fallas de \`espera\`: ${fail.length} | violaciones de \`prohibido\`: ${viol.length}`);
  L.push(`- Bloqueos del filtro: ${bloqueos} en ${results.filter((r) => r.bloqueos).length} escenario(s) (advertencia: el filtro cambió un monto por "se lo confirmo")`);
  L.push(`- Tiempo medio por turno (incluye herramientas): ${fmt(meanTurnMs)} ms`);
  L.push(`- Tokens aprox. (entrada/salida): ${known ? `${stats.input} / ${stats.output} (total ${tokens})` : 'n/d'}`);
  if (known && Number.isFinite(cost)) L.push(`- Costo estimado: USD ${fmt(cost, 4)} en total, USD ${fmt(cost / total, 4)} por conversación`);
  L.push(`- Nota media de tono (${judgeName}): ${fmt(meanTone, 2)} (${notas.length}/${total} calificados)`);
  L.push(`- Catálogo: ${info.servicios} servicios del snapshot + seeds/bot`, '');
  L.push('| # | Escenario | Resultado | Tono | ms | Motivos |', '|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    const res = r.violaciones.length ? 'VIOLA PROHIBIDO' : r.fallas.length ? 'FALLA' : 'OK';
    const why = [...(r.bloqueos ? [`ADVERTENCIA: ${r.bloqueos} bloqueo(s) del filtro`] : []), ...r.violaciones.map((v) => `PROHIBIDO: ${v}`), ...r.fallas].join('; ').replace(/\|/g, '/');
    L.push(`| ${i + 1} | ${r.sc.nombre} | ${res} | ${r.tono ? r.tono.nota : 'n/d'} | ${r.ms} | ${why} |`);
  });
  const caps = results.filter((r) => r.sc.leandro);
  if (caps.length) {
    const cn = caps.map((r) => r.comparacion?.nota).filter((n) => Number.isFinite(n));
    L.push('', `## Comparación con Leandro (capturas) — parecido medio ${fmt(cn.length ? cn.reduce((a, b) => a + b, 0) / cn.length : NaN, 2)} de 5`, '');
    L.push('| Captura | Resultado | Parecido | Qué faltó o cambió |', '|---|---|---|---|');
    for (const r of caps) {
      const res = r.violaciones.length ? 'VIOLA PROHIBIDO' : r.fallas.length ? 'FALLA' : 'OK';
      L.push(`| ${r.sc.nombre} | ${res} | ${r.comparacion ? r.comparacion.nota : 'n/d'} | ${(r.comparacion?.motivo || '').replace(/\|/g, '/')} |`);
    }
    for (const r of caps) {
      L.push('', `### ${r.sc.nombre}`, '', `Captura: \`docs/bot-ia/ejemplos-leandro/${r.sc.captura}\``, '', `**Leandro:** ${r.sc.leandro}`, '');
      for (const m of r.transcript) L.push(`- **${m.quien}:** ${String(m.texto).replace(/\n/g, ' / ')}`);
      if (r.fallas.length || r.violaciones.length) L.push(`- _Motivos: ${[...r.violaciones, ...r.fallas].join('; ')}_`);
    }
  }
  const bad = results.filter((r) => (r.fallas.length || r.violaciones.length) && !r.sc.leandro);
  if (bad.length) {
    L.push('', '## Conversaciones con problemas', '');
    for (const r of bad) {
      L.push(`### ${r.sc.nombre}`, '', `Herramientas: ${r.log.map((x) => `${x.herramienta}${x.ok === false ? '(error)' : ''}`).join(', ') || 'ninguna'}`, '');
      for (const m of r.transcript) L.push(`- **${m.quien}:** ${String(m.texto).replace(/\n/g, ' / ')}`);
      if (r.tono) L.push(`- _Tono ${r.tono.nota}: ${r.tono.motivo}_`);
      L.push('');
    }
  }
  return { text: L.join('\n') + '\n', summary: { providerName, total, pass: pass.length, fail: fail.length, viol: viol.length, meanTurnMs, tokens: known ? tokens : NaN, cost, meanTone } };
}

// ---------- principal ----------

async function runProvider(name, scenarios, judgeName, date) {
  const info = await setupDb();
  const inst = instrument(makeProvider(name));
  const judgeProvider = makeProvider(judgeName);
  const results = [];
  for (let i = 0; i < scenarios.length; i++) {
    const r = await runScenario(scenarios[i], i, inst);
    r.tono = await judge(judgeProvider, r.transcript);
    r.comparacion = await compareWithLeandro(judgeProvider, r.sc, r.transcript);
    results.push(r);
    console.log(`[eval] ${name} ${String(i + 1).padStart(2)}/${scenarios.length} ${r.violaciones.length ? 'VIOLA' : r.fallas.length ? 'falla' : 'ok'} ${r.sc.nombre}`);
  }
  const rep = buildReport(name, date, results, inst.stats, info, judgeName);
  fs.mkdirSync(RESULTADOS, { recursive: true });
  const file = path.join(RESULTADOS, `${date}-${name}.md`);
  fs.writeFileSync(file, rep.text);
  console.log(`[eval] ${name}: ${rep.summary.pass}/${rep.summary.total} ok, ${rep.summary.viol} violan prohibido → ${path.relative(ROOT, file)}`);
  return rep.summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  PAUSA_MS = args.pausa * 1000;
  const scenarios = loadScenarios(args.solo);
  if (!scenarios.length) throw new Error('Ningún escenario coincide con --solo');
  const date = new Date().toISOString().slice(0, 10);
  const names = args.provider === 'both' ? ['gemini', 'claude'] : [args.provider];
  const summaries = [];
  for (const n of names) summaries.push(await runProvider(n, scenarios, args.judge || n, date));
  if (summaries.length > 1) {
    const L = [`# Comparación Gemini vs Claude — ${date}`, '', '| Proveedor | Aprobados | Fallas | Violaciones | ms/turno | Tokens | Costo USD | Tono |', '|---|---|---|---|---|---|---|---|'];
    for (const s of summaries) L.push(`| ${s.providerName} | ${s.pass}/${s.total} | ${s.fail} | ${s.viol} | ${fmt(s.meanTurnMs)} | ${fmt(s.tokens)} | ${fmt(s.cost, 4)} | ${fmt(s.meanTone, 2)} |`);
    fs.writeFileSync(path.join(RESULTADOS, `${date}-comparacion.md`), L.join('\n') + '\n');
  }
  return summaries.some((s) => s.viol > 0) ? 1 : 0;
}

main()
  .then(async (code) => { await pool.end(); process.exit(code); })
  .catch(async (err) => { console.error('[eval] error:', String(err.message).replace(/postgres(ql)?:\/\/[^\s]*/gi, '[url]')); try { await pool.end(); } catch {} process.exit(2); });
