const express = require('express');
const router = express.Router();
const Broadcast = require('../models/Broadcast');
const Message = require('../models/Message');
const pool = require('../db/pool');
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

// ── POST /api/broadcasts/apology ── DORMANT recovery broadcast (admin, manual) ──
// Feature B: apologize to chats that received the robotic fallback during an AI
// outage. This is NOT automatic — it only runs when an admin explicitly calls it.
// Default is DRY-RUN (preview the affected chats). To actually send, the request
// body must include { "confirm": true }. Optionally scope with ?hours=48.
router.post('/apology', async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours || '48', 10) || 48, 1), 24 * 30);
    const confirm = req.body && req.body.confirm === true;

    // Find phones that received the robotic fallback in the window (outbound from bot),
    // excluding always-manual/test. Only chats whose LAST inbound still awaits a real reply.
    const { rows: affected } = await pool.query(`
      SELECT phone, MAX(created_at) AS last_fallback_at, COUNT(*) AS fallback_count
      FROM messages
      WHERE direction = 'outbound'
        AND content ILIKE '%no entendí bien%'
        AND created_at > NOW() - ($1 || ' hours')::interval
        AND phone IS NOT NULL
        AND phone NOT LIKE '%@newsletter'
      GROUP BY phone
      ORDER BY last_fallback_at DESC
    `, [String(hours)]);

    const message = req.body.message ||
      `🦉 *Gurú Soluciones*\n\n` +
      `Saludos. Le escribimos para ofrecerle una disculpa: tuvimos un inconveniente técnico reciente y es posible que su solicitud anterior no haya sido atendida correctamente.\n\n` +
      `Ya estamos operando con normalidad. ¿En qué podemos ayudarle hoy?`;

    // DRY-RUN: just report who would receive it
    if (!confirm) {
      return res.json({
        dryRun: true,
        hours,
        affectedCount: affected.length,
        affected,
        message,
        note: 'Dry-run. Reenvía con { "confirm": true } para enviar realmente. Requiere WhatsApp conectado.',
      });
    }

    // CONFIRMED SEND — requires an active WhatsApp connection (team activates the bot)
    const conn = getAnyConnection();
    if (!conn) {
      return res.status(503).json({ error: 'No hay conexión de WhatsApp activa. Activa el bot primero.' });
    }

    let sent = 0;
    const failed = [];
    for (const r of affected) {
      try {
        const lastJid = await Message.getLastJid(r.phone);
        const jid = lastJid || `${r.phone}@s.whatsapp.net`;
        await sendMessage(conn.sessionId, jid, { text: message });
        sent++;
        await new Promise(resolve => setTimeout(resolve, 2000)); // throttle anti-ban
      } catch (err) {
        failed.push({ phone: r.phone, error: err.message });
      }
    }

    res.json({ dryRun: false, sent, failedCount: failed.length, failed });
  } catch (err) {
    console.error('[Broadcast] Apology error:', err);
    res.status(500).json({ error: 'Error en broadcast de disculpa' });
  }
});

// Export sendBroadcast so scheduler can call it
module.exports = router;
module.exports.sendBroadcast = sendBroadcast;
