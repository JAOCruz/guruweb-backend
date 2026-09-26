const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyTurnstile } = require('../src/services/turnstile');

const fakeFetch = (body) => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { json: async () => body };
  };
  fn.calls = calls;
  return fn;
};

test('skipped when no secret is configured (login works as before)', async () => {
  const f = fakeFetch({ success: false });
  assert.deepEqual(await verifyTurnstile('tok', '1.2.3.4', { secret: '', fetchImpl: f }), { ok: true, skipped: true });
  assert.equal(f.calls.length, 0);
});

test('missing token fails without calling Cloudflare', async () => {
  const f = fakeFetch({ success: true });
  assert.deepEqual(await verifyTurnstile('', '1.2.3.4', { secret: 's', fetchImpl: f }), { ok: false });
  assert.equal(f.calls.length, 0);
});

test('valid token → ok, sends secret, token and ip to siteverify', async () => {
  const f = fakeFetch({ success: true });
  assert.deepEqual(await verifyTurnstile('tok', '1.2.3.4', { secret: 's', fetchImpl: f }), { ok: true });
  assert.equal(f.calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  const sent = new URLSearchParams(f.calls[0].opts.body);
  assert.equal(sent.get('secret'), 's');
  assert.equal(sent.get('response'), 'tok');
  assert.equal(sent.get('remoteip'), '1.2.3.4');
});

test('invalid token → not ok', async () => {
  assert.deepEqual(await verifyTurnstile('bad', null, { secret: 's', fetchImpl: fakeFetch({ success: false }) }), { ok: false });
});

test('Cloudflare unreachable → not ok (fail closed)', async () => {
  const boom = async () => { throw new Error('network'); };
  assert.deepEqual(await verifyTurnstile('tok', null, { secret: 's', fetchImpl: boom }), { ok: false });
});
