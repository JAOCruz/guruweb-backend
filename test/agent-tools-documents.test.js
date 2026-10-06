process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const legalProfile = require('../src/documentos/legalProfile');
const { listBlocks } = require('../src/documentos/docxText');
const { clearCache } = require('../src/agent/businessInfo');
const { ver_modelo, preparar_documento, invoiceFor } = require('../src/agent/tools/documents');

// El llenado del Word pasa por docx_text.py (python-docx); sin él, esas pruebas se saltan como en documentos-etiquetas.
const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;
const needsDocx = { skip: !hasDocx };

// Modelo etiquetado y aprobado: {{NOMBRE_VENDEDOR}} y {{NOMBRE_COMPRADOR}} (cada uno aparece dos veces)
const FIXTURE = path.join(__dirname, 'fixtures', 'venta-etiquetada.docx');
const TAGS = [
  { key: 'NOMBRE_VENDEDOR', label: 'Nombre del vendedor', group: 'VENDEDOR' },
  { key: 'NOMBRE_COMPRADOR', label: 'Nombre del comprador', group: 'COMPRADOR' },
];
// El mismo Word etiquetado con un solo rol (como una declaración jurada): las dos etiquetas son del VENDEDOR
const ONE_ROLE_TAGS = [
  { key: 'NOMBRE_VENDEDOR', label: 'Nombre', group: 'VENDEDOR' },
  { key: 'NOMBRE_COMPRADOR', label: 'Nombre del testigo', group: 'VENDEDOR' },
];

const PHONE = '18095550121';
let ctx, botUserId, adminId, digId, clientId, ids;

async function version(templateId, { approve, tags = TAGS }) {
  const { rows } = await pool.query(
    `INSERT INTO template_tag_versions (template_id, version_number, file_path, tags, source) VALUES ($1, 1, $2, $3, 'ai') RETURNING id`,
    [templateId, FIXTURE, JSON.stringify(tags)]);
  if (approve) await pool.query('UPDATE doc_templates SET approved_tag_version_id = $1 WHERE id = $2', [rows[0].id, templateId]);
  return rows[0].id;
}

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS notifications, bot_tool_log, bot_memory, business_info, tramites, invoices, service_catalog, service_categories,
    template_tag_versions, legal_profiles, portfolio_versions, portfolio_documents, doc_templates, doc_categories, clients CASCADE`);
  await pool.query(`CREATE TABLE service_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, category_id INT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB DEFAULT '[]', unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY, doc_number TEXT, status TEXT NOT NULL DEFAULT 'draft', client_id INT, total NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE, name VARCHAR(255), assigned_to INT, user_id INT, email VARCHAR(255), address TEXT, notes TEXT, source VARCHAR(20) DEFAULT 'whatsapp', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(255) NOT NULL, message TEXT NOT NULL, link TEXT, read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261002_template_tags.sql');
  await runSqlFile('migrations/20261005_bot_agent.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  clearCache();
  const mk = async (u, role, name) => (await pool.query(
    `INSERT INTO users (username, email, password_hash, name, role) VALUES ($1,$2,'x',$3,$4) RETURNING id`, [u, `${u}@t.co`, name, role])).rows[0].id;
  adminId = await mk('adm', 'admin', 'Admin Uno');
  digId = await mk('dig', 'digitador', 'Digi Tador');
  botUserId = (await pool.query(`SELECT id FROM users WHERE username='bot'`)).rows[0].id;

  const tpl = async (name, file) => (await pool.query(
    `INSERT INTO doc_templates (name, file_path, file_name) VALUES ($1, $2, $2) RETURNING id`, [name, file])).rows[0].id;
  ids = {
    vehiculo: await tpl('ACTO DE VENTA DE VEHÍCULO', 'vehiculo.docx'),
    inmueble: await tpl('ACTO DE VENTA DE INMUEBLE', 'inmueble.docx'),
    solar: await tpl('ACTO DE VENTA DE SOLAR', 'solar.docx'), // etiquetado, sin aprobar
    poder: await tpl('PODER GENERAL', 'poder.docx'),           // etiquetado, sin aprobar
    carta: await tpl('CARTA DE NO OBJECIÓN', 'carta.docx'),    // sin etiquetar
    declaracion: await tpl('DECLARACIÓN JURADA', 'declaracion.docx'), // un solo rol
  };
  await version(ids.vehiculo, { approve: true });
  await version(ids.inmueble, { approve: true });
  await version(ids.declaracion, { approve: true, tags: ONE_ROLE_TAGS });
  await version(ids.solar, { approve: false });
  await version(ids.poder, { approve: false });

  const svc = async (name, templateId) => (await pool.query(
    `INSERT INTO service_catalog (name, digitacion_price, template_id) VALUES ($1, 500, $2) RETURNING id`, [name, templateId])).rows[0].id;
  ids.svcVehiculo = await svc('Acto de Venta de Vehículo', String(ids.vehiculo));
  ids.svcSolar = await svc('Acto de Venta de Solar', String(ids.solar));
  ids.svcPoder = await svc('Poder General', String(ids.poder));
  ids.svcCarta = await svc('Carta de No Objeción', null);
  ids.svcVenta = await svc('Venta de Vehículo', null); // sin modelo ligado: se busca por el nombre del servicio

  clientId = (await pool.query(`INSERT INTO clients (phone, name, assigned_to) VALUES ($1, 'Ana Cliente', $2) RETURNING id`, [PHONE, digId])).rows[0].id;
  await legalProfile.merge(clientId, { NOMBRE: 'ANA CLIENTE', 'DOCUMENTO IDENTIDAD': '001-0000000-1' }, adminId);
  const client = (await pool.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
  ctx = { phone: PHONE, client, botUserId, now: new Date() };
});
test.after(async () => { await pool.end(); });

const docs = async () => (await pool.query('SELECT * FROM portfolio_documents ORDER BY id')).rows;
const notifs = async () => (await pool.query(`SELECT * FROM notifications WHERE type='document' ORDER BY id`)).rows;

test('ver_modelo devuelve las etiquetas y lo que ya está en la ficha', async () => {
  const r = await ver_modelo({ servicio_id: ids.svcVehiculo, rol_cliente: 'VENDEDOR' }, ctx);
  assert.equal(r.error, undefined);
  assert.equal(r.modelo_id, ids.vehiculo);
  assert.equal(r.nombre, 'ACTO DE VENTA DE VEHÍCULO');
  assert.deepEqual(r.etiquetas, [
    { clave: 'NOMBRE_VENDEDOR', etiqueta: 'Nombre del vendedor', rol: 'VENDEDOR' },
    { clave: 'NOMBRE_COMPRADOR', etiqueta: 'Nombre del comprador', rol: 'COMPRADOR' },
  ]);
  assert.deepEqual(r.ya_tenemos, { NOMBRE_VENDEDOR: 'ANA CLIENTE' });
  assert.deepEqual(r.faltan, ['NOMBRE_COMPRADOR']);
  assert.deepEqual(r.roles, ['VENDEDOR', 'COMPRADOR']);
  assert.ok(!('precio' in r) && !('total' in r));

  // sin rol_cliente y con varios roles no se adivina de quién es el nombre de la ficha
  const sinRol = await ver_modelo({ servicio_id: ids.svcVehiculo }, ctx);
  assert.deepEqual(sinRol.ya_tenemos, {});
  assert.deepEqual(sinRol.faltan, ['NOMBRE_VENDEDOR', 'NOMBRE_COMPRADOR']);

  // por nombre (sin acentos, minúsculas) entre los modelos aprobados
  const porNombre = await ver_modelo({ nombre: 'acto de venta de vehiculo', rol_cliente: 'VENDEDOR' }, ctx);
  assert.equal(porNombre.modelo_id, ids.vehiculo);
  // un servicio sin modelo ligado se busca por su nombre
  assert.equal((await ver_modelo({ servicio_id: ids.svcVenta }, ctx)).modelo_id, ids.vehiculo);
  // un nombre que empata con varios aprobados pide que se elija
  const varios = await ver_modelo({ nombre: 'acto de venta' }, ctx);
  assert.equal(varios.error, 'varios modelos');
  assert.deepEqual(varios.opciones.sort(), ['ACTO DE VENTA DE INMUEBLE', 'ACTO DE VENTA DE VEHÍCULO']);
});

test('ver_modelo de un servicio sin modelo aprobado → error', async () => {
  // servicio ligado a un modelo etiquetado pero sin aprobar: no se cambia por otro parecido aunque se llame casi igual
  assert.deepEqual(await ver_modelo({ servicio_id: ids.svcSolar }, ctx), { error: 'sin modelo aprobado' });
  assert.deepEqual(await ver_modelo({ servicio_id: ids.svcSolar, nombre: 'acto de venta' }, ctx), { error: 'sin modelo aprobado' });
  assert.deepEqual(await ver_modelo({ servicio_id: ids.svcPoder }, ctx), { error: 'sin modelo aprobado' });
  // por nombre, todas las palabras tienen que estar en el nombre del modelo
  assert.deepEqual(await ver_modelo({ nombre: 'venta solar' }, ctx), { error: 'sin modelo aprobado' });
  // servicio sin modelo ligado y cuyo nombre no empata con ningún aprobado
  assert.deepEqual(await ver_modelo({ servicio_id: ids.svcCarta }, ctx), { error: 'sin modelo aprobado' });
  assert.deepEqual(await ver_modelo({ nombre: 'poder general' }, ctx), { error: 'sin modelo aprobado' });
  assert.deepEqual(await ver_modelo({ servicio_id: 99999 }, ctx), { error: 'sin modelo aprobado' });
  assert.equal((await ver_modelo({}, ctx)).error, 'indique servicio_id o nombre');
});

test('preparar_documento con un valor faltante no crea nada y dice cuáles faltan', needsDocx, async () => {
  const r = await preparar_documento({ modelo_id: ids.vehiculo, valores: { NOMBRE_COMPRADOR: '   ' }, rol_cliente: 'VENDEDOR' }, ctx);
  assert.deepEqual(r, { error: 'faltan datos', faltan: ['NOMBRE_COMPRADOR'] });
  assert.equal((await docs()).length, 0);
  assert.equal((await notifs()).length, 0);
  assert.deepEqual(await legalProfile.get(clientId), { NOMBRE: 'ANA CLIENTE', 'DOCUMENTO IDENTIDAD': '001-0000000-1' });
});

test('con varios roles hay que decir cuál es el cliente', async () => {
  const sinRol = await preparar_documento({ modelo_id: ids.vehiculo, valores: { NOMBRE_VENDEDOR: 'A', NOMBRE_COMPRADOR: 'B' } }, ctx);
  assert.deepEqual(sinRol, { error: 'falta rol_cliente', roles: ['VENDEDOR', 'COMPRADOR'] });
  assert.equal((await docs()).length, 0);
});

test('un rol_cliente que el modelo no tiene se rechaza en las dos herramientas', async () => {
  const esperado = { error: 'rol_cliente inválido', roles: ['VENDEDOR', 'COMPRADOR'] };
  assert.deepEqual(await ver_modelo({ servicio_id: ids.svcVehiculo, rol_cliente: 'NOTARIO' }, ctx), esperado);
  assert.deepEqual(await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'NOTARIO', valores: { NOMBRE_VENDEDOR: 'A', NOMBRE_COMPRADOR: 'B' } }, ctx), esperado);
  assert.equal((await docs()).length, 0);
  // minúsculas y espacios se toleran
  assert.deepEqual((await ver_modelo({ servicio_id: ids.svcVehiculo, rol_cliente: ' vendedor ' }, ctx)).ya_tenemos, { NOMBRE_VENDEDOR: 'ANA CLIENTE' });
});

test('preparar_documento llena el Word, crea el borrador del bot ligado a la cotización y guarda en la ficha', needsDocx, async () => {
  const inv = async (status, daysAgo) => (await pool.query(
    `INSERT INTO invoices (doc_number, status, client_id, total, created_at) VALUES ($1, $2, $3, 1, NOW() - ($4 || ' days')::interval) RETURNING id`,
    [`COT-${status}-${daysAgo}`, status, clientId, daysAgo])).rows[0].id;
  await inv('pending_approval', 5);
  const vieja = await inv('approved', 3);
  const reciente = await inv('pending_approval', 1);
  await inv('paid', 10);                // pagada, pero más vieja que las otras
  const ajena = (await pool.query(`INSERT INTO invoices (doc_number, status, client_id, total) VALUES ('COT-X', 'approved', 999, 1) RETURNING id`)).rows[0].id;

  const r = await preparar_documento({
    modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR',
    valores: { NOMBRE_VENDEDOR: 'ANA CLIENTE GÓMEZ', nombre_comprador: ' LUIS DÍAZ ' },
  }, ctx);
  assert.equal(r.error, undefined);
  assert.equal(r.estado, 'por_aprobar');
  assert.equal(r.titulo, 'ACTO DE VENTA DE VEHÍCULO — Ana Cliente');
  assert.ok(Number.isInteger(r.documento_id));

  const [d] = await docs();
  assert.equal(d.id, r.documento_id);
  assert.equal(d.client_id, clientId);
  assert.equal(d.template_id, ids.vehiculo);
  assert.equal(d.created_by, botUserId);
  assert.equal(d.prepared_by_bot, true);
  assert.equal(d.invoice_id, reciente);
  assert.equal(d.approved_version_id, null);
  assert.equal(d.title, r.titulo);

  const { rows: [v] } = await pool.query('SELECT * FROM portfolio_versions WHERE document_id = $1', [d.id]);
  assert.equal(v.source, 'generated');
  assert.equal(v.notes, 'Preparado por el bot');
  assert.equal(v.created_by, botUserId);
  assert.equal(v.mime_type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(fs.existsSync(v.file_path));
  assert.ok(v.size_bytes > 0);
  assert.deepEqual((await listBlocks(v.file_path)).map((b) => b.text), [
    'ACTO DE VENTA DE VEHICULO',
    'Yo, ANA CLIENTE GÓMEZ, vendo a LUIS DÍAZ el vehículo.',
    'Firman: ANA CLIENTE GÓMEZ y LUIS DÍAZ.',
  ]);

  // la ficha guarda lo del cliente (rol VENDEDOR), no lo de la otra parte
  const ficha = await legalProfile.get(clientId);
  assert.equal(ficha.NOMBRE, 'ANA CLIENTE GÓMEZ');
  assert.equal(ficha['DOCUMENTO IDENTIDAD'], '001-0000000-1');
  assert.ok(!Object.values(ficha).includes('LUIS DÍAZ'));

  // avisa a los admins (switch apagado: el digitador asignado no)
  const n = await notifs();
  assert.deepEqual(n.map((x) => x.user_id), [adminId]);
  assert.equal(n[0].title, '📄 Documento preparado por el bot: ACTO DE VENTA DE VEHÍCULO — Ana Cliente');
  assert.equal(n[0].link, '/documentos');
  assert.equal(n[0].metadata.document_id, d.id);

  // invoice_id explícito: se usa si es del cliente; si es ajeno, la más reciente del cliente
  const r2 = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR', valores: { NOMBRE_COMPRADOR: 'PEDRO' }, invoice_id: vieja }, ctx);
  assert.equal((await docs()).find((x) => x.id === r2.documento_id).invoice_id, vieja);
  const r3 = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR', valores: { NOMBRE_COMPRADOR: 'PEDRO' }, invoice_id: ajena }, ctx);
  assert.equal((await docs()).find((x) => x.id === r3.documento_id).invoice_id, reciente);
});

test('con el switch encendido también avisa al digitador asignado', needsDocx, async () => {
  await pool.query(`UPDATE business_info SET valor = 'true'::jsonb WHERE clave = 'digitadores_aprueban_documentos'`);
  clearCache();
  const r = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR', valores: { NOMBRE_COMPRADOR: 'LUIS DÍAZ' } }, ctx);
  assert.equal(r.estado, 'por_aprobar');
  assert.deepEqual((await notifs()).map((x) => x.user_id).sort(), [adminId, digId].sort());
  const [d] = await docs();
  assert.equal(d.invoice_id, null); // sin cotización en curso
});

test('si falla la ficha o el aviso después de crear el borrador, la herramienta igual responde bien', needsDocx, async () => {
  await pool.query(`CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER boom_ficha BEFORE INSERT OR UPDATE ON legal_profiles FOR EACH ROW EXECUTE FUNCTION boom()`);
  await pool.query(`CREATE TRIGGER boom_aviso BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION boom()`);
  try {
    // NOMBRE_VENDEDOR es del cliente: con él la ficha sí se intenta guardar (y el trigger la hace fallar)
    const r = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR', valores: { NOMBRE_VENDEDOR: 'ANA CLIENTE GÓMEZ', NOMBRE_COMPRADOR: 'LUIS DÍAZ' } }, ctx);
    assert.equal(r.error, undefined);
    assert.equal(r.estado, 'por_aprobar');
    assert.equal((await docs()).length, 1);
    assert.equal((await notifs()).length, 0);
    assert.equal((await legalProfile.get(clientId)).NOMBRE, 'ANA CLIENTE'); // la ficha no cambió, pero el borrador sí quedó
  } finally {
    await pool.query('DROP FUNCTION boom() CASCADE');
  }
});

test('un modelo con etiquetas pero sin versión aprobada no se puede usar', async () => {
  const r = await preparar_documento({ modelo_id: ids.poder, rol_cliente: 'VENDEDOR', valores: { NOMBRE_VENDEDOR: 'A', NOMBRE_COMPRADOR: 'B' } }, ctx);
  assert.deepEqual(r, { error: 'sin modelo aprobado' });
  assert.deepEqual(await preparar_documento({ modelo_id: ids.carta, valores: {} }, ctx), { error: 'sin modelo aprobado' });
  assert.deepEqual(await preparar_documento({ modelo_id: 99999, valores: {} }, ctx), { error: 'sin modelo aprobado' });
  assert.equal((await docs()).length, 0);
  assert.equal((await notifs()).length, 0);
});

// ── Revisión final: I1 enlace con cotizaciones enviadas/pagadas; I4 documentos para un tercero ──

test('I1: el documento se liga a la cotización más reciente por aprobar/aprobada/enviada, y acepta el invoice_id de preparar_cotizacion', needsDocx, async () => {
  const inv = async (status, daysAgo) => (await pool.query(
    `INSERT INTO invoices (doc_number, status, client_id, total, created_at) VALUES ($1, $2, $3, 1, NOW() - ($4 || ' days')::interval) RETURNING id`,
    [`COT-${status}-${daysAgo}`, status, clientId, daysAgo])).rows[0].id;
  const vieja = await inv('approved', 3);
  const enviada = await inv('sent', 1); // "Aprobar y enviar" la dejó en sent antes de que el bot preparara el documento
  await inv('rejected', 0);
  await inv('draft', 0);
  const ajena = (await pool.query(`INSERT INTO invoices (doc_number, status, client_id, total) VALUES ('COT-X', 'sent', 999, 1) RETURNING id`)).rows[0].id;

  const r = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR', valores: { NOMBRE_COMPRADOR: 'LUIS DÍAZ' } }, ctx);
  assert.equal(r.estado, 'por_aprobar');
  assert.equal((await docs()).find((d) => d.id === r.documento_id).invoice_id, enviada);

  // Pagada y más reciente: sin invoice_id explícito NO se liga (podría ser un pago viejo)
  const pagada = await inv('paid', 0);
  const r2 = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR', valores: { NOMBRE_COMPRADOR: 'LUIS DÍAZ' } }, ctx);
  assert.equal((await docs()).find((d) => d.id === r2.documento_id).invoice_id, enviada);

  // El invoice_id que devolvió preparar_cotizacion (numérico) se respeta, aunque no sea la más reciente
  const r3 = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR', valores: { NOMBRE_COMPRADOR: 'LUIS DÍAZ' }, invoice_id: vieja }, ctx);
  assert.equal((await docs()).find((d) => d.id === r3.documento_id).invoice_id, vieja);
  // Nunca la de otro cliente
  const r4 = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'VENDEDOR', valores: { NOMBRE_COMPRADOR: 'LUIS DÍAZ' }, invoice_id: ajena }, ctx);
  assert.equal((await docs()).find((d) => d.id === r4.documento_id).invoice_id, enviada);
});

test('I4: ver_modelo con un solo rol llena desde la ficha; para un tercero (para_tercero o rol_cliente NINGUNO) no', async () => {
  const propio = await ver_modelo({ nombre: 'declaración jurada' }, ctx);
  assert.equal(propio.error, undefined);
  assert.deepEqual(propio.roles, ['VENDEDOR']);
  assert.deepEqual(propio.ya_tenemos, { NOMBRE_VENDEDOR: 'ANA CLIENTE' });
  assert.deepEqual(propio.faltan, ['NOMBRE_COMPRADOR']);

  const tercero = await ver_modelo({ nombre: 'declaración jurada', para_tercero: true }, ctx);
  assert.equal(tercero.error, undefined);
  assert.deepEqual(tercero.ya_tenemos, {});
  assert.deepEqual(tercero.faltan, ['NOMBRE_VENDEDOR', 'NOMBRE_COMPRADOR']);
  assert.deepEqual(await ver_modelo({ nombre: 'declaración jurada', rol_cliente: 'ninguno' }, ctx), tercero);
  // también con varios roles: ni se pide el rol ni se adivina nada
  const venta = await ver_modelo({ servicio_id: ids.svcVehiculo, para_tercero: true }, ctx);
  assert.equal(venta.error, undefined);
  assert.deepEqual(venta.ya_tenemos, {});
});

test('I4: preparar_documento para un tercero no llena desde la ficha ni escribe en ella', needsDocx, async () => {
  // Sin para_tercero: el nombre del cliente sale de la ficha y lo nuevo se guarda
  const propio = await preparar_documento({ modelo_id: ids.declaracion, valores: { NOMBRE_COMPRADOR: 'PEDRO TESTIGO' } }, ctx);
  assert.equal(propio.estado, 'por_aprobar');
  let [v] = (await pool.query('SELECT file_path FROM portfolio_versions WHERE document_id = $1', [propio.documento_id])).rows;
  assert.match((await listBlocks(v.file_path)).map((b) => b.text).join(' '), /ANA CLIENTE, vendo a PEDRO TESTIGO/);
  const ficha = await legalProfile.get(clientId); // lo que quedó en la ficha tras el documento propio

  // Para un tercero: hay que pasar todo
  const faltan = await preparar_documento({ modelo_id: ids.declaracion, para_tercero: true, valores: { NOMBRE_COMPRADOR: 'PEDRO TESTIGO' } }, ctx);
  assert.deepEqual(faltan, { error: 'faltan datos', faltan: ['NOMBRE_VENDEDOR'] });

  const tercero = await preparar_documento({
    modelo_id: ids.declaracion, para_tercero: true, valores: { NOMBRE_VENDEDOR: 'MARÍA GÓMEZ', NOMBRE_COMPRADOR: 'PEDRO TESTIGO' },
  }, ctx);
  assert.equal(tercero.estado, 'por_aprobar');
  assert.equal(tercero.titulo, 'DECLARACIÓN JURADA — Ana Cliente');
  const d = (await docs()).find((x) => x.id === tercero.documento_id);
  assert.equal(d.client_id, clientId); // el pedido sigue siendo del cliente del chat
  assert.equal(d.prepared_by_bot, true);
  [v] = (await pool.query('SELECT file_path FROM portfolio_versions WHERE document_id = $1', [tercero.documento_id])).rows;
  assert.match((await listBlocks(v.file_path)).map((b) => b.text).join(' '), /MARÍA GÓMEZ, vendo a PEDRO TESTIGO/);
  // La ficha del cliente no cambió: MARÍA GÓMEZ no entra en ella
  assert.deepEqual(await legalProfile.get(clientId), ficha);
  assert.equal(ficha.NOMBRE, 'ANA CLIENTE');
  assert.ok(!Object.values(ficha).includes('MARÍA GÓMEZ'));

  // Con varios roles y para_tercero no hace falta rol_cliente, y tampoco se toca la ficha
  const venta = await preparar_documento({ modelo_id: ids.vehiculo, rol_cliente: 'NINGUNO', valores: { NOMBRE_VENDEDOR: 'JOSÉ PÉREZ', NOMBRE_COMPRADOR: 'LUIS DÍAZ' } }, ctx);
  assert.equal(venta.estado, 'por_aprobar');
  assert.deepEqual(await legalProfile.get(clientId), ficha);
  assert.equal((await notifs()).length, 3);
});

// ── Residual: nunca ligar un documento nuevo a una cotización pagada vieja ──

const mkInv = async (status, hoursAgo, client = clientId) => (await pool.query(
  `INSERT INTO invoices (doc_number, status, client_id, total, created_at) VALUES ($1, $2, $3, 1, NOW() - ($4 || ' hours')::interval) RETURNING id`,
  [`COT-${status}-${hoursAgo}`, status, client, String(hoursAgo)])).rows[0].id;

test('invoiceFor: solo hay una cotización pagada vieja y no se pasa invoice_id -> null', async () => {
  await mkInv('paid', 24 * 10);
  await mkInv('paid', 1); // ni siquiera una pagada reciente
  assert.equal(await invoiceFor(clientId, undefined), null);
});

test('invoiceFor: una pagada del cliente se liga si se pasa explícita', async () => {
  const pagada = await mkInv('paid', 24 * 10);
  assert.equal(await invoiceFor(clientId, pagada), pagada);
  assert.equal(await invoiceFor(clientId, String(pagada)), pagada);
  const ajena = await mkInv('paid', 1, 999);
  assert.equal(await invoiceFor(clientId, ajena), null); // nunca de otro cliente
});

test('invoiceFor: una por aprobar de más de 48 h no la toma el respaldo; una de menos sí', async () => {
  await mkInv('pending_approval', 49);
  assert.equal(await invoiceFor(clientId, undefined), null);
  const reciente = await mkInv('sent', 47);
  assert.equal(await invoiceFor(clientId, undefined), reciente);
});

test('invoiceFor: un invoice_id explícito rechazado o en borrador se ignora (y aplica el respaldo)', async () => {
  const rechazada = await mkInv('rejected', 1);
  const borrador = await mkInv('draft', 1);
  assert.equal(await invoiceFor(clientId, rechazada), null);
  assert.equal(await invoiceFor(clientId, borrador), null);
  const viva = await mkInv('approved', 2);
  assert.equal(await invoiceFor(clientId, rechazada), viva);
});
