// Panel de la biblioteca legal: todos leen y prueban la búsqueda; solo el admin escribe temas.
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { generateToken } = require('../src/middleware/auth');
const library = require('../src/legal/library');

let server, base, tok = {};

test.before(async () => {
  await resetDb();
  await pool.query('DROP TABLE IF EXISTS legal_articles, legal_laws, legal_topics, activity_log CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20261127_biblioteca_legal.sql');
  await library.loadLegalLibrary({ dir: path.join(__dirname, 'fixtures', 'leyes') });
  for (const [u, role] of [['adm', 'admin'], ['dig', 'digitador']]) {
    const { rows } = await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES ($1,$2,'x',$1,$3) RETURNING id, username, email, role`, [u, `${u}@t.co`, role]);
    tok[u] = generateToken(rows[0]);
  }
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/legal', require('../src/routes/legal'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, p, who, body) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who && { Authorization: `Bearer ${tok[who]}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });

test('pide sesión; cualquier usuario ve las leyes cargadas y los temas', async () => {
  assert.equal((await call('GET', '/api/legal/topics')).status, 401);
  const laws = await (await call('GET', '/api/legal/laws', 'dig')).json();
  assert.deepEqual(laws.laws.map((l) => [l.short, l.article_count]), [['Ley 108-05 de Registro Inmobiliario', 3]]);
  assert.equal(laws.laws[0].source_url, 'https://example.gob.do/108-05.pdf');
  const topics = await (await call('GET', '/api/legal/topics', 'dig')).json();
  assert.equal(topics.topics.length, 2);
});

test('probar la búsqueda: lo mismo que vería el bot', async () => {
  const r = await (await call('GET', '/api/legal/search?q=duplicado%20de%20titulo', 'dig')).json();
  assert.equal(r.articulos[0].articulo, '92');
  assert.ok(r.temas.length >= 1);
});

test('solo el admin crea, edita y desactiva temas; editar marca el tema como del equipo', async () => {
  const body = { kind: 'tema', title: 'Salida de menores', keywords: 'viaje menor permiso', body: 'Explicación del equipo.', legal_basis: 'Ley 136-03, art. 204' };
  assert.equal((await call('POST', '/api/legal/topics', 'dig', body)).status, 403);
  assert.equal((await call('POST', '/api/legal/topics', 'adm', { ...body, body: ' ' })).status, 400);
  let res = await call('POST', '/api/legal/topics', 'adm', body);
  assert.equal(res.status, 201);
  const { topic } = await res.json();
  assert.equal(topic.source, 'manual');

  const found = await (await call('GET', '/api/legal/search?q=permiso%20de%20viaje%20menor', 'dig')).json();
  assert.equal(found.temas[0].titulo, 'Salida de menores');

  const seed = (await pool.query(`SELECT id FROM legal_topics WHERE seed_key = 'inst-jce'`)).rows[0].id;
  res = await call('PUT', `/api/legal/topics/${seed}`, 'adm', { body: 'Actas y cédulas (editado)' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).topic.source, 'manual');

  res = await call('PUT', `/api/legal/topics/${topic.id}`, 'adm', { active: false });
  assert.equal((await res.json()).topic.active, false);
  const after = await (await call('GET', '/api/legal/search?q=permiso%20de%20viaje%20menor', 'dig')).json();
  assert.ok(!after.temas.some((t) => t.titulo === 'Salida de menores'));
  assert.equal((await call('PUT', `/api/legal/topics/${topic.id}`, 'dig', { active: true })).status, 403);
  const log = await pool.query(`SELECT COUNT(*)::int AS n FROM activity_log WHERE category = 'leyes'`);
  assert.ok(log.rows[0].n >= 3);
});
