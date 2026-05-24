const express = require('express');
const Service = require('../models/Service');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Get all services with categories
router.get('/', async (req, res) => {
  try {
    const services = await Service.findAll();
    res.json({ services });
  } catch (err) {
    console.error('List services error:', err);
    res.status(500).json({ error: 'Failed to list services' });
  }
});

// Get services by category name
router.get('/category/:category', async (req, res) => {
  try {
    const services = await Service.findByCategory(req.params.category);
    res.json({ services });
  } catch (err) {
    console.error('List services by category error:', err);
    res.status(500).json({ error: 'Failed to list services' });
  }
});

// Get all categories
router.get('/categories/list', async (req, res) => {
  try {
    const categories = await Service.getCategories();
    res.json({ categories });
  } catch (err) {
    console.error('List categories error:', err);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

// Search service by name
router.get('/search/:name', async (req, res) => {
  try {
    const service = await Service.findByName(req.params.name);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    res.json({ service });
  } catch (err) {
    console.error('Search service error:', err);
    res.status(500).json({ error: 'Failed to search service' });
  }
});

// Calculate total price for a service (digitación + notarización based on asset value)
router.post('/calculate', async (req, res) => {
  try {
    const { serviceId, assetValue, quantity = 1, includeNotarization = true } = req.body;
    if (!serviceId) {
      return res.status(400).json({ error: 'serviceId is required' });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const qty = Number(quantity) || 1;
    const digitacionTotal = (Number(service.digitacion_price) || 0) * qty;
    let notarizacionTotal = 0;

    if (includeNotarization && service.notarizacion_price) {
      // Check for price tiers (value-based pricing)
      const tiers = service.price_tiers || [];
      if (tiers.length > 0 && assetValue) {
        const val = Number(assetValue) || 0;
        // Find matching tier (max: null means open-ended)
        const matched = tiers.find(t =>
          t.min !== undefined && val >= t.min &&
          (t.max === null || t.max === undefined || val <= t.max)
        );
        if (matched) {
          notarizacionTotal = Number(matched.price) * qty;
        }
        // Fallback to base notarizacion_price if no tier matched
        if (notarizacionTotal === 0) {
          notarizacionTotal = Number(service.notarizacion_price) * qty;
        }
      } else {
        notarizacionTotal = Number(service.notarizacion_price) * qty;
      }
    }

    const total = digitacionTotal + notarizacionTotal;

    res.json({
      service: {
        id: service.id,
        name: service.name,
        unit_type: service.unit_type,
        digitacion_price: service.digitacion_price,
        notarizacion_price: service.notarizacion_price,
      },
      quantity: qty,
      assetValue: assetValue || null,
      breakdown: {
        digitacion: digitacionTotal,
        notarizacion: notarizacionTotal,
      },
      total,
    });
  } catch (err) {
    console.error('Calculate price error:', err);
    res.status(500).json({ error: 'Failed to calculate price' });
  }
});

// Create service (admin only)
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { name, description, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type } = req.body;
    if (!name || digitacion_price === undefined) {
      return res.status(400).json({ error: 'name and digitacion_price are required' });
    }
    const service = await Service.create({
      name, description, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type
    });
    res.status(201).json({ service });
  } catch (err) {
    console.error('Create service error:', err);
    res.status(500).json({ error: 'Failed to create service' });
  }
});

// Update service (admin only)
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { name, description, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type, active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category_id !== undefined) updates.category_id = category_id;
    if (digitacion_price !== undefined) updates.digitacion_price = digitacion_price;
    if (notarizacion_price !== undefined) updates.notarizacion_price = notarizacion_price;
    if (price_tiers !== undefined) updates.price_tiers = JSON.stringify(price_tiers);
    if (unit_type !== undefined) updates.unit_type = unit_type;
    if (active !== undefined) updates.active = active;

    const service = await Service.update(req.params.id, updates);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    res.json({ service });
  } catch (err) {
    console.error('Update service error:', err);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

// Delete service (soft delete, admin only)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await Service.delete(req.params.id);
    res.json({ message: 'Service deleted' });
  } catch (err) {
    console.error('Delete service error:', err);
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

module.exports = router;
