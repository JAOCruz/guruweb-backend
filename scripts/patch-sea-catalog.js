/**
 * Patch: Apply Leandro's S/E/A (Sencillo/Extensivo/Avanzado) complexity
 * classification and official notarization prices to the service_catalog.
 */
const pool = require('../src/db/pool');

const CATEGORIES = {
  NOTARIZACION: 'Notarización',
  REDACCION: 'Redactar o digitar un documento',
  MODIFICACION: 'Modificación de un Documento',
};

// Services to upsert with complexity and prices.
// digitacion = drafting/typing price, notarizacion = notarization price.
const SERVICES = [
  // ═══════════════════════════════════════════════════════
  // DOCUMENTOS EN TAMAÑO CARTA
  // ═══════════════════════════════════════════════════════
  { name: 'Cartas o Comunicaciones - Certificando Firmas', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 150, notarizacion: 500, unit: 'por documento' },
  { name: 'Coletilla y Notarizar documento Fiel y Conforme', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 200, notarizacion: 700, unit: 'por documento' },
  { name: 'Formulario Sucesiones y Donaciones DGII', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: 700, unit: 'por documento' },
  { name: 'Contrato de Poderes (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 250, notarizacion: 500, unit: 'por documento' },
  { name: 'Contrato de Alquileres o Renta Inmueble (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: 500, unit: 'por documento' },

  // ═══════════════════════════════════════════════════════
  // CONTRATOS TRASLATIVOS (notarización value tiers)
  // ═══════════════════════════════════════════════════════
  { name: 'Contrato de Venta Bienes', complexity: null, category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: null, unit: 'por documento', tiers: [
    { label: 'S - RD$0 - 150K', min: 0, max: 150000, price: 500 },
    { label: 'E - RD$150K - 500K', min: 150001, max: 500000, price: 700 },
    { label: 'E - RD$600K - 1M', min: 600000, max: 1000000, price: 1000 },
    { label: 'A - RD$1M - 3M', min: 1000001, max: 3000000, price: 2000 },
    { label: 'A - RD$3M - 5M', min: 3000001, max: 5000000, price: 4000 },
    { label: 'A - RD$5M - 8M', min: 5000001, max: 8000000, price: 5000 },
    { label: 'A - RD$8M - 10M', min: 8000001, max: 10000000, price: 10000 },
  ]},

  // ═══════════════════════════════════════════════════════
  // ADENDUM / CORRECCIÓN
  // ═══════════════════════════════════════════════════════
  { name: 'Contrato ADENDUM o Corrección (Sencillo)', complexity: 'S', category: CATEGORIES.MODIFICACION, digitacion: 250, notarizacion: 700, unit: 'por documento' },
  { name: 'Contrato ADENDUM o Corrección (Extensivo)', complexity: 'E', category: CATEGORIES.MODIFICACION, digitacion: 500, notarizacion: 1000, unit: 'por documento' },
  { name: 'Contrato ADENDUM o Corrección (Avanzado)', complexity: 'A', category: CATEGORIES.MODIFICACION, digitacion: 1000, notarizacion: 2000, unit: 'por documento' },

  // ═══════════════════════════════════════════════════════
  // RECIBOS DE DESCARGO / PAGO
  // ═══════════════════════════════════════════════════════
  { name: 'Recibo de Descargo y Recibo de Pago (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 150, notarizacion: 700, unit: 'por documento' },
  { name: 'Recibo de Descargo y Recibo de Pago (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: 1000, unit: 'por documento' },
  { name: 'Recibo de Descargo y Recibo de Pago (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 500, notarizacion: 2000, unit: 'por documento' },

  // ═══════════════════════════════════════════════════════
  // ACTOS AUTÉNTICOS
  // ═══════════════════════════════════════════════════════
  { name: 'Declaración Jurada - Soltería, Domicilio, Unión Libre (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 250, notarizacion: 700, unit: 'por documento' },
  { name: 'Declaración Jurada - Soltería, Domicilio, Unión Libre (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 350, notarizacion: 1000, unit: 'por documento' },
  { name: 'Notoriedad Jurada (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 400, notarizacion: 1000, unit: 'por documento' },
  { name: 'Pagaré Notarial (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: 700, unit: 'por documento' },
  { name: 'Pagaré Notarial (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 400, notarizacion: 1000, unit: 'por documento' },
  { name: 'Pagaré Notarial (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 600, notarizacion: 2000, unit: 'por documento' },
  { name: 'Acto de Partición Amigable (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 400, notarizacion: 1000, unit: 'por documento' },
  { name: 'Acto de Partición Amigable (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 800, notarizacion: 2500, unit: 'por documento' },
  { name: 'Acto de Donación Entre Vivos (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 400, notarizacion: 1000, unit: 'por documento' },
  { name: 'Acto de Donación Entre Vivos (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 800, notarizacion: 2500, unit: 'por documento' },
  { name: 'Notoriedad de Determinación de Herederos (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 500, notarizacion: 1000, unit: 'por documento' },
  { name: 'Notoriedad de Determinación de Herederos (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 1000, notarizacion: 2500, unit: 'por documento' },
  { name: 'Declaración de Testamento - Bienes Post Mortem (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 500, notarizacion: 1000, unit: 'por documento' },
  { name: 'Declaración de Testamento - Bienes Post Mortem (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 1000, notarizacion: 2500, unit: 'por documento' },
  { name: 'Estipulación y Convenciones de Divorcio Mutuo Consentimiento (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 500, notarizacion: 1000, unit: 'por documento' },
  { name: 'Estipulación y Convenciones de Divorcio Mutuo Consentimiento (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 1000, notarizacion: 2000, unit: 'por documento' },

  // ═══════════════════════════════════════════════════════
  // PODERES Y ACUERDOS
  // ═══════════════════════════════════════════════════════
  { name: 'Poder Especial de Autorización (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 250, notarizacion: 700, unit: 'por documento' },
  { name: 'Poder Especial de Autorización (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 400, notarizacion: 1000, unit: 'por documento' },
  { name: 'Poder Cuota Litis (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 200, notarizacion: 700, unit: 'por documento' },
  { name: 'Poder Cuota Litis (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: 1000, unit: 'por documento' },
  { name: 'Poder Cuota Litis (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 500, notarizacion: 1500, unit: 'por documento' },
  { name: 'Acuerdo Amigable (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: 700, unit: 'por documento' },
  { name: 'Acuerdo Amigable Especializado o Extenso (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 700, notarizacion: 1000, unit: 'por documento' },
  { name: 'Acuerdo Amigable Especializado o Extenso (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 1000, notarizacion: 1500, unit: 'por documento' },

  // ═══════════════════════════════════════════════════════
  // RENTAS Y/O ALQUILERES
  // ═══════════════════════════════════════════════════════
  { name: 'Contrato de Alquiler - Vivienda (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: 500, unit: 'por documento' },
  { name: 'Contrato de Alquiler - Vivienda (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 400, notarizacion: 700, unit: 'por documento' },
  { name: 'Contrato de Alquiler - Vivienda (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 600, notarizacion: 1000, unit: 'por documento' },
  { name: 'Contrato de Alquiler - Local Comercial (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 400, notarizacion: 700, unit: 'por documento' },
  { name: 'Contrato de Alquiler - Local Comercial (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 600, notarizacion: 1000, unit: 'por documento' },
  { name: 'Contrato de Alquiler - Local Comercial (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 1000, notarizacion: 2000, unit: 'por documento' },
  { name: 'Contrato de Renta de Vehículo (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 300, notarizacion: 700, unit: 'por documento' },
  { name: 'Contrato de Renta de Vehículo (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 500, notarizacion: 1000, unit: 'por documento' },
  { name: 'Contrato de Renta de Vehículo (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 1000, notarizacion: 2500, unit: 'por documento' },
  { name: 'Contrato de Alquiler - Nave Comercial (Sencillo)', complexity: 'S', category: CATEGORIES.REDACCION, digitacion: 500, notarizacion: 1000, unit: 'por documento' },
  { name: 'Contrato de Alquiler - Nave Comercial (Extensivo)', complexity: 'E', category: CATEGORIES.REDACCION, digitacion: 1000, notarizacion: 2000, unit: 'por documento' },
  { name: 'Contrato de Alquiler - Nave Comercial (Avanzado)', complexity: 'A', category: CATEGORIES.REDACCION, digitacion: 1500, notarizacion: 3000, unit: 'por documento' },
];

async function patch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure category exists
    for (const catName of Object.values(CATEGORIES)) {
      await client.query(
        `INSERT INTO service_categories (name, description, abbreviation, color, category_type, active)
         VALUES ($1, $2, $3, $4, 'service', true)
         ON CONFLICT (name) DO UPDATE SET active = true`,
        [catName, null, catName.slice(0, 3).toUpperCase(), '#6366f1']
      );
    }

    const catRes = await client.query(`SELECT id, name FROM service_categories WHERE name = ANY($1)`, [Object.values(CATEGORIES)]);
    const catMap = Object.fromEntries(catRes.rows.map(r => [r.name, r.id]));

    let inserted = 0;
    let updated = 0;

    for (const svc of SERVICES) {
      const catId = catMap[svc.category];
      if (!catId) {
        console.warn(`⚠️ Category not found: ${svc.category} for ${svc.name}`);
        continue;
      }

      const existing = await client.query(
        `SELECT id FROM service_catalog WHERE name = $1`,
        [svc.name]
      );

      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO service_catalog (name, description, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type, complexity, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [svc.name, svc.description || null, catId, svc.digitacion, svc.notarizacion || null, JSON.stringify(svc.tiers || []), svc.unit, svc.complexity]
        );
        inserted++;
      } else {
        await client.query(
          `UPDATE service_catalog
           SET category_id = $1,
               digitacion_price = $2,
               notarizacion_price = $3,
               price_tiers = $4,
               unit_type = $5,
               complexity = $6,
               active = true,
               updated_at = NOW()
           WHERE name = $7`,
          [catId, svc.digitacion, svc.notarizacion || null, JSON.stringify(svc.tiers || []), svc.unit, svc.complexity, svc.name]
        );
        updated++;
      }
    }

    await client.query('COMMIT');
    console.log(`✅ S/E/A patch complete: ${inserted} inserted, ${updated} updated`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ S/E/A patch failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

patch();
