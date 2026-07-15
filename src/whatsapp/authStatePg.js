const pool = require('../db/pool');

let initAuthCreds = () => ({});
let BufferJSON = {
  replacer: (_, value) => value,
  reviver: (_, value) => value,
};

try {
  const baileys = require('@whiskeysockets/baileys');
  initAuthCreds = baileys.initAuthCreds || baileys.utils?.initAuthCreds || (() => ({}));
  BufferJSON = baileys.BufferJSON || BufferJSON;
} catch {
  // Baileys optional — fallback to empty object if not installed
}

function initCreds() {
  return initAuthCreds();
}

function serialize(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize(value) {
  if (!value) return {};
  if (typeof value === 'object') {
    return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
  }
  return JSON.parse(value, BufferJSON.reviver);
}

function makeKeyStore(sessionId) {
  return {
    async get(type, ids) {
      const { rows } = await pool.query(
        'SELECT keys FROM wa_credentials WHERE session_id = $1',
        [sessionId]
      );
      const data = deserialize(rows[0]?.keys) || {};
      const result = {};
      for (const id of ids) {
        const key = `${type}:${id}`;
        const value = data[key];
        if (value) result[id] = value;
      }
      return result;
    },

    async set(data) {
      const { rows } = await pool.query(
        'SELECT keys FROM wa_credentials WHERE session_id = $1',
        [sessionId]
      );
      const existing = deserialize(rows[0]?.keys) || {};
      const merged = { ...existing, ...data };
      await pool.query(
        `INSERT INTO wa_credentials (session_id, creds, keys, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           keys = EXCLUDED.keys,
           updated_at = NOW()`,
        [sessionId, JSON.stringify({}), serialize(merged)]
      );
    },

    async del(type, ids) {
      const { rows } = await pool.query(
        'SELECT keys FROM wa_credentials WHERE session_id = $1',
        [sessionId]
      );
      const existing = deserialize(rows[0]?.keys) || {};
      for (const id of ids) {
        delete existing[`${type}:${id}`];
      }
      await pool.query(
        `INSERT INTO wa_credentials (session_id, creds, keys, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           keys = EXCLUDED.keys,
           updated_at = NOW()`,
        [sessionId, JSON.stringify({}), serialize(existing)]
      );
    },

    async loadAnotherKeyFromDataSource() {
      // Not implemented — full keys are already loaded from DB
    },
  };
}

async function usePostgresAuthState(sessionId) {
  const { rows } = await pool.query(
    'SELECT creds, keys FROM wa_credentials WHERE session_id = $1',
    [sessionId]
  );

  const creds = rows[0]?.creds ? deserialize(rows[0].creds) : initCreds();
  const keys = makeKeyStore(sessionId);

  const saveCreds = async (newCreds) => {
    await pool.query(
      `INSERT INTO wa_credentials (session_id, creds, keys, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         creds = EXCLUDED.creds,
         updated_at = NOW()`,
      [sessionId, serialize(newCreds || creds), serialize(rows[0]?.keys || {})]
    );
  };

  const clear = async () => {
    await pool.query('DELETE FROM wa_credentials WHERE session_id = $1', [sessionId]);
  };

  return {
    state: { creds, keys },
    saveCreds,
    clear,
  };
}

module.exports = { usePostgresAuthState, initCreds };
