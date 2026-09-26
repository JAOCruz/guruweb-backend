// Cloudflare Turnstile ("¿eres humano?") verification for the login.
// Without TURNSTILE_SECRET_KEY the check is skipped, so the login keeps working
// until the key is configured on Railway.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile(token, ip, { secret = process.env.TURNSTILE_SECRET_KEY, fetchImpl = fetch } = {}) {
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false };
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json();
    return { ok: data.success === true };
  } catch (err) {
    console.error('[turnstile] verification failed:', err.message);
    return { ok: false };
  }
}

module.exports = { verifyTurnstile };
