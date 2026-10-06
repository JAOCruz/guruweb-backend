const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { authenticate, requireRole } = require('../middleware/auth');
const pool = require('../db/pool');
const { clearCache } = require('../agent/businessInfo');
const { digitadoresAprueban, SWITCH_KEY } = require('../documentos/permissions');
const { logActivity, safeLog } = require('../services/activityLog');

// All settings routes require authentication
router.use(authenticate);

// Get current employee percentage (accessible to all authenticated users)
router.get('/current', settingsController.getCurrentPercentage);

// Get percentage for a specific date (accessible to all authenticated users)
router.get('/percentage', settingsController.getPercentageForDate);

// Get all settings history (admin only)
router.get('/history', requireRole('admin'), settingsController.getAllSettings);

// Update employee percentage (admin only)
router.post('/percentage', requireRole('admin'), settingsController.updatePercentage);

// ── Bot (fase 2): switch "los digitadores aprueban y envían documentos" ──
// Anyone signed in can read it (the panel decides what to show); only the admin changes it.
router.get('/bot', async (req, res) => {
  try {
    res.json({ digitadores_aprueban_documentos: await digitadoresAprueban() });
  } catch (err) {
    console.error('[settings] bot read error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudo leer la configuración del bot' });
  }
});

router.put('/bot', requireRole('admin'), async (req, res) => {
  const value = (req.body || {}).digitadores_aprueban_documentos;
  if (typeof value !== 'boolean') {
    return res.status(400).json({ error: 'digitadores_aprueban_documentos debe ser true o false', code: 'INVALID_VALUE' });
  }
  try {
    await pool.query(
      `INSERT INTO business_info (clave, valor, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
      [SWITCH_KEY, JSON.stringify(value)]
    );
    clearCache();
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'configuracion.digitadores_aprueban', entityType: 'configuracion', entityId: SWITCH_KEY,
      summary: value
        ? 'Permitió que los digitadores aprueben y envíen los documentos del bot de sus clientes'
        : 'Quitó a los digitadores el permiso de aprobar y enviar los documentos del bot',
      details: { digitadores_aprueban_documentos: value },
    }));
    res.json({ digitadores_aprueban_documentos: value });
  } catch (err) {
    console.error('[settings] bot update error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudo guardar la configuración del bot' });
  }
});

// Delete a setting (admin only)
router.delete('/:id', requireRole('admin'), settingsController.deleteSetting);

module.exports = router;
