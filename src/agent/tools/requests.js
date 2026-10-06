const pool = require('../../db/pool');
const Case = require('../../models/Case');
const { assigneeOrAdmins, notifyUsers } = require('./notify');
const { generateCaseNumber } = require('../../conversation/flows/intake');

async function crear_solicitud(args, ctx) {
  const servicio = args && typeof args.servicio === 'string' ? args.servicio.trim() : '';
  if (!servicio) return { error: 'servicio requerido' };
  const detalles = args.detalles == null ? null : String(args.detalles);
  const client = ctx.client;
  if (!client?.id) return { error: 'cliente no encontrado' };
  const clientName = client.name || ctx.phone;

  const caso = await Case.create({
    caseNumber: generateCaseNumber(),
    title: `${servicio} — ${clientName}`,
    description: detalles,
    caseType: servicio,
    clientId: client.id,
    userId: client.assigned_to || null,
    serviceId: args.servicio_id || null,
    source: 'whatsapp',
  });

  const { asignado, recipients } = await assigneeOrAdmins(client.assigned_to);
  await notifyUsers(recipients, {
    type: 'case', title: 'Nueva solicitud por WhatsApp',
    message: `${servicio} — ${clientName} (${caso.case_number})`,
    link: '/cases', metadata: { case_id: caso.id, case_number: caso.case_number },
  });
  return { caso: caso.case_number, estado: caso.status || 'new', asignado_a: asignado };
}

async function estado_solicitud(args, ctx) {
  const clientId = ctx.client?.id;
  if (!clientId) return { solicitudes: [] };
  const { rows } = await pool.query(
    `SELECT case_number, title, status, updated_at FROM cases WHERE client_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 5`, [clientId]);
  return { solicitudes: rows.map((r) => ({ caso: r.case_number, titulo: r.title, estado: r.status, actualizado: r.updated_at })) };
}

module.exports = { crear_solicitud, estado_solicitud };
