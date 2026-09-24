const express = require('express');
const crypto = require('crypto');
const cloudHandler = require('../whatsapp/cloudHandler');

const router = express.Router();

function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return null;
}

function parsePayload(req) {
  const raw = getRawBody(req);
  if (raw) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch (err) {
      console.error('[WA Cloud] Failed to parse raw body:', err.message);
      return null;
    }
  }
  if (req.body && typeof req.body === 'object') return req.body;
  return null;
}

function verifySignature(req, appSecret) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;

  const raw = getRawBody(req);
  if (!raw) return false;

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(raw)
    .digest('hex');

  const parts = signature.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;

  const provided = parts[1];
  if (expected.length !== provided.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch (_) {
    return false;
  }
}

/**
 * WhatsApp Cloud API webhook routes (Meta Official API)
 * These are PUBLIC — Meta calls them directly for verification and events.
 * Do NOT add authentication middleware here.
 */

// ── GET /webhook/whatsapp ── Meta verification challenge
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[WA Cloud] Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('[WA Cloud] Webhook verification failed — invalid token or mode');
  return res.sendStatus(403);
});

// ── POST /webhook/whatsapp ── Incoming events from Meta
router.post('/', (req, res) => {
  // Meta requires an immediate 200 OK; otherwise it retries.
  res.sendStatus(200);

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret) {
    if (!verifySignature(req, appSecret)) {
      console.warn('[WA Cloud] Signature verification failed — rejecting event');
      return;
    }
    console.log('[WA Cloud] Signature verified');
  }

  const payload = parsePayload(req);
  if (!payload) {
    console.warn('[WA Cloud] Empty or unparseable payload');
    return;
  }

  if (payload.object !== 'whatsapp_business_account') {
    console.warn(`[WA Cloud] Ignoring non-WhatsApp object: ${payload.object}`);
    return;
  }

  console.log('[WA Cloud] Incoming webhook payload:', JSON.stringify(payload, null, 2));

  cloudHandler.processWebhookPayload(payload).catch((err) => {
    console.error('[WA Cloud] Error processing payload:', err.message);
  });
});

module.exports = router;
