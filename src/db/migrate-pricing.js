/**
 * Migration: Add digitacion_price and notarizacion_price to services
 * Seed comprehensive pricing data for Guru Soluciones
 */
const pool = require('./pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add new columns if they don't exist
    const cols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'services' AND column_name IN ('digitacion_price', 'notarizacion_price', 'price_tiers', 'unit_type')
    `);
    const existing = cols.rows.map(r => r.column_name);

    if (!existing.includes('digitacion_price')) {
      await client.query(`ALTER TABLE services ADD COLUMN digitacion_price NUMERIC(12,2)`);
      console.log('✅ Added digitacion_price');
    }
    if (!existing.includes('notarizacion_price')) {
      await client.query(`ALTER TABLE services ADD COLUMN notarizacion_price NUMERIC(12,2)`);
      console.log('✅ Added notarizacion_price');
    }
    if (!existing.includes('price_tiers')) {
      await client.query(`ALTER TABLE services ADD COLUMN price_tiers JSONB DEFAULT '[]'`);
      console.log('✅ Added price_tiers');
    }
    if (!existing.includes('unit_type')) {
      await client.query(`ALTER TABLE services ADD COLUMN unit_type VARCHAR(50) DEFAULT 'por documento'`);
      console.log('✅ Added unit_type');
    }

    // Get category IDs
    const cats = await client.query(`SELECT id, name FROM service_categories`);
    const catMap = {};
    for (const c of cats.rows) catMap[c.name] = c.id;

    // Clear existing services (we'll re-seed everything)
    await client.query(`DELETE FROM services`);
    console.log('🧹 Cleared old services');

    // Notarization tiers per Ley 140-15 / user pricing
    const VENTA_TIERS = [
      {label:'Hasta RD$100K', min:0, max:100000, price:500},
      {label:'RD$100K-800K', min:100001, max:800000, price:700},
      {label:'RD$800K-1M', min:800001, max:1000000, price:1000},
      {label:'RD$1M-3M', min:1000001, max:3000000, price:2000},
      {label:'RD$3M-5M', min:3000001, max:5000000, price:3000},
      {label:'RD$5M+', min:5000001, max:null, price:5000}
    ];

    const services = [
      // ═══════════════════════════════════════════════════════
      // CONTRATOS - VENTAS (Bajo firma privada)
      // ═══════════════════════════════════════════════════════
      { name: 'Acto de Venta - Motocicleta', category: 'Redactar o digitar un documento', digitacion: 200, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta - Vehículo Liviano', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta - Vehículo Pesado', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta - Bien Inmueble', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta - Terreno', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta - Punto Comercial', category: 'Redactar o digitar un documento', digitacion: 350, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta - Nave Marítima', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta - Ganado/Animal', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta - Máquina Industrial', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta Condicional - Vehículo', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Acto de Venta Condicional - Inmueble', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1500, unit: 'por documento', tiers: VENTA_TIERS },
      { name: 'Cesión de Crédito', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 500, unit: 'por documento' },
      { name: 'Recibo de Descargo / Pago', category: 'Redactar o digitar un documento', digitacion: 150, notarizacion: 500, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // CONTRATOS TRASLATIVOS
      // ═══════════════════════════════════════════════════════
      { name: 'Contrato de Hipoteca', category: 'Redactar o digitar un documento', digitacion: 350, notarizacion: 1000, unit: 'por documento' },
      { name: 'Permuta', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Promesa de Compra-Venta', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Contrato de Anticresis', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Aporte en Naturaleza', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Contrato de Prenda', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // RENTAS / ALQUILERES
      // ═══════════════════════════════════════════════════════
      { name: 'Contrato de Alquiler - Vivienda Sencillo', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 500, unit: 'por documento' },
      { name: 'Contrato de Alquiler - Vivienda Avanzado', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Contrato de Renta - Vehículo', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Contrato de Renta - Local Comercial', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Contrato de Renta - Terreno', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Contrato de Alquiler Amueblado', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 1000, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // ACUERDOS
      // ═══════════════════════════════════════════════════════
      { name: 'Comodato (Uso)', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Pagaré Notarial', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 1000, unit: 'por documento' },
      { name: 'Partición Amigable', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 1000, unit: 'por documento' },
      { name: 'Donación Entre Vivos', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 1000, unit: 'por documento' },
      { name: 'Determinación de Herederos', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento', tiers: [{label:'Simple',min:0,max:2,price:1000},{label:'Extensa',min:3,max:5,price:1500},{label:'Múltiples bienes',min:6,max:999,price:2500}] },
      { name: 'Testamento', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Acuerdo Amigable', category: 'Redactar o digitar un documento', digitacion: 350, notarizacion: 700, unit: 'por documento' },
      { name: 'Acuerdo Amigable Especializado', category: 'Redactar o digitar un documento', digitacion: 1000, notarizacion: 1500, unit: 'por documento' },
      { name: 'Descargo y Finiquito - Inmuebles', category: 'Redactar o digitar un documento', digitacion: 1000, notarizacion: 1000, unit: 'por documento' },
      { name: 'Contrato Personalizado', category: 'Redactar o digitar un documento', digitacion: 1000, notarizacion: 1500, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // DIVORCIO / MATRIMONIO
      // ═══════════════════════════════════════════════════════
      { name: 'Divorcio Mutuo Consentimiento', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Matrimonio / Estipulaciones', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // PODERES Y AUTORIZACIONES
      // ═══════════════════════════════════════════════════════
      { name: 'Poder - Depositar Documentos', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 700, unit: 'por documento' },
      { name: 'Poder - Retirar Certificaciones', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 700, unit: 'por documento' },
      { name: 'Poder - Realizar Pagos', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 700, unit: 'por documento' },
      { name: 'Poder - Guarda y Tutela de Menor', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Poder - Viaje de Menor', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Poder - Venta de Propiedades', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Poder - Cobrar Suma de Dinero', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Poder - Procesos Judiciales', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Poder - Ampliatorio', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 800, unit: 'por documento' },
      { name: 'Poder Cuota Litis', category: 'Redactar o digitar un documento', digitacion: 200, notarizacion: 1000, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // DECLARACIONES JURADAS
      // ═══════════════════════════════════════════════════════
      { name: 'Declaración Jurada - Unión Libre', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Soltería', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Residencia/Domicilio', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - No Convivencia', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Mejora Const. Estado', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Mejora Const. Particulares', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Bienes e Ingresos', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Portador de Arma', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Pérdida Certificado Título', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Fabricación de Trailers', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Procedencia/Lavado', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Cambio Nombre Empresa', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Pérdida Cert. Financiero', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Propiedad Comercial', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 700, unit: 'por documento' },
      { name: 'Declaración Jurada - Conversión de Moneda', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 700, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // NOTORIEDADES
      // ═══════════════════════════════════════════════════════
      { name: 'Notoriedad - No Convivencia', category: 'Redactar o digitar un documento', digitacion: 400, notarizacion: 1000, unit: 'por documento' },
      { name: 'Notoriedad - Conocen al Fallecido', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Notoriedad - Buena Conducta', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Notoriedad - Buena Conducta Empleado', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Notoriedad - Manutención Parental', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Notoriedad - No Descendencia', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Notoriedad - Domicilio', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // COMPROBACIONES
      // ═══════════════════════════════════════════════════════
      { name: 'Comprobación de Documentos', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Comprobación de Autenticidad', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },
      { name: 'Comprobación de Evento', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 700, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // COMPULSA / ADENDUM
      // ═══════════════════════════════════════════════════════
      { name: 'Compulsa Notarial', category: 'Notarización', digitacion: 250, notarizacion: 800, unit: 'por documento' },
      { name: 'Adendum', category: 'Modificación de un Documento', digitacion: 250, notarizacion: 1000, unit: 'por documento' },
      { name: 'Nota Correctiva / Fe de Errata', category: 'Modificación de un Documento', digitacion: 100, notarizacion: 100, unit: 'por unidad' },

      // ═══════════════════════════════════════════════════════
      // INSTANCIAS
      // ═══════════════════════════════════════════════════════
      { name: 'Instancia - Solicitud de Documentos', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Solicitud de Certificaciones', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Levantamiento', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Depósito de Documentos', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Arrendamiento Inmueble', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Desglose de Expediente', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Desglose de Pago', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Corrección', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Autorización', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Fijación de Audiencia', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Pronunciamiento', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Asignación de Sala', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Inscripción Nombre Comercial', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Transferencia', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Prórroga de Expediente', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Construcción', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Recogida de Escombros', category: 'Redactar y Certificar una Traducción', digitacion: 150, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Oposición', category: 'Redactar y Certificar una Traducción', digitacion: 200, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Avalúo de Inmueble', category: 'Redactar y Certificar una Traducción', digitacion: 200, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Depósito de Inventario', category: 'Redactar y Certificar una Traducción', digitacion: 300, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Subsanación de Expediente', category: 'Redactar y Certificar una Traducción', digitacion: 300, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Recurso de Amparo', category: 'Redactar y Certificar una Traducción', digitacion: 500, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Recurso de Reconsideración', category: 'Redactar y Certificar una Traducción', digitacion: 500, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Recurso de Apelación', category: 'Redactar y Certificar una Traducción', digitacion: 500, notarizacion: null, unit: 'por documento' },
      { name: 'Instancia - Comunicación/Invitación', category: 'Redactar y Certificar una Traducción', digitacion: 500, notarizacion: null, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // EMPRESAS / ESTATUTOS
      // ═══════════════════════════════════════════════════════
      { name: 'Acto Constitutivo (EIRL, SRL)', category: 'Redactar o digitar un documento', digitacion: 500, notarizacion: 1000, unit: 'por documento' },
      { name: 'Estatutos Sociales', category: 'Redactar o digitar un documento', digitacion: 250, notarizacion: 1500, unit: 'por documento' },
      { name: 'Asamblea Extraordinaria/Ordinaria', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 1000, unit: 'por documento' },
      { name: 'Nómina de Pagos/Presencia', category: 'Redactar o digitar un documento', digitacion: 300, notarizacion: 500, unit: 'por documento' },

      // ═══════════════════════════════════════════════════════
      // TRADUCCIONES
      // ═══════════════════════════════════════════════════════
      { name: 'Traducción - Acta Natal (Idiomas básicos)', category: 'Redactar y Certificar una Traducción', digitacion: 700, notarizacion: null, unit: 'por documento' },
      { name: 'Traducción - Acta Natal (Idiomas avanzados)', category: 'Redactar y Certificar una Traducción', digitacion: 800, notarizacion: null, unit: 'por documento' },
      { name: 'Traducción - Acta Extranjera al Español', category: 'Redactar y Certificar una Traducción', digitacion: 1000, notarizacion: null, unit: 'por documento' },
      { name: 'Traducción - Licencia/Matrícula/Carnet (Nativo)', category: 'Redactar y Certificar una Traducción', digitacion: 700, notarizacion: null, unit: 'por lado' },
      { name: 'Traducción - Licencia/Matrícula/Carnet (Extranjero)', category: 'Redactar y Certificar una Traducción', digitacion: 1000, notarizacion: null, unit: 'por lado' },
      { name: 'Traducción - Texto Manuscrito Extranjero', category: 'Redactar y Certificar una Traducción', digitacion: 2500, notarizacion: null, unit: 'por página' },

      // ═══════════════════════════════════════════════════════
      // SERVICIOS DIGITALES
      // ═══════════════════════════════════════════════════════
      { name: 'Apostilla en Cancillería', category: 'Solicitud de Certificaciones', digitacion: 300, notarizacion: null, unit: 'por documento' },
      { name: 'Certificación Estatus Jurídico Inmueble', category: 'Solicitud de Certificaciones', digitacion: 500, notarizacion: null, unit: 'por inmueble' },
      { name: 'Formulario DS-160 (Visa USA)', category: 'Solicitud de Certificaciones', digitacion: 2000, notarizacion: null, unit: 'por persona' },
      { name: 'Solicitud Pasaporte Dominicano', category: 'Solicitud de Certificaciones', digitacion: 500, notarizacion: null, unit: 'por unidad' },
      { name: 'Solicitud DGII/Tribunales/Poder Judicial', category: 'Solicitud de Certificaciones', digitacion: 500, notarizacion: null, unit: 'por unidad' },
      { name: 'Pagos en Línea', category: 'Solicitud de Certificaciones', digitacion: 500, notarizacion: null, unit: 'por unidad' },
      { name: 'Certificación Buena Costumbre/No Antecedentes', category: 'Solicitud de Certificaciones', digitacion: 250, notarizacion: null, unit: 'por unidad' },
      { name: 'Formularios Dirección General de Migración', category: 'Solicitud de Certificaciones', digitacion: 600, notarizacion: null, unit: 'por unidad' },
      { name: 'Formularios Dirección General de Aduanas', category: 'Solicitud de Certificaciones', digitacion: 500, notarizacion: null, unit: 'por unidad' },
      { name: 'Inscripción Online (general)', category: 'Solicitud de Certificaciones', digitacion: 500, notarizacion: null, unit: 'por unidad' },

      // ═══════════════════════════════════════════════════════
      // NOTIFICACIONES
      // ═══════════════════════════════════════════════════════
      { name: 'Notificación Sencilla', category: 'Mensajería', digitacion: 150, notarizacion: null, unit: 'por hoja' },
      { name: 'Notificación Avanzada', category: 'Mensajería', digitacion: 300, notarizacion: null, unit: 'por hoja' },
      { name: 'Notificación Personalizada', category: 'Mensajería', digitacion: 300, notarizacion: null, unit: 'por hoja' },

      // ═══════════════════════════════════════════════════════
      // MODIFICACIONES / CORRECCIONES
      // ═══════════════════════════════════════════════════════
      { name: 'Modificación de Documento Existente', category: 'Modificación de un Documento', digitacion: 100, notarizacion: null, unit: 'por documento' },
      { name: 'Revisión y Formato', category: 'Modificación de un Documento', digitacion: 50, notarizacion: null, unit: 'por documento' },
      { name: 'Escáner de Documento', category: 'Scanner de documentos', digitacion: 5, notarizacion: null, unit: 'por hoja' },

      // ═══════════════════════════════════════════════════════
      // IMPRESIONES
      // ═══════════════════════════════════════════════════════
      { name: 'Fotocopia 8½x11"', category: 'Impresión', digitacion: 3, notarizacion: null, unit: 'por unidad' },
      { name: 'Fotocopia 8½x14" (Legal)', category: 'Impresión', digitacion: 10, notarizacion: null, unit: 'por unidad' },
      { name: 'Fotocopia 11x17"', category: 'Impresión', digitacion: 20, notarizacion: null, unit: 'por unidad' },
      { name: 'Impresión B&N 8½x11"', category: 'Impresión', digitacion: 10, notarizacion: null, unit: 'por unidad' },
      { name: 'Impresión B&N 8½x14" (Legal)', category: 'Impresión', digitacion: 25, notarizacion: null, unit: 'por unidad' },
      { name: 'Impresión B&N 11x17"', category: 'Impresión', digitacion: 50, notarizacion: null, unit: 'por unidad' },
      { name: 'Impresión Color 8½x11"', category: 'Impresión', digitacion: 25, notarizacion: null, unit: 'por unidad' },
      { name: 'Impresión Color 8½x14" (Legal)', category: 'Impresión', digitacion: 50, notarizacion: null, unit: 'por unidad' },
      { name: 'Impresión Color 11x17"', category: 'Impresión', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Impresión Lámina Foto', category: 'Impresión', digitacion: 40, notarizacion: null, unit: 'por unidad' },
      { name: 'Foto 2x2', category: 'Fotos 2x2', digitacion: 300, notarizacion: null, unit: 'por unidad' },
      { name: 'Brochures Papel Satinado', category: 'Impresión', digitacion: 70, notarizacion: null, unit: 'por unidad' },

      // ═══════════════════════════════════════════════════════
      // MENSAJERÍA
      // ═══════════════════════════════════════════════════════
      { name: 'Mensajería Local (Santo Domingo)', category: 'Mensajería', digitacion: 200, notarizacion: null, unit: 'por servicio' },

      // ═══════════════════════════════════════════════════════
      // TIENDA FÍSICA - PAPELERÍA
      // ═══════════════════════════════════════════════════════
      { name: 'Papel Bond 8.5x11" Blanco', category: 'Papelería', digitacion: 2, notarizacion: null, unit: 'por unidad' },
      { name: 'Papel Cartulina Blanco', category: 'Papelería', digitacion: 10, notarizacion: null, unit: 'por unidad' },
      { name: 'Papel Adhesivo Satinado', category: 'Papelería', digitacion: 20, notarizacion: null, unit: 'por unidad' },
      { name: 'Papel Satinado Slim', category: 'Papelería', digitacion: 8, notarizacion: null, unit: 'por unidad' },
      { name: 'Papel Vegetal', category: 'Papelería', digitacion: 10, notarizacion: null, unit: 'por unidad' },
      { name: 'CD', category: 'Papelería', digitacion: 50, notarizacion: null, unit: 'por unidad' },
      { name: 'Folder Manila', category: 'Papelería', digitacion: 10, notarizacion: null, unit: 'por unidad' },
      { name: 'Sobre Manila', category: 'Papelería', digitacion: 10, notarizacion: null, unit: 'por unidad' },
      { name: 'Folder Multicolor Especial', category: 'Papelería', digitacion: 25, notarizacion: null, unit: 'por unidad' },
      { name: 'Tijera Pequeña', category: 'Papelería', digitacion: 70, notarizacion: null, unit: 'por unidad' },
      { name: 'Tijera Grande', category: 'Papelería', digitacion: 170, notarizacion: null, unit: 'por unidad' },
      { name: 'Liquid Paper Brocha', category: 'Papelería', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Liquid Paper Lápiz', category: 'Papelería', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Sacapuntas', category: 'Papelería', digitacion: 25, notarizacion: null, unit: 'por unidad' },
      { name: 'Lápiz HB2', category: 'Papelería', digitacion: 15, notarizacion: null, unit: 'por unidad' },
      { name: 'Bolígrafo (Azul/Negro/Rojo/Verde)', category: 'Papelería', digitacion: 20, notarizacion: null, unit: 'por unidad' },
      { name: 'Carpeta Plástica', category: 'Papelería', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Carpeta Plástica Archivo', category: 'Papelería', digitacion: 250, notarizacion: null, unit: 'por unidad' },
      { name: 'Carpeta Horizontal Plástica', category: 'Papelería', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Carpeta Cartón Duro', category: 'Papelería', digitacion: 125, notarizacion: null, unit: 'por unidad' },
      { name: 'Carpeta Hojas Perforadas', category: 'Papelería', digitacion: 250, notarizacion: null, unit: 'por unidad' },
      { name: 'Tabla Pisa Papel', category: 'Papelería', digitacion: 80, notarizacion: null, unit: 'por unidad' },
      { name: 'Marcadores Pizarra', category: 'Papelería', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Resaltador Multicolor', category: 'Papelería', digitacion: 85, notarizacion: null, unit: 'por unidad' },

      // ═══════════════════════════════════════════════════════
      // COMESTIBLES
      // ═══════════════════════════════════════════════════════
      { name: 'Galletas de Avena', category: 'Consumibles', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Ajonjolí / Maní', category: 'Consumibles', digitacion: 50, notarizacion: null, unit: 'por unidad' },
      { name: 'Semilla de Cajuil', category: 'Consumibles', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Semilla de Almendra', category: 'Consumibles', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Semilla de Pistacho', category: 'Consumibles', digitacion: 120, notarizacion: null, unit: 'por unidad' },
      { name: 'Botella de Agua', category: 'Consumibles', digitacion: 25, notarizacion: null, unit: 'por unidad' },
      { name: 'Jugo Natural', category: 'Consumibles', digitacion: 100, notarizacion: null, unit: 'por unidad' },
      { name: 'Bizcocho de Maní', category: 'Consumibles', digitacion: 100, notarizacion: null, unit: 'por unidad' },
    ];

    for (const svc of services) {
      const catId = catMap[svc.category];
      if (!catId) {
        console.warn(`⚠️ Category not found: ${svc.category} for ${svc.name}`);
        continue;
      }
      await client.query(
        `INSERT INTO services (name, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (name) DO UPDATE SET
           category_id = EXCLUDED.category_id,
           digitacion_price = EXCLUDED.digitacion_price,
           notarizacion_price = EXCLUDED.notarizacion_price,
           price_tiers = EXCLUDED.price_tiers,
           unit_type = EXCLUDED.unit_type`,
        [svc.name, catId, svc.digitacion, svc.notarizacion || null, JSON.stringify(svc.tiers || []), svc.unit]
      );
    }

    await client.query('COMMIT');
    console.log(`✅ Seeded ${services.length} services with digitación + notarización prices`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
