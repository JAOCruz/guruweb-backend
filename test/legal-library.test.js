// Biblioteca legal (Leandro, 2026-11-27): el bot da micro asesorías citando solo artículos de leyes cargadas y
// temas escritos por el equipo. Nada de citar leyes de memoria.
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitArticles } = require('../scripts/leyes/articulos');
const library = require('../src/legal/library');
const { buscar_ley } = require('../src/agent/tools/legal');

const FIXTURES = path.join(__dirname, 'fixtures', 'leyes');

test.before(async () => {
  await resetDb();
  await pool.query('DROP TABLE IF EXISTS legal_articles, legal_laws, legal_topics CASCADE');
});
test.after(async () => { await pool.end(); });

test('splitArticles separa por artículo, guarda la sección y no corta en una referencia a otro artículo', () => {
  const raw = [
    'Ley de prueba', 'CONSIDERANDO: algo', '',
    'TÍTULO I', 'DE LOS AUSENTES', '',
    'Artículo 1.- Objeto. Esta ley regula la ausencia de las perso-',
    'nas desaparecidas.', '',
    'Artículo 2.- Plazo. Se aplica lo dispuesto en el',
    'Artículo 1 de la presente ley.', '- 3 -',
    'Art. 3.- Final. Fin.',
  ].join('\n');
  const a = splitArticles(raw);
  assert.deepEqual(a.map((x) => x.num), ['1', '2', '3']);
  assert.equal(a[0].text, 'Objeto. Esta ley regula la ausencia de las personas desaparecidas.');
  assert.equal(a[0].section, 'TÍTULO I DE LOS AUSENTES');
  assert.match(a[1].text, /Artículo 1 de la presente ley\.$/);
});

test('sin las tablas (migración sin correr) la búsqueda no rompe al bot', async () => {
  const r = await buscar_ley({ consulta: 'duplicado de titulo' }, {});
  assert.ok(r.error);
});

test('carga las leyes y los temas; una segunda carga sin cambios no rehace nada', async () => {
  await runSqlFile('migrations/20261127_biblioteca_legal.sql');
  await runSqlFile('migrations/20261127_biblioteca_legal.sql'); // idempotente
  let r = await library.loadLegalLibrary({ dir: FIXTURES });
  assert.deepEqual(r.loaded, ['ley-prueba']);
  assert.equal(r.topics, 2);
  const { rows } = await pool.query('SELECT article_count, short FROM legal_laws');
  assert.equal(rows[0].article_count, 3);
  r = await library.loadLegalLibrary({ dir: FIXTURES });
  assert.deepEqual(r.loaded, []);
  assert.equal(r.topics, 0);
});

test('una versión nueva de la ley reemplaza sus artículos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leyes-'));
  const law = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'ley-prueba.json'), 'utf8'));
  law.articles = law.articles.slice(0, 2);
  fs.writeFileSync(path.join(dir, 'ley-prueba.json'), JSON.stringify(law));
  const r = await library.loadLegalLibrary({ dir });
  assert.deepEqual(r.loaded, ['ley-prueba']);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM legal_articles WHERE law_code = 'ley-prueba'`);
  assert.equal(rows[0].n, 2);
  await library.loadLegalLibrary({ dir: FIXTURES }); // vuelve a la de 3
});

test('busca sin importar acentos y devuelve ley, artículo, texto y fuente', async () => {
  const r = await buscar_ley({ consulta: 'perdida del certificado de titulo duplicado' }, {});
  const art = r.articulos.find((a) => a.articulo === '92');
  assert.ok(art, 'debe encontrar el art. 92');
  assert.equal(art.ley, 'Ley 108-05 de Registro Inmobiliario');
  assert.equal(art.fuente, 'https://example.gob.do/108-05.pdf');
  assert.match(art.texto, /copia fiel/);
  assert.equal(r.temas[0].titulo, 'Duplicado de título por pérdida: entrevista virtual');
  assert.equal(r.temas[0].base_legal, 'Ley 108-05, art. 92');
});

test('«artículo 93 de la 108-05» trae ese artículo directo', async () => {
  const r = await buscar_ley({ consulta: 'que dice el articulo 93 de la ley 108-05' }, {});
  assert.equal(r.articulos[0].articulo, '93');
});

test('las instituciones salen con su enlace', async () => {
  const r = await buscar_ley({ consulta: 'donde saco un acta de nacimiento' }, {});
  const jce = r.temas.find((t) => t.titulo.startsWith('Junta Central Electoral'));
  assert.equal(jce.enlace, 'https://jce.gob.do');
  assert.equal(jce.tipo, 'institucion');
});

test('sin resultados lo dice claro para que el bot no invente', async () => {
  const r = await buscar_ley({ consulta: 'astronautas marcianos' }, {});
  assert.deepEqual(r.articulos, []);
  assert.deepEqual(r.temas, []);
  assert.match(r.nota, /no cite/i);
});

test('un tema editado por el equipo no lo pisa la carga de temas', async () => {
  await pool.query(`UPDATE legal_topics SET body = 'Editado por Leandro', source = 'manual' WHERE seed_key = 'tema-duplicado-titulo'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leyes-'));
  const temas = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'temas.json'), 'utf8'));
  temas[0].body = 'Texto nuevo de la semilla';
  fs.writeFileSync(path.join(dir, 'temas.json'), JSON.stringify(temas));
  await library.loadLegalLibrary({ dir });
  const { rows } = await pool.query(`SELECT body FROM legal_topics WHERE seed_key = 'tema-duplicado-titulo'`);
  assert.equal(rows[0].body, 'Editado por Leandro');
});
