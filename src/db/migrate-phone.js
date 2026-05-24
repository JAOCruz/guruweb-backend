const pool = require('./pool');

async function migrate() {
  try {
    // Add phone column to messages if it doesn't exist
    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
    `);
    console.log('Added phone column to messages table');

    // Create index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    `);
    console.log('Created index on messages.phone');

    // Backfill phone for existing messages that have a client_id
    const { rowCount } = await pool.query(`
      UPDATE messages m
      SET phone = c.phone
      FROM clients c
      WHERE m.client_id = c.id AND m.phone IS NULL;
    `);
    console.log(`Backfilled phone for ${rowCount} existing messages`);

    console.log('Migration complete!');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
