// Captura 04: un documento extranjero de varias páginas (libro de matrimonio en sueco, 5 hojas) es "desde RD$800 por
// página", no el acta extranjera (RD$1,000 por documento) multiplicada por página.
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIG = 'migrations/20261029_traduccion_varias_paginas.sql';
const ACTA = 'Traducción - Acta Extranjera al Español';
const VARIAS = 'Traducción - Varias Páginas, Solo Texto (Documento Extranjero)';

test.before(async () => {
  await createAgentSchema();
  await pool.query(`INSERT INTO service_categories (name) VALUES ('Traducciones')`);
  await pool.query(`INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, reglas, alias) VALUES
    ($1, 1, 1000, 'por documento', 'Se cobra por página, considerando el formato.', ARRAY['acta extranjera al español']),
    ($2, 1, 800, 'por página', 'Se cobra por página.', ARRAY['traducir contrato extranjero'])`, [ACTA, VARIAS]);
  await runSqlFile(MIG);
  await runSqlFile(MIG); // idempotente
});
test.after(() => pool.end());

const one = async (name) => (await pool.query('SELECT * FROM service_catalog WHERE name = $1', [name])).rows[0];

test('el acta extranjera se cobra por documento y manda los de varias páginas al servicio por página', async () => {
  const a = await one(ACTA);
  assert.doesNotMatch(a.reglas, /Se cobra por página/);
  assert.match(a.reglas, /por documento/);
  assert.match(a.reglas, /Varias Páginas/);
  assert.equal(Number(a.digitacion_price), 1000);
});

test('varias páginas extranjero: los libros y documentos de varias hojas lo encuentran, sin alias repetidos', async () => {
  const v = await one(VARIAS);
  for (const al of ['libro de matrimonio', 'libro de familia', 'documento extranjero de varias paginas']) assert.ok(v.alias.includes(al), al);
  assert.equal(new Set(v.alias).size, v.alias.length);
  assert.equal(Number(v.digitacion_price), 800);
  assert.match(v.reglas, /desde/);
});
