// WhatsApp Cloud API (Meta): webhook security, Graph requests, incoming message parsing.
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

const cloudApi = require('../src/whatsapp/cloudApi');
const cloudHandler = require('../src/whatsapp/cloudHandler');

// ── Graph requests ──

function mockFetch(reply = { messages: [{ id: 'wamid.X' }] }, status = 200) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(JSON.stringify(reply), { status });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('the token goes in the Authorization header, never in the URL', async () => {
  const f = mockFetch();
  try {
    await cloudApi.sendTextMessage('+1 (809) 555-0101', 'Hola');
    const { url, opts } = f.calls[0];
    assert.ok(!url.includes('EAAG-test-token'));
    assert.ok(!url.includes('access_token'));
    assert.equal(opts.headers.Authorization, 'Bearer EAAG-test-token');
    assert.equal(JSON.parse(opts.body).to, '18095550101');
  } finally { f.restore(); }
});

test('media downloads also use the header', async () => {
  const f = mockFetch({});
  try {
    await cloudApi.downloadMedia('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1');
    assert.ok(!f.calls[0].url.includes('EAAG-test-token'));
    assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer EAAG-test-token');
  } finally { f.restore(); }
});

test('outside the 24-hour window the error says so in Spanish', async () => {
  const f = mockFetch({ error: { code: 131047, message: 'Re-engagement message' } }, 400);
  try {
    await assert.rejects(cloudApi.sendTextMessage('18095550101', 'Hola'), (err) => {
      assert.equal(err.code, 'WINDOW_CLOSED');
      assert.match(err.message, /24 horas/);
      return true;
    });
  } finally { f.restore(); }
});

test('long replies are split into several messages (WhatsApp limit 4096)', async () => {
  const f = mockFetch();
  try {
    await cloudApi.sendTextMessage('18095550101', `${'a'.repeat(4000)}\n\n${'b'.repeat(1000)}`);
    assert.equal(f.calls.length, 2);
    for (const c of f.calls) assert.ok(JSON.parse(c.opts.body).text.body.length <= 4096);
  } finally { f.restore(); }
});

test('markAsRead sends the read status for that message', async () => {
  const f = mockFetch({ success: true });
  try {
    await cloudApi.markAsRead('wamid.ABC');
    const body = JSON.parse(f.calls[0].opts.body);
    assert.deepEqual(body, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.ABC' });
    assert.match(f.calls[0].url, /\/111222333\/messages$/);
  } finally { f.restore(); }
});

// ── Webhook ──

let server, base;
const received = [];
test.before(async () => {
  cloudHandler.processWebhookPayload = async (p) => { received.push(p); };
  const app = express();
  app.use('/webhook/whatsapp', express.raw({ type: 'application/json' }));
  app.use('/webhook/whatsapp', require('../src/routes/whatsappWebhook'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/webhook/whatsapp`;
});
test.after(async () => { server.close(); await require('../src/db/pool').end(); });

const event = { object: 'whatsapp_business_account', entry: [] };
const sign = (body, secret) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
const post = (body, headers = {}) =>
  fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
const settle = () => new Promise((r) => setTimeout(r, 30));

test('verification: right token returns the challenge, wrong one 403', async () => {
  const ok = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '42');
  const bad = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
  assert.equal(bad.status, 403);
});

test('without WHATSAPP_APP_SECRET no event is processed', async () => {
  delete process.env.WHATSAPP_APP_SECRET;
  received.length = 0;
  const res = await post(JSON.stringify(event));
  assert.equal(res.status, 200); // Meta always gets 200, or it retries
  await settle();
  assert.equal(received.length, 0);
});

test('a bad or missing signature is rejected; a good one is processed', async () => {
  process.env.WHATSAPP_APP_SECRET = 'app-secret';
  received.length = 0;
  const body = JSON.stringify(event);
  await post(body);
  await post(body, { 'X-Hub-Signature-256': sign(body, 'other-secret') });
  await settle();
  assert.equal(received.length, 0);
  await post(body, { 'X-Hub-Signature-256': sign(body, 'app-secret') });
  await settle();
  assert.equal(received.length, 1);
});

// ── Incoming messages ──

const { normalizeMessage, isOurNumber, cloudSock } = cloudHandler;

test('button and list replies arrive as their text', () => {
  const button = normalizeMessage({ id: 'm1', from: '18095550101', type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Sí, continuar' } } }, {});
  assert.equal(button.text, 'Sí, continuar');
  const list = normalizeMessage({ id: 'm2', from: '18095550101', type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Contrato de venta', description: 'x' } } }, {});
  assert.equal(list.text, 'Contrato de venta');
  const quick = normalizeMessage({ id: 'm3', from: '18095550101', type: 'button', button: { text: 'Hablar con alguien' } }, {});
  assert.equal(quick.text, 'Hablar con alguien');
});

test('reactions, stickers and unknown types do not crash and carry no text', () => {
  for (const m of [
    { type: 'reaction', reaction: { emoji: '👍', message_id: 'x' } },
    { type: 'sticker', sticker: { id: 's1' } },
    { type: 'unsupported', errors: [{ code: 131051 }] },
  ]) {
    const out = normalizeMessage({ id: 'm', from: '18095550101', ...m }, {});
    assert.equal(out.text, '');
  }
});

test('only events for our phone number are handled', () => {
  assert.equal(isOurNumber({ metadata: { phone_number_id: '111222333' } }), true);
  assert.equal(isOurNumber({ metadata: { phone_number_id: '999' } }), false);
  assert.equal(isOurNumber({}), false);
});

test('the bot replies through Meta with the same pipeline as Baileys', async () => {
  const f = mockFetch();
  try {
    const sock = cloudSock('18095550101');
    const sent = await sock.sendMessage('18095550101@s.whatsapp.net', { text: 'Hola 👋' });
    assert.equal(sent.key.id, 'wamid.X');
    assert.equal(JSON.parse(f.calls[0].opts.body).text.body, 'Hola 👋');
  } finally { f.restore(); }
});
