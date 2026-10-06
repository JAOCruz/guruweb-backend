const pool = require('../../db/pool');
const Tags = require('../../documentos/templateTags');
const LegalProfile = require('../../documentos/legalProfile');
const { listTags } = require('../../documentos/docxText');
const { fillAndStore } = require('../../documentos/fillDocument');
const { digitadoresAprueban } = require('../../documentos/permissions');
const { fold } = require('../text');
const { ensureClient } = require('./client');
const { activeAdminIds, notifyUsers } = require('./notify');

// ver_modelo / preparar_documento: el bot solo usa modelos etiquetados y aprobados en Documentos → Etiquetas
// (doc_templates.approved_tag_version_id). El documento queda como borrador del bot, por aprobar; nunca sale solo.

const SIN_MODELO = { error: 'sin modelo aprobado' };
const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'en', 'por', 'para', 'con', 'al', 'a', 'e', 'u']);
const tokens = (s) => fold(s).split(/[^a-z0-9ñ]+/).filter((t) => t && !STOP.has(t));

// El modelo aprobado ligado al servicio (service_catalog.template_id guarda el id del doc_template como texto)
async function approvedByService(serviceId) {
  const id = Number(serviceId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await pool.query('SELECT name, template_id FROM service_catalog WHERE id = $1', [id]);
  const s = rows[0];
  if (!s) return null;
  const t = /^\d+$/.test(String(s.template_id || '').trim()) ? await Tags.getTemplate(Number(s.template_id)) : null;
  return { service: s, template: t && t.is_active && t.approved_tag_version_id ? t : null };
}

// Por nombre, entre los modelos aprobados: el que más palabras de la consulta contiene (empates → opciones).
async function approvedByName(nombre) {
  const q = tokens(nombre);
  if (!q.length) return null;
  const { rows } = await pool.query(
    `SELECT id, name, approved_tag_version_id FROM doc_templates
     WHERE is_active = TRUE AND approved_tag_version_id IS NOT NULL ORDER BY name`);
  const exact = rows.filter((t) => fold(t.name) === fold(nombre));
  if (exact.length === 1) return { template: exact[0] };
  let best = []; let bestScore = 0; let bestCover = 0;
  for (const t of rows) {
    const mine = tokens(t.name);
    const hits = q.filter((w) => mine.includes(w)).length;
    if (!hits) continue;
    const cover = mine.length ? hits / mine.length : 0; // qué tanto del nombre del modelo quedó cubierto
    if (hits > bestScore || (hits === bestScore && cover > bestCover)) { best = [t]; bestScore = hits; bestCover = cover; }
    else if (hits === bestScore && cover === bestCover) best.push(t);
  }
  if (!best.length) return null;
  if (best.length > 1) return { opciones: best.map((t) => t.name) };
  return { template: best[0] };
}

const rolesOf = (tags) => [...new Set(tags.map((t) => t.group).filter((g) => g && g !== 'DOCUMENTO'))];

// El rol del cliente en el modelo: el que se pasó; si no, el único que hay; con varios y sin decir cuál → null.
function clientRole(roles, given) {
  const r = String(given || '').trim().toUpperCase();
  if (r) return r;
  return roles.length === 1 ? roles[0] : null;
}

async function ver_modelo(args, ctx) {
  const servicioId = args && args.servicio_id;
  const nombre = args && typeof args.nombre === 'string' ? args.nombre.trim() : '';
  if ((servicioId === undefined || servicioId === null || servicioId === '') && !nombre) return { error: 'indique servicio_id o nombre' };

  let template = null;
  let found = null;
  if (servicioId !== undefined && servicioId !== null && servicioId !== '') {
    found = await approvedByService(servicioId);
    template = found && found.template;
  }
  if (!template) {
    const byName = await approvedByName(nombre || (found && found.service && found.service.name) || '');
    if (byName && byName.opciones) return { error: 'varios modelos', opciones: byName.opciones };
    template = byName && byName.template;
  }
  if (!template) return SIN_MODELO;

  const version = await Tags.getVersion(template.approved_tag_version_id);
  if (!version) return SIN_MODELO;
  const tags = Array.isArray(version.tags) ? version.tags : [];
  const roles = rolesOf(tags);
  const role = clientRole(roles, args.rol_cliente);
  const profile = ctx.client?.id ? await LegalProfile.get(ctx.client.id) : {};
  // Con varios roles y sin saber cuál es el cliente no se adivina de quién es lo que hay en la ficha
  const yaTenemos = roles.length > 1 && !role ? {} : LegalProfile.prefill(tags, profile, role);
  return {
    modelo_id: template.id,
    nombre: template.name,
    roles,
    etiquetas: tags.map((t) => ({ clave: t.key, etiqueta: t.label || t.key, rol: t.group })),
    ya_tenemos: yaTenemos,
    faltan: tags.map((t) => t.key).filter((k) => !yaTenemos[k]),
  };
}

// La cotización a la que se liga el documento: la indicada si es del cliente; si no, la más reciente
// por aprobar o aprobada del cliente; si no hay, ninguna.
async function invoiceFor(clientId, given) {
  const id = Number(given);
  if (Number.isInteger(id) && id > 0) {
    const { rows } = await pool.query('SELECT id FROM invoices WHERE id = $1 AND client_id = $2', [id, clientId]);
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await pool.query(
    `SELECT id FROM invoices WHERE client_id = $1 AND status IN ('pending_approval', 'approved')
     ORDER BY created_at DESC, id DESC LIMIT 1`, [clientId]);
  return rows[0] ? rows[0].id : null;
}

async function preparar_documento(args, ctx) {
  const modeloId = Number(args && args.modelo_id);
  const valores = args && args.valores;
  if (!valores || typeof valores !== 'object' || Array.isArray(valores)) return { error: 'valores inválidos' };
  const template = Number.isInteger(modeloId) && modeloId > 0 ? await Tags.getTemplate(modeloId) : null;
  if (!template || !template.is_active || !template.approved_tag_version_id) return SIN_MODELO;
  const version = await Tags.getVersion(template.approved_tag_version_id);
  if (!version) return SIN_MODELO;
  const client = await ensureClient(ctx);
  if (!client?.id) return { error: 'cliente no encontrado' };

  const tags = Array.isArray(version.tags) ? version.tags : [];
  const roles = rolesOf(tags);
  const role = clientRole(roles, args.rol_cliente);
  if (roles.length > 1 && !role) return { error: 'falta rol_cliente', roles };

  // Claves tal como las devolvió ver_modelo; se toleran mayúsculas/espacios distintos ("nombre_comprador")
  const keys = [...new Set(await listTags(version.file_path))];
  const byNorm = new Map([...keys, ...tags.map((t) => t.key)].map((k) => [LegalProfile.norm(k), k]));
  const clean = {};
  for (const [k, v] of Object.entries(valores)) {
    const key = byNorm.get(LegalProfile.norm(k));
    const val = v == null ? '' : String(v).trim();
    if (key && val) clean[key] = val;
  }
  const merged = { ...LegalProfile.prefill(tags, await LegalProfile.get(client.id), role), ...clean };
  const faltan = keys.filter((k) => !merged[k]);
  if (faltan.length) return { error: 'faltan datos', faltan };

  const clientName = client.name || ctx.phone;
  const title = `${template.name} — ${clientName}`.slice(0, 200);
  const invoiceId = await invoiceFor(client.id, args.invoice_id);
  const { id } = await fillAndStore({
    version, values: Object.fromEntries(keys.map((k) => [k, merged[k]])), title,
    clientId: client.id, templateId: template.id, userId: ctx.botUserId || null,
    notes: 'Preparado por el bot', invoiceId, preparedByBot: true,
  });
  await LegalProfile.merge(client.id, LegalProfile.updatesFrom(tags, clean, role), ctx.botUserId || null);

  const recipients = new Set(await activeAdminIds());
  if (client.assigned_to && (await digitadoresAprueban())) recipients.add(client.assigned_to);
  await notifyUsers([...recipients], {
    type: 'document', title: `📄 Documento preparado por el bot: ${title}`,
    message: `${clientName} — por aprobar en Documentos`, link: '/documentos',
    metadata: { document_id: id, client_id: client.id, invoice_id: invoiceId },
  });
  return { documento_id: id, titulo: title, estado: 'por_aprobar' };
}

module.exports = { ver_modelo, preparar_documento };
