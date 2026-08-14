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

// Fields every usable creds object must have. If any is missing, the stored
// state is corrupt (e.g. a partial creds.update payload was persisted) and we
// must start fresh instead of crashing in the noise handshake.
const REQUIRED_CREDS_FIELDS = ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'registrationId', 'advSecretKey'];

function isCredsUsable(creds) {
  return !!creds && REQUIRED_CREDS_FIELDS.every((f) => creds[f] !== undefined && creds[f] !== null);
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

    // Baileys calls set() with a NESTED structure: { [type]: { [id]: value } }.
    // Flatten it into `${type}:${id}` entries so get() can find them.
    //
    // ATOMIC jsonb merge — NO read-modify-write. The old implementation read the
    // whole keys blob, merged in memory, and wrote it back; concurrent set() calls
    // (bursts of session/pre-key writes during message storms) clobbered each
    // other, silently losing Signal sessions → endless Bad MAC / "Closing session"
    // churn. A single UPDATE with `||` is row-locked and race-free, even across
    // overlapping containers during deploys.
    async set(data) {
      const flat = {};
      for (const [type, entries] of Object.entries(data || {})) {
        for (const [id, value] of Object.entries(entries || {})) {
          if (value === undefined || value === null) continue;
          flat[`${type}:${id}`] = value;
        }
      }
      if (Object.keys(flat).length === 0) return;
      await pool.query(
        `INSERT INTO wa_credentials (session_id, creds, keys, updated_at)
         VALUES ($1, '{}', $2, NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           keys = COALESCE(wa_credentials.keys, '{}'::jsonb) || EXCLUDED.keys,
           updated_at = NOW()`,
        [sessionId, serialize(flat)]
      );
    },

    async del(type, ids) {
      // Atomic jsonb key removal: `keys - 'k1' - 'k2' ...` (no read needed).
      const removals = ids.map((id) => `${type}:${id}`);
      if (removals.length === 0) return;
      await pool.query(
        `UPDATE wa_credentials
         SET keys = COALESCE(keys, '{}'::jsonb) - $2::text[],
           updated_at = NOW()
         WHERE session_id = $1`,
        [sessionId, removals]
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

  let creds = rows[0]?.creds ? deserialize(rows[0].creds) : null;
  if (!isCredsUsable(creds)) {
    if (rows[0]) {
      console.warn(`[WA] Stored creds for ${sessionId} are incomplete — reinitializing`);
    }
    creds = initCreds();
  }
  const keys = makeKeyStore(sessionId);

  // IMPORTANT: baileys 'creds.update' emits only the CHANGED fields (Partial).
  // Always persist the full in-memory creds object and never touch `keys` here
  // (keys are managed by the key store; overwriting them with a stale snapshot
  // loses sessions/pre-keys).
  const saveCreds = async () => {
    await pool.query(
      `INSERT INTO wa_credentials (session_id, creds, keys, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         creds = EXCLUDED.creds,
         updated_at = NOW()`,
      [sessionId, serialize(creds), JSON.stringify({})]
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
