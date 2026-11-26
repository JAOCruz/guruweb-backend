// Envíos (sección del dashboard). Lo usan admin y digitadores: es logística del negocio.
const express = require('express');
const Delivery = require('../models/Delivery');
const { authenticate } = require('../middleware/auth');
const { logActivity, safeLog } = require('../services/activityLog');

const router = express.Router();
router.use(authenticate);

const LABEL = { por_enviar: 'Por enviar', enviado: 'Enviado', entregado: 'Entregado', cancelado: 'Cancelado' };
const blank = (v) => v == null || !String(v).trim();
const who = (d) => d.recipient_name || d.client_name || `envío ${d.id}`;

router.get('/', async (req, res) => {
  try {
    const [deliveries, counts] = await Promise.all([Delivery.list(req.query.status), Delivery.counts()]);
    res.json({ deliveries, counts });
  } catch (err) {
    console.error('List deliveries error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudieron cargar los envíos' });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (blank(body.address)) return res.status(400).json({ error: 'Falta la dirección', code: 'ADDRESS_REQUIRED' });
    const fields = Object.fromEntries(Delivery.EDITABLE.map((k) => [k, body[k]]));
    const delivery = await Delivery.create({ ...fields, source: 'manual', createdBy: req.user.id });
    await safeLog(() => logActivity(req, {
      category: 'envios', action: 'delivery.create', entityType: 'delivery', entityId: delivery.id,
      summary: `Creó el envío para ${who(delivery)}`,
    }));
    res.status(201).json({ delivery });
  } catch (err) {
    console.error('Create delivery error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudo crear el envío' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.address !== undefined && blank(body.address)) {
      return res.status(400).json({ error: 'Falta la dirección', code: 'ADDRESS_REQUIRED' });
    }
    const delivery = await Delivery.update(Number(req.params.id) || 0, body);
    if (!delivery) return res.status(404).json({ error: 'Envío no encontrado' });
    res.json({ delivery });
  } catch (err) {
    console.error('Update delivery error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudo guardar el envío' });
  }
});

router.post('/:id/status', async (req, res) => {
  try {
    const status = req.body?.status;
    if (!Delivery.STATUSES.includes(status)) return res.status(400).json({ error: 'Estado no válido', code: 'INVALID_STATUS' });
    const delivery = await Delivery.setStatus(Number(req.params.id) || 0, status);
    if (!delivery) return res.status(404).json({ error: 'Envío no encontrado' });
    await safeLog(() => logActivity(req, {
      category: 'envios', action: 'delivery.status', entityType: 'delivery', entityId: delivery.id,
      summary: `Envío de ${who(delivery)} → ${LABEL[status]}`,
      details: { status },
    }));
    res.json({ delivery });
  } catch (err) {
    console.error('Delivery status error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudo cambiar el estado' });
  }
});

module.exports = router;
