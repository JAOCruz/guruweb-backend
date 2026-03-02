const bcrypt = require('bcryptjs');
const pool = require('./database');

async function initializeDatabase() {
  try {
    console.log('🔄 Initializing database...');

    // Check environment - dev user only created in development
    const isProduction = process.env.NODE_ENV === 'production';
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);

    // Create settings table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        employee_percentage DECIMAL(5, 2) NOT NULL CHECK (employee_percentage >= 0 AND employee_percentage <= 100),
        effective_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index on effective_date for efficient queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_settings_effective_date ON settings(effective_date DESC)
    `);

    // Insert default 50/50 split if no settings exist
    await pool.query(`
      INSERT INTO settings (employee_percentage, effective_date)
      SELECT 50.00, CURRENT_DATE
      WHERE NOT EXISTS (SELECT 1 FROM settings)
    `);

    const adminPassword = await bcrypt.hash('admin123', 10);
    const employeePassword = await bcrypt.hash('password123', 10);

    await pool.query(
      `INSERT INTO users (username, password_hash, role, data_column) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING`,
      ['admin', adminPassword, 'admin', null]
    );

    const employees = [
      ['hengi', 'HENGI'],
      ['marleni', 'MARLENI'],
      ['israel', 'ISRAEL'],
      ['thaicar', 'THAICAR']
    ];

    for (const [username, dataColumn] of employees) {
      await pool.query(
        `INSERT INTO users (username, password_hash, role, data_column)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING`,
        [username, employeePassword, 'employee', dataColumn]
      );
    }

    // DEVELOPMENT ONLY: Create test user
    if (!isProduction) {
      const devPassword = await bcrypt.hash('dev123', 10);
      await pool.query(
        `INSERT INTO users (username, password_hash, role, data_column)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING`,
        ['devtest', devPassword, 'admin', null]
      );
      console.log('🔧 DEV MODE: Test user created (username=devtest, password=dev123)');
    }

    console.log('✅ Database initialized successfully!');
    console.log('📝 Default credentials:');
    console.log('   Admin: username=admin, password=admin123');
    console.log('   Employees: username=hengi/marleni/israel/thaicar, password=password123');

    if (!isProduction) {
      console.log('   🔧 DEV ONLY: username=devtest, password=dev123 (admin role)');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    process.exit(1);
  }
}

initializeDatabase();
