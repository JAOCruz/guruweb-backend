const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { pool } = require('./helpers/db');
const { classifyTipo, templatePages, fojasFor } = require('../scripts/fojas/classify');
const { applyFojas } = require('../scripts/fojas/apply');

const REDACTAR = 'Redactar o digitar un documento';

test('classifyTipo: reglas por nombre y categoría', () => {
  assert.equal(classifyTipo('Instancia - Recurso de Amparo', 'Redactar y Certificar una Traducción'), 'carta_motivada');
  assert.equal(classifyTipo('Instancia - Corrección', 'Redactar y Certificar una Traducción'), 'carta_simple');
  assert.equal(classifyTipo('Acto de Venta - Vehículo Liviano', REDACTAR), 'legal_simple');
  assert.equal(classifyTipo('Determinación de Herederos', REDACTAR), 'legal_motivada');
  assert.equal(classifyTipo('Nómina de Pagos/Presencia', REDACTAR), 'carta_motivada');
  assert.equal(classifyTipo('Traducción - Acta Natal (Idiomas básicos)', 'Redactar y Certificar una Traducción'), null);
  assert.equal(classifyTipo('Coletilla y Notarizar documento Fiel y Conforme', REDACTAR), null);
  assert.equal(classifyTipo('Original adicional o duplicado', REDACTAR), null);
});

function mkdocx(file, pages) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
  fs.mkdirSync(path.join(d, 'docProps'));
  fs.writeFileSync(path.join(d, 'docProps/app.xml'), `<Properties><Pages>${pages}</Pages></Properties>`);
  execFileSync('zip', ['-q', '-r', file, 'docProps'], { cwd: d });
}

test('templatePages y fojasFor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  mkdocx(path.join(dir, 'ACTO DE VENTA DE VEHÍCULO.docx'), 3);
  mkdocx(path.join(dir, 'sub', 'Carta de Poder.docx'), 2);
  fs.writeFileSync(path.join(dir, 'roto.docx'), 'no es zip');
  const m = templatePages(dir);
  assert.equal(m.get('acto de venta de vehiculo'), 3);
  assert.equal(m.get('carta de poder'), 2);
  assert.equal(m.has('roto'), false);
  assert.deepEqual(fojasFor('Carta de Poder', m), { fojas: 2, fuente: 'modelo: carta de poder' });
  assert.equal(fojasFor('Acto de Venta de Vehículo Liviano', m).fojas, 3);
  assert.deepEqual(fojasFor('Otra cosa', m), { fojas: 1, fuente: 'por defecto' });
  // Sin modelo: las fojas salen del precio anterior para que el precio no cambie de golpe.
  assert.deepEqual(fojasFor('Otra cosa', m, { precioAnterior: 500, tarifa: 250 }), { fojas: 2, fuente: 'estimado del precio anterior' });
  assert.deepEqual(fojasFor('Otra cosa', m, { precioAnterior: 1000, tarifa: 300 }), { fojas: 3, fuente: 'estimado del precio anterior' });
  assert.deepEqual(fojasFor('Otra cosa', m, { precioAnterior: 100, tarifa: 250 }), { fojas: 1, fuente: 'estimado del precio anterior' });
  assert.deepEqual(fojasFor('Otra cosa', m, { precioAnterior: null, tarifa: 250 }), { fojas: 1, fuente: 'por defecto' });
  assert.equal(fojasFor('Carta de Poder', m, { precioAnterior: 5000, tarifa: 250 }).fojas, 2); // el modelo manda
});

test('applyFojas: aplica 2 de 3 y dryRun no cambia nada', async () => {
  await pool.query('DROP TABLE IF EXISTS service_catalog CASCADE');
  await pool.query('CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, foja_tipo TEXT, fojas INT)');
  await pool.query(`INSERT INTO service_catalog (name) VALUES ('A'), ('B')`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fj-')), 'f.json');
  fs.writeFileSync(file, JSON.stringify([
    { nombre: 'A', foja_tipo: 'legal_simple', fojas: 2 },
    { nombre: 'B', foja_tipo: 'carta_simple', fojas: 1 },
    { nombre: 'Z', foja_tipo: 'carta_simple', fojas: 1 }]));
  const dry = await applyFojas({ file, dryRun: true });
  assert.equal(dry.aplicados, 2);
  assert.deepEqual(dry.saltados, ['Z']);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM service_catalog WHERE foja_tipo IS NOT NULL')).rows[0].n, 0);
  const r = await applyFojas({ file });
  assert.equal(r.aplicados, 2);
  assert.equal((await pool.query(`SELECT fojas FROM service_catalog WHERE name='A'`)).rows[0].fojas, 2);
  await pool.query('DROP TABLE service_catalog CASCADE');
});

test('excel.py genera un xlsx no vacío', { skip: spawnSync('python3', ['-c', 'import openpyxl']).status !== 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-'));
  const j = path.join(d, 'f.json'), x = path.join(d, 'o.xlsx');
  fs.writeFileSync(j, JSON.stringify([{ nombre: 'A', categoria: 'C', foja_tipo: 'carta_simple', fojas: 2, fuente: 'por defecto', precio_anterior: 100, precio_nuevo: 300 }]));
  execFileSync('python3', [path.join(__dirname, '..', 'scripts/fojas/excel.py'), j, x]);
  assert.ok(fs.statSync(x).size > 0);
});
