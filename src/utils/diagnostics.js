// Safe configuration snapshot for /health: booleans only, never secret values.
const fs = require('fs');
const path = require('path');

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.health-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function configDiagnostics(env = process.env) {
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
  return {
    turnstile: {
      production: Boolean(env.TURNSTILE_SECRET_KEY),
      development: Boolean(env.TURNSTILE_SECRET_KEY_DEV),
    },
    storage: {
      volume_attached: Boolean(volume),
      writable: isWritable(volume || '/data/guru-files'),
      s3_configured: Boolean(env.S3_BUCKET),
    },
    whatsapp: {
      access_token: Boolean(env.WHATSAPP_ACCESS_TOKEN),
      phone_number_id: Boolean(env.WHATSAPP_PHONE_NUMBER_ID),
      app_secret: Boolean(env.WHATSAPP_APP_SECRET),
      verify_token: Boolean(env.WHATSAPP_VERIFY_TOKEN),
    },
    commit: env.RAILWAY_GIT_COMMIT_SHA ? env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : null,
  };
}

module.exports = { configDiagnostics };
