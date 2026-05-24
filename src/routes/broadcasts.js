const express = require('express');
const router = express.Router();
const Broadcast = require('../models/Broadcast');
const Message = require('../models/Message');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendMessage, getAnyConnection } = require('../whatsapp/connection');

// All broadcast routes: admin only
router.use(authenticate, requireRole('admin'));

// List broadcasts
router.get('/', async (req, res) => {
  try {
    const broadcasts = await Broadcast.findAll();
    res.json({ broadcasts });
  } catch (err) {
    console.error('Broadcast list error:', err);
    res.status(500).json({ error: 'Error al cargar broadcasts' });
  }
});

// Get recipients for a broadcast
router.get('/:id/recipients', async (req, res) => {
  try {
    const recipients = await Broadcast.getRecipients(req.params.id);
    res.json({ recipients });
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar destinatarios' });
  }
});

// Create broadcast
router.post('/', async (req, res) => {
  try {
    const { title, message, mediaUrl, scheduledAt, clientIds } = req.body;
    if (!message || !clientIds?.length) {
      return res.status(400).json({ error: 'message y clientIds son requeridos' });
    }

    const Client = require('../models/Client');
    const recipients = [];
    for (const id of clientIds) {
      const c = await Client.findById(id);
      if (c) recipients.push({ client_id: c.id, phone: c.phone, name: c.name });
    }

    const broadcast = await Broadcast.create({
      title,
      message,
      mediaUrl: mediaUrl || null,
      scheduledAt: scheduledAt || null,
      createdBy: req.user.id,
      recipients,
    });

    // If no schedule → send immediately
    if (!scheduledAt) {
      sendBroadcast(broadcast.id).catch(err => console.error('[Broadcast] Send error:', err));
    }

    res.status(201).json({ broadcast });
  } catch (err) {
    console.error('Broadcast create error:', err);
    res.status(500).json({ error: 'Error al crear broadcast' });
  }
});

// Cancel pending broadcast
router.delete('/:id', async (req, res) => {
  try {
    await Broadcast.cancel(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al cancelar' });
  }
});

// Send now (manual trigger for scheduled)
router.post('/:id/send', async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);
    if (!broadcast) return res.status(404).json({ error: 'Not found' });
    if (broadcast.status !== 'pending') return res.status(400).json({ error: 'Solo se pueden enviar broadcasts pendientes' });
    sendBroadcast(broadcast.id).catch(err => console.error('[Broadcast] Send error:', err));
    res.json({ ok: true, message: 'Enviando...' });
  } catch (err) {
    res.status(500).json({ error: 'Error al enviar' });
  }
});

// ── Core send logic ──────────────────────────────────────────────────────────
async function sendBroadcast(broadcastId) {
  const broadcast = await Broadcast.findById(broadcastId);
  if (!broadcast) return;

  await Broadcast.markSending(broadcastId);

  const conn = getAnyConnection();
  if (!conn) {
    await Broadcast.markFailed(broadcastId);
    throw new Error('No WhatsApp connection');
  }

  const recipients = await Broadcast.getRecipients(broadcastId);
  let successCount = 0;

  for (const r of recipients) {
    try {
      // Use real JID if available (handles @lid accounts)
      const lastJid = await Message.getLastJid(r.phone);
      const jid = lastJid || `${r.phone}@s.whatsapp.net`;

      // Build message payload
      let payload;
      if (broadcast.media_url) {
        payload = { image: { url: broadcast.media_url }, caption: broadcast.message };
      } else {
        payload = { text: broadcast.message };
      }

      await sendMessage(conn.sessionId, jid, payload);
      await Broadcast.markRecipientSent(r.id);
      successCount++;

      // Throttle: 1.5s between messages to avoid WA ban
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (err) {
      console.error(`[Broadcast] Failed to send to ${r.phone}:`, err.message);
      await Broadcast.markRecipientFailed(r.id, err.message);
    }
    await Broadcast.updateCounts(broadcastId);
  }

  await Broadcast.markDone(broadcastId);
  console.log(`[Broadcast] #${broadcastId} done — ${successCount}/${recipients.length} sent`);
}

// Export sendBroadcast so scheduler can call it
module.exports = router;
module.exports.sendBroadcast = sendBroadcast;
