// registrar_envio: el cliente quiere que le enviemos el documento. El bot recoge los datos y el envío queda en el
// dashboard (Envíos) «por enviar». Sin montos: el Uber y su pago los maneja el equipo.
const pool = require('../../db/pool');
const Delivery = require('../../models/Delivery');
const { ensureClient } = require('./client');
const { assigneeOrAdmins, notifyUsers } = require('./notify');

const FIELDS = {
  direccion: 'address', referencia: 'reference', recibe: 'recipient_name',
  telefono_recibe: 'recipient_phone', documento: 'document', nota: 'note',
};

async function registrar_envio(args, ctx) {
  const direccion = typeof args?.direccion === 'string' ? args.direccion.trim() : '';
  if (!direccion) return { error: 'falta la dirección de entrega' };
  const client = await ensureClient(ctx);
  if (!client?.id) return { error: 'cliente no encontrado' };

  const fields = {};
  for (const [arg, col] of Object.entries(FIELDS)) {
    if (typeof args[arg] === 'string' && args[arg].trim()) fields[col] = args[arg];
  }

  // One open delivery per client: if there is one «por enviar», that one is corrected
  const open = await Delivery.openForClient(client.id);
  if (open) {
    const d = await Delivery.update(open.id, fields);
    return { envio: d.id, estado: d.status, actualizado: true };
  }

  const { rows } = await pool.query(
    'SELECT id FROM cases WHERE client_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [client.id]);
  const d = await Delivery.create({ ...fields, clientId: client.id, caseId: rows[0]?.id || null, source: 'whatsapp' });
  const clientName = client.name || ctx.phone;
  const { recipients } = await assigneeOrAdmins(client.assigned_to);
  await notifyUsers(recipients, {
    type: 'delivery', title: 'Nuevo envío por WhatsApp',
    message: `${clientName}${fields.document ? ` — ${fields.document}` : ''}: ${direccion}`,
    link: `/envios?envio=${d.id}`, metadata: { delivery_id: d.id },
  });
  return { envio: d.id, estado: d.status };
}

module.exports = { registrar_envio };
