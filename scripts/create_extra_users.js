const bcrypt = require('bcrypt');
const pool = require('../src/db/pool');

const SALT_ROUNDS = 10;

const newUsers = [
  { username: 'administracion', name: 'Administracion', role: 'digitador', password: 'GuruAdmin2026!' },
  { username: 'auxiliar1', name: 'Auxiliar 1', role: 'auxiliar', password: 'GuruAux1_2026!' },
  { username: 'auxiliar2', name: 'Auxiliar 2', role: 'auxiliar', password: 'GuruAux2_2026!' },
];

async function main() {
  for (const u of newUsers) {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [u.username]);
    if (existing.rows.length > 0) {
      console.log(`User ${u.username} already exists, skipping.`);
      continue;
    }

    const passwordHash = await bcrypt.hash(u.password, SALT_ROUNDS);
    const email = `${u.username}@guru.local`;

    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash, name, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, username, name, role`,
      [u.username, email, passwordHash, u.name, u.role]
    );

    console.log('Created user:', rows[0]);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
