const express = require('express');
const path = require('path');
const fs = require('fs');
const { authenticate } = require('../middleware/auth');
const ClientMedia = require('../models/ClientMedia');

const router = express.Router();
router.use(authenticate);

// List all media for a client
router.get('/client/:clientId', async (req, res) => {
  try {
    const media = await ClientMedia.findByClient(req.params.clientId);
    res.json({ media });
  } catch (err) {
    console.error('List client media error:', err);
    res.status(500).json({ error: 'Failed to list media' });
  }
});

// List all media for a phone (for unregistered contacts)
router.get('/phone/:phone', async (req, res) => {
  try {
    const media = await ClientMedia.findByPhone(req.params.phone);
    res.json({ media });
  } catch (err) {
    console.error('List phone media error:', err);
    res.status(500).json({ error: 'Failed to list media' });
  }
});

// Download a specific media file
const UPLOADS_ROOT = path.resolve(__dirname, '..', '..', 'uploads');

router.get('/:id/download', async (req, res) => {
  try {
    const media = await ClientMedia.findById(req.params.id);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    const absPath = path.resolve(media.file_path);
    // Path traversal prevention: resolved path must be within the uploads directory
    const uploadsRoot = path.resolve(__dirname, '..', '..', 'uploads');
    if (!absPath.startsWith(uploadsRoot)) {
      console.error(`[SECURITY] Path traversal attempt: ${absPath}`);
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.setHeader('Content-Type', media.mime_type || 'application/octet-stream');
    // Security: force attachment instead of inline to prevent XSS via malicious files
    res.setHeader('Content-Disposition', `attachment; filename="${media.original_name || media.saved_name}"`);
    res.sendFile(absPath);
  } catch (err) {
    console.error('Download media error:', err);
    res.status(500).json({ error: 'Failed to download media' });
  }
});

// Get media metadata
router.get('/:id', async (req, res) => {
  try {
    const media = await ClientMedia.findById(req.params.id);
    if (!media) return res.status(404).json({ error: 'Media not found' });
    res.json({ media });
  } catch (err) {
    console.error('Get media error:', err);
    res.status(500).json({ error: 'Failed to get media' });
  }
});

module.exports = router;
