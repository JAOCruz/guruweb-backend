/**
 * Patch: Recategorize notarization services and fix prices per official tariff
 */
const pool = require('./pool');

const NOTARIZACION_SERVICES = [
  // Ventas
  'Acto de Venta - Motocicleta',
  'Acto de Venta - Vehículo Liviano',
  'Acto de Venta - Vehículo Pesado',
  'Acto de Venta - Bien Inmueble',
  'Acto de Venta - Terreno',
  'Acto de Venta - Punto Comercial',
  'Acto de Venta - Nave Marítima',
  'Acto de Venta - Ganado/Animal',
  'Acto de Venta - Máquina Industrial',
  'Acto de Venta Condicional - Vehículo',
  'Acto de Venta Condicional - Inmueble',
  'Cesión de Crédito',
  'Recibo de Descargo / Pago',
  // Traslativos
  'Contrato de Hipoteca',
  'Permuta',
  'Promesa de Compra-Venta',
  'Contrato de Anticresis',
  'Aporte en Naturaleza',
  'Contrato de Prenda',
  // Rentas
  'Contrato de Alquiler - Vivienda Sencillo',
  'Contrato de Alquiler - Vivienda Avanzado',
  'Contrato de Renta - Vehículo',
  'Contrato de Renta - Local Comercial',
  'Contrato de Renta - Terreno',
  'Contrato de Alquiler Amueblado',
  // Acuerdos / Hereditarios
  'Comodato (Uso)',
  'Pagaré Notarial',
  'Partición Amigable',
  'Donación Entre Vivos',
  'Determinación de Herederos',
  'Testamento',
  'Acuerdo Amigable',
  'Acuerdo Amigable Especializado',
  'Descargo y Finiquito - Inmuebles',
  'Contrato Personalizado',
  // Divorcio
  'Divorcio Mutuo Consentimiento',
  'Matrimonio / Estipulaciones',
  // Poderes
  'Poder - Depositar Documentos',
  'Poder - Retirar Certificaciones',
  'Poder - Realizar Pagos',
  'Poder - Guarda y Tutela de Menor',
  'Poder - Viaje de Menor',
  'Poder - Venta de Propiedades',
  'Poder - Cobrar Suma de Dinero',
  'Poder - Procesos Judiciales',
  'Poder - Ampliatorio',
  'Poder Cuota Litis',
  // Declaraciones
  'Declaración Jurada - Soltería',
  'Declaración Jurada - Residencia/Domicilio',
  'Declaración Jurada - Unión Libre',
  'Declaración Jurada - No Convivencia',
  'Declaración Jurada - Portador de Arma',
  'Declaración Jurada - Mejora Const. Estado',
  'Declaración Jurada - Mejora Const. Particulares',
  'Declaración Jurada - Pérdida Cert. Financiero',
  'Declaración Jurada - Pérdida Certificado Título',
  'Declaración Jurada - Fabricación de Trailers',
  'Declaración Jurada - Cambio Nombre Empresa',
  'Declaración Jurada - Procedencia/Lavado',
  'Declaración Jurada - Propiedad Comercial',
  'Declaración Jurada - Bienes e Ingresos',
  'Declaración Jurada - Conversión de Moneda',
  // Notoriedades
  'Notoriedad - No Convivencia',
  'Notoriedad - Conocen al Fallecido',
  'Notoriedad - Buena Conducta',
  'Notoriedad - Buena Conducta Empleado',
  'Notoriedad - Manutención Parental',
  'Notoriedad - No Descendencia',
  'Notoriedad - Domicilio',
  // Comprobaciones
  'Comprobación de Documentos',
  'Comprobación de Autenticidad',
  'Comprobación de Evento',
];

const HEREDITARIO_TIERS = [
  { label: 'Simple (0-2 bienes)', min: 0, max: 2, price: 1000 },
  { label: 'Extensa (3-5 bienes)', min: 3, max: 5, price: 1500 },
  { label: 'Múltiples bienes (6+)', min: 6, max: null, price: 2500 }
];

const PAGARE_TIERS = [
  { label: 'Hasta RD$100K', min: 0, max: 100000, price: 1000 },
  { label: 'RD$100K-500K', min: 100001, max: 500000, price: 1500 },
  { label: 'RD$500K-1M', min: 500001, max: 1000000, price: 2000 },
  { label: 'RD$1M-3M', min: 1000001, max: 3000000, price: 3000 },
  { label: 'RD$3M+', min: 3000001, max: null, price: 5000 }
];

async function patch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get Notarización category id
    const catRes = await client.query(
      `SELECT id FROM service_categories WHERE name = 'Notarización'`
    );
    let notCatId = catRes.rows[0]?.id;

    // If Notarización category doesn't exist, create it
    if (!notCatId) {
      const newCat = await client.query(
        `INSERT INTO service_categories (name, description, abbreviation, color, category_type, active)
         VALUES ('Notarización', 'Servicios de notarización y autenticación de documentos', 'NOT', '#ef4444', 'service', true)
         RETURNING id`
      );
      notCatId = newCat.rows[0].id;
      console.log('✅ Created Notarización category id:', notCatId);
    }

    // Recategorize services
    for (const name of NOTARIZACION_SERVICES) {
      await client.query(
        `UPDATE services SET category_id = $1 WHERE name = $2`,
        [notCatId, name]
      );
    }
    console.log(`✅ Recategorized ${NOTARIZACION_SERVICES.length} services to Notarización`);

    // Fix Comprobaciones prices: notarizacion 700 -> 1000
    await client.query(
      `UPDATE services SET notarizacion_price = 1000 WHERE name LIKE 'Comprobación%'`
    );
    console.log('✅ Fixed Comprobaciones notarización to RD$1,000');

    // Fix Determinación de Herederos top tier max: 999 -> null
    await client.query(
      `UPDATE services SET price_tiers = jsonb_set(
        price_tiers,
        '{2,max}',
        'null',
        false
      ) WHERE name = 'Determinación de Herederos'`
    );
    console.log('✅ Fixed Herederos top tier to open-ended (null)');

    // Add tiers to hereditario services
    const hereditarios = ['Testamento', 'Donación Entre Vivos', 'Partición Amigable'];
    for (const name of hereditarios) {
      await client.query(
        `UPDATE services SET price_tiers = $1 WHERE name = $2`,
        [JSON.stringify(HEREDITARIO_TIERS), name]
      );
    }
    console.log('✅ Added hereditario tiers to Testamento, Donación, Partición');

    // Add tiers to Pagaré Notarial
    await client.query(
      `UPDATE services SET price_tiers = $1 WHERE name = 'Pagaré Notarial'`,
      [JSON.stringify(PAGARE_TIERS)]
    );
    console.log('✅ Added value-based tiers to Pagaré Notarial');

    // Add missing Sucesión if not exists
    const sucRes = await client.query(`SELECT id FROM services WHERE name = 'Sucesión'`);
    if (sucRes.rows.length === 0) {
      await client.query(
        `INSERT INTO services (name, description, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type, active)
         VALUES ('Sucesión', 'Trámite de sucesión hereditaria', $1, 500, 1000, $2, 'por documento', true)`,
        [notCatId, JSON.stringify(HEREDITARIO_TIERS)]
      );
      console.log('✅ Added Sucesión service');
    }

    await client.query('COMMIT');
    console.log('\n🎉 Patch complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Patch failed:', err);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

patch();
