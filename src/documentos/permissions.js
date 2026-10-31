// Quién puede aprobar y enviar documentos (bot fase 2).
// El admin siempre. Un digitador solo si el switch de Configuración está encendido
// (business_info.digitadores_aprueban_documentos) y el cliente del documento está asignado a él, o si él mismo hizo
// el documento (no un borrador del bot): Jay, 2026-10-31, los digitadores envían sin el admin; el admin aprueba modelos.
const pool = require('../db/pool');
const { getBusinessInfo } = require('../agent/businessInfo');

const SWITCH_KEY = 'digitadores_aprueban_documentos';

// El valor es JSONB: true, o 'true' si alguien lo guardó como texto. Sin tabla o sin fila: apagado.
async function digitadoresAprueban() {
  const info = await getBusinessInfo().catch(() => ({}));
  const v = info[SWITCH_KEY];
  return v === true || v === 'true';
}

async function canApproveDocuments(user, doc) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!doc || !(await digitadoresAprueban())) return false;
  if (!doc.prepared_by_bot && doc.created_by === user.id) return true; // también los suyos «Sin cliente»
  if (!doc.client_id) return false;
  const { rows } = await pool.query('SELECT 1 FROM clients WHERE id = $1 AND assigned_to = $2', [doc.client_id, user.id]);
  return rows.length > 0;
}

module.exports = { canApproveDocuments, digitadoresAprueban, SWITCH_KEY };
