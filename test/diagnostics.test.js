const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { configDiagnostics } = require('../src/utils/diagnostics');

test('reports only yes/no flags, never secret values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vol-'));
  const d = configDiagnostics({
    TURNSTILE_SECRET_KEY: 'super-secret', TURNSTILE_SECRET_KEY_DEV: '',
    RAILWAY_VOLUME_MOUNT_PATH: dir, S3_BUCKET: 'b', RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567',
  });
  assert.deepEqual(d, {
    turnstile: { production: true, development: false },
    storage: { volume_attached: true, writable: true, s3_configured: true },
    commit: 'abcdef1',
  });
  assert.ok(!JSON.stringify(d).includes('super-secret'));
});

test('no volume → falls back to the container disk and says so', () => {
  const d = configDiagnostics({});
  assert.equal(d.storage.volume_attached, false);
  assert.equal(d.turnstile.production, false);
  assert.equal(d.commit, null);
});
