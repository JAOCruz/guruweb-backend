/**
 * Field Extractor
 * Uses Gemini Vision to extract legal document fields from images (cédulas, passports, docs)
 * Also uses AI to extract fields from free-form text
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Extract person data from a cédula/passport image
 * Returns: { nombre, cedula, genero, nacionalidad }
 */
async function extractFromCedula(imagePath) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    const prompt = `Analiza esta imagen de cédula de identidad, pasaporte u otro documento de identidad dominicano.
Extrae EXACTAMENTE la siguiente información en formato JSON:
{
  "nombre": "nombre completo como aparece en el documento",
  "cedula": "número de cédula/pasaporte (solo números y guiones)",
  "genero": "M o F",
  "nacionalidad": "dominicana u otro"
}
Si no puedes leer algún campo, usa null. Solo devuelve el JSON, sin explicaciones.`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { mimeType, data: base64 } }
    ]);
    
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[Extractor] Image extraction failed:', err.message);
    return null;
  }
}

/**
 * Extract vehicle data from a matrícula/title document (PDF or image)
 * Returns: { vehiculo_marca, vehiculo_modelo, vehiculo_ano, vehiculo_color, vehiculo_placa, vehiculo_chasis }
 */
async function extractFromVehicleDoc(filePath, mimeType) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const fileData = fs.readFileSync(filePath);
    const base64 = fileData.toString('base64');

    const prompt = `Analiza este documento de matrícula o título de propiedad de vehículo de República Dominicana.
Extrae EXACTAMENTE la siguiente información en formato JSON:
{
  "matricula_propietario": "nombre completo del propietario/dueño registrado en la matrícula",
  "vehiculo_marca": "marca del vehículo (ej: Toyota, Nissan, Honda)",
  "vehiculo_modelo": "modelo del vehículo (ej: Corolla, Note, Civic)",
  "vehiculo_ano": "año del vehículo (4 dígitos)",
  "vehiculo_color": "color del vehículo",
  "vehiculo_placa": "número de placa (ej: A123456)",
  "vehiculo_chasis": "número de chasis/VIN si aparece",
  "vehiculo_motor": "número de motor si aparece"
}
Si no puedes leer algún campo, usa null. Solo devuelve el JSON, sin explicaciones.`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { mimeType: mimeType || 'application/pdf', data: base64 } }
    ]);

    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    console.log('[Extractor] Vehicle doc data:', parsed);
    return parsed;
  } catch (err) {
    console.error('[Extractor] Vehicle doc extraction failed:', err.message);
    return null;
  }
}

/**
 * Extract multiple fields from free-form text using AI
 * Returns object with any detected field values
 */
async function extractFromText(text, templateKey, existingData = {}) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const prompt = `Analiza este mensaje de un cliente para un bufete legal en República Dominicana.
Extrae cualquier información relevante para un documento legal.

Mensaje del cliente: "${text}"

Busca y extrae (si están presentes):
- Nombres de personas (propietario, inquilino, vendedor, comprador, poderdante, apoderado, garante)
- Números de cédula (formato XXX-XXXXXXX-X)
- Montos de dinero (en pesos o sin especificar)
- Direcciones o ubicaciones
- Descripciones de inmuebles, vehículos
- Marcas, modelos, años, placas de vehículos
- Propósitos o finalidades (para poderes)
- Fechas
- Género (señor/señora → M/F)

Devuelve SOLO un JSON con los campos que puedas identificar del mensaje.
Usa las claves exactas según el tipo de contrato (${templateKey}).
Si no hay información clara, devuelve {}.
Solo el JSON, sin explicaciones.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[Extractor] Text extraction failed:', err.message);
    return {};
  }
}

/**
 * Smart extractor: tries to get fields from whatever was sent
 * Handles single or multiple images (cédulas) and text
 * savedMedia can have an .allMedia array for batch processing
 */
async function extractFields(message, imagePath, templateKey, existingData = {}, allMedia = null) {
  const extracted = {};
  const roles = getRolesForTemplate(templateKey);

  // Process multiple images if available (batch mode)
  const imagePaths = allMedia
    ? allMedia.filter(m => m.media_type === 'image').map(m => m.file_path)
    : imagePath ? [imagePath] : [];

  // Also process document-type media (PDFs, etc.) for vehicle/other data
  const docItems = allMedia
    ? allMedia.filter(m => m.media_type === 'document')
    : [];

  if (docItems.length > 0) {
    const docResults = await Promise.all(
      docItems.map(d => extractFromVehicleDoc(d.file_path, d.mime_type).catch(() => null))
    );
    for (const docData of docResults) {
      if (docData) {
        for (const [k, v] of Object.entries(docData)) {
          if (v) extracted[k] = v;
        }
      }
    }
  }

  if (imagePaths.length > 0) {
    // Process all images in parallel
    const imageResults = await Promise.all(
      imagePaths.map(p => extractFromCedula(p).catch(() => null))
    );

    const validPeople = imageResults.filter(r => r?.nombre);
    validPeople.forEach(p => console.log('[Extractor] Image data:', p));

    // For acto_venta_vehiculo: use matrícula owner to determine vendedor/comprador
    if (templateKey === 'acto_venta_vehiculo' && validPeople.length >= 2) {
      const matriculaPropietario = extracted.matricula_propietario ||
                                   existingData.matricula_propietario || null;
      const assignment = assignRolesByMatricula(matriculaPropietario, validPeople);

      if (assignment) {
        // Smart assignment: matrícula owner = vendedor
        extracted.vendedor_nombre = assignment.vendedor.nombre;
        if (assignment.vendedor.cedula) extracted.vendedor_cedula = assignment.vendedor.cedula;
        if (assignment.vendedor.genero) extracted.vendedor_genero = assignment.vendedor.genero;
        extracted.comprador_nombre = assignment.comprador.nombre;
        if (assignment.comprador.cedula) extracted.comprador_cedula = assignment.comprador.cedula;
        if (assignment.comprador.genero) extracted.comprador_genero = assignment.comprador.genero;
      } else {
        // Fallback: positional (first = vendedor, second = comprador)
        const roleAssign = ['vendedor', 'comprador'];
        validPeople.slice(0, 2).forEach((person, i) => {
          const role = roleAssign[i];
          extracted[`${role}_nombre`] = person.nombre;
          if (person.cedula) extracted[`${role}_cedula`] = person.cedula;
          if (person.genero) extracted[`${role}_genero`] = person.genero;
        });
      }
    } else {
      // All other templates: sequential role assignment
      let workingData = { ...existingData };
      for (const imageData of validPeople) {
        const unfilledRole = roles.find(role => !workingData[`${role}_nombre`] && !extracted[`${role}_nombre`]);
        if (unfilledRole) {
          extracted[`${unfilledRole}_nombre`] = imageData.nombre;
          if (imageData.cedula) extracted[`${unfilledRole}_cedula`] = imageData.cedula;
          if (imageData.genero) extracted[`${unfilledRole}_genero`] = imageData.genero;
          workingData[`${unfilledRole}_nombre`] = imageData.nombre;
        }
      }
    }
  }

  // Also extract from text
  if (message && message.trim().length > 2) {
    const textData = await extractFromText(message, templateKey, { ...existingData, ...extracted });
    Object.assign(extracted, textData);
  }

  return extracted;
}

/**
 * Normalize a name for fuzzy comparison:
 * lowercase, remove accents, collapse spaces, remove common particles
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/\b(de|del|la|los|las|el)\b/g, '')       // remove particles
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score how well two names match (0 = no match, higher = better match)
 * Splits into words and counts overlapping tokens
 */
function nameMatchScore(nameA, nameB) {
  const a = normalizeName(nameA).split(' ').filter(Boolean);
  const b = normalizeName(nameB).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  const matches = a.filter(word => word.length > 2 && b.includes(word));
  return matches.length;
}

/**
 * Given matrícula owner name and array of {nombre, cedula, ...} person objects,
 * return { vendedor: personObj, comprador: personObj } by matching owner to cédula names.
 * Falls back to positional (first=vendedor) if no match found.
 */
function assignRolesByMatricula(matriculaPropietario, people) {
  if (!matriculaPropietario || people.length < 2) return null;

  const scores = people.map(p => ({
    person: p,
    score: nameMatchScore(matriculaPropietario, p.nombre),
  }));

  const best = scores.reduce((a, b) => (a.score >= b.score ? a : b));

  // Need at least 1 word match to be confident
  if (best.score === 0) {
    console.log('[Extractor] No name match found for matrícula owner, using positional fallback');
    return null;
  }

  const vendedor = best.person;
  const comprador = people.find(p => p !== vendedor);

  console.log(`[Extractor] Matrícula owner "${matriculaPropietario}" matched "${vendedor.nombre}" (score: ${best.score}) → VENDEDOR`);
  console.log(`[Extractor] Other person "${comprador.nombre}" → COMPRADOR`);

  return { vendedor, comprador };
}

function getRolesForTemplate(templateKey) {
  const roleMap = {
    contrato_alquiler_vivienda: ['propietario', 'inquilino', 'garante'],
    contrato_alquiler_comercial: ['propietario', 'inquilino'],
    acto_venta_vehiculo: ['vendedor', 'comprador', 'apoderado'],
    poder_autorizacion: ['poderdante', 'apoderado'],
  };
  return roleMap[templateKey] || [];
}

module.exports = { extractFromCedula, extractFromVehicleDoc, extractFromText, extractFields, nameMatchScore };
