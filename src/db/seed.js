const pool = require('./pool');

const serviceCategories = [
  // Store Products
  {
    name: 'Papelería',
    description: 'Venta de objetos físicos de la papelería',
    abbreviation: 'PAP',
    color: '#ef4444',
    category_type: 'product'
  },
  {
    name: 'Consumibles',
    description: 'Comestibles líquidos y físicos de la tienda',
    abbreviation: 'CON',
    color: '#f97316',
    category_type: 'product'
  },
  // Services
  {
    name: 'Impresión',
    abbreviation: 'IMP',
    color: '#3b82f6',
    category_type: 'service'
  },
  {
    name: 'Modificación de un Documento',
    abbreviation: 'MOD',
    color: '#8b5cf6',
    category_type: 'service'
  },
  {
    name: 'Redactar o digitar un documento',
    abbreviation: 'RED',
    color: '#6366f1',
    category_type: 'service'
  },
  {
    name: 'Notarización',
    abbreviation: 'NOT',
    color: '#06b6d4',
    category_type: 'service'
  },
  {
    name: 'Redactar y Certificar una Traducción',
    abbreviation: 'TRA',
    color: '#ec4899',
    category_type: 'service'
  },
  {
    name: 'Solicitud de Certificaciones',
    abbreviation: 'CER',
    color: '#10b981',
    category_type: 'service'
  },
  {
    name: 'Scanner de documentos',
    abbreviation: 'SCN',
    color: '#14b8a6',
    category_type: 'service'
  },
  {
    name: 'Fotos 2x2',
    abbreviation: 'FOT',
    color: '#f59e0b',
    category_type: 'service'
  },
  {
    name: 'Creación De Un Correo',
    abbreviation: 'COR',
    color: '#6366f1',
    category_type: 'service'
  },
  {
    name: 'Compra de Impuestos',
    abbreviation: 'IMP',
    color: '#8b5cf6',
    category_type: 'service'
  },
  {
    name: 'Mensajería',
    abbreviation: 'MEN',
    color: '#06b6d4',
    category_type: 'service'
  },
  {
    name: 'Legalización',
    abbreviation: 'LEG',
    color: '#10b981',
    category_type: 'service'
  },
  {
    name: 'Revisión de contrato',
    abbreviation: 'REV',
    color: '#f59e0b',
    category_type: 'service'
  },
  {
    name: 'Corrección de Documento',
    abbreviation: 'COR',
    color: '#ec4899',
    category_type: 'service'
  },
  {
    name: 'Máquina de escribir',
    abbreviation: 'MAQ',
    color: '#6366f1',
    category_type: 'service'
  }
];

async function seedDatabase() {
  try {
    console.log('Seeding service categories...');

    for (const cat of serviceCategories) {
      await pool.query(
        `INSERT INTO service_categories (name, description, abbreviation, color, category_type, active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (name) DO NOTHING`,
        [cat.name, cat.description || null, cat.abbreviation, cat.color, cat.category_type]
      );
    }

    console.log('✅ Service categories seeded successfully');
  } catch (err) {
    console.error('Error seeding database:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seedDatabase();
