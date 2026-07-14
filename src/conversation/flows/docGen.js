/**
 * Mother Brain Document Generation Flow v2
 * Integrates with 162 templates from the Mother Brain system.
 *
 * Flow:
 *  1. select_category     → Show top-level categories
 *  2. select_template     → Show templates in category
 *  3. confirm_template    → Show template details + required roles
 *  4. collect_role_data   → Collect data for each required role sequentially
 *  5. collect_fields      → Collect remaining non-ROL fields (dates, notary, etc.)
 *  6. review              → Show collected data for confirmation
 *  7. generating          → Generate and send DOCX
 */

const path = require('path');
const { transitionTo, updateData } = require('../stateManager');
const pool = require('../../db/pool');
const { spawnSync } = require('child_process');
const Client = require('../../models/Client');
const Case = require('../../models/Case');
const ClientDocument = require('../../models/ClientDocument');
const { isSimulatorPhone, getSource } = require('../../utils/simulator');
const storage = require('../../utils/storage');

// Working directory for Python document generator.
// In Railway the app runs from /app; locally from the repo root.
const PYTHON_CWD = process.cwd();

// ── Database helpers ──

async function getCategories() {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.slug,
      COUNT(t.id) AS template_count
    FROM doc_categories c
    LEFT JOIN doc_templates t ON t.category_id = c.id AND t.is_active = true
    WHERE c.parent_id IS NULL
    GROUP BY c.id
    ORDER BY c.sort_order, c.name
  `);
  return rows;
}

async function getTemplatesByCategory(categorySlug) {
  const { rows } = await pool.query(`
    SELECT t.id, t.name, t.slug, t.description, t.file_path
    FROM doc_templates t
    JOIN doc_categories c ON c.id = t.category_id
    WHERE c.slug = $1 AND t.is_active = true
    ORDER BY t.sort_order, t.name
  `, [categorySlug]);
  return rows;
}

async function getTemplateDetail(templateId) {
  const { rows: [template] } = await pool.query(`
    SELECT t.*, c.name AS category_name
    FROM doc_templates t
    LEFT JOIN doc_categories c ON c.id = t.category_id
    WHERE t.id = $1
  `, [templateId]);
  return template;
}

async function analyzeTemplateRoles(filePath) {
  const script = `
import sys, json
from src.documents.motherbrainGenerator import analyze_template_roles
roles = analyze_template_roles(sys.argv[1])
print(json.dumps(roles))
`;
  const result = spawnSync('python3', ['-c', script, filePath], {
    cwd: PYTHON_CWD,
    encoding: 'utf-8',
    timeout: 10000,
  });
  if (result.status !== 0) return {};
  try { return JSON.parse(result.stdout.trim()); } catch (e) { return {}; }
}

// ── Format helpers ──

function formatRoleQuestion(roleCode, fields, roleIndex = null) {
  const roleNames = {
    VENDEDOR: 'Vendedor', COMPRADOR: 'Comprador',
    ARRENDADOR: 'Arrendador', ARRENDATARIO: 'Arrendatario',
    DONANTE: 'Donante', DONATARIO: 'Donatario',
    TESTIGO: 'Testigo', CONYUGE: 'Cónyuge',
    APODERADO: 'Apoderado', PODERDANTE: 'Poderdante',
    GARANTE: 'Garante', BENEFICIARIO: 'Beneficiario',
    DEMANDANTE: 'Demandante', DEMANDADO: 'Demandado',
    ACREEDOR: 'Acreedor', DEUDOR: 'Deudor',
    SOLICITANTE: 'Solicitante', COMPARECIENTE: 'Compareciente',
    REPRESENTANTE: 'Representante', ABOGADO: 'Abogado',
    NOTARIO: 'Notario', ALGUACIL: 'Alguacil',
  };

  const roleLabel = roleNames[roleCode] || roleCode;
  const idxLabel = roleIndex ? ` #${roleIndex}` : '';

  let msg = `👤 *Datos del ${roleLabel}${idxLabel}*\n\n`;
  msg += `Necesito la siguiente información. Puedes enviar:\n`;
  msg += `• Texto con los datos\n`;
  msg += `• Foto de la cédula (extraigo nombre, documento, nacionalidad, etc.)\n\n`;

  const fieldLabels = {
    'NOMBRE': 'Nombre completo',
    'NACIONALIDAD': 'Nacionalidad',
    'ESTADO CIVIL': 'Estado civil',
    'DOCUMENTO IDENTIDAD': 'Documento de identidad (cédula/pasaporte)',
    'DIRECCION O DOMICILIO': 'Dirección o domicilio',
    'OCUPACION': 'Ocupación / profesión',
    'CARGO_REPRESENTANTE': 'Cargo (Gerente, Presidente, etc.)',
  };

  fields.forEach(f => {
    msg += `• ${fieldLabels[f] || f}\n`;
  });

  return msg;
}

function formatFieldQuestion(fieldTag, templateName) {
  const fieldLabels = {
    'CIUDAD_FIRMA': '¿En qué ciudad se firmará el documento?',
    'DIA_TEXTO': '¿Qué día se firma? (en letras, ej: quince)',
    'MES_TEXTO': '¿Qué mes se firma? (en letras, ej: mayo)',
    'AÑO_TEXTO': '¿Qué año se firma? (en letras, ej: dos mil veintiséis)',
    'DESCRIPCION_DEL_BIEN': 'Describe el bien (vehículo, inmueble, etc.)',
    'PRECIO_VENTA_LETRAS': 'Precio en letras (ej: doscientos cincuenta mil pesos)',
    'PRECIO_VENTA_NUMEROS': 'Precio en números (ej: 250,000.00)',
    'NUMERO_MATRICULA': 'Número de matrícula',
    'FECHA_EXPEDICION_MATRICULA': 'Fecha de expedición de la matrícula',
    'DIA_NUMERO': 'Día (número)',
    'AÑO_NUMERO': 'Año (número)',
  };

  return `📝 *${templateName}*\n\n${fieldLabels[fieldTag] || `¿Cuál es ${fieldTag}?`}`;
}

// ── Cédula extraction helper ──

async function extractFromCedula(imagePath) {
  try {
    const { extractFromCedula } = require('../../documents/extractor');
    const result = await extractFromCedula(imagePath);
    return result || {};
  } catch (e) {
    return {};
  }
}

// ── Main handler ──

async function handle(session, text, msg, savedMedia = null) {
  const step = session.step;
  const data = session.data || {};

  // Global cancel
  if (/^(cancelar|salir|cancel|menu|inicio)$/i.test(text.trim())) {
    await transitionTo(session, 'main_menu', 'show', {});
    return '❌ Proceso cancelado. ¿En qué más te puedo ayudar?';
  }

  // ── STEP 1: Show categories ──
  if (step === 'select_category' || step === 'show') {
    const categories = await getCategories();
    let response = `📁 *Generación de Documentos Legales*\n\n`;
    response += `Selecciona una categoría:\n\n`;
    categories.forEach((cat, i) => {
      response += `*${i + 1}.* ${cat.name} (${cat.template_count} documentos)\n`;
    });
    response += `\n_Escribe el número de la categoría que necesitas._`;
    await transitionTo(session, 'doc_generation', 'select_category', data);
    return response;
  }

  // ── STEP 2: Select category → show templates ──
  if (step === 'select_category') {
    const categories = await getCategories();
    const choice = parseInt(text.trim());
    if (isNaN(choice) || choice < 1 || choice > categories.length) {
      return `❌ Opción no válida. Escribe un número del 1 al ${categories.length}.`;
    }

    const selectedCategory = categories[choice - 1];
    const templates = await getTemplatesByCategory(selectedCategory.slug);

    if (templates.length === 0) {
      return `❌ No hay documentos disponibles en esta categoría. Intenta con otra.`;
    }

    let response = `📄 *${selectedCategory.name}*\n\n`;
    response += `Selecciona un documento:\n\n`;
    templates.forEach((t, i) => {
      response += `*${i + 1}.* ${t.name}\n`;
    });
    response += `\n_Escribe el número del documento._`;

    await updateData(session, { docGenCategory: selectedCategory.slug, docGenTemplates: templates });
    await transitionTo(session, 'doc_generation', 'select_template', { ...data, docGenCategory: selectedCategory.slug, docGenTemplates: templates });
    return response;
  }

  // ── STEP 3: Select template → confirm ──
  if (step === 'select_template') {
    const templates = data.docGenTemplates || [];
    const choice = parseInt(text.trim());
    if (isNaN(choice) || choice < 1 || choice > templates.length) {
      return `❌ Opción no válida. Escribe un número del 1 al ${templates.length}.`;
    }

    const template = templates[choice - 1];
    const roles = await analyzeTemplateRoles(template.file_path);
    const roleList = Object.keys(roles);

    let response = `✨ *${template.name}*\n\n`;

    if (roleList.length > 0) {
      response += `*Personas que intervienen:*\n`;
      roleList.forEach(r => {
        const count = roles[r].length;
        response += `• ${r} (${count} datos requeridos)\n`;
      });
      response += `\n`;
    }

    response += `¿Confirmas que quieres generar este documento?\n`;
    response += `• Escribe *sí* para continuar\n`;
    response += `• Escribe *no* para elegir otro`;

    await updateData(session, { docGenTemplateId: template.id, docGenTemplateName: template.name, docGenTemplatePath: template.file_path, docGenRoles: roles, docGenRoleList: roleList, docGenCurrentRoleIndex: 0, docGenCollectedRoles: {}, docGenCollectedFields: {} });
    await transitionTo(session, 'doc_generation', 'confirm_template', { ...data, docGenTemplateId: template.id, docGenTemplateName: template.name, docGenTemplatePath: template.file_path, docGenRoles: roles, docGenRoleList: roleList, docGenCurrentRoleIndex: 0, docGenCollectedRoles: {}, docGenCollectedFields: {} });
    return response;
  }

  // ── STEP 4: Confirm template → start collecting roles ──
  if (step === 'confirm_template') {
    if (!/^(sí|si|yes|ok|continuar|adelante)$/i.test(text.trim())) {
      await transitionTo(session, 'doc_generation', 'select_category', data);
      return `📁 Volvamos a las categorías...`;
    }

    const roles = data.docGenRoles || {};
    const roleList = data.docGenRoleList || [];

    if (roleList.length === 0) {
      // No roles — go straight to field collection
      await transitionTo(session, 'doc_generation', 'collect_fields', data);
      return await askNextField(session, data);
    }

    // Start collecting first role
    const firstRole = roleList[0];
    const roleFields = roles[firstRole];
    await transitionTo(session, 'doc_generation', 'collect_role_data', data);
    return formatRoleQuestion(firstRole, roleFields);
  }

  // ── STEP 5: Collect role data ──
  if (step === 'collect_role_data') {
    const roles = data.docGenRoles || {};
    const roleList = data.docGenRoleList || [];
    const currentIndex = data.docGenCurrentRoleIndex || 0;
    const currentRole = roleList[currentIndex];
    const collectedRoles = data.docGenCollectedRoles || {};

    // Extract data from text + image
    let extracted = {};
    const imagePath = savedMedia?.file_path || null;

    if (imagePath) {
      const cedulaData = await extractFromCedula(imagePath);
      if (cedulaData.nombre) extracted.NOMBRE = cedulaData.nombre;
      if (cedulaData.cedula) extracted['DOCUMENTO IDENTIDAD'] = cedulaData.cedula;
      if (cedulaData.nacionalidad) extracted.NACIONALIDAD = cedulaData.nacionalidad;
      if (cedulaData.estado_civil) extracted['ESTADO CIVIL'] = cedulaData.estado_civil;
    }

    // Also try to extract from text
    if (text.trim().length > 3) {
      const lines = text.split(/\n|,/);
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (lower.includes('nombre')) extracted.NOMBRE = line.split(':').pop().trim();
        if (lower.includes('cédula') || lower.includes('cedula') || /\d{3}-\d{7}-\d/.test(line)) {
          extracted['DOCUMENTO IDENTIDAD'] = line.match(/\d{3}-\d{7}-\d/)?.[0] || line.split(':').pop().trim();
        }
        if (lower.includes('dirección') || lower.includes('domicilio')) extracted['DIRECCION O DOMICILIO'] = line.split(':').pop().trim();
        if (lower.includes('nacionalidad')) extracted.NACIONALIDAD = line.split(':').pop().trim();
        if (lower.includes('estado civil')) extracted['ESTADO CIVIL'] = line.split(':').pop().trim();
        if (lower.includes('ocupación') || lower.includes('profesión')) extracted.OCUPACION = line.split(':').pop().trim();
      }
    }

    // Merge
    const currentRoleData = collectedRoles[currentRole] || {};
    const updatedRoleData = { ...currentRoleData, ...extracted };
    const updatedCollectedRoles = { ...collectedRoles, [currentRole]: updatedRoleData };

    // Check if role is complete
    const requiredFields = roles[currentRole] || [];
    const missing = requiredFields.filter(f => !updatedRoleData[f] || updatedRoleData[f].trim() === '');

    if (missing.length === 0) {
      // Role complete → next role or move to fields
      const nextIndex = currentIndex + 1;
      if (nextIndex < roleList.length) {
        await updateData(session, { docGenCollectedRoles: updatedCollectedRoles, docGenCurrentRoleIndex: nextIndex });
        return formatRoleQuestion(roleList[nextIndex], roles[roleList[nextIndex]]);
      } else {
        // All roles done → collect remaining fields
        await updateData(session, { docGenCollectedRoles: updatedCollectedRoles });
        await transitionTo(session, 'doc_generation', 'collect_fields', { ...data, docGenCollectedRoles: updatedCollectedRoles });
        return await askNextField(session, { ...data, docGenCollectedRoles: updatedCollectedRoles });
      }
    } else {
      // Still missing data for this role
      await updateData(session, { docGenCollectedRoles: updatedCollectedRoles });
      let response = `✅ *Recibido:*\n`;
      Object.entries(updatedRoleData).forEach(([k, v]) => {
        response += `• ${k}: ${v}\n`;
      });
      response += `\n⏳ *Falta:*\n`;
      missing.forEach(f => response += `• ${f}\n`);
      response += `\nPor favor envía los datos faltantes.`;
      return response;
    }
  }

  // ── STEP 6: Collect non-ROL fields ──
  if (step === 'collect_fields') {
    const collectedFields = data.docGenCollectedFields || {};
    const templatePath = data.docGenTemplatePath;

    // Store the answer
    const currentField = data.docGenCurrentField;
    if (currentField) {
      collectedFields[currentField] = text.trim();
    }

    await updateData(session, { docGenCollectedFields: collectedFields });
    return await askNextField(session, { ...data, docGenCollectedFields: collectedFields });
  }

  // ── STEP 7: Review → generate ──
  if (step === 'review') {
    if (!/^(sí|si|yes|ok|generar|continuar)$/i.test(text.trim())) {
      return `⏳ Esperando confirmación... Escribe *sí* para generar el documento.`;
    }
    await transitionTo(session, 'doc_generation', 'generating', data);
    return await generateDocumentAndSend(session, data, msg);
  }

  // ── STEP 8: Generating ──
  if (step === 'generating') {
    return '⏳ Generando tu documento... Un momento por favor.';
  }

  // Default fallback
  await transitionTo(session, 'doc_generation', 'select_category', data);
  return `📁 Volvamos a empezar. Selecciona una categoría de documentos.`;
}

// ── Helper: Ask next non-ROL field ──

async function askNextField(session, data) {
  const templatePath = data.docGenTemplatePath;
  const templateName = data.docGenTemplateName;
  const collectedFields = data.docGenCollectedFields || {};

  // Get all variables from template
  const script = `
import sys
from src.documents.motherbrainGenerator import extract_required_fields
vars = extract_required_fields(sys.argv[1])
for v in vars:
    print(v)
`;
  const result = spawnSync('python3', ['-c', script, templatePath], {
    cwd: PYTHON_CWD,
    encoding: 'utf-8',
    timeout: 10000,
  });

  if (result.status !== 0) {
    await transitionTo(session, 'doc_generation', 'review', data);
    return `✅ *Datos completos.* Revisa y confirma para generar.`;
  }

  const allVars = result.stdout.trim().split('\n').filter(Boolean);

  // Filter out ROL variables (already collected) and already-collected fields
  const roles = data.docGenRoles || {};
  const roleVars = new Set();
  Object.keys(roles).forEach(rol => {
    roles[rol].forEach(field => {
      roleVars.add(`${field}_${rol}`);
      // Also add indexed variants
      for (let i = 1; i <= 5; i++) roleVars.add(`${field}_${rol} ${i}`);
    });
  });

  const remaining = allVars.filter(v => {
    // Skip if it's a role variable
    for (const rv of roleVars) {
      if (v.includes(rv) || v === rv) return false;
    }
    // Skip if already collected
    if (collectedFields[v]) return false;
    return true;
  });

  if (remaining.length === 0) {
    await transitionTo(session, 'doc_generation', 'review', data);
    return buildReviewMessage(data);
  }

  const nextField = remaining[0];
  await updateData(session, { docGenCurrentField: nextField });
  return formatFieldQuestion(nextField, templateName);
}

// ── Helper: Build review message ──

function buildReviewMessage(data) {
  const templateName = data.docGenTemplateName;
  const roles = data.docGenCollectedRoles || {};
  const fields = data.docGenCollectedFields || {};

  let msg = `📋 *Revisión: ${templateName}*\n\n`;

  if (Object.keys(roles).length > 0) {
    msg += `*Personas:*\n`;
    Object.entries(roles).forEach(([role, data]) => {
      msg += `• *${role}:* ${data.NOMBRE || '—'}\n`;
    });
    msg += `\n`;
  }

  if (Object.keys(fields).length > 0) {
    msg += `*Datos adicionales:*\n`;
    Object.entries(fields).forEach(([k, v]) => {
      msg += `• ${k}: ${v}\n`;
    });
    msg += `\n`;
  }

  msg += `¿Todo correcto? Escribe *sí* para generar el documento.`;
  return msg;
}

// ── Helper: Generate and send ──

async function generateDocumentAndSend(session, data, msg) {
  const templatePath = data.docGenTemplatePath;
  const templateName = data.docGenTemplateName;
  const templateId = data.docGenTemplateId || null;
  const collectedRoles = data.docGenCollectedRoles || {};
  const collectedFields = data.docGenCollectedFields || {};
  const phone = session.phone;
  const isSimulator = isSimulatorPhone(phone);
  const source = getSource(phone);

  try {
    const script = `
import sys, json
from src.documents.motherbrainGenerator import generate_document

data = json.loads(sys.argv[1])
roles = json.loads(sys.argv[2])
output = generate_document(sys.argv[3], data, roles, sys.argv[4])
print(output)
`;
    const outputName = `doc_${Date.now()}.docx`;
    const result = spawnSync('python3', ['-c', script,
      JSON.stringify(collectedFields),
      JSON.stringify(collectedRoles),
      templatePath,
      outputName
    ], {
      cwd: PYTHON_CWD,
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || 'Generation failed');
    }

    const rawOutputPath = result.stdout.trim();

    // Move generated file to persistent storage
    const safeName = `${path.basename(templateName).replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.docx`;
    const persistentPath = storage.saveLocalFile(rawOutputPath, 'documents', safeName);

    // Persist client, case and document record for every generated document
    let clientId = session.client_id || null;
    let caseId = null;
    const defaultUserId = await Client.getDefaultUserId();

    let client = clientId ? await Client.findById(clientId) : null;
    if (!client) {
      client = await Client.findByPhone(phone);
    }
    if (!client) {
      client = await Client.create({
        name: collectedRoles?.compareciente?.nombre || collectedRoles?.VENDEDOR?.NOMBRE || collectedRoles?.SOLICITANTE?.NOMBRE || (isSimulator ? 'Cliente Simulado' : 'Cliente WhatsApp'),
        phone,
        notes: isSimulator
          ? 'Cliente creado automáticamente desde el simulador del bot'
          : 'Cliente creado automáticamente desde WhatsApp',
        userId: defaultUserId,
        source,
      });
    }
    clientId = client.id;

    const caseNumber = isSimulator
      ? `SIM-${Date.now().toString(36).toUpperCase()}`
      : `DOC-${Date.now().toString(36).toUpperCase()}`;
    const newCase = await Case.create({
      caseNumber,
      title: `${templateName}`,
      description: `Documento generado${isSimulator ? ' en simulador' : ' vía WhatsApp'}: ${templateName}`,
      caseType: isSimulator ? 'simulacion' : 'documento',
      clientId,
      userId: defaultUserId,
      source,
    });
    caseId = newCase.id;

    // Link client to session
    const ConversationSession = require('../../models/ConversationSession');
    await ConversationSession.setClientId(session.id, clientId);

    // Save document record with versioning
    const latestVersion = await ClientDocument.getLatestVersion(clientId, templateId, caseId);
    await ClientDocument.create({
      clientId,
      caseId,
      templateId,
      versionNumber: latestVersion + 1,
      filePath: persistentPath,
      fileName: safeName,
      generatedByUserId: defaultUserId,
      status: 'active',
      notes: `Generado ${isSimulator ? 'desde simulador' : 'desde WhatsApp'}. Template: ${templateName}`,
      storageType: 'railway_volume',
    });

    // Send via WhatsApp (skip for simulator)
    if (!isSimulator && msg && msg.key && msg.key.remoteJid) {
      const { sendDocumentToChat } = require('../../whatsapp/sender');
      const jid = msg.key.remoteJid;
      await sendDocumentToChat(jid, persistentPath, `${templateName}.docx`);
    }

    // Transition back to menu
    await transitionTo(session, 'main_menu', 'show', {});

    const sendLabel = isSimulator ? 'generado y guardado en modo simulador' : 'generado exitosamente';
    return `✅ *¡Documento ${sendLabel}!*\n\n📎 Tu *${templateName}* está listo. Revísalo y si necesitas ajustes me avisas.\n\n⚠️ _Este documento es un borrador. Debe ser revisado y firmado ante notario para tener validez legal._\n\n¿En qué más te puedo ayudar?`;

  } catch (err) {
    console.error('[DocGen v2] Generation error:', err);
    await transitionTo(session, 'main_menu', 'show', {});
    return `❌ Hubo un error generando el documento. Nuestro equipo lo preparará manualmente. Disculpe el inconveniente.`;
  }
}

module.exports = { handle };
