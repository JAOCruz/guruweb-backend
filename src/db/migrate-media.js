const pool = require('./pool');

async function migrate() {
  try {
    // Create client_media table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_media (
        id             SERIAL PRIMARY KEY,
        phone          VARCHAR(20) NOT NULL,
        client_id      INT REFERENCES clients(id) ON DELETE SET NULL,
        wa_message_id  VARCHAR(255),
        media_type     VARCHAR(20) NOT NULL,
        mime_type      VARCHAR(100),
        original_name  VARCHAR(255),
        saved_name     VARCHAR(255) NOT NULL,
        file_path      TEXT NOT NULL,
        file_size      INT,
        context        VARCHAR(50) DEFAULT 'conversation',
        doc_request_id INT REFERENCES document_requests(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Created client_media table');

    // Add file_path to document_requests
    await pool.query(`
      ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS file_path TEXT;
    `);
    console.log('Added file_path column to document_requests');

    // Add media_id to document_requests
    await pool.query(`
      ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS media_id INT REFERENCES client_media(id) ON DELETE SET NULL;
    `);
    console.log('Added media_id column to document_requests');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_client_media_phone ON client_media(phone);
      CREATE INDEX IF NOT EXISTS idx_client_media_client ON client_media(client_id);
      CREATE INDEX IF NOT EXISTS idx_client_media_doc_req ON client_media(doc_request_id);
    `);
    console.log('Created indexes on client_media');

    console.log('Media migration complete!');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
