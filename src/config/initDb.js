const bcrypt = require('bcryptjs');
const pool = require('./database');

async function initializeDatabase() {
  try {
    console.log('🔄 Initializing database...');

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

    console.log('✅ Database initialized successfully!');
    console.log('📝 Default credentials:');
    console.log('   Admin: username=admin, password=admin123');
    console.log('   Employees: username=hengi/marleni/israel/thaicar, password=password123');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    process.exit(1);
  }
}

initializeDatabase();
