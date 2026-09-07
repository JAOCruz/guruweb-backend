const express = require('express');

const router = express.Router();

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
router.post('/', express.json(), (req, res) => {
  // Meta requires an immediate 200 OK; otherwise it retries.
  res.sendStatus(200);

  // Log the full payload so we can inspect the real message structure
  // while migrating from Baileys to the official Cloud API.
  console.log('[WA Cloud] Incoming webhook payload:', JSON.stringify(req.body, null, 2));

  // TODO: Connect this to the existing AI conversation logic.
  // The payload structure from Meta is:
  //   req.body.entry[0].changes[0].value.messages[0]
  // We should map the sender phone, message text/type, and media
  // into the same format our Baileys handler uses, then pass it to
  // handleIncomingMessage or the conversation router.
});

module.exports = router;
